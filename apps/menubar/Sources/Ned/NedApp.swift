import SwiftUI
import AppKit
import ServiceManagement

@main
struct NedApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        // Forget any "hidden" flag AppKit wrote into our defaults (legacy MenuBarExtra "Item-0" keys and the
        // AppKit item's own autosave name) before the status item exists — see StatusItemController.
        MainActor.assumeIsolated { StatusItemGuard.clearFlags() }
        // Headless: status item created → values logged → removed (run the bare binary, not the bundle).
        if CommandLine.arguments.contains("--statusitem-selftest") { MainActor.assumeIsolated { StatusItemSelfTest.run() } }
        // Headless: before any scene, store, daemon or notification center exists.
        if CommandLine.arguments.contains("--notify-selftest") { exit(NotifySelfTest.run()) }
        // Headless: tool cache + boot screen HTML (own defaults suite, writes only to $TMPDIR / NED_BOOT_HTML_OUT).
        if CommandLine.arguments.contains("--boot-selftest") { exit(BootSelfTest.run()) }
        // Headless boot screen → dashboard timing (real daemon on a temp NED_HOME/NED_PORT; no scene, no menu bar item).
        if CommandLine.arguments.contains("--boot-transition-selftest") { MainActor.assumeIsolated { BootTransitionSelfTest.run() } }
        // Read-only: print SMAppService.mainApp status (registers nothing) and exit.
        if CommandLine.arguments.contains("--login-item-status") {
            let s = SMAppService.mainApp.status
            let label = s == .enabled ? "켜짐" : (s == .requiresApproval ? "꺼짐 (승인 필요)" : "꺼짐")
            print("login-item-status: \(LoginItem.describe(s)) (rawValue \(s.rawValue)) — 자동 시작: \(label)")
            print("bundle: \(Bundle.main.bundlePath) id=\(Bundle.main.bundleIdentifier ?? "nil")")
            if s == .requiresApproval { print("approve: System Settings > General > Login Items & Extensions (macOS 14: Login Items) → Ned under 'Open at Login' / turn Ned on under 'Allow in the Background'") }
            fflush(stdout)
            exit(0)
        }
    }

    /// No status item scene: the menu bar item is an AppKit NSStatusItem owned by AppDelegate
    /// (StatusItemController). An empty Settings scene is the minimum an `App` needs.
    var body: some Scene {
        Settings { EmptyView() }
    }
}

/// Logs lifecycle, owns the store, the status item and the daemon child, and keeps the app alive when its windows close.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var sigterm: DispatchSourceSignal?
    private var store: StateStore?
    private var statusItem: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        log.info("didFinishLaunching policy=\(NSApp.activationPolicy().rawValue)")
        // `kill <pid>` / `pkill -x Ned` / logout: quit through NSApp so the daemon child is stopped too.
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { NSApp.terminate(nil) }
        src.resume()
        sigterm = src
        MainActor.assumeIsolated {
            let store = StateStore()
            self.store = store
            statusItem = StatusItemController(store: store)
            StatusItemGuard.shared.start()
            DaemonManager.shared.start()
            Notifier.shared.start()
            // `open Ned.app --args --dashboard` (install.sh first launch) or NED_OPEN_DASHBOARD=1.
            if CommandLine.arguments.contains("--dashboard") || AppConfig.env["NED_OPEN_DASHBOARD"] == "1" {
                DashboardWindowController.shared.show()
            }
            if CommandLine.arguments.contains("--wake-selftest") {
                Task { await DaemonManager.shared.wakeSelfTest() }
            }
            if CommandLine.arguments.contains("--persona-selftest") {
                Task { await PersonaSelfTest.run() }
            }
            // Diagnostic: exercise the same register/unregister path as the menu toggle and log it.
            if CommandLine.arguments.contains("--login-item-selftest") {
                var li = LoginItem()
                li.set(true)
                DaemonManager.shared.note("login item selftest: enabled=\(li.enabled) message=\(li.message ?? "nil")")
                li.set(false)
            }
        }
    }
    func applicationWillTerminate(_ notification: Notification) {
        log.error("applicationWillTerminate")
        MainActor.assumeIsolated { DaemonManager.shared.stopSync() }
    }
    /// Dock icon click (while the dashboard made the app .regular) reopens the dashboard.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated { DashboardWindowController.shared.show() }
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}
