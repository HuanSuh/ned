import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCalendar, rangeBounds, type CalendarItem } from "./agenda.js";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
import type { NedConfig } from "./config.js";
import { CALENDAR_DIR, log, readJson, writeJsonAtomic } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = path.resolve(here, "../../../prompts/calendar.md");
const CACHE_MS = 6 * 3600_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface CalendarRange {
  from: string;
  to: string;
  calendar: CalendarItem[];
  fetched_at: number;
  cached: boolean;
  cost_usd: number;
  error?: string;
}

/** Validate a local date range (inclusive, ≤ 42 days). Returns an error message or null. */
export function checkRange(from: unknown, to: unknown): string | null {
  if (typeof from !== "string" || typeof to !== "string" || !DAY.test(from) || !DAY.test(to)) return "from/to must be YYYY-MM-DD";
  const a = Date.parse(`${from}T00:00:00`), b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "to must be on or after from";
  if ((b - a) / 86400_000 > 41) return "range too long (max 42 days)";
  return null;
}

const cachePath = (from: string, to: string) => path.join(CALENDAR_DIR, `${from}_${to}.json`);
const inflight = new Map<string, Promise<CalendarRange>>();
let queue: Promise<unknown> = Promise.resolve(); // one claude -p at a time

/**
 * Events for a local date range outside agenda.calendar_range: 6 h file cache, else a calendar-only
 * `claude -p` (maxTurns 6). Same-range callers share one run (busy guard); different ranges queue.
 */
export function fetchCalendarRange(cfg: NedConfig, from: string, to: string): Promise<CalendarRange> {
  const key = `${from}_${to}`;
  const hit = readJson<CalendarRange | null>(cachePath(from, to), null);
  if (hit && Date.now() - hit.fetched_at < CACHE_MS) return Promise.resolve({ ...hit, cached: true });
  const running = inflight.get(key);
  if (running) return running;
  const p = (queue = queue.then(() => doFetch(cfg, from, to), () => doFetch(cfg, from, to))) as Promise<CalendarRange>;
  inflight.set(key, p);
  return p.finally(() => inflight.delete(key));
}

/** Drop cached /api/calendar ranges that overlap [from, to] (a new event there would be missing for 6 h). Returns how many. */
export function invalidateCalendarRanges(from: string, to: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(CALENDAR_DIR)) {
      const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m && m[1] <= to && from <= m[2]) { fs.rmSync(path.join(CALENDAR_DIR, f), { force: true }); n++; }
    }
  } catch {
    /* no cache dir yet */
  }
  return n;
}

export function calendarBusy(): string[] {
  return [...inflight.keys()];
}

async function doFetch(cfg: NedConfig, from: string, to: string): Promise<CalendarRange> {
  const base = { from, to, fetched_at: Date.now(), cached: false, cost_usd: 0 };
  if (!cfg.sources.calendar) return { ...base, calendar: [] };
  if (llmDisabled()) {
    log(`calendar ${from}..${to}: NED_NO_LLM=1 — empty`);
    return { ...base, calendar: [] }; // not cached: a later real run should fetch
  }
  const { start, end } = rangeBounds(from, to);
  const prompt = fs
    .readFileSync(PROMPT, "utf8")
    .replaceAll("{{NOW}}", new Date().toISOString())
    .replaceAll("{{TZ}}", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .replaceAll("{{FROM}}", from)
    .replaceAll("{{TO}}", to)
    .replaceAll("{{START}}", start)
    .replaceAll("{{END}}", end);
  log(`calendar ${from}..${to}: asking claude`);
  const res = await runClaude(prompt, { allowedTools: ["ToolSearch", "mcp__claude_ai_Google_Calendar__list_events"], maxTurns: 6, model: cfg.claude_model, timeoutMs: 3 * 60_000, job: "calendar" });
  const parsed = res.ok ? extractJson<{ calendar?: unknown }>(res.text) : null;
  if (!parsed) {
    const error = res.ok ? `invalid JSON from model: ${res.text.slice(0, 200)}` : (res.error ?? "claude failed").slice(0, 300);
    log(`calendar ${from}..${to}: failed — ${error}`);
    return { ...base, calendar: [], cost_usd: res.cost_usd, error };
  }
  const out: CalendarRange = { ...base, calendar: normalizeCalendar(parsed.calendar), cost_usd: res.cost_usd };
  writeJsonAtomic(cachePath(from, to), out);
  log(`calendar ${from}..${to}: ${out.calendar.length} events ($${res.cost_usd.toFixed(2)}, ${res.num_turns} turns, ${Math.round(res.duration_ms / 1000)}s)`);
  return out;
}
