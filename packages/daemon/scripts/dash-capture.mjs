#!/usr/bin/env node
/* Dashboard regression capture — headless Chrome over raw CDP, no dependencies (Node ≥ 22: global WebSocket).
 *
 *   node scripts/dash-capture.mjs capture --out <dir> [--daemon <packages/daemon dir>] [--port 7790] [--home /tmp/ned-mods]
 *   node scripts/dash-capture.mjs compare <dirA> <dirB> [--out <diffdir>]
 *
 * capture: writes a deterministic fixture into $NED_HOME (wiped first), starts the daemon from `--daemon`
 * (default: this package) with NED_NO_LLM=1 / NED_PORT, opens a fresh headless Chrome profile with the page clock
 * frozen at <today> 10:30 local and reduced motion, then records
 *   shots/<theme>-<width>-<view>.png        every tab, dark + light, 1600 and 390 wide
 *   dom.json   innerHTML hash (whitespace-normalised) + computed-style/geometry hash per view container and header
 *   steps.json the same hashes after each interaction (tab keys, j/k/e, ⌘K search, persona switch, reviewed check,
 *              draft modal, settings PUT, calendar week nav) + console errors / exceptions per step
 * compare: byte- or pixel-compares every shot (pixel diff runs in headless Chrome, diff PNGs into --out) and diffs
 * the hash files; exits 1 on any difference.
 *
 * Never binds 7777 and never touches ~/.ned: everything lives under --home. */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

