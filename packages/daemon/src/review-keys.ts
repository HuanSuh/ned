/**
 * 확인 완료 (✓) keys and the "changed since the mark → open again" rule for source items — the single definition.
 * The dashboard (public/app/features/revkeys.js) carries a line-for-line copy; test/review-keys-shared.test.ts runs
 * both against the same fixtures, so a change here must be made there too.
 *
 * Keys: mail:<thread id> · slack:<channel>:<message ts> (from the permalink; never thread metadata) · jira:<KEY> ·
 * github:<repo>#<n>. A mark (ms) counts while it is at or after the item's last change (activityMs):
 *  - mail: received (else ts) · jira / github: updated (else ts)
 *  - slack: max(row ts, thread.last_reply_ts, thread.search_latest_ts) — a new reply / phase-1 hit after the mark
 *    reopens the row; metadata that only moved backwards or sideways doesn't.
 * Old marks `slack:<ch>:<ts>@<reply ts>` (thread-aware keys before this rule) fold into `slack:<ch>:<ts>` (largest mark).
 *
 * Pure — no imports, no I/O.
 */

export type Marks = Record<string, number>;
export type ReviewKind = "email" | "slack" | "jira" | "github";

/** Any source-item review key prefix. */
export const SRC_KEY_RE = /^(mail|slack|jira|github):/;
const SLACK_LINK_RE = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/;
/** Old thread-aware Slack key: `slack:<ch>:<ts>@<reply ts>`. */
const OLD_SLACK_KEY_RE = /^(slack:[A-Z0-9]+:\d+\.\d+)@[^\s]*$/;

/** Slack ts ("1730860000.123456"), ISO or epoch ms → epoch ms (0 when none). */
export function tsMs(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const t = String(v ?? "").trim();
  if (!t) return 0;
  if (/^\d{9,11}(\.\d+)?$/.test(t)) return Number(t) * 1000;
  return Date.parse(t) || 0;
}

/** `slack:<channel>:<message ts>` from the permalink; an odd permalink is its own key; no url → "". */
export function slackReviewKey(x: { url?: string } | null | undefined): string {
  const url = x?.url || "";
  const m = SLACK_LINK_RE.exec(url);
  if (!m) return url ? `slack:${url}` : "";
  return `slack:${m[1]}:${m[2]}.${m[3]}`;
}

type Item = {
  id?: string; url?: string; key?: string; repo?: string; number?: number | string;
  received?: unknown; ts?: unknown; updated?: unknown;
  thread?: { last_reply_ts?: string; search_latest_ts?: string } | null;
};

/** The ✓ key of a card / history / 팔로업 row ("" = none: the ✓ is disabled). */
export function srcKey(kind: string, x: Item | null | undefined): string {
  if (!x) return "";
  if (kind === "email") { const t = x.id || /#[\w-]+\/([^|?&#\s]+)/.exec(x.url || "")?.[1]; return t ? `mail:${t}` : ""; }
  if (kind === "slack") return slackReviewKey(x);
  if (kind === "jira") { const k = x.key || /\/browse\/([A-Z][A-Z0-9_]*-\d+)/.exec(x.url || "")?.[1]; return k ? `jira:${k}` : ""; }
  if (kind === "github") {
    if (x.repo && x.number) return `github:${x.repo}#${x.number}`;
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/.exec(x.url || ""); return m ? `github:${m[1]}#${m[2]}` : "";
  }
  return "";
}

/** The item's last change (ms) — what a ✓ mark must be at or after to keep it closed. */
export function activityMs(kind: string, x: Item | null | undefined): number {
  if (!x) return 0;
  if (kind === "slack") return Math.max(tsMs(x.ts), tsMs(x.thread?.last_reply_ts), tsMs(x.thread?.search_latest_ts));
  if (kind === "email") return tsMs(x.received || x.ts);
  if (kind === "jira" || kind === "github") return tsMs(x.updated || x.ts);
  return tsMs(x.received || x.ts || x.updated);
}

/** The mark (ms) when it still covers the item (at ≥ its last change), else 0. */
export function reviewedAt(marks: Marks | null | undefined, key: string, actMs: number): number {
  const at = key ? Number(marks?.[key]) || 0 : 0;
  return at && at >= actMs ? at : 0;
}

/** Old `slack:<ch>:<ts>@<x>` keys → `slack:<ch>:<ts>` (largest mark wins); everything else as is. */
export function foldReviewMarks(marks: Marks | null | undefined): Marks {
  const out: Marks = {};
  for (const [k, v] of Object.entries(marks ?? {})) {
    const at = Number(v) || 0;
    const base = OLD_SLACK_KEY_RE.exec(k)?.[1] ?? k;
    if (!(base in out) || at > out[base]) out[base] = at;
  }
  return out;
}

/** An incoming review key, canonical: old `@…` Slack keys lose the suffix. */
export const normalizeReviewKey = (k: string): string => OLD_SLACK_KEY_RE.exec(k)?.[1] ?? k;
