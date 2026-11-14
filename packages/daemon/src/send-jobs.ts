/**
 * POST /api/send as a background job. A connector send runs `claude -p` for 30~60s — longer than a WKWebView fetch
 * waits — so the route answers 202 {job_id} at once and the dashboard polls GET /api/send/:job_id.
 *
 * - Same request (draft_id or ref, + source/mode/text) while one is running → that job's id, never a second send.
 * - Same draft_id + source/mode already sent ok within 10 min (memory or ~/.ned/sent-actions.log) → 409 already_sent.
 *   Calendar `create` has no draft: the same event (calendar + title + start/end) created ok within 10 min → 409.
 * - Jobs live in memory only; after a daemon restart GET answers 404 and the client looks in GET /api/actions.
 */
import { randomUUID } from "node:crypto";
import { eventKey } from "./calendar-create.js";
import { appendActionLog, gate, performSend, readActionLog, type SendRequest, type SendResult } from "./actions.js";
import type { NedConfig } from "./config.js";
import { log } from "./paths.js";
import { blockingRule, guardSend, needConfirmSummary, spendConfirmToken, type NeedConfirm } from "./send-guard.js";

export type SendJobState = "running" | "done";

export interface SendJob {
  id: string;
  key: string;
  req: SendRequest;
  state: SendJobState;
  started_at: number;
  finished_at?: number;
  result?: SendResult;
  /** Long multi-step jobs (session_create): the step running now, for the polling UI. */
  stage?: string;
}

export interface SendJobView {
  job_id: string;
  state: SendJobState;
  started_at: string;
  elapsed_ms: number;
  stage?: string;
  result?: Omit<SendResult, "status"> & { http_status: SendResult["status"]; error?: string };
}

/** Window in which a draft that was sent ok answers 409 instead of sending again. */
export const ALREADY_SENT_MS = 10 * 60_000;
/** Finished jobs are kept this long for GET /api/send/:id. */
const KEEP_DONE_MS = 30 * 60_000;
const MAX_JOBS = 300;

const jobs = new Map<string, SendJob>();

/** Identity of "the same send": the draft (or the ref when there is none) + source/mode + exact text. */
export function sendKey(req: SendRequest): string {
  if (req.event) return `${req.source}|${req.mode}|e:${JSON.stringify(req.event)}`;
  const who = req.draft_id ? `d:${req.draft_id}` : `r:${JSON.stringify(req.ref)}`;
  return `${req.source}|${req.mode}|${who}|${req.text}`;
}

