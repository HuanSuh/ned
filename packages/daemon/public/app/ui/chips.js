/* Source pills (the timeline chip UI + kind icon + count), per-view filter state, source on/off. */
import { counts } from "../features/cards.js";
import { renderAll } from "../main.js";
import { S, ui } from "../state.js";
import { KIND_ICON, KIND_KO } from "./icons.js";
import { esc, lsGet, lsSet } from "../util.js";
// ---------- source pills: the timeline's .chips/.chip UI + kind icon + count; multi-select, per-view state.
//            Home: filters only the 할 일 card (Ned action items + personal todos). Inbox: the list. ----------
export const PILL_KINDS = ["session", "email", "slack", "jira", "github", "sentry", "calendar", "me"];
export const PILL_ICON = { ...KIND_ICON, me: "✅" }, PILL_KO = { ...KIND_KO, me: "개인" };
export const CARD_KIND = { mail: "email", jira: "jira", slack: "slack", gh: "github" };
export function loadPf(v) { try { return new Set(JSON.parse(lsGet(`ned.pf.${v}`) || "[]").filter((k) => PILL_KINDS.includes(k))); } catch { return new Set(); } }
export const PF = { home: loadPf("home"), inbox: loadPf("inbox") };
export const pfOn = (v, kind) => !PF[v].size || PF[v].has(kind);
// Sources switched off in Settings vanish from cards, pills and greeting counts right away (/api/config, else agenda.sources).
export const KIND_SOURCE = { email: "gmail", slack: "slack", jira: "jira", github: "github", sentry: "sentry", calendar: "calendar" };
export const srcOn = (kind) => { const src = KIND_SOURCE[kind], m = S.config?.sources || S.agenda?.sources; return !src || !m || m[src] !== false; };
export function pillRow(v, counts, kinds) {
  return `<span class="lbl">소스</span><button class="chip${PF[v].size ? "" : " on"}" type="button" data-pf="${v}" data-k="" aria-pressed="${!PF[v].size}">전체</button>` +
    kinds.map((k) => {
      const n = counts[k] || 0, on = PF[v].has(k);
      return `<button class="chip${on ? " on" : ""}${n ? "" : " nil"}" type="button" data-pf="${v}" data-k="${k}" aria-pressed="${on}" title="${esc(PILL_KO[k])} ${n}건"><span class="pi" aria-hidden="true">${PILL_ICON[k]}</span>${esc(PILL_KO[k])}<span class="pn">${n}</span></button>`;
    }).join("");
}

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pf]"); if (!b) return;
    const v = b.dataset.pf, k = b.dataset.k, set = PF[v];
    if (!k) set.clear(); else if (set.has(k)) set.delete(k); else set.add(k);
    lsSet(`ned.pf.${v}`, JSON.stringify([...set]));
    if (v === "inbox") { ui.sel = 0; ui.selKey = null; }
    renderAll();
  });
}
