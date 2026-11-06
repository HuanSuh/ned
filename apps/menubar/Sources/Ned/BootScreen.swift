import AppKit

/// The dashboard window's boot screen (shown until the daemon answers `/api/state`).
///
/// - Persona-themed: the persona's mark (Resources/marks/<id>.svg, inlined below), accent, dark background;
///   a faint spider web behind the mark for Ned only.
/// - One animation for every mark: strokes draw in (pathLength = 1 + stroke-dashoffset), fills fade in,
///   then a soft light band sweeps across the tile. `prefers-reduced-motion`: static mark + step text only.
/// - Progress is pushed from Swift with `window.nedBoot(step, text, elapsedSeconds, failed)`; `nedBootDone()`
///   plays the outro (ready beat → dissolve into the dashboard's --bg) before the dashboard URL is loaded.
/// - A persona greeting (random, not the previous boot's) sits under the name. "다시 시작" posts `restart` to the `ned` handler.
enum BootScreen {
    static let steps = DaemonManager.BootStage.allCases.map(\.label)

    struct Theme {
        var id: PersonaID
        var name: String
        var accent: String
        /// One line from the persona's greeting pool (different from the previous boot's).
        var greeting: String = ""
        /// Shown when the boot completes, right before the outro.
        var ready: String = "준비 완료"
    }

    // MARK: outro — "ready" beat, then the page dissolves into the dashboard's own background colour

    /// `nedBootDone()` timeline (CSS below): 0 s ready beat (all ✓, mark pulse, ready line) → 0.6 s exit
    /// (content lifts + fades, a veil fades to the dashboard's `--bg`) → done at ~1.15 s. The dashboard then paints
    /// on the same colour and its content fades in (DashboardWindowController's reveal script).
    static let readyBeatSeconds: Double = 0.6
    static let outroSeconds: Double = 1.15

    /// The dashboard's `--bg` per persona (packages/daemon/public/css/tokens.css), dark / light.
    static func dashboardBackground(_ id: PersonaID) -> (dark: String, light: String) {
        switch id {
        case .ned: return ("#0f1420", "#f6f2ea")
        case .alfred: return ("#0b0d12", "#f3efe6")
        case .oracle: return ("#050605", "#edf3ee")
        case .jarvis: return ("#08101f", "#eef5fb")
        }
    }

    // MARK: greetings — persona tone (archetypes only, no quotes); time-of-day lines + any-time lines

    struct Copy {
        var morning: [String], day: [String], evening: [String], night: [String], any: [String]
        var ready: String
    }

