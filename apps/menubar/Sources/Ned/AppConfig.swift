import Foundation

/// Process-wide settings shared by the store, the daemon supervisor and the dashboard window.
/// Env vars win over user defaults so tests can isolate a run without touching the user's setup.
enum AppConfig {
    static let defaults = UserDefaults.standard
    static let env = ProcessInfo.processInfo.environment

    /// `NED_HOME`, else `~/.ned`. The spawned daemon inherits the same env, so both agree.
    static let home: String = env["NED_HOME"] ?? (NSHomeDirectory() + "/.ned")

    /// `NED_PORT` env, else the `nedPort` user default, else 7777.
    /// The spawned daemon gets the same value via `NED_PORT` (read in packages/daemon/src/config.ts).
    static let port: Int = {
        if let s = env["NED_PORT"], let n = Int(s), (1..<65536).contains(n) { return n }
        let d = defaults.integer(forKey: "nedPort")
        return (1..<65536).contains(d) ? d : 7777
    }()

    static var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    static var logsDir: String { home + "/logs" }
    static var daemonLogPath: String { logsDir + "/app-daemon.log" }

    static let repoPathKey = "nedRepoPath"

    /// Where ToolResolver keeps its node/claude cache: the app's defaults, or `NED_TOOL_CACHE_SUITE` (selftests,
    /// so a test run never rewrites the real cache).
    static let toolCacheDefaults: UserDefaults = env["NED_TOOL_CACHE_SUITE"].flatMap { UserDefaults(suiteName: $0) } ?? .standard
}
