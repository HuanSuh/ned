/* Home source cards (mail · jira · slack · github): render, shrink/expand, list modes, packing. */
import { cardDomId, cardIds, dashLayout } from "./cardlayout.js";
import { applyLayout, cardOrder } from "./layout.js";
import { isOpenSrc, srcKey } from "./reviewed.js";
import { recentHtml } from "./slackthread.js";
import { watchRow } from "./watchcards.js";
import { ui } from "../state.js";
import { renderTodoGroups } from "../tabs/home.js";
import { CARD_KIND, srcOn } from "../ui/chips.js";
import { $, esc, ext, lsGet, lsSet, toMs } from "../util.js";
export const GH_REASON = { review_requested: ["rv", "리뷰 요청", "👀"], my_pr_changes_requested: ["over", "변경 요청", "✍️"], my_pr_approved: ["ok", "승인됨", "✅"] };
export const MAIL_REASON = { reply: ["rv", "답장", "↩️"], approval: ["today", "결재", "🖊️"], deadline: ["over", "마감", "⏰"], request: ["", "확인", "📨"] };
export const SLACK_REASON = { dm: ["today", "DM", "💬"], mention: ["rv", "멘션", "📣"], thread: ["", "스레드", "🧵"], group: ["", "그룹", "👥"] }; // group = 내 유저그룹 멘션 (filters.slack.group_mentions)
export const PRIO_LED = { highest: "r", high: "r", medium: "a" };

export function group(id, n, hot, rows, emptyMsg) {
  $("n-" + id).textContent = n;
  $("n-" + id).classList.toggle("hot", !!hot);
  $("g-" + id).innerHTML = rows || `<div class="gnone">${esc(emptyMsg)}</div>`;
}
/** Source card open state: remembered per card (ned.card.<id> = "1"/"0"); default open iff it has items. */
export const cardKey = (id) => `ned.card.${id}`;
export function cardOpen(id, n) { const v = lsGet(cardKey(id)); return v === "1" ? true : v === "0" ? false : n > 0; }
/** One-line preview of the most urgent item, shown only while the card is shrunk. */
export const preview = (ic, title, url, chip) => `<span class="ic">${ic}</span><span class="tt">${url ? ext(url, esc(title)) : esc(title)}</span>${chip || ""}`;
/** Render a source card: badge + list via group(), then summary line, preview, open/hidden state. */
/** Placeholder body while a source has never landed (first load: agenda not read yet, or its source still running
 *  with no data) — three grey lines with a soft shimmer. The header's '갱신 중' spinner (agstatus.js) stays as is. */
export const SKELETON = `<div class="skel" role="status" aria-label="불러오는 중"><i></i><i></i><i></i></div>`;
export function card(id, { n, hot, rows, empty, sum, pv, hidden, mode, allRows, allEmpty, loading }) {
  const el = $("sc-" + id);
  for (const b of el.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === (mode || "need")));
  if (mode === "all") { rows = allRows; empty = allEmpty; }
  el.hidden = !!hidden || !srcOn(CARD_KIND[id]); // source switched off (home pills only filter the 할 일 card)
  if (el.hidden) return;
  const skel = !!loading && !n && !rows;
  el.classList.toggle("loading", skel);
  group(id, n, hot, skel ? SKELETON : rows, empty);
  $("ss-" + id).className = sum ? "ss" : "ss none";
  $("ss-" + id).innerHTML = sum || esc(skel ? "불러오는 중…" : empty);
  $("pv-" + id).innerHTML = n ? pv || "" : "";
  const open = skel && lsGet(cardKey(id)) == null ? true : cardOpen(id, n); // default-open while the skeleton shows
  el.classList.toggle("open", open);
  el.querySelector(".sh").setAttribute("aria-expanded", String(open));
}
/** One row per Slack DM conversation (latest; count summed) — a safety net over the agenda prompt's rule. Mentions / threads untouched.
 *  Conversation = the channel id in the permalink (D…/G…), else channel + sender ("DM" alone would merge different people). */
export const slackConv = (x) => /\/archives\/([A-Z0-9]+)\//.exec(x.url || "")?.[1] || `${x.channel}|${x.from}`;
export function collapseDMs(list) {
  const best = new Map(), total = new Map();
  for (const x of list) if (x.reason === "dm") {
    const k = slackConv(x), cur = best.get(k);
    total.set(k, (total.get(k) || 0) + Math.max(1, Number(x.count) || 1));
    if (!cur || toMs(x.ts) > toMs(cur.ts)) best.set(k, x);
  }
  return list.filter((x) => x.reason !== "dm" || best.get(slackConv(x)) === x).map((x) => (x.reason === "dm" && total.get(slackConv(x)) > 1 ? { ...x, count: total.get(slackConv(x)) } : x));
}
export const moreBadge = (x) => (x.count > 1 ? `<span class="chipx more" title="이 대화에서 답 안 한 메시지 ${x.count}건">+${x.count - 1}</span>` : "");
/** The "전체" list = all ∪ items, one row per item key (Slack channel id + ts, mail thread id — srcKey; else the
 *  link), the `all` record winning (it carries answered / unread), newest first. `isNeed` = the item is in `items`. */
