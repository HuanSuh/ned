/**
 * Obsidian vault plumbing for the archive (src/archive.ts) and 정리 결과물 notes (src/outputs.ts): vault checks, path-safe
 * joins (no traversal / symlink escape), atomic writes, Ned-owned marker blocks, and the small archive state file
 * (~/.ned/archive.json: dirty days, last write / last error). No claude calls anywhere here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NED_HOME, log, readJson, writeJsonAtomic } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The Ned repo checkout (packages/daemon/{src,dist}/ → ../../..). A vault inside it is refused. */
export const REPO_ROOT = path.resolve(here, "../../..");
export const ARCHIVE_STATE_PATH = path.join(NED_HOME, "archive.json");

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export interface VaultCheck {
  ok: boolean;
  /** `<vault>/.obsidian` exists → "볼트 확인됨". Missing is only a warning (writing still works). */
  obsidian: boolean;
  path: string;
  error?: string;
}

/** Is `vault` usable? Absolute, an existing directory, and neither inside nor containing ~/.ned or the repo. */
export function checkVault(vault: string, opts: { nedHome?: string; repoRoot?: string } = {}): VaultCheck {
  const v = String(vault ?? "").trim();
  const fail = (error: string): VaultCheck => ({ ok: false, obsidian: false, path: v, error });
  if (!v) return fail("볼트 경로가 비어 있어");
  if (!path.isAbsolute(v)) return fail("볼트 경로는 절대 경로여야 해 (예: /Users/me/Documents/obsidian)");
  let st: fs.Stats;
  try {
    st = fs.statSync(v);
  } catch {
    return fail("그 경로에 폴더가 없어");
  }
  if (!st.isDirectory()) return fail("폴더가 아니야");
  const rv = real(v);
  for (const [name, p] of [["~/.ned", opts.nedHome ?? NED_HOME], ["Ned 레포", opts.repoRoot ?? REPO_ROOT]] as const) {
    const rp = real(p);
    if (inside(rv, rp) || inside(rp, rv)) return fail(`${name} 안(또는 그 상위)은 볼트로 쓸 수 없어`);
  }
  return { ok: true, obsidian: fs.existsSync(path.join(rv, ".obsidian")), path: v };
}

/**
 * `<vault>/<rel>` as an absolute path, refusing anything that would land outside the vault: "..", absolute `rel`,
 * NUL, and symlinked parents pointing elsewhere (the deepest existing ancestor is realpath-checked).
 */
export function resolveInVault(vault: string, rel: string): string {
  if (!vault || !path.isAbsolute(vault)) throw new Error("vault must be an absolute path");
  if (typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel)) throw new Error(`bad vault path: ${rel}`);
  const root = path.resolve(vault);
  const abs = path.resolve(root, rel);
  if (abs === root || !inside(abs, root)) throw new Error(`path escapes the vault: ${rel}`);
  let anc = path.dirname(abs);
  while (!fs.existsSync(anc) && anc !== path.dirname(anc)) anc = path.dirname(anc);
  if (!inside(real(anc), real(root))) throw new Error(`path escapes the vault (symlink): ${rel}`);
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${rel}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return abs;
}

/** temp file in the same directory (a dotfile — Obsidian ignores those) → rename. Creates parent dirs. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.ned-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ---------- marker blocks: <!-- ned:name --> … <!-- ned:/name --> ----------

export const openMarker = (name: string) => `<!-- ned:${name} -->`;
export const closeMarker = (name: string) => `<!-- ned:/${name} -->`;

/** Keep generated text from forging a marker (a title containing "<!-- ned:x -->" would break the next parse). */
export const defang = (s: string) => s.replace(/<!--/g, "<!-");

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/**
 * The Ned-owned span for `name`: the LAST opening marker that has a closing marker after it, up to the first closing
 * marker after it. Orphan markers (the user deleted one half) never pair across user text. null = no intact pair.
 */
export function findBlock(content: string, name: string): { start: number; end: number } | null {
  const open = openMarker(name), close = closeMarker(name);
  const opens = allIndexes(content, open), closes = allIndexes(content, close);
  for (let i = opens.length - 1; i >= 0; i--) {
    const e = closes.find((c) => c > opens[i]);
    if (e !== undefined) return { start: opens[i], end: e + close.length };
  }
  return null;
}

