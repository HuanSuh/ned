import SwiftUI
import AppKit
import Combine

// MARK: - State → expression (pure; checked by --pet-selftest)

/// What the floating pet shows. Highest priority first — `PetMapping.expression` picks the first that applies.
enum PetMood: String, CaseIterable, Sendable {
    case offline, blocked, needsInput, attention, running, idle
}

/// Only what `StateStore` / `DaemonManager` already have (no daemon change).
struct PetInput: Sendable {
    struct Session: Sendable {
        var worktree: String
        var status: String
        var isWorker: Bool = false
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
    /// Every applicable line, priority order. The first is the mood's bubble; the hover bubble shows the top 3.
    var lines: [PetLine]
    /// Open attention count on the character (not while offline).
    var badge: Int?

    /// Bubble text on a state change (`nil` for idle).
    var bubble: String? { lines.first?.text }
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
    static let panel = CGSize(width: 240, height: 160)
    static let character: CGFloat = 72
    static let inset: CGFloat = 8
    /// In AppKit coordinates (origin bottom-left) of a panel of `size`.
    static func characterRect(in size: CGSize) -> CGRect {
        CGRect(x: size.width - inset - character, y: inset, width: character, height: character)
    }
}

// MARK: - Model

@MainActor
final class PetModel: ObservableObject {
    @Published private(set) var expression = PetExpression.idle
    @Published private(set) var persona: PersonaID = .ned
    /// The state-change bubble currently shown (auto-collapses).
    @Published private(set) var bubbleText: String?
    @Published var hovering = false
    @Published var reduceMotion: Bool

    static let bubbleSeconds: TimeInterval = 5
    static let doneSeconds: TimeInterval = 2.5
    private var hideWork: DispatchWorkItem?

    init(reduceMotion: Bool = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion) {
        self.reduceMotion = reduceMotion
    }

    /// `quiet` = the daemon's quiet hours (`state.json` `quiet`): no automatic bubble, hover still works.
    func update(_ e: PetExpression, persona p: PersonaID, quiet: Bool) {
        if p != persona { persona = p }
        guard e != expression else { return }
        let prev = expression
        expression = e
        guard e.mood != prev.mood || e.bubble != prev.bubble else { return } // badge-only change
        if quiet { collapse(); return }
        if let b = e.bubble { flash(b, for: Self.bubbleSeconds) }
        else if PetMapping.showsDone(from: prev.mood, to: e.mood) { flash(PetMapping.doneText, for: Self.doneSeconds) }
        else { collapse() }
    }

    /// Lines in the bubble right now: hover → top 3 (or the persona's "nothing new"), else the auto bubble.
    var visibleLines: [PetLine] {
        if hovering { return expression.summary.isEmpty ? [PetLine(mood: .idle, text: persona.persona.nothingNew)] : expression.summary }
        guard let t = bubbleText else { return [] }
        return [PetLine(mood: t == PetMapping.doneText ? .idle : expression.mood, text: t)]
    }

    /// For snapshots: show a fixed state with its bubble open, no timers.
    func pin(_ e: PetExpression, persona p: PersonaID, bubble: String?, hovering h: Bool) {
        hideWork?.cancel()
        expression = e; persona = p; bubbleText = bubble; hovering = h; reduceMotion = true
    }

    private func flash(_ text: String, for seconds: TimeInterval) {
        hideWork?.cancel()
        bubbleText = text
        let w = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.bubbleText = nil } }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
    }

    private func collapse() {
        hideWork?.cancel(); hideWork = nil
        bubbleText = nil
    }
}

// MARK: - Views

private enum PetColors {
    static let warning = Color(hex: 0xFF453A)
    static let waiting = Color(hex: 0xFF9F0A)

    static func icon(_ m: PetMood) -> String {
        switch m {
        case .offline: return "bolt.horizontal.circle"
        case .blocked: return "exclamationmark.triangle.fill"
        case .needsInput: return "hand.raised.fill"
        case .attention: return "bell.fill"
        case .running: return "gearshape.2.fill"
        case .idle: return "checkmark.circle.fill"
        }
    }

