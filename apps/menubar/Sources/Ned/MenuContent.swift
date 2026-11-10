import SwiftUI
import AppKit
import ServiceManagement

/// The dropdown: one status line + 대시보드 열기 · 설정… · 업데이트 확인 · 종료. Everything else lives in the dashboard
/// (설정 → 앱 for the app's own settings, via AppSettingsHandler in DashboardWindow.swift).
struct MenuContent: View {
    @ObservedObject var store: StateStore
    @ObservedObject var daemon: DaemonManager
    @ObservedObject private var updates = UpdateChecker.shared

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            MenuView(status: MenuStatus.make(daemon: daemon.status, bootStage: daemon.bootStage, statusLine: daemon.statusLine,
                                              repoPath: daemon.repoPath, lastHeartbeatAt: store.state.last_heartbeat_at,
                                              attention: store.attentionCount, readError: store.lastError, now: ctx.date),
                     persona: store.persona, checkingUpdate: updates.checking,
                     actions: MenuActions(
                        restart: { daemon.restart() },
                        openDashboard: { StatusItemController.shared?.closePopover(); DashboardWindowController.shared.show() },
                        openSettings: { StatusItemController.shared?.closePopover(); DashboardWindowController.shared.show(section: "s-app") },
                        checkUpdate: { UpdateChecker.shared.check() },
                        quit: { NSApp.terminate(nil) }))
        }
    }
}

/// What the status line shows — pure (MenuStatus.make), so `--menu-snapshot` can render every state without a daemon.
struct MenuStatus: Equatable {
    enum Kind: String { case ok, booting, off }
    var kind: Kind
    var message: String
    /// Tooltip: the supervisor line (pid / failure), repo, state.json read error.
    var detail: String
    var attention: Int

    /// Dot colours are the old daemon line's: running/external = persona LED, checking/starting = yellow, failed = red.
    static func make(daemon: DaemonManager.Status, bootStage: DaemonManager.BootStage, statusLine: String, repoPath: String?,
                     lastHeartbeatAt: Double?, attention: Int, readError: String?, now: Date = Date()) -> MenuStatus {
        var tip = [statusLine, repoPath.map { "저장소: \($0)" } ?? "저장소 미지정"]
        if let e = readError { tip.append("state.json 읽기 실패 (이전 상태 표시 중): \(e)") }
        let kind: Kind, msg: String
        switch daemon {
        case .checking, .starting:
            kind = .booting
            msg = "시작 중 \(bootStage.rawValue + 1)/\(DaemonManager.BootStage.allCases.count) · \(bootStage.label)"
        case .failed:
            kind = .off
            msg = "꺼져 있음"
        case .running, .external:
            kind = .ok
            msg = lastHeartbeatAt.map { "마지막 점검 \(ago($0, now: now))" } ?? "아직 점검 전"
        }
        return MenuStatus(kind: kind, message: msg, detail: tip.joined(separator: "\n"), attention: max(0, attention))
    }

    /// "방금" · "N분 전" · "N시간 전" · "N일 전" (ms since 1970). A future time (clock skew) reads as 방금.
    static func ago(_ ms: Double, now: Date) -> String {
        let s = now.timeIntervalSince1970 - ms / 1000
        if s < 60 { return "방금" }
        if s < 3600 { return "\(Int(s / 60))분 전" }
        if s < 86_400 { return "\(Int(s / 3600))시간 전" }
        return "\(Int(s / 86_400))일 전"
    }
}

struct MenuActions {
    var restart: () -> Void = {}
    var openDashboard: () -> Void = {}
    var openSettings: () -> Void = {}
    var checkUpdate: () -> Void = {}
    var quit: () -> Void = {}
}

