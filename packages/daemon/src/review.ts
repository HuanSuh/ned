/**
 * 확인 완료 (✓) toggle — the one implementation behind POST /api/attention/:id/review and the MCP tool
 * ned_mark_reviewed (src/mcp-tools.ts). Same validation, same side effects (Slack thread seen mark, Gmail mark-read).
 */
import { patchAgenda } from "./agenda.js";
import { loadConfig } from "./config.js";
import { onMailReviewed, type MarkReadOutcome } from "./mail-read.js";
import { log } from "./paths.js";
import { SRC_KEY_RE, normalizeReviewKey } from "./review-keys.js";
import { markThreadSeen } from "./slack-threads.js";
import { SOURCE_KEY, readState, setReviewed } from "./state.js";

export type ReviewResult =
  | { status: 200; body: { ok: true; id: string; reviewed_at: number | null; attention_open_count: number; mark_read?: MarkReadOutcome } }
  | { status: 400 | 404; body: { error: string } };

/** Mark (reviewed=true) or unmark an attention id / source key. 400 malformed key, 404 unknown attention id. */
export async function reviewItem(rawId: string, reviewed: boolean): Promise<ReviewResult> {
  // Old thread-aware Slack keys (`…@<reply ts>`) are stored under their base key (review-keys.ts).
  const id = normalizeReviewKey(rawId.trim());
  // A source prefix with an empty / malformed rest (a row whose key couldn't be built) is a client bug, not a lookup.
  if (!id || (SRC_KEY_RE.test(id) && !SOURCE_KEY.test(id))) return { status: 400, body: { error: "bad review key" } };
  // Source items (mail: / slack: / jira: / github:) have no attention entry; their key is stable across agenda runs.
  if (!SOURCE_KEY.test(id) && !readState().attention.some((a) => a.id === id)) return { status: 404, body: { error: "not found" } };
  const at = setReviewed(id, reviewed);
  // Slack: the thread remembers the mark time as seen_reply_ts; only a message after it reopens it (same as the ✓ rule).
  if (id.startsWith("slack:")) try { patchAgenda((a) => void markThreadSeen(a.slack, id, reviewed, at ?? Date.now())); } catch (e) { log(`review: thread seen mark failed — ${String(e).slice(0, 200)}`); }
  // Mail + config.actions.gmail_mark_read: also mark the thread read in Gmail (background job; un-review never re-marks unread).
  let mark_read: MarkReadOutcome | null = null;
  if (reviewed && id.startsWith("mail:")) try { mark_read = await onMailReviewed(id, loadConfig()); } catch (e) { log(`review: gmail mark-read failed — ${String(e).slice(0, 200)}`); }
  return { status: 200, body: { ok: true, id, reviewed_at: at, attention_open_count: readState().attention_open_count, ...(mark_read ? { mark_read } : {}) } };
}
