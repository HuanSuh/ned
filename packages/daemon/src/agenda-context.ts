/**
 * Agenda phase 2: background reply-context collection.
 * After a source's phase-1 list lands in agenda.json, the items that need a reply and lack fresh context are read in small
 * batches (narrow tools, few turns) and merged back item by item, keyed by stable ids. Slack first, then mail.
 * The context shape is exactly what drafts.ts' fast path reads (SlackContext / MailContext), so drafts.ts is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMailContext, normalizeSlackContext, patchAgenda, pickSections, readAgenda, sourceSignature, type Agenda, type ContextStatus } from "./agenda.js";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
import { loadConfig, type NedConfig } from "./config.js";
import { recordCost, todayCost } from "./costs.js";
import { parseSlackUrl } from "./drafts.js";
import { log, readJson } from "./paths.js";
import { personaPrompt } from "./persona.js";
import { applyThreadState, DM_BATCH_MAX, dmCandidates, mergeThreadReads, threadCandidates, type SlackThread } from "./slack-threads.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = path.resolve(here, "../../../prompts/agenda-context.md");

export type CtxSource = "slack" | "mail";
const MAIL_REASONS = new Set(["reply", "approval", "request"]);

export interface CtxCandidate {
  src: CtxSource;
  /** Slack permalink / Gmail thread id — how the result is merged back. */
  key: string;
  from: string;
  text: string;
  ts: string;
}

const TOOLS: Record<CtxSource, string[]> = {
  slack: ["mcp__claude_ai_Slack__slack_read_thread", "mcp__claude_ai_Slack__slack_read_channel"],
  mail: ["mcp__claude_ai_Gmail__get_thread"],
};

const fresh = (iso: string | undefined, maxAgeMin: number, now: number) => !!iso && !Number.isNaN(Date.parse(iso)) && now - Date.parse(iso) <= maxAgeMin * 60_000;

/** Items of `src` that need a reply and have no context younger than draft_context_max_age_minutes (most urgent first). */
export function contextCandidates(a: Agenda, src: CtxSource, cfg: NedConfig, now = Date.now()): CtxCandidate[] {
  const out: CtxCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: CtxCandidate, ctxAt: string | undefined) => {
    if (!c.key || seen.has(c.key)) return;
    seen.add(c.key);
    if (!fresh(ctxAt, cfg.draft_context_max_age_minutes, now)) out.push(c);
  };
  if (src === "slack" && a.slack) {
    for (const x of a.slack.items) push({ src, key: x.url, from: x.from, text: x.text, ts: x.ts }, x.context?.collected_at);
    for (const w of a.slack.watch) for (const h of w.highlights) if (h.needs_me) push({ src, key: h.url, from: h.from, text: h.text, ts: h.ts }, h.context?.collected_at);
  }
  if (src === "mail" && a.mail) {
    for (const x of a.mail.items) if (MAIL_REASONS.has(x.reason)) push({ src, key: x.id, from: x.from, text: x.why || x.subject, ts: x.received }, x.context?.collected_at);
  }
  return out;
}

