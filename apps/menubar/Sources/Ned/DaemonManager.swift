import Foundation
import AppKit
import os

private let dlog = Logger(subsystem: "com.ned.menubar", category: "daemon")

/// Owns the Ned daemon (`node packages/daemon/dist/cli.js run`) for the life of the app.
///
/// - Something healthy already answers `/api/state` (e.g. the old LaunchAgent): adopt it, spawn nothing.
/// - Otherwise spawn it as a child, restart with backoff when it exits (max 5 in 10 min),
///   and SIGTERM → SIGKILL it when the app quits.
/// - App lines and the child's stdout/stderr share `$NED_HOME/logs/app-daemon.log`.
@MainActor
final class DaemonManager: ObservableObject {
    static let shared = DaemonManager()

    enum Status: Equatable {
        case checking
        case starting(pid: Int32)
        case running(pid: Int32)
        case external(pid: Int?)
        case failed(String)
    }

    @Published private(set) var status: Status = .checking
    @Published private(set) var repoPath: String?

    private var process: Process?
    private var logFD: Int32 = -1
    private var stopping = false
    private var exits: [Date] = []
    private var healthTimer: Timer?
    private var externalMisses = 0
    private var pendingRestart: DispatchWorkItem?

    private let maxRestarts = 5
    private let restartWindow: TimeInterval = 600

    var isHealthy: Bool {
        switch status { case .running, .external: return true; default: return false }
    }

    var statusLine: String {
        switch status {
        case .checking: return "데몬 확인 중…"
        case .starting(let pid): return "데몬 시작 중… (pid \(pid))"
        case .running(let pid): return "데몬 실행 중 (pid \(pid))"
        case .external(let pid): return "외부 데몬 사용 중" + (pid.map { " (pid \($0))" } ?? "") + " — external"
        case .failed(let msg): return "데몬 실패: \(msg)"
        }
    }

    // MARK: lifecycle