    static func tint(_ m: PetMood, _ p: Persona) -> Color {
        switch m {
        case .offline: return .gray
        case .blocked: return warning
        case .needsInput: return waiting
        case .attention: return p.accent
        case .running: return p.led
        case .idle: return p.led
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

struct PetView: View {
    @ObservedObject var model: PetModel

    var body: some View {
        let p = model.persona.persona
        VStack(alignment: .trailing, spacing: 6) {
            Spacer(minLength: 0)
            let lines = model.visibleLines
            if !lines.isEmpty {
                PetBubble(lines: lines, persona: p)
                    .transition(model.reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.9, anchor: .bottomTrailing)))
            }
            PetCharacter(mood: model.expression.mood, persona: p, badge: model.expression.badge, reduceMotion: model.reduceMotion)
        }
        .padding(PetLayout.inset)
        .frame(width: PetLayout.panel.width, height: PetLayout.panel.height, alignment: .bottomTrailing)
        .animation(model.reduceMotion ? nil : .easeOut(duration: 0.2), value: model.visibleLines)
    }
}

struct PetBubble: View {
    let lines: [PetLine]
    let persona: Persona
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                HStack(spacing: 5) {
                    Image(systemName: PetColors.icon(l.mood)).font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(PetColors.tint(l.mood, persona))
                    Text(l.text).font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(scheme == .dark ? Color(hex: 0xF2F2F4) : Color(hex: 0x1D1D1F))
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(scheme == .dark ? Color(hex: 0x2C2E33) : Color.white)
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(scheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.10), lineWidth: 0.5))
                .shadow(color: .black.opacity(scheme == .dark ? 0.45 : 0.18), radius: 4, y: 1.5)
        )
        .frame(maxWidth: PetLayout.panel.width - 2 * PetLayout.inset, alignment: .trailing)
        .padding(.trailing, 6)
    }
}

struct PetCharacter: View {
    let mood: PetMood
    let persona: Persona
    let badge: Int?
    let reduceMotion: Bool

    var body: some View {
        let tile: CGFloat = 58
        ZStack {
            if mood == .running { RunningRing(color: persona.led, still: reduceMotion) }
            if mood == .blocked {
                RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PetColors.warning, lineWidth: 3)
                    .frame(width: tile + 8, height: tile + 8)
                    .shadow(color: PetColors.warning.opacity(0.6), radius: 4)
            }
            Image(nsImage: PetArt.mark(persona.id)).resizable().interpolation(.high)
                .frame(width: tile, height: tile)
                .clipShape(RoundedRectangle(cornerRadius: tile * 14 / 64, style: .continuous))
                // Hairline so the dark tile still reads on a dark desktop.
                .overlay(RoundedRectangle(cornerRadius: tile * 14 / 64, style: .continuous).stroke(Color.white.opacity(0.22), lineWidth: 1))
                .shadow(color: .black.opacity(0.35), radius: 3, y: 1.5)
                .saturation(mood == .offline ? 0 : 1)
                .opacity(mood == .offline ? 0.45 : 1)
        }
        .frame(width: PetLayout.character, height: PetLayout.character)
        .modifier(PetMotion(mood: mood, still: reduceMotion))
        .overlay(alignment: .topLeading) {
            if mood == .needsInput {
                Image(systemName: "hand.wave.fill").font(.system(size: 15)).foregroundStyle(PetColors.waiting)
                    .shadow(color: .black.opacity(0.3), radius: 1.5).offset(x: 1, y: 1)
            }
        }
        .overlay(alignment: .topTrailing) {
            if let n = badge {
                Text(n > 99 ? "99+" : "\(n)").font(.system(size: 11, weight: .bold)).monospacedDigit()
                    .foregroundStyle(.white).padding(.horizontal, 5).frame(minWidth: 19, minHeight: 19)
                    .background(Capsule().fill(persona.accent))
                    .overlay(Capsule().stroke(Color.white.opacity(0.85), lineWidth: 1.2))
                    .shadow(color: .black.opacity(0.3), radius: 1.5)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(Text(persona.displayName))
    }
}

/// Dashed arc around the tile; one SwiftUI repeat-forever rotation (Core Animation, no Timer).
private struct RunningRing: View {
    let color: Color
    let still: Bool
    @State private var spin = false

