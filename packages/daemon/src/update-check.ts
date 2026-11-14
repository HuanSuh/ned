/**
 * 업데이트 확인 (Ned.app 메뉴 "업데이트 확인" · 설정 → 앱): the installed runtime's plugin version vs the newest one.
 *
 * current = `<runtime>/.claude-plugin/plugin.json` (`NED_RUNTIME_DIR`, else `$NED_HOME/runtime` — where /ned:install
 * builds; a dev checkout without a runtime falls back to the checkout the daemon runs from).
 * latest  = (a) `https://raw.githubusercontent.com/<owner>/<repo>/main/.claude-plugin/plugin.json` (public repo — plain
 *               fetch, no gh / login, 5 s timeout),
 *           else (b) `gh api repos/<owner>/<repo>/contents/.claude-plugin/plugin.json?ref=main` (the user's gh login —
 *               e.g. raw.githubusercontent.com blocked by a proxy, or a private fork),
 *           else (c) the local marketplace clone `~/.claude/plugins/marketplaces/<marketplace>/.claude-plugin/plugin.json`.
 * The repo slug comes from plugin.json `repository` / `homepage`, the marketplace name from marketplace.json `name`.
 * Nothing is installed here — installing is the Claude Code flow (/plugin update → /reload-plugins → /ned:install).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NED_HOME } from "./paths.js";
import { REPO_ROOT } from "./vault.js";

export interface UpdateCheck {
  current: string | null;
  latest: string | null;
  /** Where `latest` came from (null = nowhere). */
  source: "raw" | "github" | "marketplace" | null;
  update_available: boolean;
  checked_at: number;
  /** "owner/repo" read from plugin.json, when found. */
  repo: string | null;
  /** The Claude Code steps that install an update (the app never installs by itself). */
  steps: string[];
  /** Set when either side could not be read: why. */
  error?: string;
  /** Latest came from a fallback (gh / marketplace): why the earlier ones did not answer. */
  note?: string;
}

export const RAW_TIMEOUT_MS = 5_000;

export interface UpdateDeps {
  /** File text, or null when missing / unreadable. */
  readFile: (p: string) => string | null;
  /** GET a URL (raw.githubusercontent.com). `status` 0 + `err` = network error / timeout. */
  fetchText: (url: string, timeoutMs: number) => Promise<{ status: number; text: string; err?: string }>;
  /** Run gh; `missing` = gh not installed. */
  gh: (args: string[]) => Promise<{ code: number; out: string; err: string; missing: boolean }>;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** (pure) semver compare: <0, 0, >0. A pre-release sorts before its release (1.0.0-rc.1 < 1.0.0). null = not semver. */
export function compareSemver(a: string, b: string): number | null {
  const x = SEMVER.exec(a.trim()), y = SEMVER.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  const pa = x[4], pb = y[4];
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const sa = pa.split("."), sb = pb.split(".");
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === undefined) return -1;
    if (sb[i] === undefined) return 1;
    const na = /^\d+$/.test(sa[i]) ? Number(sa[i]) : null, nb = /^\d+$/.test(sb[i]) ? Number(sb[i]) : null;
    if (na !== null && nb !== null) { if (na !== nb) return Math.sign(na - nb); continue; }
    if (na !== null) return -1;
    if (nb !== null) return 1;
    if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
  }
  return 0;
}

