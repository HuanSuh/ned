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
            MenuContent(store: store)
        } label: {
            MenuBarLabel(store: store)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Logs lifecycle and keeps the app alive when its only window (the menu panel) closes.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        log.info("didFinishLaunching policy=\(NSApp.activationPolicy().rawValue)")
    }
    func applicationWillTerminate(_ notification: Notification) { log.error("applicationWillTerminate") }
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
