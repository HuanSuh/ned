/* Ned 통신기 (comms) — the DOM-free half: SSE parser, markdown-lite, the 메시지 feed and every HTML string.
 * features/comms.js mounts and wires it; tests import this file directly (no document at import). */
import { esc, safeUrl } from "../util.js";
import { parseActionBlock, renderActionCard } from "./chat-action.js";

// ---------- persona wording (structure is shared; only words + theme tokens change) ----------
export const COMMS_VOICE = {
  ned: { tag: "NED · NET", title: "Ned Net", live: "수신 중", idle: "연결됨", off: "신호 끊김", calling: (n) => `Ned: 새 메시지 ${n}건`, quiet: "새 소식 없음", thinking: "찾아보는 중…", placeholder: "Ned 에게 물어봐…", empty: "뭐든 물어봐. 오늘 일정, 답할 거, PR 상태 — 아는 건 바로, 모르는 건 찾아볼게.", noMsgs: "새로 온 건 없어.", ask: "Ned 에게 묻기" },
  alfred: { tag: "ALFRED · 인터폰", title: "인터폰", live: "호출 중", idle: "대기 중", off: "연결 끊김", calling: (n) => `호출 ${n}건`, quiet: "새 호출 없음", thinking: "알아보는 중입니다…", placeholder: "말씀하십시오…", empty: "무엇이든 여쭈어 주십시오. 일정, 회신할 일, PR 현황을 바로 아뢰겠습니다.", noMsgs: "새로 들어온 소식은 없습니다.", ask: "Alfred 에게 묻기" },
  oracle: { tag: "ORACLE · LINK", title: "CLOCKTOWER LINK", live: "RX", idle: "LINK OK", off: "NO SIGNAL", calling: (n) => `신호 ${n}`, quiet: "신호 없음", thinking: "조회 중…", placeholder: "질의 입력 >", empty: "질의 대기. 일정 · 답할 것 · PR 상태 즉시 응답.", noMsgs: "수신 신호 없음.", ask: "Oracle 에게 질의" },
  jarvis: { tag: "JARVIS · 링크", title: "Jarvis 링크", live: "수신", idle: "온라인", off: "오프라인", calling: (n) => `알림 ${n}건`, quiet: "새 알림 0건", thinking: "분석 중…", placeholder: "무엇을 확인할까요?", empty: "무엇이든 물어보세요. 일정 · 응답 대기 · PR 현황을 바로 정리해 드릴게요.", noMsgs: "새 알림이 없어요.", ask: "Jarvis 에게 묻기" },
};
export const commsVoice = (p) => COMMS_VOICE[p] || COMMS_VOICE.ned;

