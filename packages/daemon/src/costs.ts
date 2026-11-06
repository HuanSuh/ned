import path from "node:path";
import { NED_HOME, localDay, readJson, writeJsonAtomic } from "./paths.js";

/** ~/.ned/costs.json — `claude -p` spend per local day and job (agenda / agenda_context / heartbeat / draft / calendar / action). */
export const COSTS_PATH = path.join(NED_HOME, "costs.json");
const KEEP_DAYS = 30;

export type CostJob = "agenda" | "agenda_context" | "heartbeat" | "draft" | "calendar" | "action" | "chat";

export interface DayCost {
  total_usd: number;
  runs: number;
  jobs: Record<string, { usd: number; runs: number }>;
}

interface CostFile {
  days: Record<string, DayCost>;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Add one run's cost to today's ledger (sync read-modify-write: one process, no interleaving). */
export function recordCost(job: CostJob, usd: number, day = localDay()): void {
  if (!Number.isFinite(usd) || usd < 0) return;
  const f = readJson<CostFile>(COSTS_PATH, { days: {} });
  if (!f.days || typeof f.days !== "object") f.days = {};
  const d = (f.days[day] ??= { total_usd: 0, runs: 0, jobs: {} });
  const j = (d.jobs[job] ??= { usd: 0, runs: 0 });
  j.usd = round(j.usd + usd);
  j.runs++;
  d.total_usd = round(d.total_usd + usd);
  d.runs++;
  for (const k of Object.keys(f.days).sort().slice(0, -KEEP_DAYS)) delete f.days[k];
  try {
    writeJsonAtomic(COSTS_PATH, f);
  } catch {
    /* NED_HOME missing (tests): costs are best-effort */
  }
}

/** Today's total spend in USD. */
export function todayCost(day = localDay()): number {
  return readJson<CostFile>(COSTS_PATH, { days: {} }).days?.[day]?.total_usd ?? 0;
}

/** GET /api/costs: today + the last `days` days, newest first. */
export function costSummary(budgetUsd: number, days = 14): { today: string; today_usd: number; budget_usd: number; over_budget: boolean; days: (DayCost & { day: string })[] } {
  const f = readJson<CostFile>(COSTS_PATH, { days: {} });
  const today = localDay();
  const list = Object.entries(f.days ?? {})
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, days)
    .map(([day, d]) => ({ day, ...d }));
  const t = f.days?.[today]?.total_usd ?? 0;
  return { today, today_usd: t, budget_usd: budgetUsd, over_budget: t >= budgetUsd, days: list };
}
