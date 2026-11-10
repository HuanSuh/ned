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

    /// No status item scene: the menu bar item is an AppKit NSStatusItem owned by AppDelegate
    /// (StatusItemController). A Settings scene is the minimum an `App` needs — but Ned's settings live in the dashboard
    /// (설정 탭), so its window must never stay up as an empty "Ned Settings": SettingsRedirect closes it at once.
    var body: some Scene {
        Settings { SettingsRedirect() }
    }
}

/// The SwiftUI Settings window's content. It closes its own window as soon as it appears and, when the person asked for
/// it (⌘, / app menu "Settings…"), opens the dashboard's 설정 → 앱(Ned.app) instead. Shown within the first seconds of
/// launch it was not asked for (window restoration / activation brought it up): it only closes, so a launch never
/// opens the dashboard against LaunchBehavior. Either way the event is logged to find what raised it.
struct SettingsRedirect: View {
    /// Below this many seconds after launch the window counts as not asked for.
    static let launchGrace: TimeInterval = 5
    static let launchedAt = Date()

    var body: some View {
        Color.clear.frame(width: 1, height: 1)
            .onAppear {
                DispatchQueue.main.async {
                    for w in NSApp.windows where w.identifier?.rawValue.contains("Settings") == true || w.title.hasSuffix("Settings") {
                        w.close()
                    }
                    let early = Date().timeIntervalSince(Self.launchedAt) < Self.launchGrace
                    DaemonManager.shared.note("settings window: appeared \(early ? "at launch — closed (not asked for)" : "— closed, opening 설정 → 앱")")
                    if !early { DashboardWindowController.shared.show(section: "s-app") }
                }
            }
    }
}

/// Logs lifecycle, owns the store, the status item and the daemon child, and keeps the app alive when its windows close.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var sigterm: DispatchSourceSignal?
    private var store: StateStore?
    private var statusItem: StatusItemController?
    private var pet: DesktopPetController?

    func applicationWillFinishLaunching(_ notification: Notification) {
        _ = SettingsRedirect.launchedAt // pin the launch time (a static let is set on first read)
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
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated { DashboardWindowController.shared.show() }
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}
