import SwiftUI
import AppKit
import ServiceManagement

@main
struct NedApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        // Headless pet checks — before StatusItemGuard touches any defaults. Selftest uses its own defaults suite;
        // snapshot writes PNGs only to the given directory.
        if CommandLine.arguments.contains("--pet-selftest") { exit(MainActor.assumeIsolated { PetSelfTest.run() }) }
        if let i = CommandLine.arguments.firstIndex(of: "--pet-snapshot") {
            let args = CommandLine.arguments
            let dir = i + 1 < args.count ? args[i + 1] : NSTemporaryDirectory() + "ned-pet-snapshot"
            exit(MainActor.assumeIsolated { PetSnapshot.run(dir: dir) })
        }
        // Headless: appSettings bridge whitelist / origin / set on its own defaults suite; menu PNGs into the given directory.
        if CommandLine.arguments.contains("--appsettings-selftest") { exit(MainActor.assumeIsolated { AppSettingsSelfTest.run() }) }
        if let i = CommandLine.arguments.firstIndex(of: "--menu-snapshot") {
            let args = CommandLine.arguments
            let dir = i + 1 < args.count ? args[i + 1] : NSTemporaryDirectory() + "ned-menu-snapshot"
            exit(MainActor.assumeIsolated { MenuSnapshot.run(dir: dir) })
        }
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
        // Headless register / unregister (/ned:install "자동 실행" step — works whether or not Ned is already running:
        // SMAppService.mainApp is per bundle, so the running app's menu toggle sees it on its next refresh). Exits.
        for (flag, on) in [("--login-item-register", true), ("--login-item-unregister", false)] where CommandLine.arguments.contains(flag) {
            exit(LoginItem.headless(register: on))
        }
    }

    /// No status item scene: the menu bar item is an AppKit NSStatusItem owned by AppDelegate (StatusItemController).
    /// An `App` needs one scene. It used to be `Settings { EmptyView() }`, and SwiftUI brought that empty "Ned Settings"
    /// window up at every launch on macOS 26 (no saved state; refusing untitled / reopen and ordering the dashboard
    /// before activating did not stop it). A MenuBarExtra that is never inserted has no window and no status item — so
    /// there is nothing to open. Ned's settings live in the dashboard (설정 탭).
    var body: some Scene {
        MenuBarExtra("Ned", isInserted: .constant(false)) { EmptyView() }
    }
}

/// Logs lifecycle, owns the store, the status item and the daemon child, and keeps the app alive when its windows close.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var sigterm: DispatchSourceSignal?
    private var store: StateStore?
    private var statusItem: StatusItemController?
    private var pet: DesktopPetController?

    func applicationWillFinishLaunching(_ notification: Notification) {
        LaunchBehavior.registerDefaults()
        LaunchBehavior.captureLaunchEvent()
    }

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
            // Floating Ned (off by default; config.pet.enabled — 설정 → 외형 → 데스크톱 펫).
            let pet = DesktopPetController()
            pet.attach(store: store)
            self.pet = pet
            StatusItemGuard.shared.start()
            DaemonManager.shared.start()
            Notifier.shared.start()
            // A launch should show something: the dashboard window (boot screen → dashboard) unless turned off,
            // or launched at login (menu bar only by default) — see LaunchBehavior.
            let launch = LaunchBehavior.decide()
            DaemonManager.shared.note("launch: dashboard \(launch.open ? "open" : "not opened") — \(launch.reason)")
            if launch.open { DashboardWindowController.shared.show() }
            if CommandLine.arguments.contains("--wake-selftest") {
                Task { await DaemonManager.shared.wakeSelfTest() }
            }
            if CommandLine.arguments.contains("--persona-selftest") {
                Task { await PersonaSelfTest.run() }
            }
            // Diagnostic: exercise the same register/unregister path as 설정 → 앱 (자동 실행) and log it.
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
    /// Reopen (Dock / Finder / a second `open`) shows the dashboard. Returns false: with true AppKit goes on to its own
    /// reopen, and SwiftUI answers that by opening the app's only scene — the empty Settings window (the "Ned Settings"
    /// flash at launch / reopen). The dashboard is Ned's window; nothing else should open.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated { DashboardWindowController.shared.show() }
        return false
    }
    /// No "untitled document" at launch: SwiftUI would open the Settings scene for it. LaunchBehavior decides the dashboard.
    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}
