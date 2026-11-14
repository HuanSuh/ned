/**
 * 보내기 전 자동 검토 (config.actions.review = "warn"): one no-tool `claude -p` turn (draft_fast_model, effort low,
 * 20s) reads the draft, the recipient and the original request and answers {ok, issues:[{kind, detail}]}.
 * Issues never block — they go to the same confirm step as a `confirm` rule. A timeout / failure is "검토 못 함": the
 * send goes on with that note. Sessions (a local terminal) are not reviewed. Prompt: prompts/send-review.md.
 *
 * NED_NO_LLM=1 (and tests) never spawn claude: an injected reviewer (_setSendReviewer), else an offline stub that only
 * looks for secret-looking strings (marked "(stub)").
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
import type { NedConfig } from "./config.js";
import { fillTemplate } from "./draft-thread.js";
import type { SendRequest } from "./actions.js";
import { UNRULED_MODES, type SendTarget } from "./send-rules.js";
import { log } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(here, "../../../prompts/send-review.md");

export const REVIEW_KINDS = ["recipient", "secret", "commitment", "tone", "other"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export interface ReviewIssue {
  kind: ReviewKind;
  detail: string;
}
/** ok = looked, nothing found · issues = found some · failed = could not look (timeout / bad answer) · skipped = not reviewed. */
export interface ReviewOutcome {
  status: "ok" | "issues" | "failed" | "skipped";
  issues: ReviewIssue[];
  /** failed / skipped: why ("검토 못 함: timeout"). */
  note?: string;
}
export interface ReviewInput {
  source: string;
  mode: string;
  target: string;
  original: string;
  draft: string;
}
export type SendReviewer = (input: ReviewInput, cfg: NedConfig) => Promise<ReviewOutcome>;

export const REVIEW_TIMEOUT_MS = 20_000;
const MAX_ISSUES = 6;

/** Should `req` be reviewed under `cfg`? warn mode, not a session, a real send with something to read. */
export function wantsReview(req: SendRequest, cfg: Pick<NedConfig, "actions">): boolean {
  if (cfg.actions.review !== "warn" || req.source === "session" || UNRULED_MODES.has(req.mode)) return false;
  return !!req.text.trim() || !!req.event;
}

export function reviewInput(req: SendRequest, target: SendTarget): ReviewInput {
  const ev = req.event;
  const draft = ev ? [`제목: ${ev.title}`, `시간: ${ev.start} – ${ev.end}`, ev.location && `장소: ${ev.location}`, ev.attendees.length ? `참석자: ${ev.attendees.join(", ")}` : "", ev.description && `설명: ${ev.description}`].filter(Boolean).join("\n") : req.text;
  return {
    source: req.source,
    mode: req.mode,
    target: target.label || "(알 수 없음)",
    original: [req.ref.title, req.ref.text].filter(Boolean).join("\n").slice(0, 1500) || "(없음)",
    draft: draft.slice(0, 4000),
  };
}

/** The model's answer → issues (unknown kinds → other, empty details dropped, ≤ 6, each ≤ 200 chars). null = not a review answer. */
export function parseReview(text: string): ReviewOutcome | null {
  const j = extractJson<{ ok?: unknown; issues?: unknown }>(text);
  if (!j || (typeof j.ok !== "boolean" && !Array.isArray(j.issues))) return null;
  const issues = (Array.isArray(j.issues) ? j.issues : [])
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    // The model may quote the secret it found: mask it before the detail reaches the response or sent-actions.log.
    .map((x) => ({ kind: (REVIEW_KINDS.includes(x.kind as ReviewKind) ? x.kind : "other") as ReviewKind, detail: maskSecrets(String(x.detail ?? "").replace(/\s+/g, " ").trim()).slice(0, 200) }))
    .filter((x) => x.detail)
    .slice(0, MAX_ISSUES);
  return { status: issues.length ? "issues" : "ok", issues };
}

export function buildReviewPrompt(input: ReviewInput, tpl = fs.readFileSync(PROMPT_PATH, "utf8")): string {
  return fillTemplate(tpl, { SOURCE: input.source, MODE: input.mode, TARGET: input.target, ORIGINAL: input.original, DRAFT: input.draft });
}

/** The real reviewer: 1 turn, no tools, isolated start-up, effort low, draft_fast_model. */
export const claudeReviewer: SendReviewer = async (input, cfg) => {
  const res = await runClaude(buildReviewPrompt(input), { allowedTools: [], tools: [], maxTurns: 1, isolated: true, effort: "low", model: cfg.draft_fast_model ?? cfg.claude_model, timeoutMs: REVIEW_TIMEOUT_MS, job: "action" });
  if (!res.ok) return { status: "failed", issues: [], note: `검토 못 함: ${(res.error || "claude 실패").slice(0, 120)}` };
  return parseReview(res.text) ?? { status: "failed", issues: [], note: "검토 못 함: 답을 읽지 못했어" };
};

const SECRET_SRC = String.raw`\b(xox[abpr]-[\w-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(password|passwd|비밀번호)\s*[:=]\s*\S+`;
const SECRET_RE = new RegExp(SECRET_SRC, "i");
/** Secret-looking runs → "[가림]" (review details are logged to sent-actions.log). */
export const maskSecrets = (s: string) => s.replace(new RegExp(SECRET_SRC, "gi"), "[가림]");
/** NED_NO_LLM without an injected reviewer: an offline check for secret-looking strings only (clearly marked). */
export const stubReviewer: SendReviewer = async (input) =>
  SECRET_RE.test(input.draft) ? { status: "issues", issues: [{ kind: "secret", detail: "(stub) 토큰·비밀번호처럼 보이는 문자열이 있어" }] } : { status: "ok", issues: [] };

let injected: SendReviewer | null = null;
let timeoutMs = REVIEW_TIMEOUT_MS;
/** Tests / NED_NO_LLM: swap the reviewer (undefined → back to the default) and, for the timeout test, the deadline. */
export function _setSendReviewer(fn?: SendReviewer, deadlineMs = REVIEW_TIMEOUT_MS): void {
  injected = fn ?? null;
  timeoutMs = deadlineMs;
}

/** Run the review (never throws, never longer than REVIEW_TIMEOUT_MS). */
export async function reviewSend(req: SendRequest, target: SendTarget, cfg: NedConfig): Promise<ReviewOutcome> {
  const reviewer = injected ?? (llmDisabled() ? stubReviewer : claudeReviewer);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ReviewOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "failed", issues: [], note: `검토 못 함: ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았어` }), timeoutMs);
  });
  try {
    return await Promise.race([reviewer(reviewInput(req, target), cfg), timeout]);
  } catch (e) {
    log(`send-review: ${String(e).slice(0, 200)}`);
    return { status: "failed", issues: [], note: `검토 못 함: ${String(e).slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}
