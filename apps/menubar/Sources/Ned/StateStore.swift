import Foundation
import Combine

struct SessionView: Codable, Identifiable {
    let id: String
    let worktree: String
    let status: String
    let since: Double
    let last_event_ts: Double
    let last_prompt: String?
    let last_summary: String?
    let subagents_active: Int
}

struct AttentionItem: Codable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let detail: String?
    let url: String?
    let ts: Double
}

struct LastBriefing: Codable {
    let id: String
    let ts: Double
    let type: String
    let status: String
    let headline: String?
}

struct NedState: Codable {
    var updated_at: Double = 0
    var daemon_pid: Int = 0
    var sessions: [SessionView] = []
    var attention: [AttentionItem] = []
    var last_briefing: LastBriefing? = nil
    var last_heartbeat_at: Double? = nil
    var next_heartbeat_at: Double? = nil
    var quiet: Bool = false

    /// Daemon writes state at least every heartbeat; treat >20 min silence as dead.
    var daemonAlive: Bool { Date().timeIntervalSince1970 * 1000 - updated_at < 20 * 60 * 1000 }
}

@MainActor
final class StateStore: ObservableObject {
    @Published var state = NedState()

    let home = ProcessInfo.processInfo.environment["NED_HOME"] ?? (NSHomeDirectory() + "/.ned")
    var statePath: String { home + "/state.json" }
    var port: Int { 7777 }

    private var source: DispatchSourceFileSystemObject?
    private var fd: Int32 = -1
    private var timer: Timer?

    var attentionCount: Int { state.attention.count }
    var runningCount: Int { state.sessions.filter { $0.status == "running" }.count }

    init() {
        reload()
        watch()
        // Directory watch catches atomic rename; the timer is a safety net.
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    func reload() {
        guard let data = FileManager.default.contents(atPath: statePath),
              let decoded = try? JSONDecoder().decode(NedState.self, from: data) else { return }
        state = decoded
    }

    private func watch() {
        fd = open(home, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename], queue: .main)
        src.setEventHandler { [weak self] in self?.reload() }
        src.setCancelHandler { [fd] in close(fd) }
        src.resume()
        source = src
    }

    func dismiss(_ id: String) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/attention/\(id)/dismiss")!)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            Task { @MainActor in self?.reload() }
        }.resume()
    }

    func triggerHeartbeat() {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/heartbeat")!)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }
}
