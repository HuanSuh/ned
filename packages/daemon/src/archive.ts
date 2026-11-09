/**
 * Obsidian 아카이브 (config.archive): the daemon keeps a daily report <vault>/<folder>/Daily/YYYY-MM/YYYY-MM-DD.md —
 * 브리핑 · 순찰 · 보낸 것 · 정리 결과물 · 세션 · 들어온 것 · 오늘 — rendered from what is already on disk (briefings, sent-actions.log,
 * outputs, events, the 수집 이력 (src/history.ts), costs, agenda refresh counts). No claude call.
 *
 * Each section lives between `<!-- ned:<name> -->` … `<!-- ned:/<name> -->`; only that span is rewritten, anything the user
 * writes outside the markers is kept byte-for-byte. Writes are atomic (temp → rename).
 *
 * When: right after a briefing / heartbeat UPDATE / successful action / saved output (archiveTouch immediate), and from the
 * daemon's 1-minute tick (archiveTick) when a day changed since its last write and ≥ ARCHIVE_FLUSH_MS passed. Changes are
 * filed under the day of the change (a heartbeat that started 23:59 lands in that day's file); a past day is only written
 * while it still has a pending change, then never touched again.
 *
 * archive.daily_embed: the user's own daily note (from <vault>/.obsidian/daily-notes.json), if it already exists, gets one
 * `<!-- ned:embed -->![[…]]<!-- ned:/embed -->` line under "## 📝 Notes & Logs". Nothing else in it is changed, and a
 * missing note is never created.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { readActionLog, type ActionLogEntry } from "./actions.js";
import { loadConfig, type NedArchive, type NedConfig } from "./config.js";
import { COSTS_PATH } from "./costs.js";
import { describeRecord, firstSeenOn, type HistRecord } from "./history.js";
import { parseLines } from "./events.js";
import { AGENDA_PATH, BRIEFINGS_DIR, EVENTS_DIR, localDay, log, readJson } from "./paths.js";
import { OUTPUT_KIND_KO, listOutputs } from "./outputs.js";
import { reduceSessions } from "./sessions.js";
import { briefingOk, type Briefing, type BriefingSection } from "./state.js";
import { checkVault, defang, findBlock, noteArchiveError, patchArchiveState, readArchiveState, replaceBlocks, resolveInVault, writeFileAtomic, type VaultCheck } from "./vault.js";

/** Tick flush: a changed day is rewritten at most this often (immediate triggers bypass it). */
export const ARCHIVE_FLUSH_MS = 5 * 60_000;
export const SECTIONS = ["briefing", "patrol", "sent", "outputs", "sessions", "history", "today"] as const;
export type SectionName = (typeof SECTIONS)[number];

