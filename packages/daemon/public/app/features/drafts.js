/* Reply-draft modal: POST /api/draft → 3 drafts, edit, regenerate → POST /api/send. */
import { postJson } from "../api.js";
import { init as initActions } from "./actions.js";
import { asksHtml, editMentions, mentionIds, shownText, toggleMentions } from "./draftasks.js";
import { clean, parseDraftAttr } from "./draftref.js";
import { SRC_KEY_RE, reviewAttention, reviewSource } from "./reviewed.js";
import { resumePending, sendAndWait } from "./sendjob.js";
import { renderHeader } from "../main.js";
import { S } from "../state.js";
import { select } from "../tabs/inbox.js";
import { hideModal, showModal, trapTab } from "../ui/modal.js";
import { errBadge, errSummary } from "../ui/popover.js";
import { toast } from "../ui/toast.js";
import { $, esc, safeUrl } from "../util.js";

// ---------- reply drafts: "답장 초안" → POST /api/draft → modal (3 drafts, edit, regenerate) → POST /api/send ----------
// Write actions are opt-in (config.actions); sending ones (Slack 전송 / 메일 보내기 / 세션에 보내기) always ask once more.
export const ACTION_DEFAULTS = { slack_send: false, gmail_draft: true, gmail_send: false, gmail_mark_read: false, session_send: true, jira_comment: false, jira_transition: false, github_review: false, calendar_rsvp: false, calendar_create: false, chat_write: false, chat_session_create: false };
export const ACTION_KO = { slack_send: "Slack 전송", gmail_draft: "Gmail 초안 저장", gmail_send: "메일 보내기", gmail_mark_read: "Gmail 읽음 표시", session_send: "세션에 보내기", jira_comment: "Jira 코멘트", jira_transition: "Jira 상태 변경", github_review: "GitHub 리뷰·코멘트", calendar_rsvp: "캘린더 참석 응답", calendar_create: "캘린더 일정 생성", chat_write: "대화창에서 쓰기 허용", chat_session_create: "대화창에서 세션 만들기" };
export const actionsOn = () => ({ ...ACTION_DEFAULTS, ...(S.config?.actions || {}) });
export const DRAFT_SRC_KO = { slack: "Slack", email: "메일", session: "세션", jira: "Jira 코멘트", github: "PR 리뷰" };
// refs + ✎ button html: features/draftref.js (pure, node-testable) — re-exported for the old import sites.
export { clean, draftBtn, draftFor, mailRef, ORIGIN_KO, sessionRef, slackRef } from "./draftref.js";

export let DR = { open: false };
/**
 * Open the modal for (source, ref). `opts`: origin (card | history | watch — rides to /api/draft and /api/send for the
 * action log), note (a line above the context, e.g. "가장 최근 메시지 기준"), pick ([{source, ref, from, label, att}] — a
 * 팔로업 요약 줄 matching several messages: the modal first lists them, the chosen one gets drafted).
 */
