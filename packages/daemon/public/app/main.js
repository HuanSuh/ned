/* Boot: header, loaders + polling, view routing, keyboard map, window.NED. */
import { api, postJson } from "./api.js";
import { agendaActive, followAgenda, init as initAgStatus, loadCosts } from "./features/agstatus.js";
import { init as initCalendar } from "./features/calendar.js";
import { init as initCardLayout } from "./features/cardlayout.js";
import { noteBuild } from "./features/build.js";
import { init as initLayout } from "./features/layout.js";
import { init as initCards } from "./features/cards.js";
import { init as initComms } from "./features/comms.js";
import { init as initDrafts } from "./features/drafts.js";
import { init as initReviewed } from "./features/reviewed.js";
import { init as initSlackThread } from "./features/slackthread.js";
import { init as initTodoSplit, setMeFold, isMeFolded } from "./features/todosplit.js";
import { emit, store } from "./state.js";
import { init as initHome } from "./tabs/home.js";
import { dashActive, initActivityPing } from "./features/autosched.js";
import { init as initSettings } from "./tabs/settings.js";
import { init as initChips } from "./ui/chips.js";
import { init as initPopover } from "./ui/popover.js";
import { HOME_POLL_MS, calMove, calView, renderAgenda } from "./features/calendar.js";
import { packCards } from "./features/cards.js";
import { DR } from "./features/drafts.js";
import { V, applyPersona, mood, opener, persona, quip, say } from "./features/personas.js";
import { openAtt } from "./features/reviewed.js";
import { S, alive, ui } from "./state.js";
import { renderHome } from "./tabs/home.js";
import { closeDetail, dismissSelected, listOf, model, openDetail, renderInbox, select, setTab, syncRailButton } from "./tabs/inbox.js";
import { renderConfig, renderExcl } from "./tabs/settings.js";
import { renderTimeline } from "./tabs/timeline.js";
import { MOOD_KO } from "./ui/icons.js";
import { errBadge, errSummary } from "./ui/popover.js";
import { toast } from "./ui/toast.js";
import { $, POLL_MS, esc, hhmm, mdhm, rel } from "./util.js";

// ---------- header ----------
export function renderHeader() {
  const m = mood(), s = S.state;
  document.body.dataset.mood = m;
  $("mood").textContent = V().mood[m] || MOOD_KO[m];
  const n = openAtt().length; // 확인 완료 items don't count
  document.title = n ? `(${n}) ${V().name}` : V().name;
  const up = alive();
  const lb = s?.last_briefing;
  $("leds").innerHTML = `
      <span title="${esc(s?.updated_at ? "갱신 " + mdhm(s.updated_at) + " · pid " + s.daemon_pid : "")}"><span class="led ${up ? "g" : "r"}"></span>daemon ${up ? "on" : "off"}</span>${S.conn === false
        ? errBadge("daemon-conn", { where: "daemon 연결", message: `GET /api/state 가 실패했어 (${S.connErr || "network"}). daemon 이 꺼졌거나 포트가 바뀌었을 수 있어. 10초마다 다시 시도 중.`, at: S.connErrAt || Date.now(), retry: () => loadState() })
        : !up && s ? errBadge("daemon-stale", { where: "daemon 응답 없음", message: `state.json 이 ${rel(s.updated_at)} (${mdhm(s.updated_at)}) 이후 갱신되지 않았어. pid ${s.daemon_pid} 가 멈췄거나 종료됐을 수 있어.`, at: s.updated_at, retry: () => loadState() }) : ""}${S.hbErr
        ? errBadge("heartbeat", { where: S.hbErr.daily ? "아침 브리핑 실행" : "점검 실행", message: S.hbErr.message, at: S.hbErr.at, retry: () => runHeartbeat(S.hbErr.daily) }) : ""}
      <span><span class="led ${n ? "a" : ""}"></span>attn ${n}</span>
      <span class="opt"><span class="led ${s?.quiet ? "b" : ""}"></span>quiet</span>
      <span class="opt" title="${esc(lb ? `${lb.type === "daily" ? "아침" : "점검"} ${lb.ok === false ? "실패" : lb.status}${lb.headline ? " · " + lb.headline : ""}` : "")}">last ${s?.last_heartbeat_at ? rel(s.last_heartbeat_at) : "—"}</span>
      <span>next ${s?.next_heartbeat_at ? rel(s.next_heartbeat_at) : "—"}</span>`;
  const o = opener();
  $("say").innerHTML = say(`ned · ${hhmm(Date.now())}`, esc(o.lead), esc(o.sub));
  $("say-settings").innerHTML = say("ned", esc(V().settings[0]), esc(V().settings[1]));
}