// ---------- greeting (new chat: Ned speaks first, a different line each time) ----------
/** Per persona: [새벽 <5, 아침 <12, 오후 <18, 저녁] → candidate opening lines. The hint (voice.empty) follows as a second line. */
export const COMMS_HELLO = {
  ned: [
    ["아직 안 잤어? 나도 깨어 있어.", "새벽 근무 동지네. 뭐 찾아줄까?", "늦었다. 빨리 끝내고 자자 — 뭐 필요해?"],
    ["좋은 아침! 오늘 뭐부터 볼까?", "굿모닝. 커피 한 잔 하면서 물어봐.", "아침이야. 오늘 일정부터 훑어줄까?", "왔구나! 밤사이 온 거 정리해 줄 수 있어."],
    ["오후 체크인. 뭐 막힌 거 있어?", "점심은 먹었어? 필요한 거 말해.", "오후도 달려보자. 뭐 찾아줄까?", "여기 있어. 궁금한 거 던져봐."],
    ["저녁이네. 오늘 마무리할 거 있어?", "퇴근 전에 놓친 거 없나 볼까?", "수고했어. 남은 거 같이 정리하자.", "아직 일하는 중? 도와줄게."],
  ],
  alfred: [
    ["늦은 시간까지 수고가 많으십니다. 무엇을 도와드릴까요?", "밤이 깊었습니다. 필요한 것이 있으시면 말씀하십시오."],
    ["좋은 아침입니다. 오늘 일정부터 아뢸까요?", "아침 준비는 끝났습니다. 무엇부터 보시겠습니까?", "평안한 아침입니다. 분부만 내리십시오."],
    ["오후입니다. 살펴 드릴 일이 있으신지요?", "차 한 잔 곁들이시지요. 무엇을 알아볼까요?", "대기하고 있습니다. 말씀하십시오."],
    ["저녁입니다. 오늘 정리할 일이 남으셨습니까?", "하루 수고 많으셨습니다. 마무리를 도와드리지요.", "늦지 않게 끝내시지요. 무엇이 필요하십니까?"],
  ],
  oracle: [
    ["[야간] 채널 열림. 질의하라.", "[야간] 아직 접속 중이군. 무엇을 찾나?"],
    ["[오전] 링크 확립. 오늘 무엇을 조회할까?", "[오전] 시계탑 온라인. 질의 대기.", "[오전] 신호 양호. 첫 질의를 보내라."],
    ["[오후] 링크 안정. 무엇을 추적할까?", "[오후] 대기 중. 필요한 정보를 말하라.", "[오후] 모든 채널 감시 중. 질의하라."],
    ["[야간] 링크 유지 중. 마무리 점검할까?", "[야간] 오늘의 신호 정리 가능. 질의하라.", "[야간] 아직 근무 중이군. 무엇을 찾나?"],
  ],
  jarvis: [
    ["늦은 시간이네요. 무엇을 확인해 드릴까요?", "아직 작업 중이시군요. 필요한 걸 말씀하세요."],
    ["좋은 아침이에요. 오늘 일정부터 볼까요?", "모든 시스템 정상이에요. 무엇부터 시작할까요?", "아침 브리핑 준비됐어요. 물어보세요."],
    ["오후 현황 점검할까요?", "온라인이에요. 무엇을 분석해 드릴까요?", "오후도 순조롭게 가 보죠. 필요한 게 있나요?"],
    ["저녁이에요. 오늘 남은 일을 정리해 드릴까요?", "하루 마무리 점검, 시작할까요?", "수고하셨어요. 놓친 게 없는지 볼까요?"],
  ],
};
const helloBucket = (h) => (h < 5 ? 0 : h < 12 ? 1 : h < 18 ? 2 : 3);
/** Pick an opening line for persona `p` at hour `h`; `seed` (e.g. Date.now() at chat start) varies it per chat. */
export function helloLine(p, h, seed = 0) {
  const lines = (COMMS_HELLO[p] || COMMS_HELLO.ned)[helloBucket(h)];
  return lines[Math.abs(Math.floor(seed)) % lines.length];
}

// ---------- panel size (resize handles; persisted as ned.comms.size) ----------
/** Expanded-panel size limits: min 360×420, max viewport − 32 on each axis; default 420×620. */
export const COMMS_SIZE = { minW: 360, minH: 420, defW: 420, defH: 620, gap: 32 };
/** Clamp {w,h} to [min, viewport − gap]; when the viewport is smaller than the minimum, the minimum wins (CSS caps it visually). */
export function clampSize(s, vw, vh) {
  const { minW, minH, gap } = COMMS_SIZE;
  const fit = (v, min, vp) => Math.round(Math.max(min, Math.min(Number(v), vp - gap)));
  return { w: fit(s.w, minW, vw), h: fit(s.h, minH, vh) };
}
/** Restore a saved size (localStorage JSON) → clamped {w,h}, or null (= default size) for missing / malformed values. */
export function readSize(raw, vw, vh) {
  let v = null; try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (!v || !Number.isFinite(Number(v.w)) || !Number.isFinite(Number(v.h)) || v.w === null || v.h === null) return null;
  return clampSize(v, vw, vh);
}

// ---------- SSE ----------
/**
 * Incremental text/event-stream parser: feed() any chunk boundaries (mid-line, mid-frame, \r\n), get onEvent(event, data)
 * per complete frame. `data` is JSON-parsed when it parses, else the raw string. Comment lines (":") are ignored.
 */
