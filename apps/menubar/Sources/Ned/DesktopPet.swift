import SwiftUI
import AppKit
import Combine

// MARK: - State → expression (pure; checked by --pet-selftest)

/// What the floating pet shows. Highest priority first — `PetMapping.expression` picks the first that applies.
enum PetMood: String, CaseIterable, Sendable {
    case offline, blocked, needsInput, attention, running, idle
}

/// Only what `StateStore` / `DaemonManager` already have.
struct PetInput: Sendable {
    struct Session: Sendable {
        var worktree: String
        var status: String
        var isWorker: Bool = false
        /// 세션에 답하기 (PetReply): which session, can Ned type into its Orca terminal, what it asked, its last event.
        var id: String = ""
        var canReply: Bool = true
        var summary: String = ""
        var ts: Double = 0
    }
    /// `false` = daemon not answering (same rule as the menu's "데몬이 꺼져 있어요" line).
    var alive: Bool
    var sessions: [Session] = []
    /// Open (not 확인 완료) attention — `StateStore.attentionCount`.
    var openAttention: Int = 0
}

struct PetLine: Equatable, Sendable {
    var mood: PetMood
    var text: String
}

struct PetExpression: Equatable, Sendable {
    var mood: PetMood
    /// Every applicable status line, priority order. The first is the hover bubble's status line.
    var lines: [PetLine]
    /// Open attention count on the character (not while offline).
    var badge: Int?

    var status: PetLine? { lines.first }
    var summary: [PetLine] { Array(lines.prefix(3)) }

    static let idle = PetExpression(mood: .idle, lines: [], badge: nil)
}

enum PetMapping {
    static let doneText = "끝"

    static func expression(_ i: PetInput) -> PetExpression {
        guard i.alive else { return PetExpression(mood: .offline, lines: [PetLine(mood: .offline, text: "연결 끊김")], badge: nil) }
        var lines: [PetLine] = []
        let errors = i.sessions.filter { $0.status == "error" }
        if let first = errors.first {
            lines.append(PetLine(mood: .blocked, text: errors.count == 1 ? "\(first.worktree) 오류" : "오류 \(errors.count)"))
        }
        // Orca workers (the user's own agent workers) never ask for the user's input here — same as attention.
        let waiting = i.sessions.filter { $0.status == "waiting" && !$0.isWorker }
        if let first = waiting.first {
            lines.append(PetLine(mood: .needsInput, text: waiting.count == 1 ? "\(first.worktree) 입력 기다림" : "입력 기다림 \(waiting.count)"))
        }
        if i.openAttention > 0 { lines.append(PetLine(mood: .attention, text: "확인할 것 \(i.openAttention)")) }
        let running = i.sessions.filter { $0.status == "running" }.count
        if running > 0 { lines.append(PetLine(mood: .running, text: "작업 중 \(running)")) }
        return PetExpression(mood: lines.first?.mood ?? .idle, lines: lines, badge: i.openAttention > 0 ? i.openAttention : nil)
    }

    /// A short "끝" bubble when something that needed the user ended and the pet went back to idle.
    static func showsDone(from: PetMood, to: PetMood) -> Bool {
        to == .idle && (from == .needsInput || from == .attention)
    }
}

// MARK: - Messages (pure; checked by --pet-selftest)

/// One chat-style bubble: a feed item (GET /api/feed), the day's greeting, a "새 소식 N" bundle or a status note (끝 / 연결 끊김).
struct PetMessage: Equatable, Sendable {
    var key: String
    /// Feed kind (session/email/slack/thread/jira/github/sentry/calendar/briefing/other) or greeting/summary/done/offline.
    var kind: String
    /// The pet.messages toggle (nil = none).
    var petKind: String?
    var title: String
    var detail: String = ""
    var url: String? = nil
    var deep: String? = nil

    init(key: String, kind: String, petKind: String?, title: String, detail: String = "", url: String? = nil, deep: String? = nil) {
        self.key = key; self.kind = kind; self.petKind = petKind; self.title = title; self.detail = detail; self.url = url; self.deep = deep
    }

    init(_ f: FeedItem) {
        self.init(key: f.key, kind: f.kind, petKind: f.pet_kind, title: f.title, detail: f.detail, url: f.url, deep: f.deep)
    }

    static func greeting(_ p: Persona, at date: Date) -> PetMessage {
        PetMessage(key: PetInbox.greetingKey(date), kind: "greeting", petKind: "greeting", title: p.greeting(at: date))
    }
    static func summary(_ items: [PetMessage]) -> PetMessage {
        PetMessage(key: "summary:\(items.first?.key ?? "")", kind: "summary", petKind: nil, title: "새 소식 \(items.count)",
                   detail: items.prefix(2).map(\.title).joined(separator: " · "))
    }
    static let done = PetMessage(key: "status:done", kind: "done", petKind: "session", title: PetMapping.doneText)
    static let offline = PetMessage(key: "status:offline", kind: "offline", petKind: nil, title: "연결 끊김", detail: "데몬이 응답하지 않아요")
}

/// What pops up: new feed keys only (seen ones never again), first run seeds everything as seen (= 통신기),
/// switched-off kinds and quiet hours pop nothing (their keys still become seen), more than `maxBurst` at once → one
/// "새 소식 N", and the persona greeting once a day (first non-quiet look of the day). The seen keys are all it keeps.
struct PetInbox: Equatable {
    static let maxBurst = 3
    static let keep = 600

    /// Oldest first; `nil` = never seeded (first run).
    private(set) var seen: [String]?

    init(seen: [String]?) { self.seen = seen }

    var seeded: Bool { seen != nil }
    func hasSeen(_ key: String) -> Bool { seen?.contains(key) == true }

    static func greetingKey(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "greet:%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// `feed` newest first (as the daemon sends it). `greeting` = today's greeting, or nil when the pet isn't showing.
    mutating func ingest(_ feed: [FeedItem], prefs: PetSettings, quiet: Bool, greeting: PetMessage?) -> [PetMessage] {
        var s = seen ?? []
        let firstRun = seen == nil
        let known = Set(s)
        let fresh = feed.filter { !known.contains($0.key) }.reversed().map(PetMessage.init)
        s.append(contentsOf: fresh.map(\.key))
        var out: [PetMessage] = []
        if !quiet, let g = greeting, prefs.messageOn("greeting"), !known.contains(g.key) {
            s.append(g.key)
            out.append(g)
        }
        if s.count > Self.keep { s.removeFirst(s.count - Self.keep) }
        seen = s
        guard !firstRun, !quiet else { return out }
        let shown = fresh.filter { prefs.messageOn($0.petKind) }
        out += shown.count > Self.maxBurst ? [PetMessage.summary(Array(shown.reversed()))] : shown
        return out
    }

    /// The hover list: the newest `n` feed items of switched-on kinds.
    static func recent(_ feed: [FeedItem], prefs: PetSettings, n: Int = 3) -> [PetMessage] {
        Array(feed.filter { prefs.messageOn($0.pet_kind) }.prefix(n)).map(PetMessage.init)
    }
}

// MARK: - 세션에 답하기 (pure; checked by --pet-selftest)

/// One session waiting for the user that the bubble can answer.
struct PetReplyTarget: Equatable, Sendable {
    var id: String
    var worktree: String
    var summary: String
    /// false = no Orca terminal on record → only "터미널에서 직접 입력".
    var canReply: Bool
    /// last_event_ts — a send is "answered" until the session moves past it.
    var ts: Double
}

/// The bubble's reply strip: quick buttons (config.dashboard.session_quick_replies) + "…" one-line input, for the most
/// recent waiting session (⇧⇥ / ↑↓ / ‹ › switch when several wait). While it is in use (input / sending / result) the
/// bubble does not auto-collapse (PetModel.timerFired holds). A sent session drops out of the targets until its next
/// event; the result line ("보냄 ✓" / why not) shows `resultSeconds`, then the normal flow resumes.
struct PetReply: Equatable {
    enum Phase: Equatable { case idle, input, sending, result(ok: Bool, text: String) }
    static let defaultQuick = ["ㄱㄱ", "승인", "계속"]
    static let maxText = 2000
    static let resultSeconds: TimeInterval = 2.5

