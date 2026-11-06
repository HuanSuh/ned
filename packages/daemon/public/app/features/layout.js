/* 홈 자유 배치 (≥1100px): every home panel (일정, Slack · 메일 · Jira · GitHub cards, 할 일) sits on a 12-column grid
 * with row units, from config.dashboard.layout = { [panel]: { x, y, w, h } }. Drag a panel header (grip ⠿) to move,
 * the right edge / bottom-right corner to resize; the grid snaps, pushes colliding panels down and floats everything
 * up (vertical compaction, like dashboard builders). Keyboard: focus the grip → arrows move, Shift+arrows resize,
 * Enter saves, Esc cancels. Saved with a debounced PUT /api/config (optimistic, reverted + toast on failure).
 * <1100px: the old stacked flow (packCards), source cards in layout order (y, then x). Lock = config.dashboard.locked. */
import { api } from "../api.js";
import { S } from "../state.js";
import { toast } from "../ui/toast.js";
import { $ } from "../util.js";
import { normLayout, renderCardLayout } from "./cardlayout.js";
import { renderAgenda } from "./calendar.js";

export const PANELS = ["cal", "slack", "mail", "jira", "github", "todo"];
export const PANEL_EL = { cal: "cal-card", todo: "todo-card", slack: "sc-slack", mail: "sc-mail", jira: "sc-jira", github: "sc-gh" };
export const PANEL_LABEL = { cal: "일정", slack: "Slack", mail: "메일", jira: "Jira", github: "GitHub", todo: "할 일" };
/** Same as src/config.ts PANEL_MIN / DEFAULT_LAYOUT. */
export const PANEL_MIN = { cal: { w: 2, h: 4 }, todo: { w: 2, h: 3 }, slack: { w: 2, h: 2 }, mail: { w: 2, h: 2 }, jira: { w: 2, h: 2 }, github: { w: 2, h: 2 } };
export const COLS = 12, BASE_ROWS = 12, GAP = 16, MIN_ROWH = 40;
export const FREE_MQ = "(min-width: 1100px)";
const HEADER_SEL = "#cal-card > .hd, #todo-card > .hd, .scard > .shw";

// ---------------------------------------------------------------- model (pure)
const clampRect = (id, r) => {
  const m = PANEL_MIN[id];
  const w = Math.max(m.w, Math.min(COLS, Math.trunc(r.w)));
  return { x: Math.max(0, Math.min(COLS - w, Math.trunc(r.x))), y: Math.max(0, Math.trunc(r.y)), w, h: Math.max(m.h, Math.min(48, Math.trunc(r.h))) };
};
const valid = (r) => r && ["x", "y", "w", "h"].every((k) => Number.isFinite(Number(r[k])));
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** order / span (the settings list) → free-grid layout: 일정 3 | cards 6 (span 2 = 6 cols, span 1 = 3) | 할 일 3, 12 rows. */
export function deriveLayout(d) {
  const { card_order, card_span } = normLayout(d);
  const rows = [];
  let used = 2;
  for (const id of card_order) { const s = card_span[id]; if (used + s > 2) { rows.push([]); used = 0; } rows[rows.length - 1].push(id); used += s; }
  const n = rows.length, rh = Math.max(2, Math.floor(BASE_ROWS / n));
  const L = { cal: { x: 0, y: 0, w: 3, h: BASE_ROWS }, todo: { x: 9, y: 0, w: 3, h: BASE_ROWS } };
  rows.forEach((r, i) => {
    let x = 3;
    const h = i === n - 1 ? Math.max(2, BASE_ROWS - rh * (n - 1)) : rh;
    for (const id of r) { const w = card_span[id] * 3; L[id] = { x, y: i * rh, w, h }; x += w; }
  });
  return L;
}

/** Push + float: `moved` stays at its target while the rest fall into place around it (each from the top, in y order),
 * then everything floats up in that order (moved first on ties). Only `ids` take part; the rest are copied as-is. */
