import AppKit
import Combine
import SwiftUI

/// The menu bar item, managed directly with AppKit (replaces SwiftUI `MenuBarExtra`).
///
/// Why: MenuBarExtra's NSStatusItem uses the default autosave name "Item-0". Control Center's own defaults
/// (com.apple.controlcenter) still held `NSStatusItem Visible Item-0`…`Item-9` = false, so on every launch macOS
/// applied that "hidden" record to our Item-0 and then wrote `NSStatusItem VisibleCC Item-0 = 0` into our domain —
/// the icon was gone right after start and StatusItemGuard logged "macOS flagged it hidden — re-inserting" 10 s later.
///
/// Now: one NSStatusItem with a unique `autosaveName` (no collision with Item-N records), `isVisible = true` right
/// after creation, `behavior = []` (no ⌘-drag removal). The item is created once and never re-created — state
/// changes only swap `button.image` / `button.title`. Clicking toggles a transient NSPopover holding MenuContent
/// (same experience as `.menuBarExtraStyle(.window)`).
@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
    static let autosaveName = "com.ned.menubar.status"
    static private(set) var shared: StatusItemController?

    let statusItem: NSStatusItem
    private let store: StateStore
    private let daemon: DaemonManager
    private let popover = NSPopover()
    private var sub: AnyCancellable?
    /// Last rendered (symbol, count, running, persona) — skip identical redraws.
    private var lastKey = ""

    init(store: StateStore) {
        self.store = store
        self.daemon = DaemonManager.shared
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = Self.autosaveName
        statusItem.isVisible = true
        statusItem.behavior = []
        super.init()
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        if let b = statusItem.button {
            b.target = self
            b.action = #selector(toggle(_:))
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
            b.imagePosition = .imageLeading
        }
        render()
        // objectWillChange fires before the new value lands: render on the next main-queue turn.
        sub = store.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.render() } }
        }
        Self.shared = self
        // Diagnostics: judge "is the icon on screen" from the log instead of by eye.
        logVisibility("created")
        for t in [1.0, 5.0, 15.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                MainActor.assumeIsolated { self?.logVisibility(String(format: "+%.0fs", t)) }
            }
        }
    }

    /// One line: isVisible, the button window's frame / visibility / occlusion, bar thickness, screen width.
    /// Warns when the frame is missing/zero-sized or the window is not on screen (occluded = hidden by the system,
    /// e.g. behind the notch or turned off in System Settings > Menu Bar).
    func visibilityLine() -> (line: String, ok: Bool) {
        let w = statusItem.button?.window
        let frame = w?.frame
        let occluded = w.map { !$0.occlusionState.contains(.visible) }
        let screenW = (w?.screen ?? NSScreen.main)?.frame.width
        func f(_ r: NSRect?) -> String {
            guard let r else { return "nil" }
            return String(format: "(%.0f,%.0f %.0f×%.0f)", r.minX, r.minY, r.width, r.height)
        }
        let ok = statusItem.isVisible && frame.map { $0.width > 0 && $0.height > 0 } == true && occluded == false
        let line = "visible=\(statusItem.isVisible) frame=\(f(frame)) window.isVisible=\(w.map { "\($0.isVisible)" } ?? "nil")"
            + " occluded=\(occluded.map { "\($0)" } ?? "nil") thickness=\(String(format: "%.0f", NSStatusBar.system.thickness))"
            + " screenW=\(screenW.map { String(format: "%.0f", $0) } ?? "nil")"
        return (line, ok)
    }

    /// At creation the button window is not laid out yet (0 height, occluded) — no warning for that sample.
    func logVisibility(_ tag: String) {
        let v = visibilityLine()
        let verdict = v.ok ? "" : tag == "created" ? " (layout pending)" : " — WARNING: icon probably not on screen (no/zero frame, hidden or occluded)"
        DaemonManager.shared.note("status item [\(tag)]: \(v.line)\(verdict)")
    }

    /// Same look as the old MenuBarLabel: template symbol, or the symbol + accent count badge composed into one
    /// non-template image; the running-session count as text only when there is no badge.
    func render() {
        let p = store.persona
        let mode: Persona.Mode = !store.state.daemonAlive ? .offline : (store.attentionCount > 0 ? .attention : .idle)
        let n = store.attentionCount
        let running = n == 0 && store.runningCount > 0 ? store.runningCount : 0
        let symbol = p.symbol(mode)
        let key = "\(symbol)|\(n)|\(running)|\(p.id.rawValue)"
        guard key != lastKey, let b = statusItem.button else { return }
        lastKey = key
        b.image = n > 0 ? Self.badged(symbol, count: n, color: p.accentNS) : Self.plain(symbol)
        b.attributedTitle = running > 0
            ? NSAttributedString(string: " \(running)", attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                .foregroundColor: NSColor.secondaryLabelColor,
            ])
            : NSAttributedString(string: "")
        b.toolTip = p.displayName
        b.setAccessibilityLabel(n > 0 ? "\(p.displayName): 확인할 것 \(n)건" : p.displayName)
    }

    /// For `StatusItemSelfTest` (same file): popover state without exposing the popover itself.
    fileprivate var popoverShown: Bool { popover.isShown }
    fileprivate var popoverHasContent: Bool { popover.contentViewController != nil }

    @objc fileprivate func toggle(_ sender: Any?) {
        if popover.isShown { popover.performClose(sender); return }
        guard let b = statusItem.button else { return }
        // Fresh content per open (the status line's relative time starts from now).
        let host = NSHostingController(rootView: MenuContent(store: store, daemon: daemon))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
        b.highlight(true)
    }

    /// A menu row was picked (대시보드 열기 · 설정…): close like a menu does.
    func closePopover() {
        if popover.isShown { popover.performClose(nil) }
    }

    func popoverDidClose(_ notification: Notification) {
        statusItem.button?.highlight(false)
        popover.contentViewController = nil
    }

    // MARK: images

    /// The bare symbol as a template image (follows the menu bar's label color).
    static func plain(_ symbol: String) -> NSImage {
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular)) ?? NSImage()
        img.isTemplate = true
        return img
    }

    /// Symbol in the menu bar's label color + an accent capsule holding the count (text black or
    /// white, whichever reads on the accent). Drawn lazily, so `labelColor` follows the bar's appearance.
    static func badged(_ symbol: String, count n: Int, color: NSColor) -> NSImage {
        let sym = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular)) ?? NSImage()
        let text = n > 99 ? "99+" : "\(n)"
        let rgb = color.usingColorSpace(.sRGB) ?? color
        let lum = 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .bold),
            .foregroundColor: lum > 0.55 ? NSColor.black : NSColor.white,
        ]
        let ts = (text as NSString).size(withAttributes: attrs)
        let badge = NSSize(width: max(14, ceil(ts.width) + 8), height: 14)
        let gap: CGFloat = 3
        let size = NSSize(width: ceil(sym.size.width) + gap + badge.width, height: max(ceil(sym.size.height), badge.height))
        let img = NSImage(size: size, flipped: false) { _ in
            let sr = NSRect(x: 0, y: (size.height - sym.size.height) / 2, width: sym.size.width, height: sym.size.height)
            sym.draw(in: sr)
            NSColor.labelColor.set()
            sr.fill(using: .sourceAtop)
            let br = NSRect(x: sr.maxX + gap, y: (size.height - badge.height) / 2, width: badge.width, height: badge.height)
            color.setFill()
            NSBezierPath(roundedRect: br, xRadius: br.height / 2, yRadius: br.height / 2).fill()
            (text as NSString).draw(at: NSPoint(x: br.midX - ts.width / 2, y: br.midY - ts.height / 2), withAttributes: attrs)
            return true
        }
        img.isTemplate = false
        return img
    }
}