export function setBusyButtons() {
  const b1 = $("btn-hb"), b2 = $("btn-daily");
  b1.disabled = b2.disabled = !!S.busy;
  if (!S.busy) { b1.textContent = "지금 점검"; b2.textContent = "아침 브리핑"; return; }
  const secs = Math.round((Date.now() - S.busy.t0) / 1000);
  const target = S.busy.daily ? b2 : b1;
  // Two steps (GET /api/check): agenda phase 1 → claude judging. Unknown (old daemon) → the old single label.
  const label = S.busy.phase === "agenda" ? "데이터 갱신 중…" : S.busy.phase === "judge" ? "판단 중…" : S.busy.daily ? "정리 중" : "스캔 중";
  target.innerHTML = `<span class="spin"></span>${label} ${secs}초`;
}

/** Follow the daemon-side step of the running check; entering "agenda" also starts the per-card agenda spinners. */
async function pollCheck() {
  try {
    const st = await api("/api/check");
    if (!S.busy || !st?.running || !st.phase || st.phase === S.busy.phase) return;
    S.busy.phase = st.phase; setBusyButtons();
    if (st.phase === "agenda") loadAgenda().then(followAgenda);
  } catch { /* old daemon: keep the generic label */ }
}

export let busyTick = 0;
/** '지금 점검' = POST /api/check (agenda refresh → judge); '아침 브리핑' = POST /api/heartbeat?daily=1. */
export async function runHeartbeat(daily) {
  if (S.busy) return;
  S.busy = { daily, t0: Date.now(), phase: daily ? null : "agenda" };
  setBusyButtons(); renderHeader();
  let n = 0;
  busyTick = setInterval(() => { setBusyButtons(); if (++n % 2 === 1) pollCheck(); }, 1000);
  try {
    let b;
    if (daily) b = await api("/api/heartbeat?daily=1", { method: "POST" });
    else {
      try { b = await api("/api/check", { method: "POST" }); }
      catch (e) { if (e.status !== 404) throw e; S.busy.phase = null; b = await api("/api/heartbeat", { method: "POST" }); }
      loadAgenda().then(followAgenda); loadCosts();
    }
    S.hbErr = null;
    if (b && b.status === "skipped") toast("볼 게 없어서 건너뛰었어.");
    else if (b && b.status === "NED_OK") toast(`이상 무. ${quip(Date.now())}`);
    else if (b && b.status) toast(b.headline ? b.headline : "새 소식 있어. 우선 탭 봐 줘.", 6000);
    else toast("끝났어.");
  } catch (e) {
    console.warn(e); S.hbErr = { message: e.message, at: Date.now(), daily }; toast(`순찰 실패 — ${errSummary(e.message)} (⚠ 를 눌러 자세히)`, 6000);
  } finally {
    clearInterval(busyTick);
    S.busy = null; setBusyButtons();
    await Promise.all([loadState(), loadBriefings(), loadEvents()]);
  }
}

// ---------- loaders ----------
export let lastUpdated = 0, lastBriefId; // undefined until the first poll
export async function loadState() {
  try {
    const s = await api(dashActive() ? "/api/state?visible=1" : "/api/state"); // visible+focused = user activity (idle mode)
    S.state = s; S.conn = true; S.connErrAt = 0;
    noteBuild(s.build_id); // daemon restarted on new code → reload banner + settings save lock
    if (s.persona && s.persona !== persona) applyPersona(s.persona);
    const bid = s.last_briefing?.id ?? null;
    const tasks = [];
    if (lastUpdated && s.updated_at !== lastUpdated) tasks.push(loadEvents(false));
    if (lastBriefId !== undefined && bid !== lastBriefId) tasks.push(loadBriefings(false));
    lastUpdated = s.updated_at; lastBriefId = bid;
    await Promise.all(tasks);
  } catch (e) {
    console.warn("state", e.message); S.conn = false; S.connErr = e.message; S.connErrAt = S.connErrAt || Date.now();
  }
  renderAll();
}
export async function loadEvents(render = true) {
  try { S.events = await api("/api/events?days=2"); } catch (e) { console.warn("events", e.message); }
  if (render) renderAll();
}
export async function loadBriefings(render = true) {
  try { S.briefings = (await api("/api/briefings?limit=30")).sort((a, b) => b.ts - a.ts); } catch (e) { console.warn("briefings", e.message); }
  if (render) renderAll();
}
export async function loadAgenda(render = true) {
  try { [S.agenda] = await Promise.all([api("/api/agenda"), loadCosts()]); }
  catch (e) { if (e.status !== 404) console.warn("agenda", e.message); if (e.status === 404 || S.agenda === undefined) S.agenda = null; }
  if (render) renderAll();
  if (agendaActive(S.agenda)) followAgenda(); // a run (scheduled or from 새로고침) is landing source by source
}
export async function loadTodos(render = true) {
  try { const t = await api("/api/todos"); S.todos = Array.isArray(t) ? t : []; }
  catch (e) { if (e.status !== 404) console.warn("todos", e.message); if (e.status === 404 || S.todos === undefined) S.todos = null; }
  if (render) renderAll();
}
export async function loadConfig() {
  try { S.config = await api("/api/config"); noteBuild(S.config?.build_id); renderConfig(); } catch (e) { console.warn("config", e.message); }
}
export function renderAll() {
  renderHeader();
  if (ui.view === "home") renderHome();
  if (ui.view === "inbox") renderInbox();
  if (ui.view === "timeline") renderTimeline();
  if (ui.view === "settings" && S.config) renderExcl(); // candidates follow agenda/briefings as they load
  emit("render", ui.view);
}