export function settle(L, ids, moved = null) {
  const out = { ...L };
  const byY = (a, b) => out[a].y - out[b].y || (a === moved ? -1 : b === moved ? 1 : 0) || out[a].x - out[b].x || PANELS.indexOf(a) - PANELS.indexOf(b);
  const fall = (order, fixed) => {
    const placed = fixed ? [fixed] : [];
    for (const id of order) {
      if (id === fixed) continue;
      const r = { ...out[id], y: 0 };
      for (let o; (o = placed.find((p) => hit(r, out[p]))); ) r.y = out[o].y + out[o].h;
      out[id] = r; placed.push(id);
    }
  };
  if (moved && ids.includes(moved)) fall([...ids].sort(byY), moved);
  fall([...ids].sort(byY), null);
  return out;
}

/** Every panel present (missing ones from the order/span layout), clamped, compacted. */
export function fullLayout(dash) {
  const raw = dash?.layout && typeof dash.layout === "object" ? dash.layout : null;
  const base = deriveLayout(dash);
  const L = Object.fromEntries(PANELS.map((id) => [id, clampRect(id, valid(raw?.[id]) ? raw[id] : base[id])]));
  return settle(L, PANELS);
}
const same = (a, b) => PANELS.every((id) => ["x", "y", "w", "h"].every((k) => a?.[id]?.[k] === b?.[id]?.[k]));
/** Source card ids in reading order (y, then x) — the stacked flow below 1100px and the settings list. */
export const cardOrder = (L = fullLayout(dash())) => ["slack", "mail", "jira", "github"].sort((a, b) => L[a].y - L[b].y || L[a].x - L[b].x);

// ---------------------------------------------------------------- state
const dash = () => S.config?.dashboard || {};
export const locked = () => dash().locked === true;
export const freeOn = () => window.matchMedia(FREE_MQ).matches;
let work = null;        // layout while dragging / keyboard editing (null = the saved one)
let confirmed = null;   // last dashboard the server confirmed (revert target)
let migrated = false;
let saveT = 0, seq = 0;
let lastCalH = -1;
const visible = () => PANELS.filter((id) => !$(PANEL_EL[id]).hidden);
const current = () => work || fullLayout(dash());

// ---------------------------------------------------------------- render
/** Place every panel (free grid) or clear placement (stacked flow). Returns whether the free grid is on. */
export function applyLayout() {
  const g = $("hgrid"), on = freeOn();
  g.classList.toggle("free", on);
  g.classList.toggle("locked", locked());
  syncLockBtn();
  if (!on) {
    for (const id of PANELS) { const el = $(PANEL_EL[id]); el.style.gridColumn = el.style.gridRow = ""; }
    $("lay-ghost")?.remove();
    lastCalH = -1;
    return false;
  }
  migrate();
  // Row unit: BASE_ROWS rows fill the grid's height (≥ MIN_ROWH); taller layouts scroll inside the grid.
  const rowh = Math.max(MIN_ROWH, Math.floor((g.clientHeight - (BASE_ROWS - 1) * GAP) / BASE_ROWS));
  g.style.setProperty("--rowh", rowh + "px");
  const ids = visible(), L = work ? work : settle(fullLayout(dash()), ids);
  for (const id of PANELS) {
    const el = $(PANEL_EL[id]), r = L[id];
    if (drag?.id === id && drag.mode === "move") continue; // stays in its start cell, follows the pointer by transform
    el.style.gridColumn = `${r.x + 1} / span ${r.w}`;
    el.style.gridRow = `${r.y + 1} / span ${r.h}`;
  }
  // Calendar hour height follows its body: re-fit when the panel's height changed.
  const calH = $("agenda").clientHeight;
  if (calH !== lastCalH) { lastCalH = calH; renderAgenda(); }
  return true;
}
/** DOM order of the source cards = reading order (keyboard / screen readers); not during a drag (keeps capture). */
function reorderDom(L) {
  const g = $("sgrid");
  for (const id of cardOrder(L)) g.appendChild($(PANEL_EL[id]));
}

