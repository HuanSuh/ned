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
    /// Orca child worktree (the user's own agent worker): shown dimmed, never attention.
    var is_worker: Bool = false

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
        is_worker = (try? c.decodeIfPresent(Bool.self, forKey: .is_worker)) ?? false
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
    /// 확인 완료 (ms). Reviewed items stay in `attention` but are not open.
    var reviewed_at: Double? = nil

    var isOpen: Bool { reviewed_at == nil }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "other"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "(제목 없음)"
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        ts = try c.decodeIfPresent(Double.self, forKey: .ts) ?? 0
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? ""
        reviewed_at = try? c.decodeIfPresent(Double.self, forKey: .reviewed_at)
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

/// `state.json` `notifications` (daemon config.notifications). Every field defaults to the daemon's
/// DEFAULT_NOTIFICATIONS, so an older daemon (no field) or a partial object behaves as before.
struct NotifySettings: Codable, Sendable {
    var enabled: Bool = true
    /// Per attention kind (session/email/slack/jira/github/sentry/calendar). Missing kind = on.
    var kinds: [String: Bool] = [:]
    var briefing: Bool = true
    /// More than this many new items at once → one summary notification.
    var summary_threshold: Int = 3
    /// "skip" | "silent"; `nil` = absent → the `quietDelivery` user default (then "skip").
    var quiet_delivery: String? = nil
    var sound: Bool = true

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
        kinds = (try? c.decodeIfPresent([String: Bool].self, forKey: .kinds)) ?? [:]
        briefing = (try? c.decodeIfPresent(Bool.self, forKey: .briefing)) ?? true
        summary_threshold = max(0, (try? c.decodeIfPresent(Int.self, forKey: .summary_threshold)) ?? 3)
        let q = try? c.decodeIfPresent(String.self, forKey: .quiet_delivery)
        quiet_delivery = (q == "skip" || q == "silent") ? q : nil
        sound = (try? c.decodeIfPresent(Bool.self, forKey: .sound)) ?? true
    }

    func kindEnabled(_ kind: String) -> Bool { kinds[kind] ?? true }
}

/// `config.pet` (daemon src/config.ts NedPet) — mirrored into state.json and returned by GET /api/feed.
/// Missing / partial = the daemon defaults (off, every message kind on).
struct PetSettings: Codable, Equatable, Sendable {
    var enabled: Bool = false
    /// pet.messages.<kind> (greeting/session/slack/mail/jira/github/sentry/calendar/briefing). Missing kind = on.
    var messages: [String: Bool] = [:]

    init(enabled: Bool = false, messages: [String: Bool] = [:]) { self.enabled = enabled; self.messages = messages }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        messages = (try? c.decodeIfPresent([String: Bool].self, forKey: .messages)) ?? [:]
    }

    /// `nil` kind (attention kind "other") has no toggle: always on.
    func messageOn(_ kind: String?) -> Bool { kind.map { messages[$0] ?? true } ?? true }
}

/// One GET /api/feed item (daemon src/feed.ts FeedItem — the 통신기 메시지 rules + `pet_kind` + `deep`).
struct FeedItem: Codable, Equatable, Sendable {
    var key: String
    var kind: String = "other"
    /// The pet.messages toggle it falls under; `nil` = none (always shown).
    var pet_kind: String? = nil
    var title: String
    var detail: String = ""
    var url: String? = nil
    /// App deep link per 설정 → 링크 열기 (what the dashboard's openLink would hand over), else nil.
    var deep: String? = nil
    var ts: Double = 0

    init(key: String, kind: String = "other", pet_kind: String? = nil, title: String, detail: String = "", url: String? = nil, deep: String? = nil, ts: Double = 0) {
        self.key = key; self.kind = kind; self.pet_kind = pet_kind; self.title = title; self.detail = detail; self.url = url; self.deep = deep; self.ts = ts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "other"
        pet_kind = try? c.decodeIfPresent(String.self, forKey: .pet_kind)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        detail = (try? c.decodeIfPresent(String.self, forKey: .detail)) ?? ""
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        deep = try? c.decodeIfPresent(String.self, forKey: .deep)
        ts = (try? c.decodeIfPresent(Double.self, forKey: .ts)) ?? 0
    }
}

