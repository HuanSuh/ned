/* POST /api/send as a job: 202 {job_id} → poll GET /api/send/:id every 2s (max 4 min).
 * A connector send runs claude -p for 30~60s — longer than the app WebView's fetch waits — so nothing here holds a
 * request open. Pending jobs sit in localStorage so a reload still learns the outcome (and never re-sends). */
import { api, postJson } from "../api.js";
import { lsGet, lsSet } from "../util.js";
import { askSendConfirm, needsConfirm } from "./sendconfirm.js";

const POLL_MS = 2000;
export const MAX_WAIT_MS = 4 * 60_000;
const LS_KEY = "ned.pendingSends";
const KEEP_PENDING_MS = 30 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPending() {
  try { const v = JSON.parse(lsGet(LS_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writePending(list) { lsSet(LS_KEY, JSON.stringify(list)); }
function addPending(p) { writePending([...readPending().filter((x) => x.job_id !== p.job_id), p]); }
function dropPending(id) { writePending(readPending().filter((x) => x.job_id !== id)); }

/** Job result → the {ok, status, data} shape postJson returns, so callers keep their old checks. */
const fromResult = (res) => ({ ok: res.http_status === 200, status: res.http_status, data: res });

/** After a daemon restart the job is gone: look for its line in the action log (same draft/ref, mode, text, after start). */
async function fromActionLog(p) {
  let list;
  try { list = await api("/api/actions"); } catch (e) { return { ok: false, status: 0, unknown: true, data: { error: `결과 확인 실패 (${e.message})` } }; }
  const since = Date.parse(p.started_at || 0) - 5000;
  const hit = (list || []).find((e) => e.source === p.source && e.mode === p.mode && Date.parse(e.ts) >= since
    && (p.draft_id ? e.draft_id === p.draft_id : JSON.stringify(e.ref || {}) === JSON.stringify(p.ref || {}))
    && (!p.text || e.text === p.text.slice(0, 120)));
  if (hit) return { ok: !!hit.ok, status: hit.ok ? 200 : 502, fromLog: true, data: { ok: !!hit.ok, action: hit.action, detail: hit.result } };
  return { ok: false, status: 0, unknown: true, data: { error: "daemon 이 재시작돼 결과를 알 수 없어 — 설정 → '오늘 한 액션' 이나 대상 앱에서 확인해 줘" } };
}

/** Poll one job until done / lost / deadline (default: p.max_wait_ms or 4 min after it started). `onTick(elapsedMs, stage)` every poll. */
async function poll(p, onTick, deadline) {
  const t0 = Date.parse(p.started_at) || Date.now();
  const maxWait = p.max_wait_ms || MAX_WAIT_MS;
  deadline ??= t0 + maxWait;
  for (;;) {
    let r = null;
    try {
      const res = await fetch(`${p.endpoint || "/api/send"}/${encodeURIComponent(p.job_id)}`, { headers: { accept: "application/json" } });
      r = { status: res.status, data: await res.json().catch(() => null) };
    } catch { /* daemon briefly unreachable — keep trying until the deadline */ }
    if (r?.status === 404) return fromActionLog(p);
    if (r?.status === 200 && r.data?.state === "done" && r.data.result) return fromResult(r.data.result);
    onTick?.(r?.data?.elapsed_ms ?? Date.now() - t0, r?.data?.stage);
    if (Date.now() >= deadline) return { ok: false, status: 0, unknown: true, timedOut: true, data: { error: `${Math.round(maxWait / 60_000)}분 넘게 끝나지 않아 확인을 멈췄어 — 설정 → '오늘 한 액션' 이나 대상 앱에서 결과를 확인해 줘` } };
    await sleep(POLL_MS);
  }
}

/**
 * POST /api/send and wait for the outcome. Resolves {ok, status, data} like postJson:
 * - 403/400 come back at once (refused before any job);
 * - 409 + data.already_sent: this draft was already sent ok in the last 10 min (data.link);
 * - `unknown: true` when the daemon never confirmed (restart with no log line, 4-min deadline, network) — no retry then.
 * `opts.label` is kept with the pending job so a reload can say what finished.
 * `opts.endpoint` (default /api/send): another job route with the same shape (POST → 202, GET <endpoint>/:id), e.g.
 * /api/calendar/events with `opts.match` = {source, mode, ref} for the action-log fallback.
 * `opts.maxWaitMs`: a longer job (세션 만들기 — worktree + agent boot, a few minutes) than the 4-min default.
 */
export async function sendAndWait(body, { onTick, label, endpoint = "/api/send", match, maxWaitMs, confirm = askSendConfirm, confirmHost } = {}) {
  // A POST that never got an answer is safe to retry: the daemon joins a running job / answers 409 for a sent draft.
  const post = (b) => postJson(endpoint, b).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
  let r = await post(body);
  // 409 need_confirm (보내기 규칙 confirm / 자동 검토 이슈): the shared confirm step (sendconfirm.js). [그래도 보내기] → the
  // same body + confirm_token; [취소] → nothing is sent ({cancelled: true}). A stale token (5 min / changed body) asks again.
  for (let i = 0; i < 3 && needsConfirm(r); i++) {
    const go = await confirm(r.data, confirmHost);
    if (!go) return { ok: false, status: 409, cancelled: true, data: { ...r.data, error: "취소 — 보내지 않았어" } };
    r = await post({ ...body, confirm_token: r.data.confirm_token });
  }
  if (r.status !== 202 || !r.data?.job_id) return r;
  const m = match || body;
  const p = { job_id: r.data.job_id, started_at: r.data.started_at || new Date().toISOString(), label, endpoint, source: m.source, mode: m.mode, draft_id: m.draft_id, ref: m.ref, text: (m.text || "").trim(), ...(maxWaitMs ? { max_wait_ms: maxWaitMs } : {}) };
  if (body.mode !== "transitions") addPending(p); // a read-only listing isn't worth reporting after a reload
  const out = await poll(p, onTick);
  if (!out.timedOut) dropPending(p.job_id); // a timed-out job stays: the next page load checks once more
  return out;
}

/** Wait for a job someone else started (e.g. Gmail 읽음 표시 from POST …/review → mark_read.job_id). Same {ok, status, data}. */
export function waitJob(p, onTick) {
  return poll({ endpoint: "/api/send", ...p, started_at: p.started_at || new Date().toISOString() }, onTick);
}

/** Page load: for every job a previous page left pending, find out how it ended (resume polling if still running). */
export function resumePending(report) {
  const now = Date.now();
  for (const p of readPending()) {
    if (now - (Date.parse(p.started_at) || 0) > Math.max(KEEP_PENDING_MS, p.max_wait_ms || 0)) { dropPending(p.job_id); continue; }
    // still inside its 4 minutes → keep polling; past them → one look (deadline = now)
    poll(p, null, Math.max(now, (Date.parse(p.started_at) || now) + (p.max_wait_ms || MAX_WAIT_MS)))
      .then((r) => { dropPending(p.job_id); report(p, r); });
  }
}
