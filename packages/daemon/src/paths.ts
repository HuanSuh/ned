import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const NED_HOME = process.env.NED_HOME ?? path.join(os.homedir(), ".ned");

/**
 * Tests (vitest sets VITEST, or NODE_ENV=test) and LLM-less stub runs (NED_NO_LLM=1) must never touch the user's real
 * ~/.ned: test runs that skipped test/setup.ts once overwrote the real config.yaml. In such a run NED_HOME has to be
 * set explicitly and must not resolve to <homedir>/.ned — else throw at import, before anything under it is read or
 * written. The production daemon (Ned.app sets NED_HOME=<home>/.ned, no NED_NO_LLM) is unaffected.
 */
export function assertSafeNedHome(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): void {
  const guarded = !!env.VITEST || env.NODE_ENV === "test" || env.NED_NO_LLM === "1";
  if (!guarded) return;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const userHome = path.resolve(homedir, ".ned");
  if (!explicit || path.resolve(explicit) === userHome || real(explicit) === real(userHome)) {
    throw new Error("refusing to use the real ~/.ned in a test/stub run — set NED_HOME to a temp dir");
  }
}
assertSafeNedHome(process.env.NED_HOME);
export const EVENTS_DIR = path.join(NED_HOME, "events");
export const BRIEFINGS_DIR = path.join(NED_HOME, "briefings");
export const LOGS_DIR = path.join(NED_HOME, "logs");
export const STATE_PATH = path.join(NED_HOME, "state.json");
export const CURSOR_PATH = path.join(NED_HOME, "cursor.json");
export const CONFIG_PATH = path.join(NED_HOME, "config.yaml");
export const SENT_LOG = path.join(BRIEFINGS_DIR, "sent.log");
export const AGENDA_PATH = path.join(NED_HOME, "agenda.json");
/** Raw model reply of the last agenda run that parsed but came back empty (debugging aid). */
export const AGENDA_RAW_PATH = path.join(NED_HOME, "agenda.raw.txt");
/** Cached calendar ranges outside agenda.calendar_range: <from>_<to>.json. */
export const CALENDAR_DIR = path.join(NED_HOME, "calendar");
export const TODOS_PATH = path.join(NED_HOME, "todos.json");
export const DISMISSED_PATH = path.join(NED_HOME, "dismissed.json");
/** Attention ids the user marked 확인 완료 → when (ms). Survives attention being rebuilt. */
export const REVIEWED_PATH = path.join(NED_HOME, "reviewed.json");

/** Local calendar date as YYYY-MM-DD (matches the hook, which uses local time too). */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ensureDirs(): void {
  for (const d of [NED_HOME, EVENTS_DIR, BRIEFINGS_DIR, LOGS_DIR, CALENDAR_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(path.join(LOGS_DIR, "daemon.log"), line);
  } catch {
    /* ignore */
  }
}