    private(set) var targets: [PetReplyTarget] = []
    private(set) var selectedID: String?
    private(set) var phase: Phase = .idle
    /// Last typed text — kept after a failed send so "…" reopens with it; cleared after a sent one.
    var text = ""
    /// Sent session id → its last_event_ts at send.
    private(set) var sent: [String: Double] = [:]
    /// The target being answered (it may leave `targets` mid-reply).
    private(set) var pinned: PetReplyTarget?

    var active: Bool { phase != .idle }
    var current: PetReplyTarget? {
        if active, let p = pinned { return p }
        return targets.first { $0.id == selectedID } ?? targets.first
    }
    var index: Int? { current.flatMap { c in targets.firstIndex { $0.id == c.id } } }

    /// Waiting, not an Orca worker, newest event first (the default pick is the most recent).
    static func waiting(_ sessions: [PetInput.Session]) -> [PetReplyTarget] {
        sessions.filter { $0.status == "waiting" && !$0.isWorker && !$0.id.isEmpty }
            .sorted { $0.ts > $1.ts }
            .map { PetReplyTarget(id: $0.id, worktree: $0.worktree, summary: $0.summary, canReply: $0.canReply, ts: $0.ts) }
    }

    mutating func setTargets(_ t: [PetReplyTarget]) {
        // A sent mark lasts while the session still shows the event we answered.
        sent = sent.filter { id, ts in t.contains { $0.id == id && $0.ts == ts } }
        targets = t.filter { sent[$0.id] == nil }
        if let s = selectedID, !targets.contains(where: { $0.id == s }) { selectedID = nil }
    }

    /// Pick a session (a session message bubble names its own). No-op while sending / showing a result.
    mutating func select(_ id: String) {
        guard phase == .idle || phase == .input, let t = targets.first(where: { $0.id == id }) else { return }
        selectedID = id
        if active { pinned = t }
    }

    mutating func cycle(_ step: Int) {
        guard targets.count > 1, phase == .idle || phase == .input, let i = index else { return }
        let n = targets.count
        let t = targets[((i + step) % n + n) % n]
        selectedID = t.id
        if active { pinned = t }
    }

    /// "…" → input mode for the current target. false when there is none or it can't be replied to.
    mutating func openInput() -> Bool {
        guard phase == .idle || phase == .input, let c = current, c.canReply else { return false }
        pinned = c
        phase = .input
        return true
    }

    /// Esc / 닫기.
    mutating func cancel() {
        guard phase == .input else { return }
        phase = .idle
        pinned = nil
    }

    /// A quick button or ⏎: (session id, trimmed text) to POST, or nil (empty, too long, nothing to answer, busy).
    mutating func beginSend(_ raw: String) -> (id: String, text: String)? {
        guard phase == .idle || phase == .input, let c = current, c.canReply else { return nil }
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= Self.maxText else { return nil }
        pinned = c
        phase = .sending
        return (c.id, t)
    }

    mutating func finish(_ o: SessionSendOutcome) {
        guard phase == .sending, let c = pinned else { return }
        phase = .result(ok: o.ok, text: Self.resultText(o))
        if o.ok { sent[c.id] = c.ts; text = "" }
    }

    /// After `resultSeconds`: back to the normal flow (a sent session leaves the targets).
    mutating func endResult() {
        guard case .result = phase else { return }
        phase = .idle
        pinned = nil
        targets.removeAll { sent[$0.id] != nil }
        if let s = selectedID, !targets.contains(where: { $0.id == s }) { selectedID = nil }
    }

    /// The result line: "보냄 ✓", or why not (409 = the terminal is gone — same words as the dashboard).
    static func resultText(_ o: SessionSendOutcome) -> String {
        switch o.status {
        case 200: return "보냄 ✓"
        case 409: return "터미널이 닫혀 있어 보낼 수 없음 — 터미널에서 직접 입력"
        case 403: return "세션에 보내기가 꺼져 있어요 (설정 → 쓰기 액션)"
        case 0: return o.error.map { "보내지 못함: \($0)" } ?? "데몬이 응답하지 않아요"
        default: return "보내지 못함: \(String((o.error ?? "HTTP \(o.status)").prefix(80)))"
        }
    }
}

/// What the bubble draws for the reply strip (PetModel.replyStrip).
struct PetReplyStrip: Equatable {
    var target: PetReplyTarget
    /// 1-based position and count when several sessions wait (the header shows ‹ n/m ›).
    var position: Int
    var count: Int
    var quick: [String]
    var phase: PetReply.Phase
}

/// Hit ids of the bubble's controls (PetModel.rowFrames keys; list rows use 0..<100).
enum PetControl {
    static let quickBase = 100
    static let more = 150
    static let prev = 160
    static let next = 161
    static let field = 170
}

/// Where the panel goes: the saved origin if the character is still (mostly) on a screen, else the default
/// (bottom-right of the main screen's visible frame — Dock and menu bar excluded).
enum PetPlacement {
    static let margin: CGFloat = 12

    static func defaultOrigin(size: CGSize, main: CGRect) -> CGPoint {
        CGPoint(x: main.maxX - size.width - margin + PetLayout.inset, y: main.minY + margin - PetLayout.inset)
    }

    static func origin(saved: CGPoint?, size: CGSize, screens: [CGRect], main: CGRect) -> CGPoint {
        if let s = saved {
            let c = PetLayout.characterRect(in: size).offsetBy(dx: s.x, dy: s.y)
            let area = c.width * c.height
            if screens.contains(where: { let r = $0.intersection(c); return !r.isNull && r.width * r.height >= area * 0.5 }) { return s }
        }
        return defaultOrigin(size: size, main: main)
    }