struct FeedResponse: Decodable {
    var items: [FeedItem]
    var pet: PetSettings?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try c.decodeIfPresent([Lossy<FeedItem>].self, forKey: .items) ?? []).compactMap(\.value)
        pet = try? c.decodeIfPresent(PetSettings.self, forKey: .pet)
    }
    enum CodingKeys: String, CodingKey { case items, pet }
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
    /// Raw `persona` from the daemon (config.persona). Missing/unknown → ned via `personaID`.
    var persona: String? = nil
    /// Notification preferences; defaults when the daemon does not write them.
    var notifications = NotifySettings()
    /// Daemon's count of attention not marked 확인 완료. `nil` = older daemon → derived from `reviewed_at`.
    var attention_open_count: Int? = nil
    /// config.pet mirrored by the daemon on every settings save; `nil` = older daemon / not saved yet.
    var pet: PetSettings? = nil

    var personaID: PersonaID { PersonaID(raw: persona) }
    /// Attention items still open (not 확인 완료) — what the dropdown lists.
    var openAttention: [AttentionItem] { attention.filter(\.isOpen) }
    /// Menu bar badge: `attention_open_count`, else the open items.
    var openCount: Int { attention_open_count.map { max(0, $0) } ?? openAttention.count }

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
        persona = try? c.decodeIfPresent(String.self, forKey: .persona)
        notifications = (try? c.decodeIfPresent(NotifySettings.self, forKey: .notifications)) ?? NotifySettings()
        attention_open_count = try? c.decodeIfPresent(Int.self, forKey: .attention_open_count)
        pet = try? c.decodeIfPresent(PetSettings.self, forKey: .pet)
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

    /// Optimistic choice from the menu's 페르소나 submenu, shown until the daemon's state.json
    /// reports a persona different from `overrideBase` (it caught up, or someone else changed it).
    @Published private(set) var personaOverride: PersonaID? = nil
    private var overrideBase: PersonaID = .ned

    var personaID: PersonaID { personaOverride ?? state.personaID }
    var persona: Persona { personaID.persona }

    /// Badge count: open (not 확인 완료) attention — see `NedState.openCount`.
    var attentionCount: Int { state.openCount }
    var runningCount: Int { state.sessions.filter { $0.status == "running" }.count }

    /// 데스크톱 펫: config.pet (from state.json on a settings save, and from GET /api/feed) and the 메시지 feed.
    @Published private(set) var pet = PetSettings()
    @Published private(set) var feed: [FeedItem] = []
    /// A feed answer arrived at least once (before that the pet stays hidden and seeds nothing).
    @Published private(set) var feedLoaded = false
    /// Last state.json `pet` seen: only a *change* there is applied — a later state write by the heartbeat carries the
    /// same (possibly older) mirror, which must not undo a newer value read from GET /api/feed (e.g. a hand edit).
    private var lastStatePet: PetSettings?
    private var feedInFlight = false
    private var feedAgain = false

    /// The app's single store (for `--persona-selftest`).
    static weak var current: StateStore?

    init() {
        Self.current = self
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
            let before = personaID
            if let o = personaOverride, decoded.personaID == o || decoded.personaID != overrideBase {
                personaOverride = nil
            }
            state = decoded
            if let p = decoded.pet, p != lastStatePet { lastStatePet = p; if pet != p { pet = p } }
            fetchFeed()
            if personaID != before {
                let p = persona
                DaemonManager.shared.note("persona \(before.rawValue) -> \(personaID.rawValue) (state.json persona=\(decoded.persona ?? "nil")) label=\(p.symbol(decoded.daemonAlive ? (decoded.openCount == 0 ? .idle : .attention) : .offline)) accent=\(p.accentHex) header=\(p.headerTitle)")
            }
            PersonaIcon.apply(personaID)
            lastError = nil
            Notifier.shared.stateDidLoad(decoded, store: self)
            log.info("decoded state: sessions=\(decoded.sessions.count) attention=\(decoded.attention.count) open=\(decoded.openCount) workers=\(decoded.sessions.filter(\.is_worker).count) briefing=\(decoded.last_briefing?.status ?? "nil", privacy: .public) quiet=\(decoded.quiet)")
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

    /// GET /api/feed — after every state.json reload (debounced there) and the 15 s safety timer. One request at a time;
    /// a reload during one runs one more right after. Failure keeps the last feed / pet settings.
    func fetchFeed() {
        if feedInFlight { feedAgain = true; return }
        feedInFlight = true
        Self.getFeed(port: port) { decoded in
            self.feedInFlight = false
            if let decoded {
                if self.feed != decoded.items { self.feed = decoded.items }
                if let p = decoded.pet, p != self.pet { self.pet = p }
                if !self.feedLoaded { self.feedLoaded = true }
            }
            if self.feedAgain { self.feedAgain = false; self.fetchFeed() }
        }
    }

    /// The pet's 숨기기 (and anything else that flips it from the app): saved through the daemon, applied locally right away.
    func setPetEnabled(_ on: Bool) {
        pet.enabled = on
        Self.putPetEnabled(on, port: port) { result in
            DaemonManager.shared.note("PUT /api/config pet.enabled=\(on) -> \(result)")
            self.fetchFeed()
        }
    }

    /// One GET /api/feed → decoded (nil on any failure). `done` runs on the main actor.
    nonisolated static func getFeed(port: Int, done: @escaping @MainActor (FeedResponse?) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/feed")!)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, resp, err in
            let ok = err == nil && (resp as? HTTPURLResponse)?.statusCode == 200
            let decoded = ok ? data.flatMap { try? JSONDecoder().decode(FeedResponse.self, from: $0) } : nil
            Task { @MainActor in done(decoded) }
        }.resume()
    }

    /// PUT /api/config {pet: {enabled}} with config's current `if_updated_at` (GET /api/config first; one retry on 409
    /// with the token the 409 returns). `done("HTTP 200")` / the error, on the main actor.
    nonisolated static func putPetEnabled(_ on: Bool, port: Int, done: @escaping @MainActor (String) -> Void) {
        let base = "http://127.0.0.1:\(port)/api/config"
        @Sendable func put(_ token: Double?, retry: Bool) {
            var req = URLRequest(url: URL(string: base)!)
            req.httpMethod = "PUT"
            req.timeoutInterval = 3
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = ["pet": ["enabled": on]]
            if let token { body["if_updated_at"] = token }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: req) { data, resp, err in
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let current = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["current"] as? [String: Any]
                let next = current?["updated_at"] as? Double
                if code == 409, retry, let next { put(next, retry: false); return }
                let result = err?.localizedDescription ?? "HTTP \(code)"
                Task { @MainActor in done(result) }
            }.resume()
        }
        var get = URLRequest(url: URL(string: base)!)
        get.timeoutInterval = 3
        URLSession.shared.dataTask(with: get) { data, _, _ in
            let token = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["updated_at"] as? Double
            put(token, retry: true)
        }.resume()
    }

    /// 페르소나 submenu: switch immediately, PUT {persona} to the daemon's config route, revert on failure.
    func setPersona(_ id: PersonaID) {
        guard id != personaID else { return }
        let previous = personaOverride
        let previousBase = overrideBase
        overrideBase = state.personaID
        personaOverride = id
        PersonaIcon.apply(personaID)
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/config")!)
        req.httpMethod = "PUT"
        req.timeoutInterval = 3
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["persona": id.rawValue])
        DaemonManager.shared.note("PUT /api/config {\"persona\":\"\(id.rawValue)\"} (optimistic)")
        URLSession.shared.dataTask(with: req) { _, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let desc = err?.localizedDescription
            Task { @MainActor in
                guard self.personaOverride == id else { return } // superseded by a later pick
                if desc == nil, (200..<300).contains(code) {
                    DaemonManager.shared.note("PUT /api/config persona=\(id.rawValue) -> \(code)")
                } else {
                    DaemonManager.shared.note("PUT /api/config persona=\(id.rawValue) FAILED (\(desc ?? "HTTP \(code)")) — reverting")
                    self.personaOverride = previous
                    self.overrideBase = previousBase
                    PersonaIcon.apply(self.personaID)
                }
            }
        }.resume()
    }
}