    var body: some View {
        Circle().trim(from: 0, to: 0.72)
            .stroke(color.opacity(0.85), style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [5, 5]))
            .frame(width: 70, height: 70)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(still ? nil : .linear(duration: 3).repeatForever(autoreverses: false), value: spin)
            .onAppear { if !still { spin = true } }
    }
}

/// idle: breathing · blocked: shake then pause · needsInput: bounce then pause · others: still.
/// "동작 줄이기" → no motion at all.
private struct PetMotion: ViewModifier {
    let mood: PetMood
    let still: Bool

    enum Shake: CaseIterable { case rest, left, right, left2, right2
        var angle: Double { switch self { case .rest: 0; case .left: -6; case .right: 6; case .left2: -3; case .right2: 3 } }
    }
    enum Bounce: CaseIterable { case rest, up, down
        var dy: CGFloat { switch self { case .rest, .down: 0; case .up: -7 } }
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        if still {
            content
        } else {
            switch mood {
            case .idle:
                content.phaseAnimator([false, true]) { c, big in c.scaleEffect(big ? 1.035 : 1, anchor: .bottom) }
                    animation: { _ in .easeInOut(duration: 2.4) }
            case .blocked:
                content.phaseAnimator(Shake.allCases) { c, s in c.rotationEffect(.degrees(s.angle)) }
                    animation: { s in s == .rest ? .easeOut(duration: 0.08).delay(1.6) : .linear(duration: 0.07) }
            case .needsInput:
                content.phaseAnimator(Bounce.allCases) { c, b in c.offset(y: b.dy) }
                    animation: { b in b == .up ? .easeOut(duration: 0.22) : b == .down ? .easeIn(duration: 0.22) : .linear(duration: 0.01).delay(1.4) }
            case .offline, .attention, .running:
                content
            }
        }
    }
}

// MARK: - Panel

/// Never key / main: clicking the pet does not take focus from the app in front.
final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Mouse over the character only: click → dashboard, drag → move (origin saved), right-click → menu, hover → summary.
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
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { controller?.model.hovering = true }
    override func mouseExited(with event: NSEvent) { controller?.model.hovering = false }

    override func mouseDown(with event: NSEvent) {
        startMouse = NSEvent.mouseLocation
        startOrigin = window?.frame.origin ?? .zero
        dragged = false
    }
    override func mouseDragged(with event: NSEvent) {
        let p = NSEvent.mouseLocation
        let dx = p.x - startMouse.x, dy = p.y - startMouse.y
        if !dragged, hypot(dx, dy) < 3 { return }
        dragged = true
        window?.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy))
    }
    override func mouseUp(with event: NSEvent) {
        if dragged { controller?.saveOrigin() } else { controller?.openDashboard() }
    }
    override func rightMouseDown(with event: NSEvent) {
        guard let menu = controller?.contextMenu() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}

/// The floating Ned: one non-activating panel on every Space (and over full-screen apps), off by default.
/// Shown while the `desktopPetEnabled` user default is on (menu toggle "데스크톱 펫 표시", 우클릭 "숨기기").
@MainActor
final class DesktopPetController: NSObject {
    nonisolated static let enabledKey = "desktopPetEnabled"
    nonisolated static let originKey = "desktopPetOrigin"

    let defaults: UserDefaults
    let model: PetModel
    private(set) var panel: PetPanel?
    private var kvo: NSKeyValueObservation?
    private var subs: Set<AnyCancellable> = []
    private var observers: [NSObjectProtocol] = []
    /// Click / 대시보드 열기 — the menu's existing path.
    var openDashboardAction: () -> Void = { DashboardWindowController.shared.show() }

    var isEnabled: Bool { defaults.bool(forKey: Self.enabledKey) }
    var isShowing: Bool { panel?.isVisible == true }

