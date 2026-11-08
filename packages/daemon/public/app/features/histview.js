/* 수집 이력 보기 (src/history.ts, GET /api/history): a card's "지난 7일 / 30일" toggle shows what Ned collected beyond the
 * display window — newest first, a separator per local day, rows still in the card now marked "지금".
 * Cards: mail · Slack (in the 전체 view), Jira · GitHub (under the list), 팔로업 channel cards (`channel=`), 일정 (calnav "이력").
 * The choice is per card in localStorage (ned.cardhist.<card id>): 0 = off (the card as usual), 7 or 30 days.
 * Data is fetched once per (card, days) and again whenever agenda.json changes (S.agenda.updated_at). */
import { api } from "../api.js";
import { renderAll } from "../main.js";
import { S } from "../state.js";
import { histHtml } from "./histrows.js";
import { $, esc, lsGet, lsSet } from "../util.js";

export const HIST_DAYS = [[0, "표시 구간"], [7, "지난 7일"], [30, "30일"]];
const cache = {}, pending = {};

/** 0 / 7 / 30 for a card id ("mail", "slack", "jira", "gh", "cal", "watch:<ch>"). */
export function histDays(id) {
  const n = Number(lsGet(`ned.cardhist.${id}`));
  return n === 7 || n === 30 ? n : 0;
}
export function setHistDays(id, n) { lsSet(`ned.cardhist.${id}`, String(n === 7 || n === 30 ? n : 0)); }

/** The toggle row: 표시 구간 | 지난 7일 | 30일. */
export function histBar(id) {
  const d = histDays(id);
  return `<div class="hbar" role="group" aria-label="수집 이력"><span class="hlab">이력</span>${HIST_DAYS.map(([n, label]) => `<button type="button" class="btn small" data-hist-card="${esc(id)}" data-hist-days="${n}" aria-pressed="${d === n}">${esc(label)}</button>`).join("")}</div>`;
}

/** The card's history list html for `query` ({source, channel?}), or null when the card's toggle is off. */
export function histList(id, query) {
  const d = histDays(id);
  if (!d) return null;
  const key = `${id}|${d}`, stamp = S.agenda?.updated_at || 0, c = cache[key];
  if (!c || c.stamp !== stamp) load(key, d, query, stamp);
  if (!c) return `<div class="gnone">이력 불러오는 중…</div>`;
  if (c.error) return `<div class="gnone">이력을 못 불러왔어 — ${esc(c.error)}</div>`;
  return histHtml(c.items, c.total);
}

async function load(key, days, q, stamp) {
  if (pending[key]) return;
  pending[key] = true;
  try {
    const r = await api(`/api/history?source=${encodeURIComponent(q.source)}&days=${days}${q.channel ? `&channel=${encodeURIComponent(q.channel)}` : ""}`);
    cache[key] = { stamp, items: r?.items || [], total: r?.total ?? 0 };
  } catch (e) {
    cache[key] = { stamp, items: [], total: 0, error: e.status === 404 ? "이 데몬은 이력을 몰라 (업데이트 필요)" : e.message };
  } finally {
    delete pending[key];
    renderAll();
  }
}

export const HIST_CSS = `.hbar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: 2px 0 6px; } .hbar .hlab { font-size: 11px; color: var(--dim); margin-right: 2px; }
.hbar .btn[aria-pressed="true"] { background: var(--hover); border-color: var(--hero); }
.hday { font-size: 11px; color: var(--dim); margin: 8px 0 2px; padding-bottom: 2px; border-bottom: 1px solid var(--line); }
.ti.hist.cur { box-shadow: inset 2px 0 0 var(--hero); }`;

/** Listeners + one-time setup (main.js). */
export function init() {
  const st = document.createElement("style");
  st.textContent = HIST_CSS;
  document.head.appendChild(st);
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hist-card]");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const id = b.dataset.histCard, n = Number(b.dataset.histDays);
    // calnav "이력": toggles 7 days ⇄ off; the bar's buttons set the value.
    setHistDays(id, b.dataset.histToggle ? (histDays(id) ? 0 : 7) : n);
    renderAll();
    $("sc-" + id)?.classList.add("open");
  }, true);
}
