/* 확인 완료 keys for source items (no attention id) + the ✓ button / fold — pure (no DOM at import), so node tests can
 * render rows that carry a ✓. reviewed.js re-exports everything here and owns the POST + click handling. */
import { S, ui } from "../state.js";
import { iconBtn, reviewIcon } from "../ui/icons.js";
import { esc } from "../util.js";

// ---- Copy of src/review-keys.ts (the single definition) — test/review-keys-shared.test.ts runs both on the same fixtures. ----
// Keys: mail:<thread> · slack:<channel>:<message ts> (permalink only, never thread metadata) · jira:<KEY> · github:<repo>#<n>.
// A mark (ms) counts while it is at or after the item's last change (activityMs): mail received · jira/github updated ·
// slack max(row ts, thread.last_reply_ts, thread.search_latest_ts). Old `slack:<ch>:<ts>@<x>` marks fold into the base key.
export const SRC_KEY_RE = /^(mail|slack|jira|github):/;
const SLACK_LINK_RE = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/;
const OLD_SLACK_KEY_RE = /^(slack:[A-Z0-9]+:\d+\.\d+)@[^\s]*$/;
export function tsMs(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const t = String(v ?? "").trim();
  if (!t) return 0;
  if (/^\d{9,11}(\.\d+)?$/.test(t)) return Number(t) * 1000;
  return Date.parse(t) || 0;
}
export function slackReviewKey(x) {
  const url = x?.url || "";
  const m = SLACK_LINK_RE.exec(url);
  if (!m) return url ? `slack:${url}` : "";
  return `slack:${m[1]}:${m[2]}.${m[3]}`;
}
export function srcKey(kind, x) {
  if (!x) return "";
  // Gmail view URLs look like #all/<hex> or #all/thread-f:<n> — keep everything after the folder, not just the first word.
  if (kind === "email") { const t = x.id || /#[\w-]+\/([^|?&#\s]+)/.exec(x.url || "")?.[1]; return t ? `mail:${t}` : ""; }
  if (kind === "slack") return slackReviewKey(x);
  if (kind === "jira") { const k = x.key || /\/browse\/([A-Z][A-Z0-9_]*-\d+)/.exec(x.url || "")?.[1]; return k ? `jira:${k}` : ""; }
  if (kind === "github") {
    if (x.repo && x.number) return `github:${x.repo}#${x.number}`;
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/.exec(x.url || ""); return m ? `github:${m[1]}#${m[2]}` : "";
  }
  return "";
}
export function activityMs(kind, x) {
  if (!x) return 0;
  if (kind === "slack") return Math.max(tsMs(x.ts), tsMs(x.thread?.last_reply_ts), tsMs(x.thread?.search_latest_ts));
  if (kind === "email") return tsMs(x.received || x.ts);
  if (kind === "jira" || kind === "github") return tsMs(x.updated || x.ts);
  return tsMs(x.received || x.ts || x.updated);
}
export function reviewedAt(marks, key, actMs) {
  const at = key ? Number(marks?.[key]) || 0 : 0;
  return at && at >= actMs ? at : 0;
}
export function foldReviewMarks(marks) {
  const out = {};
  for (const [k, v] of Object.entries(marks ?? {})) {
    const at = Number(v) || 0;
    const base = OLD_SLACK_KEY_RE.exec(k)?.[1] ?? k;
    if (!(base in out) || at > out[base]) out[base] = at;
  }
  return out;
}
// ---- end of the copy ----

/** Kept for callers: the item's last change (ms) — slack rows need their kind, so this is the generic fallback. */
export const itemMs = (x) => tsMs(x.received || x.ts || x.updated || 0);
// /api/agenda already folds old keys (state.ts readReviewed); folding again here keeps an older daemon's answer working.
let foldedFrom = null, folded = {};
const marksNow = () => { const m = S.agenda?.reviewed || {}; if (m !== foldedFrom) { foldedFrom = m; folded = foldReviewMarks(m); } return folded; };
/** The mark covering `x` under `key` (ms), else 0. `kind` picks the item's last-change field (default: generic). */
export const srcRevAt = (key, x, kind = "") => reviewedAt(marksNow(), key, kind ? activityMs(kind, x) : itemMs(x));
export const revAt = (kind, x) => srcRevAt(srcKey(kind, x), x, kind);
export const isOpenSrc = (kind) => (x) => !revAt(kind, x);
export const revCls = (kind, x) => (revAt(kind, x) ? " reviewed" : "");
/** ✓ for a row; a row with no key (unparsable link) gets a disabled ✓ instead of none, so the gap is visible. */
export const NO_KEY_TITLE = "확인 키 없음";
export const srcCheck = (kind, x) => {
  const k = srcKey(kind, x);
  return k ? reviewIcon({ id: k, reviewed_at: srcRevAt(k, x, kind) }) : iconBtn("check", NO_KEY_TITLE, { attrs: `disabled aria-disabled="true" data-review-nokey="1"`, cls: "nokey" });
};
/** A card list: open items, then a folded "확인 완료 N" with the reviewed ones (click the check again to bring one back). */
export function withFold(cardId, kind, list, rowFn) {
  const open = [], rev = [];
  for (const x of list) (revAt(kind, x) ? rev : open).push(x);
  if (!rev.length) return open.map(rowFn).join("");
  return open.map(rowFn).join("") + `${open.length ? "" : `<div class="gnone">열린 항목 없음.</div>`}<details class="rvfold" data-rv="${esc(cardId)}" ${ui.revCard?.[cardId] ? "open" : ""}><summary>확인 완료 ${rev.length}</summary>${rev.map(rowFn).join("")}</details>`;
}
/**
 * Optimistic ✓: new marks object with `key` set (now) or removed, plus an undo that restores the previous value — pure,
 * so the rollback-on-failure path is unit-testable. Returns null for an empty / non-source key (nothing to send).
 */
export function applyReviewMark(marks, key, reviewed, now = Date.now()) {
  if (!key || !SRC_KEY_RE.test(key)) return null;
  const had = Object.prototype.hasOwnProperty.call(marks || {}, key), prev = marks?.[key];
  const next = { ...(marks || {}) };
  if (reviewed) next[key] = now; else delete next[key];
  const undo = (cur) => { const r = { ...(cur || {}) }; if (had) r[key] = prev; else delete r[key]; return r; };
  return { next, undo };
}