    static func encode(_ p: CGPoint) -> String { "\(Int(p.x.rounded())),\(Int(p.y.rounded()))" }
    static func decode(_ s: String?) -> CGPoint? {
        guard let parts = s?.split(separator: ","), parts.count == 2, let x = Double(parts[0]), let y = Double(parts[1]) else { return nil }
        return CGPoint(x: x, y: y)
    }
}

/// Fixed panel geometry: the character sits at the bottom-right, the bubble grows up/left from it.
enum PetLayout {
    static let panel = CGSize(width: 280, height: 300)
    static let character: CGFloat = 76
    /// Room around the character card for its glow (the back-light reaches radius 6).
    static let inset: CGFloat = 10
    /// Character card (rounded, state-coloured edge) and the persona mark inside it.
    static let card: CGFloat = 64
    static let tile: CGFloat = 54
    /// = 통신기 --cm-radius (16px) for the bubble; the card keeps the same look at its size.
    static let bubbleRadius: CGFloat = 16
    static let cardRadius: CGFloat = 18
    static let bubbleWidth: CGFloat = panel.width - 2 * inset - 6
    /// In AppKit coordinates (origin bottom-left) of a panel of `size`.
    static func characterRect(in size: CGSize) -> CGRect {
        CGRect(x: size.width - inset - character, y: inset, width: character, height: character)
    }
}

// MARK: - Model

/// What the bubble shows right now.
enum PetBubbleContent: Equatable {
    case message(PetMessage)
    /// Hover: the status line (if not idle) + the newest messages, or the persona's "nothing new".
    case list(status: PetLine?, items: [PetMessage], empty: String?)
}

@MainActor
final class PetModel: ObservableObject {
    @Published private(set) var expression = PetExpression.idle
    @Published private(set) var persona: PersonaID = .ned
    /// The message bubble on screen (auto-collapses); queued ones follow in order.
    @Published private(set) var current: PetMessage?
    @Published private(set) var queue: [PetMessage] = []
    @Published private(set) var recent: [PetMessage] = []
    /// Hover list open (mouse over the character, or still over the open list).
    @Published var listOpen = false
    @Published var reduceMotion: Bool
    /// Mouse over the bubble: the current message stays until it leaves.
    var bubbleHovered = false { didSet { if !bubbleHovered, current != nil { schedule(1.5) } } }
    /// Bubble rows in AppKit panel coordinates (row index → rect), reported by `PetView` for `PetBubbleHitView`.
    @Published var bubbleFrame: CGRect = .zero
    var rowFrames: [Int: CGRect] = [:]
    /// The reply input's slot (PetControl.field) in AppKit panel coordinates — the controller lays its NSTextField there.
    @Published var fieldFrame: CGRect = .zero

    /// 세션에 답하기: waiting sessions + the strip's phase; quick buttons and the actions.session_send switch from GET /api/feed.
    @Published var reply = PetReply()
    @Published var quickReplies: [String] = PetReply.defaultQuick
    @Published var replyOn = true

    static let bubbleSeconds: TimeInterval = 5.5
    static let doneSeconds: TimeInterval = 2.5
    private var hideWork: DispatchWorkItem?
    private var resultWork: DispatchWorkItem?

    init(reduceMotion: Bool = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion) {
        self.reduceMotion = reduceMotion
    }

    /// `quiet` = the daemon's quiet hours (`state.json` `quiet`): no automatic bubble, hover still works.
    /// `sessionOn` = pet.messages.session (the 끝 note belongs to it).
    func update(_ e: PetExpression, persona p: PersonaID, quiet: Bool, sessionOn: Bool = true) {
        if p != persona { persona = p }
        guard e != expression else { return }
        let prev = expression
        expression = e
        guard e.mood != prev.mood, !quiet else { return }
        if e.mood == .offline { enqueue([.offline]) }
        else if prev.mood == .offline { drop("status:offline") }
        else if sessionOn, PetMapping.showsDone(from: prev.mood, to: e.mood) { enqueue([.done]) }
    }

    func setRecent(_ r: [PetMessage]) { if r != recent { recent = r } }

    /// Up to `PetInbox.maxBurst` waiting (current excluded); overflow folds the waiting ones into one "새 소식 N".
    func enqueue(_ msgs: [PetMessage]) {
        guard !msgs.isEmpty else { return }
        var q = queue + msgs.filter { m in m.key != current?.key && !queue.contains { $0.key == m.key } }
        if q.count > PetInbox.maxBurst {
            let greet = q.filter { $0.kind == "greeting" }
            let rest = q.filter { $0.kind != "greeting" }
            q = greet + [PetMessage.summary(rest.reversed())]
        }
        queue = q
        if current == nil { next() }
    }

    var content: PetBubbleContent? {
        if listOpen {
            let status = expression.mood == .idle ? nil : expression.status
            // With the reply strip the panel has room for one recent row (none while replying).
            let items = !hasStripInList ? recent : reply.active ? [] : Array(recent.prefix(1))
            return .list(status: status, items: items, empty: status == nil && items.isEmpty && !hasStripInList ? persona.persona.nothingNew : nil)
        }
        return current.map(PetBubbleContent.message)
    }

    private var hasStripInList: Bool { replyOn && reply.current != nil }

    /// The reply strip under the bubble: on the hover list whenever a session waits, on a session message bubble, and
    /// always while replying (input / sending / result).
    var replyStrip: PetReplyStrip? {
        guard replyOn, let t = reply.current else { return nil }
        let show: Bool
        if reply.active || listOpen { show = true }
        else if let m = current, m.kind == "session" { show = true }
        else { show = false }
        guard show else { return nil }
        return PetReplyStrip(target: t, position: (reply.index ?? 0) + 1, count: max(reply.targets.count, 1), quick: quickReplies, phase: reply.phase)
    }

    /// The session a session message bubble is about (`att:session:<id>`).
    static func sessionID(of m: PetMessage) -> String? {
        m.kind == "session" && m.key.hasPrefix("att:session:") ? String(m.key.dropFirst("att:session:".count)) : nil
    }

    func setReplyTargets(_ t: [PetReplyTarget]) {
        var r = reply
        r.setTargets(t)
        if r != reply { reply = r }
    }

    /// Mutate the reply state; leaving a held phase (back to idle) lets the bubble go on with its normal timer.
    func updateReply(_ f: (inout PetReply) -> Void) {
        let was = reply.active
        var r = reply
        f(&r)
        reply = r
        if case .result = r.phase { scheduleResultEnd() }
        if was && !r.active && current != nil { schedule(1.5) }
    }

    private func scheduleResultEnd() {
        resultWork?.cancel()
        let w = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.updateReply { $0.endResult() }; self?.onReplyIdle?() } }
        resultWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + PetReply.resultSeconds, execute: w)
    }

    /// The controller's hook when the strip goes back to idle after a result (closes the hover list if the mouse left).
    var onReplyIdle: (() -> Void)?

    /// For snapshots: a fixed state with its bubble open, no timers.
    func pin(_ e: PetExpression, persona p: PersonaID, message: PetMessage?, recent r: [PetMessage] = [], list: Bool = false, reply rp: PetReply = PetReply()) {
        hideWork?.cancel()
        expression = e; persona = p; current = message; queue = []; recent = r; listOpen = list; reduceMotion = true; reply = rp
    }

    private func next() {
        guard !queue.isEmpty else { current = nil; hideWork?.cancel(); return }
        current = queue.removeFirst()
        // A session message bubble answers its own session.
        if let m = current, let id = Self.sessionID(of: m), !reply.active { updateReply { $0.select(id) } }
        schedule(current?.kind == "done" ? Self.doneSeconds : Self.bubbleSeconds)
    }

    /// The auto-collapse timer fired: hold while the mouse is on the bubble or the reply strip is in use, else the next one.
    func timerFired() {
        if bubbleHovered || reply.active { schedule(1.5) } else { next() }
    }

    private func drop(_ key: String) {
        queue.removeAll { $0.key == key }
        if current?.key == key { next() }
    }

    private func schedule(_ seconds: TimeInterval) {
        hideWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.timerFired() }
        }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
    }

    /// Tests: show the next message now (as if the timer fired).
    func advance() { next() }
}

// MARK: - Views