    init(defaults: UserDefaults = .standard, model: PetModel? = nil) {
        self.defaults = defaults
        self.model = model ?? PetModel()
        super.init()
        kvo = defaults.observe(\.desktopPetEnabled, options: [.new]) { [weak self] _, _ in
            if Thread.isMainThread { MainActor.assumeIsolated { self?.sync() } }
            else { DispatchQueue.main.async { MainActor.assumeIsolated { self?.sync() } } }
        }
        let ws = NSWorkspace.shared.notificationCenter
        observers.append(ws.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.model.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.place() }
        })
        sync()
    }

    /// Follow the store (state.json) and the daemon supervisor (health) — both already published.
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
        let input = PetInput(
            alive: s.daemonAlive || daemon.isHealthy || daemon.isBooting,
            sessions: s.sessions.map { .init(worktree: $0.worktree, status: $0.status, isWorker: $0.is_worker) },
            openAttention: store.attentionCount)
        model.update(PetMapping.expression(input), persona: store.personaID, quiet: s.quiet)
    }

    /// Show / hide to match the user default.
    func sync() {
        if isEnabled {
            if panel == nil { panel = makePanel() }
            place()
            panel?.orderFrontRegardless()
        } else {
            panel?.orderOut(nil)
        }
    }

    func hide() { defaults.set(false, forKey: Self.enabledKey) }

    func openDashboard() { openDashboardAction() }

    func saveOrigin() {
        guard let o = panel?.frame.origin else { return }
        defaults.set(PetPlacement.encode(o), forKey: Self.originKey)
        place() // snaps back to the default if it was dropped off-screen
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
        let hide = NSMenuItem(title: "숨기기", action: #selector(menuHide), keyEquivalent: "")
        for i in [open, hide] { i.target = self }
        m.addItem(open)
        m.addItem(.separator())
        m.addItem(hide)
        return m
    }
    @objc private func menuOpen() { openDashboard() }
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
        let hit = PetHitView(frame: PetLayout.characterRect(in: size))
        hit.controller = self
        hit.setAccessibilityRole(.button)
        hit.setAccessibilityLabel("데스크톱 펫 — 클릭하면 대시보드")
        container.addSubview(hit)
        p.contentView = container
        return p
    }
}

extension UserDefaults {
    /// KVO key path for `DesktopPetController.enabledKey` (the property name must equal the key).
    @objc dynamic var desktopPetEnabled: Bool { bool(forKey: DesktopPetController.enabledKey) }
}

// MARK: - --pet-selftest / --pet-snapshot

