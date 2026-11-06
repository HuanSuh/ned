/* New calendar event: ＋ in the 일정 card header, drag on the week/day time grid (15-min snap), click an empty day slot.
 * Popup (#cal-modal, draft-modal look) → confirm once → POST /api/calendar/events (a send job, features/sendjob.js) →
 * the event shows optimistically (pending) until the calendar source refresh brings the real one.
 * Gate: config.actions.calendar_create (off → a toast, no popup). Edit / delete / move are not here (yet). */
import { refreshSource } from "./agstatus.js";
import { PPH, renderAgenda } from "./calendar.js";
import { packCards } from "./cards.js";
import { clickRange, defaultSlot, dragRange, formToBody, minToHHMM, pendingEvent, slotFromRange, whenLabel } from "./calrange.js";
import { ACTION_KO, actionsOn } from "./drafts.js";
import { sendAndWait } from "./sendjob.js";
import { S, ui } from "../state.js";
import { hideModal, showModal, trapTab } from "../ui/modal.js";
import { errBadge, errSummary } from "../ui/popover.js";
import { toast } from "../ui/toast.js";
import { $, esc, ext, safeUrl } from "../util.js";

const GATE = "calendar_create";
const LABEL = "일정 생성";
/** A pending block stays at most this long after the refresh that should have brought the real event. */
const PENDING_GRACE_MS = 3 * 60_000;
export const CC = { open: false };

const MODAL = `<div class="modal" id="cal-modal" hidden>
  <div class="mbox ccbox" role="dialog" aria-modal="true" aria-labelledby="cm-h">
    <div class="mhd"><h3 id="cm-h">새 일정</h3><span class="mt" id="cm-sub">Google Calendar</span><span class="sp"></span><button type="button" class="btn small" data-cmclose="1" aria-label="닫기" title="닫기 (Esc)">✕</button></div>
    <form class="mbd ccform" id="cm-form" novalidate autocomplete="off">
      <input type="text" id="cm-title" class="cctitle" placeholder="제목" aria-label="제목 (필수)" maxlength="200" required>
      <div class="ccrow">
        <input type="date" id="cm-date" aria-label="날짜" required>
        <span class="cctime"><input type="time" id="cm-start" step="900" aria-label="시작 시각"><span class="dash">–</span><input type="time" id="cm-end" step="900" aria-label="끝 시각"></span>
        <span class="ccend" hidden><span class="dash">~</span><input type="date" id="cm-enddate" aria-label="끝나는 날 (종일)"></span>
        <label class="cctog"><input type="checkbox" id="cm-allday">종일</label>
      </div>
      <input type="text" id="cm-loc" placeholder="장소" aria-label="장소" maxlength="500">
      <textarea id="cm-desc" rows="3" placeholder="설명" aria-label="설명" maxlength="4000"></textarea>
      <input type="text" id="cm-att" placeholder="참석자 이메일 (쉼표로 구분)" aria-label="참석자 이메일 (쉼표로 구분)" spellcheck="false">
      <div class="ccrow">
        <label class="cctog"><input type="checkbox" id="cm-meet">Google Meet 링크 추가</label><span class="sp"></span>
        <label class="cccal">캘린더 <input type="text" id="cm-cal" value="primary" aria-label="캘린더 (primary 또는 캘린더 이메일)" spellcheck="false"></label>
      </div>
      <div class="mconfirm" id="cm-confirm" hidden></div>
      <div class="merr" id="cm-err" role="alert"></div>
    </form>
    <div class="mft" id="cm-actions"></div>
  </div>
</div>`;

// ---------------------------------------------------------------- optimistic events (calendar.js merges these)

/** Pending items to draw: still running, or created and waiting for the refresh (dropped once the real one shows). */
export function pendingFor(cal) {
  const now = Date.now();
  S.calPending = (S.calPending || []).filter((p) => !(p.until && now > p.until) && !cal.some((e) => (p.event_id && e.id === p.event_id) || (e.title === p.ev.title && Date.parse(e.start) === Date.parse(p.ev.start))));
  return S.calPending.map((p) => ({ ...p.ev, created: !!p.event_id }));
}
const rerender = () => { if (ui.view === "home") { renderAgenda(); packCards(); } };
function dropPending(key) { S.calPending = (S.calPending || []).filter((p) => p.key !== key); rerender(); }

// ---------------------------------------------------------------- popup

const field = (id) => $(id);
function readForm() {
  return { title: field("cm-title").value, date: field("cm-date").value, start: field("cm-start").value, end: field("cm-end").value, all_day: field("cm-allday").checked, end_date: field("cm-enddate").value, location: field("cm-loc").value, description: field("cm-desc").value, attendees: field("cm-att").value, meet: field("cm-meet").checked, calendar_id: field("cm-cal").value };
}