export function unionAll(kind, items, all, tsOf) {
  const key = (x) => srcKey(kind, x) || x.url || "";
  const need = new Set(items.map(key).filter(Boolean)), seen = new Set(), list = [];
  for (const x of [...all, ...items]) {
    const k = key(x);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    list.push(x);
  }
  list.sort((a, b) => toMs(tsOf(b)) - toMs(tsOf(a)));
  return { list, isNeed: (x) => need.has(key(x)) };
}
/** Mail / Slack card list mode: "need" (the picked items) or "all" (everything recent), per card in localStorage. */
export const cardMode = (id) => (lsGet(`ned.cardmode.${id}`) === "all" ? "all" : "need");
export const counts = (pairs, sep = ", ") => pairs.filter(([, k]) => k > 0).map(([label, k]) => `${label} ${k}`).join(sep);

/** Open (not 확인 완료) 채널 팔로업 highlights that need me (agenda slack.watch[].highlights[].needs_me), one per url. */
export function watchNeeds(slack) {
  const seen = new Set();
  return (slack?.watch || []).flatMap((w) => (w.highlights || []).filter((h) => h.needs_me && isOpenSrc("slack")(h)).map((h) => ({ ...h, channel: w.channel })))
    .filter((h) => !h.url || (!seen.has(h.url) && seen.add(h.url)));
}
/** Slack card's 채널 팔로업 fold (config.dashboard.watch_cards = false; else each channel has its own card — watchcards.js):
 *  collapsed by default, per-channel summary + highlights; needs_me rows get the accent bar. */
export function renderSlackWatch(watch, needN) {
  const el = $("slack-watch");
  if (!watch.length) { el.innerHTML = ""; return; }
  const hl = (w, h) => watchRow(w.channel, h);
  el.innerHTML = `<details class="swatch" ${ui.watchOpen ? "open" : ""}><summary>채널 팔로업 ${watch.length}${needN ? `<span class="chipx today">나한테 ${needN}</span>` : ""}</summary>` +
    watch.map((w) => {
      const n = (w.highlights || []).filter((h) => h.needs_me && isOpenSrc("slack")(h)).length;
      return `<div class="swch"><div class="swh">${esc(w.channel)}${n ? `<span class="chipx today">${n}</span>` : ""}</div>` +
        (w.summary ? `<div class="sws">${esc(w.summary)}</div>` : (!(w.highlights || []).length && recentHtml(w.recent)) || `<div class="gnone">지난 24시간 눈에 띄는 대화 없음.</div>`) +
        (w.highlights || []).map((h) => hl(w, h)).join("") + `</div>`;
    }).join("") + `</details>`;
}

/** Lay the source cards out in rows: config.dashboard order, each card 1 or 2 of the grid's --cols (≤ 2) columns —
 *  a card that doesn't fit the current row starts the next one (grid auto-placement does the same). The last row
 *  takes the leftover height (`.last` cards stretch their list). Re-run after content / open state / width changes. */
export function packCards() {
  const g = $("sgrid");
  const n = Math.min(2, Math.max(1, Number(getComputedStyle(g).getPropertyValue("--cols")) || 1));
  if (applyLayout()) { for (const id of cardIds()) $(cardDomId(id))?.classList.remove("last"); g.style.gridTemplateRows = ""; return; } // ≥1100px: free grid (features/layout.js)
  // Stacked flow: cards in layout reading order (y, then x), widths from the settings' 1열/2열.
  const { card_span } = dashLayout(), card_order = cardOrder();
  let rows = 0, used = 0;
  const placed = [];
  for (const id of card_order) {
    const c = $(cardDomId(id)), span = Math.min(n, card_span[id] || 1);
    if (!c) continue;
    g.appendChild(c); // DOM order = visual order (keyboard / screen readers follow it)
    c.classList.remove("last");
    c.style.gridColumn = `span ${span}`;
    if (c.hidden) continue;
    if (!rows || used + span > n) { rows++; used = 0; }
    used += span;
    placed.push([c, rows]);
  }
  for (const [c, r] of placed) if (r === rows) c.classList.add("last");
  g.style.gridTemplateRows = rows > 1 ? `repeat(${rows - 1}, auto) minmax(auto, 1fr)` : "minmax(auto, 1fr)";
}

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  $("sc-slack").addEventListener("toggle", (e) => { if (e.target.classList?.contains("swatch")) { ui.watchOpen = e.target.open; packCards(); } }, true);
  // Source card header (a <button>: click, Enter or Space) toggles shrink ⇄ expanded and remembers it per card.
  $("sgrid").addEventListener("toggle", (e) => { const d = e.target; if (d.classList?.contains("rvfold")) { ui.revCard = ui.revCard || {}; ui.revCard[d.dataset.rv] = d.open; packCards(); } }, true);
  $("sgrid").addEventListener("click", (e) => {
    const vm = e.target.closest("[data-vm]");
    if (vm) {
      lsSet(`ned.cardmode.${vm.dataset.vm}`, vm.dataset.mode);
      const el = $("sc-" + vm.dataset.vm);
      if (vm.dataset.mode === "all" && !el.classList.contains("open")) { el.classList.add("open"); lsSet(cardKey(vm.dataset.vm), "1"); } // show the list you asked for
      renderTodoGroups(); packCards();
      return;
    }
    const h = e.target.closest(".sh[data-card]"); if (!h) return;
    const el = h.closest(".scard"), open = !el.classList.contains("open");
    el.classList.toggle("open", open); h.setAttribute("aria-expanded", String(open));
    lsSet(cardKey(h.dataset.card), open ? "1" : "0");
    packCards();
  });
}
