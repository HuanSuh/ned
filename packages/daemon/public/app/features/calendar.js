/* Home calendar panel: day / week views over agenda.calendar + /api/calendar ranges. */
import { api } from "../api.js";
import { histBar, histList } from "./histview.js";
import { init as initCreate, pendingFor } from "./calcreate.js";
import { packCards } from "./cards.js";
import { actionsOn } from "./drafts.js";
import { say } from "./personas.js";
import { S, ui } from "../state.js";
import { errBadge } from "../ui/popover.js";
import { $, WEEK, esc, ext, hhmm, lsGet, lsSet, pad, safeUrl, ymdOf } from "../util.js";

// ---------- home ----------
export const HOME_POLL_MS = 60 * 1000, MIN_EV_PX = 22; // min block height
// Timeline px per hour: 52 by default, taller on tall windows (52–72). Width never changes with it.
export let PPH = 52;
export const fitPPH = () => {
  // ≥900px the calendar body has a fixed height (viewport fill): fit 08–20 into it; below that, follow the window.
  const bd = $("agenda"), fixed = window.matchMedia("(min-width: 900px)").matches;
  const room = fixed && bd ? bd.clientHeight - (ui.cal?.view === "week" ? 76 : 34) : 0;
  PPH = room > 300 ? Math.floor(Math.min(72, Math.max(40, room / 12))) : Math.round(Math.min(72, Math.max(52, (window.innerHeight - 320) / 12)));
};
export const RSVP = { needsAction: ["a", "응답 필요"], tentative: ["", "미정"], declined: ["", "거절"], organizer: ["", "주최"] };
export function untilLabel(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m}분 후` : `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""} 후`;
}

// ---------- calendar: day / week views over agenda.calendar (yesterday … +13) and /api/calendar ranges ----------
export const parseYmd = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymdOf(d); };
export const mondayOf = (s) => addDays(s, -((parseYmd(s).getDay() + 6) % 7));
export const todayYmd = () => ymdOf(new Date());
export function loadCal() {
  try {
    const c = JSON.parse(lsGet("ned.cal") || "{}");
    // A date picked on an earlier day snaps back to today; the day/week choice is kept.
    return { view: c.view === "week" ? "week" : "day", date: c.saved === todayYmd() && /^\d{4}-\d{2}-\d{2}$/.test(c.date || "") ? c.date : todayYmd() };
  } catch { return { view: "day", date: todayYmd() }; }
}
export const saveCal = () => lsSet("ned.cal", JSON.stringify({ ...ui.cal, saved: todayYmd() }));
export const calDays = () => (ui.cal.view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(mondayOf(ui.cal.date), i)) : [ui.cal.date]);
/**
 * Events for `days`: agenda.calendar covers agenda.calendar_range; only the days outside it (at most a span before
 * and a span after) come from /api/calendar. Returns {status: ok|loading|error, cal} — while a span loads, what we
 * already have is still drawn.
 */
export function calSource(days) {
  const r = S.agenda?.calendar_range || { from: todayYmd(), to: todayYmd() }; // older agenda.json: today only
  const before = days.filter((d) => d < r.from), after = days.filter((d) => d > r.to);
  let cal = [...(S.agenda?.calendar || [])], status = "ok", error = "";
  for (const span of [before, after]) {
    if (!span.length) continue;
    const key = `${span[0]}_${span[span.length - 1]}`;
    if (!S.calRanges[key]) fetchCalRange(span[0], span[span.length - 1]);
    const got = S.calRanges[key];
    if (got.status === "loading") status = "loading";
    else if (got.status === "error") { if (status === "ok") status = "error"; error = got.error; }
    cal = cal.concat(got.cal);
  }
  const seen = new Set(); // an event crossing the range edge can come from both sources
  cal = cal.filter((e) => { const k = `${e.id}|${e.start}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // Events just created from the card (calcreate.js): drawn pending until the calendar refresh brings the real one.
  cal = cal.concat(pendingFor(cal));
  return { status, cal, error };
}
export async function fetchCalRange(from, to) {
  const key = `${from}_${to}`;
  S.calRanges[key] = { status: "loading", cal: [] };
  try {
    const r = await api(`/api/calendar?from=${from}&to=${to}`);
    S.calRanges[key] = { status: r.error && !(r.calendar || []).length ? "error" : "ok", cal: r.calendar || [], error: r.error, cached: r.cached };
  } catch (e) { S.calRanges[key] = { status: "error", cal: [], error: e.message }; }
  if (ui.view === "home") { renderAgenda(); packCards(); }
}
export function calMove(step) {
  ui.cal.date = step === 0 ? todayYmd() : addDays(ui.cal.date, step * (ui.cal.view === "week" ? 7 : 1));
  saveCal(); renderAgenda(); packCards();
}
export function calView(v) { ui.cal.view = v; saveCal(); renderAgenda(); packCards(); }