    static func copy(_ id: PersonaID) -> Copy {
        switch id {
        case .ned: return Copy(
            morning: ["좋은 아침! 밤새 온 거 먼저 훑어볼게요", "일어나셨어요? 저는 벌써 깼어요", "아침부터 레이더 돌려 놨어요"],
            day: ["오후도 힘내요, 뒤는 제가 봐요", "점심은 드셨어요? 그동안 정리해 둘게요", "오후 순찰 나갑니다"],
            evening: ["오늘도 수고 많았어요", "퇴근 전에 한 번만 같이 훑어봐요", "저녁엔 급한 것만 골라 드릴게요"],
            night: ["늦었어요, 망은 제가 볼게요", "밤샘은 저한테 맡겨요", "이 시간엔 진짜 급한 것만 볼게요"],
            any: ["오늘도 같이 가요", "레이더 켜는 중이에요", "놓친 거 없나 볼게요", "준비 운동 끝, 출동해요", "오늘은 뭐부터 볼까요?", "다시 왔어요! 금방 돼요"],
            ready: "다 됐어요, 가요!")
        case .alfred: return Copy(
            morning: ["좋은 아침입니다. 밤사이 소식을 정리해 두었습니다", "아침 준비가 끝났습니다", "오늘 하루도 무탈하시길 바랍니다"],
            day: ["오후 일정을 살펴 두었습니다", "식사는 거르지 않으셨기를 바랍니다", "오후 보고를 준비하겠습니다"],
            evening: ["오늘도 고생 많으셨습니다", "저녁 시간입니다. 무리하지 마십시오", "남은 일은 간단히 추려 드리겠습니다"],
            night: ["늦은 시간입니다. 쉬셔도 됩니다", "밤에는 제가 지키고 있겠습니다", "꼭 필요한 것만 말씀드리겠습니다"],
            any: ["돌아오셨군요. 준비해 두었습니다", "필요하신 것은 이미 정리해 두었습니다", "언제든 분부만 내리십시오", "차 한 잔 곁들이시지요", "모든 것이 제자리에 있습니다"],
            ready: "준비되었습니다")
        case .oracle: return Copy(
            morning: ["오전 교대. 브리핑 준비.", "아침 신호 정리 중.", "일출. 채널 개방."],
            day: ["주간 감시 지속.", "오후 트래픽 확인 중.", "정오 이후 신호 수집."],
            evening: ["야간 전환 준비.", "일몰. 감도 조정.", "주간 로그 정리 중."],
            night: ["야간 감시 중.", "조용한 밤. 귀는 열어 둠.", "심야 채널 유지."],
            any: ["채널 개방.", "신호 수집 개시.", "전 주파수 스캔 중.", "회선 확보. 대기.", "정보망 연결 중.", "감도 양호."],
            ready: "연결 완료.")
        case .jarvis: return Copy(
            morning: ["좋은 아침입니다. 시스템 온라인", "오늘의 데이터를 불러오고 있습니다", "아침 점검을 시작합니다"],
            day: ["오후 업무 모니터링을 재개합니다", "실시간 피드를 동기화합니다", "오후 우선순위를 계산 중입니다"],
            evening: ["저녁 모드로 전환합니다", "오늘의 기록을 정리하고 있습니다", "수고하셨습니다. 마무리를 돕겠습니다"],
            night: ["야간 대기 모드입니다", "저전력 감시로 전환합니다", "늦은 시간입니다. 필요한 것만 표시하겠습니다"],
            any: ["시스템을 깨우는 중입니다", "모든 모듈을 점검하고 있습니다", "다시 뵙게 되어 반갑습니다", "데이터 스트림 동기화 중입니다", "인터페이스를 준비하고 있습니다", "오늘도 함께하겠습니다"],
            ready: "모든 시스템 온라인")
        }
    }

    /// Time-of-day lines + any-time lines for `date`.
    static func greetingPool(_ id: PersonaID, at date: Date = Date()) -> [String] {
        let c = copy(id)
        let tod: [String] = switch Calendar.current.component(.hour, from: date) {
        case 5..<11: c.morning
        case 11..<18: c.day
        case 18..<23: c.evening
        default: c.night
        }
        return tod + c.any
    }

    static let lastGreetingKey = "bootScreen.lastGreeting"

    /// A random greeting that differs from the previous boot's (remembered in `defaults`).
    static func pickGreeting(_ id: PersonaID, at date: Date = Date(), defaults: UserDefaults = .standard) -> String {
        let pool = greetingPool(id, at: date)
        let last = defaults.string(forKey: lastGreetingKey)
        let g = pool.filter { $0 != last }.randomElement() ?? pool.first ?? ""
        defaults.set(g, forKey: lastGreetingKey)
        return g
    }