export function createSseParser(onEvent) {
  let buf = "", ev = "message", data = [];
  const dispatch = () => {
    if (!data.length) { ev = "message"; return; }
    const raw = data.join("\n");
    let v = raw; try { v = JSON.parse(raw); } catch { /* raw string */ }
    onEvent(ev, v);
    ev = "message"; data = [];
  };
  const line = (l) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const i = l.indexOf(":"), field = i < 0 ? l : l.slice(0, i);
    let val = i < 0 ? "" : l.slice(i + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") ev = val || "message";
    else if (field === "data") data.push(val);
  };
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
        if (buf[i] === "\r" && i === buf.length - 1) break; // a lone \r at the end may be half of \r\n
        const n = buf[i] === "\r" && buf[i + 1] === "\n" ? 2 : 1;
        line(buf.slice(0, i)); buf = buf.slice(i + n);
      }
    },
    end() { if (buf) { line(buf); buf = ""; } dispatch(); },
  };
}

// ---------- markdown-lite: line breaks, links, `code`, ```fences```, **bold** — everything else escaped ----------
function inline(s) {
  const out = [];
  // Tokens: `code` | [text](url) | bare url | **bold**
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*\*([^*\n]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    out.push(esc(s.slice(last, m.index)));
    if (m[1] != null) out.push(`<code>${esc(m[1])}</code>`);
    else if (m[2] != null) { const u = safeUrl(m[3]); out.push(u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(m[2])}</a>` : esc(m[0])); }
    else if (m[4] != null) { const u = safeUrl(m[4]); out.push(u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.length > 60 ? u.slice(0, 57) + "…" : u)}</a>` : esc(m[0])); }
    else out.push(`<b>${esc(m[5])}</b>`);
    last = re.lastIndex;
  }
  out.push(esc(s.slice(last)));
  return out.join("");
}
export function mdLite(text) {
  const parts = String(text ?? "").split(/```[^\n`]*\n?/);
  return parts.map((p, i) => (i % 2 ? `<pre><code>${esc(p.replace(/\n$/, ""))}</code></pre>` : p.split("\n").map(inline).join("<br>"))).join("");
}

// ---------- 메시지 feed ----------
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const KIND_ICON = { session: "🖥", email: "✉️", slack: "💬", jira: "📋", github: "🐙", sentry: "🐞", calendar: "📅", other: "🔔", briefing: "📡", thread: "🧵", chat: "🗨" };
export const DAY_MS = 24 * 3600_000;

/**
 * What arrived: open attention items, recent briefing headlines (24h), Slack threads with replies after mine, and Ned's
 * chat answers that landed while the panel was closed. Newest first; `unread` = key not in `seen`.
 */
export function buildFeed({ state, briefings = [], agenda = null, chatNotes = [] } = {}, seen = new Set(), now = Date.now()) {
  const out = [];
  const urls = new Set();
  for (const a of state?.attention || []) {
    if (a.reviewed_at) continue;
    out.push({ key: `att:${a.id}`, kind: a.kind || "other", title: clip(a.title, 120), detail: clip(a.detail, 120), url: safeUrl(a.url), ts: a.ts || 0, go: a.source === "sessions" ? "inbox" : "inbox" });
    if (a.url) urls.add(a.url);
  }
  for (const b of briefings || []) {
    if (b.status !== "UPDATE" || !b.headline || now - (b.ts || 0) > DAY_MS) continue;
    out.push({ key: `brief:${b.id}`, kind: "briefing", title: clip(b.headline, 120), detail: `${b.type === "daily" ? "아침 브리핑" : "순찰"} · ${(b.action_items || []).length}건`, url: null, ts: b.ts, go: "inbox" });
  }
  for (const t of agenda?.slack?.threads || []) {
    if (!(t.new_since_me > 0) || (t.url && urls.has(t.url))) continue;
    out.push({ key: `thr:${t.key}@${t.last_reply_ts || ""}`, kind: "thread", title: clip(`${t.channel || "Slack"} · 내 답 이후 새 답글 ${t.new_since_me}건`, 120), detail: clip(`${t.last_reply_from ? t.last_reply_from + ": " : ""}${t.last_reply_text || t.thread_summary || ""}`, 120), url: safeUrl(t.url), ts: Date.parse(t.last_reply_at || "") || 0, go: "home" });
  }
  for (const c of chatNotes) out.push({ key: c.key, kind: "chat", title: clip(c.title, 120), detail: clip(c.detail, 120), url: null, ts: c.ts, go: "chat" });
  out.sort((x, y) => y.ts - x.ts);
  return out.map((x) => ({ ...x, icon: KIND_ICON[x.kind] || "🔔", unread: !seen.has(x.key) }));
}