export function openDraft(source, ref, att = "", opts = {}) {
  const pick = Array.isArray(opts.pick) && opts.pick.length ? opts.pick : null;
  DR = { open: true, source, ref: ref || {}, att, origin: opts.origin || "", note: opts.note || "", pick, loading: false, resp: null, tab: null, edits: {}, error: "", confirm: null, sending: null, back: document.activeElement };
  $("dm-hint").value = ""; $("dm-text").value = ""; $("dm-text").dataset.tab = ""; // nothing carries over from the last popup
  showModal($("draft-modal"));
  if (pick) { renderDraft(); $("dm-ctx").querySelector("[data-dpick]")?.focus(); return; }
  requestDraft();
}
/** Pick step → draft the chosen candidate in the same popup. */
export function pickDraft(i) {
  const c = DR.pick?.[i]; if (!c) return;
  DR.source = c.source || DR.source; DR.ref = c.ref || {}; DR.att = c.att || ""; DR.note = c.note || ""; DR.pick = null;
  requestDraft();
}
export function closeDraft() {
  if (!DR.open) return;
  DR.open = false;
  hideModal($("draft-modal"));
  DR.back?.focus?.();
}
export async function requestDraft(hint) {
  DR.loading = true; DR.error = ""; DR.confirm = null; S.drafting = true; renderHeader(); renderDraft();
  const r = await postJson("/api/draft", clean({ source: DR.source, ref: DR.ref, hint: hint || undefined, origin: DR.origin || undefined })).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
  if (!DR.open) { S.drafting = false; renderHeader(); return; }
  if (r.ok && r.data) {
    DR.resp = r.data; DR.tab = (r.data.drafts?.[1] || r.data.drafts?.[0])?.id ?? null; DR.edits = {}; DR.mention = false; DR.mentionAdded = {}; // 멘션 제안 toggle: off by default
    // drafting a reply counts as having looked at it
    if (DR.att && SRC_KEY_RE.test(DR.att)) { if (!(S.agenda?.reviewed || {})[DR.att]) reviewSource(DR.att, true); }
    else { const a = DR.att && S.state?.attention.find((x) => x.id === DR.att); if (a && !a.reviewed_at) reviewAttention(DR.att, true); }
  }
  else {
    DR.error = r.status === 404 ? "초안 API 가 아직 없어 (daemon 업데이트가 필요해)." : `초안을 못 만들었어${r.data?.error ? `: ${r.data.error}` : ` (HTTP ${r.status || "network"})`}.`;
    DR.errWhere = "답장 초안 생성"; DR.errLabel = "초안을 못 만들었어"; DR.errAt = Date.now(); DR.errRetry = () => requestDraft($("dm-hint").value.trim());
  }
  DR.loading = false; S.drafting = false; renderHeader(); renderDraft();
  if (DR.resp) $("dm-text")?.focus();
}
/** Action buttons for the source; `primary` is what ⌘⏎ does. */
export function draftActions() {
  const on = actionsOn(), src = DR.source, list = [{ key: "copy", label: "복사" }];
  if (src === "slack") {
    if (DR.ref.url) list.push({ key: "open", label: "Slack 에서 열기", href: DR.ref.url });
    list.push({ key: "slack_send", label: "Slack 전송", mode: "send", confirm: true });
  } else if (src === "email") {
    if (DR.ref.url) list.push({ key: "open", label: "Gmail 에서 열기", href: DR.ref.url });
    list.push({ key: "gmail_draft", label: "Gmail 초안 저장", mode: "gmail_draft" }, { key: "gmail_send", label: "메일 보내기", mode: "send", confirm: true });
  } else if (src === "session") list.push({ key: "session_send", label: "세션에 보내기", mode: "session", confirm: true });
  else if (src === "jira") {
    if (DR.ref.url) list.push({ key: "open", label: "Jira 에서 열기", href: DR.ref.url });
    list.push({ key: "jira_comment", label: "코멘트 달기", mode: "comment", confirm: true });
  } else if (src === "github") {
    if (DR.ref.url) list.push({ key: "open", label: "GitHub 에서 열기", href: DR.ref.url });
    list.push(
      { key: "gh_review_comment", gate: "github_review", label: "리뷰 코멘트", mode: "review_comment", confirm: true },
      { key: "gh_request_changes", gate: "github_review", label: "변경 요청", mode: "request_changes", confirm: true },
      { key: "gh_approve", gate: "github_review", label: "승인 + 코멘트", mode: "approve", confirm: true },
      { key: "gh_comment", gate: "github_review", label: "PR 코멘트", mode: "comment", confirm: true },
    );
  }
  for (const a of list) { a.gate ||= a.key; a.off = a.mode ? !on[a.gate] : false; }
  const pick = src === "email" ? ["gmail_draft", "gmail_send"] : src === "slack" ? ["slack_send"] : src === "jira" ? ["jira_comment"] : src === "github" ? ["gh_review_comment"] : ["session_send"];
  const primary = list.find((a) => pick.includes(a.key) && !a.off) || list[0];
  primary.primary = true;
  return list;
}
export const curDraft = () => DR.resp?.drafts?.find((d) => d.id === DR.tab) || null;
export const curText = () => (DR.tab in DR.edits ? DR.edits[DR.tab] : shownText(curDraft()?.text || "", mentionIds(DR.resp), !!DR.mention));
/**
 * 멘션 제안 toggle (state transitions: features/draftasks.js toggleMentions / editMentions). Edited texts get the
 * missing mentions (never twice); turning it off strips only what the toggle added — a mention the user typed stays.
 */