/** The batch prompt (prompts/agenda-context.md) for one source. */
export function buildContextPrompt(src: CtxSource, batch: CtxCandidate[]): string {
  const items =
    src === "slack"
      ? batch.map((c) => {
          const u = parseSlackUrl(c.key);
          return { key: c.key, channel_id: u.channel ?? "", ts: u.ts ?? "", thread_ts: u.thread_ts ?? "", from: c.from, ask: c.text };
        })
      : batch.map((c) => ({ key: c.key, thread_id: c.key, from: c.from, about: c.text }));
  const guide =
    src === "slack"
      ? [
          "- `thread_ts` 가 있으면 `slack_read_thread`(channel_id, message_ts=thread_ts, response_format `concise`, limit 30).",
          "- 없고 채널이 `D…`(DM)이면 `slack_read_channel`(channel_id, latest=ts 보다 1초 뒤, limit 6, response_format `concise`).",
          "- 그 밖(채널 메시지)은 `slack_read_thread`(channel_id, message_ts=ts, response_format `concise`, limit 30) — 답글이 없으면 그 메시지 하나.",
          "- 옮길 것: 대상 메시지(ts)까지의 **최근 최대 5개, 오래된 순**, 각 `text` 원문 최대 300자 (넘치면 자름). 내가 보낸 메시지는 `from` 을 `나` 로. `participants` 는 대화에 나온 표시 이름.",
        ].join("\n")
      : [
          "- 스레드마다 `get_thread`(threadId, messageFormat `PLAIN_TEXT`).",
          "- 기준은 스레드의 마지막 **다른 사람이 보낸** 메시지: `from` `이름 <주소>`, `to` 받는 사람(쉼표 구분), `subject`, `body_excerpt` 그 본문 원문 — 인용된 이전 메일(`>` 줄, `On … wrote:`/`… 님이 작성:` 이하)과 서명·면책 문구는 지우고 최대 1500자, `attachments` 첨부 파일 이름(없으면 `[]`), `message_id` 그 메시지 id, `reply_to` 그 발신자 주소.",
        ].join("\n");
  const schema =
    src === "slack"
      ? '{"contexts":[{"key":"<항목 key 그대로>","participants":["이름"],"messages":[{"from":"이름|나","ts":"ISO","text":"원문 ≤300자"}]}]}'
      : '{"contexts":[{"key":"<항목 key 그대로>","from":"","to":"","subject":"","body_excerpt":"≤1500자","attachments":[],"message_id":"","reply_to":""}]}';
  return pickSections(fs.readFileSync(PROMPT, "utf8"), new Set(["context"]))
    .replace("{{TOOL_SELECT}}", `select:${TOOLS[src].join(",")}`)
    .replace("{{GUIDE}}", () => guide)
    .replace("{{ITEMS}}", () => items.map((i) => JSON.stringify(i)).join("\n"))
    .replace("{{SCHEMA}}", () => schema);
}

/** Write one batch's contexts into agenda.json, item-level (every row with that permalink / thread id). Returns how many landed. */
export function mergeContexts(src: CtxSource, raw: unknown[], collectedAt = new Date().toISOString()): number {
  let n = 0;
  patchAgenda((a) => {
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const key = String((r as Record<string, unknown>).key ?? "");
      if (!key) continue;
      let hit = false;
      if (src === "slack" && a.slack) {
        const ctx = normalizeSlackContext(r, collectedAt);
        if (!ctx) continue;
        for (const x of [...a.slack.items, ...a.slack.all, ...a.slack.watch.flatMap((w) => w.highlights)]) if (x.url === key) { x.context = ctx; hit = true; }
      } else if (src === "mail" && a.mail) {
        const ctx = normalizeMailContext(r, collectedAt);
        if (!ctx) continue;
        for (const x of a.mail.items) if (x.id === key) { x.context = ctx; hit = true; }
      }
      if (hit) n++;
    }
  });
  return n;
}

// ---------- Slack thread follow-up (slack-threads.ts) ----------

const THREAD_TOOLS = ["mcp__claude_ai_Slack__slack_read_thread"];
const DM_TOOLS = ["mcp__claude_ai_Slack__slack_read_channel"];
const THREAD_SCHEMA = '{"threads":[{"key":"<항목 key 그대로>","reply_count":0,"my_last_reply_ts":"","new_since_me":0,"thread_summary":"한 줄 ≤60자 (다시 쓸 필요 없으면 빈 문자열)","participants":["이름"],"messages":[{"from":"이름|나","ts":"1730860000.123456","text":"원문 ≤300자"}]}]}';

/** Tools a thread/DM batch needs: slack_read_channel only when it has DM conversations. */
const threadTools = (dms: SlackThread[]) => [...THREAD_TOOLS, ...(dms.length ? DM_TOOLS : [])];

