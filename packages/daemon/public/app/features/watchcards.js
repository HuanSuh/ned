/* 팔로업 channel cards: one home card per followed Slack channel (config.filters.slack.watch_channels minus excluded),
 * id `watch:<channel>` on the layout (features/layout.js panels()), built here inside #sgrid next to the fixed cards.
 * config.dashboard.watch_cards = false → no cards; the Slack card's '채널 팔로업' fold (cards.js renderSlackWatch) instead.
 * Shrunk: the model summary (≤3 lines) + open needs_me highlights. Expanded: every highlight (from · time · text · link ·
 * check), 확인 완료 ones folded. needs_me still counts in the 할 일 card / greeting via cards.js watchNeeds(). */
import { draftFor } from "./drafts.js";
import { cardDomId, cardKeyOf, watchCh, watchIds, WATCH_ICON } from "./cardlayout.js";
import { cardOpen } from "./cards.js";
import { decoratePanel } from "./layout.js";
import { isOpenSrc, revCls, srcCheck, srcKey, withFold } from "./reviewed.js";
import { openIcon } from "../ui/icons.js";
import { $, esc, ext, rel, safeUrl, toMs } from "../util.js";

/** One highlight row (also used by the Slack card's fold). needs_me rows get the accent bar + a draft button. */
export function watchRow(channel, h) {
  const u = safeUrl(h.url), rv = revCls("slack", h), text = h.text || "(내용 없음)";
  return `<div class="ti${h.needs_me && !rv ? " need" : ""}${rv}"><span class="ic">${h.needs_me ? "❗" : "·"}</span><div class="mn"><span class="tt">${u ? ext(u, esc(text)) : esc(text)}</span>
      <div class="sb"><span class="from">${esc(h.from)}</span>${h.needs_me ? `<span class="chipx today">나한테</span>` : ""}${h.reason ? `<span class="d">${esc(h.reason)}</span>` : ""}${h.ts ? `<span>${rel(toMs(h.ts))}</span>` : ""}</div></div>
      <div class="ra">${h.needs_me ? draftFor("slack", { ...h, channel }, srcKey("slack", h)) : ""}${openIcon(u)}${srcCheck("slack", h)}</div></div>`;
}

function cardHtml(id) {
  const k = cardKeyOf(id), ch = watchCh(id), eid = esc(id);
  return `<section class="card scard g-slack g-watch" id="sc-${k}" data-watch="${esc(ch)}">
    <div class="shw"><button class="sh" type="button" data-card="${eid}" aria-expanded="false" aria-controls="sl-${k}" title="팔로업 채널 #${esc(ch)}"><span class="ico">${WATCH_ICON}</span><span class="wch">#${esc(ch)}</span><span class="wme" id="wme-${k}"></span><span class="n" id="n-${k}">0</span><span class="chev" aria-hidden="true">▼</span></button></div>
    <div class="ss wsum" id="ss-${k}"></div>
    <div class="wneed" id="pv-${k}"></div>
    <div class="sl" id="sl-${k}"><div class="gl"><div id="g-${k}"></div></div></div>
  </section>`;
}

/** Build / drop the card sections so the DOM matches watchIds() (idempotent; new ones get the layout grip + handles). */
export function syncWatchDom() {
  const g = $("sgrid"); if (!g) return;
  const want = watchIds(), keep = new Set(want.map(cardDomId));
  for (const el of [...g.querySelectorAll(":scope > .g-watch")]) if (!keep.has(el.id)) el.remove();
  for (const id of want) {
    if ($(cardDomId(id))) continue;
    g.insertAdjacentHTML("beforeend", cardHtml(id));
    decoratePanel(id);
  }
}

/** The agenda's slack.watch entry for a channel ("#name" there, case-insensitive). */
const entryFor = (slack, ch) => (slack?.watch || []).find((w) => String(w.channel || "").replace(/^#+/, "").toLowerCase() === ch.toLowerCase());

/**
 * Render every watch card. `slack` = agenda slack block (null when off / not fetched), `on` = Slack source on,
 * `unavailable` = agenda load message ("" when loaded).
 */
export function renderWatchCards(slack, on, unavailable) {
  syncWatchDom();
  for (const id of watchIds()) {
    const el = $(cardDomId(id)); if (!el) continue;
    el.hidden = !on; // Slack switched off → every 팔로업 card goes too
    if (el.hidden) continue;
    const k = cardKeyOf(id), ch = watchCh(id), w = entryFor(slack, ch), hls = w?.highlights || [];
    const open = hls.filter(isOpenSrc("slack")), need = open.filter((h) => h.needs_me);
    $("n-" + k).textContent = open.length;
    $("n-" + k).classList.toggle("hot", need.length > 0);
    $("wme-" + k).innerHTML = need.length ? `<span class="chipx today">나한테 ${need.length}</span>` : "";
    const fallback = unavailable || (!slack ? "다음 새로고침 때 Slack 도 가져올게." : w ? "지난 24시간 눈에 띄는 대화 없음." : "다음 새로고침 때 이 채널도 볼게.");
    $("ss-" + k).className = w?.summary ? "ss wsum" : "ss wsum none";
    $("ss-" + k).textContent = w?.summary || fallback;
    $("pv-" + k).innerHTML = need.map((h) => watchRow(w.channel, h)).join("");
    $("g-" + k).innerHTML = hls.length ? withFold(id, "slack", hls, (h) => watchRow(w.channel, h)) : `<div class="gnone">${esc(w ? "눈에 띄는 대화 없음." : fallback)}</div>`;
    const isOpen = cardOpen(id, 0); // shrunk by default: the summary + needs_me already show
    el.classList.toggle("open", isOpen);
    el.querySelector(".sh").setAttribute("aria-expanded", String(isOpen));
  }
}
