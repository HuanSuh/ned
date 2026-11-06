import SwiftUI
import AppKit
import ServiceManagement

struct MenuContent: View {
    @ObservedObject var store: StateStore
    @ObservedObject var daemon: DaemonManager
    @State private var loginItem = LoginItem()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if daemon.isBooting {
                bootLine
            } else {
                daemonLine
            }
            if !store.state.daemonAlive && !daemon.isHealthy && !daemon.isBooting {
                Label("\(store.persona.displayName) 데몬이 꺼져 있어요 — 로그를 확인하세요", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
            if let e = store.lastError {
                Label("state.json 읽기 실패 (이전 상태 표시 중)", systemImage: "doc.badge.ellipsis")
                    .font(.caption2).foregroundStyle(.secondary).help(e)
            }
            // Open items only: 확인 완료 (reviewed_at) ones are hidden here and not in the badge.
            if !store.state.openAttention.isEmpty {
                section("지금 봐야 할 것") {
                    ForEach(store.state.openAttention.prefix(5)) { item in
                        AttentionRow(item: item) { store.dismiss(item.id) }
                    }
                }
            } else {
                // Empty attention: the persona's greeting for this time of day.
                Label(store.persona.greeting(), systemImage: store.persona.symbol(.idle))
                    .font(.caption).foregroundStyle(.secondary)
            }
            section("에이전트 세션 (\(store.state.sessions.count))") {
                if store.state.sessions.isEmpty {
                    Text("활성 세션 없음").font(.caption).foregroundStyle(.secondary)
                }
                // The user's own sessions first, then (dimmed) Orca workers; recency order within each.
                ForEach((store.state.sessions.filter { !$0.is_worker } + store.state.sessions.filter(\.is_worker)).prefix(8)) { s in SessionRow(session: s, live: store.persona.led) }
            }
            Divider()
            settings
            footer
        }
        .padding(12)
        .frame(width: 360)
        .tint(store.persona.accent)
        .onAppear { loginItem.refresh() }
    }

    private var daemonLine: some View {
        HStack(spacing: 6) {
            Circle().fill(daemonColor).frame(width: 7, height: 7)
                .shadow(color: daemon.isHealthy ? store.persona.led.opacity(0.7) : .clear, radius: 2)
            Text(daemon.statusLine).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                .help(daemon.repoPath.map { "저장소: \($0)" } ?? "저장소 미지정")
            Spacer(minLength: 4)
            if case .failed = daemon.status {
                Button { daemon.restart() } label: { Label("다시 시작", systemImage: "arrow.clockwise") }
                    .buttonStyle(.borderedProminent).tint(.red).controlSize(.small).font(.caption.weight(.semibold))
            }
            Button("로그 열기") { daemon.revealLog() }.buttonStyle(.link).font(.caption)
        }
    }

