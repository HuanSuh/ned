/* 확인 완료 keys for source items (no attention id) + the ✓ button / fold — pure (no DOM at import), so node tests can
 * render rows that carry a ✓. reviewed.js re-exports everything here and owns the POST + click handling. */
import { S, ui } from "../state.js";
import { reviewIcon } from "../ui/icons.js";
import { esc, toMs } from "../util.js";

// Stable keys per source, marks come with /api/agenda (`reviewed`). An item that changed after the mark (newer
// received / ts / updated) counts as open again. Cards, 지난 N일 이력 rows and search share these keys.
export const SRC_KEY_RE = /^(mail|slack|jira|github):/;
export function srcKey(kind, x) {
  if (!x) return "";
  // Gmail view URLs look like #all/<hex> or #all/thread-f:<n> — keep everything after the folder, not just the first word.
  if (kind === "email") { const t = x.id || /#[\w-]+\/([^|?&#\s]+)/.exec(x.url || "")?.[1]; return t ? `mail:${t}` : ""; }
  if (kind === "slack") {
    const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(x.url || "");
    if (!m) return x.url ? `slack:${x.url}` : ""; // odd permalinks: the link itself is the stable key
    // Followed thread: the key carries its latest reply, so a newer reply makes the row open (미확인) again.
    const base = `slack:${m[1]}:${m[2]}.${m[3]}`, lr = x.thread?.last_reply_ts;
    return lr && lr !== `${m[2]}.${m[3]}` ? `${base}@${lr}` : base;
  }
  if (kind === "jira") { const k = x.key || /\/browse\/([A-Z][A-Z0-9_]*-\d+)/.exec(x.url || "")?.[1]; return k ? `jira:${k}` : ""; }
  if (kind === "github") {
    if (x.repo && x.number) return `github:${x.repo}#${x.number}`;
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/.exec(x.url || ""); return m ? `github:${m[1]}#${m[2]}` : "";
  }
  return "";
}
export const itemMs = (x) => toMs(x.received || x.ts || x.updated || 0);
export const srcRevAt = (key, x) => {
  const marks = S.agenda?.reviewed || {};
  let at = key ? marks[key] : 0;
  // A mark made before the thread was followed (key without `@…`) still counts if it came after the latest reply.
  if (!at && key.includes("@")) { const b = marks[key.split("@")[0]], lr = Number(key.split("@")[1]) * 1000; if (b && b >= lr) at = b; }
  return at && at >= itemMs(x) ? at : 0;
};
export const revAt = (kind, x) => srcRevAt(srcKey(kind, x), x);
export const isOpenSrc = (kind) => (x) => !revAt(kind, x);
export const revCls = (kind, x) => (revAt(kind, x) ? " reviewed" : "");
export const srcCheck = (kind, x) => { const k = srcKey(kind, x); return k ? reviewIcon({ id: k, reviewed_at: srcRevAt(k, x) }) : ""; };
/** A card list: open items, then a folded "확인 완료 N" with the reviewed ones (click the check again to bring one back). */
export function withFold(cardId, kind, list, rowFn) {
  const open = [], rev = [];
  for (const x of list) (revAt(kind, x) ? rev : open).push(x);
  if (!rev.length) return open.map(rowFn).join("");
  return open.map(rowFn).join("") + `${open.length ? "" : `<div class="gnone">열린 항목 없음.</div>`}<details class="rvfold" data-rv="${esc(cardId)}" ${ui.revCard?.[cardId] ? "open" : ""}><summary>확인 완료 ${rev.length}</summary>${rev.map(rowFn).join("")}</details>`;
}