/// Colours are the dashboard's tokens (packages/daemon/public/css/tokens.css, ned persona): --amber, --red, --bubble,
/// --edge; the edge / glow follow 통신기 comms.css (--cm-edge = accent 70 %, --cm-glow = accent 50 %).
enum PetColors {
    /// Per persona, dark / light — packages/daemon/public/css/tokens.css: --edge, --mint, --amber, --red.
    struct Tokens { let edge: UInt32; let mint: UInt32; let amber: UInt32; let red: UInt32 }
    static func tokens(_ id: PersonaID, dark: Bool) -> Tokens {
        switch (id, dark) {
        case (.ned, true): return Tokens(edge: 0x3B4867, mint: 0x5CC4A3, amber: 0xF0AD3C, red: 0xF08C80)
        case (.ned, false): return Tokens(edge: 0x1C2133, mint: 0x2D8A6D, amber: 0xA96B00, red: 0x8F1D17)
        case (.alfred, true): return Tokens(edge: 0x3B3A35, mint: 0x8FAE99, amber: 0xD9A441, red: 0xF0907F)
        case (.alfred, false): return Tokens(edge: 0x1B1A17, mint: 0x3F7A55, amber: 0x9A6700, red: 0x8F1D17)
        case (.oracle, true): return Tokens(edge: 0x2B5B40, mint: 0x3DDC84, amber: 0xF2B33D, red: 0xFF8A7A)
        case (.oracle, false): return Tokens(edge: 0x0C2016, mint: 0x0D8A4A, amber: 0x946300, red: 0x8F1D17)
        case (.jarvis, true): return Tokens(edge: 0x2E4C71, mint: 0x5FD4C0, amber: 0xF0B429, red: 0xFF8F86)
        case (.jarvis, false): return Tokens(edge: 0x0D2236, mint: 0x0F8F7C, amber: 0xF0B429, red: 0x8F1D17)
        }
    }
    static func waiting(_ p: Persona, _ dark: Bool) -> Color { Color(hex: tokens(p.id, dark: dark).amber) }
    static func error(_ p: Persona, _ dark: Bool) -> Color { Color(hex: tokens(p.id, dark: dark).red) }
    /// 작업 중 = the persona's secondary colour. 통신기 uses --cm-rx (= --mint for ned, = --hero for the others); the pet
    /// takes --mint for every persona so 작업 중 never looks like 확인할 것 (accent).
    static func running(_ p: Persona, _ dark: Bool) -> Color { Color(hex: tokens(p.id, dark: dark).mint) }
    /// 쉼 = neutral --edge (light themes' --edge is the ink colour → softened).
    static func neutral(_ p: Persona, _ dark: Bool) -> Color { Color(hex: tokens(p.id, dark: dark).edge).opacity(dark ? 1 : 0.35) }
    static func card(_ dark: Bool) -> Color { dark ? Color(hex: 0x1B2337) : Color(hex: 0xF8F3EA) }    // ned --bubble
    static func text(_ dark: Bool) -> Color { dark ? Color(hex: 0xE8EBF3) : Color(hex: 0x1C2133) }    // ned --fg
    static func dim(_ dark: Bool) -> Color { dark ? Color(hex: 0x9CA6BD) : Color(hex: 0x5D6376) }     // ned --dim
    static let offline = Color(hex: 0x626D88)                                                         // ned --faint

    /// Edge colour of the card / hover list for a mood: 쉼 neutral, 작업 중 mint, 확인할 것 accent, 입력 기다림 amber,
    /// 오류 red (dashed), 연결 끊김 grey.
    static func edge(_ m: PetMood, _ p: Persona, dark: Bool) -> Color {
        switch m {
        case .offline: return offline
        case .blocked: return error(p, dark)
        case .needsInput: return waiting(p, dark)
        case .attention: return p.accent
        case .running: return running(p, dark)
        case .idle: return neutral(p, dark)
        }
    }
    /// Outer glow strength (0 = none): 오류 strongest, 확인할 것 next, 작업 중·쉼 softer, 연결 끊김 none.
    /// Every state but 연결 끊김 breathes (PetGlow), so the pet always reads as alive.
    static func glow(_ m: PetMood) -> Double {
        switch m {
        case .offline: return 0
        case .idle: return 0.3
        case .running: return 0.55
        case .needsInput: return 0.75
        case .attention: return 0.85
        case .blocked: return 1
        }
    }
    /// The glow's colour: the edge colour, except 쉼 — its neutral edge is too faint to glow, so a soft --dim light.
    static func glowColor(_ m: PetMood, _ p: Persona, dark: Bool) -> Color {
        m == .idle ? dim(dark) : edge(m, p, dark: dark)
    }
    /// Message bubbles (new items) wear the accent like 확인할 것; status notes keep their own colour.
    static func messageEdge(_ m: PetMessage, _ p: Persona, dark: Bool) -> (Color, Double) {
        switch m.kind {
        case "offline": return (offline, 0)
        case "done": return (running(p, dark), 0.35)
        default: return (p.accent, 0.6)
        }
    }

    static func moodSymbol(_ m: PetMood) -> String {
        switch m {
        case .offline: return "bolt.horizontal.circle"
        case .blocked: return "exclamationmark.triangle.fill"
        case .needsInput: return "keyboard"
        case .attention: return "bell.fill"
        case .running: return "gearshape.2.fill"
        case .idle: return "checkmark.circle.fill"
        }
    }

    /// Source icon per message kind (SF Symbols — no emoji).
    static func kindSymbol(_ kind: String) -> String {
        switch kind {
        case "slack", "thread": return "number"
        case "email": return "envelope.fill"
        case "jira": return "checklist"
        case "github": return "arrow.triangle.pull"
        case "sentry": return "ant.fill"
        case "calendar": return "calendar"
        case "session": return "terminal.fill"
        case "briefing": return "antenna.radiowaves.left.and.right"
        case "greeting": return "sun.max.fill"
        case "summary": return "tray.full.fill"
        case "done": return "checkmark.circle.fill"
        case "offline": return "bolt.horizontal.circle"
        default: return "bell.fill"
        }
    }
    static func kindTint(_ kind: String, _ p: Persona, dark: Bool) -> Color {
        switch kind {
        case "offline": return offline
        case "session": return waiting(p, dark)
        case "done": return running(p, dark)
        default: return p.accent
        }
    }
}

/// Persona marks (the same SVGs as the boot screen / `Resources/marks`), rasterized once by NSImage.
@MainActor
enum PetArt {
    private static var cache: [PersonaID: NSImage] = [:]
    static func mark(_ id: PersonaID) -> NSImage {
        if let i = cache[id] { return i }
        let img = NSImage(data: Data(BootScreen.markSVG(id).utf8)) ?? NSImage(size: NSSize(width: 64, height: 64))
        cache[id] = img
        return img
    }
}

private struct BubbleFrameKey: PreferenceKey {
    static let defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) { value.merge(nextValue()) { $1 } }
}
private extension View {
    /// Report this view's frame in the panel's coordinate space under `id` (-1 = whole bubble, ≥0 = a list row).
    func petFrame(_ id: Int) -> some View {
        background(GeometryReader { g in Color.clear.preference(key: BubbleFrameKey.self, value: [id: g.frame(in: .named("pet"))]) })
    }
}

struct PetView: View {
    @ObservedObject var model: PetModel
    private static let fade: Animation = .easeInOut(duration: 0.5)