    static func html(theme t: Theme, step: Int, text: String, elapsed: Double, failed: Bool) -> String {
        let web = t.id == .ned ? "<svg class=\"web\" viewBox=\"-500 -500 1000 1000\" preserveAspectRatio=\"xMidYMid slice\" aria-hidden=\"true\">\(webPaths())</svg>" : ""
        let initial = "nedBoot(\(step), \(jsString(text)), \(String(format: "%.1f", elapsed)), \(failed));"
        let dash = dashboardBackground(t.id)
        return """
        <!doctype html><html lang="ko"><head><meta charset="utf-8"><title>\(t.name)</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          :root { color-scheme: dark; --dash: \(dash.dark); --accent: \(t.accent); --bg: #0d1016; --fg: #e8e6df; --dim: #8a8f98; --faint: #555b66; --red: #ff5d5d; --ok: #7fe0c4; }
          @media (prefers-color-scheme: light) { :root { --dash: \(dash.light); } }
          * { box-sizing: border-box; }
          html, body { height: 100%; margin: 0; }
          body { display: grid; place-items: center; overflow: hidden; font: 13px -apple-system, system-ui, sans-serif; color: var(--fg);
                 background: radial-gradient(60% 50% at 50% 42%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 70%), var(--bg);
                 }
          .veil { position: fixed; inset: 0; z-index: 5; pointer-events: none; background: var(--dash); opacity: 0; transition: opacity .5s ease .05s; }
          body.out .veil { opacity: 1; }
          .web { position: fixed; inset: 0; width: 100%; height: 100%; opacity: 0; animation: webin 2.4s ease-out .2s forwards; pointer-events: none; }
          .web path { fill: none; stroke: #fff; stroke-width: 1.1; vector-effect: non-scaling-stroke; }
          @keyframes webin { from { opacity: 0; transform: scale(1.05); } to { opacity: .07; transform: scale(1); } }
          main { position: relative; display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 24px; text-align: center;
                 transition: opacity .45s ease, transform .55s cubic-bezier(.4,0,.2,1), filter .45s ease; }
          body.out main { opacity: 0; transform: translateY(-10px) scale(.97); filter: blur(3px); }
          body.out .web { animation: webout .45s ease forwards; }
          @keyframes webout { from { opacity: .07; } to { opacity: 0; } }
          .markbox { position: relative; width: 112px; height: 112px; }
          .halo { position: absolute; inset: 0; border-radius: 22%; border: 2px solid var(--accent); opacity: 0; pointer-events: none; }
          body.ready .halo { animation: halo .9s cubic-bezier(.2,.7,.3,1) forwards; }
          @keyframes halo { from { opacity: .85; transform: scale(1); } to { opacity: 0; transform: scale(1.65); } }
          body.ready .markw { animation: beat .55s cubic-bezier(.3,1.4,.5,1) both; }
          body.ready .markw::after { animation: none; opacity: 0; }
          @keyframes beat { 0% { transform: scale(1); } 40% { transform: scale(1.07); } 100% { transform: scale(1); } }
          .markw { position: relative; width: 112px; height: 112px; border-radius: 22%; overflow: hidden;
                   box-shadow: 0 10px 40px -10px color-mix(in srgb, var(--accent) 55%, transparent);
                   animation: pop .5s cubic-bezier(.2,.9,.3,1.2) both; }
          .markw svg { display: block; width: 100%; height: 100%; }
          .markw::after { content: ""; position: absolute; inset: -20%; pointer-events: none;
                          background: linear-gradient(105deg, transparent 38%, rgba(255,255,255,.28) 50%, transparent 62%);
                          transform: translateX(-110%); animation: sweep 2.6s ease-in-out 1.3s infinite; }
          .d { stroke-dasharray: 1 1; stroke-dashoffset: 1; animation: draw .9s cubic-bezier(.6,.1,.3,1) calc(.25s + var(--i, 0) * .14s) forwards; }
          .f { opacity: 0; animation: fade .6s ease calc(.3s + var(--i, 0) * .14s) forwards; transform-box: fill-box; transform-origin: center; }
          @keyframes pop { from { opacity: 0; transform: scale(.82); } to { opacity: 1; transform: scale(1); } }
          @keyframes draw { to { stroke-dashoffset: 0; } }
          @keyframes fade { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: scale(1); } }
          @keyframes sweep { 0% { transform: translateX(-110%); } 45%, 100% { transform: translateX(110%); } }
          h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .02em; color: var(--fg); }
          .greet { margin: -10px 0 2px; min-height: 1.4em; max-width: 440px; font-size: 14px; color: var(--fg); opacity: 0;
                   animation: rise .7s ease .85s forwards; }
          @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: .9; transform: none; } }
          body.ready .st { color: var(--ok); } body.ready .st b { display: none; }
          ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; text-align: left; min-width: 200px; }
          li { display: flex; align-items: center; gap: 9px; color: var(--faint); transition: color .2s; }
          li .ic { width: 14px; height: 14px; flex: none; display: grid; place-items: center; font-size: 11px; line-height: 1; }
          li.todo .ic::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
          li.done { color: var(--dim); } li.done .ic { color: var(--ok); } li.done .ic::before { content: "✓"; }
          li.cur { color: var(--fg); } li.cur .ic::before { content: ""; width: 10px; height: 10px; border-radius: 50%;
                  border: 2px solid var(--accent); border-right-color: transparent; animation: spin .8s linear infinite; }
          li.fail { color: var(--red); } li.fail .ic::before { content: "✕"; color: var(--red); }
          @keyframes spin { to { transform: rotate(360deg); } }
          .st { min-height: 1.4em; max-width: 440px; color: var(--dim); font-size: 12px; }
          .st b { font-weight: 500; font-variant-numeric: tabular-nums; color: var(--faint); margin-left: 6px; }
          body.failed .st { color: var(--red); }
          .help { display: none; flex-direction: column; align-items: center; gap: 10px; color: var(--dim); font-size: 12px; }
          body.failed .help { display: flex; }
          button { font: inherit; font-weight: 600; color: #fff; background: var(--red); border: 0; border-radius: 7px; padding: 6px 14px; cursor: pointer; }
          button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
          @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { animation: none !important; transition: none !important; }
            .d { stroke-dashoffset: 0; } .f { opacity: 1; } .web { opacity: .07; } .markw::after { display: none; } .greet { opacity: .9; }
            li.cur .ic::before { border-right-color: var(--accent); }
          }
        </style></head>
        <body>
        \(web)
        <main>
          <div class="markbox" aria-hidden="true"><div class="halo"></div><div class="markw">\(markSVG(t.id))</div></div>
          <h1>\(t.name)</h1>
          <p class="greet" id="greet"></p>
          <ol id="steps" aria-live="polite"></ol>
          <div class="st" id="st" role="status"></div>
          <div class="help"><span>로그를 확인한 뒤 다시 시작해 보세요 (메뉴 막대 \(t.name) → 다시 시작, ⌘R 새로고침).</span>
            <button type="button" id="restart">다시 시작</button></div>
        </main>
        <div class="veil" aria-hidden="true"></div>
        <script>
          document.getElementById("greet").textContent = \(jsString(t.greeting));
          const READY = \(jsString(t.ready));
          const STEPS = \(jsArray(steps));
          const list = document.getElementById("steps"), st = document.getElementById("st");
          list.innerHTML = STEPS.map((s) => '<li class="todo"><span class="ic"></span><span></span></li>').join("");
          list.querySelectorAll("li > span:last-child").forEach((el, i) => { el.textContent = STEPS[i]; });
          window.nedBoot = function (step, text, elapsed, failed) {
            list.querySelectorAll("li").forEach((li, i) => {
              li.className = i < step ? "done" : i > step ? "todo" : failed ? "fail" : "cur";
            });
            document.body.classList.toggle("failed", !!failed);
            st.textContent = text || "";
            const b = document.createElement("b"); b.textContent = Math.floor(elapsed) + "초"; st.appendChild(b);
            document.body.dataset.step = String(step);
          };
          // Outro (Swift waits BootScreen.outroSeconds): ready beat, then dissolve into the dashboard's --bg.
          window.nedBootDone = function () {
            list.querySelectorAll("li").forEach((li) => { li.className = "done"; });
            st.textContent = READY;
            document.body.classList.add("ready");
            setTimeout(() => document.body.classList.add("out"), \(Int(readyBeatSeconds * 1000)));
          };
          document.getElementById("restart").addEventListener("click", () => {
            try { window.webkit.messageHandlers.ned.postMessage("restart"); } catch (e) { console.warn(e); }
          });
          \(initial)
        </script>
        </body></html>
        """
    }