/** One local day's events split into all-day + timed (timed clipped to the day, ms in s/en). */
export function eventsForDay(cal, day) {
  const d0 = parseYmd(day).getTime(), d1 = parseYmd(addDays(day, 1)).getTime();
  const allDay = [], timed = [];
  for (const e of cal) {
    if (e.all_day) {
      const sd = String(e.start || "").slice(0, 10), ed = String(e.end || "").slice(0, 10);
      const endEx = ed && ed > sd ? ed : sd ? addDays(sd, 1) : ""; // Google all-day end is exclusive
      if (!sd || !(sd <= day && day < endEx)) continue;
      allDay.push(e); continue;
    }
    const s = Date.parse(e.start); if (!Number.isFinite(s)) continue;
    const en = Math.max(Date.parse(e.end) || 0, s + 5 * 60000);
    if (en <= d0 || s >= d1) continue;
    timed.push({ ...e, s: Math.max(s, d0), en: Math.min(en, d1), url: safeUrl(e.url), meet: safeUrl(e.meet_url) });
  }
  timed.sort((a, b) => a.s - b.s || b.en - a.en);
  return { allDay, timed, d0 };
}
/** Today only, from agenda.calendar — what the greeting / "next meeting" use, same as before the 2-week range. */
export const todayEvents = () => eventsForDay(S.agenda?.calendar || [], todayYmd());
/** Side-by-side columns for overlapping events (per overlap cluster). Uses the drawn end so short blocks don't collide. */
export function layoutCols(evs) {
  let cluster = [], cols = [], clusterEnd = 0;
  const flush = () => { for (const e of cluster) e.ncol = cols.length; cluster = []; cols = []; clusterEnd = 0; };
  for (const e of evs) {
    e.vEnd = Math.max(e.en, e.s + (MIN_EV_PX / PPH) * 3600000);
    if (cluster.length && e.s >= clusterEnd) flush();
    let c = cols.findIndex((end) => end <= e.s);
    if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = e.vEnd; e.col = c; cluster.push(e); clusterEnd = Math.max(clusterEnd, e.vEnd);
  }
  flush();
}
/** Optimistic (just created) event: class + tooltip suffix. */
const pendCls = (e) => (e.pending ? " pend" : "");
const pendTip = (e) => (e.pending ? (e.created ? " · 만들었어, 캘린더 반영 중" : " · 만드는 중…") : "");
export const meetings = (timed) => timed.filter((e) => e.rsvp !== "declined");
export const hourSpan = (per) => {
  let h0 = 8, h1 = 20;
  for (const p of per) for (const e of p.timed) { h0 = Math.min(h0, Math.floor((e.s - p.d0) / 3600000)); h1 = Math.max(h1, Math.ceil((e.en - p.d0) / 3600000)); }
  return [Math.max(0, h0), Math.min(24, h1)];
};

export function renderAgenda() {
  fitPPH();
  const days = calDays(), box = $("agenda"), a = parseYmd(days[0]), z = parseYmd(days[days.length - 1]);
  $("ag-date").textContent = days.length === 1 ? `${a.getMonth() + 1}월 ${a.getDate()}일 (${WEEK[a.getDay()]})` : `${a.getMonth() + 1}/${a.getDate()} – ${z.getMonth() + 1}/${z.getDate()}`;
  for (const b of document.querySelectorAll("[data-cv]")) b.setAttribute("aria-pressed", String(b.dataset.cv === ui.cal.view));
  $("cal-today").classList.toggle("on", days.includes(todayYmd()));
  $("hgrid").classList.toggle("wk", ui.cal.view === "week");
  if (S.agenda === undefined) { box.innerHTML = `<div class="gnone">불러오는 중…</div>`; $("ag-count").textContent = ""; return; }
  // 수집 이력 (calnav "이력"): past events Ned saw, newest first, instead of the day / week grid.
  const hist = histList("cal", { source: "calendar" });
  $("cal-hist")?.setAttribute("aria-pressed", String(hist !== null));
  if (hist !== null) { box.innerHTML = histBar("cal") + hist; $("ag-count").textContent = ""; return; }
  const src = calSource(days);
  if (ui.cal.view === "week") renderWeek(box, days, src.cal); else renderDay(box, days[0], src.cal);
  // Days outside agenda.calendar_range: say we're fetching (or that it failed) above what we already have.
  const note = src.status === "loading" ? `<div class="calload"><span class="spin"></span>범위 밖 날짜 일정 가져오는 중… <span class="hint">처음 보는 기간이면 30초쯤 걸려.</span></div>`
    : src.status === "error" ? `<div class="calload err">${errBadge("calendar", { where: "캘린더 범위 조회 (/api/calendar)", message: src.error || "알 수 없는 오류", retry: () => { for (const k of Object.keys(S.calRanges)) if (S.calRanges[k].status === "error") delete S.calRanges[k]; renderAgenda(); packCards(); } })}<span>일부 날짜 일정을 못 가져왔어.</span></div>` : "";
  if (note) box.insertAdjacentHTML("afterbegin", note);
}

