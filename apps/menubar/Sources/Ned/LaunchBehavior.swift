import AppKit

/// Whether to open the dashboard window at launch. Ned is LSUIElement (no Dock icon, no window), so a plain launch
/// used to show nothing visible — it looked like "Ned didn't start" until a second launch hit
/// applicationShouldHandleReopen. Now a normal launch opens the dashboard (boot screen → dashboard); a launch at
/// login stays in the menu bar unless the user opted in.
///
/// Order: `--dashboard` / `NED_OPEN_DASHBOARD=1` → open; `NED_OPEN_DASHBOARD=0` → no; any `--*-selftest` → no;
/// launched at login → `openDashboardAtLoginLaunch` (default false); otherwise `openDashboardAtLaunch` (default true).
enum LaunchBehavior {
    static let openAtLaunchKey = "openDashboardAtLaunch"
    static let openAtLoginLaunchKey = "openDashboardAtLoginLaunch"
    /// "Launched at login" heuristic window: Dock (re)starts with every login session.
    static let loginWindowSeconds: TimeInterval = 60

    static func registerDefaults(_ d: UserDefaults = .standard) {
        d.register(defaults: [openAtLaunchKey: true, openAtLoginLaunchKey: false])
    }

    /// Set from applicationWillFinishLaunching, while the launch Apple event is current.
    nonisolated(unsafe) static var launchEventSaysLoginItem = false

    /// The `oapp` event carries `keyAEPropData = keyAELaunchedAsLogInItem` when launchd/loginwindow started us
    /// as a login item. Must run while the event is being handled (applicationWillFinishLaunching).
    static func captureLaunchEvent() {
        guard let e = NSAppleEventManager.shared().currentAppleEvent else { return }
        launchEventSaysLoginItem = e.eventID == kAEOpenApplication
            && e.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    /// Seconds since the Dock started (≈ since this login session began), nil if unknown.
    /// The Dock is started by launchd (NSRunningApplication.launchDate is nil for it), so read its process start
    /// time with sysctl(KERN_PROC_PID).
    static func secondsSinceLogin() -> TimeInterval? {
        guard let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return nil }
        if let d = dock.launchDate { return Date().timeIntervalSince(d) }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, dock.processIdentifier]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let tv = info.kp_proc.p_un.__p_starttime
        let start = Double(tv.tv_sec) + Double(tv.tv_usec) / 1_000_000
        return start > 0 ? Date().timeIntervalSince1970 - start : nil
    }

    static func decide(args: [String] = CommandLine.arguments, env: [String: String] = AppConfig.env,
                       defaults d: UserDefaults = .standard) -> (open: Bool, reason: String) {
        if args.contains("--dashboard") || env["NED_OPEN_DASHBOARD"] == "1" { return (true, "--dashboard / NED_OPEN_DASHBOARD=1") }
        if env["NED_OPEN_DASHBOARD"] == "0" { return (false, "NED_OPEN_DASHBOARD=0") }
        if args.contains(where: { $0.hasPrefix("--") && $0.hasSuffix("-selftest") }) { return (false, "selftest run") }
        let since = secondsSinceLogin()
        let sinceText = since.map { String(format: "%.0fs after login", $0) } ?? "login time unknown"
        let atLogin = launchEventSaysLoginItem || (since.map { $0 < loginWindowSeconds } ?? false)
        if atLogin {
            let open = d.bool(forKey: openAtLaunchKey) && d.bool(forKey: openAtLoginLaunchKey)
            return (open, "launched at login (apple event \(launchEventSaysLoginItem ? "lgit" : "-"), \(sinceText)) — \(openAtLaunchKey)=\(d.bool(forKey: openAtLaunchKey)) \(openAtLoginLaunchKey)=\(d.bool(forKey: openAtLoginLaunchKey))")
        }
        let open = d.bool(forKey: openAtLaunchKey)
        return (open, "normal launch (\(sinceText)) — \(openAtLaunchKey)=\(open)")
    }
}