    // MARK: marks — Resources/marks/<id>.svg, with draw (`d`, pathLength=1) / fade (`f`) classes and stagger `--i`.

    static func markSVG(_ id: PersonaID) -> String {
        switch id {
        case .ned: return """
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
              <rect width="64" height="64" rx="14" fill="#1c2430"/>
              <g fill="none" stroke="#f4f1e8" stroke-width="4.5" stroke-linecap="round">
                <circle class="d" pathLength="1" style="--i:0" cx="20" cy="34" r="10" transform="rotate(-90 20 34)"/>
                <circle class="d" pathLength="1" style="--i:1" cx="44" cy="34" r="10" transform="rotate(-90 44 34)"/>
                <path class="d" pathLength="1" style="--i:2" d="M30 33q2-3.5 4 0"/>
                <path class="d" pathLength="1" style="--i:3" d="M10 31 5 26M54 31l5-5"/>
              </g>
              <path class="f" style="--i:5" d="M14.5 30.5a6.5 6.5 0 0 1 5-4" stroke="#7fe0c4" stroke-width="2.6" stroke-linecap="round" fill="none"/>
              <path class="f" style="--i:6" d="M38.5 30.5a6.5 6.5 0 0 1 5-4" stroke="#7fe0c4" stroke-width="2.6" stroke-linecap="round" fill="none"/>
            </svg>
            """
        case .alfred: return """
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
              <rect width="64" height="64" rx="14" fill="#121214"/>
              <path class="d" pathLength="1" style="--i:0" d="M16 19h32" stroke="#2a2a2e" stroke-width="2" stroke-linecap="round"/>
              <g fill="#d4af37">
                <path class="f" style="--i:1" d="M28.5 30.5 13.5 22.5q-4 9.5 0 19l15-8z"/>
                <path class="f" style="--i:2" d="M35.5 30.5l15-8q4 9.5 0 19l-15-8z"/>
                <rect class="f" style="--i:3" x="27.5" y="27" width="9" height="10" rx="2.5"/>
              </g>
              <g fill="none" stroke="#8a6d1d" stroke-width="1.6" stroke-linecap="round">
                <path class="d" pathLength="1" style="--i:4" d="M17 27.5l7 3.5M17 36.5l7-3.5M47 27.5l-7 3.5M47 36.5l-7-3.5"/>
              </g>
            </svg>
            """
        case .oracle: return """
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
              <rect width="64" height="64" rx="14" fill="#0b0d0c"/>
              <path class="d" pathLength="1" style="--i:0" d="M15 37v-5a17 17 0 0 1 34 0v5" fill="none" stroke="#3ddc84" stroke-width="4.5" stroke-linecap="round"/>
              <rect class="f" style="--i:2" x="10" y="32" width="10" height="15" rx="3.5" fill="#8b5cf6"/>
              <rect class="f" style="--i:3" x="44" y="32" width="10" height="15" rx="3.5" fill="#8b5cf6"/>
              <path class="d" pathLength="1" style="--i:4" d="M16 47q1 7 11 7.5" fill="none" stroke="#3ddc84" stroke-width="3" stroke-linecap="round"/>
              <rect class="f" style="--i:5" x="27" y="51.5" width="7" height="5" rx="2.5" fill="#3ddc84"/>
              <path class="d" pathLength="1" style="--i:6" d="M27 20h10M29.5 15.5h5" stroke="#3ddc84" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>
            </svg>
            """
        case .jarvis: return """
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
              <defs>
                <radialGradient id="glow" cx="32" cy="32" r="22" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="#38bdf8" stop-opacity=".55"/>
                  <stop offset="1" stop-color="#38bdf8" stop-opacity="0"/>
                </radialGradient>
              </defs>
              <rect width="64" height="64" rx="14" fill="#0b1a33"/>
              <circle class="f" style="--i:4" cx="32" cy="32" r="22" fill="url(#glow)"/>
              <circle class="d" pathLength="1" style="--i:0" cx="32" cy="32" r="20" fill="none" stroke="#38bdf8" stroke-width="2" opacity=".45" transform="rotate(-90 32 32)"/>
              <g transform="rotate(-80 32 32)"><circle class="f" style="--i:1" cx="32" cy="32" r="14.5" fill="none" stroke="#38bdf8" stroke-width="4" stroke-dasharray="9.4 3.7"/></g>
              <circle class="f" style="--i:3" cx="32" cy="32" r="7" fill="#e0f6ff"/>
              <circle class="d" pathLength="1" style="--i:2" cx="32" cy="32" r="7" fill="none" stroke="#38bdf8" stroke-width="2"/>
              <g stroke="#f0b429" stroke-width="2.4" stroke-linecap="round">
                <path class="d" pathLength="1" style="--i:5" d="M32 9.5v3M32 51.5v3M9.5 32h3M51.5 32h3"/>
              </g>
            </svg>
            """
        }
    }