/** The batch prompt that re-reads followed threads + DM conversations (prompts/agenda-context.md, `threads` section). */
export function buildThreadPrompt(batch: SlackThread[], cfg: NedConfig, dms: SlackThread[] = []): string {
  // known_last_reply_ts + has_summary: the model writes thread_summary only when the thread moved (or has none yet).
  const items: object[] = batch.map((t) => ({ key: t.key, channel_id: t.channel_id, thread_ts: t.thread_ts, channel: t.channel, known_last_reply_ts: t.last_reply_ts ?? "", has_summary: !!t.thread_summary }));
  for (const d of dms) items.push({ key: d.key, kind: "dm", channel_id: d.channel_id, channel: d.channel, known_last_ts: d.last_reply_ts ?? "" });
  return pickSections(fs.readFileSync(PROMPT, "utf8"), new Set(["threads"]))
    .replace("{{TOOL_SELECT}}", `select:${threadTools(dms).join(",")}`)
    .replace("{{PERSONA}}", () => personaPrompt(cfg.persona))
    .replace("{{ITEMS}}", () => items.map((i) => JSON.stringify(i)).join("\n"))
    .replace("{{SCHEMA}}", () => THREAD_SCHEMA);
}

/** Merge one thread-read batch into agenda.json (thread records → rows: thread view, draft context, reopen). */
export function mergeThreads(raw: unknown[], now = Date.now()): string[] {
  let keys: string[] = [];
  patchAgenda((a) => {
    if (!a.slack) return;
    const isDm = (r: unknown) => String((r as { key?: unknown })?.key ?? "").startsWith("dm:");
    keys = [...mergeThreadReads(a.slack.threads ?? [], raw.filter((r) => !isDm(r)), now), ...mergeThreadReads(a.slack.dms ?? [], raw.filter(isDm), now)];
    applyThreadState(a.slack);
  });
  return keys;
}

/**
 * Re-read up to agenda_thread_batch followed threads (one narrow `claude -p`). Runs on every Slack pass, even when
 * the list signature is unchanged: new replies don't change the list. Returns "budget" when the day's spend is used up.
 */
export async function processThreads(cfg: NedConfig, now = Date.now()): Promise<"ok" | "none" | "budget"> {
  const a = readAgenda();
  const batch = threadCandidates(a.slack?.threads, cfg.agenda_thread_batch, now);
  const dms = dmCandidates(a.slack?.dms, DM_BATCH_MAX, now);
  if (!batch.length && !dms.length) return "none";
  if (overBudget(cfg)) {
    log(`agenda-threads: today's spend $${todayCost().toFixed(2)} ≥ budget $${cfg.agenda_daily_budget_usd} — not reading ${batch.length} thread(s), ${dms.length} DM(s)`);
    setStatus({ stopped: "budget" });
    return "budget";
  }
  const t = Date.now();
  let raw: unknown[] = [], cost = 0, turns = 0, err = "";
  const keys = new Set([...batch, ...dms].map((x) => x.key));
  if (llmDisabled()) {
    // NED_NO_LLM_THREADS = path to {"threads":[…]} (model-shaped); only the batch's keys are applied.
    const file = process.env.NED_NO_LLM_THREADS;
    const fx = file ? readJson<{ threads?: unknown }>(file, {}) : {};
    raw = (Array.isArray(fx.threads) ? fx.threads : []).filter((r) => keys.has(String((r as { key?: unknown })?.key ?? "")));
    // Unknown to the fixture: count it as read (nothing new) so it waits for the recheck interval.
    for (const k of keys) if (!raw.some((r) => (r as { key?: unknown }).key === k)) raw.push({ key: k, messages: [] });
  } else {
    const res = await runClaude(buildThreadPrompt(batch, cfg, dms), {
      allowedTools: ["ToolSearch", ...threadTools(dms)],
      tools: ["ToolSearch"],
      maxTurns: 6,
      model: cfg.agenda_light_model ?? cfg.claude_model,
      timeoutMs: 3 * 60_000,
      job: "agenda_context",
    });
    cost = res.cost_usd;
    turns = res.num_turns;
    const j = res.ok ? extractJson<{ threads?: unknown }>(res.text) : null;
    if (j && Array.isArray(j.threads)) raw = j.threads;
    else err = res.ok ? `invalid JSON: ${res.text.slice(0, 200)}` : (res.error ?? "claude failed").slice(0, 300);
  }
  // A failed call leaves checked_at alone, so the same threads are first in line next time.
  const done = err ? [] : mergeThreads(raw, now);
  setStatus({ cost_usd: Math.round((status.cost_usd + cost) * 10000) / 10000 });
  const fresh = readAgenda().slack?.threads?.filter((x) => done.includes(x.key) && x.new_since_me > 0).length ?? 0;
  log(`agenda-threads: ${done.length}/${batch.length + dms.length} threads/DMs read${fresh ? `, ${fresh} with replies after mine` : ""} — $${cost.toFixed(3)}, ${turns} turns, ${((Date.now() - t) / 1000).toFixed(1)}s${err ? ` — ${err}` : ""}`);
  return "ok";
}

