import AppKit
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

    /// The boot screen stays at least this long, even when the daemon answers at once (cache hit ≈ <1 s),
    /// so it never flashes; then it fades out (0.32 s, BootScreen CSS) into the dashboard.
    static let minBootScreenSeconds: TimeInterval = 1.5
    static let fadeSeconds: TimeInterval = 0.35

    func show() {
        if window == nil { build() }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        if !loaded { waitForDaemon() }
    }

    private func build() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.userContentController.add(BootMessageHandler(), name: "ned")
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

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
    /// screen, push progress into it every 0.5 s via `nedBoot(...)`, and once `/api/state` answers (and the screen
    /// has been up ≥ minBootScreenSeconds) fade it out and load the dashboard.
    private func waitForDaemon() {
        waitTimer?.invalidate()
        finishing = false
        let daemon = DaemonManager.shared
        if daemon.isHealthy {
            bootShownAt = nil
            loadDashboard(reason: "daemon already healthy — no boot screen")
            return
        }
        bootShownAt = Date()
        let s = Self.bootSnapshot()
        webView.loadHTMLString(BootScreen.html(theme: Self.theme(), step: s.step, text: s.text, elapsed: s.elapsed, failed: s.failed), baseURL: nil)
        daemon.note("dashboard window: boot screen (persona \(Self.theme().id.rawValue), step \(s.step) \(s.text))")
        let poll: () -> Void = { [weak self] in
            _ = Task { @MainActor in
                guard let self, !self.loaded, !self.finishing else { return }
                let s = Self.bootSnapshot()
                _ = try? await self.webView.evaluateJavaScript(BootScreen.update(step: s.step, text: s.text, elapsed: s.elapsed, failed: s.failed))
                guard !s.failed, await DaemonManager.probe(timeout: 1) != nil, !self.loaded, !self.finishing else { return }
                self.finishing = true
                self.waitTimer?.invalidate()
                let last = BootScreen.update(step: DaemonManager.BootStage.dashboard.rawValue, text: "대시보드 불러오는 중…", elapsed: DaemonManager.shared.bootElapsed, failed: false)
                _ = try? await self.webView.evaluateJavaScript(last)
                let shown = Date().timeIntervalSince(self.bootShownAt ?? Date())
                if shown < Self.minBootScreenSeconds {
                    try? await Task.sleep(nanoseconds: UInt64((Self.minBootScreenSeconds - shown) * 1_000_000_000))
                }
                _ = try? await self.webView.evaluateJavaScript("window.nedBootDone && nedBootDone();")
                try? await Task.sleep(nanoseconds: UInt64(Self.fadeSeconds * 1_000_000_000))
                guard self.finishing, !self.loaded else { return }
                self.loadDashboard(reason: String(format: "daemon answered — boot screen shown %.1fs", Date().timeIntervalSince(self.bootShownAt ?? Date())))
            }
        }
        poll()
        waitTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in poll() }
    }

    private func loadDashboard(reason: String) {
        waitTimer?.invalidate()
        loaded = true
        finishing = false
        wlog.info("\(reason, privacy: .public) — loading dashboard")
        DaemonManager.shared.note("dashboard window: \(reason) — loading \(AppConfig.baseURL.absoluteString)/")
        webView.load(URLRequest(url: AppConfig.baseURL))
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
        return BootScreen.Theme(id: p.id, name: p.displayName, accent: p.accentHex)
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        waitTimer?.invalidate()
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
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
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