    /// Ned's spider web: 12 spokes + sagging rings (quadratic curves pulled toward the centre).
    static func webPaths() -> String {
        let spokes = 12, rings: [Double] = [60, 115, 180, 255, 340, 435, 540, 660]
        func pt(_ r: Double, _ k: Double) -> (Double, Double) {
            let a = (k / Double(spokes)) * 2 * .pi - .pi / 2 + 0.13
            return (r * cos(a), r * sin(a))
        }
        func f(_ v: Double) -> String { String(format: "%.1f", v) }
        var d = ""
        for k in 0..<spokes { let p = pt(760, Double(k)); d += "M0 0L\(f(p.0)) \(f(p.1))" }
        for r in rings {
            let p0 = pt(r, 0); d += "M\(f(p0.0)) \(f(p0.1))"
            for k in 1...spokes {
                let c = pt(r * 0.86, Double(k) - 0.5), p = pt(r, Double(k))
                d += "Q\(f(c.0)) \(f(c.1)) \(f(p.0)) \(f(p.1))"
            }
        }
        return "<path d=\"\(d)\"/>"
    }

    // MARK: JS literals

    static func jsString(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s]), let arr = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(arr.dropFirst().dropLast())   // ["…"] → "…"
    }

    static func jsArray(_ a: [String]) -> String { "[" + a.map(jsString).joined(separator: ",") + "]" }

    /// `nedBoot(...)` call for evaluateJavaScript.
    static func update(step: Int, text: String, elapsed: Double, failed: Bool) -> String {
        "window.nedBoot && nedBoot(\(step), \(jsString(text)), \(String(format: "%.1f", elapsed)), \(failed));"
    }
}