/** Open the popup prefilled with {date, start, end, end_date?, all_day?}; refused with a toast when the gate is off. */
export function openCreate(slot = defaultSlot()) {
  if (!actionsOn()[GATE]) { toast(`설정 → 쓰기 액션에서 '${ACTION_KO[GATE]}' 을 켜야 해.`); return false; }
  if (CC.open && CC.sending) return false;
  CC.open = true; CC.confirm = null; CC.error = ""; CC.sending = false; CC.back = document.activeElement;
  field("cm-form").reset();
  field("cm-title").value = ""; field("cm-cal").value = "primary";
  field("cm-date").value = slot.date; field("cm-enddate").value = slot.end_date && slot.all_day ? slot.end_date : slot.date;
  field("cm-start").value = slot.start || "09:00"; field("cm-end").value = slot.end || "10:00";
  field("cm-allday").checked = !!slot.all_day;
  showModal($("cal-modal"));
  renderCreate();
  field("cm-title").focus();
  return true;
}
export function closeCreate() {
  if (!CC.open) return;
  CC.open = false;
  hideModal($("cal-modal"));
  CC.back?.focus?.();
}

function renderCreate() {
  if (!CC.open && !CC.sending) return;
  const allDay = field("cm-allday").checked;
  field("cm-start").closest(".cctime").hidden = allDay;
  field("cm-enddate").closest(".ccend").hidden = !allDay;
  for (const el of $("cal-modal").querySelectorAll("input, textarea")) el.disabled = !!CC.sending;
  $("cm-err").innerHTML = CC.error && CC.errPlain ? `<span class="ccmsg">${esc(CC.error)}</span>` : CC.error ? errBadge("calcreate", { where: LABEL, message: CC.error, at: CC.errAt || Date.now(), retry: CC.errRetry || null, label: CC.errLabel || "실패" }) : "";
  const c = CC.confirm;
  $("cm-confirm").hidden = !c;
  if (c) {
    const b = c.body, n = b.attendees.length;
    $("cm-confirm").innerHTML = `<div class="tgt">⚠️ Google Calendar${b.calendar_id !== "primary" ? ` (${esc(b.calendar_id)})` : ""} 에 이 일정을 만듦${n ? ` — 참석자 ${n}명에게 초대가 가` : ""}</div>
      <div class="pv">${esc(whenLabel(b))} · ${esc(b.title)}${b.location ? ` · 📍 ${esc(b.location)}` : ""}${b.meet ? " · Meet" : ""}${n ? `\n${esc(b.attendees.join(", "))}` : ""}</div>
      <button type="button" class="btn go" data-cmconfirm="1">확인 — 만들기 <kbd>⌘⏎</kbd></button><button type="button" class="btn" data-cmcancel="1">취소 <kbd>Esc</kbd></button>`;
  }
  $("cm-actions").innerHTML = CC.sending
    ? `<button type="button" class="btn go" disabled><span class="spin"></span> <span id="cm-tick">만드는 중 ${Math.floor((CC.elapsed || 0) / 1000)}s</span></button>`
    : `<button type="button" class="btn" data-cmclose="1">취소</button><button type="button" class="btn go" data-cmgo="1" ${c ? "disabled" : ""}>만들기 <kbd>⌘⏎</kbd></button>`;
}

/** ⌘⏎ / 만들기: validate → confirm step → (second press) create. */
function primary() {
  if (CC.sending) return;
  if (CC.confirm) return create(CC.confirm.body);
  const r = formToBody(readForm());
  if (r.error) { CC.error = r.error; CC.errPlain = true; CC.errRetry = null; renderCreate(); field(/제목/.test(r.error) ? "cm-title" : /이메일/.test(r.error) ? "cm-att" : /날/.test(r.error) ? "cm-date" : "cm-end").focus(); return; }
  CC.error = ""; CC.confirm = { body: r.body }; renderCreate();
  $("cm-confirm").querySelector("[data-cmconfirm]")?.focus();
}

const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return Number.isFinite(m) ? (m < 1 ? "방금" : `${m}분 전`) : ""; };
/** A toast whose link can be clicked (the shared toast is pointer-events: none). */
function linkToast(msg, link, ms = 7000) {
  toast(msg, ms);
  const u = safeUrl(link);
  if (!u) return;
  const t = $("toast");
  t.classList.add("cclink");
  t.insertAdjacentHTML("beforeend", ext(u, "캘린더에서 열기 ↗", "cclk"));
  setTimeout(() => t.classList.remove("cclink"), ms);
}