/// The dropdown's layout, from plain values (MenuContent feeds it live; MenuSnapshot feeds fixed states).
struct MenuView: View {
    static var width: CGFloat { 248 }
    let status: MenuStatus
    let persona: Persona
    var checkingUpdate = false
    var actions = MenuActions()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusLine.padding(.horizontal, 10).padding(.top, 9).padding(.bottom, 8)
            Divider().padding(.horizontal, 6)
            VStack(spacing: 0) {
                MenuRow(title: "대시보드 열기", symbol: "macwindow", action: actions.openDashboard)
                MenuRow(title: "설정…", symbol: "gearshape", action: actions.openSettings)
                MenuRow(title: checkingUpdate ? "업데이트 확인 중…" : "업데이트 확인", symbol: "arrow.down.circle",
                        busy: checkingUpdate, action: actions.checkUpdate)
                Divider().padding(.horizontal, 6).padding(.vertical, 3)
                MenuRow(title: "종료", symbol: "power", action: actions.quit)
            }
            .padding(5)
        }
        .frame(width: Self.width)
        .tint(persona.accent)
    }

    private var dotColor: Color {
        switch status.kind {
        case .ok: return persona.led
        case .booting: return .yellow
        case .off: return .red
        }
    }

    private var statusLine: some View {
        HStack(spacing: 7) {
            Circle().fill(dotColor).frame(width: 8, height: 8)
                .shadow(color: status.kind == .ok ? persona.led.opacity(0.7) : .clear, radius: 2)
            Text(status.message).font(.callout).foregroundStyle(status.kind == .off ? .primary : .secondary).lineLimit(1)
            Spacer(minLength: 4)
            if status.kind == .off {
                Button(action: actions.restart) { Label("다시 시작", systemImage: "arrow.clockwise") }
                    .buttonStyle(.borderedProminent).tint(.red).controlSize(.small).font(.caption.weight(.semibold))
            }
            if status.attention > 0 {
                Text(status.attention > 99 ? "99+" : "\(status.attention)")
                    .font(.caption2.monospacedDigit().weight(.bold))
                    .foregroundStyle(persona.accentIsLight ? Color.black : Color.white)
                    .padding(.horizontal, 5).frame(minWidth: 16, minHeight: 15)
                    .background(Capsule().fill(persona.accent))
                    .help("확인할 것 \(status.attention)건 — 대시보드에서 보기")
                    .accessibilityLabel("확인할 것 \(status.attention)건")
            }
        }
        .help(status.detail)
        .accessibilityElement(children: .combine)
    }
}

/// One menu-like row: icon + title, full width, hover highlight.
struct MenuRow: View {
    let title: String
    let symbol: String
    var busy = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Group {
                    if busy { ProgressView().controlSize(.mini) } else { Image(systemName: symbol) }
                }
                .frame(width: 16).foregroundStyle(.secondary)
                Text(title)
                Spacer()
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 5).fill(hover ? Color.primary.opacity(0.09) : .clear))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .onHover { hover = $0 }
    }
}

/// 설정 → 앱 "저장소 위치 → 변경…": pick the Ned repo folder (must contain packages/daemon) → DaemonManager.setRepoPath.
/// Returns false when cancelled or the folder is not a Ned repo (an alert says so).
@MainActor
enum RepoPicker {
    static func choose() -> Bool {
        let daemon = DaemonManager.shared
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Ned 저장소 (packages/daemon 이 있는 폴더) 를 선택하세요"
        if let r = daemon.repoPath { panel.directoryURL = URL(fileURLWithPath: r) }
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        guard FileManager.default.fileExists(atPath: url.path + "/packages/daemon/package.json") else {
            let a = NSAlert()
            a.messageText = "Ned 저장소가 아니에요"
            a.informativeText = "\(url.path) 에 packages/daemon 이 없습니다."
            a.runModal()
            return false
        }
        daemon.setRepoPath(url.path)
        return true
    }
}

/// `SMAppService.mainApp` wrapper. Registration of an unsigned/dev bundle may need the user's
/// approval in System Settings > General > Login Items; that state is surfaced as a message.
@MainActor
struct LoginItem {
    var enabled = false
    var message: String? = nil
    var status: SMAppService.Status = .notRegistered

    /// '켜짐' only when macOS will actually launch Ned at login; awaiting approval is not on yet.
    var statusLabel: String {
        switch status {
        case .enabled: return "켜짐"
        case .requiresApproval: return "꺼짐 (승인 필요)"
        default: return "꺼짐"
        }
    }

    nonisolated static func describe(_ s: SMAppService.Status) -> String {
        switch s {
        case .notRegistered: return "notRegistered"
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notFound: return "notFound"
        @unknown default: return "unknown(\(s.rawValue))"
        }
    }

    mutating func refresh() {
        let s = SMAppService.mainApp.status
        status = s
        enabled = s == .enabled || s == .requiresApproval
        message = s == .requiresApproval ? "시스템 설정 > 일반 > 로그인 항목에서 Ned 를 허용해야 해요" : message
    }

    mutating func set(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            message = nil
            DaemonManager.shared.note("login item \(on ? "register" : "unregister") ok, status=\(SMAppService.mainApp.status.rawValue)")
        } catch {
            message = "로그인 항목 \(on ? "등록" : "해제") 실패: \(error.localizedDescription)"
            DaemonManager.shared.note("login item \(on ? "register" : "unregister") failed: \(error) status=\(SMAppService.mainApp.status.rawValue)")
        }
        refresh()
        if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
    }

    /// `--login-item-register` / `--login-item-unregister`: the same SMAppService call, no UI / daemon / log file —
    /// one status line on stdout (+ the approval pane when macOS wants the user's OK). 0 = ok, 1 = the call failed.
    nonisolated static func headless(register on: Bool) -> Int32 {
        var code: Int32 = 0
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            print("login-item-\(on ? "register" : "unregister"): failed — \(error.localizedDescription)")
            code = 1
        }
        let s = SMAppService.mainApp.status
        print("login-item-status: \(describe(s)) (rawValue \(s.rawValue)) — 자동 시작: \(s == .enabled ? "켜짐" : s == .requiresApproval ? "꺼짐 (승인 필요)" : "꺼짐")")
        if s == .requiresApproval {
            print("approve: System Settings > General > Login Items & Extensions → Ned")
            SMAppService.openSystemSettingsLoginItems()
        }
        fflush(stdout)
        return code
    }
}