export function toggleMention() {
  const ids = mentionIds(DR.resp); if (!ids.length) return;
  const st = toggleMentions({ on: !!DR.mention, edits: DR.edits, added: DR.mentionAdded || {} }, ids);
  DR.mention = st.on; DR.edits = st.edits; DR.mentionAdded = st.added;
  $("dm-text").dataset.tab = ""; // repaint the textarea with the new text
  DR.confirm = null; renderDraft();
}
export function confirmTarget(a) {
  const t = DR.ref.title || "";
  if (DR.source === "jira") return `Jira ${DR.ref.key || t} 에 이 코멘트를 남김`;
  if (DR.source === "github") return `PR ${DR.ref.repo}#${DR.ref.number} 에 ${a.mode === "approve" ? "승인(Approve) 리뷰" : a.mode === "request_changes" ? "변경 요청(Request changes) 리뷰" : a.mode === "comment" ? "일반 코멘트" : "코멘트 리뷰"}로 남김`;
  return DR.source === "slack" ? `Slack ${t} 에 이 내용으로 보냄` : DR.source === "email" ? `메일 회신 보냄: ${t}` : `세션 ${t} 에 입력으로 보냄`;
}
export function renderDraft() {
  if (!DR.open) return;
  const r = DR.resp, ctx = r?.context || {};
  $("dm-title").textContent = `${DR.source === "jira" || DR.source === "github" ? "코멘트 초안" : "답장 초안"} · ${DRAFT_SRC_KO[DR.source] || DR.source}`;
  $("dm-sub").textContent = DR.pick ? "어느 메시지에 답할지 골라 줘" : DR.ref.title || "";
  const note = DR.note ? `<div class="dnote" role="note">ⓘ ${esc(DR.note)}</div>` : "";
  $("dm-ctx").innerHTML = DR.pick ? `<div class="dpick" role="group" aria-label="답할 메시지 후보">${DR.pick.map((c, i) => `<button type="button" class="dpk" data-dpick="${i}"><span class="from">${esc(c.from || "")}</span><span class="tx">${esc(c.label || c.ref?.text || "")}</span></button>`).join("")}</div>`
    : note + (DR.loading ? `<div class="calload"><span class="spin"></span>맥락 읽고 초안 쓰는 중… <span class="hint">보통 10~30초</span></div>`
    : r ? `${ctx.summary ? `<div class="sum">${esc(ctx.summary)}</div>` : ""}${ctx.excerpt ? `<blockquote>${esc(ctx.excerpt)}</blockquote>` : ""}${asksHtml(r, { mentionOn: !!DR.mention })}<div class="mmeta">${r.cached ? "캐시 · " : ""}$${Number(r.cost_usd || 0).toFixed(3)}</div>` : "");
  $("dm-tabs").innerHTML = (r?.drafts || []).map((d) => `<button type="button" class="tab ${d.id === DR.tab ? "on" : ""}" role="tab" aria-selected="${d.id === DR.tab}" data-dtab="${esc(d.id)}">${esc(d.label)}</button>`).join("");
  const ta = $("dm-text");
  if (document.activeElement !== ta || ta.dataset.tab !== String(DR.tab)) { ta.value = curText(); ta.dataset.tab = String(DR.tab); }
  ta.disabled = DR.loading || !r;
  $("dm-regen").disabled = $("dm-hint").disabled = DR.loading || !!DR.pick;
  $("dm-err").innerHTML = DR.error ? errBadge("draft", { where: DR.errWhere || "답장 초안", message: DR.error, at: DR.errAt || Date.now(), retry: DR.errRetry || null, label: DR.errLabel || "실패" }) : "";
  const acts = draftActions();
  $("dm-actions").innerHTML = acts.map((a) => {
    const title = a.off ? `설정 → 쓰기 액션에서 '${ACTION_KO[a.gate]}' 을 허용해야 써` : a.confirm ? "누르면 보낼 대상을 한 번 더 보여 줘" : "";
    const body = DR.sending === a.key ? `<span class="spin"></span> <span data-dsend-el>${sendingText()}</span>` : `${esc(a.label)}${a.primary ? ` <kbd>⌘⏎</kbd>` : ""}`;
    if (a.href) return `<a class="btn" href="${esc(safeUrl(a.href) || "#")}" target="_blank" rel="noopener">${body}</a>`;
    return `<button type="button" class="btn${a.primary ? " go" : ""}${a.off ? " dis" : ""}" data-dact="${a.key}" aria-disabled="${a.off}" title="${esc(title)}" ${!r || DR.loading || DR.sending ? "disabled" : ""}>${body}</button>`;
  }).join("");
  const c = DR.confirm ? acts.find((a) => a.key === DR.confirm) : null;
  $("dm-confirm").hidden = !c;
  if (c) $("dm-confirm").innerHTML = `<div class="tgt">⚠️ ${esc(confirmTarget(c))}</div><div class="pv">${esc(curText().slice(0, 160))}${curText().length > 160 ? "…" : ""}</div>
      <button type="button" class="btn go" data-dconfirm="1">확인 — ${esc(c.label)} <kbd>⌘⏎</kbd></button><button type="button" class="btn" data-dcancel="1">취소 <kbd>Esc</kbd></button>`;
}
export async function copyDraft() {
  const t = $("dm-text").value;
  try { await navigator.clipboard.writeText(t); }
  catch { const ta = $("dm-text"); ta.disabled = false; ta.select(); document.execCommand("copy"); }
  toast("초안을 클립보드에 복사했어.");
}
const sendingText = () => `전송 중 ${Math.floor((DR.sendElapsed || 0) / 1000)}s`;
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return Number.isFinite(m) ? (m < 1 ? "방금" : `${m}분 전`) : ""; };
/** One-line outcome of a finished send, for a toast (popup closed) or the popup's error line. */
function sendOutcome(label, r) {
  if (r.ok && r.data?.ok !== false) return { ok: true, msg: r.data?.detail || `${label} 완료.` };
  if (r.status === 409 && r.data?.already_sent) return { ok: true, msg: `이미 보냈어 (${ago(r.data.sent_at)})${r.data.link ? ` — ${r.data.link}` : ""}` };
  const msg = r.status === 403 ? `'${label}' 은 설정에서 꺼져 있어 (daemon 이 거절함, HTTP 403).`
    : r.unknown ? `${label} 결과 확인 못 함: ${r.data?.error || "알 수 없음"}`
    : `${label} 실패: ${r.data?.detail || r.data?.error || `HTTP ${r.status || "network"}`}`;
  return { ok: false, msg };
}
/**
 * Send = a daemon job (features/sendjob.js): 202 → poll every 2s, the button counts up ("전송 중 34s"), max 4 min.
 * Closing the popup (Esc) doesn't stop it — the outcome comes back as a toast. Retry is offered only when the daemon
 * reported a failure; an unknown outcome (restart, 4-min deadline) never re-sends on its own.
 */
