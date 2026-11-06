/* 홈 카드 배치: source card order + width from config.dashboard (Settings → 홈 카드 배치, saved with PUT /api/config).
 * Config ids are slack / mail / jira / github; the DOM ids are sc-slack / sc-mail / sc-jira / sc-gh.
 * The home free grid (features/layout.js, config.dashboard.layout) is edited on home itself; this section keeps the
 * simple alternative (↑/↓ order + 1열/2열 → re-derives the layout on save), a lock toggle, 'Reset layout' and a preview. */
import { renderAll } from "../main.js";
import { S } from "../state.js";
import { $, esc } from "../util.js";
import { cardOrder, deriveLayout, fullLayout, onConfig, panelLabel, resetLayout, saveDash, setLocked } from "./layout.js";
import { syncWatchDom } from "./watchcards.js";

export const CARD_IDS = ["slack", "mail", "jira", "github"];
export const CARD_DOM = { slack: "slack", mail: "mail", jira: "jira", github: "gh" };
const CARD_LABEL = { slack: ["💬", "Slack"], mail: ["📬", "메일"], jira: ["📋", "Jira"], github: ["🐙", "GitHub"] };
const PANEL_ICON = { cal: "📅", todo: "✅", slack: "💬", mail: "📬", jira: "📋", github: "🐙" };
/** Same defaults as src/config.ts DEFAULT_DASHBOARD (an older daemon sends no `dashboard`). */
export const DASH_DEFAULT = { card_order: ["slack", "mail", "jira", "github"], card_span: { slack: 2, mail: 1, jira: 1, github: 2 } };

// ---------- 팔로업 channel cards: one per followed channel, id `watch:<channel>` (src/config.ts WATCH_PREFIX) ----------
export const WATCH_PREFIX = "watch:", WATCH_ICON = "👀";
export const isWatch = (id) => typeof id === "string" && id.startsWith(WATCH_PREFIX);
export const watchCh = (id) => id.slice(WATCH_PREFIX.length);
/** Followed channels minus excluded ones (case-insensitive) — same as src/config.ts watchChannels(). */
export function cfgWatchChannels(c = S.config) {
  const ex = new Set((c?.filters?.slack?.exclude_channels || []).map((x) => String(x).toLowerCase()));
  return (c?.filters?.slack?.watch_channels || []).filter((x) => typeof x === "string" && x && !ex.has(x.toLowerCase()));
}
/** config.dashboard.watch_cards (default on). */
export const watchCardsOn = (d = S.config?.dashboard) => d?.watch_cards !== false;
/** Watch card ids shown on home now ([] when the toggle is off). */
export const watchIds = (d = S.config?.dashboard) => (watchCardsOn(d) ? cfgWatchChannels().map((c) => WATCH_PREFIX + c) : []);
/** Every source card id: the fixed four + the watch cards. */
export const cardIds = (d) => [...CARD_IDS, ...watchIds(d)];
/** DOM key (after "sc-" / "n-" / "g-" …): fixed → CARD_DOM; watch → "w-" + the channel, anything outside [A-Za-z0-9-] as `_<hex>_`. */
export const cardKeyOf = (id) => (isWatch(id) ? "w-" + [...watchCh(id)].map((c) => (/[A-Za-z0-9-]/.test(c) ? c : `_${c.codePointAt(0).toString(16)}_`)).join("") : CARD_DOM[id]);
export const cardDomId = (id) => "sc-" + cardKeyOf(id);
export const cardLabel = (id) => (isWatch(id) ? [WATCH_ICON, `#${watchCh(id)}`] : CARD_LABEL[id]);
export const panelIcon = (id) => (isWatch(id) ? WATCH_ICON : PANEL_ICON[id]);

/** Known ids once each (missing ones appended in default order, then new watch cards), spans 1 | 2 (watch cards: 1). */
export function normLayout(d) {
  const ids = cardIds(d);
  const order = (Array.isArray(d?.card_order) ? d.card_order : []).filter((id, i, a) => ids.includes(id) && a.indexOf(id) === i);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const card_span = Object.fromEntries(ids.map((id) => [id, [1, 2].includes(Number(d?.card_span?.[id])) ? Number(d.card_span[id]) : DASH_DEFAULT.card_span[id] || 1]));
  return { card_order: order, card_span, watch_cards: watchCardsOn(d) };
}
export const dashLayout = () => normLayout(S.config?.dashboard);