    var body: some View {
        let p = model.persona.persona
        VStack(alignment: .trailing, spacing: 8) {
            Spacer(minLength: 0)
            if let c = model.content {
                PetBubble(content: c, mood: model.expression.mood, persona: p, reduceMotion: model.reduceMotion, strip: model.replyStrip)
                    .transition(.opacity)
                    .id(bubbleID(c))
            }
            PetCharacter(mood: model.expression.mood, persona: p, badge: model.expression.badge, reduceMotion: model.reduceMotion)
                .frame(width: PetLayout.character, height: PetLayout.character)
        }
        .padding(PetLayout.inset)
        .frame(width: PetLayout.panel.width, height: PetLayout.panel.height, alignment: .bottomTrailing)
        .coordinateSpace(name: "pet")
        .animation(Self.fade, value: model.content)
        .animation(Self.fade, value: model.expression.mood)
        .onPreferenceChange(BubbleFrameKey.self) { frames in
            // SwiftUI (top-left origin) → AppKit panel coordinates (bottom-left).
            let h = PetLayout.panel.height
            let flip = { (r: CGRect) in CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height) }
            MainActor.assumeIsolated {
                model.rowFrames = frames.filter { $0.key >= 0 }.mapValues(flip)
                let b = frames[-1].map(flip) ?? .zero
                if model.bubbleFrame != b { model.bubbleFrame = b }
                let f = frames[PetControl.field].map(flip) ?? .zero
                if model.fieldFrame != f { model.fieldFrame = f }
            }
        }
    }

    private func bubbleID(_ c: PetBubbleContent) -> String {
        switch c {
        case .message(let m): return "m:" + m.key
        case .list: return "list"
        }
    }
}

/// Chat-style bubble (통신기 메시지 탭): source icon + one-line title (+ short detail); the hover list stacks rows.
/// Rounded like the card, edge + glow in the pet's state colour.
struct PetBubble: View {
    let content: PetBubbleContent
    let mood: PetMood
    let persona: Persona
    var reduceMotion: Bool = false
    /// 세션에 답하기 strip under the content (nil = none).
    var strip: PetReplyStrip? = nil
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        let (edge, glow): (Color, Double) = {
            if case .message(let m) = content { return PetColors.messageEdge(m, persona, dark: dark) }
            return (PetColors.edge(mood, persona, dark: dark), PetColors.glow(mood))
        }()
        let glowColor: Color = { if case .message = content { return edge }; return PetColors.glowColor(mood, persona, dark: dark) }()
        VStack(alignment: .leading, spacing: 6) {
            switch content {
            case .message(let m):
                row(icon: PetColors.kindSymbol(m.kind), tint: PetColors.kindTint(m.kind, persona, dark: dark), title: m.title, detail: m.detail, lines: 2, dark: dark)
            case .list(let status, let items, let empty):
                if let s = status {
                    row(icon: PetColors.moodSymbol(s.mood), tint: PetColors.edge(s.mood, persona, dark: dark), title: s.text, detail: "", lines: 1, dark: dark, bold: true)
                    if !items.isEmpty { Divider().opacity(0.5) }
                }
                ForEach(Array(items.enumerated()), id: \.offset) { i, m in
                    row(icon: PetColors.kindSymbol(m.kind), tint: PetColors.kindTint(m.kind, persona, dark: dark), title: m.title, detail: m.detail, lines: 1, dark: dark)
                        .petFrame(i)
                }
                if let e = empty {
                    row(icon: PetColors.moodSymbol(.idle), tint: PetColors.dim(dark), title: e, detail: "", lines: 1, dark: dark)
                }
            }
            if let s = strip {
                Divider().opacity(0.5)
                replyStrip(s, dark: dark)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .fixedSize(horizontal: false, vertical: true)
        .background(
            RoundedRectangle(cornerRadius: PetLayout.bubbleRadius, style: .continuous)
                .fill(PetColors.card(dark))
                .overlay(RoundedRectangle(cornerRadius: PetLayout.bubbleRadius, style: .continuous)
                    .strokeBorder(edge.opacity(0.8), lineWidth: 1))
                .shadow(color: .black.opacity(dark ? 0.45 : 0.18), radius: 6, y: 2)
                .modifier(PetGlow(color: glowColor, strength: glow * 0.7, reduceMotion: reduceMotion))
        )
        .petFrame(-1) // the drawn bubble only — the click / hover area (PetBubbleHitView)
        // Hug the text like a chat bubble, at most the panel's width, right-aligned over the character.
        .frame(maxWidth: PetLayout.bubbleWidth, alignment: .trailing)
        .padding(.trailing, 4)
    }

    /// Header (which session, ‹ n/m › when several wait) + what it asked, then quick buttons and "…" / the input slot /
    /// 보내는 중… / the result line. Clicks land on PetBubbleHitView, which hit-tests these frames (PetControl ids).
    @ViewBuilder
    private func replyStrip(_ s: PetReplyStrip, dark: Bool) -> some View {
        let amber = PetColors.waiting(persona, dark)
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "keyboard").font(.system(size: 10, weight: .semibold)).foregroundStyle(amber).frame(width: 14)
                Text("\(s.target.worktree) 에 답하기").font(.system(size: 11, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(PetColors.text(dark))
                Spacer(minLength: 4)
                if s.count > 1 && (s.phase == .idle || s.phase == .input) {
                    chip("‹", dark: dark).petFrame(PetControl.prev)
                    Text("\(s.position)/\(s.count)").font(.system(size: 10)).monospacedDigit().foregroundStyle(PetColors.dim(dark))
                    chip("›", dark: dark).petFrame(PetControl.next)
                }
            }
            if !s.target.canReply {
                Text("터미널에서 직접 입력 — Orca 터미널 기록이 없어요").font(.system(size: 10.5)).foregroundStyle(PetColors.dim(dark)).lineLimit(2)
            } else {
                switch s.phase {
                case .sending:
                    Text("보내는 중…").font(.system(size: 11)).foregroundStyle(PetColors.dim(dark))
                case .result(let ok, let text):
                    Text(text).font(.system(size: 11, weight: ok ? .semibold : .regular)).lineLimit(2)
                        .foregroundStyle(ok ? PetColors.running(persona, dark) : PetColors.error(persona, dark))
                case .idle, .input:
                    HStack(spacing: 4) {
                        ForEach(Array(s.quick.prefix(5).enumerated()), id: \.offset) { i, q in
                            chip(q, dark: dark).petFrame(PetControl.quickBase + i)
                        }
                        if s.phase == .idle { chip("…", dark: dark).petFrame(PetControl.more) }
                    }
                    if s.phase == .input {
                        // The NSTextField sits on top of this slot (DesktopPetController.layoutField).
                        RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(amber.opacity(0.8), lineWidth: 1)
                            .frame(height: 22).frame(maxWidth: .infinity).petFrame(PetControl.field)
                        Text("⏎ 보내기 · esc 닫기\(s.count > 1 ? " · ⇧⇥ 다른 세션" : "")").font(.system(size: 9.5)).foregroundStyle(PetColors.dim(dark))
                    }
                }
            }
        }
    }

    private func chip(_ label: String, dark: Bool) -> some View {
        Text(label).font(.system(size: 11, weight: .medium)).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .foregroundStyle(PetColors.text(dark))
            .background(Capsule().fill(PetColors.dim(dark).opacity(0.18)))
            .overlay(Capsule().strokeBorder(PetColors.dim(dark).opacity(0.35), lineWidth: 0.5))
            .contentShape(Capsule())
    }

    @ViewBuilder
    private func row(icon: String, tint: Color, title: String, detail: String, lines: Int, dark: Bool, bold: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: icon).font(.system(size: 11, weight: .semibold)).foregroundStyle(tint).frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12, weight: bold ? .semibold : .medium)).lineLimit(lines).truncationMode(.tail)
                    .foregroundStyle(PetColors.text(dark))
                if !detail.isEmpty {
                    Text(detail).font(.system(size: 11)).lineLimit(1).truncationMode(.tail).foregroundStyle(PetColors.dim(dark))
                }
            }
        }
        .contentShape(Rectangle())
    }
}