/// `--boot-selftest`: headless, log-only (stdout) check of the start-up path — no scene, no daemon, no ~/.ned.
/// Uses its own defaults suite (never the app's toolCache), so the real cache is untouched.
/// 1. cold resolve = cache miss (full zsh search) and is cached; 2. warm resolve = cache hit, fast;
/// 3. a broken cached node / vanished claude = miss; 4. writes the boot screen HTML per persona (+ failed /
/// mid-boot variants) to $NED_BOOT_HTML_OUT (default: $TMPDIR/ned-boot-selftest) for a headless render check.
enum BootSelfTest {
    static func run() -> Int32 {
        var failures = 0
        func check(_ ok: Bool, _ msg: String) { print("boot-selftest: \(ok ? "PASS" : "FAIL") — \(msg)"); if !ok { failures += 1 } }
        let suite = "com.ned.menubar.boot-selftest"
        guard let d = UserDefaults(suiteName: suite) else { print("boot-selftest: FAIL — no defaults suite"); return 1 }
        d.removePersistentDomain(forName: suite)
        defer { d.removePersistentDomain(forName: suite) }

        let cold = ToolResolver.resolveCached(d)
        check(!cold.hit && cold.result.node != nil, String(format: "cold resolve: hit=%@ node=%@ claude=%@ (%@, %.1fs)", "\(cold.hit)", cold.result.node ?? "nil", cold.result.claude ?? "nil", cold.result.source, cold.seconds))
        check(d.string(forKey: ToolResolver.Cache.nodeKey) == cold.result.node, "cache saved: toolCache.node=\(d.string(forKey: ToolResolver.Cache.nodeKey) ?? "nil") toolCache.version=\(d.string(forKey: ToolResolver.Cache.versionKey) ?? "nil")")

        let warm = ToolResolver.resolveCached(d)
        check(warm.hit && warm.result.node == cold.result.node && warm.result.claude == cold.result.claude && warm.seconds < 3,
              String(format: "warm resolve: hit=%@ (%@, %.2fs) vs cold %.1fs", "\(warm.hit)", warm.result.source, warm.seconds, cold.seconds))
        check(ToolResolver.Cache.matches(cold.result, d), "Cache.matches(full result) after save")

        let goodNode = d.string(forKey: ToolResolver.Cache.nodeKey)
        d.set("/nonexistent/bin/node", forKey: ToolResolver.Cache.nodeKey)
        check(ToolResolver.Cache.load(d) == nil, "missing cached node → miss")
        d.set("/bin/echo", forKey: ToolResolver.Cache.nodeKey)  // runs, but `--version` is not a node version
        check(ToolResolver.Cache.load(d) == nil, "cached path failing `node --version` → miss")
        d.set(goodNode, forKey: ToolResolver.Cache.nodeKey)
        d.set("/nonexistent/bin/claude", forKey: ToolResolver.Cache.claudeKey)
        check(ToolResolver.Cache.load(d) == nil, "vanished cached claude → miss")

        let out = ProcessInfo.processInfo.environment["NED_BOOT_HTML_OUT"] ?? (NSTemporaryDirectory() + "ned-boot-selftest")
        try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        var files: [String] = []
        func write(_ name: String, _ html: String) {
            let p = out + "/" + name
            let ok = (try? html.write(toFile: p, atomically: true, encoding: .utf8)) != nil
            check(ok, "wrote \(p) (\(html.utf8.count) bytes)"); files.append(p)
        }
        for id in PersonaID.allCases {
            let p = id.persona
            write("boot-\(id.rawValue).html", BootScreen.html(theme: .init(id: id, name: p.displayName, accent: p.accentHex,
                                                                          greeting: BootScreen.greetingPool(id).first ?? "", ready: BootScreen.copy(id).ready), step: 0, text: "node·claude 찾는 중…", elapsed: 0.4, failed: false))
        }
        let ned = PersonaID.ned.persona
        write("boot-ned-connect.html", BootScreen.html(theme: .init(id: .ned, name: ned.displayName, accent: ned.accentHex), step: 2, text: "데몬 시작 중… (pid 4242)", elapsed: 3.2, failed: false))
        write("boot-ned-failed.html", BootScreen.html(theme: .init(id: .ned, name: ned.displayName, accent: ned.accentHex), step: 1, text: "데몬 실패: node 를 찾을 수 없음", elapsed: 21.7, failed: true))
        // Greetings: every persona has a pool; a pick never repeats the previous boot's line.
        let now = Date()
        for id in PersonaID.allCases {
            let pool = BootScreen.greetingPool(id, at: now)
            var picks: [String] = []
            for _ in 0..<12 { picks.append(BootScreen.pickGreeting(id, at: now, defaults: d)) }
            let noRepeat = zip(picks, picks.dropFirst()).allSatisfy { $0 != $1 }
            check(pool.count >= 6 && picks.allSatisfy(pool.contains) && noRepeat && Set(picks).count >= 3,
                  "greeting \(id.rawValue): pool \(pool.count), 12 picks → \(Set(picks).count) distinct, no back-to-back repeat: \(picks.prefix(3).joined(separator: " / "))")
        }
        let html = BootScreen.html(theme: .init(id: .alfred, name: "Alfred", accent: "#d4af37", greeting: "a\"<b>", ready: "준비되었습니다"), step: 3, text: "", elapsed: 1, failed: false)
        check(html.contains("--dash: #0b0d12") && html.contains("--dash: #f3efe6") && html.contains(BootScreen.jsString("a\"<b>")),
              "html carries dashboard --bg (dark/light) + greeting as a JS string")
        check(BootScreen.steps == ["도구 찾는 중", "데몬 시작", "연결 확인", "대시보드 로드"], "steps: \(BootScreen.steps.joined(separator: " → "))")
        let esc = BootScreen.jsString("a\"b</script>\n")
        check(!esc.contains("</") && esc.contains("\\\"") && !esc.contains("\n"), "jsString escapes quote / </ / newline: \(esc)")
        print("boot-selftest: \(failures == 0 ? "ALL PASS" : "\(failures) FAILED") — html in \(out)")
        fflush(stdout)
        return failures == 0 ? 0 : 1
    }
}

