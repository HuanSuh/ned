/* 확인 완료 (reviewed) marks for attention items and source items. */
import { api } from "../api.js";
import { loadState, renderAll } from "../main.js";
import { S, ui } from "../state.js";
import { reviewIcon } from "../ui/icons.js";
import { toast } from "../ui/toast.js";
import { esc, toMs } from "../util.js";
/** attention items not marked 확인 완료 (counts, badges, greeting). */
export const openAtt = () => (S.state?.attention || []).filter((a) => !a.reviewed_at);
// 확인 완료 for source items (no attention id): stable keys per source, marks come with /api/agenda (`reviewed`).
// An item that changed after the mark (newer received / ts / updated) counts as open again.
export const SRC_KEY_RE = /^(mail|slack|jira|github):/;
export function srcKey(kind, x) {
  if (!x) return "";
  // Gmail view URLs look like #all/<hex> or #all/thread-f:<n> — keep everything after the folder, not just the first word.
  if (kind === "email") { const t = x.id || /#[\w-]+\/([^|?&#\s]+)/.exec(x.url || "")?.[1]; return t ? `mail:${t}` : ""; }
  if (kind === "slack") {
    const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(x.url || "");
    return m ? `slack:${m[1]}:${m[2]}.${m[3]}` : x.url ? `slack:${x.url}` : ""; // odd permalinks: the link itself is the stable key
  }
  if (kind === "jira") { const k = x.key || /\/browse\/([A-Z][A-Z0-9_]*-\d+)/.exec(x.url || "")?.[1]; return k ? `jira:${k}` : ""; }
  if (kind === "github") {
    if (x.repo && x.number) return `github:${x.repo}#${x.number}`;
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/.exec(x.url || ""); return m ? `github:${m[1]}#${m[2]}` : "";
  }
  return "";
}
export const itemMs = (x) => toMs(x.received || x.ts || x.updated || 0);
export const srcRevAt = (key, x) => { const at = key ? (S.agenda?.reviewed || {})[key] : 0; return at && at >= itemMs(x) ? at : 0; };
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
export async function reviewSource(key, reviewed) {
  S.agenda = S.agenda || {}; S.agenda.reviewed = { ...(S.agenda.reviewed || {}) };
  if (reviewed) S.agenda.reviewed[key] = Date.now(); else delete S.agenda.reviewed[key];
  renderAll();
  try { await api(`/api/attention/${encodeURIComponent(key)}/review`, { method: "POST", body: JSON.stringify({ reviewed }) }); }
  catch (e) { console.warn(e); toast(`확인 표시 실패 — ${e.message}`); }
}
export async function reviewAttention(id, reviewed) {
  const a = S.state?.attention.find((x) => x.id === id); if (!a) return;
  a.reviewed_at = reviewed ? Date.now() : undefined; // optimistic
  renderAll();
  try { await api(`/api/attention/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ reviewed }) }); }
  catch (e) { console.warn(e); toast(`확인 표시 실패: ${e.message}`); }
  await loadState();
}

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-review]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (SRC_KEY_RE.test(b.dataset.review)) return reviewSource(b.dataset.review, b.getAttribute("aria-pressed") !== "true");
    const a = S.state?.attention.find((x) => x.id === b.dataset.review);
    reviewAttention(b.dataset.review, !a?.reviewed_at);
  }, true);
  // icons inside an inbox row act on their own (no row select / detail open)
  document.addEventListener("click", (e) => { if (e.target.closest("#items .row .ib")) e.stopPropagation(); }, true);
}
