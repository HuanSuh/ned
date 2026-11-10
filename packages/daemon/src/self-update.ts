/**
 * 자동 업데이트 (config.updates): a periodic update check that announces a new version once, and — only with
 * `updates.auto_install` or the 설정 → 앱 "지금 업데이트" button — the self-install (scripts/self-update.sh,
 * a detached process: plugin marketplace update → plugin update → the new version's install.sh).
 *
 * Bookkeeping lives in $NED_HOME/update-state.json (UPDATE_STATE_PATH): last_check_at, available {current, latest},
 * notified_version, and the install attempt (last_attempt_at, last_result running|ok|fail, from, to, log, fail_line).
 * state.json mirrors `available` as `update_available` (src/state.ts) for the menu and the dashboard.
 * The gates are pure functions (checkDue, installVerdict); spawning, the clock and the files are injectable.
 */
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { NedConfig } from "./config.js";
import { notify as notifyBanner } from "./notify.js";
import { NED_HOME, log, readJson, writeJsonAtomic } from "./paths.js";
import { quietStatus } from "./scheduler.js";
import { UPDATE_STATE_PATH, readState, writeState } from "./state.js";
import type { UpdateCheck } from "./update-check.js";
import { runtimeDir, updateCheck } from "./update-check.js";
import { REPO_ROOT } from "./vault.js";

export interface UpdateState {
  last_check_at?: number;
  available?: { current: string | null; latest: string; at: number } | null;
  notified_version?: string | null;
  last_attempt_at?: number;
  last_result?: "running" | "ok" | "fail";
  from?: string | null;
  to?: string;
  log?: string;
  fail_line?: string;
  finished_at?: number;
}

export const SELF_UPDATE_LOCK = path.join(NED_HOME, "self-update.lock");
export const SELF_UPDATE_LOG = path.join(NED_HOME, "logs", "self-update.log");
/** A failed attempt is not retried automatically for this long. */
export const RETRY_AFTER_FAIL_MS = 24 * 60 * 60_000;
/** A "running" record older than this (the script died without writing) counts as failed. */
export const RUNNING_STALE_MS = 2 * 60 * 60_000;

export const readUpdateState = (): UpdateState => readJson<UpdateState>(UPDATE_STATE_PATH, {});
export function patchUpdateState(p: Partial<UpdateState>): UpdateState {
  const next = { ...readUpdateState(), ...p };
  writeJsonAtomic(UPDATE_STATE_PATH, next);
  return next;
}

/** (pure) Is an automatic check due? Never checked → yes; otherwise every `hours` (≥ 1). */
export function checkDue(lastCheckAt: number | undefined, hours: number, now: number): boolean {
  if (!lastCheckAt) return true;
  return now - lastCheckAt >= Math.max(1, hours) * 60 * 60_000;
}

/** (pure) The last attempt as it stands: a "running" record past RUNNING_STALE_MS is a failure. */
export function attemptResult(st: UpdateState, now: number): UpdateState["last_result"] | undefined {
  if (st.last_result === "running" && st.last_attempt_at && now - st.last_attempt_at > RUNNING_STALE_MS) return "fail";
  return st.last_result;
}

export interface InstallInput {
  autoInstall: boolean;
  check: Pick<UpdateCheck, "update_available" | "latest" | "current"> | null;
  quiet: boolean;
  idle: boolean;
  /** state.json sessions (workers included). */
  sessions: { status: string; worktree?: string }[];
  state: UpdateState;
  locked: boolean;
  now: number;
  /** 설정 → 앱 "지금 업데이트": skips auto_install / quiet-idle / sessions / retry wait — not the lock or "nothing newer". */
  manual?: boolean;
}

/** (pure) May the self-install start now? `reason` says why not (or what it is about to do). */
export function installVerdict(i: InstallInput): { ok: boolean; reason: string } {
  if (!i.check?.update_available || !i.check.latest) return { ok: false, reason: "새 버전 없음" };
  if (i.locked || attemptResult(i.state, i.now) === "running") return { ok: false, reason: "이미 업데이트 중" };
  if (i.manual) return { ok: true, reason: `지금 업데이트 → ${i.check.latest}` };
  if (!i.autoInstall) return { ok: false, reason: "updates.auto_install 꺼짐" };
  if (!i.quiet && !i.idle) return { ok: false, reason: "조용한 시간도 유휴도 아님" };
  const busy = i.sessions.filter((s) => s.status === "running" || s.status === "waiting");
  if (busy.length) return { ok: false, reason: `세션 ${busy.length}개가 실행 중·입력 대기` };
  if (attemptResult(i.state, i.now) === "fail" && i.state.last_attempt_at && i.now - i.state.last_attempt_at < RETRY_AFTER_FAIL_MS) {
    return { ok: false, reason: "마지막 시도가 실패한 지 24시간 안 됨" };
  }
  return { ok: true, reason: `자동 설치 → ${i.check.latest}` };
}

