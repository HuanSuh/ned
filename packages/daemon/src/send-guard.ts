/**
 * The confirm step of a send, enforced by the daemon (POST /api/send · /api/calendar/events → send-jobs.ts):
 * a `confirm` rule (send-rules.ts) or review issues (send-review.ts) → 409 {need_confirm, reasons, review, confirm_token}.
 * The client shows them, and on [그래도 보내기] posts the same request + confirm_token. The token is an HMAC (per daemon
 * run) over the request content (source, mode, draft, ref, text, event) and its expiry — 5 minutes, and a changed text /
 * target is a different request, so it asks again. A token starts one send job only (then "spent" — reuse asks again).
 * A valid token skips the review (the user already saw it).
 *
 * Not a security boundary against local processes: the 409 hands the token to whoever asked, so any program on this
 * Mac that can reach 127.0.0.1 (an agent included) can confirm its own request. `confirm` guards against mistakes made
 * in the dashboard; `block` (403, no token) is the hard stop. A dashboard-only token is backlog.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NedConfig, RuleEffect } from "./config.js";
import type { SendRequest } from "./actions.js";
import { matchSendRule, ruleReason, sendTargetOf, UNRULED_MODES, type RuleMatch } from "./send-rules.js";
import { reviewSend, wantsReview, type ReviewOutcome } from "./send-review.js";

export const CONFIRM_TTL_MS = 5 * 60_000;
const SECRET = randomBytes(32);

/** What the guard decided — rides on the SendRequest into performSend and the action log. */
export interface SendGuard {
  rule?: { index: number; effect: RuleEffect; note?: string };
  review?: ReviewOutcome;
  /** The user confirmed this exact request (valid confirm_token). */
  confirmed?: boolean;
}

export interface NeedConfirm {
  reasons: string[];
  review?: ReviewOutcome;
  confirm_token: string;
  expires_at: string;
  /** The request carried a token that no longer fits (expired / the text or target changed / already used). */
  token_problem?: "expired" | "mismatch" | "invalid" | "spent";
}

export type GuardDecision = { kind: "go"; guard: SendGuard } | { kind: "confirm"; need: NeedConfirm; guard: SendGuard };

const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
/** sha256 of the request content (not origin / confirm_token / guard). */
export function requestDigest(req: SendRequest): string {
  const body = { source: req.source, mode: req.mode, draft_id: req.draft_id ?? null, ref: sortKeys(req.ref as Record<string, unknown>), text: req.text, event: req.event ? sortKeys(req.event as unknown as Record<string, unknown>) : null };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

const sign = (digest: string, exp: number) => createHmac("sha256", SECRET).update(`${digest}|${exp}`).digest("base64url");

export function issueConfirmToken(req: SendRequest, now = Date.now()): { token: string; expires: number } {
  const exp = now + CONFIRM_TTL_MS;
  return { token: `${exp.toString(36)}.${sign(requestDigest(req), exp)}`, expires: exp };
}

/** Tokens already used for a send (signature → expiry): one confirm = one send. Pruned once expired. */
const spent = new Map<string, number>();
function pruneSpent(now: number): void {
  for (const [sig, exp] of spent) if (exp < now) spent.delete(sig);
}

export function checkConfirmToken(token: string | undefined, req: SendRequest, now = Date.now()): "ok" | "missing" | "expired" | "mismatch" | "invalid" | "spent" {
  if (!token) return "missing";
  const m = /^([0-9a-z]{1,12})\.([\w-]{20,100})$/.exec(token);
  if (!m) return "invalid";
  const exp = parseInt(m[1], 36);
  const want = Buffer.from(sign(requestDigest(req), exp));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "mismatch";
  if (now > exp) return "expired";
  pruneSpent(now);
  return spent.has(m[2]) ? "spent" : "ok";
}

/** A send job was started with this (valid) token: it cannot confirm another one. */
export function spendConfirmToken(token: string | undefined, now = Date.now()): void {
  const m = token ? /^([0-9a-z]{1,12})\.([\w-]{20,100})$/.exec(token) : null;
  if (!m) return;
  pruneSpent(now);
  spent.set(m[2], parseInt(m[1], 36));
}

/** Test helper: forget spent tokens. */
export function _resetSpentTokens(): void {
  spent.clear();
}

const ruleInfo = (m: RuleMatch | null): SendGuard["rule"] => (m ? { index: m.index, effect: m.rule.effect, ...(m.rule.note ? { note: m.rule.note } : {}) } : undefined);

/** A `block` rule for `req` (checked before anything else, synchronously). */
export function blockingRule(req: SendRequest, cfg: Pick<NedConfig, "actions">): RuleMatch | null {
  const m = matchSendRule(req, cfg);
  return m?.rule.effect === "block" ? m : null;
}

/** Decide whether `req` may go now or must be confirmed first. Runs the review (≤ 20s) when it is on. Never throws. */
export async function guardSend(req: SendRequest, cfg: NedConfig, now = Date.now()): Promise<GuardDecision> {
  if (UNRULED_MODES.has(req.mode)) return { kind: "go", guard: {} };
  const target = sendTargetOf(req);
  const m = matchSendRule(req, cfg, target);
  const rule = ruleInfo(m);
  const tok = checkConfirmToken(req.confirm_token, req, now);
  if (tok === "ok") return { kind: "go", guard: { ...(rule ? { rule } : {}), confirmed: true } };
  const reasons = m?.rule.effect === "confirm" ? [ruleReason(m)] : [];
  const review = wantsReview(req, cfg) ? await reviewSend(req, target, cfg) : undefined;
  const guard: SendGuard = { ...(rule ? { rule } : {}), ...(review ? { review } : {}) };
  if (!reasons.length && review?.status !== "issues") return { kind: "go", guard };
  const t = issueConfirmToken(req, now);
  return { kind: "confirm", guard, need: { reasons, ...(review ? { review } : {}), confirm_token: t.token, expires_at: new Date(t.expires).toISOString(), ...(tok !== "missing" ? { token_problem: tok } : {}) } };
}

/** One line for the action log: the reasons and review issues. */
export function needConfirmSummary(n: Pick<NeedConfirm, "reasons" | "review" | "token_problem">): string {
  const parts = [...n.reasons, ...(n.review?.issues ?? []).map((i) => `검토(${i.kind}): ${i.detail}`)];
  if (n.token_problem) parts.push(`확인 토큰 ${n.token_problem === "expired" ? "만료" : n.token_problem === "mismatch" ? "불일치(요청이 바뀜)" : n.token_problem === "spent" ? "이미 사용됨" : "형식 오류"} — 다시 확인`);
  return `확인 필요 — ${parts.join(" · ")}`.slice(0, 600);
}