/// Keeps the menu bar item on screen, without re-creating it. Every 10 s: forget any "hidden" flag AppKit wrote into
/// our defaults (the legacy MenuBarExtra `Item-0` keys and our own autosave name's keys) and re-assert
/// `statusItem.isVisible = true` (logged only when it had actually turned false).
@MainActor
final class StatusItemGuard {
    static let shared = StatusItemGuard()
    static let keys: [String] = {
        let names = ["Item-0", StatusItemController.autosaveName]
        return names.flatMap { ["NSStatusItem Visible \($0)", "NSStatusItem VisibleCC \($0)"] }
    }()
    private var timer: Timer?

    static func clearFlags() {
        for k in keys { UserDefaults.standard.removeObject(forKey: k) }
    }

    func start() {
        guard timer == nil else { return }
        Self.clearFlags()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
            Task { @MainActor in StatusItemGuard.shared.check() }
        }
    }

    func check() {
        let d = UserDefaults.standard
        let flagged = Self.keys.filter { d.object(forKey: $0) != nil && !d.bool(forKey: $0) }
        if !flagged.isEmpty { Self.clearFlags() }
        guard let item = StatusItemController.shared?.statusItem else { return }
        if !item.isVisible {
            item.isVisible = true
            DaemonManager.shared.note("status item: isVisible was false (flags: \(flagged.joined(separator: ", "))) — set visible again")
        }
    }
}

