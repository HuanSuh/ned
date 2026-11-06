import Foundation
import Combine
import os

let log = Logger(subsystem: "com.ned.menubar", category: "state")

// MARK: - Model (mirrors packages/daemon/src/state.ts + sessions.ts)
//
// Only the fields the UI truly needs are required. Everything else is optional
// with a default so a daemon that adds/removes a field never blanks the menu.

struct SessionView: Codable, Identifiable {
    var id: String
    var cwd: String = ""
    var worktree: String = "?"
    var status: String = "running"
    var since: Double = 0
    var last_event_ts: Double = 0
    var last_prompt: String? = nil
    var last_summary: String? = nil
    var subagents_active: Int = 0
    var orca_worktree: String? = nil

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        worktree = try c.decodeIfPresent(String.self, forKey: .worktree)
            ?? (cwd.isEmpty ? "?" : (cwd as NSString).lastPathComponent)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "running"
        since = try c.decodeIfPresent(Double.self, forKey: .since) ?? 0
        last_event_ts = try c.decodeIfPresent(Double.self, forKey: .last_event_ts) ?? since
        last_prompt = try c.decodeIfPresent(String.self, forKey: .last_prompt)
        last_summary = try c.decodeIfPresent(String.self, forKey: .last_summary)
        subagents_active = try c.decodeIfPresent(Int.self, forKey: .subagents_active) ?? 0
        orca_worktree = try c.decodeIfPresent(String.self, forKey: .orca_worktree)
    }
}

struct AttentionItem: Codable, Identifiable {
    var id: String
    var kind: String = "other"
    var title: String
    var detail: String? = nil
    var url: String? = nil
    var ts: Double = 0
    var source: String = ""

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "other"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "(제목 없음)"
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        ts = try c.decodeIfPresent(Double.self, forKey: .ts) ?? 0
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? ""
    }
}

struct LastBriefing: Codable {
    var id: String = ""
    var ts: Double = 0
    var type: String = "heartbeat"
    var status: String = "NED_OK"
    var headline: String? = nil

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        ts = try c.decodeIfPresent(Double.self, forKey: .ts) ?? 0
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "heartbeat"
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "NED_OK"
        headline = try c.decodeIfPresent(String.self, forKey: .headline)
    }
}

/// Decodes an element, or drops it (logging) instead of failing the whole array.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        do { value = try T(from: decoder) }
        catch { log.error("dropping undecodable element: \(String(describing: error), privacy: .public)"); value = nil }
    }
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

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        updated_at = try c.decodeIfPresent(Double.self, forKey: .updated_at) ?? 0
        daemon_pid = try c.decodeIfPresent(Int.self, forKey: .daemon_pid) ?? 0
        sessions = (try c.decodeIfPresent([Lossy<SessionView>].self, forKey: .sessions) ?? []).compactMap(\.value)
        attention = (try c.decodeIfPresent([Lossy<AttentionItem>].self, forKey: .attention) ?? []).compactMap(\.value)
        last_briefing = try? c.decodeIfPresent(LastBriefing.self, forKey: .last_briefing)
        last_heartbeat_at = try? c.decodeIfPresent(Double.self, forKey: .last_heartbeat_at)
        next_heartbeat_at = try? c.decodeIfPresent(Double.self, forKey: .next_heartbeat_at)
        quiet = (try? c.decodeIfPresent(Bool.self, forKey: .quiet)) ?? false
    }

    /// Daemon writes state at least every heartbeat; treat >20 min silence as dead.
    var daemonAlive: Bool { Date().timeIntervalSince1970 * 1000 - updated_at < 20 * 60 * 1000 }
}

// MARK: - Store

@MainActor
final class StateStore: ObservableObject {
    @Published var state = NedState()
    /// Set when the last read failed; the UI keeps showing the previous good state.
    @Published var lastError: String? = nil

    let home = AppConfig.home
    var statePath: String { home + "/state.json" }
    var port: Int { AppConfig.port }

    private var source: DispatchSourceFileSystemObject?
    private var timer: Timer?
    private var pendingReload: DispatchWorkItem?

    var attentionCount: Int { state.attention.count }
    var runningCount: Int { state.sessions.filter { $0.status == "running" }.count }

    init() {
        log.info("NED_HOME=\(self.home, privacy: .public)")
        reload()
        watch()
        // Directory watch catches atomic rename; the timer is a safety net and
        // re-arms the watch if the directory did not exist at launch.
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.source == nil { self.watch() }
                self.reload()
            }
        }
    }

    func reload() {
        guard let data = FileManager.default.contents(atPath: statePath) else {
            // File momentarily absent mid-rename or daemon never ran: keep old state.
            lastError = "state.json not found"
            return
        }
        do {
            let decoded = try JSONDecoder().decode(NedState.self, from: data)
            state = decoded
            lastError = nil
            log.info("decoded state: sessions=\(decoded.sessions.count) attention=\(decoded.attention.count) briefing=\(decoded.last_briefing?.status ?? "nil", privacy: .public) quiet=\(decoded.quiet)")
        } catch {
            // Partial write or garbage: keep the last good state instead of blanking the UI.
            lastError = String(describing: error)
            log.error("decode failed, keeping previous state: \(String(describing: error), privacy: .public)")
        }
    }

    /// Debounced reload: a rename produces several directory events in a row.
    private func scheduleReload() {
        pendingReload?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.reload() }
        pendingReload = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: w)
    }

    /// Watch the *directory*, not the file: the daemon writes `state.json.tmp`
    /// and renames it over `state.json`, so a file-level watch would go stale
    /// after the first write. Any rename/write inside the dir triggers reload.
    private func watch() {
        source?.cancel(); source = nil
        let fd = open(home, O_EVTONLY)
        guard fd >= 0 else { log.error("cannot open \(self.home, privacy: .public) for watching"); return }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete, .extend, .attrib, .link],
            queue: .main)
        src.setEventHandler { [weak self] in
            guard let self else { return }
            let ev = src.data
            if ev.contains(.delete) || ev.contains(.rename) && !FileManager.default.fileExists(atPath: self.home) {
                // Directory itself went away (e.g. ~/.ned recreated); re-arm next tick.
                self.source?.cancel(); self.source = nil
            }
            self.scheduleReload()
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        source = src
        log.info("watching \(self.home, privacy: .public)")
    }

    private func post(_ path: String, then completion: (() -> Void)? = nil) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { _, resp, err in
            if let err { log.error("POST \(path, privacy: .public) failed: \(err.localizedDescription, privacy: .public)") }
            else { log.info("POST \(path, privacy: .public) -> \((resp as? HTTPURLResponse)?.statusCode ?? 0)") }
            Task { @MainActor in completion?() }
        }.resume()
    }

    func dismiss(_ id: String) {
        // Optimistic: hide locally, daemon rewrites state.json which reloads anyway.
        state.attention.removeAll { $0.id == id }
        post("/api/attention/\(id)/dismiss") { [weak self] in self?.reload() }
    }

    func triggerHeartbeat() { post("/api/heartbeat") }
}
