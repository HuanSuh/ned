/* 팔로업 channel cards: one home card per followed Slack channel (config.filters.slack.watch_channels minus excluded),
 * id `watch:<channel>` on the layout (features/layout.js panels()), built here inside #sgrid next to the fixed cards.
 * config.dashboard.watch_cards = false → no cards; the Slack card's '채널 팔로업' fold (cards.js renderSlackWatch) instead.
 * Body = one scroll area filling the card (.wbody): the model summary as one <li> per line (↗ to the highlight a line
 * clearly talks about — watchsum.js), then highlights, needs_me first (from · time · text · link · check; followed
 * thread → summary + latest reply). Shrunk: summary + open needs_me. Expanded: every highlight, 확인 완료 ones folded.
 * needs_me still counts in the 할 일 card / greeting via cards.js watchNeeds(). */
import { cardDomId, cardKeyOf, watchCh, watchIds, WATCH_ICON } from "./cardlayout.js";
import { cardOpen } from "./cards.js";
import { decoratePanel } from "./layout.js";
import { isOpenSrc, withFold } from "./reviewed.js";
import { histBar, histList } from "./histview.js";
import { watchRecent, watchRow, watchSummary } from "./watchrow.js";
import { $, esc } from "../util.js";

// Rows / summary / 최근 대화 (each with a ✎, origin "watch") are shared with the Slack card's fold: features/watchrow.js.
export { watchRow } from "./watchrow.js";

function cardHtml(id) {
  const k = cardKeyOf(id), ch = watchCh(id), eid = esc(id);
  return `<section class="card scard g-slack g-watch" id="sc-${k}" data-watch="${esc(ch)}">
    <div class="shw"><button class="sh" type="button" data-card="${eid}" aria-expanded="false" aria-controls="sl-${k}" title="팔로업 채널 #${esc(ch)}"><span class="ico">${WATCH_ICON}</span><span class="wch">#${esc(ch)}</span><span class="wme" id="wme-${k}"></span><span class="n" id="n-${k}">0</span><span class="chev" aria-hidden="true">▼</span></button><span class="srcst" data-src="slack"></span></div>
    <div class="wbody" id="sl-${k}">
      <ul class="wsum" id="ss-${k}"></ul>
      <div class="gl wneed" id="pv-${k}"></div>
      <div class="gl wall" id="g-${k}"></div>
    </div>
  </section>`;
}

/** needs_me first, the rest after (each group keeps the model's order). */
const needFirst = (hls) => [...hls.filter((h) => h.needs_me), ...hls.filter((h) => !h.needs_me)];

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
    const fallback = unavailable || (!slack ? "다음 새로고침 때 Slack 도 가져올게." : w ? "표시 구간에 눈에 띄는 대화 없음." : "다음 새로고침 때 이 채널도 볼게.");
    const sum = w ? watchSummary(w) : "";
    // Nothing stood out (no summary, no highlights): the channel's newest messages instead of an empty card.
    const quiet = !sum && !hls.length && w ? watchRecent(w) : "";
    $("ss-" + k).className = sum ? "wsum" : "wsum none";
    $("ss-" + k).innerHTML = sum || (quiet ? "" : `<li>${esc(fallback)}</li>`);
    $("ss-" + k).hidden = !sum && !!quiet;
    $("pv-" + k).innerHTML = quiet || need.map((h) => watchRow(w.channel, h)).join("");
    // 수집 이력 (features/histview.js): 지난 7일 / 30일 of this channel instead of the display window's highlights.
    const hist = histList(id, { source: "slack", channel: ch });
    $("g-" + k).innerHTML = hist !== null ? histBar(id) + hist : (hls.length
      ? withFold(id, "slack", needFirst(hls), (h) => watchRow(w.channel, h)) + watchRecent(w, new Set(hls.map((h) => h.url).filter(Boolean))) // expanded only (.wall): newest messages not already listed
      : quiet) + (slack ? histBar(id) : ""); // nothing to list: the summary area already says so
    const isOpen = cardOpen(id, 0); // shrunk by default: the summary + needs_me already show
    el.classList.toggle("open", isOpen);
    el.querySelector(".sh").setAttribute("aria-expanded", String(isOpen));
  }
}