export function feedHtml(items, voice, relFn = () => "") {
  if (!items.length) return `<div class="cm-none">${esc(voice.noMsgs)}</div>`;
  return items.map((x, i) => `<button type="button" class="cm-it${x.unread ? " new" : ""}" data-fi="${i}" title="${esc(x.url ? "열기 (새 탭) · 읽음 처리" : "대시보드에서 보기 · 읽음 처리")}">
  <span class="ic" aria-hidden="true">${x.icon}</span><span class="tt">${esc(x.title)}</span><span class="tm">${esc(relFn(x.ts))}</span>${x.detail ? `<span class="sb">${esc(x.detail)}</span>` : ""}${x.unread ? '<span class="dot" aria-label="안 읽음"></span>' : ""}
</button>`).join("");
}

// ---------- chat ----------
export const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

/** A ned answer's body: its text + the 확인 카드 for a ```ned-action block (chat-action.js). `cardState(m)` → card state. */
function nedBody(m, cardState) {
  const pa = parseActionBlock(m.text);
  if (!pa.block && !pa.error) return m.text ? mdLite(m.text) : "";
  const card = pa.block ? renderActionCard(pa.block, cardState(m, pa.block), { id: String(m.ts) }) : `<div class="cm-act bad">⚠ ${esc(pa.error)}</div>`;
  return (pa.text ? mdLite(pa.text) : "") + card;
}
const defaultCardState = (m) => ({ status: m.action?.state || "idle", text: m.action?.text, result: m.action?.result });

/** Message list. `live` = the streaming answer ({ text, tool, thinking }) or null. `cardState(m, block)` → 확인 카드 state. */
export function messagesHtml(msgs, voice, live = null, timeFn = () => "", hello = "", cardState = defaultCardState) {
  if (!msgs.length && !live) return hello
    ? `<div class="cm-msg ned hello"><div class="bb"><b class="hi">${esc(hello)}</b><span class="hint">${esc(voice.empty)}</span></div></div>`
    : `<div class="cm-empty">${esc(voice.empty)}</div>`;
  const row = (m) => {
    const me = m.role === "user";
    const meta = [timeFn(m.ts), !me && m.cost_usd ? usd(m.cost_usd) : "", m.stopped ? "중단됨" : ""].filter(Boolean).join(" · ");
    return `<div class="cm-msg ${me ? "me" : "ned"}${m.error ? " err" : ""}"><div class="bb">${m.text ? (me || m.error ? mdLite(m.text) : nedBody(m, cardState)) : m.stopped ? "<i>(멈춤)</i>" : ""}${m.error ? `<div class="cm-err">⚠ ${esc(m.error)}</div>` : ""}</div>${meta ? `<div class="mm">${esc(meta)}</div>` : ""}</div>`;
  };
  let html = msgs.map(row).join("");
  const lp = live ? parseActionBlock(live.text) : null; // a proposal shows as a card once the answer is done
  if (live) html += `<div class="cm-msg ned live"><div class="bb">${lp.text ? mdLite(lp.text) : ""}${lp.block || lp.pending ? `<div class="cm-act s-pending">⚡ 실행 제안 준비 중…</div>` : ""}<div class="cm-think"><span class="spin"></span>${esc(live.tool ? `${voice.thinking} ${live.tool}` : voice.thinking)}</div></div></div>`;
  return html;
}