/** Same idea as server.ts BUILD_ID (code mtime), without importing the server. */
export const NED_VERSION = process.env.NED_BUILD_ID || (() => {
  try {
    return Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs).toString(36);
  } catch {
    return "dev";
  }
})();

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** One-line, marker-safe text for a list item ("[", "]" left alone — they are fine in Obsidian list text). */
const one = (s: unknown, n: number) => defang(clip(s, n));
const link = (title: string, url?: string) => (url && /^https?:\/\//.test(url) ? `[${title.replace(/[[\]]/g, "")}](${url.replace(/[()\s]/g, encodeURIComponent)})` : title);
const dayStart = (day: string) => new Date(`${day}T00:00:00`).getTime();
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Vault-relative path of the day's report (and its wikilink target without ".md"). */
export const reportRel = (folder: string, day: string) => `${folder}/Daily/${day.slice(0, 7)}/${day}.md`;
export const reportLink = (folder: string, day: string) => reportRel(folder, day).replace(/\.md$/, "");

// ---------- data for one day ----------

export interface DayData {
  day: string;
  briefings: Briefing[];
  actions: ActionLogEntry[];
  outputs: ReturnType<typeof listOutputs>;
  sessions: ReturnType<typeof reduceSessions>;
  costs: { total_usd: number; runs: number; jobs: Record<string, { usd: number; runs: number }> } | null;
  srcCounts: Record<string, number>;
  /** 수집 이력 records first seen that day, per source (archive.include.history). */
  incoming?: Record<string, HistRecord[]>;
}

/** Briefing files are named by their UTC ISO time — read only the ones that can fall on `day` (local), then check ts. */
export function briefingsOn(day: string): Briefing[] {
  const from = dayStart(day), to = from + 26 * 3600_000;
  let files: string[];
  try {
    files = fs.readdirSync(BRIEFINGS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Briefing[] = [];
  for (const f of files) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(f);
    const t = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
    if (Number.isFinite(t) && (t < from - 2 * 3600_000 || t > to)) continue;
    const b = readJson<Briefing | null>(path.join(BRIEFINGS_DIR, f), null);
    if (b && typeof b.ts === "number" && localDay(new Date(b.ts)) === day) out.push(b);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function collectDay(day: string, cfg: Pick<NedConfig, "session_stale_minutes">): DayData {
  const actions = readActionLog(Number.MAX_SAFE_INTEGER)
    .filter((e) => e.ok && !String(e.action).startsWith("dry_run:") && e.mode !== "transitions" && localDay(new Date(Date.parse(e.ts))) === day)
    .reverse();
  let events: ReturnType<typeof parseLines> = [];
  try {
    events = parseLines(fs.readFileSync(path.join(EVENTS_DIR, `${day}.jsonl`), "utf8"));
  } catch {
    /* no events that day */
  }
  const costs = readJson<{ days?: Record<string, DayData["costs"]> }>(COSTS_PATH, {}).days?.[day] ?? null;
  return {
    day,
    briefings: briefingsOn(day),
    actions,
    outputs: listOutputs({ day, limit: 500 }).reverse(),
    sessions: reduceSessions(events, cfg.session_stale_minutes ?? 180, dayStart(day) + 24 * 3600_000).filter((s) => !s.is_worker),
    costs,
    srcCounts: readArchiveState().src_counts[day] ?? {},
    incoming: firstSeenOn(day),
  };
}

// ---------- rendering ----------

const KIND_KO: Record<string, string> = { session: "세션", email: "메일", slack: "Slack", jira: "Jira", github: "GitHub", sentry: "Sentry", calendar: "캘린더", other: "기타" };
const SRC_KO: Record<string, string> = { slack: "Slack", email: "메일", session: "세션", jira: "Jira", github: "GitHub", calendar: "캘린더", todo: "할 일" };
const MODE_KO: Record<string, string> = {
  send: "보냄", gmail_draft: "초안 저장", mark_read: "읽음 처리", session: "세션에 보냄", comment: "코멘트", transition: "상태 변경",
  approve: "승인", request_changes: "변경 요청", review_comment: "리뷰 코멘트", rsvp: "참석 응답", create: "만듦", add: "추가",
};
const itemLine = (x: BriefingSection, prefix = "") => `- ${prefix}${x.kind ? `[${KIND_KO[x.kind] ?? x.kind}] ` : ""}${link(one(x.title, 160), x.url)}${x.detail ? ` — ${one(x.detail, 160)}` : ""}`;
const keyOf = (s: BriefingSection) => (s.url || s.title || "").trim().toLowerCase();

/** Every daily briefing of the day (a re-run of 아침 브리핑 drops already-sent items, so the first one keeps them): one list each, deduped. */
function briefingBody(d: DayData): string {
  const dailies = d.briefings.filter((x) => x.type === "daily" && briefingOk(x)); // failed runs (claude error / unparsable) aren't a briefing
  const failed = d.briefings.filter((x) => x.type === "daily" && !briefingOk(x)).length;
  if (!dailies.length) return `## 🌅 브리핑\n\n_(${failed ? `아침 브리핑 실패 ${failed}회 — 성공한 브리핑 없음` : "아직 아침 브리핑 없음"})_`;
  const out = [`## 🌅 브리핑`, "", ...dailies.map((b) => `${hm(b.ts)}${b.headline ? ` — **${one(b.headline, 200)}**` : ""}`)];
  const seen = new Set<string>();
  for (const label of ["행동 필요", "업데이트", "참고"] as const) {
    const key = label === "행동 필요" ? "action_items" : label === "업데이트" ? "updates" : "fyi";
    const xs = dailies.flatMap((b) => b[key] ?? []).filter((x) => {
      const k = keyOf(x);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (xs.length) out.push("", `**${label}**`, ...xs.map((x) => itemLine(x)));
  }
  return out.join("\n");
}

function patrolBody(d: DayData): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const b of d.briefings) {
    if (b.type !== "heartbeat" || b.status !== "UPDATE") continue;
    for (const [mark, xs] of [["❗ ", b.action_items], ["", b.updates], ["· ", b.fyi]] as const) {
      for (const x of xs ?? []) {
        const k = keyOf(x);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        lines.push(itemLine(x, `${hm(b.ts)} ${mark}`));
      }
    }
  }
  return ["## 🔔 순찰", "", ...(lines.length ? lines : ["_(오늘 새로 알린 것 없음)_"])].join("\n");
}

/** Action log origin → the short label after a "보낸 것" line (absent = older entries, no label). */
const ORIGIN_KO: Record<string, string> = { chat: "대화창", card: "카드", history: "지난 N일", watch: "팔로업" };
function actionTarget(e: ActionLogEntry): string {
  const r = e.ref ?? {};
  return r.title || r.key || (r.repo ? `${r.repo}#${r.number ?? ""}` : "") || r.channel || (r.session_id ? `세션 ${String(r.session_id).slice(0, 8)}` : "") || "";
}
function sentBody(d: DayData): string {
  const lines = d.actions.map((e) => {
    const url = e.event?.html_link || /https:\/\/[^\s"')]+/.exec(e.result ?? "")?.[0] || e.ref?.url;
    const what = `${SRC_KO[e.source] ?? e.source} ${MODE_KO[e.mode] ?? e.mode}`;
    const tgt = one(actionTarget(e), 100);
    return `- ${hm(Date.parse(e.ts))} ${what}${tgt ? ` · ${link(tgt, url)}` : url ? ` · ${link("링크", url)}` : ""}${e.text ? ` — “${one(e.text, 100)}”` : ""}${e.origin && ORIGIN_KO[e.origin] ? ` (${ORIGIN_KO[e.origin]})` : ""}`;
  });
  return ["## ✉️ 보낸 것", "", ...(lines.length ? lines : ["_(오늘 보낸 것 없음)_"])].join("\n");
}

function outputsBody(d: DayData): string {
  const lines = d.outputs.map((o) => `- ${hm(o.ts)} ${o.vault_rel ? `[[${o.vault_rel.replace(/\.md$/, "")}|${one(o.title, 120).replace(/[|[\]]/g, " ")}]]` : `${one(o.title, 120)} _(Ned 에만 저장)_`} · ${OUTPUT_KIND_KO[o.kind] ?? o.kind}`);
  return ["## 📎 정리 결과물", "", ...(lines.length ? lines : ["_(오늘 정리한 것 없음)_"])].join("\n");
}

const STATUS_KO: Record<string, string> = { running: "실행 중", waiting: "입력 대기", done: "완료", error: "오류", ended: "종료" };
function sessionsBody(d: DayData): string {
  const lines = [...d.sessions].sort((a, b) => a.since - b.since).map((s) => `- ${hm(s.since)}–${hm(s.last_event_ts)} ${one(s.worktree || path.basename(s.cwd), 60)} · ${STATUS_KO[s.status] ?? s.status}${s.last_summary ? ` — ${one(s.last_summary, 140)}` : s.last_prompt ? ` — “${one(s.last_prompt, 100)}”` : ""}`);
  return ["## 🤖 세션", "", ...(lines.length ? lines : ["_(오늘 세션 없음)_"])].join("\n");
}

/** Lines per source in "📥 들어온 것" before "… 외 N건". */
export const INCOMING_MAX = 30;
const INCOMING_KO: [string, string][] = [["slack", "Slack"], ["mail", "메일"], ["jira", "Jira"], ["github", "GitHub"], ["calendar", "캘린더"]];
const md = (ms: number) => `${new Date(ms).getMonth() + 1}/${new Date(ms).getDate()}`;

/** One "📥 들어온 것" line for a history record (per source: who · what · link). */
function incomingLine(r: HistRecord): string {
  const it = r.item as Record<string, any>, t = Date.parse(r.ts);
  const d = describeRecord(r);
  switch (r.source) {
    case "slack":
      return `- ${Number.isFinite(t) ? `${hm(t)} ` : ""}${one(it.channel || it.watch?.channel || "", 40)}${it.from ? ` · ${one(it.from, 40)}` : ""} — ${link(one(d.title, 120), it.url)}`;
    case "mail":
      return `- ${Number.isFinite(t) ? `${hm(t)} ` : ""}${one(it.from, 60)} — ${link(one(it.subject || "(제목 없음)", 120), it.url)}`;
    case "jira":
      return `- ${link(one(it.key, 30), it.url)} ${one(it.title, 120)}`;
    case "github":
      return `- ${one(it.repo, 60)}#${one(it.number, 10)} ${link(one(it.title, 120), it.url)}`;
    default:
      return `- ${Number.isFinite(t) ? (it.all_day ? `${md(t)} 종일 ` : `${md(t)} ${hm(t)} `) : ""}${link(one(it.title || "(제목 없음)", 120), it.url)}`;
  }
}

function incomingBody(d: DayData): string {
  const out = ["## 📥 들어온 것"];
  let any = false;
  for (const [src, label] of INCOMING_KO) {
    const recs = d.incoming?.[src] ?? [];
    if (!recs.length) continue;
    any = true;
    out.push("", `**${label}** ${recs.length}`, ...recs.slice(0, INCOMING_MAX).map(incomingLine));
    if (recs.length > INCOMING_MAX) out.push(`- … 외 ${recs.length - INCOMING_MAX}건`);
  }
  if (!any) out.push("", "_(오늘 새로 들어온 것 없음)_");
  return out.join("\n");
}

function todayBody(d: DayData): string {
  const hb = d.briefings.filter((b) => b.type === "heartbeat");
  const upd = hb.filter((b) => b.status === "UPDATE").length;
  const src = Object.entries(d.srcCounts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  const c = d.costs;
  const jobs = c ? Object.entries(c.jobs ?? {}).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => `${k} $${v.usd.toFixed(2)}`) : [];
  return [
    "## 📊 오늘",
    "",
    `- 순찰 ${hb.length}회 (알림 ${upd}회)${d.briefings.some((b) => b.type === "daily" && briefingOk(b)) ? " · 아침 브리핑 ✓" : d.briefings.some((b) => b.type === "daily") ? " · 아침 브리핑 실패" : ""}`,
    `- 소스 갱신: ${src.length ? src.join(" · ") : "—"}`,
    `- 비용: ${c ? `$${(c.total_usd ?? 0).toFixed(2)} (${c.runs ?? 0}회${jobs.length ? ` — ${jobs.join(", ")}` : ""})` : "$0.00"}`,
    `- 보낸 것 ${d.actions.length}건 · 정리 결과물 ${d.outputs.length}건`,
  ].join("\n");
}

/** The section bodies for `day` (each with its own "## " heading). A section switched off in archive.include → "". */
export function renderSections(d: DayData, inc: NedArchive["include"]): { name: SectionName; body: string }[] {
  return [
    { name: "briefing", body: inc.briefings ? briefingBody(d) : "" },
    { name: "patrol", body: inc.updates ? patrolBody(d) : "" },
    { name: "sent", body: inc.actions ? sentBody(d) : "" },
    { name: "outputs", body: inc.outputs ? outputsBody(d) : "" },
    { name: "sessions", body: inc.sessions ? sessionsBody(d) : "" },
    { name: "history", body: inc.history !== false ? incomingBody(d) : "" },
    { name: "today", body: todayBody(d) },
  ];
}

export function newReportHeader(day: string): string {
  const fm = YAML.stringify({ created: day, tags: ["ned", "daily"], ned_version: NED_VERSION }).trimEnd();
  return `---\n${fm}\n---\n\n# Ned · ${day}\n\n> Ned 가 매일 자동으로 쓰는 기록. \`<!-- ned:… -->\` 표시 사이는 Ned 가 다시 쓰고, 그 밖에 적은 메모는 그대로 둬.\n`;
}

/**
 * New / existing report text → updated text. Sections switched off are only cleared when their block already exists
 * (an off section is never added).
 */
export function mergeReport(existing: string | null, day: string, sections: { name: string; body: string }[]): string {
  const base = existing ?? newReportHeader(day);
  const blocks = sections.filter((s) => s.body || findBlock(base, s.name));
  return replaceBlocks(base, blocks);
}

// ---------- daily note embed ----------

/** moment-style subset Obsidian's daily-notes "format" uses: YYYY YY MM M DD D, [literal]. Anything else → null. */
export function formatDay(fmt: string, day: string): string | null {
  const [y, m, d] = day.split("-");
  let out = "";
  const re = /\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|([^A-Za-z[]+)|([A-Za-z])/g;
  for (const t of fmt.matchAll(re)) {
    if (t[1] !== undefined) out += t[1];
    else if (t[0] === "YYYY") out += y;
    else if (t[0] === "YY") out += y.slice(2);
    else if (t[0] === "MM") out += m;
    else if (t[0] === "M") out += String(Number(m));
    else if (t[0] === "DD") out += d;
    else if (t[0] === "D") out += String(Number(d));
    else if (t[2] !== undefined) out += t[2];
    else return null;
  }
  return out;
}

export type EmbedResult = "inserted" | "present" | "no_note" | "no_config" | "no_heading" | "bad_format";
export const EMBED_HEADING = "## 📝 Notes & Logs";

/** Candidate vault-relative paths of the user's daily note for `day` (from .obsidian/daily-notes.json), or null. */
export function dailyNoteCandidates(vault: string, day: string): string[] | null {
  const conf = readJson<{ folder?: unknown; format?: unknown } | null>(path.join(vault, ".obsidian", "daily-notes.json"), null);
  if (!conf || typeof conf !== "object") return null;
  const folder = typeof conf.folder === "string" ? conf.folder.replace(/^\/+|\/+$/g, "") : "";
  const pre = folder ? `${folder}/` : "";
  if (typeof conf.format === "string" && conf.format.trim()) {
    const name = formatDay(conf.format.trim(), day);
    return name ? [`${pre}${name}.md`] : [];
  }
  return [`${pre}${day}.md`, `${pre}${day.slice(0, 7)}/${day}.md`];
}

/** Insert the embed line right under EMBED_HEADING when the note exists and doesn't have it yet. Other lines untouched. */
export function ensureEmbed(arch: Pick<NedArchive, "vault" | "folder">, day: string): EmbedResult {
  const cands = dailyNoteCandidates(arch.vault, day);
  if (cands === null) return "no_config";
  if (!cands.length) return "bad_format";
  let file: string | null = null;
  for (const rel of cands) {
    const abs = resolveInVault(arch.vault, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      file = abs;
      break;
    }
  }
  if (!file) return "no_note";
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("<!-- ned:embed -->")) return "present";
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.replace(/\r$/, "").trim() === EMBED_HEADING);
  if (i < 0) return "no_heading";
  const eol = lines[i].endsWith("\r") ? "\r" : "";
  lines.splice(i + 1, 0, `<!-- ned:embed -->![[${reportLink(arch.folder, day)}]]<!-- ned:/embed -->${eol}`);
  const next = lines.join("\n");
  if (fs.readFileSync(file, "utf8") !== text) return "no_note"; // the user is editing right now — try again next write
  writeFileAtomic(file, next);
  return "inserted";
}

// ---------- writing ----------

/** Optimistic re-merge attempts when the file keeps changing under us (Obsidian saving while we merge). */
export const REPORT_WRITE_ATTEMPTS = 4;
/** How writeDailyReport reads the report (tests swap it to simulate a file that keeps changing). */
export interface ReportIo {
  read: (abs: string) => string | null;
}
const fsIo: ReportIo = { read: (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null) };

/**
 * Write (create or update) the report for `day`. Re-reads after merging: if the file changed meanwhile, merge again on
 * top of the new text, up to REPORT_WRITE_ATTEMPTS times. `written: false` = it never held still (nothing written) —
 * the caller keeps the day pending. Throws on I/O failure — callers go through flushDay.
 */
export function writeDailyReport(cfg: NedConfig, day: string, io: ReportIo = fsIo): { file: string; written: boolean } {
  const arch = cfg.archive;
  const rel = reportRel(arch.folder, day);
  const abs = resolveInVault(arch.vault, rel);
  const sections = renderSections(collectDay(day, cfg), arch.include);
  for (let attempt = 0; attempt < REPORT_WRITE_ATTEMPTS; attempt++) {
    const before = io.read(abs);
    const next = mergeReport(before, day, sections);
    if (io.read(abs) !== before) continue; // changed under us (Obsidian save) — re-merge on top of it
    if (next !== before) {
      writeFileAtomic(abs, next);
      log(`archive: wrote ${rel}${before === null ? " (new)" : ""}`);
    }
    return { file: abs, written: true };
  }
  log(`archive: warn — ${rel} kept changing during ${REPORT_WRITE_ATTEMPTS} merge attempts; not written, retrying on the next tick`);
  return { file: abs, written: false };
}

/** Write one day + (daily_embed) its embed; record the outcome. Never throws. false = not written (the day stays pending). */
export function flushDay(cfg: NedConfig, day: string, now = Date.now(), io: ReportIo = fsIo): boolean {
  const arch = cfg.archive;
  const chk = checkVault(arch.vault);
  if (!chk.ok) {
    noteArchiveError("볼트 확인 실패", new Error(chk.error), now);
    return false;
  }
  try {
    const { file, written } = writeDailyReport(cfg, day, io);
    if (!written) {
      patchArchiveState((s) => {
        s.dirty[day] ??= now; // keep it pending → the next tick tries again
      }, now);
      return false;
    }
    let embed: EmbedResult | null = null;
    if (arch.daily_embed)
      try {
        embed = ensureEmbed(arch, day);
      } catch (e) {
        noteArchiveError("데일리 노트 embed 실패", e, now);
      }
    patchArchiveState((s) => {
      delete s.dirty[day];
      s.written[day] = now;
      s.last_write_at = now;
      s.last_write_path = file;
      if (embed) s.last_embed = { day, result: embed, at: now };
    }, now);
    return true;
  } catch (e) {
    noteArchiveError(`데일리 리포트 쓰기 실패 (${day})`, e, now);
    return false;
  }
}

const archiveOn = (cfg: NedConfig) => cfg.archive?.enabled === true && !!cfg.archive.vault;

/**
 * Something for the report happened at `ts` (briefing saved, action sent, output saved, …): mark its day changed and,
 * with `immediate`, write it now. Cheap no-op when the archive is off. Never throws.
 */
export function archiveTouch(ts: number, opts: { immediate?: boolean; cfg?: NedConfig; now?: number } = {}): void {
  try {
    const cfg = opts.cfg ?? loadConfig();
    if (!archiveOn(cfg)) return;
    const day = localDay(new Date(Number.isFinite(ts) ? ts : Date.now()));
    patchArchiveState((s) => {
      s.dirty[day] ??= opts.now ?? Date.now();
    }, opts.now ?? Date.now());
    if (opts.immediate) flushDay(cfg, day, opts.now ?? Date.now());
  } catch (e) {
    log(`archive: touch failed — ${String(e).slice(0, 200)}`);
  }
}

/**
 * The daemon's 1-minute tick (cli.ts, next to the scheduler tick): count finished agenda refreshes per source, then flush
 * each changed day whose last write is ≥ ARCHIVE_FLUSH_MS old. Never throws.
 */
export function archiveTick(cfg: NedConfig, now = Date.now()): void {
  try {
    if (!archiveOn(cfg)) return;
    const ss = readJson<{ sources_status?: Record<string, { status?: string; updated_at?: number }> }>(AGENDA_PATH, {}).sources_status ?? {};
    const st = patchArchiveState((s) => {
      const first = s.src_seen === null;
      s.src_seen ??= {};
      for (const [k, v] of Object.entries(ss)) {
        const t = Number(v?.updated_at) || 0;
        if (v?.status !== "done" || t <= (s.src_seen[k] ?? 0)) continue;
        s.src_seen[k] = t;
        if (first) continue; // don't count what was already there when the archive was switched on
        const day = localDay(new Date(t));
        const c = (s.src_counts[day] ??= {});
        c[k] = (c[k] ?? 0) + 1;
        s.dirty[day] ??= now;
      }
    }, now);
    for (const day of Object.keys(st.dirty).filter(isDay).sort()) {
      if (now - (st.written[day] ?? 0) >= ARCHIVE_FLUSH_MS) flushDay(cfg, day, now);
    }
  } catch (e) {
    log(`archive: tick failed — ${String(e).slice(0, 200)}`);
  }
}

export interface ArchiveStatus {
  enabled: boolean;
  vault: string;
  folder: string;
  check: VaultCheck | null;
  today_rel: string;
  /** obsidian:// link to today's report (when it exists). */
  today_url: string | null;
  last_write_at: number | null;
  last_write_path: string | null;
  last_error: string | null;
  last_error_at: number | null;
  last_embed: { day: string; result: string; at: number } | null;
  pending_days: string[];
}

/** GET /api/archive/status — what 설정 → 아카이브 shows (vault badge, last write, last error). */
export function archiveStatus(cfg: NedConfig, now = Date.now()): ArchiveStatus {
  const a = cfg.archive;
  const st = readArchiveState();
  const day = localDay(new Date(now));
  const check = a.vault ? checkVault(a.vault) : null;
  let todayUrl: string | null = null;
  if (check?.ok)
    try {
      const rel = reportRel(a.folder, day);
      if (fs.existsSync(resolveInVault(a.vault, rel))) todayUrl = `obsidian://open?vault=${encodeURIComponent(path.basename(a.vault))}&file=${encodeURIComponent(rel.replace(/\.md$/, ""))}`;
    } catch {
      /* folder escapes — shown as an error elsewhere */
    }
  return {
    enabled: a.enabled,
    vault: a.vault,
    folder: a.folder,
    check,
    today_rel: reportRel(a.folder, day),
    today_url: todayUrl,
    last_write_at: st.last_write_at,
    last_write_path: st.last_write_path,
    last_error: st.last_error,
    last_error_at: st.last_error_at,
    last_embed: st.last_embed,
    pending_days: Object.keys(st.dirty).filter(isDay).sort(),
  };
}

/** POST /api/archive/flush — write today's report (and any pending day) now. */
export function archiveFlushNow(cfg: NedConfig, now = Date.now()): { ok: boolean; written: string[]; error?: string } {
  if (!archiveOn(cfg)) return { ok: false, written: [], error: "아카이브가 꺼져 있어 (설정 → 아카이브)" };
  const days = [...new Set([...Object.keys(readArchiveState().dirty).filter(isDay), localDay(new Date(now))])].sort();
  const written = days.filter((d) => flushDay(cfg, d, now));
  const st = readArchiveState();
  return written.length === days.length ? { ok: true, written } : { ok: false, written, error: st.last_error ?? "쓰기 실패" };
}