/** (pure) Announce the version now? Once per version; quiet hours with quiet_delivery skip (or notifications off) wait. */
export function announceVerdict(latest: string, st: UpdateState, cfg: Pick<NedConfig, "notifications">, quiet: boolean): { now: boolean; reason: string } {
  if (st.notified_version === latest) return { now: false, reason: "이미 알림" };
  if (cfg.notifications.enabled === false) return { now: false, reason: "notifications.enabled=false" };
  if (quiet && cfg.notifications.quiet_delivery !== "silent") return { now: false, reason: "조용한 시간 — 끝나면 알림" };
  return { now: true, reason: "새 버전" };
}

/** The lock directory scripts/self-update.sh holds (pid inside); a dead owner does not count. */
export function lockHeld(dir = SELF_UPDATE_LOCK, alive: (pid: number) => boolean = pidAlive): boolean {
  let pid: number;
  try { pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8").trim()); } catch { return fs.existsSync(dir); }
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

export interface Spawned { pid?: number; unref: () => void }
export interface SelfUpdateDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => Spawned;
  /** Open the log for append → fd (closed after spawning). */
  openLog: (file: string) => number;
  closeLog: (fd: number) => void;
  now: () => number;
  script: string;
}

const defaultDeps = (): SelfUpdateDeps => ({
  spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
  openLog: (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); return fs.openSync(file, "a"); },
  closeLog: (fd) => { try { fs.closeSync(fd); } catch { /* already closed */ } },
  now: Date.now,
  script: path.join(REPO_ROOT, "scripts", "self-update.sh"),
});
let depsOverride: Partial<SelfUpdateDeps> | null = null;
/** Tests: swap spawn / clock / script (null = real ones). */
export function setSelfUpdateDeps(d: Partial<SelfUpdateDeps> | null): void { depsOverride = d; }
const deps = (): SelfUpdateDeps => ({ ...defaultDeps(), ...(depsOverride ?? {}) });

/** (pure) The script's argv. Marketplace = the runtime's marketplace.json name, plugin = plugin.json name. */
export function selfUpdateArgs(script: string, check: Pick<UpdateCheck, "current" | "latest">, names: { marketplace: string; plugin: string }): string[] {
  return [script, "--to", String(check.latest), ...(check.current ? ["--from", check.current] : []), "--marketplace", names.marketplace, "--plugin", names.plugin];
}

/** Plugin / marketplace names of the installed runtime (fallback "ned"). */
export function pluginNames(root = runtimeDir()): { marketplace: string; plugin: string } {
  const read = (f: string) => { for (const r of [root, REPO_ROOT]) { const j = readJson<Record<string, unknown> | null>(path.join(r, ".claude-plugin", f), null); if (j) return j; } return null; };
  const name = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9._+-]+$/.test(v) ? v : null);
  const plugin = name(read("plugin.json")?.name) ?? "ned";
  return { plugin, marketplace: name(read("marketplace.json")?.name) ?? plugin };
}

/**
 * Start scripts/self-update.sh detached (own session — Node's `detached` = setsid; stdio to the log, never the daemon's
 * pipes) and unref it, so install.sh quitting Ned.app (and with it this daemon) does not kill it. Records "running".
 */
export function startSelfUpdate(check: Pick<UpdateCheck, "current" | "latest">, d: SelfUpdateDeps = deps()): { started: boolean; reason: string; pid?: number } {
  if (!check.latest) return { started: false, reason: "새 버전 없음" };
  if (!fs.existsSync(d.script)) return { started: false, reason: `스크립트 없음: ${d.script}` };
  const fd = d.openLog(SELF_UPDATE_LOG);
  let child: Spawned;
  try {
    child = d.spawn("/bin/bash", selfUpdateArgs(d.script, check, pluginNames()), {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: NED_HOME,
      env: { ...process.env, NED_HOME },
    });
  } catch (e) {
    d.closeLog(fd);
    patchUpdateState({ last_attempt_at: d.now(), last_result: "fail", from: check.current, to: check.latest, log: SELF_UPDATE_LOG, fail_line: `spawn: ${String((e as Error).message ?? e)}` });
    return { started: false, reason: `실행 실패: ${String((e as Error).message ?? e)}` };
  }
  child.unref();
  d.closeLog(fd);
  patchUpdateState({ last_attempt_at: d.now(), last_result: "running", from: check.current, to: check.latest, log: SELF_UPDATE_LOG, fail_line: undefined });
  log(`self-update: started pid ${child.pid ?? "?"} ${check.current ?? "?"} → ${check.latest} (log ${SELF_UPDATE_LOG})`);
  return { started: true, reason: `${check.current ?? "?"} → ${check.latest}`, pid: child.pid };
}