function ghostAt(r) {
  let gh = $("lay-ghost");
  if (!r) { gh?.remove(); return; }
  if (!gh) { gh = document.createElement("div"); gh.id = "lay-ghost"; gh.className = "lghost"; gh.setAttribute("aria-hidden", "true"); $("hgrid").appendChild(gh); }
  gh.style.gridColumn = `${r.x + 1} / span ${r.w}`;
  gh.style.gridRow = `${r.y + 1} / span ${r.h}`;
}

// ---------------------------------------------------------------- save (debounced, optimistic)
function scheduleSave(delay = 400) {
  clearTimeout(saveT);
  saveT = setTimeout(() => saveDash(null, { quiet: true }), delay);
}
/** PUT dashboard (patch merged over the current one). Optimistic: S.config already holds the new value. */
export async function saveDash(patch, { quiet = false, okMsg = "", failMsg = "배치 저장 실패 — 이전 배치로 되돌렸어" } = {}) {
  if (!S.config) return false;
  if (patch) S.config.dashboard = { ...dash(), ...patch };
  const mine = ++seq, body = { dashboard: { ...dash() } };
  try {
    const res = await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
    confirmed = res?.dashboard || body.dashboard;
    if (mine === seq) { S.config.dashboard = { ...confirmed }; applyLayout(); renderCardLayout(S.config.dashboard); }
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    console.warn("layout save", err.message);
    if (mine === seq && confirmed) { S.config.dashboard = { ...confirmed }; work = null; applyLayout(); renderCardLayout(S.config.dashboard); }
    if (!quiet || failMsg) toast(failMsg);
    return false;
  }
}
/** First load with no layout: derive it from order/span once and save it. */
function migrate() {
  if (migrated || !S.config) return;
  if (!confirmed) confirmed = { ...dash() };
  migrated = true;
  if (dash().layout) return;
  S.config.dashboard = { ...dash(), layout: deriveLayout(dash()) };
  saveDash(null, { quiet: true, failMsg: "" });
}
/** Called when config (re)loads: new revert target, re-place panels. */
export function onConfig() {
  confirmed = S.config?.dashboard ? { ...S.config.dashboard } : null;
  if (!work && !drag) { if (applyLayout()) reorderDom(current()); }
}
function commit(L) {
  seq++; // a save already in flight must not overwrite this newer layout when it returns
  const all = { ...fullLayout(dash()), ...L };
  work = null;
  S.config.dashboard = { ...dash(), layout: Object.fromEntries(PANELS.map((id) => [id, { x: all[id].x, y: all[id].y, w: all[id].w, h: all[id].h }])) };
  applyLayout(); reorderDom(all);
  scheduleSave();
}
export function resetLayout() {
  if (!S.config) return;
  work = null;
  const d = normLayout(null);
  saveDash({ ...d, layout: deriveLayout(d) }, { okMsg: "홈 배치를 기본값으로 돌렸어" });
  applyLayout(); reorderDom(current());
}
export function setLocked(on) {
  if (!S.config) return;
  saveDash({ locked: !!on }, { okMsg: on ? "홈 배치 잠금 — 드래그·크기 조절 꺼짐" : "홈 배치 잠금 해제" });
  applyLayout();
}

