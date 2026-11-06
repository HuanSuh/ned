import AppKit
import Foundation
import UserNotifications

/// Native notifications for Ned, driven by `state.json` diffs (replaces the daemon's osascript banners).
///
/// Honors `state.notifications` (daemon config.notifications; see `plan`):
/// - `enabled=false` → nothing; `kinds[k]=false` → items of that kind are skipped.
/// - New attention ids → one notification each; more than `summary_threshold` (default 3) → one summary.
/// - `last_briefing` moved to a new id with status UPDATE → the headline (unless `briefing=false`, or
///   the attention notifications of this same reload already came from that briefing).
/// - `session` items (waiting/error) are `.timeSensitive`; everything else `.active`; `sound=false` → no sound.
/// - `state.quiet`: `quiet_delivery` decides — `skip` or `silent` (delivered to Notification Center
///   without sound or banner, `.passive`); absent → the `quietDelivery` user default, then `skip`.
/// - Seen ids live in UserDefaults (`notifySeen:<NED_HOME>`: id → first-seen epoch s) so a restart does not
///   re-notify. Session ids are forgotten once they leave `attention`, so the next alert for the
///   same session notifies again; other ids are pruned after 7 days.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    // Lazy: `current()` throws (NSInternalInconsistencyException) outside a .app bundle, and the
    // bare `.build/release/Ned` binary is the documented way to check UI changes on macOS 26.
    private lazy var center = UNUserNotificationCenter.current()
    private let defaults = AppConfig.defaults
    // Scoped by NED_HOME: a test bundle (same bundle id) must not touch the real app's seen set.
    private let seenKey = "notifySeen:" + AppConfig.home
    private let briefingKey = "notifyLastBriefing:" + AppConfig.home
    private let seededKey = "notifySeeded:" + AppConfig.home
    static let quietDeliveryKey = "quietDelivery"
    nonisolated private static let kinds = ["session", "email", "slack", "jira", "github", "sentry", "calendar", "other", "briefing", "summary"]

    private var ready = false
    private var pending: NedState?
    private weak var store: StateStore?

    private func note(_ msg: String) { DaemonManager.shared.note("notify: " + msg) }

    // MARK: setup

    /// Call from applicationDidFinishLaunching: delegate, categories, then authorization.
    func start() {
        guard Bundle.main.bundleURL.pathExtension == "app" else {
            note("not running from a .app bundle — native notifications off")
            return
        }
        center.delegate = self
        center.setNotificationCategories(Self.categories())
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            Task { @MainActor in
                let s = await UNUserNotificationCenter.current().notificationSettings()
                self.note("authorization granted=\(granted) status=\(Self.describe(s.authorizationStatus)) alert=\(s.alertSetting.rawValue) style=\(s.alertStyle.rawValue)" + (error.map { " error=\($0.localizedDescription)" } ?? ""))
                self.ready = true
                if let st = self.pending { self.pending = nil; self.process(st) }
            }
        }
    }

    private static func categories() -> Set<UNNotificationCategory> {
        let open = UNNotificationAction(identifier: "open", title: "열기", options: [.foreground])
        let close = UNNotificationAction(identifier: "dismiss", title: "닫기", options: [])
        var out = Set<UNNotificationCategory>()
        for k in kinds {
            out.insert(UNNotificationCategory(identifier: "ned.\(k)", actions: [close], intentIdentifiers: []))
            out.insert(UNNotificationCategory(identifier: "ned.\(k).link", actions: [open, close], intentIdentifiers: []))
        }
        return out
    }

    // MARK: diff

    /// Called by StateStore after every successful decode.
    func stateDidLoad(_ state: NedState, store: StateStore) {
        self.store = store
        guard ready else { pending = state; return }
        process(state)
    }

    private func process(_ state: NedState) {
        var seen = (defaults.dictionary(forKey: seenKey) as? [String: Double]) ?? [:]
        let now = Date().timeIntervalSince1970
        let currentIds = Set(state.attention.map(\.id))

        // First run ever: adopt what is already there instead of flooding.
        if !defaults.bool(forKey: seededKey) {
            for a in state.attention { seen[a.id] = now }
            defaults.set(seen, forKey: seenKey)
            defaults.set(state.last_briefing?.id ?? "", forKey: briefingKey)
            defaults.set(true, forKey: seededKey)
            note("first run: seeded \(state.attention.count) attention ids as seen, briefing=\(state.last_briefing?.id ?? "nil")")
            return
        }

        let fresh = state.attention.filter { seen[$0.id] == nil }
        for a in fresh { seen[a.id] = now }
        // Prune: sessions that left attention (so a later alert notifies again), anything > 7 days.
        seen = seen.filter { id, t in
            if id.hasPrefix("session:") && !currentIds.contains(id) { return false }
            return now - t < 7 * 86400
        }
        defaults.set(seen, forKey: seenKey)

        var briefingNew: LastBriefing? = nil
        if let b = state.last_briefing, !b.id.isEmpty, b.id != defaults.string(forKey: briefingKey) {
            defaults.set(b.id, forKey: briefingKey)
            if b.status == "UPDATE" { briefingNew = b }
        }
        guard !fresh.isEmpty || briefingNew != nil else { return }

        // Optimistic menu pick wins over a state.json that has not caught up yet.
        let persona = store?.persona ?? state.personaID.persona
        let plan = Self.plan(fresh: fresh, briefing: briefingNew, quiet: state.quiet,
                             settings: state.notifications, quietFallback: quietDeliveryDefault,
                             persona: persona, now: now)
        for s in plan.skipped { note("skip \(s.id): \(s.reason)") }
        for p in plan.posts { post(p) }
    }

    /// The `quietDelivery` user default: used only when state.json has no `notifications.quiet_delivery`.
    private var quietDeliveryDefault: String { defaults.string(forKey: Self.quietDeliveryKey) ?? "skip" }

    // MARK: decision (pure; shared by `process` and `--notify-selftest`)

    struct Planned {
        var id: String
        var title: String
        var subtitle: String = ""
        var body: String
        var category: String
        var urgent: Bool
        /// Quiet hours with quiet_delivery=silent: `.passive`, no sound.
        var silent: Bool
        /// notifications.sound (and not silent).
        var sound: Bool
        var info: [String: String]
    }

    struct Plan {
        var posts: [Planned] = []
        var skipped: [(id: String, reason: String)] = []
    }

    /// What to post for this reload's new attention items and (UPDATE) briefing, honoring
    /// `state.notifications`. Seen-set bookkeeping stays in `process`: skipped items are still
    /// marked seen, so re-enabling a kind does not replay a backlog.
    nonisolated static func plan(fresh: [AttentionItem], briefing: LastBriefing?, quiet: Bool,
                                 settings ns: NotifySettings, quietFallback: String,
                                 persona: Persona, now: Double) -> Plan {
        var plan = Plan()
        let briefingId = briefing.map { "briefing:\($0.id)" }
        func skipAll(_ reason: String) -> Plan {
            plan.skipped = fresh.map { ($0.id, reason) } + (briefingId.map { [($0, reason)] } ?? [])
            return plan
        }
        guard ns.enabled else { return skipAll("notifications.enabled=false") }
        let quietDelivery = ns.quiet_delivery ?? quietFallback
        if quiet && quietDelivery != "silent" {
            return skipAll("quiet hours, quiet_delivery=\(quietDelivery)" + (ns.quiet_delivery == nil ? " (user default)" : ""))
        }
        let silent = quiet
        let sound = ns.sound && !silent

        var items: [AttentionItem] = []
        for a in fresh {
            if ns.kindEnabled(a.kind) { items.append(a) }
            else { plan.skipped.append((a.id, "kinds.\(a.kind)=false")) }
        }

        if items.count > ns.summary_threshold {
            let first = items.sorted { priority($0) > priority($1) }[0]
            let urgent = items.contains { $0.kind == "session" }
            plan.posts.append(Planned(id: "summary:\(Int(now))", title: persona.summaryTitle(items.count),
                                      body: persona.summaryBody(first.title, items.count - 1),
                                      category: "ned.summary", urgent: urgent, silent: silent, sound: sound, info: [:]))
        } else {
            for a in items {
                var info: [String: String] = ["attentionId": a.id]
                if let u = a.url, !u.isEmpty { info["url"] = u }
                let kind = kinds.contains(a.kind) ? a.kind : "other"
                // Item title stays the content; the persona name rides in the subtitle.
                plan.posts.append(Planned(id: a.id, title: a.title, subtitle: persona.displayName, body: a.detail ?? "",
                                          category: "ned.\(kind)" + (info["url"] != nil ? ".link" : ""),
                                          urgent: a.kind == "session", silent: silent, sound: sound, info: info))
            }
        }

        if let b = briefing, let bid = briefingId {
            if !ns.briefing {
                plan.skipped.append((bid, "notifications.briefing=false"))
            } else if items.contains(where: { $0.source == b.id }) {
                plan.skipped.append((bid, "covered by this reload's attention notifications"))
            } else {
                plan.posts.append(Planned(id: bid, title: persona.displayName, body: b.headline ?? persona.briefingFallback,
                                          category: "ned.briefing", urgent: false, silent: silent, sound: sound, info: [:]))
            }
        }
        return plan
    }

    nonisolated private static func priority(_ a: AttentionItem) -> Int { a.kind == "session" ? 1 : 0 }

    private func post(_ p: Planned) {
        let c = UNMutableNotificationContent()
        c.title = p.title
        c.subtitle = p.subtitle
        c.body = p.body
        c.categoryIdentifier = p.category
        c.userInfo = p.info
        c.threadIdentifier = p.category
        c.sound = p.sound ? .default : nil
        c.interruptionLevel = p.silent ? .passive : (p.urgent ? .timeSensitive : .active)
        let req = UNNotificationRequest(identifier: p.id, content: c, trigger: nil)
        let level = c.interruptionLevel.rawValue
        center.add(req) { error in
            Task { @MainActor in
                if let error {
                    self.note("request \(p.id) FAILED: \(error.localizedDescription)")
                } else {
                    self.note("request \(p.id) delivered (category=\(p.category) level=\(level) silent=\(p.silent) sound=\(p.sound)) title=\(p.title)" + (p.subtitle.isEmpty ? "" : " subtitle=\(p.subtitle)") + " body=\(p.body)")
                }
            }
        }
    }

    // MARK: delegate

    /// LSUIElement apps are often "frontmost" while the menu is open; still show the banner.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        let url = info["url"] as? String
        let attentionId = info["attentionId"] as? String
        await MainActor.run {
            note("action \(action) on \(response.notification.request.identifier)")
            switch action {
            case "open":
                if let url, let u = URL(string: url) { NSWorkspace.shared.open(u) }
            case "dismiss":
                if let attentionId { store?.dismiss(attentionId) }
            case UNNotificationDefaultActionIdentifier:
                DashboardWindowController.shared.show()
            default:
                break
            }
        }
    }

    private static func describe(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown(\(s.rawValue))"
        }
    }
}

