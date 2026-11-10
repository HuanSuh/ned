/**
 * 시작하기 (first-run onboarding): is each enabled source actually readable, is the Slack 팀 ID set, is the local
 * code-signing identity there? One check shared by `GET /api/setup` (dashboard checklist) and `ned setup-check`
 * (/ned:install). The Login Item is not here: only Ned.app can read SMAppService (dashboard → native bridge).
 *
 * Connectors: `claude mcp list` is not reliable (it showed Gmail "Connected" while it needed auth). The `system/init`
 * line of `claude -p --output-format stream-json --verbose` lists every MCP server with its real status before any
 * model call — read stdout up to that line, then kill the process: no tokens spent.
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildClaudeArgs, fastStartupEnabled, llmDisabled } from "./claude.js";
import type { NedConfig } from "./config.js";
import { NED_HOME, readJson, writeJsonAtomic } from "./paths.js";
import { REPO_ROOT } from "./vault.js";

export type SourceKey = keyof NedConfig["sources"];
/** off = source switched off in config.sources (not checked). */
export type CheckStatus = "connected" | "needs-auth" | "not-connected" | "pending" | "error";

/**
 * The one mapping table: config.sources key → how it is read. `server` = the MCP server name in the init line,
 * compared case-insensitively ("claude.ai Slack"; a longer name that starts with it + " " also matches).
 */
export const SETUP_SOURCES: { key: SourceKey; label: string; via: "connector" | "mcp" | "gh"; server?: string }[] = [
  { key: "slack", label: "Slack", via: "connector", server: "claude.ai Slack" },
  { key: "gmail", label: "Gmail", via: "connector", server: "claude.ai Gmail" },
  { key: "calendar", label: "Google Calendar", via: "connector", server: "claude.ai Google Calendar" },
  { key: "jira", label: "Jira (Atlassian)", via: "connector", server: "claude.ai Atlassian" },
  { key: "github", label: "GitHub", via: "gh" },
  // mcp__Sentry__* (heartbeat.ts) — a server named "Sentry" in ~/.claude.json, not a claude.ai connector.
  { key: "sentry", label: "Sentry", via: "mcp", server: "Sentry" },
];

export const CONNECTORS_URL = "https://claude.ai/settings/connectors";
export const SIGN_IDENTITY = "Ned Local Signing";

export interface McpServer { name: string; status: string }
export interface SourceCheck {
  key: SourceKey;
  label: string;
  via: "connector" | "mcp" | "gh";
  status: CheckStatus;
  /** Raw status / error text, for the tooltip and the CLI. */
  detail?: string;
  /** What to do when not connected. */
  fix?: { text: string; url?: string; command?: string };
}
export interface SetupCheck {
  checked_at: number;
  sources: SourceCheck[];
  slack_team_id: { status: "ok" | "missing" | "n/a"; value: string };
  signing: { status: "ok" | "untrusted" | "missing" | "error"; identity: string; command: string; detail?: string };
  /** Every item above is fine (sources connected, team id set when Slack is on, signing ok). */
  complete: boolean;
}

/** The `system/init` line's MCP server list, or null when the line is something else. */
export function parseInitLine(line: string): McpServer[] | null {
  let j: { type?: unknown; subtype?: unknown; mcp_servers?: unknown };
  try { j = JSON.parse(line) as typeof j; } catch { return null; }
  if (!j || j.type !== "system" || j.subtype !== "init") return null;
  const list = Array.isArray(j.mcp_servers) ? (j.mcp_servers as { name?: unknown; status?: unknown }[]) : [];
  return list.filter((s) => s && typeof s.name === "string").map((s) => ({ name: String(s.name), status: String(s.status ?? "") }));
}

const nameMatches = (name: string, want: string) => {
  const n = name.trim().toLowerCase(), w = want.toLowerCase();
  return n === w || n.startsWith(w + " ");
};

/** One server's init status → ours. Absent → not-connected (not added on claude.ai / in ~/.claude.json at all). */
export function serverStatus(servers: McpServer[], server: string): { status: CheckStatus; detail?: string } {
  const s = servers.find((x) => nameMatches(x.name, server));
  if (!s) return { status: "not-connected" };
  const st = s.status.toLowerCase();
  if (st === "connected") return { status: "connected" };
  if (st === "needs-auth") return { status: "needs-auth", detail: s.status };
  if (st === "pending") return { status: "pending", detail: s.status };
  return { status: "error", detail: s.status || "unknown" };
}

export function fixFor(via: SourceCheck["via"], status: CheckStatus): SourceCheck["fix"] {
  if (status === "connected") return undefined;
  if (via === "gh") return { text: "터미널에서 gh 로그인", command: "gh auth login" };
  if (via === "mcp") return { text: "Sentry MCP 서버를 Claude Code 에 추가(~/.claude.json)", command: "claude mcp add" };
  return { text: status === "needs-auth" ? "claude.ai → 설정 → 커넥터에서 다시 인증" : "claude.ai → 설정 → 커넥터에서 연결", url: CONNECTORS_URL };
}