// ---------------------------------------------------------------- fixture (timestamps relative to T0)
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function t0() { const d = new Date(); d.setHours(10, 30, 0, 0); return d.getTime(); }
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function fixture(T0) {
  const at = (dayOff, h, m = 0) => { const d = new Date(T0); d.setDate(d.getDate() + dayOff); d.setHours(h, m, 0, 0); return d; };
  const iso = (d) => d.toISOString();
  const day = (off) => ymd(at(off, 0));
  const wt = (n) => `/Users/me/orca/workspaces/ned/${n}`;
  const sessions = [
    { id: "s-run", cwd: wt("ned-dash"), worktree: "ned-dash", status: "running", since: T0 - 25 * MIN, last_event_ts: T0 - 2 * MIN, last_prompt: "카드 높이 맞춰 줘", last_summary: null, subagents_active: 2, orca_worktree: null, alert_ts: null },
    { id: "s-wait", cwd: wt("ned-agenda"), worktree: "ned-agenda", status: "waiting", since: T0 - 70 * MIN, last_event_ts: T0 - 9 * MIN, last_prompt: "agenda 재시도 로직", last_summary: "권한 확인이 필요해요: pnpm test 실행", subagents_active: 0, orca_worktree: null, alert_ts: T0 - 9 * MIN },
    { id: "s-err", cwd: wt("ned-slack"), worktree: "ned-slack", status: "error", since: T0 - 3 * HOUR, last_event_ts: T0 - 40 * MIN, last_prompt: "slack watch 채널", last_summary: "API Error: 400 {\"type\":\"error\",\"error\":{\"message\":\"prompt is too long\"}}", subagents_active: 0, orca_worktree: null, alert_ts: T0 - 40 * MIN },
    { id: "s-done", cwd: wt("ned-home"), worktree: "ned-home", status: "done", since: T0 - 5 * HOUR, last_event_ts: T0 - 2 * HOUR, last_prompt: "홈 탭 pill 필터", last_summary: "pill 필터 추가하고 README 갱신했어요.", subagents_active: 0, orca_worktree: null, alert_ts: null },
  ];
  const daily = {
    id: `b-${T0 - 2 * HOUR}`, ts: T0 - 2 * HOUR, type: "daily", status: "UPDATE", headline: "오늘은 리뷰 2건과 결재 1건이 급해요",
    action_items: [
      { title: "결재: 11월 법인카드 사용 내역", kind: "email", url: "https://mail.google.com/mail/u/0/#inbox/18f1a", detail: "오늘 18시 마감" },
      { title: "PR #412 리뷰 요청", kind: "github", url: "https://github.com/acme/ned/pull/412" },
      { title: "MNT-881 마감 지남", kind: "jira", url: "https://acme.atlassian.net/browse/MNT-881" },
    ],
    updates: [{ title: "배포 파이프라인 green", kind: "other" }], fyi: [{ title: "Sentry 신규 이슈 1건", kind: "sentry", url: "https://sentry.io/i/1" }],
    sessions: [{ title: "ned-dash 진행 중", kind: "session" }], cost_usd: 0.42, raw: "{}",
  };
  const hb1 = { id: `b-${T0 - 50 * MIN}`, ts: T0 - 50 * MIN, type: "heartbeat", status: "UPDATE", headline: "Slack DM 2건 답이 필요해요",
    action_items: [{ title: "김민수 DM: 회의록 확인", kind: "slack", url: "https://acme.slack.com/archives/D01ABC/p1730000000000100" }], updates: [], fyi: [], cost_usd: 0.11 };
  const hb2 = { id: `b-${T0 - 20 * MIN}`, ts: T0 - 20 * MIN, type: "heartbeat", status: "NED_OK", action_items: [], updates: [], fyi: [], cost_usd: 0.03 };
  const yday = { id: `b-${T0 - DAY - HOUR}`, ts: T0 - DAY - HOUR, type: "heartbeat", status: "UPDATE", headline: "어제 배포 확인",
    action_items: [], updates: [{ title: "v0.4 배포 완료", kind: "other" }], fyi: [], cost_usd: 0.07 };
  const attention = [
    { id: "a-mail", kind: "email", title: "결재: 11월 법인카드 사용 내역", detail: "오늘 18시 마감", url: "https://mail.google.com/mail/u/0/#inbox/18f1a", ts: T0 - 2 * HOUR, source: daily.id },
    { id: "a-gh", kind: "github", title: "PR #412 리뷰 요청", url: "https://github.com/acme/ned/pull/412", ts: T0 - 2 * HOUR, source: daily.id },
    { id: "a-jira", kind: "jira", title: "MNT-881 마감 지남", url: "https://acme.atlassian.net/browse/MNT-881", ts: T0 - 2 * HOUR, source: daily.id, reviewed_at: T0 - HOUR },
    { id: "a-slack", kind: "slack", title: "김민수 DM: 회의록 확인", url: "https://acme.slack.com/archives/D01ABC/p1730000000000100", ts: T0 - 50 * MIN, source: hb1.id },
    { id: "a-sess", kind: "session", title: "ned-agenda: 권한 확인 필요", detail: "pnpm test 실행", ts: T0 - 9 * MIN, source: "sessions" },
    { id: "a-sentry", kind: "sentry", title: "TypeError in renderAgenda", url: "https://sentry.io/i/1", ts: T0 - 3 * HOUR, source: daily.id },
  ];
  const state = {
    updated_at: T0 - MIN, daemon_pid: 4242, sessions, attention,
    last_briefing: { id: hb2.id, ts: hb2.ts, type: hb2.type, status: hb2.status }, last_heartbeat_at: T0 - 20 * MIN, next_heartbeat_at: T0 + 10 * MIN,
    quiet: false, persona: "ned",
    notifications: { enabled: false, kinds: { session: true, email: true, slack: true, jira: true, github: true, sentry: false, calendar: true }, briefing: true, summary_threshold: 3, quiet_delivery: "skip", sound: false },
    attention_open_count: 5,
  };
  const ev = (ts, event, extra) => ({ ts, event, ...extra });
  const events = [
    ev(T0 - 5 * HOUR, "SessionStart", { session_id: "s-done", cwd: wt("ned-home"), source: "startup" }),
    ev(T0 - 4 * HOUR, "UserPromptSubmit", { session_id: "s-done", cwd: wt("ned-home"), prompt: "홈 탭 pill 필터" }),
    ev(T0 - 3 * HOUR, "SessionStart", { session_id: "s-err", cwd: wt("ned-slack"), source: "startup" }),
    ev(T0 - 2 * HOUR, "Stop", { session_id: "s-done", cwd: wt("ned-home"), message: "pill 필터 추가하고 README 갱신했어요." }),
    ev(T0 - 70 * MIN, "SessionStart", { session_id: "s-wait", cwd: wt("ned-agenda"), source: "startup" }),
    ev(T0 - 40 * MIN, "StopFailure", { session_id: "s-err", cwd: wt("ned-slack"), message: "API Error: 400" }),
    ev(T0 - 25 * MIN, "SessionStart", { session_id: "s-run", cwd: wt("ned-dash"), source: "startup" }),
    ev(T0 - 24 * MIN, "UserPromptSubmit", { session_id: "s-run", cwd: wt("ned-dash"), prompt: "카드 높이 맞춰 줘" }),
    ev(T0 - 20 * MIN, "SubagentStart", { session_id: "s-run", cwd: wt("ned-dash"), agent_id: "x1", agent_type: "explore" }),
    ev(T0 - 9 * MIN, "Notification", { session_id: "s-wait", cwd: wt("ned-agenda"), message: "권한 확인이 필요해요", notification_type: "permission_prompt" }),
  ];
  const cal = (id, title, s, e, x = {}) => ({ id, title, start: iso(s), end: iso(e), all_day: false, location: "", url: `https://calendar.google.com/e/${id}`, meet_url: "", rsvp: "accepted", attendees: 4, ...x });
  const calendar = [
    { id: "c-off", title: "팀원 휴가", start: day(0), end: day(1), all_day: true, location: "", url: "", meet_url: "", rsvp: "accepted", attendees: 0 },
    cal("c-std", "데일리 스탠드업", at(0, 9, 30), at(0, 9, 45), { meet_url: "https://meet.google.com/abc" }),
    cal("c-dr", "디자인 리뷰", at(0, 10, 0), at(0, 11, 0), { location: "3층 회의실" }),
    cal("c-11", "1:1 리드", at(0, 10, 30), at(0, 11, 0), { rsvp: "tentative", attendees: 2 }),
    cal("c-plan", "분기 계획", at(0, 14, 0), at(0, 15, 30), { rsvp: "needsAction", attendees: 12 }),
    cal("c-dec", "외부 미팅", at(0, 16, 0), at(0, 17, 0), { rsvp: "declined" }),
    cal("c-y", "어제 회고", at(-1, 15, 0), at(-1, 16, 0)),
    cal("c-t1", "고객사 데모", at(1, 13, 0), at(1, 14, 0), { rsvp: "organizer" }),
    cal("c-t3", "채용 인터뷰", at(3, 11, 0), at(3, 12, 0)),
    cal("c-t8", "다음 주 스프린트 계획", at(8, 10, 0), at(8, 11, 30)),
  ];
  const agenda = {
    updated_at: T0 - 15 * MIN, cost_usd: 0.87, calendar_range: { from: day(-1), to: day(13) }, calendar,
    // jira "running" with no live run → the daemon reports it as error "interrupted" (⚠ on the Jira card)
    sources_status: Object.fromEntries(["slack", "mail", "calendar", "github"].map((k) => [k, { status: "done", updated_at: T0 - 15 * MIN }]).concat([["jira", { status: "running", updated_at: T0 - 16 * MIN, started_at: T0 - 16 * MIN }]])),
    jira: [
      { key: "MNT-881", title: "정산 배치 실패 알림 누락", status: "In Progress", priority: "High", due: day(-2), url: "https://acme.atlassian.net/browse/MNT-881", updated: iso(at(0, 9)) },
      { key: "NED-12", title: "대시보드 모듈 분리", status: "To Do", priority: "Medium", due: day(0), url: "https://acme.atlassian.net/browse/NED-12", updated: iso(at(-1, 18)) },
      { key: "NED-15", title: "검색 결과 하이라이트", status: "In Review", priority: "Low", due: day(5), url: "https://acme.atlassian.net/browse/NED-15", updated: iso(at(-2, 11)) },
      { key: "OPS-3", title: "로그 보관 정책", status: "In Progress", priority: "Highest", due: null, url: "https://acme.atlassian.net/browse/OPS-3", updated: iso(at(-3, 10)) },
    ],
    github: [
      { repo: "acme/ned", number: 412, title: "agenda: retry once on empty", url: "https://github.com/acme/ned/pull/412", author: "dana", updated: iso(at(0, 8)), reason: "review_requested" },
      { repo: "acme/web", number: 77, title: "fix: login redirect", url: "https://github.com/acme/web/pull/77", author: "me", updated: iso(at(-1, 17)), reason: "my_pr_changes_requested" },
      { repo: "acme/ned", number: 409, title: "persona tokens", url: "https://github.com/acme/ned/pull/409", author: "me", updated: iso(at(-1, 12)), reason: "my_pr_approved" },
    ],
    mail: {
      summary: "결재 1건이 오늘 마감이고, 회신 요청이 2건 있어요.", unread: 14, unread_capped: false,
      items: [
        { id: "18f1a", from: "재무팀", subject: "11월 법인카드 사용 내역 결재", snippet: "오늘 18시까지 결재 부탁드립니다", received: iso(at(0, 8, 10)), url: "https://mail.google.com/mail/u/0/#inbox/18f1a", reason: "approval", why: "오늘 18시 마감" },
        { id: "18f1b", from: "박지훈", subject: "API 스펙 검토 부탁", snippet: "금요일까지 의견 주세요", received: iso(at(0, 7, 45)), url: "https://mail.google.com/mail/u/0/#inbox/18f1b", reason: "reply", why: "금요일까지 회신 요청" },
        { id: "18f1c", from: "HR", subject: "연말 정산 서류 제출", snippet: "11/15 마감", received: iso(at(-1, 16)), url: "https://mail.google.com/mail/u/0/#inbox/18f1c", reason: "deadline", why: "11/15 마감" },
      ],
      all: [
        { id: "18f1a", from: "재무팀", subject: "11월 법인카드 사용 내역 결재", ts: iso(at(0, 8, 10)), url: "https://mail.google.com/mail/u/0/#inbox/18f1a", unread: true },
        { id: "18f1d", from: "GitHub", subject: "[acme/ned] CI passed", ts: iso(at(0, 8)), url: "https://mail.google.com/mail/u/0/#inbox/18f1d", unread: true },
        { id: "18f1b", from: "박지훈", subject: "API 스펙 검토 부탁", ts: iso(at(0, 7, 45)), url: "https://mail.google.com/mail/u/0/#inbox/18f1b", unread: true },
      ],
    },
    slack: {
      summary: "DM 2건과 멘션 1건이 답을 기다려요.",
      items: [
        { channel: "DM", from: "김민수", text: "회의록 확인 부탁해요", url: "https://acme.slack.com/archives/D01ABC/p1730000000000100", ts: iso(at(0, 9, 40)), reason: "dm", count: 3,
          dm: { key: "dm:D01ABC", channel_id: "D01ABC", recent: [
            { from: "김민수", ts: iso(at(-1, 18)), text: "내일 회의 10시로 옮겨도 될까요?" },
            { from: "나", ts: iso(at(-1, 18, 5)), text: "네 괜찮아요" },
            { from: "김민수", ts: iso(at(0, 9, 30)), text: "회의록 올렸어요" },
            { from: "김민수", ts: iso(at(0, 9, 40)), text: "회의록 확인 부탁해요" },
          ] } },
        { channel: "#ned-dev", from: "이서연", text: "@me 배포 일정 괜찮을까요?", url: "https://acme.slack.com/archives/C02DEV/p1730000000000200", ts: iso(at(0, 9, 10)), reason: "mention" },
        { channel: "#ops", from: "최우진", text: "스레드: 로그 보관 기간 정해야 해요", url: "https://acme.slack.com/archives/C03OPS/p1730000000000300?thread_ts=1730000000.000100", ts: iso(at(-1, 19)), reason: "thread" },
      ],
      all: [
        { channel: "DM", from: "김민수", text: "회의록 확인 부탁해요", url: "https://acme.slack.com/archives/D01ABC/p1730000000000100", ts: iso(at(0, 9, 40)), reason: "dm", count: 3, answered: false },
        { channel: "#ned-dev", from: "이서연", text: "@me 배포 일정 괜찮을까요?", url: "https://acme.slack.com/archives/C02DEV/p1730000000000200", ts: iso(at(0, 9, 10)), reason: "mention", answered: false },
        { channel: "#random", from: "정다은", text: "@me 점심 같이?", url: "https://acme.slack.com/archives/C04RND/p1730000000000400", ts: iso(at(0, 8, 30)), reason: "mention", answered: true },
      ],
      watch: [
        { channel: "#release", summary: "v0.5 릴리스는 목요일로 확정.\nQA 담당 정하는 중.", highlights: [
          { from: "이서연", text: "QA 누가 맡을지 정해 주세요", ts: iso(at(0, 9)), url: "https://acme.slack.com/archives/C05REL/p1730000000000500", needs_me: true, reason: "담당 지정 요청" },
          { from: "박지훈", text: "릴리스 목요일 확정", ts: iso(at(-1, 17)), url: "https://acme.slack.com/archives/C05REL/p1730000000000600", needs_me: false, reason: "결정" },
        ], recent: [
          { from: "한예린", text: "체인지로그 초안 공유드려요", ts: iso(at(0, 9, 20)), url: "https://acme.slack.com/archives/C05REL/p1730000000000700" },
          { from: "이서연", text: "QA 누가 맡을지 정해 주세요", ts: iso(at(0, 9)), url: "https://acme.slack.com/archives/C05REL/p1730000000000500" },
        ] },
        { channel: "#infra", summary: "", highlights: [], recent: [
          { from: "오세훈", text: "노드 패치 끝났습니다", ts: iso(at(0, 8, 50)), url: "https://acme.slack.com/archives/C06INF/p1730000000000800" },
          { from: "장하늘", text: "수고하셨어요", ts: iso(at(0, 8, 40)), url: "https://acme.slack.com/archives/C06INF/p1730000000000900" },
        ] },
      ],
    },
  };
  const todos = [
    { id: "t1", title: "주간 보고 작성", done: false, created_at: T0 - DAY, done_at: null, due: day(0), note: null },
    { id: "t2", title: "온보딩 문서 리뷰", done: false, created_at: T0 - 2 * DAY, done_at: null, due: day(-1), note: null },
    { id: "t3", title: "회의실 예약", done: false, created_at: T0 - 3 * HOUR, done_at: null, due: null, note: null },
    { id: "t4", title: "노트북 업데이트", done: true, created_at: T0 - 3 * DAY, done_at: T0 - DAY, due: null, note: null },
  ];
  const config = [
    "heartbeat_minutes: 600", "signal_check_minutes: 600", "briefing_time: \"23:59\"",
    "quiet_hours:", "  start: \"22:00\"", "  end: \"07:00\"", "drafts_pregenerate: false",
    "sources:", "  gmail: true", "  slack: true", "  jira: true", "  sentry: true", "  github: true", "  calendar: true",
    "persona: ned", "claude_model: \"\"", "claude_max_turns: 25", "session_stale_minutes: 100000", "agenda_refresh_minutes: 600",
    "filters:", "  slack:", "    exclude_channels: [random]", "    watch_channels: [release, infra]", "  jira:", "    exclude_projects: [HR]",
    "notifications:", "  enabled: false",
    "",
  ].join("\n");
  return { state, briefings: [daily, hb1, hb2, yday], events, agenda, todos, config };
}