// ---------- settings section (#c-cards): ↑/↓ reorder, 1열/2열 per card; read back on submit ----------
let edit = null;   // working copy while the form is open; reset by renderCardLayout(d)
let dirty = false; // order / span touched → the free-grid layout is re-derived from them on save
export function renderCardLayout(d) {
  if (d !== undefined) {
    edit = normLayout(d);
    if (d?.layout) edit.card_order = cardOrder(fullLayout(d)); // the list follows the home grid's reading order
    dirty = false;
    syncWatchDom(); // 팔로업 channel added / removed / toggle changed → cards appear / disappear before placement
    onConfig();
  }
  if (!edit) edit = dashLayout();
  const n = edit.card_order.length;
  $("c-cards").innerHTML = edit.card_order.map((id, i) => {
    const [ic, label] = cardLabel(id), span = edit.card_span[id];
    return `<div class="clrow" role="listitem" data-cl="${id}"><span class="cln">${i + 1}</span><span class="ico">${ic}</span><span class="cll">${esc(label)}</span>
      <span class="sp"></span>
      <span class="seg" role="group" aria-label="${esc(label)} 폭"><button type="button" class="btn small" data-clspan="1" aria-pressed="${span === 1}">1열</button><button type="button" class="btn small" data-clspan="2" aria-pressed="${span === 2}">2열</button></span>
      <button type="button" class="btn small" data-clmove="-1" aria-label="${esc(label)} 위로" title="위로" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn small" data-clmove="1" aria-label="${esc(label)} 아래로" title="아래로" ${i === n - 1 ? "disabled" : ""}>↓</button></div>`;
  }).join("");
  const locked = S.config?.dashboard?.locked === true, wOn = watchCardsOn();
  $("c-cards-bar").innerHTML = `<label class="ck"><input type="checkbox" id="c-lay-lock" ${locked ? "checked" : ""}> 홈 배치 잠금 (드래그·크기 조절 끄기)</label>
    <label class="ck" title="켜면 팔로업 채널마다 홈 카드가 하나씩 생겨 (Slack 카드 아래 빈 자리에 배치). 끄면 Slack 카드 안 '채널 팔로업' 접힘 섹션으로."><input type="checkbox" id="c-watch-cards" ${wOn ? "checked" : ""}> 팔로업 채널을 별도 카드로</label>
    <button type="button" class="btn small" id="c-lay-reset" title="일정 | 소스 카드 | 할 일 기본 배치로 (바로 저장)">배치 초기화</button>${dirty ? `<span class="hint">저장하면 홈 배치가 이 순서·폭으로 다시 짜여.</span>` : ""}`;
  $("c-cards-prev").innerHTML = previewHtml(dirty ? deriveLayout(edit) : fullLayout(S.config?.dashboard ?? edit));
}
/** Mini 12-column picture of the home free grid. */
function previewHtml(L) {
  return Object.entries(L).map(([id, r]) => `<span class="clp" style="grid-column:${r.x + 1} / span ${r.w};grid-row:${r.y + 1} / span ${r.h}" title="${esc(panelLabel(id))} · ${r.w}×${r.h}">${panelIcon(id)}${r.w >= 3 ? ` ${esc(panelLabel(id))}` : ""}</span>`).join("");
}
/** What the settings form saves: order / span, plus a re-derived layout when they were changed here. */
export const readCardLayout = () => {
  const d = normLayout(edit || dashLayout());
  return dirty ? { ...d, layout: deriveLayout(d) } : d;
};

export function init() {
  $("c-cards").addEventListener("click", (e) => {
    const row = e.target.closest("[data-cl]"); if (!row || !edit) return;
    const id = row.dataset.cl;
    const mv = e.target.closest("[data-clmove]"), sp = e.target.closest("[data-clspan]");
    if (mv) {
      const i = edit.card_order.indexOf(id), j = i + Number(mv.dataset.clmove);
      if (j < 0 || j >= edit.card_order.length) return;
      [edit.card_order[i], edit.card_order[j]] = [edit.card_order[j], edit.card_order[i]];
      dirty = true;
      renderCardLayout();
      $("c-cards").querySelector(`[data-cl="${id}"] [data-clmove="${mv.dataset.clmove}"]:not([disabled])`)?.focus(); // keep focus on the moved card
    } else if (sp) {
      edit.card_span[id] = Number(sp.dataset.clspan);
      dirty = true;
      renderCardLayout();
    }
  });
  // lock + reset apply right away (no form submit needed)
  $("c-cards-bar").addEventListener("change", (e) => {
    if (e.target.id === "c-lay-lock") setLocked(e.target.checked);
    if (e.target.id === "c-watch-cards") {
      const on = e.target.checked;
      saveDash({ watch_cards: on }, { okMsg: on ? "팔로업 채널을 홈 카드로 따로 보여 줄게" : "팔로업 채널은 Slack 카드 안으로 모았어", failMsg: "저장 실패 — 이전 설정으로 되돌렸어" }).then(() => renderAll());
      renderAll(); // optimistic: S.config.dashboard already holds the new value
    }
  });
  $("c-cards-bar").addEventListener("click", (e) => { if (e.target.closest("#c-lay-reset")) resetLayout(); });
}