// ---------- views + keys ----------
export const VIEWS = ["home", "inbox", "timeline", "settings"];
export function setView() {
  const v = (location.hash || "#home").slice(1);
  ui.view = VIEWS.includes(v) ? v : "home";
  for (const id of VIEWS) $("v-" + id).hidden = ui.view !== id;
  for (const a of $("views").children) a.classList.toggle("on", a.dataset.v === ui.view);
  if (ui.view === "settings" && !S.config) loadConfig();
  renderAll();
}

export const TAB_KEYS = { 1: "priority", 2: "other", 3: "history" };
export let resizeT = 0;

/** For search.js and future modules: the store, the API wrappers and navigation. (No `data` key on purpose —
 *  search.js keeps fetching with its own 30 s cache, exactly as before the split.) */
export const nav = { go: (view) => { location.hash = `#${view}`; }, tab: setTab, view: () => ui.view };
window.NED = { store, api: { api, postJson }, nav };

// Every module's listeners + one-time setup, in the order the single file ran them — listener order on document
// matters (e.g. the error popover's Esc stopImmediatePropagation runs before the page keys in boot()).
for (const init of [initChips, initPopover, initSettings, initCardLayout, initLayout, initReviewed, initDrafts, initCalendar, initCards, initSlackThread, initAgStatus, initHome, initTodoSplit, initComms, initActivityPing]) init();
boot();

function boot() {
  window.addEventListener("hashchange", setView);
  document.addEventListener("keydown", (ev) => {
    if (DR.open) return; // the draft modal owns the keyboard
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (ev.key === "r") { runHeartbeat(false); return; }
    if (ev.key === "h") { location.hash = "#home"; return; }
    if (ev.key === "i") { location.hash = "#inbox"; return; }
    if (ui.view === "home") {
      // Calendar panel focused (it or a control inside): ←/→ move, t today, d/w day/week.
      if ($("cal-card").contains(document.activeElement)) {
        const k = { ArrowLeft: () => calMove(-1), ArrowRight: () => calMove(1), t: () => calMove(0), d: () => calView("day"), w: () => calView("week") }[ev.key];
        if (k) { k(); ev.preventDefault(); return; }
      }
      if (ev.key === "n") { if (isMeFolded()) setMeFold(false); $("tadd-t").focus(); ev.preventDefault(); }
      else if (TAB_KEYS[ev.key]) { ui.tab = TAB_KEYS[ev.key]; ui.sel = 0; ui.selKey = null; location.hash = "#inbox"; }
      return;
    }
    if (ui.view !== "inbox") return;
    const list = listOf(model());
    if (ev.key === "j" || ev.key === "ArrowDown") { select(ui.sel + 1); ev.preventDefault(); }
    else if (ev.key === "k" || ev.key === "ArrowUp") { select(ui.sel - 1); ev.preventDefault(); }
    else if (ev.key === "e") dismissSelected();
    else if (ev.key === "Enter") {
      if (t && t.tagName === "BUTTON" || t && t.tagName === "A") return;
      const it = list[ui.sel];
      if (it?.url) window.open(it.url, "_blank", "noopener"); else if (it) openDetail();
    }
    else if (ev.key === "1") setTab("priority");
    else if (ev.key === "2") setTab("other");
    else if (ev.key === "3") setTab("history");
    else if (ev.key === "Escape") closeDetail();
  });

  $("btn-hb").title = "지금 점검 (r) — 메일·Slack·Jira·GitHub·캘린더를 새로 가져온 뒤 판단 · 1~2분";
  $("btn-hb").addEventListener("click", () => runHeartbeat(false));
  $("btn-daily").addEventListener("click", () => runHeartbeat(true));
  for (const b of document.querySelectorAll("[data-refresh]")) b.addEventListener("click", () => (b.dataset.refresh === "events" ? Promise.all([loadEvents(), loadBriefings()]) : loadConfig()));
  if (ui.railOff) $("inbox").classList.add("rail-off");
  window.addEventListener("resize", () => {
    syncRailButton();
    clearTimeout(resizeT); resizeT = setTimeout(() => { if (ui.view === "home") { renderAgenda(); packCards(); } }, 150); // timeline height follows the window
  });

  setView();
  applyPersona(persona, { save: false });
  Promise.all([loadBriefings(false), loadEvents(false), loadConfig(), loadAgenda(false), loadTodos(false)]).then(loadState);
  setInterval(() => { if (!document.hidden) { loadAgenda(); loadTodos(); } }, HOME_POLL_MS);
  setInterval(() => { if (!document.hidden) loadState(); }, POLL_MS);
  setInterval(renderAll, 60 * 1000); // relative times drift
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadState(); loadAgenda(false); loadTodos(false); } });
}
