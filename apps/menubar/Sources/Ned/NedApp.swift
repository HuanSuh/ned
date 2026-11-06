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
    @State private var inserted = true

    init() {
        // Headless: before any scene, store, daemon or notification center exists.
        if CommandLine.arguments.contains("--notify-selftest") { exit(NotifySelfTest.run()) }
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
        }
        .menuBarExtraStyle(.window)
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
        HStack(spacing: 3) {
            if store.attentionCount > 0 {
                // MenuBarExtra keeps only one image + one text from the label, and templates the
                // image; so the symbol and the accent badge are composed into one non-template image.
                Image(nsImage: Self.badged(p.symbol(mode), count: store.attentionCount, color: p.accentNS))
                    .accessibilityLabel("\(p.displayName): 확인할 것 \(store.attentionCount)건")
                    // New identity per persona/count/mode: an in-place NSImage swap could lag a redraw.
                    .id("\(p.id.rawValue)-\(store.attentionCount)-\(mode)")
            } else {
                Image(systemName: p.symbol(mode))
                if store.runningCount > 0 {
                    Text("\(store.runningCount)").font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
                }
            }
        }
        .help(p.displayName)
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
