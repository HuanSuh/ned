import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { recordCost, type CostJob } from "./costs.js";
import { log, NED_HOME } from "./paths.js";

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
  error?: string;
  /** The argv the answering `claude` actually ran with (after a connector fallback: the full args). */
  argv?: string[];
}

/** `NED_NO_LLM=1` makes heartbeats skip `claude -p` entirely (tests, dry runs). */
export function llmDisabled(): boolean {
  return process.env.NED_NO_LLM === "1";
}

/**
 * What a heartbeat sees when the LLM is disabled: a clean NED_OK with zero cost, or the briefing JSON
 * in `NED_NO_LLM_RESULT` (tests: exercise the UPDATE path without calling claude).
 */
export function noLlmResult(): ClaudeRunResult {
  const text = process.env.NED_NO_LLM_RESULT || '{"status":"NED_OK"}';
  return { ok: true, text, cost_usd: 0, num_turns: 0, duration_ms: 0 };
}

export interface ClaudeRunOptions {
  /** `--allowedTools` entries. Empty → the flag is omitted (nothing pre-approved). */
  allowedTools: string[];
  maxTurns: number;
  model?: string | null;
  timeoutMs?: number;
  /** Default `plan` (read-only). Action runs use `dontAsk`: anything not in allowedTools is denied, never prompted. */
  permissionMode?: "plan" | "dontAsk";
  /** `--tools`: restrict the built-in tool set (e.g. ["ToolSearch"], or [] = no built-ins). Omitted = default set. */
  tools?: string[];
  /**
   * Skip the user's settings (hooks, plugins), every MCP server and slash commands/skills. Only for no-tool runs whose
   * whole input is in the prompt: cuts `claude -p` start-up from ~40s to ~4s (measured, see drafts fast path).
   */
  isolated?: boolean;
  /** `--effort`; omitted = the CLI default. */
  effort?: "low" | "medium" | "high";
  /** Record this run's cost under that job in ~/.ned/costs.json (daily budget, GET /api/costs). Not part of argv. */
  job?: CostJob;
  /**
   * Skip the user's hooks/plugins/skills but keep the claude.ai connectors (FAST_STARTUP_ARGS, docs/claude-startup.md).
   * Omitted = `config.claude_fast_startup` (default on). Ignored when `isolated` (that already skips more).
   */
  fastStartup?: boolean;
}

/**
 * Fast start-up for connector runs (measured in docs/claude-startup.md): an extra `--settings` file layered over the
 * user's own settings that sets `disableAllHooks` (the user's hooks — one Stop hook alone cost ~10s per call — and every
 * plugin hook) and turns each of the user's enabled plugins off (their MCP servers, skills and agents leave the system
 * prompt), plus `--disable-slash-commands`. The user's settings still load (model, effortLevel, env), and so do the
 * claude.ai connectors and `~/.claude.json` MCP servers (Sentry). NOT `--setting-sources ""` (measured: drops every MCP
 * server incl. the connectors) and NOT `--strict-mcp-config` (drops the connectors). The user's ~/.claude is never written.
 */
export const FAST_SETTINGS_PATH = path.join(NED_HOME, "claude-settings.json");

/** `enabledPlugins` keys the user has on, from ~/.claude/settings.json and settings.local.json (read-only). */
function userEnabledPlugins(): string[] {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const on = new Set<string>();
  for (const f of ["settings.json", "settings.local.json"]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { enabledPlugins?: Record<string, unknown> };
      for (const [k, v] of Object.entries(j.enabledPlugins ?? {})) if (v) on.add(k);
    } catch {
      /* missing / unreadable: nothing to turn off from it */
    }
  }
  return [...on].sort();
}

/** The fast settings document (exported for tests/docs): hooks off + every user plugin off. */
export function fastSettings(): { disableAllHooks: true; enabledPlugins: Record<string, false> } {
  return { disableAllHooks: true, enabledPlugins: Object.fromEntries(userEnabledPlugins().map((k) => [k, false as const])) };
}

/**
 * Write `$NED_HOME/claude-settings.json` when its content changed (a plugin the user enabled since gets turned off too)
 * and return the argv for a fast run. Called per run: two small reads, a write only on change.
 */
