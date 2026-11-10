import SwiftUI
import AppKit

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
        check(e.mood == .idle && e.status == nil && e.badge == nil, "idle: no sessions → idle, no status line, no badge")
        e = ex(PetInput(alive: false, sessions: [S(worktree: "a", status: "error")], openAttention: 3))
        check(e.mood == .offline && e.status?.text == "연결 끊김" && e.badge == nil, "offline beats everything")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "ned-daemon", status: "waiting"), S(worktree: "ned-menubar", status: "error"), S(worktree: "x", status: "running")], openAttention: 2))
        check(e.mood == .blocked && e.status?.text == "ned-menubar 오류", "error beats waiting/attention/running")
        check(e.summary.map(\.text) == ["ned-menubar 오류", "ned-daemon 입력 기다림", "확인할 것 2"], "status lines in priority order: \(e.summary.map(\.text))")
        check(e.badge == 2, "badge = open attention under a higher mood")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "a", status: "waiting"), S(worktree: "b", status: "waiting"), S(worktree: "w", status: "waiting", isWorker: true)]))
        check(e.mood == .needsInput && e.status?.text == "입력 기다림 2", "several waiting → count, worker not counted")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "w", status: "waiting", isWorker: true), S(worktree: "r", status: "running")], openAttention: 4))
        check(e.mood == .attention && e.badge == 4, "worker waiting + attention → attention")
        e = ex(PetInput(alive: true, sessions: [S(worktree: "r1", status: "running"), S(worktree: "r2", status: "running", isWorker: true), S(worktree: "d", status: "done")]))
        check(e.mood == .running && e.status?.text == "작업 중 2", "running (workers included)")
        check(PetMapping.showsDone(from: .needsInput, to: .idle) && !PetMapping.showsDone(from: .running, to: .idle), "끝 only for needsInput/attention → idle")

        // State colours: 쉼·작업 중 = accent, 입력 기다림 = amber, 오류 = red, 연결 끊김 = grey without glow, 확인할 것 = strongest accent glow.
        let ned = PersonaID.ned.persona
        // 쉼 neutral, 작업 중 mint, 확인할 것 accent, 입력 기다림 amber, 오류 red, 연결 끊김 grey — distinct for every persona.
        for id in PersonaID.allCases {
            let p = id.persona
            for dark in [true, false] {
                let t = PetColors.tokens(id, dark: dark)
                let ok = PetColors.edge(.idle, p, dark: dark) == PetColors.neutral(p, dark) && PetColors.edge(.running, p, dark: dark) == Color(hex: t.mint)
                    && PetColors.edge(.attention, p, dark: dark) == p.accent && PetColors.edge(.needsInput, p, dark: dark) == Color(hex: t.amber)
                    && PetColors.edge(.blocked, p, dark: dark) == Color(hex: t.red) && PetColors.edge(.offline, p, dark: dark) == PetColors.offline
                let distinct = Set([t.edge, t.mint, t.amber, t.red]).count == 4 && NSColor(hex: t.mint).usingColorSpace(.sRGB) != p.accentNS.usingColorSpace(.sRGB)
                check(ok && distinct, "\(id.rawValue) \(dark ? "dark" : "light"): edge per mood, running (mint) ≠ attention (accent)")
            }
        }
        check(PetColors.glow(.offline) == 0 && PetColors.glow(.idle) > 0 && PetColors.glow(.idle) < PetColors.glow(.running)
              && PetColors.glow(.running) < PetColors.glow(.needsInput) && PetColors.glow(.needsInput) < PetColors.glow(.attention)
              && PetColors.glow(.attention) < PetColors.glow(.blocked),
              "glow: none only offline, idle soft < running < 입력 기다림 < attention < error (every live state breathes)")
        check(PetColors.glowColor(.idle, ned, dark: true) == PetColors.dim(true) && PetColors.glowColor(.running, ned, dark: true) == PetColors.edge(.running, ned, dark: true),
              "glow colour: idle = --dim light, others = the edge colour")
        check(PetColors.moodSymbol(.needsInput) == "keyboard" && !PetMood.allCases.contains { PetColors.moodSymbol($0).hasPrefix("hand.") }, "입력 기다림 symbol = keyboard (no hand)")
        check(PetColors.messageEdge(PetSnapshot.slack, ned, dark: true).0 == ned.accent, "message bubble edge = accent")
        check(PetCharacter.breath >= 3 && PetCharacter.idleScale <= 1.02, "motion: glow breath ≥ 3 s, idle scale ≤ 2 % (no bounce / shake)")

        // Inbox: seed, seen, kind toggles, quiet, bundling, greeting.
        func item(_ k: String, _ kind: String, _ pk: String?, ts: Double = 0) -> FeedItem { FeedItem(key: k, kind: kind, pet_kind: pk, title: "t-\(k)", ts: ts) }
        let all = PetSettings(enabled: true)
        let day1 = PetSnapshot.morning // 2026-11-11 08:30 local
        let day2 = day1.addingTimeInterval(86_400)
        let greet1 = PetMessage.greeting(ned, at: day1), greet2 = PetMessage.greeting(ned, at: day2)
        var inbox = PetInbox(seen: nil)
        var out = inbox.ingest([item("att:a", "slack", "slack"), item("att:b", "email", "mail")], prefs: all, quiet: false, greeting: nil)
        check(out.isEmpty && inbox.hasSeen("att:a") && inbox.hasSeen("att:b"), "first run: existing items seeded as seen, nothing pops")
        out = inbox.ingest([item("att:c", "email", "mail"), item("att:a", "slack", "slack"), item("att:b", "email", "mail")], prefs: all, quiet: false, greeting: nil)
        check(out.map(\.key) == ["att:c"], "only the new key pops: \(out.map(\.key))")
        out = inbox.ingest([item("att:c", "email", "mail")], prefs: all, quiet: false, greeting: nil)
        check(out.isEmpty, "seen item never pops again")
        var noSlack = all; noSlack.messages["slack"] = false
        out = inbox.ingest([item("thr:x", "thread", "slack"), item("att:d", "jira", "jira")], prefs: noSlack, quiet: false, greeting: nil)
        check(out.map(\.key) == ["att:d"] && inbox.hasSeen("thr:x"), "switched-off kind (slack, incl. threads) pops nothing but becomes seen")
        var noneOn = all; for k in ["greeting", "session", "slack", "mail", "jira", "github", "sentry", "calendar", "briefing"] { noneOn.messages[k] = false }
        out = inbox.ingest([item("att:o", "other", nil)], prefs: noneOn, quiet: false, greeting: nil)
        check(out.map(\.key) == ["att:o"], "kind 'other' (no toggle) always pops")
        out = inbox.ingest([item("att:q", "github", "github")], prefs: all, quiet: true, greeting: greet1)
        check(out.isEmpty && inbox.hasSeen("att:q") && !inbox.hasSeen(greet1.key), "quiet hours: nothing pops (item seen), greeting kept for later")
        out = inbox.ingest([], prefs: all, quiet: false, greeting: greet1)
        check(out.map(\.kind) == ["greeting"] && out.first?.title == ned.greeting(at: day1), "greeting: once, first non-quiet look of the day: \(out.first?.title ?? "nil")")
        out = inbox.ingest([], prefs: all, quiet: false, greeting: greet1)
        check(out.isEmpty, "greeting not twice the same day")
        var noGreet = all; noGreet.messages["greeting"] = false
        out = inbox.ingest([], prefs: noGreet, quiet: false, greeting: greet2)
        check(out.isEmpty, "greeting toggle off → no greeting")
        out = inbox.ingest([], prefs: all, quiet: false, greeting: greet2)
        check(out.map(\.key) == [greet2.key], "next day → greeting again")
        out = inbox.ingest((1...5).map { item("n\($0)", "slack", "slack", ts: Double($0)) }.reversed(), prefs: all, quiet: false, greeting: nil)
        check(out.count == 1 && out[0].kind == "summary" && out[0].title == "새 소식 5", "more than 3 at once → one '새 소식 N': \(out.map(\.title))")
        out = inbox.ingest([item("m3", "email", "mail", ts: 3), item("m2", "jira", "jira", ts: 2), item("m1", "github", "github", ts: 1)], prefs: all, quiet: false, greeting: nil)
        check(out.map(\.key) == ["m1", "m2", "m3"], "3 at once → each, oldest first: \(out.map(\.key))")
        let feedNow = [item("r4", "slack", "slack"), item("r3", "email", "mail"), item("r2", "jira", "jira"), item("r1", "github", "github")]
        check(PetInbox.recent(feedNow, prefs: noSlack).map(\.key) == ["r3", "r2", "r1"], "hover list = newest 3 of switched-on kinds")

        // Model: queue (max 3), status notes, hover list.
        let m = PetModel(reduceMotion: true)
        let msgs = ["q1", "q2"].map { PetMessage(key: $0, kind: "slack", petKind: "slack", title: $0) }
        m.enqueue(msgs)
        check(m.current?.key == "q1" && m.queue.map(\.key) == ["q2"], "queue: first shown, next waits")
        m.advance()
        check(m.current?.key == "q2" && m.queue.isEmpty, "queue: shown in order")
        m.enqueue((3...7).map { PetMessage(key: "q\($0)", kind: "email", petKind: "mail", title: "q\($0)") })
        check(m.queue.count == 1 && m.queue[0].title == "새 소식 5", "queue never holds more than 3: overflow folds into '새 소식 N' (\(m.queue.map(\.title)))")
        m.advance(); m.advance()
        check(m.current == nil, "queue drains → bubble closes")
        let waiting = ex(PetInput(alive: true, sessions: [S(worktree: "ned-daemon", status: "waiting")]))
        m.update(waiting, persona: .ned, quiet: false)
        check(m.current == nil, "state change alone pops no bubble (status = border colour + hover line)")
        m.update(.idle, persona: .ned, quiet: false, sessionOn: true)
        check(m.current?.kind == "done", "needsInput → idle: 끝 (session messages on)")
        m.advance()
        m.update(waiting, persona: .ned, quiet: false); m.update(.idle, persona: .ned, quiet: false, sessionOn: false)
        check(m.current == nil, "session messages off → no 끝")
        m.update(ex(PetInput(alive: false)), persona: .ned, quiet: true)
        check(m.current == nil, "quiet hours: no offline bubble either")
        m.update(.idle, persona: .ned, quiet: false)
        m.update(ex(PetInput(alive: false)), persona: .ned, quiet: false)
        check(m.current?.kind == "offline", "going offline → 연결 끊김 note")
        m.update(.idle, persona: .ned, quiet: false)
        check(m.current == nil, "back online → offline note dropped")
        m.setRecent(PetInbox.recent(feedNow, prefs: all))
        m.update(waiting, persona: .ned, quiet: true)
        m.listOpen = true
        if case .list(let st, let items, let empty) = m.content {
            check(st?.text == "ned-daemon 입력 기다림" && items.map(\.key) == ["r4", "r3", "r2"] && empty == nil, "hover: status line + newest 3 (also in quiet hours)")
        } else { check(false, "hover shows the list") }
        m.setRecent([]); m.update(.idle, persona: .alfred, quiet: false)
        if case .list(nil, [], let empty) = m.content { check(empty == PersonaID.alfred.persona.nothingNew, "idle, no messages: persona nothingNew") } else { check(false, "idle hover list") }
        m.listOpen = false

        // Placement.
        let main = CGRect(x: 0, y: 80, width: 1440, height: 795)
        let d = PetPlacement.origin(saved: nil, size: PetLayout.panel, screens: [main], main: main)
        let c = PetLayout.characterRect(in: PetLayout.panel).offsetBy(dx: d.x, dy: d.y)
        check(main.contains(c) && main.maxX - c.maxX == PetPlacement.margin && c.minY - main.minY == PetPlacement.margin, "default = bottom-right of visible frame: \(c)")
        check(PetPlacement.origin(saved: CGPoint(x: 300, y: 400), size: PetLayout.panel, screens: [main], main: main) == CGPoint(x: 300, y: 400), "on-screen saved origin kept")
        check(PetPlacement.origin(saved: CGPoint(x: 5000, y: 400), size: PetLayout.panel, screens: [main], main: main) == d, "off-screen saved origin → default")

        // Settings path: config.pet arrives in state.json (settings save mirror) and GET /api/feed → controller.
        let stateJSON = #"{"updated_at":1,"sessions":[],"attention":[],"pet":{"enabled":true,"messages":{"slack":false}}}"#
        let st = try? JSONDecoder().decode(NedState.self, from: Data(stateJSON.utf8))
        check(st?.pet?.enabled == true && st?.pet?.messageOn("slack") == false && st?.pet?.messageOn("mail") == true && st?.pet?.messageOn(nil) == true, "state.json pet decodes (missing kind = on, nil kind = on)")
        check((try? JSONDecoder().decode(NedState.self, from: Data(#"{"updated_at":1}"#.utf8)))?.pet == nil, "older state.json without pet → nil (keeps the last value)")
        let feedJSON = ##"{"items":[{"key":"att:s","kind":"slack","pet_kind":"slack","title":"#mobile 멘션","detail":"","url":"https://acme.slack.com/archives/C1/p1","deep":"slack://channel?team=T1&id=C1","ts":5},{"key":"att:o","kind":"other","pet_kind":null,"title":"기타","ts":4},{"bad":1}],"pet":{"enabled":false,"messages":{}},"quiet":false}"##
        let fr = try? JSONDecoder().decode(FeedResponse.self, from: Data(feedJSON.utf8))
        check(fr?.items.map(\.key) == ["att:s", "att:o"] && fr?.items.first?.deep?.hasPrefix("slack://") == true && fr?.items.last?.pet_kind == nil && fr?.pet?.enabled == false,
              "GET /api/feed decodes (bad item dropped, pet_kind / deep kept)")

        // Controller (own defaults suite; never com.ned.menubar).
        let suite = "com.ned.menubar.pet-selftest"
        UserDefaults().removePersistentDomain(forName: suite)
        let defaults = UserDefaults(suiteName: suite)!
        _ = NSApplication.shared
        let ctl = DesktopPetController(defaults: defaults, model: PetModel(reduceMotion: true))
        var opened: [String] = []
        var hides = 0
        ctl.openDashboardAction = { opened.append("dashboard") }
        ctl.openSettingsAction = { opened.append("settings") }
        ctl.hideAction = { hides += 1 }
        ctl.openURLAction = { deep, web in opened.append("deep=\(deep?.scheme ?? "nil") web=\(web?.host ?? "nil")") }
        ctl.now = { day1 }
        check(!ctl.isEnabled && !ctl.isShowing && ctl.panel == nil, "default off: no panel")
        ctl.apply(settings: st?.pet ?? PetSettings())
        check(ctl.isShowing, "config pet.enabled = true → panel shown")
        if let p = ctl.panel {
            check(p.level == .floating && p.styleMask.contains(.nonactivatingPanel) && !p.canBecomeKey && !p.isOpaque
                  && p.collectionBehavior.isSuperset(of: [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]),
                  "panel: floating, non-activating, never key, transparent, all Spaces + full screen")
            check(NSScreen.screens.isEmpty || NSScreen.screens.contains { $0.visibleFrame.intersects(p.frame) }, "panel on a screen: \(p.frame)")
        }
        ctl.ingest([item("att:s", "slack", "slack"), item("att:o", "other", nil)], quiet: false, persona: ned)
        check(ctl.model.current?.kind == "greeting" && ctl.model.queue.isEmpty, "first run while shown: greeting only, existing items seeded")
        check(defaults.stringArray(forKey: DesktopPetController.seenKey)?.contains("att:s") == true, "seen keys saved in the app's defaults")
        ctl.model.advance()
        ctl.ingest([item("att:m", "email", "mail"), item("att:s2", "slack", "slack"), item("att:s", "slack", "slack")], quiet: false, persona: ned)
        check(ctl.model.current?.key == "att:m" && ctl.model.queue.isEmpty, "slack switched off in config → only the mail bubble (\(ctl.model.current?.key ?? "nil"))")
        ctl.model.advance()
        ctl.apply(settings: PetSettings(enabled: false))
        check(!ctl.isShowing, "config pet.enabled = false → hidden")
        ctl.ingest([item("att:h", "jira", "jira")], quiet: false, persona: ned)
        check(ctl.model.current == nil && ctl.inbox.hasSeen("att:h"), "hidden: new items become seen, no bubble")
        ctl.apply(settings: PetSettings(enabled: true))
        ctl.hide()
        check(!ctl.isShowing && !ctl.isEnabled && hides == 1, "우클릭 숨기기 → hidden + pet.enabled=false saved through the daemon")
        check(ctl.contextMenu().items.filter { !$0.isSeparatorItem }.map(\.title) == ["대시보드 열기", "펫 설정…", "숨기기"], "context menu: 대시보드 열기 · 펫 설정… · 숨기기")
        ctl.contextMenu().items.first { $0.title == "펫 설정…" }.map { _ = ($0.target as? NSObject)?.perform($0.action) }
        check(opened.last == "settings", "펫 설정… → dashboard settings")
        ctl.open(PetMessage(key: "1", kind: "slack", petKind: "slack", title: "x", url: "https://acme.slack.com/archives/C1/p1", deep: "slack://channel?team=T1&id=C1"))
        ctl.open(PetMessage(key: "2", kind: "github", petKind: "github", title: "x", url: "https://github.com/a/b/pull/1"))
        ctl.open(PetMessage(key: "3", kind: "briefing", petKind: "briefing", title: "x"))
        ctl.open(PetMessage(key: "4", kind: "email", petKind: "mail", title: "x", url: "javascript:alert(1)"))
        check(Array(opened.suffix(4)) == ["deep=slack web=acme.slack.com", "deep=nil web=github.com", "dashboard", "dashboard"], "message click: deep link (+ web fallback) / web / dashboard: \(opened.suffix(4))")
        ctl.apply(settings: PetSettings(enabled: true))
        defaults.set("5000,400", forKey: DesktopPetController.originKey)
        ctl.resetPosition()
        check(defaults.string(forKey: DesktopPetController.originKey) == nil, "위치 초기화 → saved origin removed")
        let keys = Set(defaults.dictionaryRepresentation().keys).intersection([DesktopPetController.originKey, DesktopPetController.seenKey, "desktopPetEnabled"])
        check(!keys.contains("desktopPetEnabled"), "no desktopPetEnabled user default any more (keys: \(keys.sorted()))")
        ctl.apply(settings: PetSettings(enabled: false))
        UserDefaults().removePersistentDomain(forName: suite)

        // Optional live path against an isolated daemon (NED_PET_SELFTEST_PORT = its port, temp NED_HOME): PUT → GET.
        if let ps = ProcessInfo.processInfo.environment["NED_PET_SELFTEST_PORT"], let port = Int(ps) {
            func wait(_ done: () -> Bool) { let end = Date().addingTimeInterval(5); while !done() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) } }
            for on in [true, false] {
                var put: String?, got: FeedResponse??
                StateStore.putPetEnabled(on, port: port) { put = $0 }
                wait { put != nil }
                StateStore.getFeed(port: port) { got = .some($0) }
                wait { got != nil }
                check(put == "HTTP 200" && got??.pet?.enabled == on, "live daemon :\(port): PUT pet.enabled=\(on) → \(put ?? "timeout"), GET /api/feed pet.enabled=\(String(describing: got??.pet?.enabled))")
            }
        }

        print("pet-selftest: \(tally.failures == 0 ? "OK" : "\(tally.failures) FAILED")")
        fflush(stdout)
        return tally.failures == 0 ? 0 : 1
    }
}

