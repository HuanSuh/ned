import SwiftUI
import AppKit
import ServiceManagement

@main
struct NedApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = StateStore()
    /// Bound so that the system hiding the item (macOS 26 "Allow in Menu Bar",
    /// a crowded/notched menu bar, Cmd-drag removal) does not terminate the app.
    /// In-memory on purpose: persisting it would keep the item hidden on every later launch.
    /// Must stay a plain @State: binding MenuBarExtra to an ObservableObject looped the main thread at 98 % CPU
    /// (2026-11-07 — the system's own write of `false` re-ran the scene, which re-ran the write, forever).
    @State private var inserted = true

    init() {
        // When the item is hidden (⌘-drag off the bar, or the macOS 26 Menu Bar toggle) AppKit writes
        // "NSStatusItem Visible(CC) Item-0" = 0 into our defaults and keeps the item hidden on every later launch,
        // even after the toggle is on again (seen live 2026-11-07). A menu bar app with no icon is unreachable,
        // so forget that flag at start-up; the user can still hide it for the current run.
        StatusItemGuard.clearFlags()
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

    var body: some Scene {
        MenuBarExtra(isInserted: $inserted) {
            MenuContent(store: store, daemon: DaemonManager.shared)
        } label: {
            MenuBarLabel(store: store)
                // StatusItemGuard found the hidden flag: re-insert once, outside SwiftUI's own update transaction.
                .onReceive(NotificationCenter.default.publisher(for: StatusItemGuard.reinsert)) { _ in
                    guard inserted else { inserted = true; return }
                    inserted = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { inserted = true }
                }
        }
        .menuBarExtraStyle(.window)
    }
}

/// Keeps the menu bar item on screen. macOS persists "NSStatusItem Visible(CC) Item-0" = 0 in our defaults when it
/// hides the item (⌘-drag, the macOS 26 Menu Bar toggle, or — seen live 2026-11-07 — a status item re-created by a
/// label change) and then honours that flag on every later launch. A menu bar app with no icon is unreachable, so:
/// forget the flag at start-up, and while running poll it every 10 s; if it reappears, clear it and re-insert the item.
/// Not an ObservableObject on purpose (see `NedApp.inserted`): it only clears the flag and posts `reinsert`,
/// at most once a minute, and the label view flips the @State binding from outside SwiftUI's transaction.
@MainActor
final class StatusItemGuard {
    static let shared = StatusItemGuard()
    static let keys = ["NSStatusItem Visible Item-0", "NSStatusItem VisibleCC Item-0"]
    static let reinsert = Notification.Name("ned.statusItem.reinsert")
    private var timer: Timer?
    private var lastReinsert = Date.distantPast

    static func clearFlags() {
        for k in keys { UserDefaults.standard.removeObject(forKey: k) }
    }

    func start() {
        Self.clearFlags()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
            Task { @MainActor in StatusItemGuard.shared.check() }
        }
    }

    func check() {
        let d = UserDefaults.standard
        let hidden = Self.keys.contains { d.object(forKey: $0) != nil && !d.bool(forKey: $0) }
        guard hidden else { return }
        Self.clearFlags()
        guard Date().timeIntervalSince(lastReinsert) > 60 else { return }
        lastReinsert = Date()
        DaemonManager.shared.note("status item: macOS flagged it hidden — flag cleared, re-inserting once")
        NotificationCenter.default.post(name: Self.reinsert, object: nil)
    }
}

/// Logs lifecycle, owns the daemon child, and keeps the app alive when its windows close.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var sigterm: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        log.info("didFinishLaunching policy=\(NSApp.activationPolicy().rawValue)")
        // `kill <pid>` / `pkill -x Ned` / logout: quit through NSApp so the daemon child is stopped too.
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { NSApp.terminate(nil) }
        src.resume()
        sigterm = src
        MainActor.assumeIsolated {
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

struct MenuBarLabel: View {
    @ObservedObject var store: StateStore

    var body: some View {
        let p = store.persona
        let mode: Persona.Mode = !store.state.daemonAlive ? .offline : (store.attentionCount > 0 ? .attention : .idle)
        let n = store.attentionCount
        // One fixed shape — always exactly one Image and one Text, never `.id()`, never an if/else between
        // different view trees. Seen live (2026-11-07): the old label switched trees when the first attention
        // item arrived (02:39:18) and 9 s later AppKit wrote "NSStatusItem VisibleCC Item-0 = 0" into our
        // defaults — the status item had been torn down and re-created, and macOS 26 treated the teardown as
        // "hidden". The icon vanished while the daemon kept running, and came back only on a relaunch.
        // MenuBarExtra keeps one image + one text from the label and templates the image; the badge is
        // composed into one non-template image so the accent capsule keeps its color.
        HStack(spacing: 3) {
            Image(nsImage: n > 0 ? Self.badged(p.symbol(mode), count: n, color: p.accentNS) : Self.plain(p.symbol(mode)))
                .accessibilityLabel(n > 0 ? "\(p.displayName): 확인할 것 \(n)건" : p.displayName)
            Text(n == 0 && store.runningCount > 0 ? "\(store.runningCount)" : "")
                .font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
        }
        .help(p.displayName)
    }

    /// The bare symbol as a template image (follows the menu bar's label color like `Image(systemName:)` did).
    static func plain(_ symbol: String) -> NSImage {
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular)) ?? NSImage()
        img.isTemplate = true
        return img
    }

    /// Symbol in the menu bar's label color + an accent capsule holding the count (text black or
    /// white, whichever reads on the accent). Drawn lazily, so `labelColor` follows the bar's appearance.
    static func badged(_ symbol: String, count n: Int, color: NSColor) -> NSImage {
        let sym = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular)) ?? NSImage()
        let text = n > 99 ? "99+" : "\(n)"
        let rgb = color.usingColorSpace(.sRGB) ?? color
        let lum = 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .bold),
            .foregroundColor: lum > 0.55 ? NSColor.black : NSColor.white,
        ]
        let ts = (text as NSString).size(withAttributes: attrs)
        let badge = NSSize(width: max(14, ceil(ts.width) + 8), height: 14)
        let gap: CGFloat = 3
        let size = NSSize(width: ceil(sym.size.width) + gap + badge.width, height: max(ceil(sym.size.height), badge.height))
        let img = NSImage(size: size, flipped: false) { _ in
            let sr = NSRect(x: 0, y: (size.height - sym.size.height) / 2, width: sym.size.width, height: sym.size.height)
            sym.draw(in: sr)
            NSColor.labelColor.set()
            sr.fill(using: .sourceAtop)
            let br = NSRect(x: sr.maxX + gap, y: (size.height - badge.height) / 2, width: badge.width, height: badge.height)
            color.setFill()
            NSBezierPath(roundedRect: br, xRadius: br.height / 2, yRadius: br.height / 2).fill()
            (text as NSString).draw(at: NSPoint(x: br.midX - ts.width / 2, y: br.midY - ts.height / 2), withAttributes: attrs)
            return true
        }
        img.isTemplate = false
        return img
    }
}
