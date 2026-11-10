import AppKit
import Combine
import WebKit
import os

private let wlog = Logger(subsystem: "com.ned.menubar", category: "dashboard")

/// Single native window hosting the daemon's dashboard (`http://127.0.0.1:<port>/`).
/// Shows a placeholder until `/api/state` answers; external links go to the default browser.
@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    static let shared = DashboardWindowController()

    private var window: NSWindow?
    private var webView: WKWebView!
    private var waitTimer: Timer?
    private var loaded = false
    /// When the boot screen went up (nil = not showing it).
    private var bootShownAt: Date?
    private var finishing = false
    /// Bumped by every waitForDaemon(): stale timers / tasks from an earlier boot screen do nothing.
    private var bootGen = 0
    private var probing = false
    private var statusSub: AnyCancellable?

    /// The boot screen stays at least this long, even when the daemon answers at once (cache hit ≈ <1 s),
    /// so it never flashes; then the outro plays (BootScreen.outroSeconds: ready beat → dissolve into the
    /// dashboard's background) and the dashboard's content fades in (`revealScript`).
    /// 2.5 s = the mark's draw-in (~2.0 s, BootScreen CSS) plus the first light sweep finishing (~2.5 s).
    static let minBootScreenSeconds: TimeInterval = 2.5
    static var outroSeconds: TimeInterval {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.3 : BootScreen.outroSeconds
    }

    /// Injected (document start, main frame) only for the navigation that replaces the boot screen / a reload:
    /// the dashboard's top-level blocks fade + lift in over its own --bg (body background → canvas, so no flash).
    /// `backwards` fill = no transform left behind afterwards; the style removes itself after 1.2 s.
    static let revealScript = """
    (function () {
      var s = document.createElement("style");
      s.textContent = "@keyframes nedReveal { from { opacity: 0; transform: translateY(8px); } }"
        + " body > * { animation: nedReveal .55s cubic-bezier(.2,.7,.3,1) .05s backwards; }"
        + " @media (prefers-reduced-motion: reduce) { body > * { animation: none; } }";
      document.documentElement.appendChild(s);
      setTimeout(function () { s.remove(); }, 1200);
    })();
    """

    func show() {
        if window == nil { build() }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        if !loaded { waitForDaemon() }
    }

    private func makeWebView(frame: NSRect) {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.userContentController.add(BootMessageHandler(), name: "ned")
        cfg.userContentController.add(OpenLinkHandler(), name: "openLink")
        cfg.userContentController.addScriptMessageHandler(LoginItemHandler(), contentWorld: .page, name: "loginItem")
        webView = WKWebView(frame: frame, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
    }

    /// `--boot-transition-selftest`: the same boot screen → dashboard flow in a web view with no window (no UI;
    /// also the worst case for JS round-trips). `onDashboardLoad` reports the switch.
    var onDashboardLoad: ((String) -> Void)?
    func startHeadless() {
        makeWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 820))
        waitForDaemon()
    }

    private func build() {
        makeWebView(frame: .zero)

        let w = DashboardWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        w.title = "Ned"
        w.isReleasedWhenClosed = false
        w.contentView = webView
        w.minSize = NSSize(width: 640, height: 420)
        w.center()
        w.setFrameAutosaveName("NedDashboard")   // remembers size/position across launches
        w.delegate = self
        w.onReload = { [weak self] in self?.reload() }
        window = w
    }

    func reload() {
        loaded = false
        waitForDaemon()
    }

    /// Daemon already healthy → load the dashboard straight away (no boot animation). Otherwise put up the boot
    /// screen and move on as soon as the daemon is healthy (≥ minBootScreenSeconds on screen, then a fade).
    ///
    /// Nothing here ever *waits* on the web view: `await evaluateJavaScript` can take many seconds while the
    /// WebContent process is cold or the window is occluded (measured 18.5 s for the first call in a hidden
    /// web view). The old poll awaited it before every probe, so the switch landed ~13 s after the daemon was
    /// healthy (seen live: healthy at +4.3 s, dashboard at +17.2 s). Now JS updates are fire-and-forget, the
    /// switch is driven by DaemonManager's own health (its `$status`, no polling delay), with our own probe only
    /// as a fallback, and the min-time / fade delays are plain timers.
    private func waitForDaemon() {
        waitTimer?.invalidate()
        statusSub = nil
        bootGen += 1
        finishing = false
        let daemon = DaemonManager.shared
        if daemon.isHealthy {
            bootShownAt = nil
            loadDashboard(reason: "daemon already healthy — no boot screen")
            return
        }
        bootShownAt = Date()
        let s = Self.bootSnapshot()
        let theme = Self.theme()
        webView.loadHTMLString(BootScreen.html(theme: theme, step: s.step, text: s.text, elapsed: s.elapsed, failed: s.failed), baseURL: nil)
        daemon.note("dashboard window: boot screen (persona \(theme.id.rawValue), theme \(theme.appearance), greeting \"\(theme.greeting)\", step \(s.step) \(s.text))")
        let gen = bootGen
        // @Published fires in willSet: re-check on the next main-actor turn, when `status` holds the new value.
        statusSub = daemon.$status.sink { [weak self] _ in Task { @MainActor in self?.bootTick(gen) } }
        waitTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.bootTick(gen) }
        }
        bootTick(gen)
    }

    /// Push progress (fire-and-forget) and switch once healthy.
    private func bootTick(_ gen: Int) {
        guard gen == bootGen, !loaded, !finishing else { return }
        let s = Self.bootSnapshot()
        runJS(BootScreen.update(step: s.step, text: s.text, elapsed: s.elapsed, failed: s.failed))
        if s.failed { return }
        if DaemonManager.shared.isHealthy { finishBoot(gen, via: "daemon healthy"); return }
        // Fallback for a daemon DaemonManager has not adopted yet: our own probe, one at a time.
        guard !probing else { return }
        probing = true
        Task { @MainActor [weak self] in
            let ok = await DaemonManager.probe(timeout: 2) != nil
            guard let self else { return }
            self.probing = false
            if ok { self.finishBoot(gen, via: "/api/state answered") }
        }
    }

    private func finishBoot(_ gen: Int, via: String) {
        guard gen == bootGen, !loaded, !finishing else { return }
        finishing = true
        waitTimer?.invalidate()
        statusSub = nil
        let healthyAt = Date()
        runJS(BootScreen.update(step: DaemonManager.BootStage.dashboard.rawValue, text: "대시보드 불러오는 중…", elapsed: DaemonManager.shared.bootElapsed, failed: false))
        let hold = max(0, Self.minBootScreenSeconds - healthyAt.timeIntervalSince(bootShownAt ?? healthyAt))
        Task { @MainActor [weak self] in
            if hold > 0 { try? await Task.sleep(nanoseconds: UInt64(hold * 1_000_000_000)) }
            guard let self, gen == self.bootGen, self.finishing, !self.loaded else { return }
            self.runJS("window.nedBootDone && nedBootDone();")
            try? await Task.sleep(nanoseconds: UInt64(Self.outroSeconds * 1_000_000_000))
            guard gen == self.bootGen, self.finishing, !self.loaded else { return }
            let shown = Date().timeIntervalSince(self.bootShownAt ?? healthyAt)
            self.loadDashboard(reason: String(format: "%@ — boot screen shown %.1fs, switching %.2fs after healthy", via, shown, Date().timeIntervalSince(healthyAt)))
        }
    }

    /// Never awaited (see waitForDaemon).
    private func runJS(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func loadDashboard(reason: String) {
        waitTimer?.invalidate()
        loaded = true
        finishing = false
        wlog.info("\(reason, privacy: .public) — loading dashboard")
        DaemonManager.shared.note("dashboard window: \(reason) — loading \(AppConfig.baseURL.absoluteString)/")
        let ucc = webView.configuration.userContentController
        ucc.removeAllUserScripts()
        ucc.addUserScript(WKUserScript(source: Self.revealScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView.load(URLRequest(url: AppConfig.baseURL))
        onDashboardLoad?(reason)
    }

    /// What the boot screen shows for the daemon's current state.
    static func bootSnapshot() -> (step: Int, text: String, elapsed: Double, failed: Bool) {
        let d = DaemonManager.shared
        if case .failed = d.status { return (d.bootStage.rawValue, d.statusLine, d.bootElapsed, true) }
        let step = d.isHealthy ? DaemonManager.BootStage.dashboard.rawValue : d.bootStage.rawValue
        return (step, d.statusLine, d.bootElapsed, false)
    }

    static func theme() -> BootScreen.Theme {
        let p = StateStore.current?.persona ?? PersonaID.ned.persona
        return BootScreen.Theme(id: p.id, name: p.displayName, accent: p.accentHex,
                                greeting: BootScreen.pickGreeting(p.id), ready: BootScreen.copy(p.id).ready,
                                appearance: BootScreen.configTheme())
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        waitTimer?.invalidate()
        statusSub = nil
        // Back to a pure menu bar app (no Dock icon) once the dashboard is gone.
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: WKNavigationDelegate / WKUIDelegate

    private func isDashboard(_ url: URL?) -> Bool {
        guard let url else { return true }
        if url.scheme == "about" || url.scheme == "data" { return true }
        return (url.host == "127.0.0.1" || url.host == "localhost") && (url.port ?? 80) == AppConfig.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        // A raw slack:// · figma:// · notion:// navigation carries no web URL, so with the app missing nothing opens
        // (one note line). The dashboard never does this today — openlink.js posts {deep, web} to OpenLinkHandler.
        if let url, DeepLink.isDeep(url) {
            DeepLink.open(url, web: nil)
            decisionHandler(.cancel)
            return
        }
        if action.targetFrame == nil || !isDashboard(url) {
            if let url, url.scheme != "about" { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// `target=_blank` and `window.open(...)`: never open a second web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            // Same as decidePolicyFor: a bare deep link has no web fallback (not a path the dashboard uses).
            if DeepLink.isDeep(url) { DeepLink.open(url, web: nil) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The reveal is one-shot (removed after the load, not at commit — that could race its injection):
        // later navigations inside the dashboard load without it.
        if loaded { webView.configuration.userContentController.removeAllUserScripts() }
        if loaded { DaemonManager.shared.note("dashboard window: loaded \(webView.url?.absoluteString ?? "?") title=\(webView.title ?? "")") }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Daemon restarting: fall back to the placeholder and wait again.
        guard loaded else { return }
        wlog.error("dashboard load failed: \(error.localizedDescription, privacy: .public)")
        reload()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload() }
}

/// Boot screen "다시 시작" button → DaemonManager.restart(). Only the local boot page can post (the dashboard never does).
private final class BootMessageHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // The boot page is loadHTMLString(baseURL: nil) → about:blank; ignore anything posted from the dashboard (http).
        guard message.body as? String == "restart", message.frameInfo.request.url?.scheme != "http" else { return }
        MainActor.assumeIsolated {
            DaemonManager.shared.note("boot screen: 다시 시작 clicked")
            DaemonManager.shared.restart()
        }
    }
}

/// 링크를 앱으로 열기: app deep links the dashboard hands over (packages/daemon/src/links.ts LINK_SERVICES).
/// One fallback path for both the `openLink` message and slack:// · figma:// · notion:// navigations.
enum DeepLink {
    static let schemes: Set<String> = ["slack", "figma", "notion"]

    static func isDeep(_ url: URL) -> Bool { schemes.contains(url.scheme?.lowercased() ?? "") }

    /// Open `deep` in its app. No app registered for the scheme, or the open fails → `web` in the default browser
    /// (nothing when `web` is nil). One DaemonManager note line either way (scheme + app / web host, not the full URL).
    @MainActor
    static func open(_ deep: URL, web: URL?) {
        let ws = NSWorkspace.shared
        let scheme = deep.scheme ?? "?"
        guard let app = ws.urlForApplication(toOpen: deep) else {
            if let web { ws.open(web) }
            DaemonManager.shared.note("open link: no app for \(scheme):// → \(web.map { "web \($0.host ?? "?")" } ?? "nothing to fall back to")")
            return
        }
        ws.open(deep, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            let reason = error?.localizedDescription
            Task { @MainActor in
                if let reason {
                    if let web { NSWorkspace.shared.open(web) }
                    DaemonManager.shared.note("open link: \(scheme):// via \(app.lastPathComponent) failed (\(reason)) → \(web.map { "web \($0.host ?? "?")" } ?? "nothing to fall back to")")
                } else {
                    DaemonManager.shared.note("open link: \(scheme):// → \(app.lastPathComponent)")
                }
            }
        }
    }
}

/// Dashboard `openLink(web)` (public/app/features/openlink.js) → `{deep, web}`: open in the app, else the web URL.
/// Only the dashboard page (http://127.0.0.1:<port>) may post; deep must be one of DeepLink.schemes, web http(s).
private final class OpenLinkHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let deepStr = body["deep"] as? String, let deep = URL(string: deepStr), DeepLink.isDeep(deep) else { return }
        let web = (body["web"] as? String).flatMap { URL(string: $0) }.flatMap { ["http", "https"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
        let src = message.frameInfo.request.url
        MainActor.assumeIsolated {
            guard let src, src.scheme == "http", src.host == "127.0.0.1" || src.host == "localhost", (src.port ?? 80) == AppConfig.port else {
                DaemonManager.shared.note("open link: ignored a message from \(src?.absoluteString ?? "?")")
                return
            }
            DeepLink.open(deep, web: web)
        }
    }
}

/// 시작하기 → 자동 실행 (public/app/features/onboarding.js): `webkit.messageHandlers.loginItem.postMessage({op: "get"})`
/// or `{op: "set", enabled}` → Promise of `{status, enabled, message?}` (status = LoginItem.describe). Same LoginItem path
/// as the menu toggle. Only the dashboard page (http://127.0.0.1:<port>) may call it.
private final class LoginItemHandler: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let body = message.body as? [String: Any]
        let op = body?["op"] as? String
        let enabled = body?["enabled"] as? Bool
        let src = message.frameInfo.request.url
        MainActor.assumeIsolated {
            guard let src, src.scheme == "http", src.host == "127.0.0.1" || src.host == "localhost", (src.port ?? 80) == AppConfig.port else {
                DaemonManager.shared.note("login item: ignored a message from \(src?.absoluteString ?? "?")")
                replyHandler(nil, "not allowed")
                return
            }
            var li = LoginItem()
            if op == "set", let enabled {
                DaemonManager.shared.note("login item: dashboard 시작하기 → \(enabled ? "register" : "unregister")")
                li.set(enabled)
            } else if op == "get" {
                li.refresh()
            } else {
                replyHandler(nil, "unknown op")
                return
            }
            var reply: [String: Any] = ["status": LoginItem.describe(li.status), "enabled": li.enabled]
            if let m = li.message { reply["message"] = m }
            replyHandler(reply, nil)
        }
    }
}

/// Adds the shortcuts a menu bar app lacks (no main menu): ⌘W close, ⌘R reload, edit keys.
final class DashboardWindow: NSWindow {
    var onReload: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown,
              event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              let key = event.charactersIgnoringModifiers?.lowercased() else {
            return super.performKeyEquivalent(with: event)
        }
        let action: Selector?
        switch key {
        case "w": performClose(nil); return true
        case "r": onReload?(); return true
        case "m": miniaturize(nil); return true
        case "x": action = #selector(NSText.cut(_:))
        case "c": action = #selector(NSText.copy(_:))
        case "v": action = #selector(NSText.paste(_:))
        case "a": action = #selector(NSText.selectAll(_:))
        case "z": action = Selector(("undo:"))
        default: action = nil
        }
        if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        return super.performKeyEquivalent(with: event)
    }
}