    func start() {
        openLog()
        note("app launch: NED_HOME=\(AppConfig.home) port=\(AppConfig.port) bundle=\(Bundle.main.bundlePath)")
        Task { await adoptOrSpawn() }
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.tick() }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.checkAfterWake() }
        }
    }

    private var wakeObserver: NSObjectProtocol?
    private var wakeCheck: Task<Void, Never>?

    /// After sleep the child may be alive but wedged (timers/sockets stalled) or dead. Probe for
    /// up to ~10 s (network can lag right after wake); if still unhealthy, restart and log it.
    func checkAfterWake(attempts: Int = 3, interval: TimeInterval = 3) async {
        wakeCheck?.cancel()
        let t = Task { @MainActor [weak self] in
            guard let self else { return }
            self.note("wake: checking daemon health (status: \(self.statusLine))")
            for i in 1...attempts {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled || self.stopping { return }
                if await Self.probe(timeout: 2) != nil {
                    self.note("wake: daemon healthy (probe \(i)/\(attempts))")
                    if case .starting(let pid) = self.status { self.status = .running(pid: pid) }
                    return
                }
            }
            if Task.isCancelled || self.stopping { return }
            if AppConfig.env["NED_NO_DAEMON"] == "1" { self.note("wake: daemon unhealthy, NED_NO_DAEMON=1 — not restarting"); return }
            self.note("wake: daemon unhealthy after \(attempts) probes (~\(Int(Double(attempts) * (interval + 2)))s) — restarting")
            self.pendingRestart?.cancel()
            // A wedged child may not act on SIGTERM; don't let `restart()` block on it.
            // `stopping` + clearing `process` keeps childExited from scheduling a second (backoff) spawn.
            if let p = self.process, p.isRunning {
                let pid = p.processIdentifier
                self.stopping = true
                kill(pid, SIGTERM)
                let deadline = Date().addingTimeInterval(3)
                while p.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
                if p.isRunning { self.note("wake: daemon pid \(pid) ignored SIGTERM — SIGKILL"); kill(pid, SIGKILL); p.waitUntilExit() }
                self.process = nil
                self.stopping = false
            }
            self.restart()
        }
        wakeCheck = t
        await t.value
    }

    /// `--wake-selftest` (use with a throwaway NED_HOME / NED_PORT): wait for the spawned child,
    /// SIGSTOP it to fake a wedged-after-sleep daemon, run the same wake check, and log whether a
    /// new healthy pid came up. Then quit.
    func wakeSelfTest() async {
        func waitRunning(_ secs: Int, not old: Int32? = nil) async -> Int32? {
            for _ in 0..<(secs * 2) {
                if case .running(let pid) = status, pid != old { return pid }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            return nil
        }
        guard let pid = await waitRunning(40) else { note("wake selftest: FAIL — daemon never became healthy (\(statusLine))"); NSApp.terminate(nil); return }
        note("wake selftest: daemon pid \(pid) healthy — SIGSTOP to simulate a wedged daemon")
        kill(pid, SIGSTOP)
        await checkAfterWake(attempts: 2, interval: 2)
        let fresh = await waitRunning(40, not: pid)
        note("wake selftest: \(fresh.map { "PASS — restarted, new pid \($0) healthy (old \(pid))" } ?? "FAIL — no new healthy daemon (\(statusLine))")")
        NSApp.terminate(nil)
    }

    /// Called from applicationWillTerminate: SIGTERM, wait up to 3 s, then SIGKILL.
    func stopSync() {
        stopping = true
        healthTimer?.invalidate()
        pendingRestart?.cancel()
        guard let p = process, p.isRunning else { return }
        let pid = p.processIdentifier
        note("app quit: SIGTERM daemon pid \(pid)")
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning {
            note("daemon pid \(pid) ignored SIGTERM — SIGKILL")
            kill(pid, SIGKILL)
            p.waitUntilExit()
        }
        note("daemon pid \(pid) stopped (status \(p.terminationStatus))")
    }

    /// Menu: '재시작' / after the repo path changes.
    func restart() {
        exits.removeAll()
        if let p = process, p.isRunning {
            stopping = true
            kill(p.processIdentifier, SIGTERM)
            p.waitUntilExit()
            stopping = false
        }
        process = nil
        status = .checking
        Task { await adoptOrSpawn() }
    }

    func setRepoPath(_ path: String) {
        AppConfig.defaults.set(path, forKey: AppConfig.repoPathKey)
        note("repo path set to \(path)")
        if case .external = status { repoPath = Self.resolveRepo(); return }
        restart()
    }

    func openLog() {
        if logFD >= 0 { return }
        try? FileManager.default.createDirectory(atPath: AppConfig.logsDir, withIntermediateDirectories: true)
        logFD = open(AppConfig.daemonLogPath, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    }

    func revealLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: AppConfig.daemonLogPath))
    }

    // MARK: core

    private func adoptOrSpawn() async {
        repoPath = Self.resolveRepo()
        if let pid = await Self.probe(timeout: 2) {
            if process == nil {
                status = .external(pid: pid)
                note("healthy daemon already on :\(AppConfig.port) (pid \(pid.map(String.init) ?? "?")) — adopting, not spawning")
                return
            }
        }
        await spawn()
    }

    private func spawn() async {
        guard !stopping else { return }
        if AppConfig.env["NED_NO_DAEMON"] == "1" {
            fail("NED_NO_DAEMON=1 — 데몬을 띄우지 않음 (fixture 모드)")
            return
        }
        guard let repo = repoPath ?? Self.resolveRepo() else {
            fail("저장소 위치를 찾을 수 없음 — 메뉴의 '저장소 위치…'로 지정")
            return
        }
        repoPath = repo
        let cli = repo + "/packages/daemon/dist/cli.js"
        guard FileManager.default.fileExists(atPath: cli) else {
            fail("\(cli) 없음 — 저장소에서 pnpm -r build 필요")
            return
        }
        let tools = await Task.detached { ToolResolver.resolve() }.value
        note("resolved node=\(tools.node ?? "nil") claude=\(tools.claude ?? "nil") (\(tools.source))")
        guard let node = tools.node else {
            fail("node 를 찾을 수 없음")
            return
        }
        if tools.claude == nil { note("warning: claude not found — briefings will fail until it is on PATH") }

        var env = ProcessInfo.processInfo.environment
        var dirs = [tools.node, tools.claude].compactMap { $0.map { ($0 as NSString).deletingLastPathComponent } }
        dirs += ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        dirs += (env["PATH"] ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        env["PATH"] = dirs.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
        env["NED_PORT"] = String(AppConfig.port)
        env["NED_HOME"] = AppConfig.home
        // The app posts notifications itself (Notifier); the daemon must not add osascript banners.
        env["NED_NOTIFY"] = "app"

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli, "run"]
        p.currentDirectoryURL = URL(fileURLWithPath: repo + "/packages/daemon")
        p.environment = env
        if logFD >= 0 {
            let h = FileHandle(fileDescriptor: logFD, closeOnDealloc: false)
            p.standardOutput = h
            p.standardError = h
        }
        p.standardInput = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus, reason = proc.terminationReason
            Task { @MainActor in self?.childExited(proc, code: code, signaled: reason == .uncaughtSignal) }
        }
        do {
            try p.run()
        } catch {
            fail("spawn 실패: \(error.localizedDescription)")
            return
        }
        process = p
        status = .starting(pid: p.processIdentifier)
        note("spawned daemon pid \(p.processIdentifier): \(node) \(cli) run (PATH=\(env["PATH"] ?? ""), NED_NO_LLM=\(env["NED_NO_LLM"] ?? "unset"), NED_NOTIFY=\(env["NED_NOTIFY"] ?? "unset"))")
    }

    private func childExited(_ proc: Process, code: Int32, signaled: Bool) {
        guard proc === process else { return }
        process = nil
        note("daemon pid \(proc.processIdentifier) exited (\(signaled ? "signal" : "code") \(code))")
        guard !stopping else { return }
        let now = Date()
        exits = exits.filter { now.timeIntervalSince($0) < restartWindow } + [now]
        if exits.count > maxRestarts {
            fail("10분 안에 \(maxRestarts)번 넘게 종료됨 — 로그 확인 후 '다시 시작'")
            return
        }
        let delay = min(pow(2, Double(exits.count - 1)), 30)
        note("restarting in \(Int(delay))s (\(exits.count)/\(maxRestarts) in 10 min)")
        status = .checking
        let w = DispatchWorkItem { [weak self] in Task { @MainActor in await self?.adoptOrSpawn() } }
        pendingRestart = w
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
    }

    private func tick() async {
        switch status {
        case .starting(let pid):
            if await Self.probe(timeout: 2) != nil {
                status = .running(pid: pid)
                note("daemon pid \(pid) healthy on :\(AppConfig.port)")
            }
        case .external:
            if let pid = await Self.probe(timeout: 2) {
                externalMisses = 0
                status = .external(pid: pid)
            } else {
                externalMisses += 1
                if externalMisses >= 3 {
                    externalMisses = 0
                    note("external daemon stopped answering — taking over")
                    status = .checking
                    await spawn()
                }
            }
        default:
            break
        }
    }

    private func fail(_ msg: String) {
        status = .failed(msg)
        note("error: \(msg)")
    }

    func note(_ msg: String) {
        dlog.info("\(msg, privacy: .public)")
        guard logFD >= 0 else { return }
        let line = "[ned.app \(ISO8601DateFormatter().string(from: Date()))] \(msg)\n"
        line.withCString { _ = write(logFD, $0, strlen($0)) }
    }

    // MARK: helpers

    /// `nil` = nothing healthy. Inner optional = healthy, pid if the state reported one.
    nonisolated static func probe(timeout: TimeInterval) async -> Int?? {
        var req = URLRequest(url: AppConfig.baseURL.appendingPathComponent("api/state"))
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return .some(obj?["daemon_pid"] as? Int)
    }

    /// The app bundle's nearest ancestor holding `packages/daemon` (dev builds live in
    /// `apps/menubar/.build`), else the `nedRepoPath` user default.
    static func resolveRepo() -> String? {
        let fm = FileManager.default
        let isRepo = { (p: String) in fm.fileExists(atPath: p + "/packages/daemon/package.json") }
        var url = Bundle.main.bundleURL
        while url.path != "/" {
            url.deleteLastPathComponent()
            if isRepo(url.path) { return url.path }
        }
        if let saved = AppConfig.defaults.string(forKey: AppConfig.repoPathKey), isRepo(saved) { return saved }
        return nil
    }
}