/** After an ok create: drop cached ranges over that date, refresh only the calendar source (agenda + range). */
async function refreshAfter(body, key) {
  const d0 = body.date, d1 = body.end_date || body.date;
  for (const k of Object.keys(S.calRanges || {})) { const [f, t] = k.split("_"); if (f <= d1 && d0 <= t) delete S.calRanges[k]; }
  try { await refreshSource("calendar"); } finally {
    const p = (S.calPending || []).find((x) => x.key === key);
    if (p) p.until = Date.now() + PENDING_GRACE_MS;
    rerender();
  }
}

async function create(body) {
  const key = Math.random().toString(36).slice(2, 10);
  const ev = pendingEvent(body, key);
  S.calPending = [...(S.calPending || []), { key, ev }];
  CC.sending = true; CC.confirm = null; CC.error = ""; CC.elapsed = 0;
  renderCreate(); rerender();
  const r = await sendAndWait(body, {
    endpoint: "/api/calendar/events",
    label: LABEL,
    match: { source: "calendar", mode: "create", ref: { title: body.title, calendar_id: body.calendar_id } },
    onTick: (ms) => { CC.elapsed = ms; const el = $("cm-tick"); if (el) el.textContent = `만드는 중 ${Math.floor(ms / 1000)}s`; },
  });
  CC.sending = false;
  const d = r.data || {};
  const wasOpen = CC.open;
  if (r.ok && d.ok !== false) {
    const p = (S.calPending || []).find((x) => x.key === key);
    if (p) p.event_id = d.event?.id || "created";
    linkToast(`일정을 만들었어 — ${whenLabel(body)} ${body.title}`, d.event?.html_link || /https:\/\/\S+/.exec(d.detail || "")?.[0]);
    if (wasOpen) closeCreate();
    refreshAfter(body, key);
    return;
  }
  if (r.status === 409 && d.already_sent) {
    dropPending(key);
    linkToast(`같은 일정을 이미 만들었어 (${ago(d.sent_at)}).`, d.link);
    if (wasOpen) closeCreate();
    refreshAfter(body, key);
    return;
  }
  dropPending(key);
  const dry = String(d.action || "").startsWith("dry_run:");
  const msg = dry ? `dry-run — 실제로 만들지 않았어 (${d.detail || "NED_NO_LLM"}).`
    : r.status === 403 ? `'${ACTION_KO[GATE]}' 은 설정에서 꺼져 있어 (daemon 이 거절함, HTTP 403).`
    : r.status === 400 ? `입력이 잘못됐어: ${d.error || d.detail || "HTTP 400"}`
    : r.unknown ? `${LABEL} 결과 확인 못 함: ${d.error || "알 수 없음"}`
    : `${LABEL} 실패: ${d.detail || d.error || `HTTP ${r.status || "network"}`}`;
  if (!wasOpen) { toast(msg, 9000); return; }
  CC.error = msg; CC.errPlain = dry || r.status === 400; CC.errAt = Date.now(); CC.errLabel = dry ? "dry-run" : r.unknown ? `${LABEL} 결과 모름` : `${LABEL} 실패`;
  CC.errRetry = dry || r.status === 403 || r.status === 400 || r.unknown ? null : () => create(body); // retry only on a confirmed failure
  if (!dry) toast(`${CC.errLabel} — ${errSummary(msg)}`, 6000);
  renderCreate();
}

// ---------------------------------------------------------------- drag / click on the time grid

let DRAG = null;
const colOf = (t) => t.closest?.(".day[data-day], .wcol[data-day]");
function geom(col) {
  const holder = col.matches(".day") ? col : col.closest(".wk-body");
  return { h0: Number(holder.dataset.h0), h1: Number(holder.dataset.h1), pph: PPH };
}
function drawSel(col, range) {
  let el = col.querySelector(".ccsel");
  if (!el) { el = document.createElement("div"); el.className = "ccsel"; col.appendChild(el); }
  const g = geom(col);
  el.style.top = `${((range.start - g.h0 * 60) / 60) * g.pph}px`;
  el.style.height = `${Math.max(8, ((range.end - range.start) / 60) * g.pph)}px`;
  el.textContent = `${minToHHMM(range.start)}–${range.end >= 1440 ? "24:00" : minToHHMM(range.end)}`;
}
function onDown(e) {
  if (e.button !== 0 || CC.sending) return;
  const col = colOf(e.target);
  if (!col || e.target.closest(".cev, a, button, .nowline span")) return;
  DRAG = { col, day: col.dataset.day, y0: e.clientY - col.getBoundingClientRect().top, moved: false, id: e.pointerId };
}
function onMove(e) {
  if (!DRAG || e.pointerId !== DRAG.id) return;
  const y = e.clientY - DRAG.col.getBoundingClientRect().top;
  if (!DRAG.moved && Math.abs(y - DRAG.y0) < 5) return;
  if (!DRAG.moved) {
    DRAG.moved = true;
    if (!actionsOn()[GATE]) { DRAG = null; toast(`설정 → 쓰기 액션에서 '${ACTION_KO[GATE]}' 을 켜야 해.`); return; }
    document.body.classList.add("ccdragging");
  }
  e.preventDefault();
  DRAG.range = dragRange(DRAG.y0, y, geom(DRAG.col));
  drawSel(DRAG.col, DRAG.range);
}
function onUp(e) {
  if (!DRAG || e.pointerId !== DRAG.id) return;
  const d = DRAG; DRAG = null;
  document.body.classList.remove("ccdragging");
  d.col.querySelector(".ccsel")?.remove();
  if (d.moved) { if (d.range) openCreate(slotFromRange(d.day, d.range)); return; }
  // A plain click on an empty slot: day view only (a week-view click is too easy to make by accident), and silent when off.
  if (!d.col.matches(".day") || !actionsOn()[GATE] || window.getSelection()?.toString()) return;
  openCreate(slotFromRange(d.day, clickRange(d.y0, geom(d.col))));
}