@MainActor
enum PetSelfTest {
    static func run() -> Int32 {
        final class Tally { var failures = 0 }
        let tally = Tally()
        func check(_ ok: Bool, _ msg: String) { print("pet-selftest: \(ok ? "PASS" : "FAIL") — \(msg)"); fflush(stdout); if !ok { tally.failures += 1 } }
        typealias S = PetInput.Session
        func ex(_ i: PetInput) -> PetExpression { PetMapping.expression(i) }

        // Mapping: priority, copy, worker exclusion.
        var e = ex(PetInput(alive: true))
        check(e.mood == .idle && e.bubble == nil && e.badge == nil, "idle: no sessions → idle, no bubble, no badge")
        e = ex(PetInput(alive: false, sessions: [S(worktree: "a", status: "error")], openAttention: 3))
        check(e.mood == .offline && e.bubble == "연결 끊김" && e.badge == nil, "offline beats everything: \(e.bubble ?? "nil")")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "ned-daemon", status: "waiting"), S(worktree: "ned-menubar", status: "error"), S(worktree: "x", status: "running")], openAttention: 2))
        check(e.mood == .blocked && e.bubble == "ned-menubar 오류", "error beats waiting/attention/running: \(e.bubble ?? "nil")")
        check(e.summary.map(\.text) == ["ned-menubar 오류", "ned-daemon 입력 기다림", "확인할 것 2"], "hover summary = top 3: \(e.summary.map(\.text))")
        check(e.badge == 2, "badge = open attention under a higher mood")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "a", status: "error"), S(worktree: "b", status: "error")]))
        check(e.bubble == "오류 2", "two errors → \(e.bubble ?? "nil")")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "ned-daemon", status: "waiting"), S(worktree: "r", status: "running")], openAttention: 1))
        check(e.mood == .needsInput && e.bubble == "ned-daemon 입력 기다림", "waiting beats attention/running: \(e.bubble ?? "nil")")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "a", status: "waiting"), S(worktree: "b", status: "waiting"), S(worktree: "w", status: "waiting", isWorker: true)]))
        check(e.bubble == "입력 기다림 2", "several waiting → count, worker not counted: \(e.bubble ?? "nil")")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "w", status: "waiting", isWorker: true)]))
        check(e.mood == .idle, "worker-only waiting → idle (worker excluded): \(e.mood.rawValue)")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "w", status: "waiting", isWorker: true), S(worktree: "r", status: "running")], openAttention: 4))
        check(e.mood == .attention && e.bubble == "확인할 것 4" && e.badge == 4, "worker waiting + attention → attention: \(e.bubble ?? "nil")")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "r1", status: "running"), S(worktree: "r2", status: "running", isWorker: true), S(worktree: "d", status: "done")]))
        check(e.mood == .running && e.bubble == "작업 중 2", "running (workers included) → \(e.bubble ?? "nil")")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "d", status: "done"), S(worktree: "i", status: "idle")]))
        check(e.mood == .idle, "done/idle sessions only → idle")
        check(PetMapping.showsDone(from: .needsInput, to: .idle) && PetMapping.showsDone(from: .attention, to: .idle)
              && !PetMapping.showsDone(from: .running, to: .idle) && !PetMapping.showsDone(from: .needsInput, to: .running), "끝 only for needsInput/attention → idle")

        // Bubble model: state change → bubble, quiet hours → none, resolved → 끝, hover → summary.
        let m = PetModel(reduceMotion: true)
        let waiting = ex(PetInput(alive: true, sessions: [S(worktree: "ned-daemon", status: "waiting")]))
        m.update(waiting, persona: .ned, quiet: false)
        check(m.bubbleText == "ned-daemon 입력 기다림", "state change shows bubble: \(m.bubbleText ?? "nil")")
        m.update(.idle, persona: .ned, quiet: false)
        check(m.bubbleText == PetMapping.doneText, "needsInput → idle shows 끝: \(m.bubbleText ?? "nil")")
        m.update(waiting, persona: .ned, quiet: true)
        check(m.bubbleText == nil, "quiet hours: no automatic bubble")
        m.hovering = true
        check(m.visibleLines.map(\.text) == ["ned-daemon 입력 기다림"], "hover shows summary even in quiet hours")
        m.update(.idle, persona: .alfred, quiet: false)
        check(m.persona == .alfred && m.visibleLines.map(\.text) == [PersonaID.alfred.persona.nothingNew], "persona follows; idle hover = persona nothingNew")
        m.hovering = false

        // Placement.
        let main = CGRect(x: 0, y: 80, width: 1440, height: 795)
        let d = PetPlacement.origin(saved: nil, size: PetLayout.panel, screens: [main], main: main)
        let c = PetLayout.characterRect(in: PetLayout.panel).offsetBy(dx: d.x, dy: d.y)
        check(main.contains(c) && main.maxX - c.maxX == PetPlacement.margin && c.minY - main.minY == PetPlacement.margin, "default = bottom-right of visible frame: \(c)")
        let kept = CGPoint(x: 300, y: 400)
        check(PetPlacement.origin(saved: kept, size: PetLayout.panel, screens: [main], main: main) == kept, "on-screen saved origin kept")
        check(PetPlacement.origin(saved: CGPoint(x: 5000, y: 400), size: PetLayout.panel, screens: [main], main: main) == d, "off-screen saved origin → default")
        check(PetPlacement.decode(PetPlacement.encode(CGPoint(x: 12, y: -40))) == CGPoint(x: 12, y: -40) && PetPlacement.decode("junk") == nil, "origin encode/decode")

        // Toggle → panel (own defaults suite; never com.ned.menubar).
        let suite = "com.ned.menubar.pet-selftest"
        UserDefaults().removePersistentDomain(forName: suite)
        let defaults = UserDefaults(suiteName: suite)!
        _ = NSApplication.shared
        let ctl = DesktopPetController(defaults: defaults, model: PetModel(reduceMotion: true))
        ctl.openDashboardAction = {}
        check(!ctl.isEnabled && !ctl.isShowing && ctl.panel == nil, "default off: no panel")
        defaults.set(true, forKey: DesktopPetController.enabledKey)
        check(ctl.isShowing, "toggle on → panel shown")
        if let p = ctl.panel {
            check(p.level == .floating && p.styleMask.contains(.nonactivatingPanel) && !p.canBecomeKey && !p.isOpaque
                  && p.collectionBehavior.isSuperset(of: [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]),
                  "panel: floating, non-activating, never key, transparent, all Spaces + full screen")
            check(NSScreen.screens.contains { $0.visibleFrame.intersects(p.frame) }, "panel on a screen: \(p.frame)")
        }
        ctl.hide()
        check(!ctl.isEnabled && !ctl.isShowing, "우클릭 숨기기 → default off, panel hidden")
        defaults.set(true, forKey: DesktopPetController.enabledKey)
        check(ctl.isShowing, "toggle on again → shown")
        defaults.set(false, forKey: DesktopPetController.enabledKey)
        check(!ctl.isShowing, "toggle off → hidden")
        check(ctl.contextMenu().items.filter { !$0.isSeparatorItem }.map(\.title) == ["대시보드 열기", "숨기기"], "context menu items")
        UserDefaults().removePersistentDomain(forName: suite)

        print("pet-selftest: \(tally.failures == 0 ? "OK" : "\(tally.failures) FAILED")")
        fflush(stdout)
        return tally.failures == 0 ? 0 : 1
    }
}