// ---------- worker: one at a time, Slack before mail ----------

let running = false;
const queue = new Set<CtxSource>();
const forced = new Set<CtxSource>();
let latestCfg: NedConfig | null = null;
let status: ContextStatus = { pending: 0, done: 0, failed: 0, running: false, updated_at: 0, cost_usd: 0, stopped: null, skipped: [] };

export function contextBusy(): boolean {
  return running;
}

function setStatus(patch: Partial<ContextStatus>): void {
  status = { ...status, ...patch, updated_at: Date.now() };
  patchAgenda((a) => {
    a.context_status = status;
  });
}

/** Current phase-2 status (live `running`), falling back to what agenda.json recorded. */
export function contextStatus(): ContextStatus {
  const s = status.updated_at ? status : readAgenda().context_status ?? status;
  return { ...s, running };
}

/**
 * Queue phase 2 for these sources (no-op for sources that are off). `force` re-collects even when the list signature equals
 * the last completed one. Returns immediately; the worker runs in the background.
 */
export function requestContext(cfg: NedConfig, srcs: CtxSource[], opts: { force?: boolean } = {}): ContextStatus {
  latestCfg = cfg;
  for (const s of srcs) {
    if (s === "slack" ? !cfg.sources.slack : !cfg.sources.gmail) continue;
    queue.add(s);
    if (opts.force) forced.add(s);
  }
  // Fire-and-forget, but never let a background failure become an unhandled rejection that kills the daemon.
  if (!running && queue.size) {
    work().catch((e) => {
      running = false;
      try {
        setStatus({ running: false, stopped: "error", updated_at: Date.now() });
      } catch {
        /* NED_HOME may be gone (tests) */
      }
      log(`agenda-context: background run failed — ${String(e).slice(0, 300)}`);
    });
  }
  return contextStatus();
}

async function work(): Promise<void> {
  running = true;
  const started = Date.now();
  status = { pending: 0, done: 0, failed: 0, running: true, updated_at: Date.now(), cost_usd: 0, stopped: null, skipped: [] };
  setStatus({});
  try {
    while (queue.size) {
      const src: CtxSource = queue.has("slack") ? "slack" : "mail";
      queue.delete(src);
      const force = forced.delete(src);
      // Fresh config per source: a budget / batch-size change via PUT /api/config applies to the running worker.
      let cfg = latestCfg as NedConfig;
      try { cfg = loadConfig(); } catch { /* keep the queued one */ }
      let r: string = await processSource(src, cfg, force);
      if (src === "slack" && r !== "budget") r = await processThreads(cfg);
      if (r === "budget") {
        queue.clear();
        forced.clear();
        break;
      }
    }
  } catch (e) {
    log(`agenda-context: worker error ${String(e).slice(0, 300)}`);
  } finally {
    running = false;
    setStatus({ running: false });
    log(`agenda-context: done — ${status.done} collected, ${status.failed} failed, ${status.pending} pending${status.skipped.length ? `, skipped unchanged ${status.skipped.join(",")}` : ""}${status.stopped ? `, stopped: ${status.stopped}` : ""}, $${status.cost_usd.toFixed(2)}, ${Math.round((Date.now() - started) / 1000)}s`);
    const cfg = latestCfg;
    if (cfg?.drafts_pregenerate && status.done > 0) {
      // Drafts need the contexts phase 2 just wrote. Lazy import keeps the module graph acyclic at load time.
      import("./drafts.js").then((m) => m.pregenerateDrafts(readAgenda(), cfg)).catch((e) => log(`pregenerate: failed ${String(e)}`));
    }
  }
}

