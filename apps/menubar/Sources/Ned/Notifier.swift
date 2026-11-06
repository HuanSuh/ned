import AppKit
import Foundation
import UserNotifications

/// Native notifications for Ned, driven by `state.json` diffs (replaces the daemon's osascript banners).
///
/// - New attention ids → one notification each; more than 3 at once → one summary.
/// - `last_briefing` moved to a new id with status UPDATE → the headline, unless the attention
///   notifications of this same reload already came from that briefing.
/// - `session` items (waiting/error) are `.timeSensitive`; everything else `.active`.
/// - `state.quiet`: the `quietDelivery` user default decides — `skip` (default) or `silent`
///   (delivered to Notification Center without sound or banner, `.passive`).
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
    private static let kinds = ["session", "email", "slack", "jira", "github", "sentry", "calendar", "other", "briefing", "summary"]

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

        if state.quiet && quietDelivery == "skip" {
            note("quiet hours: skipped \(fresh.count) attention + \(briefingNew == nil ? 0 : 1) briefing (quietDelivery=skip)")
            return
        }
        let silent = state.quiet
        // Optimistic menu pick wins over a state.json that has not caught up yet.
        let persona = store?.persona ?? state.personaID.persona

        if fresh.count > 3 {
            let first = fresh.sorted { priority($0) > priority($1) }[0]
            let urgent = fresh.contains { $0.kind == "session" }
            post(id: "summary:\(Int(now))", title: persona.summaryTitle(fresh.count),
                 body: persona.summaryBody(first.title, fresh.count - 1),
                 category: "ned.summary", urgent: urgent, silent: silent, info: [:])
        } else {
            for a in fresh {
                var info: [String: String] = ["attentionId": a.id]
                if let u = a.url, !u.isEmpty { info["url"] = u }
                let kind = Self.kinds.contains(a.kind) ? a.kind : "other"
                // Item title stays the content; the persona name rides in the subtitle.
                post(id: a.id, title: a.title, subtitle: persona.displayName, body: a.detail ?? "",
                     category: "ned.\(kind)" + (info["url"] != nil ? ".link" : ""),
                     urgent: a.kind == "session", silent: silent, info: info)
            }
        }
        if let b = briefingNew {
            if fresh.contains(where: { $0.source == b.id }) {
                note("briefing \(b.id) UPDATE covered by attention notifications — no separate banner")
            } else {
                post(id: "briefing:\(b.id)", title: persona.displayName, body: b.headline ?? persona.briefingFallback,
                     category: "ned.briefing", urgent: false, silent: silent, info: [:])
            }
        }
    }

    private var quietDelivery: String { defaults.string(forKey: Self.quietDeliveryKey) ?? "skip" }

    private func priority(_ a: AttentionItem) -> Int { a.kind == "session" ? 1 : 0 }

    private func post(id: String, title: String, subtitle: String = "", body: String, category: String,
                      urgent: Bool, silent: Bool, info: [String: String]) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.subtitle = subtitle
        c.body = body
        c.categoryIdentifier = category
        c.userInfo = info
        c.threadIdentifier = category
        c.sound = silent ? nil : .default
        c.interruptionLevel = silent ? .passive : (urgent ? .timeSensitive : .active)
        let req = UNNotificationRequest(identifier: id, content: c, trigger: nil)
        let level = c.interruptionLevel.rawValue
        center.add(req) { error in
            Task { @MainActor in
                if let error {
                    self.note("request \(id) FAILED: \(error.localizedDescription)")
                } else {
                    self.note("request \(id) delivered (category=\(category) level=\(level) silent=\(silent)) title=\(title)" + (subtitle.isEmpty ? "" : " subtitle=\(subtitle)") + " body=\(body)")
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
