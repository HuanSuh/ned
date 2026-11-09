/* 확인 완료 (reviewed) marks for attention items and source items. */
import { api } from "../api.js";
import { loadState, renderAll } from "../main.js";
import { S } from "../state.js";
import { waitJob } from "./sendjob.js";
import { toast } from "../ui/toast.js";
/** attention items not marked 확인 완료 (counts, badges, greeting). */
export const openAtt = () => (S.state?.attention || []).filter((a) => !a.reviewed_at);
// 확인 완료 keys / ✓ / fold for source items live in features/revkeys.js (pure, node-testable).
export { SRC_KEY_RE, isOpenSrc, itemMs, revAt, revCls, srcCheck, srcKey, srcRevAt, withFold } from "./revkeys.js";
/** Optimistic Gmail 읽음 표시: the thread's row in mail.all → read, 안 읽은 count −1 (the next mail refresh sets the real values). */
export function markThreadReadLocal(agenda, threadId) {
  const m = agenda?.mail, row = m?.all?.find((x) => x.id === threadId);
  if (!row || !row.unread) return false;
  row.unread = false;
  m.unread = Math.max(0, (Number(m.unread) || 0) - 1);
  return true;
}
/** Background Gmail 읽음 표시 (config.actions.gmail_mark_read): only a failure is worth a toast — 확인 완료 stays either way. */
async function followMarkRead(mr, threadId) {
  if (mr.skipped === "budget") { toast("Gmail 읽음 표시 생략 — 오늘 예산을 다 썼어 (확인 완료는 저장됨)", 6000); return; }
  if (mr.skipped === "invalid") { toast(`Gmail 읽음 표시 실패 — ${mr.detail || "스레드 id 를 알 수 없음"}`, 7000); return; }
  if (!mr.job_id) return; // "already": marked read in the last 10 min
  const r = await waitJob({ job_id: mr.job_id, started_at: mr.started_at, source: "email", mode: "mark_read", ref: { thread_id: threadId } });
  if (!r.ok) toast(`Gmail 읽음 표시 실패 — ${r.data?.error || r.data?.detail || "알 수 없는 오류"}`, 8000);
}
export async function reviewSource(key, reviewed) {
  S.agenda = S.agenda || {}; S.agenda.reviewed = { ...(S.agenda.reviewed || {}) };
  if (reviewed) S.agenda.reviewed[key] = Date.now(); else delete S.agenda.reviewed[key];
  // 확인 해제 never marks the mail unread again in Gmail (or here).
  const markRead = reviewed && key.startsWith("mail:") && S.config?.actions?.gmail_mark_read === true;
  if (markRead) markThreadReadLocal(S.agenda, key.slice(5));
  renderAll();
  let r = null;
  try { r = await api(`/api/attention/${encodeURIComponent(key)}/review`, { method: "POST", body: JSON.stringify({ reviewed }) }); }
  catch (e) { console.warn(e); toast(`확인 표시 실패 — ${e.message}`); return; }
  if (r?.mark_read) followMarkRead(r.mark_read, key.slice(5)).catch((e) => console.warn("mark-read", e));
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