/// `--boot-transition-selftest [--cold]` (temp NED_HOME + NED_PORT, NED_REPO = a checkout with a built daemon,
/// NED_TOOL_CACHE_SUITE = a throwaway defaults suite): no scene and no menu bar item. Starts the real DaemonManager
/// and the dashboard controller in a window-less web view, and checks that the dashboard load starts within
/// outroSeconds + 1 s of the daemon turning healthy (or of minBootScreenSeconds, when the daemon is faster than that).
/// `--cold` empties the tool cache first (cache-miss start). Exit 0 = PASS. Stops the daemon it spawned.
@MainActor
enum BootTransitionSelfTest {
    final class Box { var healthyAt: Date?; var sub: Any? }

    static func run() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        if CommandLine.arguments.contains("--cold") {
            if let s = AppConfig.env["NED_TOOL_CACHE_SUITE"] { AppConfig.toolCacheDefaults.removePersistentDomain(forName: s) }
            else { print("boot-transition: --cold needs NED_TOOL_CACHE_SUITE (refusing to clear the app's cache)"); exit(2) }
        }
        let d = DaemonManager.shared
        let t0 = Date(), box = Box()
        func out(_ m: String) { print("boot-transition: " + m); fflush(stdout); d.note("boot-transition selftest: " + m) }
        box.sub = d.$status.sink { _ in
            Task { @MainActor in
                if d.isHealthy, box.healthyAt == nil { box.healthyAt = Date(); out(String(format: "daemon healthy at +%.2fs (%@)", Date().timeIntervalSince(t0), d.statusLine)) }
            }
        }
        DashboardWindowController.shared.onDashboardLoad = { reason in
            let now = Date()
            let healthy = box.healthyAt ?? now
            let due = max(healthy, t0.addingTimeInterval(DashboardWindowController.minBootScreenSeconds))
            let lag = now.timeIntervalSince(due)
            let pass = lag <= DashboardWindowController.outroSeconds + 1.0   // outro is intentional; +1 s slack
            out(String(format: "%@ — dashboard load at +%.2fs, %.2fs after healthy, %.2fs after max(healthy, min %.1fs): %@", reason, now.timeIntervalSince(t0), now.timeIntervalSince(healthy), lag, DashboardWindowController.minBootScreenSeconds, pass ? "PASS" : "FAIL"))
            d.stopSync()
            exit(pass ? 0 : 1)
        }
        d.start()
        DashboardWindowController.shared.startHeadless()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 90_000_000_000)
            out("FAIL — no dashboard load within 90 s (\(d.statusLine))")
            d.stopSync()
            exit(1)
        }
        app.run()
        exit(1)
    }
}