@MainActor
enum PetSnapshot {
    /// Synthetic states, one per mood (persona ned).
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

    static let slack = PetMessage(key: "att:s", kind: "slack", petKind: "slack", title: "#mobile-dev · 김지은: 오늘 배포 전에 확인 부탁해요", detail: "릴리스 노트 초안 올려 뒀어요")
    static let mail = PetMessage(key: "att:m", kind: "email", petKind: "mail", title: "CFO: 11월 정산 자료 요청", detail: "금요일까지 회신 필요")
    static let morning = Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 11, hour: 8, minute: 30)) ?? Date()
    static let recent = [slack, mail, PetMessage(key: "att:g", kind: "github", petKind: "github", title: "PR #42 리뷰 요청 — pet v2", detail: "ned / apps/menubar")]

    static func run(dir: String) -> Int32 {
        _ = NSApplication.shared
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var written = 0, failed = 0
        func render(_ name: String, _ e: PetExpression, persona: PersonaID, message: PetMessage?, list: Bool = false, recent r: [PetMessage] = [], dark: Bool) {
            let m = PetModel(reduceMotion: true)
            m.pin(e, persona: persona, message: message, recent: r, list: list)
            // Backdrop stands in for the desktop so the transparent panel is reviewable.
            let view = PetView(model: m)
                .background(dark ? Color(hex: 0x23262C) : Color(hex: 0xDDE2E8))
                .environment(\.colorScheme, dark ? .dark : .light)
            let rr = ImageRenderer(content: view)
            rr.scale = 2
            let path = "\(dir)/\(name)-\(dark ? "dark" : "light").png"
            guard let cg = rr.cgImage, let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]),
                  FileManager.default.createFile(atPath: path, contents: png) else {
                print("pet-snapshot: FAIL — \(path)"); failed += 1; return
            }
            print("pet-snapshot: \(path) (\(cg.width)×\(cg.height))")
            written += 1
        }
        let ned = PersonaID.ned.persona
        for dark in [false, true] {
            // Each mood with its status line (= the hover bubble's first line).
            for (mood, input) in cases {
                let e = PetMapping.expression(input)
                if e.mood != mood { print("pet-snapshot: FAIL — \(mood.rawValue) case maps to \(e.mood.rawValue)"); failed += 1 }
                render("pet-\(mood.rawValue)-ned", e, persona: .ned, message: nil, list: true, dark: dark)
            }
            let running = PetMapping.expression(cases[1].1)
            render("pet-msg-slack", running, persona: .ned, message: slack, dark: dark)
            render("pet-msg-mail", PetMapping.expression(cases[3].1), persona: .ned, message: mail, dark: dark)
            render("pet-msg-greeting", .idle, persona: .ned, message: .greeting(ned, at: morning), dark: dark)
            render("pet-msg-summary", running, persona: .ned, message: .summary(recent + [slack, mail]), dark: dark)
            render("pet-hover-ned", PetMapping.expression(cases[2].1), persona: .ned, message: nil, list: true, recent: recent, dark: dark)
            for id in PersonaID.allCases where id != .ned {
                for i in [0, 1, 3] { // idle, running, attention — must read as three different states
                    let e = PetMapping.expression(cases[i].1)
                    render("pet-\(e.mood.rawValue)-\(id.rawValue)", e, persona: id, message: nil, list: true, dark: dark)
                }
                render("pet-msg-slack-\(id.rawValue)", running, persona: id, message: slack, dark: dark)
            }
        }
        print("pet-snapshot: \(written) written, \(failed) failed → \(dir)")
        fflush(stdout)
        return failed == 0 ? 0 : 1
    }
}