/// Finds `node` and `claude` the way the user's terminal would.
///
/// nvm/fnm usually hook in from `.zshrc`, which only an *interactive* shell reads, so `zsh -lc`
/// alone can return a stale system node (seen: /usr/local/bin/node v16, which crashes hono).
/// Order: `zsh -lic`, `zsh -lc`, then well-known dirs; the first node with major ≥ 18 wins.
enum ToolResolver {
    struct Result: Sendable { var node: String?; var claude: String?; var source: String }
    static let minNodeMajor = 18

    static func resolve() -> Result {
        var nodes: [(String, String)] = [], claudes: [(String, String)] = []
        for (flags, label) in [("-lic", "zsh -lic"), ("-lc", "zsh -lc")] {
            for line in loginShell(flags, "command -v node; command -v claude") {
                if line.hasSuffix("/node") { nodes.append((line, label)) }
                if line.hasSuffix("/claude") { claudes.append((line, label)) }
            }
        }
        for d in fallbackDirs() {
            if isExec(d + "/node") { nodes.append((d + "/node", "fallback dirs")) }
            if isExec(d + "/claude") { claudes.append((d + "/claude", "fallback dirs")) }
        }
        // claude: several installs may coexist (e.g. a stale /usr/local/bin/claude 1.x next to
        // ~/.local/bin/claude 2.x). Pick the highest version, not the first on PATH.
        var bestClaude: (path: String, label: String, version: [Int])? = nil
        var seenClaude = Set<String>()
        for (c, label) in claudes where seenClaude.insert(c).inserted {
            let v = claudeVersion(c)
            if bestClaude == nil || bestClaude!.version.lexicographicallyPrecedes(v) {
                bestClaude = (c, label, v)
            }
        }
        var r = Result(node: nil, claude: bestClaude?.path, source: "")
        var tried: [String] = []
        for (n, label) in nodes where !tried.contains(n) {
            tried.append(n)
            let major = nodeMajor(n)
            if let major, major >= minNodeMajor { r.node = n; r.source = "node via \(label) v\(major)"; break }
        }
        if r.node == nil, let first = nodes.first { r.node = first.0; r.source = "node via \(first.1) (version check failed)" }
        if let b = bestClaude {
            r.source += ", claude via \(b.label) v\(b.version.map(String.init).joined(separator: "."))"
            if seenClaude.count > 1 { r.source += " (of \(seenClaude.count) installs)" }
        } else {
            r.source += ", claude via none"
        }
        if tried.count > 1 { r.source += "; node candidates: " + tried.joined(separator: " ") }
        return r
    }