/** Record a check result: `available` follows it, the state.json mirror is rewritten. */
export function recordCheck(r: UpdateCheck, now: number): UpdateState {
  const st = patchUpdateState({
    last_check_at: now,
    available: r.update_available && r.latest ? { current: r.current, latest: r.latest, at: now } : r.latest ? null : readUpdateState().available ?? null,
  });
  writeState(readState());
  return st;
}

export interface UpdateTickCtx { quiet: boolean; idle: boolean; now: number }
export interface UpdateTickDeps {
  check: (refresh: boolean) => Promise<UpdateCheck>;
  notify: (title: string, body: string, cfg: NedConfig) => void;
  start: (check: Pick<UpdateCheck, "current" | "latest">) => { started: boolean; reason: string };
  locked: () => boolean;
  sessions: () => { status: string }[];
}
const tickDeps = (): UpdateTickDeps => ({
  check: (refresh) => updateCheck({ refresh }),
  notify: (title, body, cfg) => notifyBanner(title, body, cfg.notify, { sound: cfg.notifications.sound }),
  start: (c) => startSelfUpdate(c),
  locked: () => lockHeld(),
  sessions: () => readState().sessions ?? [],
});

let busy = false;
/**
 * One scheduler tick (src/scheduler.ts calls it every minute with quiet / idle): an automatic check when due
 * (updates.auto_check, every updates.check_hours), the once-per-version announcement (it waits out quiet hours), and —
 * updates.auto_install — the self-install when installVerdict allows. Returns what it did (tests / log).
 */
export async function updateTick(cfg: NedConfig, ctx: UpdateTickCtx, d: UpdateTickDeps = tickDeps()): Promise<string[]> {
  const did: string[] = [];
  if (busy) return did;
  busy = true;
  try {
    let st = readUpdateState();
    const u = cfg.updates;
    let check: UpdateCheck | null = null;
    if (u.auto_check && checkDue(st.last_check_at, u.check_hours, ctx.now)) {
      check = await d.check(true);
      st = recordCheck(check, ctx.now);
      did.push(`check: ${check.current ?? "?"} / ${check.latest ?? "?"}${check.error ? ` (${check.error})` : ""}`);
    }
    const avail = st.available;
    if (avail) {
      const a = announceVerdict(avail.latest, st, cfg, ctx.quiet);
      if (a.now) {
        d.notify("Ned 업데이트", `새 버전 ${avail.latest} (지금 ${avail.current ?? "?"}) — ${u.auto_install ? "조용한 시간·유휴에 자동 설치" : "설정 → 앱에서 지금 업데이트"}`, cfg);
        st = patchUpdateState({ notified_version: avail.latest });
        writeState(readState());
        did.push(`notified ${avail.latest}`);
      }
      if (u.auto_install) {
        const c = check ?? { update_available: true, latest: avail.latest, current: avail.current };
        const v = installVerdict({ autoInstall: true, check: c, quiet: ctx.quiet, idle: ctx.idle, sessions: d.sessions(), state: st, locked: d.locked(), now: ctx.now });
        if (v.ok) {
          const r = d.start({ current: c.current, latest: c.latest });
          did.push(`install: ${r.started ? "started" : "not started"} — ${r.reason}`);
        }
      }
    }
  } catch (e) {
    did.push(`error: ${String((e as Error).message ?? e)}`);
  } finally {
    busy = false;
  }
  for (const x of did) log(`updates: ${x}`);
  return did;
}

/** POST /api/update/install ("지금 업데이트"): a fresh check, then the self-install if there is something newer. */
export async function installNow(d: UpdateTickDeps = tickDeps(), now = Date.now()): Promise<{ started: boolean; reason: string; check: UpdateCheck }> {
  const check = await d.check(true);
  recordCheck(check, now);
  const v = installVerdict({ autoInstall: false, check, quiet: false, idle: false, sessions: [], state: readUpdateState(), locked: d.locked(), now, manual: true });
  if (!v.ok) return { started: false, reason: v.reason, check };
  const r = d.start(check);
  return { ...r, check };
}

/** GET /api/update-check extras for the dashboard: the install attempt and when the next automatic check is. */
export function updateStatus(cfg: NedConfig, now = Date.now()): Record<string, unknown> {
  const st = readUpdateState();
  return {
    auto: cfg.updates,
    last_check_at: st.last_check_at ?? null,
    next_check_at: cfg.updates.auto_check ? (st.last_check_at ? st.last_check_at + Math.max(1, cfg.updates.check_hours) * 3_600_000 : now) : null,
    attempt: st.last_attempt_at ? { at: st.last_attempt_at, result: attemptResult(st, now), from: st.from ?? null, to: st.to ?? null, log: st.log ?? null, fail_line: st.fail_line ?? null } : null,
    running: lockHeld() || attemptResult(st, now) === "running",
    quiet_now: quietStatus(cfg, new Date(now)).active,
  };
}