function writeFixture(home, T0, { configOnly = false } = {}) {
  const f = fixture(T0);
  if (configOnly) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, "config.yaml"), f.config); return f; }
  fs.rmSync(home, { recursive: true, force: true });
  for (const d of ["events", "briefings", "logs", "calendar"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), f.config);
  const byDay = {};
  for (const e of f.events) (byDay[ymd(new Date(e.ts))] ||= []).push(JSON.stringify(e));
  for (const [d, lines] of Object.entries(byDay)) fs.writeFileSync(path.join(home, "events", `${d}.jsonl`), lines.join("\n") + "\n");
  return f;
}
/** Data files the daemon's own startup jobs (heartbeat, agenda) overwrite — laid down after they settle. */
function writeData(home, f) {
  const bdir = path.join(home, "briefings");
  for (const x of fs.readdirSync(bdir)) fs.rmSync(path.join(bdir, x), { force: true });
  for (const b of f.briefings) fs.writeFileSync(path.join(bdir, `${b.id}.json`), JSON.stringify(b, null, 2));
  fs.writeFileSync(path.join(home, "agenda.json"), JSON.stringify(f.agenda, null, 2));
  fs.writeFileSync(path.join(home, "todos.json"), JSON.stringify(f.todos, null, 2));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(f.state, null, 2));
  fs.writeFileSync(path.join(home, "costs.json"), JSON.stringify({ days: { [ymd(new Date())]: { total_usd: 3.42, runs: 9, jobs: { agenda: { usd: 2.1, runs: 3 }, heartbeat: { usd: 1.32, runs: 6 } } } } }, null, 2));
  fs.writeFileSync(path.join(home, "reviewed.json"), JSON.stringify({ "a-jira": f.state.attention.find((a) => a.id === "a-jira").reviewed_at, "jira:NED-15": Date.now() }, null, 2));
}

