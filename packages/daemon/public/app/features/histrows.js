/* 수집 이력 rows (GET /api/history items → html): day separators, state chips, ✎ / ⋯ / ✓ per row.
 * Pure — no fetch, no DOM (histview.js renders). */
import { draftFor } from "./draftref.js";
import { srcCheck, srcKey } from "./revkeys.js";
import { S } from "../state.js";
import { openIcon } from "../ui/icons.js";
import { WEEK, esc, ext, hhmm, midnight, safeUrl, toMs } from "../util.js";

const KIND = { slack: "slack", mail: "email", jira: "jira", github: "github", calendar: "calendar" };
/**
 * A history row (HistoryRow: key, source, ts, url, channel, item = the record's own fields) → the item shape the cards
 * hand to draftFor / srcCheck, so refs and 확인 keys match the card's row for the same message / thread:
 * Slack → url · channel · from · text · ts (+ the followed thread from agenda slack.threads: a reply after the ✓ reopens it);
 * mail → thread id · from · subject · snippet · why, with the row's ts (a newer message reopens it, like `received`).
 * null for a source with no item.
 */
export function histTarget(x, threads = S.agenda?.slack?.threads || []) {
  const kind = KIND[x?.source], it = x?.item || {};
  if (!kind) return null;
  if (kind === "slack") {
    const url = it.url || x.url || "";
    const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url), tt = /[?&]thread_ts=([\d.]+)/.exec(url)?.[1];
    const key = m ? `${m[1]}:${tt || `${m[2]}.${m[3]}`}` : "";
    const thread = key ? threads.find((t) => t.key === key) : undefined;
    return { kind, item: { url, channel: it.channel || it.watch?.channel || x.channel || "", from: it.from || "", text: it.text || it.ask || it.watch?.text || x.title || "", ts: it.ts || x.ts, ...(thread ? { thread } : {}) } };
  }
  if (kind === "email") return { kind, item: { ...it, url: it.url || x.url, ts: x.ts } };
  return { kind, item: { ...it, url: it.url || x.url } };
}
/** Does the record still want something from me (→ full-strength ✎; the rest are dimmed until hover)? */
const wantsMe = (x) => { const s = x.state || {}; return x.source === "slack" ? (s.need || x.item?.watch?.needs_me) && !s.answered && !s.acked : x.source === "mail" ? !!s.needs_action : false; };
/** ✎ (Slack · 메일, origin "history") or ⋯ (Jira · GitHub · 캘린더), then ✓ for Slack · 메일 — same keys as the cards. */
export function histAct(x) {
  const t = histTarget(x);
  if (!t) return "";
  const own = t.kind === "slack" || t.kind === "email";
  const btn = draftFor(t.kind, t.item, own ? srcKey(t.kind, t.item) : "", { origin: "history", soft: !wantsMe(x) });
  return btn + (own ? srcCheck(t.kind, t.item) : "");
}

const ICON = { slack: "💬", mail: "✉️", jira: "📋", github: "🐙", calendar: "📅" };

/** "오늘" / "어제" / "11/5 (수)" for a local day start. */
export function dayHead(ms, today = midnight()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const t = d.getTime();
  if (t === today) return "오늘";
  if (t === today - 86400_000) return "어제";
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
}

/** State chips per source (what the record says now). */
export function histChips(x) {
  const s = x.state || {}, out = [];
  if (x.current) out.push(`<span class="chipx">지금</span>`);
  if (x.source === "slack") {
    if (s.answered || s.acked) out.push(`<span class="chipx ok">답함</span>`);
    else if (s.need) out.push(`<span class="chipx today">답 필요</span>`);
    if (x.item?.watch?.needs_me && !s.answered && !s.acked) out.push(`<span class="chipx today">나한테</span>`);
  } else if (x.source === "mail") {
    if (s.needs_action) out.push(`<span class="chipx today">확인 필요</span>`);
    if (s.unread) out.push(`<span class="chipx">안 읽음</span>`);
  } else if (x.source === "jira" || x.source === "github") {
    if (s.open === false) out.push(`<span class="chipx">목록에서 빠짐</span>`);
  } else if (x.source === "calendar" && s.rsvp === "needsAction") out.push(`<span class="chipx today">응답 안 함</span>`);
  return out.join("");
}

/** Rows newest first with a day separator whenever the local day changes. Pure (tests). `act(row)` → the row's buttons. */
export function histHtml(items, total = items.length, today = midnight(), act = histAct) {
  if (!items.length) return `<div class="gnone">이 기간에 모은 항목 없음.</div>`;
  let html = "", lastDay = "";
  for (const x of items) {
    const ms = toMs(x.ts), head = dayHead(ms, today);
    if (head !== lastDay) { html += `<div class="hday">${esc(head)}</div>`; lastDay = head; }
    const u = safeUrl(x.url);
    html += `<div class="ti hist${x.current ? " cur" : ""}"><span class="ic">${ICON[x.source] || "·"}</span><div class="mn"><span class="tt">${u ? ext(u, esc(x.title || "(내용 없음)")) : esc(x.title || "(내용 없음)")}</span>
      <div class="sb">${x.detail ? `<span class="d">${esc(x.detail)}</span>` : ""}${histChips(x)}${ms ? `<span>${esc(hhmm(ms))}</span>` : ""}</div></div><div class="ra">${act ? act(x) : ""}${openIcon(u)}</div></div>`;
  }
  if (total > items.length) html += `<div class="gnone">최근 ${items.length}건만 — 전체 ${total}건 (검색 ⌘K 로 더 찾기).</div>`;
  return html;
}

