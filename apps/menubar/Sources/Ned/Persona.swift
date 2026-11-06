import SwiftUI
import AppKit

/// Who Ned "is" right now. Mirrors the daemon's `config.persona` (exposed as `state.json` `persona`).
/// Archetypes only: colors, geometry and copy tone — no logos, character art or quotes.
enum PersonaID: String, CaseIterable, Identifiable, Sendable {
    case ned, alfred, oracle, jarvis
    var id: String { rawValue }

    /// Unknown / missing values fall back to `.ned` so a newer daemon never breaks the menu.
    init(raw: String?) {
        self = raw.flatMap { PersonaID(rawValue: $0.lowercased()) } ?? .ned
    }

    var persona: Persona { Persona.all[self]! }
}

struct Persona {
    let id: PersonaID
    let displayName: String
    /// Menu bar SF Symbols. All exist since macOS 11–13 (checked against macOS 14's catalog era);
    /// `symbol(_:)` still falls back to Ned's set if a name is missing at runtime.
    let idleSymbol: String
    let attentionSymbol: String
    let offlineSymbol: String
    /// Buttons, links, attention icons, the menu bar badge.
    let accent: Color
    let accentNS: NSColor
    /// "Live" LEDs (daemon running, session running). Kept distinct from red/orange status colors.
    let led: Color
    let headerTitle: String
    /// Header subtitle when the last briefing was quiet (or there is none yet).
    let nothingNew: String
    /// Shown when the attention list is empty (morning/day/evening/night).
    private let greetings: (morning: String, day: String, evening: String, night: String)
    /// Notifier copy: (count, firstTitle) → (title, body) for the >3 summary; fallback briefing body.
    let summaryTitle: (Int) -> String
    let summaryBody: (String, Int) -> String
    let briefingFallback: String
    /// Resource name of the persona's .icns in the bundle (`nil` = bundle default Ned.icns).
    let iconResource: String?

    func greeting(at date: Date = Date()) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case 5..<11: return greetings.morning
        case 11..<18: return greetings.day
        case 18..<23: return greetings.evening
        default: return greetings.night
        }
    }

    enum Mode { case idle, attention, offline }

    func symbol(_ mode: Mode) -> String {
        let (name, fallback): (String, String) = switch mode {
        case .idle: (idleSymbol, "eye")
        case .attention: (attentionSymbol, "eyeglasses")
        case .offline: (offlineSymbol, "eye.slash")
        }
        return NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil ? name : fallback
    }

    var accentHex: String {
        let c = accentNS.usingColorSpace(.sRGB) ?? accentNS
        return String(format: "#%02x%02x%02x", Int(round(c.redComponent * 255)), Int(round(c.greenComponent * 255)), Int(round(c.blueComponent * 255)))
    }

    var icon: NSImage? {
        guard let r = iconResource, let url = Bundle.main.url(forResource: r, withExtension: "icns") else { return nil }
        return NSImage(contentsOf: url)
    }

    static let all: [PersonaID: Persona] = [
        .ned: Persona(
            id: .ned, displayName: "Ned",
            idleSymbol: "eye", attentionSymbol: "eyeglasses", offlineSymbol: "eye.slash",
            accent: Color(hex: 0xE23636), accentNS: NSColor(hex: 0xE23636), led: Color(hex: 0x4A78F0),
            headerTitle: "Ned",
            nothingNew: "레이더 깨끗함",
            greetings: ("좋은 아침! 오늘도 같이 가요", "오후도 순찰 중", "저녁까지 수고 많았어요", "늦었어요, 망은 제가 볼게요"),
            summaryTitle: { "Ned: 레이더에 \($0)건 잡혔어요" },
            summaryBody: { "\($0) 외 \($1)건" },
            briefingFallback: "새 브리핑 왔어요",
            iconResource: nil),
        .alfred: Persona(
            id: .alfred, displayName: "Alfred",
            idleSymbol: "person.crop.circle", attentionSymbol: "bell", offlineSymbol: "person.crop.circle.badge.xmark",
            accent: Color(hex: 0xD4AF37), accentNS: NSColor(hex: 0xD4AF37), led: Color(hex: 0xD4AF37),
            headerTitle: "Alfred",
            nothingNew: "현재 보고드릴 사항이 없습니다",
            greetings: ("좋은 아침입니다", "오후 일정 준비되어 있습니다", "저녁 시간입니다. 무리하지 마십시오", "늦은 시간입니다. 쉬셔도 됩니다"),
            summaryTitle: { "Alfred: 보고드릴 사항 \($0)건" },
            summaryBody: { "\($0) 외 \($1)건이 대기 중입니다" },
            briefingFallback: "새 보고가 준비되었습니다",
            iconResource: "Ned-alfred"),
        .oracle: Persona(
            id: .oracle, displayName: "Oracle",
            idleSymbol: "headphones", attentionSymbol: "waveform", offlineSymbol: "antenna.radiowaves.left.and.right.slash",
            accent: Color(hex: 0x8B5CF6), accentNS: NSColor(hex: 0x8B5CF6), led: Color(hex: 0x3DDC84),
            headerTitle: "Oracle",
            nothingNew: "이상 무. 대기 중.",
            greetings: ("오전 교대. 채널 개방.", "주간 감시 중.", "야간 전환 준비.", "야간 감시 중."),
            summaryTitle: { "Oracle: 신호 \($0)건 포착" },
            summaryBody: { "최우선: \($0) (+\($1))" },
            briefingFallback: "신규 브리핑 수신.",
            iconResource: "Ned-oracle"),
        .jarvis: Persona(
            id: .jarvis, displayName: "JARVIS",
            idleSymbol: "circle.hexagongrid", attentionSymbol: "circle.hexagongrid.fill", offlineSymbol: "circle.slash",
            accent: Color(hex: 0x38BDF8), accentNS: NSColor(hex: 0x38BDF8), led: Color(hex: 0x38BDF8),
            headerTitle: "JARVIS",
            nothingNew: "모든 시스템 정상입니다",
            greetings: ("좋은 아침입니다. 시스템 온라인", "오후 업무 모니터링 중입니다", "저녁 모드로 전환합니다", "야간 대기 모드입니다"),
            summaryTitle: { "JARVIS: \($0)건 감지되었습니다" },
            summaryBody: { "\($0) 외 \($1)건을 확인해 주십시오" },
            briefingFallback: "새 브리핑이 도착했습니다",
            iconResource: "Ned-jarvis"),
    ]
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// Applies the persona's app icon (Dock while the dashboard is open, About panel, alerts).
/// Finder / Login Items list / notification banners read the bundle's CFBundleIconFile (Ned.icns) instead.
@MainActor
enum PersonaIcon {
    private static var current: PersonaID?
    static func apply(_ id: PersonaID) {
        guard current != id else { return }
        current = id
        let icon = id.persona.icon
        NSApp.applicationIconImage = icon // nil restores the bundle icon (Ned.icns)
        let what = id.persona.iconResource.map { icon == nil ? "\($0).icns MISSING (not in a bundle?) — bundle icon" : "\($0).icns" } ?? "Ned.icns"
        DaemonManager.shared.note("persona icon -> \(id.rawValue): \(what)")
    }
}