function overBudget(cfg: NedConfig): boolean {
  return todayCost() >= cfg.agenda_daily_budget_usd;
}

async function processSource(src: CtxSource, cfg: NedConfig, force: boolean): Promise<"ok" | "skipped" | "budget"> {
  const a = readAgenda();
  const sig = a.sources_status?.[src]?.signature ?? sourceSignature(src, a);
  if (!force && a.context_sigs?.[src] === sig) {
    log(`agenda-context[${src}]: list unchanged since last completed collection (sig ${sig}) — skipped`);
    setStatus({ skipped: [...status.skipped, src] });
    return "skipped";
  }
  const cands = contextCandidates(a, src, cfg);
  const batches: CtxCandidate[][] = [];
  for (let i = 0; i < cands.length; i += cfg.agenda_context_batch) batches.push(cands.slice(i, i + cfg.agenda_context_batch));
  setStatus({ pending: status.pending + cands.length });
  log(`agenda-context[${src}]: ${cands.length} items need context → ${batches.length} batch(es) of ≤${cfg.agenda_context_batch}`);

  let hardFail = false;
  for (const [i, batch] of batches.entries()) {
    if (overBudget(cfg)) {
      log(`agenda-context[${src}]: today's spend $${todayCost().toFixed(2)} ≥ budget $${cfg.agenda_daily_budget_usd} — stopping (${status.pending} pending)`);
      setStatus({ stopped: "budget" });
      return "budget";
    }
    const t = Date.now();
    let raw: unknown[] = [], cost = 0, turns = 0, err = "";
    if (llmDisabled()) {
      const delay = Number(process.env.NED_NO_LLM_DELAY_MS) || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      cost = Number(process.env.NED_NO_LLM_COST) || 0;
      if (cost) recordCost("agenda_context", cost);
      raw = batch.map((c) =>
        src === "slack"
          ? { key: c.key, participants: [c.from], messages: [{ from: c.from, ts: c.ts, text: `[stub] ${c.text}` }] }
          : { key: c.key, from: c.from, to: "me", subject: "(stub)", body_excerpt: `[stub] ${c.text}`, attachments: [] },
      );
    } else {
      const res = await runClaude(buildContextPrompt(src, batch), {
        allowedTools: ["ToolSearch", ...TOOLS[src]],
        tools: ["ToolSearch"],
        maxTurns: 6,
        model: cfg.agenda_light_model ?? cfg.claude_model,
        timeoutMs: 3 * 60_000,
        job: "agenda_context",
      });
      cost = res.cost_usd;
      turns = res.num_turns;
      const j = res.ok ? extractJson<{ contexts?: unknown }>(res.text) : null;
      if (j && Array.isArray(j.contexts)) raw = j.contexts;
      else err = res.ok ? `invalid JSON: ${res.text.slice(0, 200)}` : (res.error ?? "claude failed").slice(0, 300);
    }
    const n = mergeContexts(src, raw);
    const failed = batch.length - n;
    if (err) hardFail = true;
    setStatus({ pending: status.pending - batch.length, done: status.done + n, failed: status.failed + failed, cost_usd: Math.round((status.cost_usd + cost) * 10000) / 10000 });
    log(`agenda-context[${src}] batch ${i + 1}/${batches.length}: ${n}/${batch.length} contexts — $${cost.toFixed(3)}, ${turns} turns, ${((Date.now() - t) / 1000).toFixed(1)}s${err ? ` — ${err}` : ""}`);
  }
  // Only a clean pass marks this list "done": a failed call means the next run (same list) tries again.
  if (!hardFail) patchAgenda((x) => {
    x.context_sigs = { ...x.context_sigs, [src]: sig };
  });
  return "ok";
}
