/* Agenda progress on the home tab (two-phase agenda, src/agenda.ts + agenda-context.ts):
 * - sources_status.<slack|mail|calendar|jira|github>: "running" → '갱신 중' spinner in that card / the 일정 panel header,
 *   "error" (incl. "interrupted" = the run died) → ⚠ badge (errBadge popover, retry = 새로고침).
 * - context_status (phase 2, reply context for Slack + mail): '맥락 수집 N/M' under those two cards while it runs;
 *   stopped === "budget" → '오늘 예산 소진' + a manual run (POST /api/agenda/context?force=1).
 * - followAgenda(): while agenda.busy (or phase 2 runs) re-read GET /api/agenda every 3 s so each card updates as
 *   its own source lands. Uses setTimeout, so the harness' manual poll ticks don't swallow it.
 * - costHtml(): '오늘 $x / $budget' from GET /api/costs (S.costs), warning colour when over_budget. */
import { api } from "../api.js";
import { loadAgenda } from "../main.js";
import { S } from "../state.js";
import { errBadge } from "../ui/popover.js";
import { toast } from "../ui/toast.js";
import { $, esc, rel } from "../util.js";

const SRC_LABEL = { slack: "Slack", mail: "메일", calendar: "일정", jira: "Jira", github: "GitHub" };
export const FOLLOW_MS = 3000;

/** ↻ in a source card header: refresh only that source (POST /api/agenda/refresh {sources:[key]}).
 *  title = '마지막 갱신 N분 전 · 주기 M분' (agenda.refresh_minutes = config.agenda_source_minutes ?? agenda_refresh_minutes). */
function refreshBtn(key, st) {
  const mins = S.agenda?.refresh_minutes?.[key];
  const last = st?.updated_at ? `${st.status === "error" ? "마지막 시도" : "마지막 갱신"} ${rel(st.updated_at)}${st.status === "error" ? " (실패)" : ""}` : "아직 갱신 안 됨";
  const title = `${SRC_LABEL[key]}만 지금 갱신 — ${last}${mins ? ` · 주기 ${mins}분` : ""}`;
  return `<button type="button" class="srefresh" data-srefresh="${key}" title="${esc(title)}" aria-label="${esc(title)}">↻</button>`;
}

function srcStatusHtml(key) {
  if (!S.agenda) return "";
  if (S.agenda.sources && S.agenda.sources[key === "mail" ? "gmail" : key] === false) return "";
  const st = S.agenda.sources_status?.[key];
  if (st?.status === "running") return `<span class="srun" title="${esc(SRC_LABEL[key])} 목록 가져오는 중"><span class="spin"></span>갱신 중</span>`;
  if (st?.status === "error") {
    const message = st.error === "interrupted"
      ? `${SRC_LABEL[key]} 목록을 가져오던 중에 끊겼어 (daemon 재시작 등). 이전 목록을 그대로 보여 주는 중 — 다시 시도하면 새로 가져와.`
      : st.error || "알 수 없는 오류";
    return errBadge(`src-${key}`, { where: `${SRC_LABEL[key]} 갱신 (agenda)`, message, at: st.updated_at || Date.now(), retry: () => refreshSource(key) }) + refreshBtn(key, st);
  }
  return refreshBtn(key, st);
}

/** One source only. Reuses the per-source '갱신 중' spinner (optimistic, then the server's own status) and
 *  followAgenda() re-renders as it lands. 409 = that source is already running. */
export async function refreshSource(key) {
  if (!S.agenda || !SRC_LABEL[key]) return;
  const prev = S.agenda.sources_status?.[key];
  S.agenda.sources_status = { ...(S.agenda.sources_status || {}), [key]: { ...(prev || {}), status: "running", updated_at: Date.now() } };
  S.agenda.busy = true;
  renderAgStatus();
  followAgenda();
  try {
    const a = await api("/api/agenda/refresh", { method: "POST", body: JSON.stringify({ sources: [key] }) });
    const st = a?.sources_status?.[key];
    if (st?.status === "error") toast(`${SRC_LABEL[key]} 갱신 실패 — ⚠ 를 눌러 자세히`, 6000);
    loadCosts();
  } catch (e) {
    if (e.status === 409) toast(`${SRC_LABEL[key]}은(는) 이미 갱신 중이야.`);
    else { console.warn(e); toast(`${SRC_LABEL[key]} 갱신 실패: ${e.message}`, 6000); }
  }
  await loadAgenda();
}

