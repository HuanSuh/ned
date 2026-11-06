/* 홈 카드 배치: source card order + width from config.dashboard (Settings → 홈 카드 배치, saved with PUT /api/config).
 * Config ids are slack / mail / jira / github; the DOM ids are sc-slack / sc-mail / sc-jira / sc-gh. */
import { S } from "../state.js";
import { $, esc } from "../util.js";

export const CARD_IDS = ["slack", "mail", "jira", "github"];
export const CARD_DOM = { slack: "slack", mail: "mail", jira: "jira", github: "gh" };
const CARD_LABEL = { slack: ["💬", "Slack"], mail: ["📬", "메일"], jira: ["📋", "Jira"], github: ["🐙", "GitHub"] };
/** Same defaults as src/config.ts DEFAULT_DASHBOARD (an older daemon sends no `dashboard`). */
export const DASH_DEFAULT = { card_order: ["slack", "mail", "jira", "github"], card_span: { slack: 2, mail: 1, jira: 1, github: 2 } };

/** Known ids once each (missing ones appended in default order), spans 1 | 2. */
export function normLayout(d) {
  const order = (Array.isArray(d?.card_order) ? d.card_order : []).filter((id, i, a) => CARD_IDS.includes(id) && a.indexOf(id) === i);
  for (const id of DASH_DEFAULT.card_order) if (!order.includes(id)) order.push(id);
  const card_span = Object.fromEntries(CARD_IDS.map((id) => [id, [1, 2].includes(Number(d?.card_span?.[id])) ? Number(d.card_span[id]) : DASH_DEFAULT.card_span[id]]));
  return { card_order: order, card_span };
}
export const dashLayout = () => normLayout(S.config?.dashboard);

// ---------- settings section (#c-cards): ↑/↓ reorder, 1열/2열 per card; read back on submit ----------
let edit = null; // working copy while the form is open; reset by renderCardLayout()
export function renderCardLayout(d) {
  if (d !== undefined) edit = normLayout(d);
  if (!edit) edit = dashLayout();
  const n = edit.card_order.length;
  $("c-cards").innerHTML = edit.card_order.map((id, i) => {
    const [ic, label] = CARD_LABEL[id], span = edit.card_span[id];
    return `<div class="clrow" role="listitem" data-cl="${id}"><span class="cln">${i + 1}</span><span class="ico">${ic}</span><span class="cll">${esc(label)}</span>
      <span class="sp"></span>
      <span class="seg" role="group" aria-label="${esc(label)} 폭"><button type="button" class="btn small" data-clspan="1" aria-pressed="${span === 1}">1열</button><button type="button" class="btn small" data-clspan="2" aria-pressed="${span === 2}">2열</button></span>
      <button type="button" class="btn small" data-clmove="-1" aria-label="${esc(label)} 위로" title="위로" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn small" data-clmove="1" aria-label="${esc(label)} 아래로" title="아래로" ${i === n - 1 ? "disabled" : ""}>↓</button></div>`;
  }).join("");
  $("c-cards-prev").innerHTML = previewHtml(edit);
}
/** Tiny 2-column preview of the rows the home grid will make (same row rule as packCards). */
function previewHtml(d) {
  return d.card_order.map((id) => `<span class="clp s${d.card_span[id]}">${CARD_LABEL[id][0]} ${esc(CARD_LABEL[id][1])}</span>`).join("");
}
export const readCardLayout = () => normLayout(edit || dashLayout());

export function init() {
  $("c-cards").addEventListener("click", (e) => {
    const row = e.target.closest("[data-cl]"); if (!row || !edit) return;
    const id = row.dataset.cl;
    const mv = e.target.closest("[data-clmove]"), sp = e.target.closest("[data-clspan]");
    if (mv) {
      const i = edit.card_order.indexOf(id), j = i + Number(mv.dataset.clmove);
      if (j < 0 || j >= edit.card_order.length) return;
      [edit.card_order[i], edit.card_order[j]] = [edit.card_order[j], edit.card_order[i]];
      renderCardLayout();
      $("c-cards").querySelector(`[data-cl="${id}"] [data-clmove="${mv.dataset.clmove}"]:not([disabled])`)?.focus(); // keep focus on the moved card
    } else if (sp) {
      edit.card_span[id] = Number(sp.dataset.clspan);
      renderCardLayout();
    }
  });
}
