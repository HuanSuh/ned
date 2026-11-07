/**
 * 정리 결과물: when a Ned Net answer carries a ```ned-output block ({"kind","title","markdown"}), the daemon saves it —
 * always to ~/.ned/outputs/<id>.{json,md} (GET /api/outputs), and, with config.archive on (include.outputs), as a note in
 * the vault: <vault>/<folder>/Notes/YYYY-MM/YYYY-MM-DD.<slug>.md. No claude call: the model already wrote the markdown.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import type { NedArchive } from "./config.js";
import { NED_HOME, localDay, log, readJson, writeJsonAtomic } from "./paths.js";
import { checkVault, defang, noteArchiveError, resolveInVault, writeFileAtomic } from "./vault.js";

export const OUTPUTS_DIR = path.join(NED_HOME, "outputs");
export const OUTPUT_KINDS = ["meeting", "document", "mail", "other"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];
export const OUTPUT_KIND_KO: Record<OutputKind, string> = { meeting: "회의", document: "문서", mail: "메일", other: "정리" };
export const OUTPUT_MARKDOWN_MAX = 100_000;
export const OUTPUT_FENCE = "ned-output";

export interface OutputBlock {
  kind: OutputKind;
  title: string;
  markdown: string;
}

export interface OutputRecord extends OutputBlock {
  id: string;
  ts: number;
  /** https links found in the markdown (frontmatter `source`). */
  sources: string[];
  chat_id?: string;
  /** The chat message (ned answer) it came from. */
  message_ts?: number;
  /** Written into the vault: path relative to the vault, and an obsidian:// link. */
  vault_rel?: string;
  vault_path?: string;
  obsidian_url?: string;
  /** Vault write failed (the ~/.ned copy is still there). */
  vault_error?: string;
}

/** What a chat message carries about its saved output (ChatMessage.output). */
export type OutputRef = Pick<OutputRecord, "id" | "kind" | "title" | "vault_rel" | "obsidian_url" | "vault_error">;

const FENCE_RE = /```ned-output[^\n]*\n([\s\S]*?)\n?```(?!`)/g;
const ID_RE = /^o-[a-z0-9]{4,40}$/;
export const isOutputId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

/**
 * The LAST complete ```ned-output fence in an answer → a valid block, or { error } when it is malformed, or null when
 * there is none. kind defaults to "other"; title falls back to the markdown's first heading.
 */
export function extractOutputBlock(answer: string): { block: OutputBlock } | { error: string } | null {
  const all = [...String(answer ?? "").matchAll(FENCE_RE)];
  if (!all.length) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(all[all.length - 1][1]) as Record<string, unknown>;
  } catch {
    return { error: "정리 결과(ned-output)를 읽지 못했어 — JSON 형식 오류" };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "정리 결과(ned-output)가 객체가 아니야" };
  const markdown = typeof j.markdown === "string" ? j.markdown.replace(/\r\n?/g, "\n").trim() : "";
  if (!markdown) return { error: "정리 결과(ned-output)에 markdown 이 비어 있어" };
  if (markdown.length > OUTPUT_MARKDOWN_MAX) return { error: `정리 결과가 너무 길어 (${markdown.length}자 > ${OUTPUT_MARKDOWN_MAX})` };
  const kind = OUTPUT_KINDS.includes(j.kind as OutputKind) ? (j.kind as OutputKind) : "other";
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1];
  const title = (typeof j.title === "string" && j.title.trim() ? j.title : heading || `${OUTPUT_KIND_KO[kind]} 정리`).replace(/\s+/g, " ").trim().slice(0, 120);
  return { block: { kind, title, markdown } };
}

