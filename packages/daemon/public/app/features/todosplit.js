/* 할 일 카드 분할: 위 = 확인 필요 그룹들(.tup, 스크롤), 아래 = 개인 할 일(#grp-me — 헤더 + 입력폼 + 목록, 목록만 스크롤).
 * Only while the card has a fixed height (free grid, #hgrid.free — ≥1100px): the upper area is content-sized up to
 * --up-max (px, computed here), the personal area fills the rest and never drops below --me-min = min(180px, its
 * content). Default split 60 / 40, but a short personal list gives its spare room back to the upper area.
 * A drag on the divider (#todo-split) stores the upper share in localStorage ned.todo.split (double-click → default).
 * Narrow (stacked) layout: no divider, both areas take their natural height.
 * The "개인 할 일" header folds the area (localStorage ned.todo.meFold = "1"); folded → the upper area takes it all. */
import { $, lsGet, lsSet } from "../util.js";

export const SPLIT_KEY = "ned.todo.split", FOLD_KEY = "ned.todo.meFold";
export const DEF_SPLIT = 60, ME_FLOOR = 180, UP_FLOOR = 64, SPLIT_MIN = 10, SPLIT_MAX = 90;

// ---------------------------------------------------------------- pure
/** Stored split (upper %) → number in [10, 90], or null (absent / junk → default behaviour). */
export function readSplit(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(n * 10) / 10)) : null;
}
/** Stored fold flag → folded? Only "1" folds. */
export const readFold = (raw) => raw === "1";
/** Minimum height of the personal area: header + form + 3 rows ≈ 180px, or its whole content when that's shorter. */
export const meMinPx = (meNat, floor = ME_FLOOR) => Math.max(0, Math.round(Math.min(floor, Number(meNat) || 0)));
/** Upper area's max height in px for a body of H px. split null → max(60%, room the personal content doesn't need);
 *  a stored split is taken as is. Always leaves the personal area its minimum. */
export function upMaxPx({ H, meNat, split }) {
  const h = Math.max(0, Number(H) || 0), nat = Math.max(0, Number(meNat) || 0);
  const want = split == null ? Math.max((h * DEF_SPLIT) / 100, h - nat) : (h * split) / 100;
  return Math.round(Math.max(0, Math.min(want, h - meMinPx(nat))));
}
/** Divider dragged to y px (from the body's top) → upper % to store, kept clear of both minimums. */
export function splitFromY({ y, H, meNat }) {
  const h = Math.max(1, Number(H) || 1);
  const px = Math.max(Math.min(UP_FLOOR, h), Math.min(Number(y) || 0, h - meMinPx(meNat)));
  return readSplit((px / h) * 100);
}

// ---------------------------------------------------------------- DOM
const els = () => ({ card: $("todo-card"), bd: $("todo-bd"), up: $("todo-up"), hd: $("todo-split"), me: $("grp-me"), gl: $("me-gl"), list: $("g-me"), tog: $("me-fold") });
const splitOn = () => !!$("hgrid")?.classList.contains("free");
const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]) || 0;

/** Natural height of the personal area: header + form + rows (not the scroller's box, which may be stretched). */
function meNatural(e) {
  if (e.me.hidden) return 0;
  const gh = e.me.querySelector(".gh")?.offsetHeight || 0;
  if (e.gl.hidden) return gh;
  const form = $("tadd")?.offsetHeight || 0;
  let rows = 0;
  for (const c of e.list.children) rows += c.offsetHeight;
  return gh + px(e.gl, "marginTop") + form + rows + 2;
}
/** Body height left for the two areas (inner height minus the divider). */
function bodyH(e) {
  return e.bd.clientHeight - px(e.bd, "paddingTop") - px(e.bd, "paddingBottom") - (e.hd.offsetHeight || 0);
}

export function isMeFolded() { return readFold(lsGet(FOLD_KEY)); }
export function setMeFold(folded) {
  lsSet(FOLD_KEY, folded ? "1" : "0");
  applyFold();
  layoutTodoSplit();
}
function applyFold() {
  const e = els();
  if (!e.me) return;
  const f = isMeFolded();
  e.me.classList.toggle("fold", f);
  e.gl.hidden = f;
  e.tog?.setAttribute("aria-expanded", String(!f));
}

/** Re-fit the two areas. Cheap; called after every todo render and on body resize. */
export function layoutTodoSplit() {
  const e = els();
  if (!e.bd || !e.up || !e.me) return;
  applyFold();
  const upEmpty = ![...e.up.children].some((c) => !c.hidden), meGone = e.me.hidden;
  e.up.hidden = upEmpty;
  const on = splitOn() && !upEmpty && !meGone && !isMeFolded();
  e.bd.classList.toggle("tsplit", on);
  e.hd.hidden = !on;
  if (!on) { e.bd.style.removeProperty("--up-max"); e.bd.style.removeProperty("--me-min"); return; }
  const H = bodyH(e), nat = meNatural(e), split = readSplit(lsGet(SPLIT_KEY));
  e.bd.style.setProperty("--me-min", meMinPx(nat) + "px");
  e.bd.style.setProperty("--up-max", upMaxPx({ H, meNat: nat, split }) + "px");
  e.hd.setAttribute("aria-valuenow", String(Math.round(split ?? DEF_SPLIT)));
}

function storeSplit(v) {
  if (v == null) { try { localStorage.removeItem(SPLIT_KEY); } catch { /* private mode */ } }
  else lsSet(SPLIT_KEY, String(v));
  layoutTodoSplit();
}

export function init() {
  const e = els();
  if (!e.bd) return;
  e.tog?.addEventListener("click", () => setMeFold(!isMeFolded()));
  // drag the divider: the upper area's bottom follows the pointer
  e.hd.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    e.hd.setPointerCapture?.(ev.pointerId);
    e.bd.classList.add("tdrag");
    const top = e.up.getBoundingClientRect().top, H = bodyH(e), nat = meNatural(e);
    const move = (m) => storeSplit(splitFromY({ y: m.clientY - top, H, meNat: nat }));
    const up = () => { e.bd.classList.remove("tdrag"); e.hd.removeEventListener("pointermove", move); e.hd.removeEventListener("pointerup", up); e.hd.removeEventListener("pointercancel", up); };
    e.hd.addEventListener("pointermove", move);
    e.hd.addEventListener("pointerup", up);
    e.hd.addEventListener("pointercancel", up);
  });
  e.hd.addEventListener("dblclick", () => storeSplit(null));
  e.hd.addEventListener("keydown", (ev) => {
    const d = ev.key === "ArrowUp" ? -5 : ev.key === "ArrowDown" ? 5 : 0;
    if (ev.key === "Home" || ev.key === "Escape") { storeSplit(null); ev.preventDefault(); return; }
    if (!d) return;
    ev.preventDefault();
    const cur = readSplit(lsGet(SPLIT_KEY)) ?? Math.round((e.up.offsetHeight / Math.max(1, bodyH(e))) * 100);
    const H = bodyH(e);
    storeSplit(splitFromY({ y: ((cur + d) / 100) * H, H, meNat: meNatural(e) }));
  });
  // the 완료 fold opening/closing changes the personal content height
  e.me.addEventListener("toggle", () => layoutTodoSplit(), true);
  if (typeof ResizeObserver === "function") new ResizeObserver(() => layoutTodoSplit()).observe(e.bd);
  layoutTodoSplit();
}
