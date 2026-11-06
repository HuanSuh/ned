/* Reply-draft modal: POST /api/draft → 3 drafts, edit, regenerate → POST /api/send. */
import { postJson } from "../api.js";
import { axBtn, init as initActions } from "./actions.js";
import { SRC_KEY_RE, reviewAttention, reviewSource } from "./reviewed.js";
import { resumePending, sendAndWait } from "./sendjob.js";
import { renderHeader } from "../main.js";
import { S } from "../state.js";
import { select } from "../tabs/inbox.js";
import { iconBtn } from "../ui/icons.js";
import { hideModal, showModal, trapTab } from "../ui/modal.js";
import { errBadge, errSummary } from "../ui/popover.js";
import { toast } from "../ui/toast.js";
import { $, esc, safeUrl } from "../util.js";

// ---------- reply drafts: "답장 초안" → POST /api/draft → modal (3 drafts, edit, regenerate) → POST /api/send ----------
// Write actions are opt-in (config.actions); sending ones (Slack 전송 / 메일 보내기 / 세션에 보내기) always ask once more.
export const ACTION_DEFAULTS = { slack_send: false, gmail_draft: true, gmail_send: false, session_send: true, jira_comment: false, jira_transition: false, github_review: false, calendar_rsvp: false, calendar_create: false };
export const ACTION_KO = { slack_send: "Slack 전송", gmail_draft: "Gmail 초안 저장", gmail_send: "메일 보내기", session_send: "세션에 보내기", jira_comment: "Jira 코멘트", jira_transition: "Jira 상태 변경", github_review: "GitHub 리뷰·코멘트", calendar_rsvp: "캘린더 참석 응답", calendar_create: "캘린더 일정 생성" };
export const actionsOn = () => ({ ...ACTION_DEFAULTS, ...(S.config?.actions || {}) });
export const DRAFT_SRC_KO = { slack: "Slack", email: "메일", session: "세션", jira: "Jira 코멘트", github: "PR 리뷰" };
export const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
/** ref for a Slack message: channel id + ts (+ thread_ts) from its permalink. */
export function slackRef(x) {
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(x.url || ""), tt = /[?&]thread_ts=([\d.]+)/.exec(x.url || "");
  // Followed thread (agenda slack.threads): reply into it, and let /api/draft use its latest excerpt.
  const key = m ? `${m[1]}:${tt?.[1] || `${m[2]}.${m[3]}`}` : "";
  const th = x.thread || (key && (S.agenda?.slack?.threads || []).find((t) => t.key === key));
  const thread_ts = tt?.[1] || (th && th.reply_count > 0 ? th.thread_ts : undefined);
  return clean({ url: x.url, channel: m?.[1] || x.channel, ts: m ? `${m[2]}.${m[3]}` : undefined, thread_ts, title: [x.channel, x.from].filter(Boolean).join(" · ") || x.title, text: x.text || x.detail });
}
export const mailRef = (x) => clean({ url: x.url, thread_id: x.id || /#[\w-]+\/([^|?&#\s]+)/.exec(x.url || "")?.[1], title: [x.subject || x.title, x.from].filter(Boolean).join(" — "), text: x.why || x.snippet || x.detail });
export const sessionRef = (x) => clean({ session_id: x.id, title: x.worktree, text: x.last_summary || (x.last_prompt ? "» " + x.last_prompt : "") });
/** Button that opens the draft modal; `small` for list rows. */
export const draftBtn = (source, ref, att = "") => iconBtn("draft", "답장 초안 — Ned 가 3가지 말투로 써 줘", { cls: "drb", attrs: `data-draft="${esc(JSON.stringify({ source, ref }))}"${att ? ` data-att="${esc(att)}"` : ""}` });
export const draftFor = (kind, item, att = "") => (kind === "slack" ? draftBtn("slack", slackRef(item), att) : kind === "email" ? draftBtn("email", mailRef(item), att) : kind === "jira" || kind === "github" || kind === "calendar" ? axBtn(kind, item) : "");

export let DR = { open: false };
export function openDraft(source, ref, att = "") {
  DR = { open: true, source, ref, att, loading: false, resp: null, tab: null, edits: {}, error: "", confirm: null, sending: null, back: document.activeElement };
  $("dm-hint").value = ""; $("dm-text").value = ""; $("dm-text").dataset.tab = ""; // nothing carries over from the last popup
  showModal($("draft-modal"));
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
  const r = await postJson("/api/draft", clean({ source: DR.source, ref: DR.ref, hint: hint || undefined })).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
  if (!DR.open) { S.drafting = false; renderHeader(); return; }
  if (r.ok && r.data) {
    DR.resp = r.data; DR.tab = (r.data.drafts?.[1] || r.data.drafts?.[0])?.id ?? null; DR.edits = {};
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
export const curText = () => (DR.tab in DR.edits ? DR.edits[DR.tab] : curDraft()?.text || "");
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
  $("dm-sub").textContent = DR.ref.title || "";
  $("dm-ctx").innerHTML = DR.loading ? `<div class="calload"><span class="spin"></span>맥락 읽고 초안 쓰는 중… <span class="hint">보통 10~30초</span></div>`
    : r ? `${ctx.summary ? `<div class="sum">${esc(ctx.summary)}</div>` : ""}${ctx.excerpt ? `<blockquote>${esc(ctx.excerpt)}</blockquote>` : ""}<div class="mmeta">${r.cached ? "캐시 · " : ""}$${Number(r.cost_usd || 0).toFixed(3)}</div>` : "";
  $("dm-tabs").innerHTML = (r?.drafts || []).map((d) => `<button type="button" class="tab ${d.id === DR.tab ? "on" : ""}" role="tab" aria-selected="${d.id === DR.tab}" data-dtab="${esc(d.id)}">${esc(d.label)}</button>`).join("");
  const ta = $("dm-text");
  if (document.activeElement !== ta || ta.dataset.tab !== String(DR.tab)) { ta.value = curText(); ta.dataset.tab = String(DR.tab); }
  ta.disabled = DR.loading || !r;
  $("dm-regen").disabled = $("dm-hint").disabled = DR.loading;
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
  const r = await sendAndWait({ draft_id: curDraft()?.id, source: d.source, ref: d.ref, text: $("dm-text").value, mode: a.mode }, {
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
    const t = e.target.closest("[data-dtab]"); if (t) { DR.tab = t.dataset.dtab; DR.confirm = null; renderDraft(); return; }
    const a = e.target.closest("[data-dact]"); if (a) return runAction(a.dataset.dact);
    if (e.target.closest("[data-dconfirm]")) return runAction(DR.confirm);
    if (e.target.closest("[data-dcancel]")) { DR.confirm = null; renderDraft(); }
  });
  $("dm-text").addEventListener("input", (e) => { if (DR.tab != null) DR.edits[DR.tab] = e.target.value; if (DR.confirm) { DR.confirm = null; renderDraft(); } });
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
    try { const { source, ref } = JSON.parse(b.dataset.draft); openDraft(source, ref, b.dataset.att || ""); } catch (err) { console.warn("draft ref", err); }
  }, true);
}