// ---------------------------------------------------------------- daemon
async function startDaemon(daemonDir, home, port) {
  const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
  const logFile = path.join(home, "daemon.out");
  const out = fs.openSync(logFile, "a");
  const child = spawn(tsx, [path.join(daemonDir, "src", "cli.ts"), "run"], {
    cwd: daemonDir, env: { ...process.env, NED_HOME: home, NED_PORT: String(port), NED_NO_LLM: "1", NED_SEND_DRY_RUN: "1" }, stdio: ["ignore", out, out],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    try {
      const s = await (await fetch(`${base}/api/state`)).json();
      if (s.next_heartbeat_at && fs.existsSync(path.join(home, "agenda.json"))) return { child, base };
    } catch { /* not up yet */ }
  }
  child.kill();
  throw new Error(`daemon did not settle — see ${logFile}`);
}

// ---------------------------------------------------------------- CDP
async function launchChrome(profile) {
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(CHROME, [
    "--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions", "--hide-scrollbars", "--force-color-profile=srgb",
    "--font-render-hinting=none", "--disable-gpu", "--mute-audio", "about:blank",
  ], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  return { child, port };
}

async function openPage(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { r, j } = pending.get(msg.id); pending.delete(msg.id); msg.error ? j(new Error(msg.error.message)) : r(msg.result); }
    else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

const FREEZE = (T0) => `(() => {
  const RD = Date, T0 = ${T0};
  class FD extends RD { constructor(...a) { if (a.length === 0) super(T0); else super(...a); } static now() { return T0; } }
  FD.parse = RD.parse; FD.UTC = RD.UTC;
  window.Date = FD;
  // Polling intervals (≥ 10 s: state / agenda+todos / relative-time redraw) run only when the harness calls
  // __nedTick(), so a poll can't land between an action and its snapshot. Short UI tickers stay real.
  const ticks = [], RSI = window.setInterval, RCI = window.clearInterval;
  window.setInterval = (fn, ms, ...a) => (ms >= 10000 ? (ticks.push({ fn, ms, a }), 1e6 + ticks.length - 1) : RSI(fn, ms, ...a));
  window.clearInterval = (id) => (id >= 1e6 ? (ticks[id - 1e6] = null) : RCI(id));
  window.__nedTick = () => { for (const t of ticks) if (t) t.fn(...t.a); return ticks.map((t) => t && t.ms); };
})();`;

/** Per container: whitespace-normalised innerHTML hash + geometry/computed-style fingerprint. */
const SNAP_JS = `(() => {
  const PROPS = ["display","position","color","background-color","font-family","font-size","font-weight","line-height","padding","margin","border-top","border-bottom","border-left","border-right","border-radius","box-shadow","opacity","visibility","grid-template-columns","flex","gap","overflow","text-align","white-space","z-index","transform","filter","background-image","outline"];
  // The daemon rewrites state.json with its real clock + pid after write actions (dismiss / review / config PUT):
  // mask the one tooltip that prints them.
  const norm = (h) => h.replace(/\\s+/g, " ").replace(/> </g, "><").replace(/title="갱신 [^"]*"/g, 'title="갱신 <masked>"').trim();
  const out = {};
  const sel = { header: "header.hq", home: "#v-home", inbox: "#v-inbox", timeline: "#v-timeline", settings: "#v-settings", toast: "#toast", errpop: "#errpop", modal: "#draft-modal", search: "#nsp" };
  for (const [k, s] of Object.entries(sel)) {
    const el = document.querySelector(s);
    if (!el) { out[k] = null; continue; }
    const html = norm(el.outerHTML);
    const parts = [];
    for (const e of [el, ...el.querySelectorAll("*")]) {
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      parts.push(e.tagName + "|" + [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(",") + "|" + PROPS.map((p) => cs.getPropertyValue(p)).join(";"));
    }
    out[k] = { html, style: parts.join("\\n") };
  }
  out.meta = { persona: document.documentElement.dataset.persona, mood: document.body.dataset.mood, hash: location.hash, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), ls: Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])) };
  return JSON.stringify(out);
})()`;
const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

async function capture(o) {
  const out = path.resolve(o.out), home = o.home || "/tmp/ned-mods", port = Number(o.port || 7790);
  if (port === 7777 || home.startsWith(path.join(os.homedir(), ".ned"))) throw new Error("refusing: 7777 / ~/.ned are off limits");
  const daemonDir = path.resolve(o.daemon || path.join(here, ".."));
  const T0 = t0();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "shots"), { recursive: true });
  fs.mkdirSync(path.join(out, "raw"), { recursive: true });
  const f = writeFixture(home, T0);
  const { child: daemon, base } = await startDaemon(daemonDir, home, port);
  writeData(home, f);
  const chrome = await launchChrome(path.join(os.tmpdir(), `ned-mods-chrome-${port}`));
  const log = [];
  try {
    const page = await openPage(chrome.port);
    const errors = [];
    page.on((m) => {
      if (m.method === "Runtime.exceptionThrown") errors.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
      if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "assert")) errors.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/fonts\.g/.test(m.params.entry.url || "")) errors.push(`log: ${m.params.entry.text} ${m.params.entry.url || ""}`);
    });
    for (const d of ["Page", "Runtime", "Log", "Network"]) await page.send(`${d}.enable`);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: FREEZE(T0) });
    // Google Fonts arrive at network speed and re-flow the page mid-capture (calendar PPH, card packing): run
    // offline, as the README's fallback (system serif / mono) — identical for both sides of a comparison.
    await page.send("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    // Clear all page data each load so every shot starts from the same localStorage.
    const evalJs = async (expr) => { const r = await page.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    // Before every capture: transitions / finite animations jump to their end, infinite ones (spinners, pulses that
    // ignore reduced motion) are pinned to t=0.
    const settle = async (ms = 600) => { await sleep(ms); await evalJs("document.fonts.ready.then(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { a.pause(); a.currentTime = 0; } } return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })"); };
    const media = (theme) => page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
    const size = (w) => page.send("Emulation.setDeviceMetricsOverride", { width: w, height: w > 500 ? 1000 : 844, deviceScaleFactor: 1, mobile: false });
    const load = async (hash = "#home") => {
      await page.send("Storage.clearDataForOrigin", { origin: base, storageTypes: "local_storage,session_storage" });
      await page.send("Page.navigate", { url: `${base}/${hash}` });
      await sleep(400);
      await evalJs("new Promise((r) => document.readyState === 'complete' ? r() : addEventListener('load', r, { once: true }))");
      await settle(1500);
    };
    const snap = async () => JSON.parse(await evalJs(SNAP_JS));
    const dom = {};
    await size(1600); await load("#home"); // warm-up: first paint of a fresh profile can differ by a few px
    for (const theme of ["dark", "light"]) {
      await media(theme);
      for (const w of [1600, 390]) {
        await size(w);
        await load("#home");
        await settle(800);
        for (const v of ["home", "inbox", "timeline", "settings"]) {
          await evalJs(`location.hash = "#${v}"`);
          await settle(500);
          const shot = await page.send("Page.captureScreenshot", { format: "png" });
          const name = `${theme}-${w}-${v}`;
          fs.writeFileSync(path.join(out, "shots", `${name}.png`), Buffer.from(shot.data, "base64"));
          const s = await snap();
          dom[name] = { html: h(s[v].html), style: h(s[v].style), header: h(s.header.html), headerStyle: h(s.header.style) };
          fs.writeFileSync(path.join(out, "raw", `${name}.html`), s[v].html);
          fs.writeFileSync(path.join(out, "raw", `${name}.style.txt`), s[v].style);
          log.push(`${name} ok`);
        }
      }
    }
    fs.writeFileSync(path.join(out, "dom.json"), JSON.stringify(dom, null, 2));

    // ---------------------------------------------------------------- interactions (1600 dark)
    await media("dark");
    await size(1600);
    errors.length = 0;
    await load("#home");
    const steps = [];
    const key = async (k, { meta = false, code } = {}) => {
      const base = { key: k, code: code || (k.length === 1 ? `Key${k.toUpperCase()}` : k), modifiers: meta ? 4 : 0, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39 }[k] || 0 };
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k.length === 1 && !meta ? { text: k } : {}) });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    };
    const click = (sel) => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return "missing: " + ${JSON.stringify(sel)}; e.click(); return "ok"; })()`);
    const step = async (name, fn, { shot = false, wait = 700, until = "" } = {}) => {
      errors.length = 0;
      const res = await fn();
      // Async steps (draft stub, config PUT, calendar range) wait for their visible end state, not a fixed time.
      for (let i = 0; until && i < 150 && !(await evalJs(until)); i++) await sleep(100);
      await settle(wait);
      const s = await snap();
      const rec = { name, res: res ?? null, meta: s.meta, errors: [...errors], hashes: {} };
      for (const k of ["header", "home", "inbox", "timeline", "settings", "toast", "errpop", "modal", "search"]) rec.hashes[k] = s[k] ? { html: h(s[k].html), style: h(s[k].style) } : null;
      for (const k of ["header", "home", "inbox", "settings", "modal", "search"]) if (s[k]) {
        const p = path.join(out, "raw", `step-${String(steps.length).padStart(2, "0")}-${k}`);
        fs.writeFileSync(`${p}.html`, s[k].html);
        fs.writeFileSync(`${p}.style.txt`, s[k].style);
      }
      if (shot) fs.writeFileSync(path.join(out, "shots", `step-${String(steps.length).padStart(2, "0")}-${name}.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      steps.push(rec);
      log.push(`step ${name}: ${JSON.stringify(res)} errors=${errors.length}`);
    };
    const SAVED = "!!document.getElementById('c-msg').textContent && !document.getElementById('c-save').disabled";
    await step("load", async () => "ok");
    await step("key-i", () => key("i"));
    await step("key-j", () => key("j"));
    await step("key-j2", () => key("j"));
    await step("key-k", () => key("k"), { shot: true });
    await step("key-2", () => key("2"));
    await step("key-3", () => key("3"));
    await step("key-1", () => key("1"));
    await step("key-e", () => key("e"), { wait: 1200 });
    await step("cmdk-open", () => key("k", { meta: true }), { wait: 900 });
    await step("cmdk-type", () => evalJs(`(() => { const i = document.getElementById("nsp-q"); i.value = "MNT"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`), { wait: 1200, shot: true });
    await step("cmdk-esc-clear", () => key("Escape")); // 1st Esc clears the query, 2nd closes
    await step("cmdk-esc-close", () => key("Escape"));
    await step("key-h", () => key("h"));
    await step("cal-week", () => click('#cal-card [data-cv="week"]'), { shot: true });
    await step("cal-next", () => click('#cal-card [data-cn="1"]'), { wait: 800, until: "!document.querySelector('#agenda .calload')" });
    await step("cal-prev", () => click('#cal-card [data-cn="-1"]'), { wait: 800, until: "!document.querySelector('#agenda .calload')" });
    await step("cal-day", () => click('#cal-card [data-cv="day"]'));
    await step("review-check", () => click("#g-ned .ib-check"), { wait: 1200 });
    await step("review-src-check", () => click("#sgrid .ib-check"), { wait: 1200 });
    await step("card-toggle", () => click('#sgrid [data-card="jira"]'));
    await step("draft-open", () => click("#sgrid .ib-draft"), { wait: 800, shot: true, until: "document.querySelectorAll('#dm-tabs [role=tab]').length > 0 && document.body.dataset.mood !== 'scanning'" });
    await step("draft-tab2", () => click("#dm-tabs [role=tab]:nth-child(2), #dm-tabs button:nth-child(2)"));
    await step("draft-close", () => key("Escape"));
    await step("settings", () => evalJs(`location.hash = "#settings"`));
    await step("settings-save", () => evalJs(`(() => { document.getElementById("cfg").requestSubmit(); return "ok"; })()`), { wait: 800, shot: true, until: SAVED });
    await step("timeline", () => evalJs(`location.hash = "#timeline"`));
    await step("poll-tick", () => evalJs("__nedTick()"), { wait: 1200 });
    await step("home-after-poll", () => evalJs(`location.hash = "#home"`), { shot: true });
    // 홈 카드 배치 + 전체 뷰 (items ∪ all)
    await step("slack-all", () => click('#sc-slack [data-vm="slack"][data-mode="all"]'), { shot: true });
    await step("mail-all", () => click('#sc-mail [data-vm="mail"][data-mode="all"]'), { shot: true });
    await step("settings-cards", () => evalJs(`(() => { location.hash = "#settings"; setTimeout(() => document.getElementById("c-cards").scrollIntoView({ block: "center" }), 50); return "ok"; })()`), { shot: true });
    await step("cards-move-github-up", () => click('#c-cards [data-cl="github"] [data-clmove="-1"]'));
    await step("cards-span-slack-1", () => click('#c-cards [data-cl="slack"] [data-clspan="1"]'), { shot: true });
    await step("cards-save", () => evalJs(`(() => { document.getElementById("cfg").requestSubmit(); return "ok"; })()`), { wait: 800, until: SAVED });
    await step("cards-home", () => evalJs(`location.hash = "#home"`), { shot: true });
    await step("cards-config", () => evalJs(`fetch("/api/config").then((r) => r.json()).then((c) => JSON.stringify(c.dashboard))`));
    // Live-run states (a source running, phase 2 progress / budget stop) exist only while the daemon works: a page-side
    // fetch wrapper merges window.__agMock into the real GET /api/agenda and /api/costs replies, then a poll tick loads them.
    await evalJs(`(() => { const rf = window.fetch; window.__agMock = null;
      window.fetch = async (u, o) => { const r = await rf(u, o); const m = window.__agMock, p = String(u);
        const key = p.startsWith("/api/agenda") && !(o && o.method) ? "agenda" : p.startsWith("/api/costs") ? "costs" : null;
        if (!m || !key || !m[key] || !r.ok) return r;
        const j = await r.json(); return new Response(JSON.stringify({ ...j, ...m[key], sources_status: { ...j.sources_status, ...(m[key].sources_status || {}) } }), { status: 200, headers: { "content-type": "application/json" } }); };
      return "ok"; })()`);
    const mock = (m) => evalJs(`(() => { window.__agMock = ${JSON.stringify(m)}; __nedTick(); return "ok"; })()`);
    const running = { status: "running", updated_at: T0, started_at: T0 - 20000 };
    await step("agenda-running", () => mock({ agenda: { busy: true, sources_status: { slack: running, calendar: running }, context_status: { running: true, pending: 3, done: 2, failed: 0, stopped: null, skipped: [], updated_at: T0, cost_usd: 0.04 } } }),
      { shot: true, until: "!!document.querySelector('#st-slack .srun') && !!document.querySelector('#st-calendar .srun')" });
    await step("agenda-budget", () => mock({ agenda: { busy: false, context_status: { running: false, pending: 4, done: 1, failed: 0, stopped: "budget", skipped: [], updated_at: T0, cost_usd: 0.3 } }, costs: { today_usd: 15.37, budget_usd: 15, over_budget: true } }),
      { shot: true, until: "!!document.querySelector('#ctx-slack [data-ctxforce]') && !document.querySelector('#st-slack .srun')" });
    await step("agenda-idle", () => mock(null), { wait: 3500, until: "!document.querySelector('#ctx-slack [data-ctxforce]')" });
    fs.writeFileSync(path.join(out, "steps.json"), JSON.stringify(steps, null, 2));
    page.close();
  } finally {
    chrome.child.kill();
    daemon.kill();
  }
  fs.writeFileSync(path.join(out, "log.txt"), log.join("\n") + "\n");
  console.log(log.join("\n"));
  console.log(`\nwrote ${out} (T0 ${new Date(T0).toString()})`);
}

