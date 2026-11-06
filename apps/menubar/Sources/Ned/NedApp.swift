import SwiftUI
import AppKit

@main
struct NedApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = StateStore()
    /// Bound so that the system hiding the item (macOS 26 "Allow in Menu Bar",
    /// a crowded/notched menu bar, Cmd-drag removal) does not terminate the app.
    /// In-memory on purpose: persisting it would keep the item hidden on every later launch.
    @State private var inserted = true

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
        HStack(spacing: 3) {
            Image(systemName: store.state.daemonAlive ? (store.attentionCount > 0 ? "eyeglasses" : "eye") : "eye.slash")
            if store.attentionCount > 0 {
                Text("\(store.attentionCount)").font(.system(size: 11, weight: .semibold)).monospacedDigit()
            } else if store.runningCount > 0 {
                Text("\(store.runningCount)").font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
            }
        }
    }
}