/// The persona mark on a rounded card whose edge + outer glow carry the state colour. Motion: only a slow glow
/// breath (PetGlow, 1.6 s ease-in-out — every state but 연결 끊김) and, at rest, a ≤1.5 % scale breath — no bounce, no shake, no emoji. 동작 줄이기 = still.
struct PetCharacter: View {
    let mood: PetMood
    let persona: Persona
    let badge: Int?
    let reduceMotion: Bool
    @Environment(\.colorScheme) private var scheme

    static let breath: Double = PetGlow.breath
    static let idleScale: CGFloat = 1.015

    var body: some View {
        let dark = scheme == .dark
        let edge = PetColors.edge(mood, persona, dark: dark)
        let glow = PetColors.glow(mood)
        let shape = RoundedRectangle(cornerRadius: PetLayout.cardRadius, style: .continuous)
        let card = ZStack {
            shape.fill(PetColors.card(dark))
            Image(nsImage: PetArt.mark(persona.id)).resizable().interpolation(.high)
                .frame(width: PetLayout.tile, height: PetLayout.tile)
                .clipShape(RoundedRectangle(cornerRadius: PetLayout.tile * 14 / 64, style: .continuous))
                .saturation(mood == .offline ? 0 : 1)
                .opacity(mood == .offline ? 0.5 : 1)
        }
        .frame(width: PetLayout.card, height: PetLayout.card)
        // Error is drawn dashed (tokens.css: --red is outlined/dashed so it never reads as the accent — Ned's accent is red too).
        .overlay(shape.strokeBorder(edge.opacity(mood == .offline ? 0.7 : 0.9),
                                    style: StrokeStyle(lineWidth: mood == .attention || mood == .blocked ? 2.5 : 1.5, dash: mood == .blocked ? [5, 3] : [])))
        .shadow(color: .black.opacity(dark ? 0.45 : 0.2), radius: 4, y: 1.5)

        Group {
            if reduceMotion || mood == .offline {
                card.modifier(PetGlow(color: PetColors.glowColor(mood, persona, dark: dark), strength: glow, reduceMotion: true))
            } else {
                card.modifier(PetGlow(color: PetColors.glowColor(mood, persona, dark: dark), strength: glow, reduceMotion: false))
                    .phaseAnimator([false, true]) { c, up in
                        c.scaleEffect(mood == .idle && up ? Self.idleScale : 1)
                    } animation: { _ in .easeInOut(duration: Self.breath) }
            }
        }
        .overlay(alignment: .topTrailing) {
            if let n = badge {
                Text(n > 99 ? "99+" : "\(n)").font(.system(size: 11, weight: .bold)).monospacedDigit()
                    .foregroundStyle(.white).padding(.horizontal, 5).frame(minWidth: 19, minHeight: 19)
                    .background(Capsule().fill(persona.accent))
                    .overlay(Capsule().stroke(Color.white.opacity(0.85), lineWidth: 1.2))
                    .shadow(color: .black.opacity(0.3), radius: 1.5)
                    .offset(x: 2, y: -2)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(Text(persona.displayName))
    }
}

// MARK: - Panel

/// Never main, and key only while the bubble's reply input is open (`allowKey`): clicking the pet does not take focus
/// from the app in front; typing a reply needs the (non-activating) panel to be key for that moment only.
final class PetPanel: NSPanel {
    var allowKey = false
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }
}

/// The bubble's one-line reply input: ⏎ send, esc close, ⇧⇥ / ⇥ / ↑ ↓ other waiting session. An Enter that commits a
/// Hangul composition is left to the input method.
final class PetReplyField: NSTextField, NSTextFieldDelegate {
    var onSend: (String) -> Void = { _ in }
    var onCancel: () -> Void = {}
    var onCycle: (Int) -> Void = { _ in }

    convenience init() {
        self.init(frame: .zero)
        isBordered = false
        drawsBackground = false
        focusRingType = .none
        font = .systemFont(ofSize: 12)
        placeholderString = "답 입력"
        usesSingleLineMode = true
        cell?.wraps = false
        cell?.isScrollable = true
        maximumNumberOfLines = 1
        delegate = self
        setAccessibilityLabel("세션에 답하기 입력")
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if textView.hasMarkedText() { return false }
        switch sel {
        case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
            onSend(stringValue); return true
        case #selector(NSResponder.cancelOperation(_:)):
            onCancel(); return true
        case #selector(NSResponder.insertBacktab(_:)), #selector(NSResponder.moveUp(_:)):
            onCycle(-1); return true
        case #selector(NSResponder.insertTab(_:)), #selector(NSResponder.moveDown(_:)):
            onCycle(1); return true
        default:
            return false
        }
    }
}

/// Pointer over the pet: a pointing hand (clickable), a closed hand while dragging. The panel is never key, so cursor
/// rects don't apply — the cursor is set on enter / move and put back to the arrow on exit.
enum PetCursor {
    static let options: NSTrackingArea.Options = [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect]
    @MainActor static func over() { NSCursor.pointingHand.set() }
    @MainActor static func dragging() { NSCursor.closedHand.set() }
    @MainActor static func out() { NSCursor.arrow.set() }
}

/// Mouse over the character only: click → dashboard, drag → move (origin saved), right-click → menu, hover → list.
final class PetHitView: NSView {
    weak var controller: DesktopPetController?
    private var startMouse: NSPoint = .zero
    private var startOrigin: NSPoint = .zero
    private var dragged = false

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: PetCursor.options, owner: self))
    }
    override func mouseEntered(with event: NSEvent) { PetCursor.over(); controller?.hover(character: true) }
    override func mouseMoved(with event: NSEvent) { if !dragged { PetCursor.over() } }
    override func mouseExited(with event: NSEvent) { if !dragged { PetCursor.out() }; controller?.hover(character: false) }

    override func mouseDown(with event: NSEvent) {
        startMouse = NSEvent.mouseLocation
        startOrigin = window?.frame.origin ?? .zero
        dragged = false
    }
    override func mouseDragged(with event: NSEvent) {
        let p = NSEvent.mouseLocation
        let dx = p.x - startMouse.x, dy = p.y - startMouse.y
        if !dragged, hypot(dx, dy) < 3 { return }
        if !dragged { PetCursor.dragging() }
        dragged = true
        window?.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy))
    }
    override func mouseUp(with event: NSEvent) {
        if dragged {
            dragged = false
            controller?.saveOrigin()
            // saveOrigin may snap the panel back: point or arrow depending on where the pointer ended up.
            if bounds.contains(convert(event.locationInWindow, from: nil)) { PetCursor.over() } else { PetCursor.out() }
        } else { controller?.openDashboard() }
    }
    override func rightMouseDown(with event: NSEvent) {
        guard let menu = controller?.contextMenu() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}

/// Over the bubble (frame follows `PetModel.bubbleFrame`): click a message / list row → open it; hover keeps it open.
final class PetBubbleHitView: NSView {
    weak var controller: DesktopPetController?

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: PetCursor.options, owner: self))
    }
    override func mouseEntered(with event: NSEvent) { PetCursor.over(); controller?.hover(bubble: true) }
    override func mouseMoved(with event: NSEvent) { PetCursor.over() }
    override func mouseExited(with event: NSEvent) { PetCursor.out(); controller?.hover(bubble: false) }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) {
        guard let c = controller, let superview else { return }
        c.clickBubble(at: superview.convert(event.locationInWindow, from: nil))
    }
}