// ---------------------------------------------------------------- compare
const AA_MAX = 200;
async function compare(o) {
  const [a, b] = o._.slice(1).map((p) => path.resolve(p));
  const diffDir = path.resolve(o.out || path.join(b, "diff"));
  fs.mkdirSync(diffDir, { recursive: true });
  const report = [];
  let bad = 0;
  const shots = fs.readdirSync(path.join(a, "shots")).filter((x) => x.endsWith(".png")).sort();
  const chrome = await launchChrome(path.join(os.tmpdir(), "ned-mods-chrome-cmp"));
  try {
    const page = await openPage(chrome.port);
    await page.send("Runtime.enable");
    for (const s of shots) {
      const pa = path.join(a, "shots", s), pb = path.join(b, "shots", s);
      if (!fs.existsSync(pb)) { report.push(`MISSING ${s}`); bad++; continue; }
      const A = fs.readFileSync(pa), B = fs.readFileSync(pb);
      if (A.equals(B)) { report.push(`same   ${s} (bytes)`); continue; }
      const expr = `(async () => {
        const img = (u) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u; });
        const [x, y] = await Promise.all([img("data:image/png;base64,${A.toString("base64")}"), img("data:image/png;base64,${B.toString("base64")}")]);
        if (x.width !== y.width || x.height !== y.height) return { n: -1 };
        const c = document.createElement("canvas"); c.width = x.width; c.height = x.height; const g = c.getContext("2d");
        g.drawImage(x, 0, 0); const dx = g.getImageData(0, 0, c.width, c.height);
        g.drawImage(y, 0, 0); const dy = g.getImageData(0, 0, c.width, c.height);
        let n = 0; const out = g.createImageData(c.width, c.height);
        for (let i = 0; i < dx.data.length; i += 4) {
          const d = Math.abs(dx.data[i] - dy.data[i]) + Math.abs(dx.data[i + 1] - dy.data[i + 1]) + Math.abs(dx.data[i + 2] - dy.data[i + 2]);
          if (d) { n++; out.data[i] = 255; out.data[i + 3] = 255; } else { out.data[i] = out.data[i + 1] = out.data[i + 2] = dx.data[i] / 3; out.data[i + 3] = 255; }
        }
        g.putImageData(out, 0, 0);
        return { n, png: n ? c.toDataURL("image/png").split(",")[1] : null };
      })()`;
      const r = (await page.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
      if (r.n === 0) report.push(`same   ${s} (pixels)`);
      else {
        // Headless raster of the SVG marks' anti-aliased strokes varies by a few dozen px run to run (seen between two
        // captures of the SAME build with identical DOM + computed styles): ≤ AA_MAX px is reported, not failed.
        const noise = r.n > 0 && r.n <= AA_MAX;
        if (!noise) bad++;
        report.push(`${noise ? "aa     " : "DIFF   "}${s} ${r.n < 0 ? "size differs" : `${r.n} px`}`);
        if (r.png) fs.writeFileSync(path.join(diffDir, s), Buffer.from(r.png, "base64"));
      }
    }
    page.close();
  } finally { chrome.child.kill(); }
  const da = JSON.parse(fs.readFileSync(path.join(a, "dom.json"), "utf8")), db = JSON.parse(fs.readFileSync(path.join(b, "dom.json"), "utf8"));
  for (const k of Object.keys(da)) for (const f of Object.keys(da[k])) {
    if (da[k][f] !== db[k]?.[f]) { bad++; report.push(`DOM    ${k}.${f} ${da[k][f]} ≠ ${db[k]?.[f]}`); }
  }
  report.push(`dom.json: ${Object.keys(da).length} views × 4 hashes compared`);
  const sa = JSON.parse(fs.readFileSync(path.join(a, "steps.json"), "utf8")), sb = JSON.parse(fs.readFileSync(path.join(b, "steps.json"), "utf8"));
  sa.forEach((x, i) => {
    const y = sb[i];
    if (!y || y.name !== x.name) { bad++; report.push(`STEP   ${x.name} missing`); return; }
    const diffs = [];
    if (JSON.stringify(x.res) !== JSON.stringify(y.res)) diffs.push(`res ${JSON.stringify(x.res)} ≠ ${JSON.stringify(y.res)}`);
    if (JSON.stringify(x.meta) !== JSON.stringify(y.meta)) diffs.push(`meta ${JSON.stringify(x.meta)} ≠ ${JSON.stringify(y.meta)}`);
    for (const k of Object.keys(x.hashes)) if (JSON.stringify(x.hashes[k]) !== JSON.stringify(y.hashes[k])) diffs.push(`${k} ${JSON.stringify(x.hashes[k])} ≠ ${JSON.stringify(y.hashes[k])}`);
    if (y.errors.length) diffs.push(`errors in B: ${y.errors.join(" | ")}`);
    if (x.errors.length) report.push(`note   ${x.name}: errors in A: ${x.errors.join(" | ")}`);
    if (diffs.length) { bad++; report.push(`STEP   ${x.name}: ${diffs.join("; ")}`); } else report.push(`same   step ${x.name}`);
  });
  fs.writeFileSync(path.join(diffDir, "report.txt"), report.join("\n") + "\n");
  console.log(report.join("\n"));
  console.log(`\n${bad ? `${bad} difference(s)` : "identical"} — report: ${path.join(diffDir, "report.txt")}`);
  process.exitCode = bad ? 1 : 0;
}

const o = args(process.argv.slice(2));
if (o._[0] === "capture") await capture(o);
else if (o._[0] === "compare") await compare(o);
else { console.log("usage: dash-capture.mjs capture --out <dir> [--daemon <dir>] [--port 7790] [--home /tmp/ned-mods]\n       dash-capture.mjs compare <dirA> <dirB> [--out <diffdir>]"); process.exitCode = 2; }
