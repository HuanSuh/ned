import { spawn } from "node:child_process";
import { log } from "./paths.js";

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
  error?: string;
}

/** `NED_NO_LLM=1` makes heartbeats skip `claude -p` entirely (tests, dry runs). */
export function llmDisabled(): boolean {
  return process.env.NED_NO_LLM === "1";
}

/** What a heartbeat sees when the LLM is disabled: a clean NED_OK with zero cost. */
export function noLlmResult(): ClaudeRunResult {
  return { ok: true, text: '{"status":"NED_OK"}', cost_usd: 0, num_turns: 0, duration_ms: 0 };
}

/**
 * Run `claude -p` headless with a prompt. Read-only by construction:
 * plan permission mode + an explicit allow-list of read tools.
 */
export function runClaude(prompt: string, opts: { allowedTools: string[]; maxTurns: number; model?: string | null; timeoutMs?: number }): Promise<ClaudeRunResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
    "--max-turns",
    String(opts.maxTurns),
    "--allowedTools",
    ...opts.allowedTools,
  ];
  if (opts.model) args.push("--model", opts.model);

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NED_CHILD: "1" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      log(`claude -p timed out after ${opts.timeoutMs}ms`);
    }, opts.timeoutMs ?? 10 * 60_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - started;
      try {
        const j = JSON.parse(out);
        resolve({
          ok: !j.is_error && code === 0,
          text: String(j.result ?? ""),
          cost_usd: Number(j.total_cost_usd ?? 0),
          num_turns: Number(j.num_turns ?? 0),
          duration_ms,
          error: j.is_error ? String(j.result) : undefined,
        });
      } catch {
        resolve({ ok: false, text: out, cost_usd: 0, num_turns: 0, duration_ms, error: err || `exit ${code}` });
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
