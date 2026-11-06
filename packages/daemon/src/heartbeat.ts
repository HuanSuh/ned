import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson, llmDisabled, noLlmResult, runClaude } from "./claude.js";
import { inQuietHours, type NedConfig } from "./config.js";
import { readRecentEvents, readUnprocessedEvents, type NedEvent } from "./events.js";
import { notify } from "./notify.js";
import { BRIEFINGS_DIR, DISMISSED_PATH, SENT_LOG, log, readJson, writeJsonAtomic } from "./paths.js";
import { reduceSessions } from "./sessions.js";
import { readState, writeState, type AttentionItem, type Briefing, type BriefingSection } from "./state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(here, "../../../prompts");

/** Read tools Ned may use. Connector tools are deferred, so ToolSearch must be allowed to load them. */
function allowedTools(cfg: NedConfig): string[] {
  const t = ["ToolSearch"];
  if (cfg.sources.gmail) t.push("mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread");
  if (cfg.sources.slack) t.push("mcp__claude_ai_Slack__slack_search_public_and_private", "mcp__claude_ai_Slack__slack_read_thread", "mcp__claude_ai_Slack__slack_read_channel");
  if (cfg.sources.jira) t.push("mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", "mcp__claude_ai_Atlassian__getJiraIssue");
  if (cfg.sources.sentry) t.push("mcp__Sentry__search_issues", "mcp__Sentry__get_issue_details");
  if (cfg.sources.github) t.push("Bash(gh pr list:*)", "Bash(gh search prs:*)", "Bash(gh api:*)");
  if (cfg.sources.calendar) t.push("mcp__claude_ai_Google_Calendar__list_events", "mcp__claude_ai_Google_Calendar__search_events");
  return t;
}

interface LlmBriefing {
  status: "NED_OK" | "UPDATE";
  headline?: string;
  action_items?: BriefingSection[];
  updates?: BriefingSection[];
  fyi?: BriefingSection[];
  sessions?: BriefingSection[];
}