/// `Ned --notify-selftest`: runs synthetic state.json transitions through `Notifier.plan` (nothing is
/// posted, no UI, no daemon) and prints what would be posted or skipped and why. Exits 0, or 1 on a failed check.
enum NotifySelfTest {
    @MainActor
    static func run() -> Int32 {
        var failures = 0
        func decode(_ json: String) -> NedState {
            do { return try JSONDecoder().decode(NedState.self, from: Data(json.utf8)) }
            catch { print("DECODE FAILED: \(error)"); failures += 1; return NedState() }
        }
        let items = """
        [{"id":"session:a","kind":"session","title":"api: waiting for input","source":"hb1"},
         {"id":"slack:1","kind":"slack","title":"#dev: 리뷰 부탁","url":"https://slack.example/1","source":"hb1"},
         {"id":"email:1","kind":"email","title":"CFO: 정산 자료","source":"hb1"}]
        """
        let briefing = #"{"id":"hb2","status":"UPDATE","headline":"오늘 회의 3건"}"#
        // (name, state.json, user default quietDelivery, expected (posts, skipped))
        let cases: [(String, String, String, (Int, Int))] = [
            ("old state.json (no notifications) → defaults: 3 items ≤ 3, briefing posted",
             #"{"attention":\#(items),"last_briefing":\#(briefing)}"#, "skip", (4, 0)),
            ("enabled off",
             #"{"attention":\#(items),"last_briefing":\#(briefing),"notifications":{"enabled":false}}"#, "skip", (0, 4)),
            ("kind off (slack=false)",
             #"{"attention":\#(items),"notifications":{"kinds":{"slack":false}}}"#, "skip", (2, 1)),
            ("threshold 2 with 3 items → one summary",
             #"{"attention":\#(items),"notifications":{"summary_threshold":2}}"#, "skip", (1, 0)),
            ("quiet + quiet_delivery=skip",
             #"{"quiet":true,"attention":\#(items),"notifications":{"quiet_delivery":"skip"}}"#, "silent", (0, 3)),
            ("quiet + quiet_delivery=silent (passive, no sound)",
             #"{"quiet":true,"attention":\#(items),"notifications":{"quiet_delivery":"silent"}}"#, "skip", (3, 0)),
            ("quiet, quiet_delivery absent → user default silent",
             #"{"quiet":true,"attention":\#(items),"notifications":{}}"#, "silent", (3, 0)),
            ("briefing off",
             #"{"last_briefing":\#(briefing),"notifications":{"briefing":false}}"#, "skip", (0, 1)),
            ("sound off",
             #"{"attention":[{"id":"jira:9","kind":"jira","title":"NED-9 assigned"}],"notifications":{"sound":false}}"#, "skip", (1, 0)),
        ]
        for (name, json, qd, expect) in cases {
            let st = decode(json)
            let b = st.last_briefing.flatMap { $0.status == "UPDATE" ? $0 : nil }
            let plan = Notifier.plan(fresh: st.attention, briefing: b, quiet: st.quiet, settings: st.notifications,
                                     quietFallback: qd, persona: st.personaID.persona, now: 1_700_000_000)
            let ok = plan.posts.count == expect.0 && plan.skipped.count == expect.1
            if !ok { failures += 1 }
            print("== \(name) [\(ok ? "OK" : "FAIL: expected \(expect.0) post / \(expect.1) skip")]")
            for p in plan.posts {
                let level = p.silent ? "passive" : (p.urgent ? "timeSensitive" : "active")
                print("  POST \(p.id) category=\(p.category) level=\(level) sound=\(p.sound) title=\(p.title) body=\(p.body)")
            }
            for s in plan.skipped { print("  SKIP \(s.id): \(s.reason)") }
        }
        print(failures == 0 ? "notify selftest: all passed" : "notify selftest: \(failures) FAILED")
        return failures == 0 ? 0 : 1
    }
}