export interface SetupDeps {
  /** MCP servers from one probe run; throws on failure (spawn error, timeout, no init line). */
  probeMcp: (fast: boolean) => Promise<McpServer[]>;
  /** `gh auth status`: exit 0 → true; gh missing → null. */
  ghAuth: () => Promise<boolean | null>;
  /** `security find-identity -p codesigning` stdout; `valid` = with -v. */
  identities: (valid: boolean) => Promise<string>;
  /** Wait before re-probing a pending connector. */
  sleep: (ms: number) => Promise<void>;
}

const PROBE_TIMEOUT_MS = 90_000;

/** Spawn `claude -p` like runClaude does (same binary on PATH, same env), read to the init line, kill. */
function probeMcp(fast: boolean): Promise<McpServer[]> {
  if (llmDisabled()) return Promise.reject(new Error("NED_NO_LLM=1 — claude 를 띄우지 않음"));
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs({ allowedTools: [], maxTurns: 1, fastStartup: fast });
    const env = { ...process.env, NED_CHILD: "1" };
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env });
    let buf = "", err = "", done = false;
    const finish = (e: Error | null, v?: McpServer[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      if (e) reject(e); else resolve(v!);
    };
    const timer = setTimeout(() => finish(new Error(`claude 시작이 ${PROBE_TIMEOUT_MS / 1000}초 안에 끝나지 않음`)), PROBE_TIMEOUT_MS);
    child.on("error", (e) => finish(new Error(`spawn claude: ${e.message}`)));
    child.stdin.on("error", () => { /* EPIPE after the kill */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s: string) => {
      buf += s;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const servers = parseInitLine(line);
        if (servers) return finish(null, servers);
        // Never let it reach the model: anything past init without an init line is an unexpected CLI.
        if (/^\{"type":"(assistant|result)"/.test(line)) return finish(new Error("claude 출력에 system/init 줄이 없음"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (err += d));
    child.on("close", (code) => finish(new Error(err.trim().slice(0, 300) || `claude exit ${code} (system/init 없음)`)));
    child.stdin.end("ok");
  });
}

const run = (cmd: string, args: string[]) =>
  new Promise<{ code: number | null; out: string; missing: boolean }>((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (e, stdout) => {
      const ex = e as (NodeJS.ErrnoException & { code?: unknown }) | null;
      resolve({ code: ex ? (typeof ex.code === "number" ? ex.code : 1) : 0, out: String(stdout ?? ""), missing: ex?.code === "ENOENT" });
    });
  });

const defaultDeps = (): SetupDeps => ({
  probeMcp,
  ghAuth: async () => { const r = await run("gh", ["auth", "status"]); return r.missing ? null : r.code === 0; },
  identities: async (valid) => (await run("security", ["find-identity", ...(valid ? ["-v"] : []), "-p", "codesigning"])).out,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

let depsOverride: Partial<SetupDeps> | null = null;
/** Tests: swap the probes (null = real ones). Also drops the cache. */
export function setSetupDeps(d: Partial<SetupDeps> | null): void { depsOverride = d; cache = null; }
const deps = (): SetupDeps => ({ ...defaultDeps(), ...(depsOverride ?? {}) });

/** Probe like runClaude (config.claude_fast_startup), with its fallback: a fast start-up without a single claude.ai server → once more with full args. */
async function mcpServers(d: SetupDeps): Promise<McpServer[]> {
  const fast = fastStartupEnabled();
  const first = await d.probeMcp(fast);
  if (!fast || first.some((s) => s.name.toLowerCase().startsWith("claude.ai "))) return first;
  return d.probeMcp(false);
}

export async function runSetupCheck(cfg: NedConfig, d: SetupDeps = deps()): Promise<SetupCheck> {
  const on = SETUP_SOURCES.filter((s) => cfg.sources[s.key]);
  const mcp = on.filter((s) => s.via !== "gh");
  let servers: McpServer[] = [];
  let probeErr: string | null = null;
  if (mcp.length) {
    try {
      servers = await mcpServers(d);
      // Connectors still attaching at init: one more look after a short wait, else report pending.
      if (mcp.some((s) => serverStatus(servers, s.server!).status === "pending")) {
        await d.sleep(5_000);
        servers = await mcpServers(d);
      }
    } catch (e) {
      probeErr = String((e as Error).message ?? e); // in each source's detail (no log(): it writes stdout, and the CLI prints JSON there)
    }
  }
  const gh = on.some((s) => s.via === "gh") ? await d.ghAuth() : true;
  const sources: SourceCheck[] = on.map((s) => {
    const r: { status: CheckStatus; detail?: string } = s.via === "gh"
      ? gh === null ? { status: "not-connected", detail: "gh 없음 (brew install gh)" } : gh ? { status: "connected" } : { status: "needs-auth", detail: "gh auth status 실패" }
      : probeErr ? { status: "error", detail: probeErr } : serverStatus(servers, s.server!);
    return { key: s.key, label: s.label, via: s.via, ...r, ...(fixFor(s.via, r.status) ? { fix: fixFor(s.via, r.status) } : {}) };
  });

  const team = cfg.dashboard.slack_team_id || "";
  const slack_team_id = { status: !cfg.sources.slack ? ("n/a" as const) : team ? ("ok" as const) : ("missing" as const), value: team };

  const command = `bash ${path.join(REPO_ROOT, "scripts", "make-signing-cert.sh")}`;
  let signing: SetupCheck["signing"];
  try {
    const has = (out: string) => out.includes(`"${SIGN_IDENTITY}"`);
    signing = has(await d.identities(true))
      ? { status: "ok", identity: SIGN_IDENTITY, command }
      : { status: has(await d.identities(false)) ? "untrusted" : "missing", identity: SIGN_IDENTITY, command };
  } catch (e) {
    signing = { status: "error", identity: SIGN_IDENTITY, command, detail: String((e as Error).message ?? e) };
  }

  const complete = sources.every((s) => s.status === "connected") && slack_team_id.status !== "missing" && signing.status === "ok";
  return { checked_at: Date.now(), sources, slack_team_id, signing, complete };
}

// ---------------------------------------------------------------- cache (GET /api/setup)

const CACHE_MS = 60_000;
let cache: { at: number; key: string; value: Promise<SetupCheck> } | null = null;

/** Cached for a minute per (sources, team id) — `refresh` forces a new probe. Concurrent callers share one run. */
export function setupCheck(cfg: NedConfig, { refresh = false } = {}): Promise<SetupCheck> {
  const key = JSON.stringify([cfg.sources, cfg.dashboard.slack_team_id]);
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = runSetupCheck(cfg, deps());
  cache = { at: Date.now(), key, value };
  value.catch(() => { if (cache?.value === value) cache = null; });
  return value;
}

// ---------------------------------------------------------------- 시작하기 닫음 (not config: UI state)

export const ONBOARDING_PATH = path.join(NED_HOME, "onboarding.json");
export interface OnboardingState { dismissed_at: number | null }

export function readOnboarding(): OnboardingState {
  const j = readJson<Partial<OnboardingState>>(ONBOARDING_PATH, {});
  return { dismissed_at: typeof j.dismissed_at === "number" ? j.dismissed_at : null };
}

export function setOnboardingDismissed(dismissed: boolean): OnboardingState {
  const st: OnboardingState = { dismissed_at: dismissed ? Date.now() : null };
  if (dismissed) writeJsonAtomic(ONBOARDING_PATH, st);
  else fs.rmSync(ONBOARDING_PATH, { force: true });
  return st;
}

// ---------------------------------------------------------------- CLI text

const MARK: Record<CheckStatus, string> = { connected: "✓", "needs-auth": "✗", "not-connected": "✗", pending: "…", error: "⚠" };
const WORD: Record<CheckStatus, string> = { connected: "연결됨", "needs-auth": "인증 필요", "not-connected": "연결 안 됨", pending: "연결 중", error: "확인 실패" };

/** `ned setup-check` without --json. */
export function formatSetupCheck(r: SetupCheck): string {
  const lines = ["소스 (설정에서 켠 것만)"];
  if (!r.sources.length) lines.push("  (켜진 소스 없음)");
  for (const s of r.sources) {
    const fix = s.fix ? ` → ${s.fix.text}${s.fix.url ? ` ${s.fix.url}` : ""}${s.fix.command ? ` (\`${s.fix.command}\`)` : ""}` : "";
    lines.push(`  ${MARK[s.status]} ${s.label.padEnd(16)} ${WORD[s.status]}${s.detail && s.status !== "needs-auth" ? ` (${s.detail})` : ""}${fix}`);
  }
  if (r.slack_team_id.status !== "n/a") {
    lines.push(r.slack_team_id.status === "ok" ? `✓ Slack 팀 ID        ${r.slack_team_id.value}` : "✗ Slack 팀 ID        없음 → 대시보드 설정 → 외형 → 링크 열기 (또는 시작하기)");
  }
  const sg = r.signing;
  lines.push(sg.status === "ok" ? `✓ 코드 서명          ${sg.identity}`
    : `✗ 코드 서명          ${sg.status === "untrusted" ? "인증서가 있지만 신뢰 안 됨" : sg.status === "missing" ? "없음 (ad-hoc)" : `확인 실패${sg.detail ? ` (${sg.detail})` : ""}`} → \`${sg.command}\` 후 /ned:install (다음 설치부터)`);
  lines.push(r.complete ? "모두 준비됨." : "준비 안 된 항목이 있음.");
  return lines.join("\n");
}