/** Listeners + one-time setup (called from calendar.js init — main.js's list belongs to another module). */
export function init() {
  if (!document.querySelector('link[href="/css/calcreate.css"]')) document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" href="/css/calcreate.css">`);
  document.body.insertAdjacentHTML("beforeend", MODAL);
  const nav = document.querySelector("#cal-card .calnav");
  nav?.insertAdjacentHTML("afterbegin", `<button type="button" class="btn small" id="cal-add" title="새 일정 — 주 보기에서 드래그, 일 보기에서 빈 시간 클릭으로도 만들 수 있어" aria-label="새 일정">＋</button>`);
  $("cal-add")?.addEventListener("click", (e) => { e.stopPropagation(); openCreate(defaultSlot()); });
  const box = $("agenda");
  box.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", () => { if (DRAG) { DRAG.col.querySelector(".ccsel")?.remove(); DRAG = null; document.body.classList.remove("ccdragging"); } });

  const m = $("cal-modal");
  m.addEventListener("click", (e) => {
    if (e.target === m || e.target.closest("[data-cmclose]")) return closeCreate();
    if (e.target.closest("[data-cmgo]") || e.target.closest("[data-cmconfirm]")) return primary();
    if (e.target.closest("[data-cmcancel]")) { CC.confirm = null; renderCreate(); }
  });
  m.addEventListener("submit", (e) => { e.preventDefault(); primary(); });
  // Any edit after the confirm step backs out of it (what was confirmed must be what gets sent).
  m.addEventListener("input", () => { if (CC.confirm) { CC.confirm = null; renderCreate(); } if (CC.error && !CC.sending) { CC.error = ""; renderCreate(); } });
  field("cm-allday").addEventListener("change", () => { if (field("cm-enddate").value < field("cm-date").value) field("cm-enddate").value = field("cm-date").value; renderCreate(); });
  field("cm-date").addEventListener("change", () => { if (field("cm-enddate").value < field("cm-date").value) field("cm-enddate").value = field("cm-date").value; });
  // Start moved: keep the duration (Google Calendar does the same).
  let lastStart = "";
  field("cm-start").addEventListener("focus", () => { lastStart = field("cm-start").value; });
  field("cm-start").addEventListener("change", () => {
    const toM = (s) => { const [h, mm] = s.split(":").map(Number); return h * 60 + mm; };
    const s0 = lastStart, s1 = field("cm-start").value, e0 = field("cm-end").value;
    if (/^\d\d:\d\d$/.test(s0) && /^\d\d:\d\d$/.test(s1) && /^\d\d:\d\d$/.test(e0)) {
      const dur = (toM(e0) - toM(s0) + 1440) % 1440 || 60;
      field("cm-end").value = minToHHMM(Math.min(1440, toM(s1) + dur));
    }
    lastStart = s1;
  });
  // Modal keys win over page shortcuts: Esc backs out of the confirm step / closes; ⌘⏎ / Ctrl⏎ = 만들기 / 확인.
  document.addEventListener("keydown", (e) => {
    if (!CC.open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (CC.confirm) { CC.confirm = null; renderCreate(); } else closeCreate(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); primary(); return; }
    if (e.key === "Enter" && e.target?.tagName === "INPUT" && !e.isComposing) { e.preventDefault(); return; } // no implicit submit
    e.stopImmediatePropagation(); // page shortcuts (r / h / i / n …) stay off while typing here
    trapTab(m, e);
  }, true);
}