/// `--statusitem-selftest`: creates the real StatusItemController (no input), logs autosaveName /
/// isVisible / behavior / button image, re-renders with a changed state and checks the item is the same object,
/// opens and closes the popover once via toggle(), then removes the item and exits. Run the bare binary (`.build/release/Ned`), not the bundle.
@MainActor
enum StatusItemSelfTest {
    static func run() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        var failures = 0
        func check(_ ok: Bool, _ msg: String) { print("statusitem-selftest: \(ok ? "PASS" : "FAIL") — \(msg)"); fflush(stdout); if !ok { failures += 1 } }
        let store = StateStore()
        let c = StatusItemController(store: store)
        let item = c.statusItem
        let id = ObjectIdentifier(item)
        check(item.autosaveName == StatusItemController.autosaveName, "autosaveName = \(item.autosaveName ?? "nil")")
        check(item.isVisible, "isVisible = \(item.isVisible)")
        print("statusitem-selftest: diag at creation — \(c.visibilityLine().line)")
        RunLoop.main.run(until: Date().addingTimeInterval(1))
        let v = c.visibilityLine()
        print("statusitem-selftest: diag +1s — \(v.line) → \(v.ok ? "on screen" : "WARNING: probably not on screen")")
        check(item.behavior == [], "behavior rawValue = \(item.behavior.rawValue) (removalAllowed off, terminationOnRemoval off)")
        check(item.button?.image != nil && item.button?.action != nil, "button image \(item.button?.image.map { "\($0.size)" } ?? "nil"), template=\(item.button?.image?.isTemplate ?? false), action set")
        // State change → image/title swap on the same item.
        store.state.updated_at = Date().timeIntervalSince1970 * 1000   // daemonAlive → idle symbol
        c.render()
        let before = item.button?.image
        store.state.updated_at = 0                                      // stale → offline symbol
        c.render()
        check(ObjectIdentifier(c.statusItem) == id && item.button?.image !== before, "re-render swaps the image on the same NSStatusItem (no re-creation)")
        let host = NSHostingController(rootView: MenuContent(store: store, daemon: .shared))
        let size = host.view.fittingSize
        check(size.width >= MenuView.width && size.height > 50, "popover content (MenuContent) fitting size \(Int(size.width))×\(Int(size.height))")
        // Popover open → close once through toggle() (method calls only, no input): close must reach popoverDidClose,
        // which drops the content controller. The close animates, so spin the run loop until it lands.
        func spin(until done: () -> Bool) {
            let deadline = Date().addingTimeInterval(2)
            while !done() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        }
        print("statusitem-selftest: popover isShown before open = \(c.popoverShown)"); fflush(stdout)
        c.toggle(nil)
        spin { c.popoverShown }
        print("statusitem-selftest: popover isShown after open = \(c.popoverShown)"); fflush(stdout)
        check(c.popoverShown && c.popoverHasContent, "toggle() opens the popover with content")
        c.toggle(nil)
        spin { !c.popoverShown && !c.popoverHasContent }
        print("statusitem-selftest: popover isShown after close = \(c.popoverShown)"); fflush(stdout)
        check(!c.popoverShown && !c.popoverHasContent, "toggle() closes the popover and popoverDidClose drops its content")
        NSStatusBar.system.removeStatusItem(item)
        print("statusitem-selftest: \(failures == 0 ? "ALL PASS" : "\(failures) FAILED")")
        fflush(stdout)
        exit(failures == 0 ? 0 : 1)
    }
}