/// The floating Ned: one non-activating panel on every Space (and over full-screen apps), off by default.
/// Shown while `config.pet.enabled` (설정 → 외형 → 데스크톱 펫) is on; 우클릭 → 숨기기 saves it off through the daemon.
/// UserDefaults keeps only the position and the seen message keys.
@MainActor
final class DesktopPetController: NSObject {
    nonisolated static let originKey = "desktopPetOrigin"
    nonisolated static let seenKey = "desktopPetSeen"

    /// The app's pet (for the dashboard's 위치 초기화 bridge).
    static weak var current: DesktopPetController?

    let defaults: UserDefaults
    let model: PetModel
    private(set) var panel: PetPanel?
    private var bubbleHit: PetBubbleHitView?
    private(set) var settings = PetSettings()
    private(set) var inbox: PetInbox
    private var subs: Set<AnyCancellable> = []
    private var observers: [NSObjectProtocol] = []
    private var overCharacter = false
    private var overBubble = false
    private var closeWork: DispatchWorkItem?

    /// Click / 대시보드 열기 — the menu's existing path.
    var openDashboardAction: () -> Void = { DashboardWindowController.shared.show() }
    /// 펫 설정… — the dashboard on 설정 → 외형 → 데스크톱 펫.
    var openSettingsAction: () -> Void = { DashboardWindowController.shared.showPetSettings() }
    /// 숨기기 — saves pet.enabled = false (StateStore.setPetEnabled → PUT /api/config).
    var hideAction: () -> Void = { StateStore.current?.setPetEnabled(false) }
    /// A message's link: app deep link (DeepLink.open, web fallback) or the web URL.
    var openURLAction: (_ deep: URL?, _ web: URL?) -> Void = { deep, web in
        if let deep, DeepLink.isDeep(deep) { DeepLink.open(deep, web: web) } else if let web { NSWorkspace.shared.open(web) }
    }
    var now: () -> Date = Date.init
    /// 세션에 답하기 — POST /api/send through the daemon (StateStore.sendToSession). Swapped in tests.
    var sendAction: (_ sessionID: String, _ text: String, _ done: @escaping @MainActor (SessionSendOutcome) -> Void) -> Void = { id, text, done in
        StateStore.sendToSession(id, text: text, port: AppConfig.port, done: done)
    }
    private var field: PetReplyField?
    /// The app that was in front when the input opened, if Ned had to activate itself to get the keyboard (restored on close).
    private var activatedFrom: NSRunningApplication?

    var isEnabled: Bool { settings.enabled }
    var isShowing: Bool { panel?.isVisible == true }