function sentKeys(): Set<string> {
  try {
    return new Set(fs.readFileSync(SENT_LOG, "utf8").split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

function markSent(keys: string[]): void {
  if (keys.length) fs.appendFileSync(SENT_LOG, keys.join("\n") + "\n");
}

const keyOf = (s: BriefingSection) => (s.url ?? s.title).trim().toLowerCase();

function summarizeEvents(events: NedEvent[]): string {
  if (!events.length) return "(없음)";
  return events
    .slice(-40)
    .map((e) => `- ${new Date(e.ts).toLocaleTimeString("ko-KR")} ${e.event} ${e.cwd ? path.basename(e.cwd) : ""} ${e.prompt ? `prompt="${e.prompt.slice(0, 80)}"` : ""} ${e.message ? `msg="${String(e.message).slice(0, 80)}"` : ""}`.trim())
    .join("\n");
}

/** Dismissed attention ids → the alert they dismissed (`alert_ts`) and when. */
type Dismissed = Record<string, { alert_ts: number; at: number }>;
const readDismissed = () => readJson<Dismissed>(DISMISSED_PATH, {});

/** Refresh `state.sessions` from events. Cheap; runs every tick. */
export function refreshSessions(cfg: NedConfig): void {
  const state = readState();
  const sessions = reduceSessions(readRecentEvents(2), cfg.session_stale_minutes);
  const dismissed = readDismissed();
  // Sessions that need the human become attention items (replaced each tick),
  // unless the user dismissed this same alert (a new Notification/StopFailure brings it back).
  const sessionAttention: AttentionItem[] = sessions
    .filter((s) => s.status === "waiting" || s.status === "error")
    .filter((s) => dismissed[`session:${s.id}`]?.alert_ts !== s.alert_ts)
    .map((s) => ({
      id: `session:${s.id}`,
      kind: "session",
      title: `${s.worktree}: ${s.status === "waiting" ? "입력 대기" : "오류"}`,
      detail: s.last_summary ?? s.last_prompt ?? undefined,
      ts: s.last_event_ts,
      source: "sessions",
    }));
  state.sessions = sessions;
  state.attention = [...sessionAttention, ...state.attention.filter((a) => a.source !== "sessions")];
  state.quiet = inQuietHours(cfg);
  writeState(state);
}

export interface HeartbeatOptions {
  force?: boolean;
  daily?: boolean;
}

/** One heartbeat: decide whether to think, then (maybe) ask Claude and publish a briefing. */
export async function heartbeat(cfg: NedConfig, opts: HeartbeatOptions = {}): Promise<Briefing | null> {
  refreshSessions(cfg);
  const state = readState();
  const { events, commit } = readUnprocessedEvents();
  const now = Date.now();
  const sinceLast = state.last_heartbeat_at ? now - state.last_heartbeat_at : Infinity;
  const signalDue = sinceLast >= cfg.signal_check_minutes * 60_000;
  const sessionNews = events.some((e) => ["Stop", "StopFailure", "Notification"].includes(e.event));

  if (!opts.force && !opts.daily && !signalDue && !sessionNews) {
    log(`heartbeat: nothing new (next signal check in ${Math.ceil((cfg.signal_check_minutes * 60_000 - sinceLast) / 60_000)}m) — silent`);
    return null;
  }

  const promptFile = path.join(PROMPTS_DIR, opts.daily ? "briefing.md" : "heartbeat.md");
  const template = fs.readFileSync(promptFile, "utf8");
  const sent = sentKeys();
  const prompt = template
    .replace("{{NOW}}", new Date().toLocaleString("ko-KR"))
    .replace("{{SOURCES}}", Object.entries(cfg.sources).filter(([, v]) => v).map(([k]) => k).join(", "))
    .replace("{{SESSIONS}}", state.sessions.length ? state.sessions.map((s) => `- [${s.status}] ${s.worktree} — ${s.last_summary ?? s.last_prompt ?? ""}`).join("\n") : "(활성 세션 없음)")
    .replace("{{EVENTS}}", summarizeEvents(events))
    .replace("{{ALREADY_SENT}}", [...sent].slice(-60).join("\n") || "(없음)");

  let res;
  if (llmDisabled()) {
    log(`heartbeat: NED_NO_LLM=1 — skipping claude, recording NED_OK`);
    res = noLlmResult();
  } else {
    log(`heartbeat: asking claude (${opts.daily ? "daily" : "heartbeat"}, ${events.length} new events, signalDue=${signalDue})`);
    res = await runClaude(prompt, { allowedTools: allowedTools(cfg), maxTurns: cfg.claude_max_turns, model: cfg.claude_model });
  }
  const id = new Date().toISOString().replace(/[:.]/g, "-");

  const parsed = res.ok ? extractJson<LlmBriefing>(res.text) : null;
  const briefing: Briefing = {
    id,
    ts: now,
    type: opts.daily ? "daily" : "heartbeat",
    status: parsed?.status === "UPDATE" ? "UPDATE" : "NED_OK",
    headline: parsed?.headline,
    action_items: parsed?.action_items ?? [],
    updates: parsed?.updates ?? [],
    fyi: parsed?.fyi ?? [],
    sessions: parsed?.sessions ?? [],
    cost_usd: res.cost_usd,
    raw: res.ok && parsed ? undefined : res.text.slice(0, 4000),
  };
  if (!res.ok) log(`heartbeat: claude failed — ${res.error?.slice(0, 300)}`);

  // Drop items already surfaced before, then record the new ones.
  const fresh = (xs: BriefingSection[]) => xs.filter((x) => !sent.has(keyOf(x)));
  briefing.action_items = fresh(briefing.action_items);
  briefing.updates = fresh(briefing.updates);
  briefing.fyi = fresh(briefing.fyi);
  const hasContent = briefing.action_items.length + briefing.updates.length + briefing.fyi.length > 0;
  if (briefing.status === "UPDATE" && !hasContent && !opts.daily) briefing.status = "NED_OK";
  markSent([...briefing.action_items, ...briefing.updates, ...briefing.fyi].map(keyOf));

  writeJsonAtomic(path.join(BRIEFINGS_DIR, `${id}.json`), briefing);
  commit();

  const next = readState();
  next.last_heartbeat_at = now;
  next.last_briefing = { id, ts: now, type: briefing.type, status: briefing.status, headline: briefing.headline };
  if (briefing.status === "UPDATE") {
    const items: AttentionItem[] = briefing.action_items.map((a, i) => ({
      id: `${id}:${i}`,
      kind: a.kind ?? "other",
      title: a.title,
      detail: a.detail,
      url: a.url,
      ts: now,
      source: id,
    }));
    next.attention = [...next.attention.filter((a) => a.source === "sessions"), ...items, ...next.attention.filter((a) => a.source !== "sessions")].slice(0, 30);
    if (!inQuietHours(cfg)) notify("Ned", briefing.headline ?? `${briefing.action_items.length}건 확인 필요`);
  }
  writeState(next);
  log(`heartbeat: ${briefing.status} (${briefing.action_items.length} action / ${briefing.updates.length} updates / ${briefing.fyi.length} fyi, $${res.cost_usd.toFixed(2)}, ${res.num_turns} turns)`);
  return briefing;
}

export function listBriefings(limit = 50): Briefing[] {
  if (!fs.existsSync(BRIEFINGS_DIR)) return [];
  return fs
    .readdirSync(BRIEFINGS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => readJson<Briefing | null>(path.join(BRIEFINGS_DIR, f), null))
    .filter((b): b is Briefing => !!b);
}

export function dismissAttention(id: string): void {
  const s = readState();
  s.attention = s.attention.filter((a) => a.id !== id);
  writeState(s);
  // Session attention is regenerated every refresh — remember which alert was dismissed.
  const session = id.startsWith("session:") ? s.sessions.find((x) => `session:${x.id}` === id) : undefined;
  if (session?.alert_ts != null) {
    const now = Date.now();
    const d = Object.fromEntries(Object.entries(readDismissed()).filter(([, v]) => now - v.at < 7 * 24 * 60 * 60_000));
    d[id] = { alert_ts: session.alert_ts, at: now };
    writeJsonAtomic(DISMISSED_PATH, d);
  }
}