/** The collapsed module's ticker line + badge count. */
export function tickerOf(feed, voice, { conn = true, running = false } = {}) {
  const unread = feed.filter((x) => x.unread);
  if (!conn) return { status: voice.off, line: "", n: 0, led: "off" };
  if (running) return { status: voice.live, line: voice.thinking, n: unread.length, led: "rx" };
  if (unread.length) return { status: voice.calling(unread.length), line: unread[0].title, n: unread.length, led: "rx" };
  return { status: voice.idle, line: voice.quiet, n: 0, led: "ok" };
}

/** Static skeleton (both states); comms.js fills the parts by id. `mark` is the persona's mini SVG. */
export function shellHtml(voice, mark, mod = "⌘") {
  return `<div class="cm-dock" id="cm-dock" role="button" tabindex="0" aria-label="${esc(voice.title)} 열기 (${mod}J)" aria-expanded="false" aria-controls="cm-panel" title="${esc(voice.title)} — 클릭 또는 ${mod}J · 끌어서 옮기기">
  <span class="cm-ring"><span class="cm-mk" id="cm-mk1">${mark}</span><span class="cm-led" id="cm-led"></span></span>
  <span class="cm-tx"><b id="cm-st"></b><span class="cm-tk" id="cm-tk"></span></span>
  <span class="cm-badge" id="cm-badge" hidden></span>
</div>
<section class="cm-panel" id="cm-panel" role="dialog" aria-label="${esc(voice.title)}" hidden>
  <header class="cm-hd"><span class="cm-ring sm"><span class="cm-mk" id="cm-mk2">${mark}</span></span><span class="cm-ti"><i class="cm-tag" id="cm-tag">${esc(voice.tag)}</i><b id="cm-title">${esc(voice.title)}</b><span id="cm-sub"></span></span><span class="sp"></span>
    <span class="cm-cost" id="cm-cost" title="이 대화 비용 · 오늘 claude -p 합계"></span>
    <button type="button" class="btn small" id="cm-new" title="새 대화">새 대화</button>
    <button type="button" class="btn small cm-x" id="cm-close" aria-label="접기" title="접기 (Esc)">▾</button></header>
  <nav class="cm-tabs" role="tablist"><button type="button" role="tab" id="cm-t-chat" data-cmtab="chat" aria-selected="true">대화</button><button type="button" role="tab" id="cm-t-msgs" data-cmtab="msgs" aria-selected="false">메시지<span class="n" id="cm-tn"></span></button><span class="sp"></span><button type="button" class="lnk" id="cm-allread" hidden>모두 읽음</button></nav>
  <div class="cm-body" id="cm-chat" role="tabpanel" aria-labelledby="cm-t-chat">
    <div class="cm-log" id="cm-log" aria-live="polite"></div>
    <form class="cm-in" id="cm-form" autocomplete="off"><textarea id="cm-q" rows="2" maxlength="2000" placeholder="${esc(voice.placeholder)}" aria-label="질문"></textarea>
      <div class="cm-ft"><span class="cm-hint"><kbd>⏎</kbd> 전송 · <kbd>⇧⏎</kbd> 줄바꿈<span id="cm-len"></span></span><span class="sp"></span><button type="submit" class="btn small go" id="cm-send">전송</button></div></form>
  </div>
  <div class="cm-body" id="cm-msgs" role="tabpanel" aria-labelledby="cm-t-msgs" hidden><div class="cm-feed" id="cm-feed"></div></div>
  <i class="cm-rs" data-rs="w" aria-hidden="true" title="끌어서 폭 조절 · 더블클릭: 기본 크기"></i><i class="cm-rs" data-rs="n" aria-hidden="true" title="끌어서 높이 조절 · 더블클릭: 기본 크기"></i><i class="cm-rs" data-rs="nw" aria-hidden="true" title="끌어서 크기 조절 · 더블클릭: 기본 크기"></i>
</section>`;
}