extension Persona {
    /// Black text reads better on this accent (same threshold as the status item's badge).
    var accentIsLight: Bool {
        let c = accentNS.usingColorSpace(.sRGB) ?? accentNS
        return 0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent > 0.55
    }
}

/// `--menu-snapshot <dir>` (headless): MenuView for fixed states → PNG through NSHostingView in an off-screen window
/// (real AppKit controls, unlike ImageRenderer), light and dark. Also checks MenuStatus.make for each state.
@MainActor
enum MenuSnapshot {
    static func run(dir: String) -> Int32 {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var written = 0, failed = 0
        let now = Date()
        let ms = { (secondsAgo: Double) in (now.timeIntervalSince1970 - secondsAgo) * 1000 }
        typealias S = MenuStatus
        let cases: [(name: String, status: S, expect: (S.Kind, String))] = [
            ("ok", S.make(daemon: .running(pid: 4242), bootStage: .dashboard, statusLine: "데몬 실행 중 (pid 4242)", repoPath: "/Users/me/.ned/runtime",
                          lastHeartbeatAt: ms(180), attention: 0, readError: nil, now: now), (.ok, "마지막 점검 3분 전")),
            ("not-yet", S.make(daemon: .external(pid: nil), bootStage: .dashboard, statusLine: "외부 데몬 사용 중 — external", repoPath: nil,
                               lastHeartbeatAt: nil, attention: 0, readError: nil, now: now), (.ok, "아직 점검 전")),
            ("booting", S.make(daemon: .starting(pid: 4242), bootStage: .connect, statusLine: "데몬 시작 중… (pid 4242)", repoPath: "/r",
                               lastHeartbeatAt: ms(600), attention: 0, readError: nil, now: now), (.booting, "시작 중 3/4 · 연결 확인")),
            ("off", S.make(daemon: .failed("node 를 찾지 못함"), bootStage: .tools, statusLine: "데몬 실패: node 를 찾지 못함", repoPath: "/r",
                           lastHeartbeatAt: ms(7200), attention: 0, readError: "dataCorrupted", now: now), (.off, "꺼져 있음")),
            ("attention", S.make(daemon: .running(pid: 4242), bootStage: .dashboard, statusLine: "데몬 실행 중 (pid 4242)", repoPath: "/r",
                                 lastHeartbeatAt: ms(30), attention: 3, readError: nil, now: now), (.ok, "마지막 점검 방금")),
        ]
        for c in cases where (c.status.kind, c.status.message) != c.expect {
            print("menu-snapshot: FAIL — \(c.name) → \(c.status.kind.rawValue) \"\(c.status.message)\", want \(c.expect.0.rawValue) \"\(c.expect.1)\""); failed += 1
        }
        if !cases[3].status.detail.contains("state.json 읽기 실패") { print("menu-snapshot: FAIL — read error not in the tooltip"); failed += 1 }
        if MenuStatus.ago(ms(2 * 86_400 + 5), now: now) != "2일 전" || MenuStatus.ago(ms(-30), now: now) != "방금" {
            print("menu-snapshot: FAIL — ago()"); failed += 1
        }
        for dark in [false, true] {
            for c in cases {
                let view = MenuView(status: c.status, persona: PersonaID.ned.persona, checkingUpdate: false)
                let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
                let size = host.fittingSize
                host.frame = NSRect(origin: .zero, size: size)
                let w = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
                w.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                w.contentView = host
                host.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.05))
                let path = "\(dir)/menu-\(c.name)-\(dark ? "dark" : "light").png"
                // 2× pixels (an off-screen window reports 1× backing).
                guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2),
                                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { print("menu-snapshot: FAIL — \(path)"); failed += 1; continue }
                rep.size = size
                host.cacheDisplay(in: host.bounds, to: rep)
                guard let png = rep.representation(using: .png, properties: [:]), FileManager.default.createFile(atPath: path, contents: png) else {
                    print("menu-snapshot: FAIL — \(path)"); failed += 1; continue
                }
                print("menu-snapshot: \(path) (\(rep.pixelsWide)×\(rep.pixelsHigh))")
                written += 1
            }
        }
        print("menu-snapshot: \(written) written, \(failed) failed → \(dir)")
        fflush(stdout)
        return failed == 0 ? 0 : 1
    }
}