function prune(now = Date.now()): void {
  for (const [id, j] of jobs) if (j.state === "done" && now - (j.finished_at ?? now) > KEEP_DONE_MS) jobs.delete(id);
  if (jobs.size <= MAX_JOBS) return;
  const done = [...jobs.values()].filter((j) => j.state === "done").sort((a, b) => (a.finished_at ?? 0) - (b.finished_at ?? 0));
  for (const j of done.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
}

export function viewJob(j: SendJob, now = Date.now()): SendJobView {
  const v: SendJobView = { job_id: j.id, state: j.state, started_at: new Date(j.started_at).toISOString(), elapsed_ms: (j.finished_at ?? now) - j.started_at };
  if (j.stage) v.stage = j.stage;
  if (j.result) {
    const { status, ...rest } = j.result;
    v.result = rest.ok ? { ...rest, http_status: status } : { ...rest, http_status: status, error: rest.detail };
  }
  return v;
}

export function getSendJob(id: string): SendJob | undefined {
  prune();
  return jobs.get(id);
}

/** A successful send of this draft (same source/mode) in the last 10 min — from memory, else from the action log. */
export function findRecentSent(req: SendRequest, now = Date.now()): { at: string; detail: string; job_id?: string } | null {
  if (req.event) {
    const k = eventKey(req.event);
    for (const j of jobs.values()) {
      const r = j.result;
      if (j.state === "done" && r?.ok && j.req.event && eventKey(j.req.event) === k && now - (j.finished_at ?? 0) <= ALREADY_SENT_MS) return { at: r.logged_at, detail: r.detail, job_id: j.id };
    }
    const hit = readActionLog(500).find((e) => e.ok && e.event_key === k && now - Date.parse(e.ts) <= ALREADY_SENT_MS);
    return hit ? { at: hit.ts, detail: hit.result } : null;
  }
  if (req.mode === "mark_read") {
    // Gmail 읽음 표시: same thread marked read ok within 10 min → don't run claude again.
    const t = req.ref.thread_id;
    if (!t) return null;
    for (const j of jobs.values()) {
      const r = j.result;
      if (j.state === "done" && r?.ok && j.req.mode === "mark_read" && j.req.ref.thread_id === t && now - (j.finished_at ?? 0) <= ALREADY_SENT_MS) return { at: r.logged_at, detail: r.detail, job_id: j.id };
    }
    const hit = readActionLog(500).find((e) => e.ok && e.mode === "mark_read" && e.ref?.thread_id === t && now - Date.parse(e.ts) <= ALREADY_SENT_MS);
    return hit ? { at: hit.ts, detail: hit.result } : null;
  }
  if (!req.draft_id) return null;
  for (const j of jobs.values()) {
    const r = j.result;
    if (j.state === "done" && r?.ok && j.req.draft_id === req.draft_id && j.req.source === req.source && j.req.mode === req.mode && now - (j.finished_at ?? 0) <= ALREADY_SENT_MS)
      return { at: r.logged_at, detail: r.detail, job_id: j.id };
  }
  const hit = readActionLog(500).find((e) => e.ok && e.draft_id === req.draft_id && e.source === req.source && e.mode === req.mode && now - Date.parse(e.ts) <= ALREADY_SENT_MS);
  return hit ? { at: hit.ts, detail: hit.result } : null;
}

/** First https link in a result detail (Slack permalink, Gmail url, PR comment url). */
export function linkOf(detail: string): string | undefined {
  return /https:\/\/[^\s"')]+/.exec(detail)?.[0];
}

export type StartOutcome =
  | { kind: "sync"; result: SendResult }
  | { kind: "already_sent"; sent: { at: string; detail: string; job_id?: string } }
  | { kind: "need_confirm"; need: NeedConfirm }
  | { kind: "job"; job: SendJob; reused: boolean };

/**
 * Start (or join) the job for `req`. A switched-off action or a `block` rule is refused synchronously (instant, logged
 * by performSend) so the popup can say so without polling. Then a running twin is joined / a recent send answers
 * already_sent, and only then the confirm step (send-guard.ts): a `confirm` rule or review issues without a valid
 * confirm_token → need_confirm (logged; the route answers 409). `run` is injectable for tests.
 */
export async function startSendJob(req: SendRequest, cfg: NedConfig, run: typeof performSend = performSend): Promise<StartOutcome> {
  prune();
  if (!gate(req, cfg).on || blockingRule(req, cfg)) return { kind: "sync", result: await run(req, cfg) };
  const key = sendKey(req);
  const live = [...jobs.values()].find((j) => j.state === "running" && j.key === key);
  if (live) return { kind: "job", job: live, reused: true };
  const sent = findRecentSent(req);
  if (sent) return { kind: "already_sent", sent };

  const decision = await guardSend(req, cfg);
  if (decision.kind === "confirm") {
    const { need, guard } = decision;
    appendActionLog({ ts: new Date().toISOString(), source: req.source, mode: req.mode, action: "need_confirm", ref: req.ref, draft_id: req.draft_id, text: req.text.slice(0, 120), ok: false, result: needConfirmSummary(need), ...(req.origin ? { origin: req.origin } : {}), ...(guard.rule ? { rule: guard.rule } : {}), ...(guard.review ? { review: guard.review } : {}) });
    log(`send: ${req.source}/${req.mode} held for confirm — ${needConfirmSummary(need).slice(0, 200)}`);
    return { kind: "need_confirm", need };
  }
  // The review may have taken a while: a twin started meanwhile is joined rather than sent twice.
  const twin = [...jobs.values()].find((j) => j.state === "running" && j.key === key);
  if (twin) return { kind: "job", job: twin, reused: true };
  req = { ...req, guard: decision.guard };
  if (decision.guard.confirmed) spendConfirmToken(req.confirm_token); // one confirm = one send

  const job: SendJob = { id: randomUUID(), key, req, state: "running", started_at: Date.now() };
  jobs.set(job.id, job);
  void (async () => {
    let result: SendResult;
    try {
      result = await run(req, cfg);
    } catch (e) {
      const detail = `send job crashed: ${String(e).slice(0, 300)}`;
      log(`send: ${req.source}/${req.mode} job ${job.id} ${detail}`);
      const logged_at = new Date().toISOString();
      appendActionLog({ ts: logged_at, source: req.source, mode: req.mode, action: "error", ref: req.ref, draft_id: req.draft_id, text: req.text.slice(0, 120), ok: false, result: detail, ...(req.origin ? { origin: req.origin } : {}) });
      result = { ok: false, action: "error", detail, logged_at, status: 502 };
    }
    job.result = result;
    job.state = "done";
    job.finished_at = Date.now();
  })();
  return { kind: "job", job, reused: false };
}

/**
 * A job that is not a SendRequest → performSend (대화창에서 세션 만들기: worktree + agent boot + prompt, ~1-2 min).
 * Same map, same GET view, same crash → logged 502. A running job with the same `key` is joined. Gating and
 * dedupe are the caller's (it refuses synchronously before calling this).
 */
export function startTaskJob(key: string, req: SendRequest, run: (job: SendJob) => Promise<SendResult>): { job: SendJob; reused: boolean } {
  prune();
  const live = [...jobs.values()].find((j) => j.state === "running" && j.key === key);
  if (live) return { job: live, reused: true };
  const job: SendJob = { id: randomUUID(), key, req, state: "running", started_at: Date.now() };
  jobs.set(job.id, job);
  void (async () => {
    let result: SendResult;
    try {
      result = await run(job);
    } catch (e) {
      const detail = `job crashed: ${String(e).slice(0, 300)}`;
      log(`job: ${req.source}/${req.mode} ${job.id} ${detail}`);
      const logged_at = new Date().toISOString();
      appendActionLog({ ts: logged_at, source: req.source, mode: req.mode, action: "error", ref: req.ref, text: req.text.slice(0, 120), ok: false, result: detail });
      result = { ok: false, action: "error", detail, logged_at, status: 502 };
    }
    job.result = result;
    job.state = "done";
    job.finished_at = Date.now();
  })();
  return { job, reused: false };
}

/** Running jobs, optionally only those whose key starts with `prefix`. */
export function runningJobs(prefix = ""): SendJob[] {
  return [...jobs.values()].filter((j) => j.state === "running" && j.key.startsWith(prefix));
}

/** Test helper: forget every job. */
export function _resetSendJobs(): void {
  jobs.clear();
}