/// Menu "업데이트 확인": GET /api/update-check?refresh=1 (src/update-check.ts) → a small alert. Ned.app never installs —
/// an update is the Claude Code flow (/plugin update ned → /reload-plugins → /ned:install), offered as [명령 복사].
@MainActor
final class UpdateChecker: ObservableObject {
    static let shared = UpdateChecker()
    @Published private(set) var checking = false

    struct Result: Decodable, Equatable {
        var current: String?
        var latest: String?
        var source: String?
        var update_available: Bool
        var steps: [String]?
        var error: String?
        var note: String?
    }

    /// (pure) Alert text for a result / a request failure. `copy` = the steps to put on the clipboard (nil → no button).
    static func message(_ r: Result?, failure: String?) -> (title: String, info: String, copy: String?) {
        guard let r else { return ("업데이트 확인 실패", failure ?? "데몬이 응답하지 않아요 — 메뉴의 상태 줄을 확인하세요.", nil) }
        guard let latest = r.latest else { return ("업데이트 확인 실패", r.error ?? "최신 버전을 읽지 못했어요.", nil) }
        let from = r.source == "marketplace" ? "\n(마켓플레이스 사본 기준 — gh 로 GitHub 을 읽지 못함)" : ""
        if r.update_available {
            let steps = r.steps ?? []
            return ("\(r.current ?? "?") → \(latest) 업데이트 있음",
                    "Claude Code 에서 차례로 실행하세요:\n" + steps.joined(separator: " → ") + from, steps.isEmpty ? nil : steps.joined(separator: "\n"))
        }
        if r.current == nil { return ("업데이트 확인 실패", r.error ?? "설치된 버전을 읽지 못했어요.", nil) }
        return ("최신 버전 (\(r.current ?? latest))", "설치된 버전이 최신이에요." + from, nil)
    }

    func check() {
        guard !checking else { return }
        checking = true
        Task { @MainActor in
            var result: Result?
            var failure: String?
            do {
                var req = URLRequest(url: AppConfig.baseURL.appendingPathComponent("api/update-check").appending(queryItems: [URLQueryItem(name: "refresh", value: "1")]))
                req.timeoutInterval = 40
                let (data, resp) = try await URLSession.shared.data(for: req)
                if let h = resp as? HTTPURLResponse, h.statusCode == 404 { failure = "이 데몬은 업데이트 확인을 몰라요 (/ned:install 로 업데이트)." }
                else { result = try JSONDecoder().decode(Result.self, from: data) }
            } catch {
                failure = "데몬에 묻지 못했어요: \(error.localizedDescription)"
            }
            checking = false
            let m = Self.message(result, failure: failure)
            DaemonManager.shared.note("update check: \(m.title)\(result?.error.map { " — \($0)" } ?? failure.map { " — \($0)" } ?? "")")
            StatusItemController.shared?.closePopover()
            let a = NSAlert()
            a.messageText = m.title
            a.informativeText = m.info
            if let copy = m.copy {
                a.addButton(withTitle: "명령 복사")
                a.addButton(withTitle: "닫기")
                NSApp.activate(ignoringOtherApps: true)
                if a.runModal() == .alertFirstButtonReturn {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(copy, forType: .string)
                }
            } else {
                a.addButton(withTitle: "확인")
                NSApp.activate(ignoringOtherApps: true)
                a.runModal()
            }
        }
    }
}