export function fastStartupArgs(): string[] {
  const body = JSON.stringify(fastSettings(), null, 2) + "\n";
  try {
    if (!fs.existsSync(FAST_SETTINGS_PATH) || fs.readFileSync(FAST_SETTINGS_PATH, "utf8") !== body) {
      fs.mkdirSync(NED_HOME, { recursive: true });
      const tmp = `${FAST_SETTINGS_PATH}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, body); // exact `body`, so the next call's comparison matches
      fs.renameSync(tmp, FAST_SETTINGS_PATH);
    }
    return ["--settings", FAST_SETTINGS_PATH, "--disable-slash-commands"];
  } catch {
    // Can't write the file (read-only home?): the same JSON inline works too.
    return ["--settings", body.trim(), "--disable-slash-commands"];
  }
}

/** Set once a fast run came up without any claude.ai connector: every later run in this process uses the full args. */
let fastStartupBroken = false;

/** `config.claude_fast_startup` (false only when explicitly false), unless this process already fell back. */
export function fastStartupEnabled(): boolean {
  if (fastStartupBroken) return false;
  try {
    return (loadConfig() as { claude_fast_startup?: unknown }).claude_fast_startup !== false;
  } catch {
    return true;
  }
}

/** The exact argv `runClaude` spawns `claude` with (exported so action runs can log / test it). */
export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  const fast = !opts.isolated && (opts.fastStartup ?? fastStartupEnabled());
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", opts.permissionMode ?? "plan", "--max-turns", String(opts.maxTurns)];
  if (opts.tools) args.push("--tools", opts.tools.join(","));
  if (opts.allowedTools.length) args.push("--allowedTools", ...opts.allowedTools);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.isolated) args.push("--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands");
  else if (fast) args.push(...fastStartupArgs());
  return args;
}

/** Does this run expect claude.ai connector tools (so a fast start without them must fall back)? */
function wantsConnectors(opts: ClaudeRunOptions): boolean {
  return opts.allowedTools.some((t) => t.startsWith("mcp__claude_ai_"));
}

/**
 * Run `claude -p` headless with a prompt. Read-only by construction:
 * plan permission mode + an explicit allow-list of read tools (callers may narrow further, see ClaudeRunOptions).
 * Fast start-up (fastStartupArgs) is the default for connector runs; if such a run starts without a single claude.ai
 * connector in its MCP server list it is killed right at init (no API spend) and re-run with the full args, and the
 * rest of this process stays on the full args.
 */
export async function runClaude(prompt: string, opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const fast = !opts.isolated && (opts.fastStartup ?? fastStartupEnabled());
  const guard = fast && wantsConnectors(opts);
  let argv = buildClaudeArgs({ ...opts, fastStartup: fast });
  let r = await spawnClaude(prompt, argv, opts.timeoutMs, guard);
  if (r.noConnectors) {
    fastStartupBroken = true;
    log(`claude -p: fast start-up came up without claude.ai connectors (${r.mcp_servers?.join(", ") || "no MCP servers"}) — falling back to full settings for this daemon run`);
    argv = buildClaudeArgs({ ...opts, fastStartup: false });
    r = await spawnClaude(prompt, argv, opts.timeoutMs, false);
  }
  if (opts.job && r.cost_usd > 0) recordCost(opts.job, r.cost_usd);
  const { noConnectors: _n, mcp_servers: _m, ...res } = r;
  return { ...res, argv };
}

interface SpawnResult extends ClaudeRunResult {
  /** Killed at init: the MCP server list had no claude.ai connector (only when `guardConnectors`). */
  noConnectors?: boolean;
  /** `name:status` of every MCP server in the init event. */
  mcp_servers?: string[];
}

/**
 * Spawn `claude` with `--output-format stream-json --verbose` (args from buildClaudeArgs): the `result` line carries the
 * same fields as `--output-format json`, and the `system/init` line lists the MCP servers so a connector-less start can
 * be cut before the first API call. A server still `pending` at init counts as present (connectors attach late).
 */
function spawnClaude(prompt: string, args: string[], timeoutMs: number | undefined, guardConnectors: boolean): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NED_CHILD: "1" } });
    let buf = "";
    let lastText = "";
    let err = "";
    let result: Record<string, unknown> | null = null;
    let servers: string[] | undefined;
    let noConnectors = false;
    let settled = false;
    const finish = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(r);
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      log(`claude -p timed out after ${timeoutMs}ms`);
      // Escalate if SIGTERM is ignored or grandchildren hold the pipes open.
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, text: lastText, cost_usd: 0, num_turns: 0, duration_ms: Date.now() - started, error: err || "timeout", mcp_servers: servers });
      }, 10_000);
    }, timeoutMs ?? 10 * 60_000);
    child.on("error", (e) => finish({ ok: false, text: "", cost_usd: 0, num_turns: 0, duration_ms: Date.now() - started, error: `spawn claude: ${e.message}` }));
    child.stdin.on("error", () => { /* EPIPE after an early kill */ });
    const onLine = (line: string) => {
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (j.type === "result") result = j;
      else if (j.type === "assistant") {
        const content = (j.message as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? [];
        const t = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        if (t) lastText = t;
      } else if (j.type === "system" && j.subtype === "init" && !servers) {
        const list = Array.isArray(j.mcp_servers) ? (j.mcp_servers as { name?: unknown; status?: unknown }[]) : [];
        servers = list.map((s) => `${String(s.name)}:${String(s.status)}`);
        if (guardConnectors && !list.some((s) => String(s.name).startsWith("claude.ai "))) {
          // Answer now: a killed CLI's grandchildren (hooks, MCP servers) may hold stdout open and delay "close".
          noConnectors = true;
          child.kill("SIGTERM");
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ ok: false, text: "", cost_usd: 0, num_turns: 0, duration_ms: Date.now() - started, error: "no claude.ai connectors", noConnectors, mcp_servers: servers });
        }
      }
    };
    child.stdout.setEncoding("utf8"); // multi-byte chars (Korean) can straddle chunk boundaries
    child.stdout.on("data", (s: string) => {
      buf += s;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (err += d));
    child.on("close", (code) => {
      if (settled) return; // already answered (connector guard, spawn error, SIGKILL escalation)
      if (buf.trim()) onLine(buf);
      const duration_ms = Date.now() - started;
      const j = result as Record<string, unknown> | null;
      if (j) {
        finish({
          ok: !j.is_error && code === 0,
          text: String(j.result ?? ""),
          cost_usd: Number(j.total_cost_usd ?? 0),
          num_turns: Number(j.num_turns ?? 0),
          duration_ms,
          error: j.is_error ? String(j.result) : code !== 0 ? err || `exit ${code}` : undefined,
          mcp_servers: servers,
        });
      } else {
        // No result line: the last assistant text (if any) is the useful diagnostic, not the stream (init line is huge).
        finish({ ok: false, text: lastText, cost_usd: 0, num_turns: 0, duration_ms, error: err || `exit ${code}`, mcp_servers: servers });
      }
    });
    child.stdin.end(prompt);
  });
}

/** Extract the first JSON object from model text (handles ```json fences and prose around it). */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1)) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}