/**
 * Replace each named block's inside with `body` (markers kept); text outside every intact pair is left byte-for-byte.
 * A block with no intact pair (new file, or the user deleted a marker) is appended at the end as a fresh pair.
 */
export function replaceBlocks(content: string, blocks: { name: string; body: string }[]): string {
  let out = content;
  for (const b of blocks) {
    const full = `${openMarker(b.name)}\n${b.body.replace(/\s+$/, "")}\n${closeMarker(b.name)}`;
    const span = findBlock(out, b.name);
    if (span) out = out.slice(0, span.start) + full + out.slice(span.end);
    else out = `${out.replace(/\s*$/, "")}${out.trim() ? "\n\n" : ""}${full}\n`;
  }
  return out;
}

// ---------- ~/.ned/archive.json ----------

export interface ArchiveState {
  /** day (YYYY-MM-DD) → ms of the first change not yet written. */
  dirty: Record<string, number>;
  /** day → ms of the last write of that day's report. */
  written: Record<string, number>;
  /** agenda sources_status.<k>.updated_at last counted (so each finished refresh counts once). */
  src_seen: Record<string, number> | null;
  /** day → source → finished refreshes seen. */
  src_counts: Record<string, Record<string, number>>;
  last_write_at: number | null;
  last_write_path: string | null;
  last_error: string | null;
  last_error_at: number | null;
  /** The last daily-note embed outcome ("inserted" / "present" / "no_note" / …), for the settings section. */
  last_embed: { day: string; result: string; at: number } | null;
}
const EMPTY: ArchiveState = { dirty: {}, written: {}, src_seen: null, src_counts: {}, last_write_at: null, last_write_path: null, last_error: null, last_error_at: null, last_embed: null };

export function readArchiveState(): ArchiveState {
  const s = readJson<Partial<ArchiveState>>(ARCHIVE_STATE_PATH, {});
  const obj = <T>(v: unknown, d: T): T => (v && typeof v === "object" && !Array.isArray(v) ? (v as T) : d);
  return { ...EMPTY, ...s, dirty: obj(s.dirty, {}), written: obj(s.written, {}), src_counts: obj(s.src_counts, {}), src_seen: s.src_seen ? obj(s.src_seen, null) : null };
}

/** A pending day older than this is dropped (its writes kept failing — e.g. the vault went away for a week). */
export const DIRTY_MAX_DAYS = 7;

/** Local YYYY-MM-DD (same as paths.localDay; kept here so vault.ts stays import-light). */
const ymd = (ms: number) => {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Read-modify-write (one process, sync → no interleaving). Keeps written / src_counts to the last 14 days, and drops
 * pending (dirty) days older than DIRTY_MAX_DAYS before `now` with a warning — otherwise a day that can never be written
 * would pile up forever. Malformed dirty keys are dropped too.
 */
export function patchArchiveState(fn: (s: ArchiveState) => void, now = Date.now()): ArchiveState {
  const s = readArchiveState();
  fn(s);
  for (const k of ["written", "src_counts"] as const) for (const d of Object.keys(s[k]).sort().slice(0, -14)) delete s[k][d];
  const cutoff = ymd(now - DIRTY_MAX_DAYS * 24 * 3600_000);
  const stale = Object.keys(s.dirty).filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < cutoff);
  if (stale.length) {
    log(`archive: warn — dropping ${stale.length} pending day(s) older than ${DIRTY_MAX_DAYS} days, never written: ${stale.sort().join(", ")}`);
    for (const d of stale) delete s.dirty[d];
  }
  try {
    writeJsonAtomic(ARCHIVE_STATE_PATH, s);
  } catch (e) {
    log(`archive: could not save ${ARCHIVE_STATE_PATH}: ${String(e).slice(0, 200)}`);
  }
  return s;
}

/** Log + remember a failed vault write (shown in 설정 → 아카이브). Never throws. */
export function noteArchiveError(what: string, e: unknown, now = Date.now()): void {
  const code = (e as NodeJS.ErrnoException)?.code;
  const hint = code === "EPERM" || code === "EACCES" ? " — 권한 거부: 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더(또는 전체 디스크 접근)에서 Ned 를 허용해 줘" : "";
  const msg = `${what}: ${String((e as Error)?.message ?? e).slice(0, 300)}${hint}`;
  log(`archive: ${msg}`);
  patchArchiveState((s) => {
    s.last_error = msg;
    s.last_error_at = now;
  }, now);
}