    static func nodeMajor(_ node: String) -> Int? {
        let out = run(node, ["--version"], timeout: 3).trimmingCharacters(in: .whitespacesAndNewlines)
        return Int(out.dropFirst().split(separator: ".").first ?? "")   // "v22.1.0" → 22
    }

    /// "2.1.319 (Claude Code)" → [2, 1, 319]; [] when it cannot be read.
    static func claudeVersion(_ claude: String) -> [Int] {
        let out = run(claude, ["--version"], timeout: 5)
        let token = out.split(whereSeparator: { $0 == " " || $0 == "\n" }).first ?? ""
        let parts = token.split(separator: ".").compactMap { Int($0) }
        return parts.count >= 2 ? parts : []
    }

    static func fallbackDirs() -> [String] {
        let h = NSHomeDirectory()
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin"]
        let nvm = h + "/.nvm/versions/node"
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: nvm)) ?? [])
            .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        dirs += versions.map { "\(nvm)/\($0)/bin" }
        dirs += [h + "/.local/bin", h + "/.claude/local"]
        return dirs
    }

    private static func isExec(_ p: String) -> Bool { FileManager.default.isExecutableFile(atPath: p) }

    /// Runs `/bin/zsh <flags> <script>`; returns the absolute, executable paths it printed.
    private static func loginShell(_ flags: String, _ script: String) -> [String] {
        run("/bin/zsh", [flags, script], timeout: 8)
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("/") && isExec($0) }
    }

    /// stdout of a short-lived command, "" on failure or timeout.
    private static func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return "" }
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { p.waitUntilExit(); done.signal() }
        if done.wait(timeout: .now() + timeout) == .timedOut { p.terminate(); return "" }
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}