@MainActor
enum PetSnapshot {
    /// Synthetic states, one per mood (persona ned) — bubble open as on a state change (idle: the hover bubble).
    static let cases: [(PetMood, PetInput)] = {
        typealias S = PetInput.Session
        return [
            (.idle, PetInput(alive: true)),
            (.running, PetInput(alive: true, sessions: [S(worktree: "ned-menubar", status: "running"), S(worktree: "ned-daemon", status: "running")])),
            (.needsInput, PetInput(alive: true, sessions: [S(worktree: "ned-daemon", status: "waiting"), S(worktree: "ned-menubar", status: "running")], openAttention: 2)),
            (.attention, PetInput(alive: true, sessions: [S(worktree: "ned-menubar", status: "running")], openAttention: 3)),
            (.blocked, PetInput(alive: true, sessions: [S(worktree: "ned-menubar", status: "error"), S(worktree: "ned-daemon", status: "waiting")], openAttention: 1)),
            (.offline, PetInput(alive: false)),
        ]
    }()

    static func run(dir: String) -> Int32 {
        _ = NSApplication.shared
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var written = 0, failed = 0
        func render(_ name: String, _ e: PetExpression, persona: PersonaID, bubble: String?, hover: Bool, dark: Bool) {
            let m = PetModel(reduceMotion: true)
            m.pin(e, persona: persona, bubble: bubble, hovering: hover)
            // Backdrop stands in for the desktop so the transparent panel is reviewable.
            let view = PetView(model: m)
                .background(dark ? Color(hex: 0x23262C) : Color(hex: 0xDDE2E8))
                .environment(\.colorScheme, dark ? .dark : .light)
            let r = ImageRenderer(content: view)
            r.scale = 2
            let path = "\(dir)/\(name)-\(dark ? "dark" : "light").png"
            guard let cg = r.cgImage, let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]),
                  FileManager.default.createFile(atPath: path, contents: png) else {
                print("pet-snapshot: FAIL — \(path)"); failed += 1; return
            }
            print("pet-snapshot: \(path) (\(cg.width)×\(cg.height))")
            written += 1
        }
        for dark in [false, true] {
            for (mood, input) in cases {
                let e = PetMapping.expression(input)
                if e.mood != mood { print("pet-snapshot: FAIL — \(mood.rawValue) case maps to \(e.mood.rawValue)"); failed += 1 }
                render("pet-\(mood.rawValue)-ned", e, persona: .ned, bubble: e.bubble, hover: e.bubble == nil, dark: dark)
            }
            // Hover summary (top 3) and the other personas' marks.
            let busy = PetMapping.expression(cases[4].1)
            render("pet-hover-ned", busy, persona: .ned, bubble: nil, hover: true, dark: dark)
            for id in PersonaID.allCases where id != .ned {
                let e = PetMapping.expression(cases[1].1)
                render("pet-running-\(id.rawValue)", e, persona: id, bubble: e.bubble, hover: false, dark: dark)
            }
        }
        print("pet-snapshot: \(written) written, \(failed) failed → \(dir)")
        fflush(stdout)
        return failed == 0 ? 0 : 1
    }
}
