/* Ned 통신기 (comms) — the DOM-free half: SSE parser, markdown-lite, the 메시지 feed and every HTML string.
 * features/comms.js mounts and wires it; tests import this file directly (no document at import). */
import { esc, safeUrl } from "../util.js";
import { mentionMap, parseActionBlock, renderActionCard } from "./chat-action.js";
import { parseOutputBlock, renderOutputCard } from "./chat-output.js";
import { agendaIndex, sourceParts, srcBtn } from "./focus.js";
import { slackReviewKey } from "./revkeys.js";

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
// Fenced blocks get a copy button (features/code-copy.js handles the click, delegated on document). The ```lang line is
// consumed by the split, so <pre><code>'s textContent is exactly the original block text — that's what gets copied.
const COPY_ICON = '<svg class="ic-copy" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'
  + '<svg class="ic-ok" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** = src/slack-mentions.ts NAME_PARTICLES: Hangul right after a name counts only as these particles (@사람A님, not @사람A준). */
const NAME_PARTICLES = "님|씨|께|에게|한테|이랑|랑|이|가|은|는|을|를|도|과|와|의";
/** `code` with each "@이름" of `mentions` ({"@이름": "<@U…>"}) replaced — same matching as the server. */
export function withMentionIds(code, mentions = {}) {
  let out = String(code ?? "");
  for (const k of Object.keys(mentions).sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(`${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9._-])(?=$|[^가-힣]|(?:${NAME_PARTICLES})+(?![가-힣]))`, "g"), mentions[k]);
  return out;
}
/**
 * A fenced block + copy button. With `mentions` (the answer's settled Slack mentions) and a block that names one of them,
 * a second option copies the text with `<@U…>` — Slack's input box may paste it as plain text (the real mention is Ned's send).
 */
export const codeBlockHtml = (code, mentions = null) => {
  const alt = mentions && Object.keys(mentions).length ? withMentionIds(code, mentions) : code;
  const menu = alt !== code
    ? `<span class="cm-copym"><button type="button" class="cm-copy-alt" data-alt="${esc(alt)}" title="Slack 입력창에 붙이면 글자로 들어갈 수 있음 — 진짜 멘션은 Ned 로 보내기">&lt;@U…&gt; 포함 복사</button><span class="cm-copyh">Slack 입력창에 붙이면 글자로 들어갈 수 있음 — 진짜 멘션은 Ned 로 보내기</span></span>`
    : "";
  return `<div class="cm-code"><button type="button" class="cm-copy" aria-label="${alt !== code ? "@이름 텍스트로 복사" : "복사"}" title="${alt !== code ? "@이름 텍스트로 복사" : "복사"}">${COPY_ICON}</button>${menu}<pre><code>${esc(code)}</code></pre></div>`;
};
// ---------- GFM tables (outside fences only) ----------
/** Cells of a `| a | b |` row: outer pipes dropped, split on unescaped `|`, `\|` → `|`, trimmed. */
export function splitRow(line) {
  let s = String(line).trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; } else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
