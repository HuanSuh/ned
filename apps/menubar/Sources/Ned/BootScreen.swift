import AppKit

/// The dashboard window's boot screen (shown until the daemon answers `/api/state`).
///
/// - Persona-themed: the persona's mark (Resources/marks/<id>.svg, inlined below), accent, dark background;
///   a faint spider web behind the mark for Ned only.
/// - One animation for every mark: strokes draw in (pathLength = 1 + stroke-dashoffset), fills fade in,
///   then a soft light band sweeps across the tile. `prefers-reduced-motion`: static mark + step text only.
/// - Progress is pushed from Swift with `window.nedBoot(step, text, elapsedSeconds, failed)`; `nedBootDone()`
///   fades the page out right before the dashboard URL is loaded. "다시 시작" posts `restart` to the `ned` handler.
enum BootScreen {
    static let steps = DaemonManager.BootStage.allCases.map(\.label)

    struct Theme {
        var id: PersonaID
        var name: String
        var accent: String
    }

    static func html(theme t: Theme, step: Int, text: String, elapsed: Double, failed: Bool) -> String {
        let web = t.id == .ned ? "<svg class=\"web\" viewBox=\"-500 -500 1000 1000\" preserveAspectRatio=\"xMidYMid slice\" aria-hidden=\"true\">\(webPaths())</svg>" : ""
        let initial = "nedBoot(\(step), \(jsString(text)), \(String(format: "%.1f", elapsed)), \(failed));"
        return """
        <!doctype html><html lang="ko"><head><meta charset="utf-8"><title>\(t.name)</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          :root { color-scheme: dark; --accent: \(t.accent); --bg: #0d1016; --fg: #e8e6df; --dim: #8a8f98; --faint: #555b66; --red: #ff5d5d; --ok: #7fe0c4; }
          * { box-sizing: border-box; }
          html, body { height: 100%; margin: 0; }
          body { display: grid; place-items: center; overflow: hidden; font: 13px -apple-system, system-ui, sans-serif; color: var(--fg);
                 background: radial-gradient(60% 50% at 50% 42%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 70%), var(--bg);
                 transition: opacity .32s ease; }
          body.out { opacity: 0; }
          .web { position: fixed; inset: 0; width: 100%; height: 100%; opacity: 0; animation: webin 2.4s ease-out .2s forwards; pointer-events: none; }
          .web path { fill: none; stroke: #fff; stroke-width: 1.1; vector-effect: non-scaling-stroke; }
          @keyframes webin { from { opacity: 0; transform: scale(1.05); } to { opacity: .07; transform: scale(1); } }
          main { position: relative; display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 24px; text-align: center; }
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
            .d { stroke-dashoffset: 0; } .f { opacity: 1; } .web { opacity: .07; } .markw::after { display: none; }
            li.cur .ic::before { border-right-color: var(--accent); }
          }
        </style></head>
        <body>
        \(web)
        <main>
          <div class="markw" aria-hidden="true">\(markSVG(t.id))</div>
          <h1>\(t.name)</h1>
          <ol id="steps" aria-live="polite"></ol>
          <div class="st" id="st" role="status"></div>
          <div class="help"><span>로그를 확인한 뒤 다시 시작해 보세요 (메뉴 막대 \(t.name) → 다시 시작, ⌘R 새로고침).</span>
            <button type="button" id="restart">다시 시작</button></div>
        </main>
        <script>
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
          window.nedBootDone = function () {
            list.querySelectorAll("li").forEach((li) => { li.className = "done"; });
            document.body.classList.add("out");
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
            write("boot-\(id.rawValue).html", BootScreen.html(theme: .init(id: id, name: p.displayName, accent: p.accentHex), step: 0, text: "node·claude 찾는 중…", elapsed: 0.4, failed: false))
        }
        let ned = PersonaID.ned.persona
        write("boot-ned-connect.html", BootScreen.html(theme: .init(id: .ned, name: ned.displayName, accent: ned.accentHex), step: 2, text: "데몬 시작 중… (pid 4242)", elapsed: 3.2, failed: false))
        write("boot-ned-failed.html", BootScreen.html(theme: .init(id: .ned, name: ned.displayName, accent: ned.accentHex), step: 1, text: "데몬 실패: node 를 찾을 수 없음", elapsed: 21.7, failed: true))
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
/// 1.5 s of the daemon turning healthy (or of minBootScreenSeconds, when the daemon is faster than that).
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
            let pass = lag <= 1.5
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
