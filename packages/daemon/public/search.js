/* Ned dashboard — global search (⌘K / Ctrl+K, or "/" outside inputs).
 * Self-contained: index.html only loads this file. It reuses window.NED?.data when the page exposes it, otherwise
 * fetches the same APIs the page uses (cached 30 s), searches them locally on every keystroke, and merges
 * GET /api/search?q= (all briefings, 30 days of events, drafts) deduped on type+id. Styles follow the page's CSS
 * variables, so personas and light/dark apply. Navigation drives the page through its own DOM (hash routes, tab
 * buttons, rows, cards) because the page keeps its state private. */
(() => {
  "use strict";
  if (window.__nedSearch) return;
  window.__nedSearch = true;

  const CACHE_MS = 30_000, RECENT_KEY = "ned.search.recent", RECENT_MAX = 10, PER_GROUP = 6, SERVER_DEBOUNCE = 160;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = IS_MAC ? "⌘" : "Ctrl+";

  // ---------- utils ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const localDay = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const base = (p) => (p ? String(p).replace(/\/+$/, "").split("/").pop() : "");
  const isoTs = (s) => { const t = s == null || s === "" ? NaN : new Date(s).getTime(); return Number.isFinite(t) ? t : null; };
  function dayLabel(ts) {
    const d = new Date(ts), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return "오늘";
    if (d.toDateString() === y.toDateString()) return "어제";
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }
  function rel(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts, s = Math.round(Math.abs(diff) / 1000), f = (x) => (diff >= 0 ? `${x} 전` : `${x} 후`);
    if (s < 45) return diff >= 0 ? "방금" : f(`${s}초`);
    const m = Math.round(s / 60); if (m < 60) return f(`${m}분`);
    const h = Math.round(m / 60); if (h < 36) return f(`${h}시간`);
    const d = Math.round(h / 24); if (d < 60) return f(`${d}일`);
    return `${new Date(ts).getFullYear()}.${new Date(ts).getMonth() + 1}.${new Date(ts).getDate()}`;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
  const editable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  // ---------- matching (mirrors src/search.ts) ----------
  const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const norm = (s) => String(s == null ? "" : s).normalize("NFC").toLowerCase();
  function chosung(s) { let o = ""; for (const ch of s) { const c = ch.charCodeAt(0); o += c >= 0xac00 && c <= 0xd7a3 ? CHO[Math.floor((c - 0xac00) / 588)] : ch; } return o; }
  const isCho = (t) => /^[ㄱ-ㅎ]+$/.test(t);
  const WORD_SEP = /[\s\-_/#@:.,()[\]<>"'·|]/;
  function tokenScore(text, tok) {
    if (!text) return 0;
    if (text.startsWith(tok)) return 6;
    let i = text.indexOf(tok);
    if (i >= 0) { for (; i >= 0; i = text.indexOf(tok, i + 1)) if (WORD_SEP.test(text[i - 1] ?? " ")) return 4; return 2; }
    if (isCho(tok) && chosung(text).includes(tok)) return 1.5;
    return 0;
  }
  const tokenize = (q) => norm(q).split(/\s+/).filter(Boolean).slice(0, 8);
  function scoreFields(fields, toks, ts, now) {
    if (!toks.length) return 0;
    const f = fields.map(([t, w]) => [norm(t), w]).filter(([t]) => t);
    let total = 0;
    for (const tok of toks) {
      let best = 0;
      for (const [t, w] of f) best = Math.max(best, tokenScore(t, tok) * w);
      if (!best) return 0;
      total += best;
    }
    if (ts) { const days = Math.abs(now - ts) / 86_400_000; total += days < 1 ? 2 : days < 7 ? 1 : 0; }
    return total;
  }
  /** <mark> each token occurrence in `text` (substring matches only; 초성 matches aren't highlighted). */
  function hl(text, toks) {
    const s = String(text == null ? "" : text), n = norm(s);
    if (!toks.length || n.length !== s.length) return esc(s);
    const marks = new Array(s.length).fill(false);
    for (const t of toks) for (let i = n.indexOf(t); i >= 0; i = n.indexOf(t, i + 1)) for (let j = i; j < i + t.length; j++) marks[j] = true;
    let out = "", on = false;
    for (let i = 0; i < s.length; i++) {
      if (marks[i] !== on) { out += marks[i] ? "<mark>" : "</mark>"; on = marks[i]; }
      out += esc(s[i]);
    }
    return on ? out + "</mark>" : out;
  }

  // ---------- groups / labels ----------
  const GROUPS = [
    ["attention", "주의 항목"], ["session", "세션"], ["calendar", "일정"], ["jira", "Jira"], ["github", "GitHub"], ["mail", "메일"],
    ["slack", "Slack"], ["todo", "개인 할 일"], ["briefing", "브리핑"], ["event", "타임라인 이벤트"], ["draft", "초안"], ["settings", "설정 항목"],
  ];
  const GROUP_LABEL = Object.fromEntries(GROUPS);
  const KIND_ICON = { session: "🖥", email: "✉️", slack: "💬", jira: "📋", github: "🐙", sentry: "🐞", calendar: "📅", other: "🔔", me: "✅", briefing: "📝", event: "⚡", settings: "⚙️", draft: "✍️", recent: "🕘" };
  const TYPE_ICON = { session: "🖥", calendar: "📅", jira: "📋", github: "🐙", mail: "✉️", slack: "💬", todo: "✅", briefing: "📝", event: "⚡", settings: "⚙️", draft: "✍️" };
  const TAB_KO = { home: "홈", inbox: "인박스", timeline: "타임라인", settings: "설정" };
  const EVENT_KO = { SessionStart: "세션 시작", SessionEnd: "세션 종료", UserPromptSubmit: "프롬프트", SubagentStart: "서브에이전트 시작", SubagentStop: "서브에이전트 종료", Notification: "알림", Stop: "응답 완료", StopFailure: "오류", PreCompact: "컨텍스트 압축" };
  const STATUS_KO = { running: "실행 중", waiting: "입력 대기", done: "완료", error: "오류", ended: "종료" };
  const SEC_KO = { action_items: "행동 필요", updates: "업데이트", fyi: "참고", sessions: "세션" };
  const iconOf = (h) => (h.type === "attention" ? KIND_ICON[h.kind] || "🔔" : TYPE_ICON[h.type] || KIND_ICON[h.kind] || "·");

  /** Settings sections: element id to jump to + search keywords. */
  const SETTINGS = [
    { id: "persona", title: "페르소나", detail: "말투 · 테마 · 마크 (Ned / Alfred / Oracle / Jarvis)", el: "c-persona", keys: "persona theme 테마 말투 마크 ned alfred oracle jarvis" },
    { id: "heartbeat", title: "heartbeat 간격", detail: "순찰 주기 (분)", el: "c-hb", keys: "heartbeat 순찰 주기 간격" },
    { id: "signal", title: "신호 조회 최소 간격", detail: "세션 이벤트가 없을 때 업무 신호를 보는 간격", el: "c-sig", keys: "signal 신호 조회" },
    { id: "briefing_time", title: "아침 브리핑 시각", detail: "매일 브리핑 시간", el: "c-bt", keys: "briefing time 브리핑 아침 시각" },
    { id: "quiet", title: "조용한 시간", detail: "알림 없는 시간대", el: "c-qon", keys: "quiet hours 방해 금지 dnd 야간" },
    { id: "sources", title: "업무 신호 소스", detail: "Gmail · Slack · Jira · GitHub · Sentry · 캘린더", el: "c-sources", keys: "sources 소스 gmail slack jira github sentry calendar 캘린더 메일" },
    { id: "filters", title: "트래킹 제외", detail: "Slack 채널 · Jira 프로젝트 제외", el: "x-slack-in", keys: "filters exclude 제외 채널 프로젝트 트래킹" },
    { id: "notifications", title: "알림", detail: "배너 · 소리 · 묶음 기준 · 조용한 시간 동작", el: "n-on", keys: "notifications 알림 배너 소리 sound 묶음" },
    { id: "model", title: "Claude 모델", detail: "비우면 기본값", el: "c-model", keys: "model claude 모델 sonnet opus" },
    { id: "turns", title: "Claude 최대 턴", detail: "claude -p 최대 턴 수", el: "c-turns", keys: "turns max 턴" },
  ];

  // ---------- data (window.NED?.data, else the APIs; cached 30 s) ----------
  const data = { at: 0, cands: [], loading: null };
  async function getJson(p) { const r = await fetch(p, { headers: { accept: "application/json" } }); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.json(); }
  function loadData(force) {
    if (!force && data.at && Date.now() - data.at < CACHE_MS) return Promise.resolve(data.cands);
    if (data.loading) return data.loading;
    data.loading = (async () => {
      const shared = window.NED && window.NED.data;
      const pick = async (key, p) => (shared && shared[key] !== undefined && shared[key] !== null ? shared[key] : getJson(p));
      const [state, agenda, briefings, events, todos, config] = (await Promise.allSettled([
        pick("state", "/api/state"), pick("agenda", "/api/agenda"), pick("briefings", "/api/briefings?limit=30"),
        pick("events", "/api/events?days=2"), pick("todos", "/api/todos"), pick("config", "/api/config"),
      ])).map((r) => (r.status === "fulfilled" ? r.value : null));
      data.cands = buildCands({ state, agenda, briefings, events, todos, config });
      data.at = Date.now();
      data.loading = null;
      return data.cands;
    })().catch((e) => { data.loading = null; console.warn("[search] load", e.message); return data.cands; });
    return data.loading;
  }

  /** Same ids / anchors as src/search.ts so local and server hits dedupe. */
  function buildCands(d) {
    const out = [];
    const st = d.state || {}, a = d.agenda || {}, src = (d.config && d.config.sources) || a.sources || {};
    const on = (k) => src[k] !== false;
    for (const x of st.attention || []) out.push({ type: "attention", id: x.id, title: x.title, detail: x.detail || "", ts: x.ts, url: safeUrl(x.url), kind: x.kind, tab: "inbox", anchor: `row:${x.id}`, fields: [[x.title, 3], [x.kind, 2], [x.detail, 1]] });
    for (const s of st.sessions || []) out.push({ type: "session", id: s.id, title: s.worktree, detail: s.last_summary || s.last_prompt || STATUS_KO[s.status] || s.status, ts: s.last_event_ts, url: null, kind: "session", tab: "inbox", anchor: `session:${s.id}`, status: s.status, fields: [[s.worktree, 3], [s.status, 2], [STATUS_KO[s.status], 2], [s.cwd, 1], [s.last_prompt, 1], [s.last_summary, 1]] });
    if (on("calendar")) for (const c of a.calendar || []) out.push({ type: "calendar", id: c.id, title: c.title, detail: [c.all_day ? "종일" : isoTs(c.start) ? hhmm(isoTs(c.start)) : "", c.location].filter(Boolean).join(" · "), ts: isoTs(c.start), url: safeUrl(c.url) || safeUrl(c.meet_url), kind: "calendar", tab: "home", anchor: "card:cal", fields: [[c.title, 3], [c.location, 1]] });
    if (on("jira")) for (const j of a.jira || []) out.push({ type: "jira", id: j.key, title: j.title, detail: [j.key, j.status, j.priority, j.due ? `마감 ${j.due}` : ""].filter(Boolean).join(" · "), ts: isoTs(j.updated), url: safeUrl(j.url), kind: "jira", tab: "home", anchor: "card:jira", fields: [[j.title, 3], [j.key, 3], [j.status, 1], [j.priority, 1]] });
    if (on("github")) for (const g of a.github || []) out.push({ type: "github", id: `${g.repo}#${g.number}`, title: g.title, detail: `${g.repo}#${g.number} · @${g.author}`, ts: isoTs(g.updated), url: safeUrl(g.url), kind: "github", tab: "home", anchor: "card:gh", fields: [[g.title, 3], [`${g.repo}#${g.number}`, 2], [g.author, 2], [g.reason, 1]] });
    if (on("gmail") && a.mail) {
      const seen = new Set();
      for (const m of [...(a.mail.items || []).map((x) => ({ id: x.id, from: x.from, subject: x.subject, snip: x.why || x.snippet, ts: x.received, url: x.url })), ...(a.mail.all || []).map((x) => ({ id: x.id, from: x.from, subject: x.subject, snip: "", ts: x.ts, url: x.url }))]) {
        if (seen.has(m.id)) continue; seen.add(m.id);
        out.push({ type: "mail", id: m.id, title: m.subject || "(제목 없음)", detail: [m.from, m.snip].filter(Boolean).join(" · "), ts: isoTs(m.ts), url: safeUrl(m.url), kind: "email", tab: "home", anchor: "card:mail", fields: [[m.subject, 3], [m.from, 2], [m.snip, 1]] });
      }
    }
    if (on("slack") && a.slack) {
      const seen = new Set();
      for (const x of [...(a.slack.items || []), ...(a.slack.all || [])]) {
        const id = x.url || `${x.channel}:${x.ts}`;
        if (seen.has(id)) continue; seen.add(id);
        out.push({ type: "slack", id, title: x.text || "(내용 없음)", detail: `${x.channel} · ${x.from}`, ts: isoTs(x.ts), url: safeUrl(x.url), kind: "slack", tab: "home", anchor: "card:slack", fields: [[x.text, 3], [x.channel, 2], [x.from, 2]] });
      }
    }
    for (const t of Array.isArray(d.todos) ? d.todos : []) out.push({ type: "todo", id: t.id, title: t.title, detail: [t.done ? "완료" : "", t.due ? `마감 ${t.due}` : "", t.note || ""].filter(Boolean).join(" · "), ts: t.created_at, url: null, kind: "me", tab: "home", anchor: "card:todo", done: !!t.done, fields: [[t.title, 3], [t.note, 1]] });
    for (const b of Array.isArray(d.briefings) ? d.briefings : []) {
      const secs = ["action_items", "updates", "fyi", "sessions"], items = secs.flatMap((sec) => (b[sec] || []).map((x) => ({ ...x, section: sec })));
      const label = b.type === "daily" ? "아침 브리핑" : "점검";
      out.push({ type: "briefing", id: b.id, title: b.headline || `${label} · ${b.status === "NED_OK" ? "이상 무" : `${items.length}건`}`, detail: items.map((x) => x.title).slice(0, 3).join(" · ") || label, ts: b.ts, url: null, kind: "briefing", tab: "inbox", anchor: `briefing:${b.id}`, items, status: b.status, local: true,
        fields: [[b.headline, 3], [label, 1], [b.status, 1], ...items.flatMap((x) => [[x.title, 2], [x.detail, 1], [x.kind, 1]])] });
    }
    for (const e of Array.isArray(d.events) ? d.events : []) {
      const msg = e.prompt ?? e.message ?? e.reason ?? (e.agent_type ? `agent ${e.agent_type}` : "");
      const wt = e.orca_worktree ? base(String(e.orca_worktree).split("::").pop()) : base(e.cwd), label = EVENT_KO[e.event] || e.event;
      out.push({ type: "event", id: `${e.ts}:${e.event}:${e.session_id ?? ""}`, title: msg ? String(msg).replace(/\s+/g, " ").slice(0, 160) : label, detail: [label, wt].filter(Boolean).join(" · "), ts: e.ts, url: null, kind: "event", tab: "timeline", anchor: `day:${localDay(e.ts)}`, body: msg ? String(msg) : "", local: true,
        fields: [[msg, 3], [wt, 2], [label, 1], [e.event, 1], [e.notification_type, 1]] });
    }
    for (const s of SETTINGS) out.push({ type: "settings", id: s.id, title: s.title, detail: s.detail, ts: null, url: null, kind: "settings", tab: "settings", anchor: `el:${s.el}`, fields: [[s.title, 3], [s.keys, 2], [s.detail, 1]] });
    return out;
  }

  // ---------- recent queries ----------
  function recents() { try { const r = JSON.parse(lsGet(RECENT_KEY) || "[]"); return Array.isArray(r) ? r.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : []; } catch { return []; } }
  function pushRecent(q) { q = q.trim(); if (!q) return; lsSet(RECENT_KEY, JSON.stringify([q, ...recents().filter((x) => x !== q)].slice(0, RECENT_MAX))); }

  // ---------- styles ----------
  const css = `
  .nsp-btn { margin-left: 6px; color: var(--dim); }
  .nsp-btn kbd { font-size: 10.5px; }
  #nsp { position: fixed; inset: 0; z-index: 1000; display: none; align-items: flex-start; justify-content: center; padding: 11vh 16px 16px; background: color-mix(in srgb, var(--bg) 62%, transparent); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
  #nsp.open { display: flex; }
  #nsp .pal { width: min(700px, 100%); max-height: min(72vh, 680px); display: flex; flex-direction: column; background: var(--pane); color: var(--fg); border: 1px solid var(--edge, var(--line)); border-radius: 12px; box-shadow: 0 24px 60px -12px rgba(0,0,0,.55), 0 0 0 1px color-mix(in srgb, var(--hero) 18%, transparent); overflow: hidden; font-family: var(--sans); }
  #nsp .qrow { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  #nsp .qrow .qi { color: var(--faint); font-size: 15px; }
  #nsp input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: var(--fg); font: 500 16px var(--sans); }
  #nsp input::placeholder { color: var(--faint); }
  #nsp .busy { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--hero); animation: nsp-spin .8s linear infinite; visibility: hidden; }
  #nsp .busy.on { visibility: visible; }
  @keyframes nsp-spin { to { transform: rotate(360deg); } }
  #nsp kbd { font: 11px var(--mono); background: var(--hover); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; color: var(--dim); }
  #nsp .res { overflow-y: auto; padding: 4px 0 8px; overscroll-behavior: contain; }
  #nsp .gh { display: flex; align-items: center; gap: 8px; padding: 10px 16px 4px; font: 600 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
  #nsp .gh .n { font-weight: 500; color: var(--faint); opacity: .8; }
  #nsp .gh .sp { flex: 1; }
  #nsp .gh button { font: 11px var(--sans); color: var(--dim); background: none; border: 0; cursor: pointer; padding: 0; text-transform: none; letter-spacing: 0; }
  #nsp .gh button:hover { color: var(--fg); text-decoration: underline; }
  #nsp .it { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 1px 10px; align-items: center; margin: 0 6px; padding: 7px 10px; border-radius: 8px; cursor: pointer; border-left: 2px solid transparent; }
  #nsp .it .ic { grid-row: span 2; text-align: center; font-size: 15px; }
  #nsp .it .tt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  #nsp .it .sb { grid-column: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dim); }
  #nsp .it .rt { grid-column: 3; grid-row: 1 / span 2; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  #nsp .it .tm { font: 11px var(--mono); color: var(--faint); white-space: nowrap; }
  #nsp .chip { font: 600 10.5px var(--sans); color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; white-space: nowrap; background: var(--raise); }
  #nsp .chip.url { color: var(--info); border-color: color-mix(in srgb, var(--info) 40%, var(--line)); }
  #nsp .it.sel { background: var(--sel); border-left-color: var(--hero); }
  #nsp .it.sel .chip { border-color: color-mix(in srgb, var(--hero) 40%, var(--line)); }
  #nsp .it.done .tt { text-decoration: line-through; color: var(--dim); }
  #nsp mark { background: color-mix(in srgb, var(--hero) 26%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
  #nsp .none { padding: 26px 16px; text-align: center; color: var(--dim); font-size: 13px; }
  #nsp .ft { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 8px 14px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--faint); background: var(--side, var(--pane)); }
  #nsp .ft .sp { flex: 1; }
  #nsp .dv { overflow-y: auto; padding: 14px 18px 18px; }
  #nsp .dv .crumb { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; color: var(--dim); }
  #nsp .dv h2 { margin: 8px 0 6px; font: var(--head-w, 650) 17px var(--head, var(--sans)); line-height: 1.4; }
  #nsp .dv .body { white-space: pre-wrap; font-size: 13.5px; line-height: 1.55; color: var(--fg); }
  #nsp .dv h3 { margin: 14px 0 6px; font: 600 11px var(--mono); letter-spacing: .06em; color: var(--faint); text-transform: uppercase; }
  #nsp .dv ul { margin: 0; padding-left: 18px; font-size: 13.5px; line-height: 1.5; }
  #nsp .dv li .d { color: var(--dim); font-size: 12.5px; }
  #nsp .dv a { color: var(--info); }
  .nsp-hl { position: fixed; z-index: 999; pointer-events: none; border: 2px solid var(--hero); border-radius: 8px; background: color-mix(in srgb, var(--hero) 12%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--hero) 18%, transparent); animation: nsp-hl 2.2s ease-out forwards; }
  @keyframes nsp-hl { 0%, 45% { opacity: 1; } 100% { opacity: 0; } }
  @media (max-width: 640px) { #nsp { padding-top: 8px; } #nsp .pal { max-height: calc(100vh - 16px); } #nsp .ft .hide-sm { display: none; } .nsp-btn kbd { display: none; } }
  `;

  // ---------- DOM ----------
  const st = { open: false, q: "", rows: [], sel: 0, selKey: null, server: [], serverQ: "", busy: false, detail: null, ctl: null, timer: 0, lastFocus: null };
  let root, input, res, busyEl, palEl;

  function mount() {
    const style = document.createElement("style");
    style.id = "nsp-style";
    style.textContent = css;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "nsp";
    root.innerHTML = `<div class="pal" role="dialog" aria-modal="true" aria-label="검색">
      <div class="qrow"><span class="qi" aria-hidden="true">🔍</span><input type="text" id="nsp-q" placeholder="검색 — 주의 항목, 세션, 일정, Jira, 메일, Slack, 브리핑, 설정…" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="nsp-res" aria-autocomplete="list"><span class="busy" id="nsp-busy" aria-hidden="true"></span><kbd>esc</kbd></div>
      <div class="res" id="nsp-res" role="listbox" aria-label="검색 결과"></div>
      <div class="ft"><span><kbd>↑</kbd><kbd>↓</kbd> 이동</span><span><kbd>⏎</kbd> 열기</span><span class="hide-sm"><kbd>${MOD}⏎</kbd> 새 탭</span><span class="hide-sm"><kbd>⇧⏎</kbd> 대시보드에서 보기</span><span class="sp"></span><span><kbd>esc</kbd> 닫기</span></div>
    </div>`;
    document.body.appendChild(root);
    palEl = root.querySelector(".pal");
    input = $("nsp-q"); res = $("nsp-res"); busyEl = $("nsp-busy");
    root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
    input.addEventListener("input", () => { st.q = input.value; st.sel = 0; st.selKey = null; refresh(); });
    input.addEventListener("keydown", onKey);
    res.addEventListener("mousemove", (e) => { const r = e.target.closest(".it"); if (r && +r.dataset.i !== st.sel) { st.sel = +r.dataset.i; st.selKey = st.rows[st.sel]?.key ?? null; paintSel(); } });
    res.addEventListener("click", (e) => {
      const clr = e.target.closest("[data-clear-recent]");
      if (clr) { lsSet(RECENT_KEY, "[]"); render(); input.focus(); return; }
      const r = e.target.closest(".it"); if (!r) return;
      act(st.rows[+r.dataset.i], e.metaKey || e.ctrlKey ? "newtab" : e.shiftKey ? "nav" : "enter");
    });
    // Header button, next to the nav (never inside it: the page iterates nav.children for the active tab).
    const nav = document.querySelector("nav.views, #views");
    if (nav) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn small nsp-btn"; b.id = "nsp-open";
      b.title = `검색 (${MOD}K 또는 /)`;
      b.innerHTML = `🔍 검색 <kbd>${MOD}K</kbd>`;
      b.addEventListener("click", () => open());
      nav.after(b);
    }
  }

  // ---------- open / close ----------
  function open(q) {
    if (!root) return;
    st.lastFocus = document.activeElement;
    st.open = true; st.detail = null;
    root.classList.add("open");
    if (typeof q === "string") input.value = q;
    st.q = input.value; st.sel = 0; st.selKey = null;
    input.select(); input.focus();
    render();
    loadData().then(() => { if (st.open) refresh(); });
  }
  function close() {
    if (!st.open) return;
    st.open = false;
    root.classList.remove("open");
    if (st.ctl) st.ctl.abort();
    if (st.lastFocus && st.lastFocus.focus && document.contains(st.lastFocus)) try { st.lastFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  // ---------- results ----------
  function localHits(toks) {
    const now = Date.now(), out = [];
    for (const c of data.cands) { const score = scoreFields(c.fields, toks, c.ts, now); if (score > 0) out.push({ ...c, score }); }
    return out;
  }
  function merged() {
    const toks = tokenize(st.q);
    if (!toks.length) return [];
    const by = new Map();
    for (const h of localHits(toks)) by.set(`${h.type}:${h.id}`, h);
    if (st.serverQ === st.q.trim()) for (const h of st.server) { const k = `${h.type}:${h.id}`; if (!by.has(k)) by.set(k, { ...h, remote: true }); }
    return [...by.values()];
  }
  function refresh() {
    render();
    clearTimeout(st.timer);
    const q = st.q.trim();
    if (!q) return;
    st.timer = setTimeout(() => fetchServer(q), SERVER_DEBOUNCE);
  }
  async function fetchServer(q) {
    if (st.ctl) st.ctl.abort();
    const ctl = (st.ctl = new AbortController());
    busyEl.classList.add("on");
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=50`, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`/api/search → ${r.status}`);
      const hits = await r.json();
      if (ctl.signal.aborted || q !== st.q.trim()) return;
      st.server = Array.isArray(hits) ? hits.map((h) => ({ ...h, url: safeUrl(h.url) })) : []; st.serverQ = q;
      if (st.open && !st.detail) render();
    } catch (e) {
      if (e.name !== "AbortError") console.warn("[search]", e.message);
    } finally {
      if (st.ctl === ctl) { st.ctl = null; busyEl.classList.remove("on"); }
    }
  }

  function rowHtml(h, i, toks) {
    const tm = h.type === "settings" ? "" : rel(h.ts);
    return `<div class="it${h.type === "todo" && h.done ? " done" : ""}" role="option" id="nsp-o${i}" data-i="${i}" aria-selected="false">
      <span class="ic" aria-hidden="true">${iconOf(h)}</span>
      <span class="tt">${hl(h.title, toks)}</span>
      <span class="sb">${hl(h.detail || "", toks)}</span>
      <span class="rt">${tm ? `<span class="tm">${esc(tm)}</span>` : ""}<span>${h.url ? `<span class="chip url" title="링크 있음">↗</span> ` : ""}<span class="chip">${esc(TAB_KO[h.tab] || h.tab)}</span></span></span>
    </div>`;
  }

  function render() {
    if (!st.open) return;
    if (st.detail) return renderDetail();
    const toks = tokenize(st.q);
    let html = "";
    const rows = [];
    if (!toks.length) {
      const rq = recents();
      if (rq.length) {
        html += `<div class="gh">최근 검색<span class="sp"></span><button type="button" data-clear-recent>지우기</button></div>`;
        for (const q of rq) { const i = rows.length; rows.push({ key: `recent:${q}`, type: "recent", q }); html += `<div class="it" role="option" id="nsp-o${i}" data-i="${i}" aria-selected="false"><span class="ic" aria-hidden="true">🕘</span><span class="tt">${esc(q)}</span><span class="sb">다시 검색</span><span class="rt"></span></div>`; }
      }
      const att = data.cands.filter((c) => c.type === "attention").sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, PER_GROUP);
      if (att.length) {
        html += `<div class="gh">${esc(GROUP_LABEL.attention)}<span class="n">${att.length}</span></div>`;
        for (const h of att) { const i = rows.length; rows.push({ ...h, key: `${h.type}:${h.id}` }); html += rowHtml(h, i, []); }
      }
      if (!rows.length) html = `<div class="none">${data.at ? `무엇이든 찾아 줄게. 제목·키·채널·사람 이름 아무거나 — 초성(ㄹㅂ)도 돼.` : "불러오는 중…"}</div>`;
    } else {
      const hits = merged();
      for (const [type, label] of GROUPS) {
        const g = hits.filter((h) => h.type === type).sort((a, b) => b.score - a.score || (b.ts || 0) - (a.ts || 0));
        if (!g.length) continue;
        html += `<div class="gh">${esc(label)}<span class="n">${g.length > PER_GROUP ? `${PER_GROUP} / ${g.length}` : g.length}</span></div>`;
        for (const h of g.slice(0, PER_GROUP)) { const i = rows.length; rows.push({ ...h, key: `${h.type}:${h.id}` }); html += rowHtml(h, i, toks); }
      }
      if (!rows.length) html = `<div class="none">${st.serverQ === st.q.trim() ? `‘${esc(st.q.trim())}’ — 못 찾았어.` : "찾는 중…"}</div>`;
    }
    st.rows = rows;
    if (st.selKey) { const i = rows.findIndex((r) => r.key === st.selKey); if (i >= 0) st.sel = i; }
    st.sel = Math.max(0, Math.min(st.sel, rows.length - 1));
    st.selKey = rows[st.sel]?.key ?? null;
    res.innerHTML = html;
    paintSel();
  }
  function paintSel() {
    for (const el of res.querySelectorAll(".it.sel")) { el.classList.remove("sel"); el.setAttribute("aria-selected", "false"); }
    const el = res.querySelector(`.it[data-i="${st.sel}"]`);
    if (el) { el.classList.add("sel"); el.setAttribute("aria-selected", "true"); el.scrollIntoView({ block: "nearest" }); input.setAttribute("aria-activedescendant", el.id); }
    else input.removeAttribute("aria-activedescendant");
  }
  function move(d) {
    if (!st.rows.length) return;
    st.sel = (st.sel + d + st.rows.length) % st.rows.length;
    st.selKey = st.rows[st.sel].key;
    paintSel();
  }

  // ---------- keys ----------
  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return; // Korean IME composing: let it finish
    if (st.detail) {
      if (e.key === "Escape" || e.key === "ArrowLeft" || (e.key === "Backspace" && !input.value)) { e.preventDefault(); st.detail = null; render(); return; }
      if (e.key === "Enter" && st.detail.url) { e.preventDefault(); window.open(st.detail.url, "_blank", "noopener"); return; }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); if (input.value) { input.value = ""; st.q = ""; refresh(); } else close(); return; }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); move(1); return; }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); move(-1); return; }
    if (e.key === "Tab") { e.preventDefault(); move(e.shiftKey ? -1 : 1); return; }
    if (e.key === "Enter") { e.preventDefault(); const r = st.rows[st.sel]; if (r) act(r, e.metaKey || e.ctrlKey ? "newtab" : e.shiftKey ? "nav" : "enter"); }
  }

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault(); e.stopPropagation();
      if (st.open) close(); else open();
      return;
    }
    if (st.open) {
      if (e.key === "Escape" && !palEl.contains(e.target)) { e.preventDefault(); close(); }
      return;
    }
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !editable(e.target)) { e.preventDefault(); e.stopPropagation(); open(); }
  }, true);

  // ---------- actions ----------
  function act(r, how) {
    if (!r) return;
    if (r.type === "recent") { input.value = r.q; st.q = r.q; st.sel = 0; st.selKey = null; refresh(); input.focus(); return; }
    pushRecent(st.q);
    if (how === "newtab") {
      if (r.url) { window.open(r.url, "_blank", "noopener"); return; } // palette stays open: open several in a row
      how = "nav";
    }
    if (how === "enter" && r.url) { window.open(r.url, "_blank", "noopener"); close(); return; }
    navigate(r);
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  async function until(fn, ms = 1200) {
    const t0 = performance.now();
    for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) return null; await nextFrame(); }
  }
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  /**
   * Highlight `el` with a fixed overlay rather than a class: the page re-renders its lists on every poll
   * (innerHTML), which would drop a class. `relocate` re-finds the element after such a re-render.
   */
  function flash(el, relocate) {
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    for (const old of document.querySelectorAll(".nsp-hl")) old.remove();
    const box = document.createElement("div");
    box.className = "nsp-hl";
    box.dataset.target = txt(el).slice(0, 80);
    document.body.appendChild(box);
    let cur = el;
    const t0 = performance.now();
    const tick = () => {
      if (!cur.isConnected && relocate) cur = relocate() || cur;
      const r = cur.isConnected ? cur.getBoundingClientRect() : null;
      if (r && r.width) Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      if (performance.now() - t0 < 2200) requestAnimationFrame(tick); else box.remove();
    };
    tick();
  }
  const finder = (sel, match) => () => [...document.querySelectorAll(sel)].find(match) || null;
  async function goTab(tab) {
    if ((location.hash || "#home").slice(1) !== tab) location.hash = `#${tab}`;
    return until(() => { const v = $(`v-${tab}`); return v && !v.hidden ? v : null; });
  }
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const sameText = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.includes(b) || (b.length > 24 && a.includes(b.slice(0, 24)))); };
  /** Click "전체" in a source-pill row if a filter is active. */
  function clearPills(view) { const all = document.querySelector(`[data-pf="${view}"][data-k=""]`); if (all && all.getAttribute("aria-pressed") !== "true") { all.click(); return true; } return false; }
  async function findRow(sel, match) { return until(() => [...document.querySelectorAll(sel)].find(match), 600); }

  async function navigate(h) {
    close();
    await goTab(h.tab);
    await nextFrame();
    try {
      if (await NAV[h.type]?.(h)) return;
    } catch (e) { console.warn("[search] navigate", e); }
    // Not on screen (older than what the page loaded, filtered out…): show it in the palette instead.
    openDetail(h);
  }

  async function inboxTab(t) {
    const b = await until(() => document.querySelector(`#tabs [data-t="${t}"]`));
    if (b && !b.classList.contains("on")) b.click();
    await nextFrame();
  }
  async function inboxRow(match) {
    let row = await findRow("#items .row", match);
    if (!row && clearPills("inbox")) row = await findRow("#items .row", match);
    if (!row) return false;
    row.click();
    flash(document.querySelector("#items .row.sel") || row, () => document.querySelector("#items .row.sel"));
    return true;
  }
  const CARD_EL = { cal: "cal-card", todo: "todo-card", mail: "sc-mail", jira: "sc-jira", slack: "sc-slack", gh: "sc-gh" };
  async function homeCard(h) {
    const which = h.anchor.split(":")[1], card = $(CARD_EL[which]);
    if (!card) return false;
    if (!visible(card)) { clearPills("home"); await nextFrame(); }
    if (card.classList.contains("scard") && !card.classList.contains("open")) card.querySelector(".sh[data-card]")?.click();
    if (which === "todo") for (const d of card.querySelectorAll("details")) if (!d.open && [...d.querySelectorAll(".tt")].some((t) => sameText(txt(t), h.title))) d.open = true;
    const isMe = (x) => sameText(txt(x.querySelector(".tt")), h.title);
    let el = await findRow(`#${card.id} .ti`, isMe);
    if (!el && (which === "mail" || which === "slack")) {
      const all = card.querySelector(`[data-vm="${which}"][data-mode="all"]`);
      if (all) { all.click(); el = await findRow(`#${card.id} .ti`, isMe); }
    }
    if (which === "cal") {
      el = [...card.querySelectorAll("#agenda *")].filter((x) => x.children.length <= 2 && sameText(txt(x), h.title) && txt(x).length < h.title.length + 40).pop() || null;
      card.focus({ preventScroll: true });
    }
    flash(el || card, el && which !== "cal" ? finder(`#${card.id} .ti`, isMe) : () => $(CARD_EL[which]));
    return true;
  }
  const NAV = {
    async attention(h) { await inboxTab("priority"); return inboxRow((r) => sameText(txt(r.querySelector(".tt")), h.title)); },
    async session(h) {
      await inboxTab("priority");
      if (await inboxRow((r) => txt(r.querySelector(".tt")).startsWith(`${h.title}:`))) return true;
      const unit = [...document.querySelectorAll("#rail .unit, #msess-rack .unit")].find((u) => visible(u) && txt(u.querySelector(".nm")).startsWith(h.title))
        || (() => { const m = $("msess"); if (m && visible(m)) { m.open = true; return [...m.querySelectorAll(".unit")].find((u) => txt(u.querySelector(".nm")).startsWith(h.title)); } return null; })();
      if (unit) { flash(unit, finder("#rail .unit, #msess-rack .unit", (u) => visible(u) && txt(u.querySelector(".nm")).startsWith(h.title))); return true; }
      return false;
    },
    async briefing(h) {
      await inboxTab("history");
      const hm = hhmm(h.ts);
      return inboxRow((r) => txt(r.querySelector(".tm")) === hm && (r.classList.contains("okr") ? h.status === "NED_OK" : sameText(txt(r.querySelector(".tt")), h.title) || !h.title));
    },
    calendar: homeCard, jira: homeCard, github: homeCard, mail: homeCard, slack: homeCard, todo: homeCard,
    async event(h) {
      for (const f of ["type", "wt"]) { const b = document.querySelector(`[data-f="${f}"][data-k=""]`); if (b && !b.classList.contains("on")) { b.click(); await nextFrame(); } }
      const day = dayLabel(h.ts), hm = hhmm(h.ts);
      const locate = () => {
        const head = [...document.querySelectorAll("#timeline li.dayh")].find((li) => txt(li) === day);
        if (!head) return null;
        let hit = null;
        for (let li = head.nextElementSibling; li && !li.classList.contains("dayh"); li = li.nextElementSibling) {
          if (txt(li.querySelector(".t")) !== hm) continue;
          if (!hit) hit = li;
          if (sameText(txt(li.querySelector(".msg")), h.title) || sameText(txt(li.querySelector(".kind")), h.title)) { hit = li; break; }
        }
        return { head, hit };
      };
      const found = await until(locate, 600);
      if (!found) return false;
      flash(found.hit || found.head, () => { const f = locate(); return f && (f.hit || f.head); });
      return !!found.hit;
    },
    async settings(h) {
      const el = await until(() => $(h.anchor.slice(3)));
      if (!el) return false;
      flash(el.closest(".f") || el, () => { const x = $(h.anchor.slice(3)); return x && (x.closest(".f") || x); });
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) setTimeout(() => el.focus({ preventScroll: true }), 350);
      return true;
    },
  };

  // ---------- detail (items not on screen) ----------
  function openDetail(h) {
    open(st.q);
    st.detail = h;
    renderDetail();
  }
  function renderDetail() {
    const h = st.detail, d = h.ts ? new Date(h.ts) : null;
    let body = "";
    if (h.type === "briefing" && Array.isArray(h.items)) {
      for (const sec of ["action_items", "updates", "fyi", "sessions"]) {
        const xs = h.items.filter((x) => x.section === sec);
        if (!xs.length) continue;
        body += `<h3>${esc(SEC_KO[sec])}</h3><ul>${xs.map((x) => { const u = safeUrl(x.url); return `<li>${KIND_ICON[x.kind] ? KIND_ICON[x.kind] + " " : ""}${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}${x.detail ? `<div class="d">${esc(x.detail)}</div>` : ""}</li>`; }).join("")}</ul>`;
      }
      if (!body) body = `<div class="body">${h.status === "NED_OK" ? "이상 무 — 조용한 순찰." : "항목 없음."}</div>`;
    } else {
      body = `<div class="body">${esc(h.body || h.detail || "")}</div>`;
    }
    res.innerHTML = `<div class="dv">
      <div class="crumb"><span>${iconOf(h)} ${esc(GROUP_LABEL[h.type] || h.type)}</span>${d ? `<span>· ${esc(dayLabel(h.ts))} ${hhmm(h.ts)} (${esc(rel(h.ts))})</span>` : ""}<span class="chip">${esc(TAB_KO[h.tab] || h.tab)}</span></div>
      <h2>${esc(h.title)}</h2>
      ${h.type === "briefing" ? `<div class="crumb">${esc(h.detail || "")}</div>` : h.body ? `<div class="crumb">${esc(h.detail || "")}</div>` : ""}
      ${body}
      <h3>안내</h3><div class="crumb">대시보드엔 지금 안 보이는 항목이야 (오래됐거나 필터에 가려짐). <kbd>esc</kbd> / <kbd>←</kbd> 목록으로${h.url ? ` · <kbd>⏎</kbd> 링크 열기` : ""}</div>
    </div>`;
  }

  // ---------- boot ----------
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  // Small public hook for other scripts / tests.
  window.NedSearch = { open, close, refresh: () => loadData(true).then(render) };
})();
