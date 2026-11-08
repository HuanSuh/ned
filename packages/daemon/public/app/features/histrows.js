/* 수집 이력 rows (GET /api/history items → html): day separators, state chips. Pure — no fetch, no DOM (histview.js renders). */
import { openIcon } from "../ui/icons.js";
import { WEEK, esc, ext, hhmm, midnight, safeUrl, toMs } from "../util.js";

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

/** Rows newest first with a day separator whenever the local day changes. Pure (tests). */
export function histHtml(items, total = items.length, today = midnight()) {
  if (!items.length) return `<div class="gnone">이 기간에 모은 항목 없음.</div>`;
  let html = "", lastDay = "";
  for (const x of items) {
    const ms = toMs(x.ts), head = dayHead(ms, today);
    if (head !== lastDay) { html += `<div class="hday">${esc(head)}</div>`; lastDay = head; }
    const u = safeUrl(x.url);
    html += `<div class="ti hist${x.current ? " cur" : ""}"><span class="ic">${ICON[x.source] || "·"}</span><div class="mn"><span class="tt">${u ? ext(u, esc(x.title || "(내용 없음)")) : esc(x.title || "(내용 없음)")}</span>
      <div class="sb">${x.detail ? `<span class="d">${esc(x.detail)}</span>` : ""}${histChips(x)}${ms ? `<span>${esc(hhmm(ms))}</span>` : ""}</div></div><div class="ra">${openIcon(u)}</div></div>`;
  }
  if (total > items.length) html += `<div class="gnone">최근 ${items.length}건만 — 전체 ${total}건 (검색 ⌘K 로 더 찾기).</div>`;
  return html;
}