/// `--persona-selftest`: log-only verification (no UI input). Prints every persona's resolution,
/// the decode fallbacks, then drives `StateStore.setPersona` (the submenu's action) and quits.
@MainActor
enum PersonaSelfTest {
    static func run() async {
        let note = { (m: String) in DaemonManager.shared.note("selftest: " + m) }
        for _ in 0..<40 where StateStore.current == nil { try? await Task.sleep(for: .milliseconds(50)) }
        guard let store = StateStore.current else { note("no StateStore"); NSApp.terminate(nil); return }
        for id in PersonaID.allCases {
            let p = id.persona
            note("\(id.rawValue): name=\(p.displayName) header=\(p.headerTitle) symbols idle=\(p.symbol(.idle)) attention=\(p.symbol(.attention)) offline=\(p.symbol(.offline)) accent=\(p.accentHex) icon=\(p.iconResource ?? "Ned") found=\(p.icon != nil || p.iconResource == nil)")
            note("\(id.rawValue): nothingNew=\(p.nothingNew) | greeting=\(p.greeting()) | summary=\(p.summaryTitle(5)) / \(p.summaryBody("CFO: 정산 자료", 4)) | briefing=\(p.briefingFallback)")
        }
        for raw in [nil, "", "ALFRED", "bogus", "jarvis"] as [String?] {
            note("decode persona=\(raw.map { "\"\($0)\"" } ?? "nil") -> \(PersonaID(raw: raw).rawValue)")
        }
        note("start: personaID=\(store.personaID.rawValue) state.persona=\(store.state.persona ?? "nil")")
        for id in [PersonaID.alfred, .jarvis] {
            store.setPersona(id)
            note("after setPersona(\(id.rawValue)) immediately: personaID=\(store.personaID.rawValue) override=\(store.personaOverride?.rawValue ?? "nil")")
            try? await Task.sleep(for: .seconds(3))
            note("after setPersona(\(id.rawValue)) +3s: personaID=\(store.personaID.rawValue) override=\(store.personaOverride?.rawValue ?? "nil") state.persona=\(store.state.persona ?? "nil") appIcon=\(NSApp.applicationIconImage.map { "\(Int($0.size.width))pt" } ?? "nil")")
        }
        // Window for an external state.json edit (live switch without restart).
        let wait = Double(AppConfig.env["NED_SELFTEST_WAIT"] ?? "0") ?? 0
        if wait > 0 {
            note("waiting \(Int(wait))s for external state.json changes")
            try? await Task.sleep(for: .seconds(wait))
            note("end: personaID=\(store.personaID.rawValue) state.persona=\(store.state.persona ?? "nil")")
        }
        note("done")
        NSApp.terminate(nil)
    }
}