export function renderDay(box, day, cal) {
  const now = Date.now(), isToday = day === todayYmd();
  const { allDay, timed, d0 } = eventsForDay(cal, day);
  const mt = meetings(timed);
  $("ag-count").textContent = timed.length ? `회의 ${mt.length}${allDay.length ? ` · 종일 ${allDay.length}` : ""}` : allDay.length ? `종일 ${allDay.length}` : "";
  let html = "";
  if (allDay.length) html += `<div class="allday">${allDay.map((e) => {
      const r = RSVP[e.rsvp];
      return `<div class="ad${pendCls(e)}"${e.pending ? ` title="${esc(e.title + pendTip(e))}"` : ""}><span class="tag">종일</span><span class="tt">${safeUrl(e.url) ? ext(safeUrl(e.url), esc(e.title)) : esc(e.title)}</span>${r && e.rsvp !== "organizer" ? `<span class="stk ${r[0]} flat">${r[1]}</span>` : ""}</div>`;
    }).join("")}</div>`;
  if (!timed.length) {
    html += `<div class="hzero">${!isToday ? say("ned", "이 날은 회의 없음.", "◀ ▶ 로 다른 날을 볼 수 있어.") : S.agenda ? say("ned", "오늘은 회의 없음. 딥워크 데이.", "끼어드는 일정 생기면 바로 알려 줄게.") : say("ned", "일정을 아직 못 받아 왔어.", "agenda 가 연결되면 여기 오늘 하루가 그려져.")}</div>`;
    // With creating switched on, the empty day still gets its time grid so a slot can be clicked / dragged.
    if (!actionsOn().calendar_create) { box.innerHTML = html; return; }
  }
  const [h0, h1] = hourSpan([{ timed, d0 }]);
  const y = (t) => ((t - d0) / 3600000 - h0) * PPH;
  layoutCols(timed);
  const next = isToday ? mt.find((e) => e.s > now) : null;
  let g = "";
  for (let h = h0; h <= h1; h++) {
    const nearNow = isToday && Math.abs(now - (d0 + h * 3600000)) < 12 * 60000; // the now-label takes this slot
    g += `<div class="hr" style="top:${(h - h0) * PPH}px">${nearNow ? "" : `<span>${pad(h)}:00</span>`}</div>`;
    if (h < h1) g += `<div class="hr half" style="top:${(h - h0 + 0.5) * PPH}px"></div>`;
  }
  for (const e of timed) {
    const top = y(e.s), hgt = Math.max(MIN_EV_PX, y(e.en) - top) - 2;
    const live = e.s <= now && now < e.en && e.rsvp !== "declined";
    const cls = [e.en <= now ? "past" : "", live ? "now" : "", e.rsvp === "needsAction" ? "ask" : "", e.rsvp === "declined" ? "no" : "", hgt < 38 ? "tiny" : ""].join(" ") + pendCls(e);
    const r = RSVP[e.rsvp];
    const stk = (e === next ? `<span class="stk g flat">${untilLabel(e.s - now)}</span>` : "") + (live ? `<span class="stk g flat">진행 중</span>` : "")
      + (r && (e.rsvp !== "organizer" || hgt >= 38) ? `<span class="stk ${r[0]} flat">${r[1]}</span>` : "");
    const where = [e.location ? `<span class="loc">📍 ${esc(e.location)}</span>` : "", e.meet ? ext(e.meet, "Meet ↗") : ""].filter(Boolean).join("");
    const tip = `${hhmm(e.s)}–${hhmm(e.en)} ${e.title}${e.location ? " · " + e.location : ""}${e.attendees ? ` · ${Array.isArray(e.attendees) ? e.attendees.length : e.attendees}명` : ""}${pendTip(e)}`;
    g += `<div class="cev ${cls}" title="${esc(tip)}" style="top:${top + 1}px;height:${hgt}px;left:calc(${(e.col / e.ncol) * 100}% + 2px);width:calc(${100 / e.ncol}% - 4px)">
        <div class="t1"><span class="tm">${hhmm(e.s)}–${hhmm(e.en)}</span><span class="tt">${e.url ? ext(e.url, esc(e.title)) : esc(e.title)}</span>${hgt < 38 ? stk : ""}</div>
        ${hgt >= 38 ? `<div class="t2">${stk}${where}</div>` : ""}</div>`;
  }
  if (isToday && now >= d0 + h0 * 3600000 && now <= d0 + h1 * 3600000) g += `<div class="nowline" style="top:${y(now)}px"><span>${hhmm(now)}</span></div>`;
  html += `<div class="day" data-day="${day}" data-h0="${h0}" data-h1="${h1}" style="height:${(h1 - h0) * PPH}px">${g}</div>`;
  box.innerHTML = html;
}