export async function runAction(key) {
  const a = draftActions().find((x) => x.key === key); if (!a) return;
  if (a.key === "copy") return copyDraft();
  if (a.off) { toast(`설정 → 쓰기 액션에서 '${ACTION_KO[a.gate]}' 을 허용해야 해.`); return; }
  if (a.confirm && DR.confirm !== a.key) { DR.confirm = a.key; renderDraft(); $("dm-confirm").querySelector("[data-dconfirm]")?.focus(); return; }
  const d = DR; // this popup; a later openDraft() replaces DR
  d.confirm = null; d.sending = a.key; d.sendElapsed = 0; d.error = ""; renderDraft();
  const r = await sendAndWait(clean({ draft_id: curDraft()?.id, source: d.source, ref: d.ref, text: $("dm-text").value, mode: a.mode, origin: d.origin || undefined }), {
    label: a.label,
    onTick: (ms) => { d.sendElapsed = ms; if (DR === d && d.open) { const el = $("dm-actions").querySelector("[data-dsend-el]"); if (el) el.textContent = sendingText(); } },
  });
  d.sending = null;
  const o = sendOutcome(a.label, r);
  if (DR !== d || !d.open) { toast(o.ok ? `${a.label} 완료 — ${o.msg}` : o.msg, o.ok ? 6000 : 9000); return; } // popup closed meanwhile
  if (o.ok) { toast(o.msg, 5000); closeDraft(); return; }
  d.error = o.msg;
  d.errWhere = a.label; d.errLabel = r.unknown ? `${a.label} 결과 모름` : `${a.label} 실패`; d.errAt = Date.now();
  d.errRetry = r.status === 403 || r.unknown ? null : () => runAction(key); // retry only on a failure the daemon confirmed
  toast(`${d.errLabel} — ${errSummary(d.error)}`, 6000); renderDraft();
}

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  // a send that was still running when the page went away: report how it ended (never re-sends)
  resumePending((p, r) => { const o = sendOutcome(p.label || "보내기", r); toast(o.ok ? `${p.label || "보내기"} 완료 — ${o.msg}` : o.msg, 9000); });
  initActions(); // ⋯ item actions (features/actions.js) — main.js's init list belongs to another module
  $("draft-modal").addEventListener("click", (e) => {
    if (e.target === $("draft-modal") || e.target.closest("[data-mclose]")) return closeDraft();
    const pk = e.target.closest("[data-dpick]"); if (pk) return pickDraft(Number(pk.dataset.dpick));
    if (e.target.closest("[data-dmention]")) return toggleMention();
    const t = e.target.closest("[data-dtab]"); if (t) { DR.tab = t.dataset.dtab; DR.confirm = null; renderDraft(); return; }
    const a = e.target.closest("[data-dact]"); if (a) return runAction(a.dataset.dact);
    if (e.target.closest("[data-dconfirm]")) return runAction(DR.confirm);
    if (e.target.closest("[data-dcancel]")) { DR.confirm = null; renderDraft(); }
  });
  $("dm-text").addEventListener("input", (e) => {
    // first edit of a tab while the toggle is on records the mentions it shows as the toggle's (stripped on off)
    if (DR.tab != null) {
      const st = editMentions({ on: !!DR.mention, edits: DR.edits, added: DR.mentionAdded || {} }, DR.tab, e.target.value, curDraft()?.text || "", mentionIds(DR.resp));
      DR.edits = st.edits; DR.mentionAdded = st.added;
    }
    if (DR.confirm) { DR.confirm = null; renderDraft(); } });
  $("dm-regen").addEventListener("click", () => requestDraft($("dm-hint").value.trim()));
  $("dm-hint").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); requestDraft(e.target.value.trim()); } });
  // Modal keys win over page shortcuts: Esc closes (or backs out of the confirm step), ⌘⏎ / Ctrl⏎ runs the primary action.
  document.addEventListener("keydown", (e) => {
    if (!DR.open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (DR.confirm) { DR.confirm = null; renderDraft(); } else closeDraft(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (DR.loading || DR.sending || !DR.resp) return;
      runAction(DR.confirm || draftActions().find((a) => a.primary).key);
      return;
    }
    trapTab($("draft-modal"), e); // keep focus inside the dialog
  }, true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".drb[data-draft]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const d = parseDraftAttr(b.dataset.draft);
    if (!d) { console.warn("draft ref", b.dataset.draft); return; }
    openDraft(d.source, d.ref, b.dataset.att || "", { origin: d.origin, note: d.note, pick: d.pick });
  }, true);
}