// ---------------------------------------------------------------- pointer: drag header to move, edge / corner to resize
let drag = null; // { id, mode: "move" | "e" | "se", pid, sx, sy, orig, base, started, target }
let swallowClick = false;
function steps() {
  const g = $("hgrid"), cw = (g.clientWidth - (COLS - 1) * GAP) / COLS;
  const rowh = parseFloat(g.style.getPropertyValue("--rowh")) || 64;
  return { col: cw + GAP, row: rowh + GAP };
}
function onDown(e) {
  if (drag && !drag.started) endDrag(false); // a pre-threshold press whose pointerup never arrived
  if (e.button !== 0 || drag || !S.config || !freeOn() || locked()) return;
  const t = e.target, rs = t.closest(".lrs");
  let id, mode;
  if (rs) { id = rs.dataset.panel; mode = rs.dataset.lrs; }
  else {
    const hd = t.closest(HEADER_SEL); if (!hd) return;
    // controls inside a header keep their own clicks (the card toggle button .sh and the grip may start a drag)
    if (t.closest("input, select, textarea, a, .calnav, .vmode, .srcst, .chips, button:not(.sh):not(.lgrip)")) return;
    id = Object.keys(PANEL_EL).find((k) => $(PANEL_EL[k]).contains(hd)); mode = "move";
  }
  if (!id) return;
  const base = settle(fullLayout(dash()), visible());
  drag = { id, mode, pid: e.pointerId, sx: e.clientX, sy: e.clientY, orig: { ...base[id] }, base, started: false, target: null };
  if (mode !== "move") e.preventDefault(); // no text selection from the handles
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}
function onMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.started) {
    if (Math.hypot(dx, dy) < 5) return;
    drag.started = true;
    try { $("hgrid").setPointerCapture(e.pointerId); } catch { /* synthetic / gone */ }
    document.body.classList.add("ldragging", drag.mode === "move" ? "lmove" : "lsize");
    $(PANEL_EL[drag.id]).classList.add(drag.mode === "move" ? "ldrag" : "lresize");
  }
  e.preventDefault();
  const { col, row } = steps(), o = drag.orig, m = PANEL_MIN[drag.id];
  let r;
  if (drag.mode === "move") {
    $(PANEL_EL[drag.id]).style.transform = `translate(${dx}px, ${dy}px)`;
    r = { ...o, x: Math.max(0, Math.min(COLS - o.w, Math.round(o.x + dx / col))), y: Math.max(0, Math.round(o.y + dy / row)) };
  } else {
    const w = Math.max(m.w, Math.min(COLS - o.x, Math.round(o.w + dx / col)));
    const h = drag.mode === "se" ? Math.max(m.h, Math.min(48, Math.round(o.h + dy / row))) : o.h;
    r = { ...o, w, h };
  }
  const key = `${r.x},${r.y},${r.w},${r.h}`;
  if (key === drag.target) return;
  drag.target = key;
  work = settle({ ...drag.base, [drag.id]: r }, visible(), drag.id);
  applyLayout();
  ghostAt(drag.mode === "move" ? work[drag.id] : null);
}
function endDrag(save) {
  const d = drag; drag = null;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  if (!d?.started) return;
  try { $("hgrid").releasePointerCapture(d.pid); } catch { /* already released */ }
  document.body.classList.remove("ldragging", "lmove", "lsize");
  const el = $(PANEL_EL[d.id]);
  el.classList.remove("ldrag", "lresize"); el.style.transform = "";
  ghostAt(null);
  swallowClick = true; setTimeout(() => { swallowClick = false; }, 0); // the click that ends a drag isn't a card toggle
  if (save && work && !same(work, d.base)) commit(work);
  else { work = null; applyLayout(); }
}
const onUp = (e) => { if (drag && e.pointerId === drag.pid) endDrag(true); };
const onCancel = (e) => { if (drag && e.pointerId === drag.pid) endDrag(false); };