/** Mon–Sun: header (today highlighted), all-day row, 7 timed columns; the now-line only in today's column. */
export function renderWeek(box, days, cal) {
  const now = Date.now(), today = todayYmd();
  const per = days.map((d) => ({ day: d, ...eventsForDay(cal, d) }));
  const [h0, h1] = hourSpan(per);
  const total = per.reduce((n, p) => n + meetings(p.timed).length, 0), allN = per.reduce((n, p) => n + p.allDay.length, 0);
  $("ag-count").textContent = [total ? `회의 ${total}` : "", allN ? `종일 ${allN}` : ""].filter(Boolean).join(" · ");
  const head = per.map((p) => { const d = parseYmd(p.day), wd = d.getDay(); return `<div class="wd${p.day === today ? " today" : ""}${wd === 0 || wd === 6 ? " we" : ""}"><span>${WEEK[wd]}</span><b>${d.getDate()}</b></div>`; }).join("");
  const allRow = allN ? `<div class="wk-all"><span class="wl">종일</span>${per.map((p) => `<div class="wc">${p.allDay.map((e) => { const u = safeUrl(e.url); return `<div class="wa${pendCls(e)}" title="${esc(e.title + pendTip(e))}">${u ? ext(u, esc(e.title)) : esc(e.title)}</div>`; }).join("")}</div>`).join("")}</div>` : "";
  let lines = "";
  for (let h = h0; h <= h1; h++) lines += `<div class="hr" style="top:${(h - h0) * PPH}px"><span>${pad(h)}</span></div>`;
  const cols = per.map((p) => {
    layoutCols(p.timed);
    const y = (t) => ((t - p.d0) / 3600000 - h0) * PPH;
    let g = "";
    for (const e of p.timed) {
      const top = y(e.s), hgt = Math.max(MIN_EV_PX, y(e.en) - top) - 2;
      const cls = [e.en <= now ? "past" : "", e.s <= now && now < e.en && e.rsvp !== "declined" ? "now" : "", e.rsvp === "needsAction" ? "ask" : "", e.rsvp === "declined" ? "no" : ""].join(" ") + pendCls(e);
      g += `<div class="cev wev ${cls}" title="${esc(`${hhmm(e.s)}–${hhmm(e.en)} ${e.title}${e.location ? " · " + e.location : ""}${pendTip(e)}`)}" style="top:${top + 1}px;height:${hgt}px;left:calc(${(e.col / e.ncol) * 100}% + 1px);width:calc(${100 / e.ncol}% - 2px)"><span class="tm">${hhmm(e.s)}</span> <span class="tt">${e.url ? ext(e.url, esc(e.title)) : esc(e.title)}</span></div>`;
    }
    if (p.day === today && now >= p.d0 + h0 * 3600000 && now <= p.d0 + h1 * 3600000) g += `<div class="nowline" style="top:${y(now)}px"></div>`;
    return `<div class="wcol${p.day === today ? " today" : ""}" data-day="${p.day}">${g}</div>`;
  }).join("");
  box.innerHTML = `<div class="wk"><div class="wk-head"><span class="wl"></span>${head}</div>${allRow}<div class="wk-body" data-h0="${h0}" data-h1="${h1}" style="height:${(h1 - h0) * PPH}px"><div class="wk-lines">${lines}</div><div class="wk-cols">${cols}</div></div></div>`;
}

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  ui.cal = loadCal();
  S.calRanges = {};
  S.calPending = [];
  initCreate(); // ＋ / drag / click → new event popup (features/calcreate.js)
  $("cal-card").addEventListener("click", (e) => {
    const v = e.target.closest("[data-cv]"), n = e.target.closest("[data-cn]");
    if (v) calView(v.dataset.cv);
    else if (n) calMove(Number(n.dataset.cn));
  });
}
