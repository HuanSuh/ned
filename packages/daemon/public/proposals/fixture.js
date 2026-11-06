/* Ned proposals fixture — a snapshot of the REAL daemon API (GET /api/state, /api/briefings?limit=30,
 * /api/events?days=2, /api/config) taken from NED_HOME=/tmp/ned-dash with NED_NO_LLM=1.
 * NED.load() re-anchors every timestamp to "now" so relative times stay meaningful, and prefers the
 * live API when the page is served by the daemon. Add ?empty=1 to preview the "nothing new" state. */
(function () {
  "use strict";
  const SNAP = {"generated_at":1793930983614,"state":{"updated_at":1793930954288,"daemon_pid":63568,"sessions":[{"id":"s2","cwd":"/Users/me/orca/workspaces/ned/ned-menubar","worktree":"ned-menubar","status":"waiting","since":1793923690846,"last_event_ts":1793930710846,"last_prompt":"MenuBarExtra 로 state.json 을 읽어서 attention 배지를 표시해줘","last_summary":"Claude needs your permission to use Bash: swift build -c release","subagents_active":1,"orca_worktree":"ned-menubar"},{"id":"s3","cwd":"/Users/me/orca/workspaces/ned/ned-daemon-verify","worktree":"ned-daemon-verify","status":"error","since":1793925190846,"last_event_ts":1793929570846,"last_prompt":"hook → events → state 파이프라인을 끝까지 검증하고 NED_NO_LLM 스위치를 추가","last_summary":"API Error: 529 overloaded_error after 3 retries","subagents_active":0,"orca_worktree":"ned-daemon-verify"},{"id":"s1","cwd":"/Users/me/orca/workspaces/ned/ned-dashboard","worktree":"ned-dashboard","status":"done","since":1793920690846,"last_event_ts":1793928490846,"last_prompt":"대시보드 index.html 을 만들어 주세요. 섹션은 헤더, 지금 봐야 할 것, 세션, 브리핑, 타임라인, 설정.","last_summary":null,"subagents_active":0,"orca_worktree":"ned-dashboard"}],"attention":[{"id":"session:s2","kind":"session","title":"ned-menubar: 입력 대기","detail":"Claude needs your permission to use Bash: swift build -c release","ts":1793930710846,"source":"sessions"},{"id":"session:s3","kind":"session","title":"ned-daemon-verify: 오류","detail":"API Error: 529 overloaded_error after 3 retries","ts":1793929570846,"source":"sessions"},{"id":"2026-11-06T01-08-10-846Z:0","kind":"github","title":"PR #42 리뷰 요청: feat(daemon) heartbeat scheduler","detail":"@huansuh 가 리뷰어로 지정됨. 변경 12파일, +480/-95. CI 통과.","url":"https://github.com/example/ned/pull/42","ts":1793927290846,"source":"2026-11-06T01-08-10-846Z"},{"id":"2026-11-06T01-08-10-846Z:1","kind":"slack","title":"Slack #ned-dev 멘션: 배포 일정 확인 요청","detail":"@민수: \"이번 주 금요일 2.4.3 배포 가능할까요?\" — 오늘 오후까지 답변 필요","url":"https://slack.com/app_redirect?channel=C1","ts":1793927290846,"source":"2026-11-06T01-08-10-846Z"},{"id":"2026-11-06T01-08-10-846Z:2","kind":"calendar","title":"14:00 스프린트 리뷰","detail":"Google Meet · 참석자 5명 · 데모 담당: 대시보드","url":"https://calendar.google.com/","ts":1793927290846,"source":"2026-11-06T01-08-10-846Z"}],"last_briefing":{"id":"2026-11-06T02-09-14-287Z","ts":1793930954280,"type":"daily","status":"NED_OK"},"last_heartbeat_at":1793930954280,"next_heartbeat_at":1793931554290,"quiet":false},"briefings":[{"id":"2026-11-06T02-09-14-287Z","ts":1793930954280,"type":"daily","status":"NED_OK","action_items":[],"updates":[],"fyi":[],"sessions":[],"cost_usd":0},{"id":"2026-11-06T01-48-10-846Z","ts":1793929690846,"type":"heartbeat","status":"NED_OK","action_items":[],"updates":[],"fyi":[],"sessions":[],"cost_usd":0.0412},{"id":"2026-11-06T01-08-10-846Z","ts":1793927290846,"type":"daily","status":"UPDATE","headline":"리뷰 요청 2건, 14시 스프린트 리뷰, Sentry 신규 이슈 1건","action_items":[{"title":"PR #42 리뷰 요청: feat(daemon) heartbeat scheduler","detail":"@huansuh 가 리뷰어로 지정됨. 변경 12파일, +480/-95. CI 통과.","url":"https://github.com/example/ned/pull/42","kind":"github"},{"title":"Slack #ned-dev 멘션: 배포 일정 확인 요청","detail":"@민수: \"이번 주 금요일 2.4.3 배포 가능할까요?\" — 오늘 오후까지 답변 필요","url":"https://slack.com/app_redirect?channel=C1","kind":"slack"},{"title":"14:00 스프린트 리뷰","detail":"Google Meet · 참석자 5명 · 데모 담당: 대시보드","url":"https://calendar.google.com/","kind":"calendar"}],"updates":[{"title":"NED-17 'heartbeat 스케줄러' → In Review","detail":"지수 님이 상태 변경","kind":"jira","url":"https://example.atlassian.net/browse/NED-17"},{"title":"PR #40 'hook 등록 스크립트' 머지됨","kind":"github","url":"https://github.com/example/ned/pull/40"}],"fyi":[{"title":"Sentry: TypeError in sessions.ts (신규, 3 events, 1 user)","detail":"reduceSessions → Cannot read properties of undefined","kind":"sentry","url":"https://sentry.io/issues/1"},{"title":"Gmail: 'Claude Code 1.2 release notes' (뉴스레터)","kind":"email"}],"sessions":[{"title":"ned-dashboard: 대시보드 구현 완료 후 대기 중"},{"title":"ned-menubar: swift build 권한 승인 대기"}],"cost_usd":0.1834},{"id":"2026-11-05T22-48-10-846Z","ts":1793918890846,"type":"heartbeat","status":"NED_OK","action_items":[],"updates":[],"fyi":[],"cost_usd":0.03,"raw":"```json\n{\"status\":\"NED_OK\"\n```"},{"id":"2026-11-05T00-08-10-846Z","ts":1793837290846,"type":"daily","status":"UPDATE","headline":"어제: Jira 2건 할당, PR #38 승인됨","action_items":[{"title":"NED-15, NED-16 이 할당됨 (스프린트 12)","kind":"jira","url":"https://example.atlassian.net/browse/NED-15"}],"updates":[{"title":"PR #38 approved by @jisoo","kind":"github"}],"fyi":[],"sessions":[],"cost_usd":0.21}],"events":[{"ts":1793920690846,"event":"SessionStart","session_id":"s1","cwd":"/Users/me/orca/workspaces/ned/ned-dashboard","orca_worktree":"ned-dashboard","source":"startup"},{"ts":1793920810846,"event":"UserPromptSubmit","session_id":"s1","cwd":"/Users/me/orca/workspaces/ned/ned-dashboard","prompt":"대시보드 index.html 을 만들어 주세요. 섹션은 헤더, 지금 봐야 할 것, 세션, 브리핑, 타임라인, 설정."},{"ts":1793921290846,"event":"SubagentStart","session_id":"s1","cwd":"/Users/me/orca/workspaces/ned/ned-dashboard","agent_id":"a1","agent_type":"explore"},{"ts":1793921890846,"event":"SubagentStop","session_id":"s1","cwd":"/Users/me/orca/workspaces/ned/ned-dashboard","agent_id":"a1","agent_type":"explore"},{"ts":1793923690846,"event":"SessionStart","session_id":"s2","cwd":"/Users/me/orca/workspaces/ned/ned-menubar","orca_worktree":"ned-menubar","source":"startup"},{"ts":1793923810846,"event":"UserPromptSubmit","session_id":"s2","cwd":"/Users/me/orca/workspaces/ned/ned-menubar","prompt":"MenuBarExtra 로 state.json 을 읽어서 attention 배지를 표시해줘"},{"ts":1793925190846,"event":"SessionStart","session_id":"s3","cwd":"/Users/me/orca/workspaces/ned/ned-daemon-verify","orca_worktree":"ned-daemon-verify","source":"startup"},{"ts":1793925250846,"event":"UserPromptSubmit","session_id":"s3","cwd":"/Users/me/orca/workspaces/ned/ned-daemon-verify","prompt":"hook → events → state 파이프라인을 끝까지 검증하고 NED_NO_LLM 스위치를 추가"},{"ts":1793928490846,"event":"Stop","session_id":"s1","cwd":"/Users/me/orca/workspaces/ned/ned-dashboard","transcript_path":"/nonexistent"},{"ts":1793929570846,"event":"StopFailure","session_id":"s3","cwd":"/Users/me/orca/workspaces/ned/ned-daemon-verify","message":"API Error: 529 overloaded_error after 3 retries"},{"ts":1793930350846,"event":"Notification","session_id":"s2","cwd":"/Users/me/orca/workspaces/ned/ned-menubar","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash: swift build -c release"},{"ts":1793930710846,"event":"SubagentStart","session_id":"s2","cwd":"/Users/me/orca/workspaces/ned/ned-menubar","agent_id":"a2","agent_type":"executor"}],"config":{"heartbeat_minutes":10,"signal_check_minutes":60,"briefing_time":"09:00","quiet_hours":{"start":"23:00","end":"08:00"},"sources":{"gmail":true,"slack":true,"jira":true,"github":true,"sentry":true,"calendar":true},"port":7778,"claude_model":null,"claude_max_turns":25,"session_stale_minutes":180}};
  const TS_KEYS = ["ts", "updated_at", "last_heartbeat_at", "next_heartbeat_at", "since", "last_event_ts"];
  function shift(o, d) {
    if (Array.isArray(o)) return o.map((x) => shift(x, d));
    if (o && typeof o === "object") {
      const r = {};
      for (const [k, v] of Object.entries(o)) r[k] = TS_KEYS.includes(k) && typeof v === "number" && v > 0 ? v + d : shift(v, d);
      return r;
    }
    return o;
  }
  function emptyVariant(d) {
    d.state.attention = [];
    d.state.sessions = d.state.sessions.filter((s) => s.status === "done");
    d.briefings = d.briefings.filter((b) => b.status === "NED_OK");
    return d;
  }
  async function tryLive() {
    if (!/^https?:$/.test(location.protocol)) return null;
    try {
      const g = async (p) => { const r = await fetch(p); if (!r.ok) throw new Error(p); return r.json(); };
      const [state, briefings, events, config] = await Promise.all([g("/api/state"), g("/api/briefings?limit=30"), g("/api/events?days=2"), g("/api/config")]);
      return { state, briefings, events, config, live: true };
    } catch { return null; }
  }
  const empty = new URLSearchParams(location.search).has("empty");
  let data = null;
  window.NED = {
    async load() {
      data = (!empty && (await tryLive())) || Object.assign(shift(JSON.parse(JSON.stringify(SNAP)), Date.now() - SNAP.generated_at), { live: false });
      if (empty) emptyVariant(data);
      return data;
    },
    async dismiss(id) {
      if (data && data.live) await fetch("/api/attention/" + encodeURIComponent(id) + "/dismiss", { method: "POST" });
      if (data) data.state.attention = data.state.attention.filter((a) => a.id !== id);
    },
    async heartbeat(daily) {
      if (data && data.live) return (await fetch("/api/heartbeat" + (daily ? "?daily=1" : ""), { method: "POST" })).json();
      await new Promise((r) => setTimeout(r, 1200));
      return { status: "NED_OK" };
    },
    KIND_ICON: { session: "🖥", email: "✉️", slack: "💬", jira: "📋", github: "🐙", sentry: "🐞", calendar: "📅", other: "🔔" },
    KIND_KO: { session: "세션", email: "메일", slack: "Slack", jira: "Jira", github: "GitHub", sentry: "Sentry", calendar: "캘린더", other: "기타" },
    STATUS_KO: { running: "실행 중", waiting: "입력 대기", done: "완료", error: "오류", ended: "종료" },
    EVENT_KO: { SessionStart: "세션 시작", SessionEnd: "세션 종료", UserPromptSubmit: "프롬프트", SubagentStart: "서브에이전트 시작", SubagentStop: "서브에이전트 종료", Notification: "알림", Stop: "응답 완료", StopFailure: "오류", PreCompact: "압축" },
    rel(ts) {
      if (!ts) return "—";
      const diff = Date.now() - ts, s = Math.round(Math.abs(diff) / 1000), f = (x) => (diff >= 0 ? x + " 전" : x + " 후");
      if (s < 45) return f(s + "초"); const m = Math.round(s / 60); if (m < 60) return f(m + "분");
      const h = Math.round(m / 60); if (h < 36) return f(h + "시간"); return f(Math.round(h / 24) + "일");
    },
    hhmm(ts) { const d = new Date(ts); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); },
    dayLabel(ts) {
      const d = new Date(ts), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
      if (d.toDateString() === t.toDateString()) return "오늘"; if (d.toDateString() === y.toDateString()) return "어제";
      return (d.getMonth() + 1) + "월 " + d.getDate() + "일";
    },
    basename(p) { return p ? String(p).replace(/\/+$/, "").split("/").pop() : ""; },
    alive(state) { return !!state.updated_at && Date.now() - state.updated_at < 20 * 60 * 1000; },
    /** Events + briefings merged newest first, the same rule as index.html. */
    timeline(d) {
      const ev = d.events.map((e) => ({ ts: e.ts, type: e.event, wt: e.orca_worktree || NED.basename(e.cwd), brief: false, msg: e.prompt || e.message || e.reason || (e.agent_type ? "agent " + e.agent_type : ""), raw: e }));
      const bf = d.briefings.map((b) => ({ ts: b.ts, type: "브리핑", wt: "", brief: true, msg: (b.type === "daily" ? "아침" : "점검") + " · " + b.status + (b.headline ? " · " + b.headline : ""), raw: b }));
      return ev.concat(bf).sort((a, b) => b.ts - a.ts);
    },
    esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]); },
  };
})();