// ---------------------------------------------------------------- keyboard on the grip: arrows move, Shift+arrows resize
let kb = null; // { id, base }
const live = (msg) => { const l = $("lay-live"); if (l) l.textContent = msg; };
const where = (id, r) => `${PANEL_LABEL[id]}: ${r.x + 1}열, ${r.y + 1}행, 폭 ${r.w}, 높이 ${r.h}`;
function onKey(e) {
  const grip = e.target.closest?.(".lgrip"); if (!grip || !freeOn() || locked() || !S.config) return;
  const id = grip.dataset.lgrip, k = e.key;
  if (k === "Escape" && kb) { e.preventDefault(); e.stopPropagation(); work = null; kb = null; applyLayout(); live("배치 변경 취소"); return; }
  if (k === "Enter" || k === " ") {
    e.preventDefault(); e.stopPropagation();
    if (kb && work) { const L = work; kb = null; commit(L); live("배치 저장"); }
    return;
  }
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k)) return;
  e.preventDefault(); e.stopPropagation();
  if (!kb || kb.id !== id) kb = { id, base: settle(fullLayout(dash()), visible()) };
  const ids = visible(), cur = (work || kb.base)[id], m = PANEL_MIN[id];
  const from = work || kb.base;
  let next = null;
  if (e.shiftKey) {
    const r = { ...cur };
    if (k === "ArrowRight") r.w = Math.min(COLS - r.x, r.w + 1);
    if (k === "ArrowLeft") r.w = Math.max(m.w, r.w - 1);
    if (k === "ArrowDown") r.h = Math.min(48, r.h + 1);
    if (k === "ArrowUp") r.h = Math.max(m.h, r.h - 1);
    next = settle({ ...from, [id]: r }, ids, id);
  } else if (k === "ArrowLeft" || k === "ArrowRight") {
    const x = Math.max(0, Math.min(COLS - cur.w, cur.x + (k === "ArrowLeft" ? -1 : 1)));
    next = settle({ ...from, [id]: { ...cur, x } }, ids, id);
  } else {
    // Up / down: the nearest target row that actually lands the panel somewhere else (compaction floats it back otherwise).
    const dir = k === "ArrowUp" ? -1 : 1;
    for (let y = cur.y + dir; y >= 0 && y <= cur.y + 60; y += dir) {
      const L = settle({ ...from, [id]: { ...cur, y } }, ids, id);
      if (L[id].y !== cur.y) { next = L; break; }
    }
  }
  if (!next || same(next, from)) return;
  work = next;
  applyLayout();
  live(where(id, work[id]) + " — Enter 저장, Esc 취소");
}
function onBlur(e) {
  // leaving the grip with unsaved keyboard changes keeps them (same as Enter)
  if (!kb || !e.target.closest?.(".lgrip")) return;
  if (e.relatedTarget?.closest?.(".lgrip")?.dataset.lgrip === kb.id) return;
  const L = work; kb = null;
  if (L) commit(L);
}

// ---------------------------------------------------------------- lock button in the home header
function syncLockBtn() {
  const b = $("lay-lock"); if (!b) return;
  const on = locked();
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "홈 배치 잠김 — 눌러서 드래그·크기 조절 켜기" : "홈 배치 잠금 (드래그·크기 조절 끄기)";
  b.innerHTML = on
    ? `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`
    : `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 -.6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
  b.hidden = !freeOn();
}

export function init() {
  // grips (drag + keyboard) in every panel header, resize handles on every panel
  for (const id of PANELS) {
    const el = $(PANEL_EL[id]), hd = el.querySelector(":scope > .hd, :scope > .shw");
    el.classList.add("lp");
    hd.classList.add("lhd");
    hd.insertAdjacentHTML("afterbegin", `<button type="button" class="lgrip" data-lgrip="${id}" aria-label="${PANEL_LABEL[id]} 패널 옮기기 — 방향키 이동, Shift+방향키 크기, Enter 저장, Esc 취소" title="드래그해서 옮기기 · 방향키 이동 · Shift+방향키 크기"><svg viewBox="0 0 10 16" width="8" height="13" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></g></svg></button>`);
    el.insertAdjacentHTML("beforeend", `<span class="lrs lrs-e" data-lrs="e" data-panel="${id}" aria-hidden="true" title="폭 조절"></span><span class="lrs lrs-se" data-lrs="se" data-panel="${id}" aria-hidden="true" title="크기 조절"></span>`);
  }
  const meta = document.querySelector(".hmeta");
  meta?.insertAdjacentHTML("beforeend", `<button type="button" class="btn small iconly" id="lay-lock" aria-pressed="false"></button><span class="vh" id="lay-live" aria-live="polite"></span>`);
  $("lay-lock")?.addEventListener("click", () => setLocked(!locked()));
  const g = $("hgrid");
  g.addEventListener("pointerdown", onDown);
  g.addEventListener("keydown", onKey);
  g.addEventListener("focusout", onBlur);
  g.addEventListener("click", (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; } }, true);
  g.addEventListener("dragstart", (e) => { if (e.target.closest?.(HEADER_SEL)) e.preventDefault(); }); // links / images in headers
  window.matchMedia(FREE_MQ).addEventListener("change", () => {
    if (drag) endDrag(false);
    if (kb && work) { const L = work; kb = null; commit(L); return; } // keep keyboard edits (as on blur)
    work = null; kb = null;
  });
}