/** Context collection is one queue for Slack + mail; both cards show the same progress. */
function ctxHtml() {
  const c = S.agenda?.context_status;
  if (!c) return "";
  if (c.stopped === "budget") return `<span class="ctxw">오늘 예산 소진 — 맥락 수집 멈춤</span><button type="button" class="btn small" data-ctxforce="1" title="예산과 상관없이 지금 한 번 맥락 수집 (POST /api/agenda/context?force=1)">지금 수집</button>`;
  const total = (c.done || 0) + (c.pending || 0) + (c.failed || 0);
  if (!c.running && !c.pending) return "";
  return `<span class="spin"></span><span title="${c.failed ? `실패 ${c.failed}건 포함` : "답장 초안용 맥락"}">맥락 수집 ${c.done || 0}/${total}</span>`;
}

export function renderAgStatus() {
  for (const key of Object.keys(SRC_LABEL)) {
    const html = srcStatusHtml(key);
    // #st-<key> in the fixed card / 일정 headers; [data-src] in generated ones (팔로업 channel cards = slack).
    for (const el of [$("st-" + key), ...document.querySelectorAll(`.srcst[data-src="${key}"]`)]) if (el && el.innerHTML !== html) el.innerHTML = html;
  }
  const ctx = ctxHtml();
  for (const id of ["mail", "slack"]) { const el = $("ctx-" + id); el.innerHTML = ctx; el.hidden = !ctx; }
}

let followT = 0;
/** Re-read the agenda every 3 s until no source is running (busy) and phase 2 is idle. */
export function followAgenda() {
  if (followT) return;
  const tick = async () => {
    await loadAgenda();
    followT = S.agenda?.busy || S.agenda?.context_status?.running ? setTimeout(tick, FOLLOW_MS) : 0;
  };
  followT = setTimeout(tick, FOLLOW_MS);
}
export const agendaActive = (a) => !!(a?.busy || a?.context_status?.running);

export async function loadCosts() {
  try { S.costs = await api("/api/costs"); } catch (e) { if (e.status !== 404) console.warn("costs", e.message); }
}
/** '오늘 $x / $15' (falls back to the last run's phase-1 cost when /api/costs isn't there). */
export function costHtml(ag) {
  const c = S.costs;
  if (c && typeof c.today_usd === "number") {
    return `<span class="cost${c.over_budget ? " over" : ""}" title="오늘 claude -p 합계 / 일일 예산${ag?.cost_usd != null ? ` · 마지막 agenda $${Number(ag.cost_usd).toFixed(2)}` : ""}${c.over_budget ? " — 예산 초과: 맥락 수집은 멈춤" : ""}">오늘 $${c.today_usd.toFixed(2)} / $${Number(c.budget_usd).toFixed(0)}</span>`;
  }
  return ag?.cost_usd != null ? `<span>$${Number(ag.cost_usd).toFixed(2)}</span>` : "";
}

export function init() {
  // ↻ lives in card headers inside #sgrid and in the 일정 card (#cal-card) → delegate from the home grid.
  ($("hgrid") || document).addEventListener("click", (e) => {
    const b = e.target.closest("[data-srefresh]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    refreshSource(b.dataset.srefresh);
  });
  $("sgrid").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ctxforce]"); if (!b) return;
    b.disabled = true;
    try {
      const r = await api("/api/agenda/context?force=1", { method: "POST" });
      if (S.agenda && r?.context_status) S.agenda.context_status = r.context_status;
      toast("맥락 수집 시작했어.");
      renderAgStatus();
      followAgenda();
    } catch (err) { console.warn(err); toast(`맥락 수집 실패: ${err.message}`, 6000); b.disabled = false; }
  });
}
