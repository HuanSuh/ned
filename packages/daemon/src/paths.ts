import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const NED_HOME = process.env.NED_HOME ?? path.join(os.homedir(), ".ned");
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