    /// While the daemon is .checking / .starting: the boot screen's step (n/4 + label) with a small spinner.
    private var bootLine: some View {
        HStack(alignment: .center, spacing: 8) {
            ProgressView().controlSize(.small)
            VStack(alignment: .leading, spacing: 1) {
                Text("시작 중 \(daemon.bootStage.rawValue + 1)/\(DaemonManager.BootStage.allCases.count) · \(daemon.bootStage.label)")
                    .font(.caption.weight(.medium))
                Text(daemon.statusLine).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button("로그 열기") { daemon.revealLog() }.buttonStyle(.link).font(.caption)
        }
        .help(daemon.repoPath.map { "저장소: \($0)" } ?? "저장소 미지정")
    }

    private var daemonColor: Color {
        switch daemon.status {
        case .running, .external: return store.persona.led
        case .starting, .checking: return .yellow
        case .failed: return .red
        }
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Toggle("Login Items 에 등록", isOn: Binding(
                    get: { loginItem.enabled },
                    set: { loginItem.set($0) }))
                    .toggleStyle(.checkbox).font(.caption)
                Text("자동 시작: \(loginItem.statusLabel)")
                    .font(.caption2).foregroundStyle(loginItem.status == .enabled ? .primary : .secondary)
                    .help("SMAppService.mainApp.status = \(LoginItem.describe(loginItem.status))")
            }
            if let m = loginItem.message {
                Text(m).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                Button("저장소 위치…") { chooseRepo() }.buttonStyle(.link).font(.caption)
                    .help(daemon.repoPath ?? "")
                personaMenu
            }
        }
    }

    /// 페르소나 submenu (radio). Optimistic: StateStore switches now and reverts if the PUT fails.
    private var personaMenu: some View {
        Menu {
            Picker("페르소나", selection: Binding(
                get: { store.personaID },
                set: { store.setPersona($0) })) {
                ForEach(PersonaID.allCases) { p in Text(p.persona.displayName).tag(p) }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Text("페르소나: \(store.persona.displayName)").font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("메뉴 막대·알림의 이름과 색 — 데몬 설정(PUT /api/config)에 저장")
    }

    private func chooseRepo() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Ned 저장소 (packages/daemon 이 있는 폴더) 를 선택하세요"
        if let r = daemon.repoPath { panel.directoryURL = URL(fileURLWithPath: r) }
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard FileManager.default.fileExists(atPath: url.path + "/packages/daemon/package.json") else {
            let a = NSAlert()
            a.messageText = "Ned 저장소가 아니에요"
            a.informativeText = "\(url.path) 에 packages/daemon 이 없습니다."
            a.runModal()
            return
        }
        daemon.setRepoPath(url.path)
    }

    private var header: some View {
        HStack {
            Text(store.persona.headerTitle).font(.headline).foregroundStyle(store.persona.accent)
            if let b = store.state.last_briefing, b.status != "NED_OK" {
                Text(b.headline ?? "업데이트")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            } else {
                Text(store.persona.nothingNew)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if store.state.quiet { Image(systemName: "moon.zzz").foregroundStyle(.secondary).help("Quiet hours") }
        }
    }

    private var footer: some View {
        HStack {
            Button("지금 점검") { store.triggerHeartbeat() }
            Button("대시보드") { DashboardWindowController.shared.show() }
            Spacer()
            if let t = store.state.last_heartbeat_at {
                Text("마지막 \(relative(t))").font(.caption2).foregroundStyle(.secondary)
            }
            Button("종료") { NSApp.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary).font(.caption)
        }
        .controlSize(.small)
    }

    @ViewBuilder
    private func section<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
            content()
        }
    }
}

struct AttentionRow: View {
    let item: AttentionItem
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).frame(width: 14).foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.callout).lineLimit(2)
                if let d = item.detail, !d.isEmpty {
                    Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            if let u = item.url, let url = URL(string: u) {
                Button { NSWorkspace.shared.open(url) } label: { Image(systemName: "arrow.up.right.square") }.buttonStyle(.plain)
            }
            Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05)))
    }

    private var icon: String {
        switch item.kind {
        case "session": return "terminal"
        case "email": return "envelope"
        case "slack": return "number"
        case "jira": return "checklist"
        case "github": return "arrow.triangle.pull"
        case "sentry": return "exclamationmark.octagon"
        case "calendar": return "calendar"
        default: return "bell"
        }
    }
}

struct SessionRow: View {
    let session: SessionView
    var live: Color = .green

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(session.worktree).font(.callout).fontWeight(.medium)
                    Text(label).font(.caption2).foregroundStyle(.secondary)
                    if session.is_worker {
                        Text("워커").font(.caption2).foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color.secondary.opacity(0.5), lineWidth: 0.5))
                            .help("Orca 하위 워크트리 — 알림·확인할 것에서 제외")
                    }
                    if session.subagents_active > 0 {
                        Text("+\(session.subagents_active)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if let s = session.last_summary ?? session.last_prompt, !s.isEmpty {
                    Text(s).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            Text(relative(session.last_event_ts)).font(.caption2).foregroundStyle(.tertiary)
        }
        .opacity(session.is_worker ? 0.55 : 1)
    }

    private var color: Color {
        switch session.status {
        case "running": return live
        case "waiting": return .orange
        case "error": return .red
        case "done": return .blue
        default: return .gray
        }
    }

    private var label: String {
        switch session.status {
        case "running": return "작업 중"
        case "waiting": return "입력 대기"
        case "error": return "오류"
        case "done": return "완료"
        default: return session.status
        }
    }
}

func relative(_ ms: Double) -> String {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
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
}