    init(defaults: UserDefaults = .standard, model: PetModel? = nil) {
        self.defaults = defaults
        self.model = model ?? PetModel()
        self.inbox = PetInbox(seen: defaults.stringArray(forKey: Self.seenKey))
        super.init()
        Self.current = self
        let ws = NSWorkspace.shared.notificationCenter
        observers.append(ws.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.model.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.place() }
        })
        self.model.$bubbleFrame.sink { [weak self] f in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.bubbleHit?.frame = f } }
        }.store(in: &subs)
        self.model.$fieldFrame.sink { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.layoutField() } }
        }.store(in: &subs)
        // Leaving input mode any way (sent, cancelled, the session vanished) takes the field and the key status away.
        self.model.$reply.sink { [weak self] r in
            DispatchQueue.main.async { MainActor.assumeIsolated { if r.phase != .input { self?.endInput() } } }
        }.store(in: &subs)
        self.model.onReplyIdle = { [weak self] in self?.syncList() }
    }

    /// Follow the store (state.json + GET /api/feed) and the daemon supervisor (health) — both already published.
    func attach(store: StateStore, daemon: DaemonManager? = nil) {
        let daemon = daemon ?? .shared
        // objectWillChange fires before the new value lands: read on the next main-queue turn.
        let later = { [weak self, weak store] in
            DispatchQueue.main.async { MainActor.assumeIsolated { if let store { self?.refresh(store: store, daemon: daemon) } } }
        }
        store.objectWillChange.sink { _ in later() }.store(in: &subs)
        daemon.objectWillChange.sink { _ in later() }.store(in: &subs)
        refresh(store: store, daemon: daemon)
    }

    func refresh(store: StateStore, daemon: DaemonManager) {
        let s = store.state
        apply(settings: store.pet)
        let input = PetInput(
            alive: s.daemonAlive || daemon.isHealthy || daemon.isBooting,
            sessions: s.sessions.map { .init(worktree: $0.worktree, status: $0.status, isWorker: $0.is_worker, id: $0.id, canReply: $0.can_reply,
                                             summary: $0.last_summary ?? $0.last_prompt ?? "", ts: $0.last_event_ts) },
            openAttention: store.attentionCount)
        model.update(PetMapping.expression(input), persona: store.personaID, quiet: s.quiet, sessionOn: settings.messageOn("session"))
        model.setReplyTargets(PetReply.waiting(input.sessions))
        if model.quickReplies != store.quickReplies { model.quickReplies = store.quickReplies }
        if model.replyOn != store.sessionSendOn { model.replyOn = store.sessionSendOn }
        if store.feedLoaded { ingest(store.feed, quiet: s.quiet, persona: store.persona) }
    }

    /// New feed items → bubbles (only while showing; hidden, they just become seen). Seen keys saved when they change.
    func ingest(_ feed: [FeedItem], quiet: Bool, persona: Persona) {
        let before = inbox
        let msgs = inbox.ingest(feed, prefs: settings, quiet: quiet, greeting: isEnabled ? .greeting(persona, at: now()) : nil)
        if inbox != before { defaults.set(inbox.seen, forKey: Self.seenKey) }
        model.setRecent(PetInbox.recent(feed, prefs: settings))
        if isEnabled { model.enqueue(msgs) }
    }

    /// config.pet → show / hide.
    func apply(settings s: PetSettings) {
        guard s != settings || (s.enabled != isShowing) else { return }
        settings = s
        sync()
    }

    /// Show / hide to match `settings.enabled`.
    func sync() {
        if settings.enabled {
            if panel == nil { panel = makePanel() }
            place()
            panel?.orderFrontRegardless()
        } else {
            panel?.orderOut(nil)
        }
    }

    func hide() {
        settings.enabled = false
        sync()
        hideAction()
    }

    func openDashboard() { openDashboardAction() }

    func hover(character on: Bool) { overCharacter = on; syncList() }
    func hover(bubble on: Bool) { overBubble = on; model.bubbleHovered = on; syncList() }
    /// The list opens over the character and stays while the mouse moves onto it; closes 0.3 s after leaving both.
    /// Never while the reply strip is in use (typing / sending / showing the result).
    func syncList() {
        closeWork?.cancel()
        if overCharacter { model.listOpen = true; return }
        guard model.listOpen, !overBubble, !model.reply.active else { return }
        let w = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { guard let self, !self.overCharacter, !self.overBubble, !self.model.reply.active else { return }; self.model.listOpen = false } }
        closeWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: w)
    }

    /// A click on the bubble (panel coordinates): a reply control, else the list row under it, else the current message.
    func clickBubble(at p: CGPoint) {
        if let strip = model.replyStrip, let (id, _) = model.rowFrames.first(where: { $0.key >= PetControl.quickBase && $0.key != PetControl.field && $0.value.contains(p) }) {
            switch id {
            case PetControl.prev: model.updateReply { $0.cycle(-1) }
            case PetControl.next: model.updateReply { $0.cycle(1) }
            case PetControl.more: beginInput()
            case let i where i >= PetControl.quickBase && i < PetControl.quickBase + strip.quick.count: send(strip.quick[i - PetControl.quickBase])
            default: break
            }
            return
        }
        if model.reply.active { return } // a stray click while replying never opens / advances the message under it
        switch model.content {
        case .list(_, let items, _):
            if let (i, _) = model.rowFrames.first(where: { $0.value.contains(p) }), i < items.count { open(items[i]) }
        case .message(let m):
            open(m)
            model.advance()
        case nil: break
        }
    }

    /// Item url → its app deep link (설정 → 링크 열기, from the daemon) or the web; no url → the dashboard.
    func open(_ m: PetMessage) {
        let web = m.url.flatMap(URL.init(string:)).flatMap { ["http", "https"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
        let deep = m.deep.flatMap(URL.init(string:)).flatMap { DeepLink.isDeep($0) ? $0 : nil }
        if deep == nil && web == nil { openDashboard() } else { openURLAction(deep, web) }
    }

    // MARK: 세션에 답하기

    /// Quick button or ⏎: POST through the daemon; the strip shows 보내는 중… then the result for PetReply.resultSeconds.
    func send(_ text: String) {
        if let f = field { model.reply.text = f.stringValue }
        var started: (id: String, text: String)?
        model.updateReply { started = $0.beginSend(text) }
        guard let s = started else { NSSound.beep(); return }
        sendAction(s.id, s.text) { [weak self] outcome in
            guard let self else { return }
            DaemonManager.shared.note("pet reply → session \(s.id.prefix(8)): HTTP \(outcome.status)\(outcome.error.map { " \($0.prefix(120))" } ?? "")")
            self.model.updateReply { $0.finish(outcome) }
        }
    }

    /// "…": open the one-line input. The panel turns key for it — a non-activating panel takes the keyboard without
    /// activating Ned; only if it still isn't key a moment later is Ned activated (and the previous app restored on close).
    func beginInput() {
        var opened = false
        model.updateReply { opened = $0.openInput() }
        guard opened, let panel else { return }
        let f = field ?? makeField()
        f.stringValue = model.reply.text
        if f.superview == nil { panel.contentView?.addSubview(f) }
        layoutField()
        panel.allowKey = true
        panel.makeKey()
        panel.makeFirstResponder(f)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let panel = self.panel, self.model.reply.phase == .input, !panel.isKeyWindow else { return }
                self.activatedFrom = NSWorkspace.shared.frontmostApplication
                NSApp.activate()
                panel.makeKey()
                if let f = self.field { panel.makeFirstResponder(f) }
            }
        }
    }

    /// Input closed (sent, esc, session gone): drop the field, give the key status back, restore the app in front.
    func endInput() {
        guard let f = field, f.superview != nil else { return }
        if model.reply.phase == .input { model.updateReply { $0.cancel() } }
        f.removeFromSuperview()
        panel?.makeFirstResponder(nil)
        panel?.allowKey = false
        if panel?.isKeyWindow == true { panel?.resignKey() }
        if let prev = activatedFrom {
            activatedFrom = nil
            if prev.bundleIdentifier != Bundle.main.bundleIdentifier { prev.activate(options: []) }
        }
    }

    private func makeField() -> PetReplyField {
        let f = PetReplyField()
        f.onSend = { [weak self] t in self?.send(t) }
        f.onCancel = { [weak self] in self?.model.updateReply { $0.cancel() } }
        f.onCycle = { [weak self] step in self?.model.updateReply { $0.cycle(step) } }
        field = f
        return f
    }

    /// The field over its slot in the bubble (PetControl.field), inset inside the drawn border.
    func layoutField() {
        guard let f = field, f.superview != nil else { return }
        let r = model.fieldFrame
        f.isHidden = r.isEmpty
        if !r.isEmpty { f.frame = r.insetBy(dx: 6, dy: 3) }
    }

    func saveOrigin() {
        guard let o = panel?.frame.origin else { return }
        defaults.set(PetPlacement.encode(o), forKey: Self.originKey)
        place() // snaps back to the default if it was dropped off-screen
    }

    /// 설정 → 데스크톱 펫 → 위치 초기화.
    func resetPosition() {
        defaults.removeObject(forKey: Self.originKey)
        place()
    }

    func place() {
        guard let panel else { return }
        let main = (NSScreen.screens.first ?? NSScreen.main)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let o = PetPlacement.origin(saved: PetPlacement.decode(defaults.string(forKey: Self.originKey)),
                                    size: PetLayout.panel, screens: NSScreen.screens.map(\.visibleFrame), main: main)
        if panel.frame.origin != o { panel.setFrameOrigin(o) }
    }

    func contextMenu() -> NSMenu {
        let m = NSMenu()
        let open = NSMenuItem(title: "대시보드 열기", action: #selector(menuOpen), keyEquivalent: "")
        let settings = NSMenuItem(title: "펫 설정…", action: #selector(menuSettings), keyEquivalent: "")
        let hide = NSMenuItem(title: "숨기기", action: #selector(menuHide), keyEquivalent: "")
        for i in [open, settings, hide] { i.target = self }
        m.addItem(open)
        m.addItem(settings)
        m.addItem(.separator())
        m.addItem(hide)
        return m
    }
    @objc private func menuOpen() { openDashboard() }
    @objc private func menuSettings() { openSettingsAction() }
    @objc private func menuHide() { hide() }

    private func makePanel() -> PetPanel {
        let size = PetLayout.panel
        let p = PetPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false // SwiftUI draws the shadows: the panel's own would outline the empty transparent area
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.becomesKeyOnlyIfNeeded = true
        p.isMovable = false

        let container = NSView(frame: NSRect(origin: .zero, size: size))
        let host = NSHostingView(rootView: PetView(model: model))
        host.sizingOptions = []
        host.frame = container.bounds
        host.autoresizingMask = [.width, .height]
        container.addSubview(host)
        let bubble = PetBubbleHitView(frame: model.bubbleFrame)
        bubble.controller = self
        bubble.setAccessibilityRole(.button)
        bubble.setAccessibilityLabel("펫 말풍선 — 클릭하면 열기")
        container.addSubview(bubble)
        bubbleHit = bubble
        let hit = PetHitView(frame: PetLayout.characterRect(in: size))
        hit.controller = self
        hit.setAccessibilityRole(.button)
        hit.setAccessibilityLabel("데스크톱 펫 — 클릭하면 대시보드")
        container.addSubview(hit)
        p.contentView = container
        return p
    }
}

/// The breathing outer glow of the card and the bubbles: a tight back-light just behind the edge (radius 2 ↔ 6,
/// 35 % ↔ 100 % of `strength`) pulsing on a quicker ease-in-out cycle, plus a hairline inner ring so the edge itself
/// brightens with it — kept small on purpose (a wide halo read as too much). 동작 줄이기 (or a snapshot) = held, no motion.
struct PetGlow: ViewModifier {
    static let breath: Double = 1.6
    let color: Color
    let strength: Double
    let reduceMotion: Bool

    func body(content: Content) -> some View {
        if strength <= 0 {
            content
        } else if reduceMotion {
            content.shadow(color: color.opacity(strength * 0.5), radius: 1.5).shadow(color: color.opacity(strength * 0.75), radius: 4)
        } else {
            content.phaseAnimator([false, true]) { c, up in
                c.shadow(color: color.opacity(strength * (up ? 0.7 : 0.3)), radius: up ? 1.5 : 1)
                    .shadow(color: color.opacity(strength * (up ? 1 : 0.35)), radius: up ? 6 : 2)
            } animation: { _ in .easeInOut(duration: Self.breath) }
        }
    }
}