/** The answer without its ```ned-output fence(s) (what the chat bubble shows above the saved card). */
export const stripOutputBlocks = (answer: string) => String(answer ?? "").replace(FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();

/** A filename-safe slug that keeps Korean: drops \/:*?"<>|#^[] and control chars, collapses spaces, ≤ 60 chars. */
export function slugify(title: string): string {
  const s = String(title ?? "")
    .replace(/[\u0000-\u001f\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60)
    .trim();
  return s || "정리";
}

const urlsIn = (md: string) => [...new Set([...md.matchAll(/https?:\/\/[^\s<>()\]"'`]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, "")))].slice(0, 30);

/** The vault note: YAML frontmatter (date, kind, source, tags) + "# title" (unless the markdown starts with one) + body. */
export function outputNote(rec: Pick<OutputRecord, "ts" | "kind" | "title" | "markdown" | "sources">): string {
  const fm = YAML.stringify({ date: localDay(new Date(rec.ts)), kind: rec.kind, source: rec.sources, tags: ["ned", rec.kind] }).trimEnd();
  const body = /^#\s/.test(rec.markdown) ? rec.markdown : `# ${rec.title}\n\n${rec.markdown}`;
  return `---\n${fm}\n---\n\n${defang(body)}\n`;
}

/** obsidian://open?vault=<vault folder name>&file=<path without .md> */
export const obsidianUrl = (vault: string, rel: string) => `obsidian://open?vault=${encodeURIComponent(path.basename(vault))}&file=${encodeURIComponent(rel.replace(/\.md$/, ""))}`;

/** Write the note into the vault (never overwrites: " (2)", " (3)" … on a name clash). Returns the vault-relative path. */
export function writeOutputNote(arch: Pick<NedArchive, "vault" | "folder">, rec: OutputRecord): string {
  const day = localDay(new Date(rec.ts));
  const dir = `${arch.folder}/Notes/${day.slice(0, 7)}`;
  const slug = slugify(rec.title);
  for (let n = 1; n < 100; n++) {
    const rel = `${dir}/${day}.${slug}${n > 1 ? ` (${n})` : ""}.md`;
    const abs = resolveInVault(arch.vault, rel);
    if (fs.existsSync(abs)) continue;
    writeFileAtomic(abs, outputNote(rec));
    return rel;
  }
  throw new Error("too many notes with the same name");
}

/**
 * Save a block: ~/.ned/outputs/<id>.json + .md always; the vault note too when archive is on with include.outputs.
 * A vault failure is recorded (vault_error, 설정 → 아카이브 last error) and never thrown.
 */
export function saveOutput(arch: NedArchive, block: OutputBlock, meta: { chat_id?: string; message_ts?: number; now?: number } = {}): OutputRecord {
  const ts = meta.now ?? Date.now();
  const rec: OutputRecord = { id: `o-${ts.toString(36)}${randomBytes(3).toString("hex")}`, ts, ...block, sources: urlsIn(block.markdown) };
  if (meta.chat_id) rec.chat_id = meta.chat_id;
  if (meta.message_ts) rec.message_ts = meta.message_ts;
  if (arch.enabled && arch.include.outputs) {
    const chk = checkVault(arch.vault);
    if (!chk.ok) rec.vault_error = `볼트에 못 썼어: ${chk.error}`;
    else
      try {
        rec.vault_rel = writeOutputNote(arch, rec);
        rec.vault_path = resolveInVault(arch.vault, rec.vault_rel);
        rec.obsidian_url = obsidianUrl(arch.vault, rec.vault_rel);
      } catch (e) {
        rec.vault_error = `볼트에 못 썼어: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
        noteArchiveError("결과물 노트 쓰기 실패", e, ts);
      }
    if (rec.vault_error && !chk.ok) noteArchiveError("결과물 노트 쓰기 실패", new Error(chk.error), ts);
  }
  try {
    writeJsonAtomic(path.join(OUTPUTS_DIR, `${rec.id}.json`), rec);
    fs.writeFileSync(path.join(OUTPUTS_DIR, `${rec.id}.md`), outputNote(rec));
  } catch (e) {
    log(`outputs: could not save ${rec.id}: ${String(e).slice(0, 200)}`);
  }
  log(`outputs: saved ${rec.id} (${rec.kind}) "${rec.title}"${rec.vault_rel ? ` → vault ${rec.vault_rel}` : rec.vault_error ? ` (${rec.vault_error})` : ""}`);
  return rec;
}

export const outputRef = (r: OutputRecord): OutputRef => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  ...(r.vault_rel ? { vault_rel: r.vault_rel } : {}),
  ...(r.obsidian_url ? { obsidian_url: r.obsidian_url } : {}),
  ...(r.vault_error ? { vault_error: r.vault_error } : {}),
});

export function readOutput(id: string): OutputRecord | null {
  if (!isOutputId(id)) return null;
  const r = readJson<OutputRecord | null>(path.join(OUTPUTS_DIR, `${id}.json`), null);
  return r && r.id === id ? r : null;
}

/** Newest first. `day` (YYYY-MM-DD, local) narrows to that day. */
export function listOutputs(opts: { limit?: number; day?: string } = {}): OutputRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(OUTPUTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => readOutput(f.slice(0, -5)))
    .filter((r): r is OutputRecord => !!r && (!opts.day || localDay(new Date(r.ts)) === opts.day))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, opts.limit ?? 50);
}

/** The file "Finder 에서 보기" reveals: the vault note if it is still there, else the ~/.ned copy. */
export function outputFile(r: OutputRecord): string {
  if (r.vault_path && fs.existsSync(r.vault_path)) return r.vault_path;
  return path.join(OUTPUTS_DIR, `${r.id}.md`);
}
