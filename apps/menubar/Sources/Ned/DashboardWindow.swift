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

    private func waitForDaemon() {
        waitTimer?.invalidate()
        webView.loadHTMLString(Self.placeholder, baseURL: nil)
        let poll: () -> Void = { [weak self] in
            _ = Task { @MainActor in
                guard let self, !self.loaded else { return }
                if await DaemonManager.probe(timeout: 1) != nil {
                    self.waitTimer?.invalidate()
                    self.loaded = true
                    wlog.info("daemon answered — loading dashboard")
                    DaemonManager.shared.note("dashboard window: loading \(AppConfig.baseURL.absoluteString)/")
                    self.webView.load(URLRequest(url: AppConfig.baseURL))
                }
            }
        }
        poll()
        waitTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { _ in poll() }
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

    private static let placeholder = """
    <!doctype html><meta charset="utf-8"><title>Ned</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin:0; height:100vh; display:grid; place-items:center;
             font: 14px -apple-system, system-ui; color: #8a8f98; background: Canvas; }
      .d { text-align:center } .s { font-size: 28px; animation: p 1.2s ease-in-out infinite; }
      @keyframes p { 50% { opacity: .35 } }
    </style>
    <div class="d"><div class="s">👓</div><p>daemon starting…</p></div>
    """
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