/** (pure) "owner/repo" from a plugin.json `repository` (string or {url}) / `homepage` on github.com. */
export function repoSlug(manifest: Record<string, unknown> | null): string | null {
  if (!manifest) return null;
  const r = manifest.repository;
  const urls = [typeof r === "string" ? r : r && typeof r === "object" ? (r as { url?: unknown }).url : undefined, manifest.homepage];
  for (const u of urls) {
    if (typeof u !== "string") continue;
    const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u.trim());
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

const parseJson = (s: string | null): Record<string, unknown> | null => {
  if (s === null) return null;
  try {
    const j = JSON.parse(s) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch { return null; }
};
const versionOf = (j: Record<string, unknown> | null): string | null => (typeof j?.version === "string" && j.version.trim() ? j.version.trim() : null);

/** Where the installed runtime lives (same rule as scripts/install.sh plugin mode). */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.NED_RUNTIME_DIR || path.join(NED_HOME, "runtime");
}
/** Claude Code's config dir (`CLAUDE_CONFIG_DIR`, else ~/.claude). */
const claudeDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

export async function runUpdateCheck(d: UpdateDeps, env: NodeJS.ProcessEnv = process.env): Promise<UpdateCheck> {
  const roots = [runtimeDir(env), REPO_ROOT];
  let plugin: Record<string, unknown> | null = null, market: Record<string, unknown> | null = null;
  for (const root of roots) {
    plugin = parseJson(d.readFile(path.join(root, ".claude-plugin", "plugin.json")));
    if (plugin) { market = parseJson(d.readFile(path.join(root, ".claude-plugin", "marketplace.json"))); break; }
  }
  const current = versionOf(plugin);
  const repo = repoSlug(plugin);
  const name = typeof plugin?.name === "string" && plugin.name ? plugin.name : null;
  const marketName = typeof market?.name === "string" && market.name ? market.name : name;
  const steps = name ? [`/plugin update ${name}`, "/reload-plugins", `/${name}:install`] : [];
  const currentErr = current ? null : `설치된 버전을 못 읽음 (${path.join(roots[0], ".claude-plugin", "plugin.json")})`;
  const latestErrs: string[] = [];

  let latest: string | null = null, source: UpdateCheck["source"] = null;
  if (!repo) latestErrs.push("GitHub: plugin.json 에 GitHub 레포 주소가 없음");
  // (a) GitHub main as a plain file (public repo — no gh needed).
  if (repo) {
    const url = `https://raw.githubusercontent.com/${repo}/main/.claude-plugin/plugin.json`;
    const r = await d.fetchText(url, RAW_TIMEOUT_MS).catch((e: unknown) => ({ status: 0, text: "", err: String((e as Error)?.message ?? e) }));
    if (r.status !== 200) latestErrs.push(`raw: ${r.status ? `HTTP ${r.status}` : (r.err || "network error").slice(0, 200)}`);
    else {
      latest = versionOf(parseJson(r.text));
      if (latest) source = "raw";
      else latestErrs.push("raw: 응답에 version 이 없음");
    }
  }
  // (b) GitHub main via gh (the user's gh login).
  if (repo && !latest) {
    const r = await d.gh(["api", "-H", "Accept: application/vnd.github.raw+json", `repos/${repo}/contents/.claude-plugin/plugin.json?ref=main`]);
    if (r.missing) latestErrs.push("gh: 설치 안 됨 (brew install gh)");
    else if (r.code !== 0) {
      const why = (r.err.trim().split("\n").pop() || `exit ${r.code}`).slice(0, 200);
      latestErrs.push(`gh: ${why}${/40[134]|auth|login/i.test(r.err) ? " — gh auth login 필요" : ""}`);
    } else {
      latest = versionOf(parseJson(r.out));
      if (latest) source = "github";
      else latestErrs.push("gh: 응답에 version 이 없음");
    }
  }
  // (c) the marketplace clone Claude Code keeps (fresh after /plugin marketplace update).
  if (!latest) {
    if (!marketName) latestErrs.push("마켓플레이스: 이름을 모름");
    else {
      const p = path.join(claudeDir(env), "plugins", "marketplaces", marketName, ".claude-plugin", "plugin.json");
      latest = versionOf(parseJson(d.readFile(p)));
      if (latest) source = "marketplace";
      else latestErrs.push(`마켓플레이스: ${p} 없음`);
    }
  }
  const errors = [...(currentErr ? [currentErr] : []), ...(latest ? [] : latestErrs)];
  let update_available = false;
  if (current && latest) {
    const c = compareSemver(latest, current);
    if (c === null) errors.push(`버전 형식이 semver 가 아님 (${current} / ${latest})`);
    else update_available = c > 0;
  }
  const out: UpdateCheck = { current, latest, source, update_available, checked_at: Date.now(), repo, steps };
  if (errors.length) out.error = errors.join(" · ");
  // raw (and gh) failed but a fallback answered: keep why, for the tooltip (not an error).
  if ((source === "github" || source === "marketplace") && latestErrs.length) out.note = latestErrs.join(" · ");
  return out;
}

/** plugin.json is ~1 KiB — a raw answer larger than this is refused (Content-Length) or cut off while reading (no buffering). */
export const RAW_MAX_BYTES = 64 * 1024;

/**
 * GET `url` with a timeout, reading at most `max` bytes: a Content-Length over `max` is refused before the body is read,
 * and the body stream is cancelled as soon as it passes `max` (status 0 + err either way). Non-200 bodies are not read.
 */
export async function fetchCapped(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch, max = RAW_MAX_BYTES): Promise<{ status: number; text: string; err?: string }> {
  const tooLarge = (n: number | string) => ({ status: 0, text: "", err: `응답이 너무 큼 (${n} bytes > ${max})` });
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow", headers: { "cache-control": "no-cache" } });
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return { status: res.status, text: "" }; }
    const cl = Number(res.headers.get("content-length"));
    if (Number.isFinite(cl) && cl > max) { await res.body?.cancel().catch(() => {}); return tooLarge(cl); }
    if (!res.body) return { status: 200, text: "" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel().catch(() => {}); return tooLarge(`${total}+`); }
      chunks.push(value);
    }
    return { status: 200, text: new TextDecoder().decode(Buffer.concat(chunks)) };
  } catch (e) {
    const err = e as Error;
    return { status: 0, text: "", err: err?.name === "TimeoutError" ? `timeout ${timeoutMs / 1000}s` : String(err?.message ?? e) };
  }
}

const defaultDeps = (): UpdateDeps => ({
  readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
  fetchText: (url, timeoutMs) => fetchCapped(url, timeoutMs),
  gh: (args) => new Promise((resolve) => {
    execFile("gh", args, { timeout: 15_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) => {
      const ex = e as (NodeJS.ErrnoException & { code?: unknown }) | null;
      resolve({ code: ex ? (typeof ex.code === "number" ? ex.code : 1) : 0, out: String(stdout ?? ""), err: String(stderr ?? ex?.message ?? ""), missing: ex?.code === "ENOENT" });
    });
  }),
});

let depsOverride: Partial<UpdateDeps> | null = null;
/** Tests: swap file reads / fetch / gh (null = real ones). Also drops the cache. */
export function setUpdateDeps(d: Partial<UpdateDeps> | null): void { depsOverride = d; cache = null; }

export const UPDATE_CACHE_MS = 10 * 60_000;
let cache: { at: number; value: Promise<UpdateCheck> } | null = null;

/** GET /api/update-check: cached 10 min, `refresh` forces a new look. Concurrent callers share one run. */
export function updateCheck({ refresh = false } = {}): Promise<UpdateCheck> {
  if (!refresh && cache && Date.now() - cache.at < UPDATE_CACHE_MS) return cache.value;
  const value = runUpdateCheck({ ...defaultDeps(), ...(depsOverride ?? {}) });
  cache = { at: Date.now(), value };
  value.catch(() => { if (cache?.value === value) cache = null; });
  return value;
}
