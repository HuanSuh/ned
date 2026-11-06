import SwiftUI

@main
struct NedApp: App {
    @StateObject private var store = StateStore()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(store: store)
        } label: {
            MenuBarLabel(store: store)
        }
        .menuBarExtraStyle(.window)
    }
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