const hasPipe = (l) => /(^|[^\\])\|/.test(l);
/** A delimiter row's per-column alignment ("" | "left" | "center" | "right"), or null when `line` isn't one. */
export function tableAligns(line) {
  if (!hasPipe(line) || !/-/.test(line)) return null;
  const cells = splitRow(line);
  if (!cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
}
/** Inline markdown → plain text (for TSV): `code` / [text](url) / **bold** lose their marks; bare urls stay. */
export const plainInline = (s) => String(s).replace(/`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*/g, (m, c, t, _u, b) => c ?? t ?? b ?? m);
/**
 * One TSV cell: tabs / newlines → spaces; a cell starting with = + - @ (not a plain number) gets a leading ' so a
 * spreadsheet doesn't run it as a formula (cells can carry model / read-message text); a cell with " is quoted
 * ("…", inner "" doubled) so the paste parser can't swallow the following tabs / rows.
 */
export function tsvCell(c) {
  let s = plainInline(c).replace(/[\t\r\n]+/g, " ");
  if (/^[=+\-@]/.test(s) && !/^[+-]?\d[\d,]*(\.\d+)?%?$/.test(s)) s = "'" + s;
  return s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Rows (header first, each already cut/filled to the header width) → TSV (tsvCell per cell). */
export const tableTsv = (rows) => rows.map((r) => r.map(tsvCell).join("\t")).join("\n");
/**
 * A table block + the code-block copy button (features/code-copy.js): main copy = the table's markdown source
 * (`data-md`), "TSV 복사" (.cm-copy-alt `data-alt`) = tab-separated plain text for spreadsheets / Confluence.
 * Only `.cm-tbl` scrolls sideways, so a wide table never widens the bubble.
 */
export function tableHtml(src, header, aligns, body) {
  const n = header.length;
  const fit = (r) => Array.from({ length: n }, (_, i) => r[i] ?? "");
  const rows = [header, ...body.map(fit)];
  const al = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : "");
  const tr = (r, tag) => `<tr>${r.map((c, i) => `<${tag}${al(i)}>${inline(c)}</${tag}>`).join("")}</tr>`;
  const tbody = rows.length > 1 ? `<tbody>${rows.slice(1).map((r) => tr(r, "td")).join("")}</tbody>` : "";
  const hint = "스프레드시트·Confluence 에 붙여넣기용 (탭으로 구분한 글)";
  return `<div class="cm-code cm-tablewrap" data-md="${esc(src)}"><button type="button" class="cm-copy" aria-label="표 복사 (마크다운)" title="표 복사 (마크다운)">${COPY_ICON}</button>`
    + `<span class="cm-copym"><button type="button" class="cm-copy-alt" data-alt="${esc(tableTsv(rows))}" title="${hint}">TSV 복사</button><span class="cm-copyh">${hint}</span></span>`
    + `<div class="cm-tbl"><table><thead>${tr(rows[0], "th")}</thead>${tbody}</table></div></div>`;
}
/**
 * Text outside fences: lines joined by <br>, except a header row + delimiter row (same column count) + body rows
 * (lines with a pipe, up to a blank / pipe-less line) → tableHtml. `openTail` (streaming, text without a final
 * newline): the last line is still being typed, so it never joins a table — a half-typed delimiter or row stays text.
 */
function textHtml(p, openTail = false) {
  const lines = p.split("\n");
  const end = openTail && lines.length ? lines.length - 1 : lines.length; // lines[end] (if any) is the unfinished one
  const out = [];
  let buf = [];
  const flush = () => { if (buf.length) out.push(buf.map(inline).join("<br>")); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    const aligns = i + 1 < end && hasPipe(head) ? tableAligns(lines[i + 1]) : null;
    const header = aligns ? splitRow(head) : null;
    if (!header || header.length !== aligns.length) { buf.push(head); continue; }
    let j = i + 2;
    while (j < end && lines[j].trim() && hasPipe(lines[j])) j++;
    if (buf.length && !buf[buf.length - 1].trim()) buf.pop(); // the table is a block: one blank line before it adds nothing
    flush();
    out.push(tableHtml(lines.slice(i, j).join("\n"), header, aligns, lines.slice(i + 2, j).map(splitRow)));
    i = j < lines.length && !lines[j].trim() ? j : j - 1; // …nor one right after it
  }
  flush();
  return out.join("");
}
/** `live`: the streaming answer — an unfinished last line stays text (see textHtml). */
export function mdLite(text, { mentions = null, live = false } = {}) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const parts = src.split(/```[^\n`]*\n?/);
  const tail = live && !src.endsWith("\n");
  return parts.map((p, i) => (i % 2 ? codeBlockHtml(p.replace(/\n$/, ""), mentions) : textHtml(p, tail && i === parts.length - 1))).join("");
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
  const index = agendaIndex(agenda), sessBy = Object.fromEntries((state?.sessions || []).map((s) => [s.id, s]));
  // target = what a click focuses in the inbox (features/focus.js resolveFocus); src = the short 출처 줄; srcKind = the 원문 button.
  for (const a of state?.attention || []) {
    if (a.reviewed_at) continue;
    const kind = a.kind || "other", sess = a.source === "sessions" ? sessBy[String(a.id).replace(/^session:/, "")] || null : null;
    out.push({ key: `att:${a.id}`, kind, title: clip(a.title, 120), detail: clip(a.detail, 120), url: safeUrl(a.url), ts: a.ts || 0, go: "inbox",
      target: { item: a.id, tab: "priority" }, srcKind: kind, src: sourceParts({ kind, url: a.url }, { index, sess, short: true }) });
    if (a.url) urls.add(a.url);
  }
  for (const b of briefings || []) {
    if (b.status !== "UPDATE" || !b.headline || now - (b.ts || 0) > DAY_MS) continue;
    out.push({ key: `brief:${b.id}`, kind: "briefing", title: clip(b.headline, 120), detail: `${b.type === "daily" ? "아침 브리핑" : "순찰"} · ${(b.action_items || []).length}건`, url: null, ts: b.ts, go: "inbox",
      target: { item: `bf:${b.id}`, tab: "history", ...((b.action_items || []).length ? { at: "action_items.0" } : {}) } });
  }
  for (const t of agenda?.slack?.threads || []) {
    if (!(t.new_since_me > 0) || (t.url && urls.has(t.url))) continue;
    const rk = slackReviewKey(t);
    // A thread lives on the home Slack card; it focuses an inbox row only when a 기타 item has the same message (else #home).
    out.push({ key: `thr:${t.key}@${t.last_reply_ts || ""}`, kind: "thread", title: clip(`${t.channel || "Slack"} · 내 답 이후 새 답글 ${t.new_since_me}건`, 120), detail: clip(`${t.last_reply_from ? t.last_reply_from + ": " : ""}${t.last_reply_text || t.thread_summary || ""}`, 120), url: safeUrl(t.url), ts: Date.parse(t.last_reply_at || "") || 0, go: "home",
      target: rk ? { item: rk, tab: "other" } : null, fallback: "home", srcKind: "slack" });
  }
  for (const c of chatNotes) out.push({ key: c.key, kind: "chat", title: clip(c.title, 120), detail: clip(c.detail, 120), url: null, ts: c.ts, go: "chat" });
  out.sort((x, y) => y.ts - x.ts);
  return out.map((x) => ({ ...x, icon: KIND_ICON[x.kind] || "🔔", unread: !seen.has(x.key) }));
}

export function feedHtml(items, voice, relFn = () => "") {
  if (!items.length) return `<div class="cm-none">${esc(voice.noMsgs)}</div>`;
  // The 원문 button sits beside (not inside) the row button — no nested interactive content.
  return items.map((x, i) => {
    const src = x.srcKind ? srcBtn(x.srcKind, x.url, "cm-src") : "";
    const line = x.src && x.src.length > 1 ? `<span class="srcl">${x.src.map(esc).join(" · ")}</span>` : "";
    const sb = line || x.detail ? `<span class="sb">${line}${line && x.detail ? " — " : ""}${x.detail ? esc(x.detail) : ""}</span>` : "";
    return `<div class="cm-row${src ? " has-src" : ""}"><button type="button" class="cm-it${x.unread ? " new" : ""}" data-fi="${i}" title="${esc(x.go === "chat" ? "대화에서 보기 · 읽음 처리" : "대시보드에서 이 항목 보기 · 읽음 처리")}">
  <span class="ic" aria-hidden="true">${x.icon}</span><span class="tt">${esc(x.title)}</span><span class="tm">${esc(relFn(x.ts))}</span>${sb}${x.unread ? '<span class="dot" aria-label="안 읽음"></span>' : ""}
</button>${src}</div>`;
  }).join("");
}

// ---------- chat ----------
export const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

/** A ned answer's body: its text + the 확인 카드 for a ```ned-action block (chat-action.js). `cardState(m)` → card state. */
function nedBody(m, cardState) {
  const po = parseOutputBlock(m.text); // 정리 결과물 (```ned-output → 저장 카드, chat-output.js)
  const out = po.block || m.output || m.output_error ? renderOutputCard({ out: m.output || null, err: m.output_error || "", block: po.block }, mdLite) : "";
  const pa = parseActionBlock(po.text);
  if (!pa.block && !pa.error) return (po.text ? mdLite(po.text) : "") + out;
  const cs = pa.block ? cardState(m, pa.block) : null;
  const card = pa.block ? renderActionCard(pa.block, cs, { id: String(m.ts) }) : `<div class="cm-act bad">⚠ ${esc(pa.error)}</div>`;
  // 복사용 초안: code blocks of this answer offer "<@U…> 포함 복사" for the proposal's settled mentions.
  const mentions = pa.block ? mentionMap(pa.block, cs?.mention_choices || {}) : null;
  return (pa.text ? mdLite(pa.text, { mentions }) : "") + out + card;
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
  const lo = live ? parseOutputBlock(live.text) : null; // a ned-output block shows as a 저장 카드 once saved
  const lp = live ? parseActionBlock(lo.text) : null; // a proposal shows as a card once the answer is done
  // Nothing after the text yet (no ned-output / ned-action block started) → its last line may be half-typed.
  // Judged on the raw stream: parseOutputBlock trims, so lp.text never ends with "\n" even when the line is done.
  const open = live && !(lo.block || lo.pending || lp.block || lp.pending) && !/\n$/.test(live.text ?? "");
  if (live) html += `<div class="cm-msg ned live"><div class="bb">${lp.text ? mdLite(lp.text, { live: open }) : ""}${lo.block || lo.pending ? `<div class="cm-out s-pending">📎 정리 결과 저장 준비 중…</div>` : ""}${lp.block || lp.pending ? `<div class="cm-act s-pending">⚡ 실행 제안 준비 중…</div>` : ""}<div class="cm-think"><span class="spin"></span>${esc(live.tool ? `${voice.thinking} ${live.tool}` : voice.thinking)}</div></div></div>`;
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
