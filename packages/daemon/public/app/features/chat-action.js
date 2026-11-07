/* Ned Net 확인 카드 (config.actions.chat_write). The chat model never writes: it ends an answer with ONE ```ned-action
 * block (a proposal). Here that block becomes a card — 요약, 대상(읽기 전용), 텍스트(편집 가능), [실행] [취소].
 * [실행] → POST /api/chat/actions/validate (server checks the switches + that the target is a known item and builds the
 * request) → the EXISTING endpoint (/api/send · /api/calendar/events as a job via sendjob.js, /api/todos) with origin "chat".
 *
 * Reusable: renderActionCard(block, state, {id}) is a pure HTML string; wireActionCards(root, handlers) wires every card
 * under `root` by event delegation (re-rendering with innerHTML is fine). DOM-free at import (tests import it directly). */
import { esc, safeUrl } from "../util.js";

export const ACTION_FENCE = "ned-action";
export const CHAT_KIND_KO = {
  todo_add: "할 일 추가", slack_send: "Slack 보내기", gmail_draft: "Gmail 답장 초안 저장", gmail_send: "메일 답장 보내기",
  jira_comment: "Jira 코멘트", jira_transition: "Jira 상태 변경", github_review: "GitHub PR 리뷰·코멘트",
  calendar_create: "캘린더 일정 만들기", calendar_rsvp: "캘린더 참석 응답", session_send: "세션에 보내기",
  session_create: "새 에이전트 세션 만들기",
};
const TEXT_KO = { jira_transition: "옮길 상태", calendar_create: "일정 제목", todo_add: "할 일", calendar_rsvp: "응답 코멘트 (선택)", session_create: "첫 프롬프트 (전문)" };
/** Longest editable text per kind (server: chat-actions.ts MAX_TEXT / session-create.ts MAX_PROMPT). */
const TEXT_MAX = { session_create: 8000 };
/** session_create job stages (GET /api/sessions/create/:id → stage). */
export const STAGE_KO = { worktree_create: "워크트리 만드는 중", agent_launch: "에이전트 시작 중", agent_boot: "에이전트 기동 대기", prompt_send: "첫 프롬프트 전송", submit_confirm: "제출 확인" };

const FENCE_RE = /```ned-action[^\n]*\n([\s\S]*?)\n?```/g;

/**
 * Split an answer into the visible text and its proposal. Every complete ```ned-action fence is removed from `text`;
 * the LAST one is the proposal. An unterminated fence (still streaming) is hidden and reported as `pending`.
 * → { text, block: {kind, target, text, summary} | null, error: "" | why it could not be read, pending }
 */
export function parseActionBlock(answer) {
  const src = String(answer ?? "");
  const all = [...src.matchAll(FENCE_RE)];
  if (!all.length) {
    const i = src.indexOf("```" + ACTION_FENCE);
    return i >= 0 ? { text: src.slice(0, i).trimEnd(), block: null, error: "", pending: true } : { text: src, block: null, error: "", pending: false };
  }
  let text = src.replace(FENCE_RE, "");
  const open = text.indexOf("```" + ACTION_FENCE); // a second, unterminated one after the last complete fence
  if (open >= 0) text = text.slice(0, open);
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  let j = null;
  try { j = JSON.parse(all[all.length - 1][1]); } catch { return { text, block: null, error: "실행 제안(ned-action)을 읽지 못했어 — JSON 형식 오류", pending: false }; }
  if (!j || typeof j !== "object" || Array.isArray(j) || !CHAT_KIND_KO[j.kind])
    return { text, block: null, error: `실행 제안(ned-action)의 kind 를 모르겠어: ${String(j?.kind ?? "").slice(0, 40)}`, pending: false };
  let target = j.target && typeof j.target === "object" && !Array.isArray(j.target) ? j.target : {};
  let btext = typeof j.text === "string" ? j.text.trim() : "";
  if (j.kind === "session_create") { // also the flat form {repo, worktree, model, prompt}
    target = { ...Object.fromEntries(["repo", "worktree", "model"].filter((k) => j[k] !== undefined).map((k) => [k, j[k]])), ...target };
    if (!btext && typeof j.prompt === "string") btext = j.prompt.trim();
  }
  return { text, block: { kind: j.kind, target, text: btext, summary: typeof j.summary === "string" ? j.summary.trim().slice(0, 200) : "" }, error: "", pending: false };
}

/** Best-effort target line before the server has checked it (validate's target_label replaces it). */
export function targetGuess(block) {
  const t = block?.target || {};
  if (block?.kind === "session_create") {
    const w = t.worktree && typeof t.worktree === "object" ? t.worktree : {};
    return [t.repo && `레포 ${String(t.repo).split("/").filter(Boolean).pop()} (${t.repo})`, w.name && `${w.mode === "existing" ? "기존 워크트리" : "새 워크트리"} ${w.name}`, `모델 ${t.model || "opus"}`].filter(Boolean).join(" · ");
  }
  const parts = [t.url, t.key, t.event_id && `event ${t.event_id}`, t.response, t.session_id && `session ${String(t.session_id).slice(0, 8)}`, t.event,
    t.date && [t.date, t.start_time && `${t.start_time}–${t.end_time || ""}`, t.all_day && "종일"].filter(Boolean).join(" "), t.due && `마감 ${t.due}`,
    Array.isArray(t.attendees) && t.attendees.length && `참석자 ${t.attendees.join(", ")}`].filter(Boolean);
  return parts.join(" · ") || "(대상 없음)";
}

/**
 * The card. `state`: { status: idle|running|executed|failed|cancelled, text (current, maybe edited), result {ok, detail, link},
 * preview {target_label, label, summary} | null, previewError, tick (running: elapsed label) }. `opts.id` keys the card.
 */
export function renderActionCard(block, state = {}, { id = "" } = {}) {
  const status = state.status || "idle";
  const label = state.preview?.label || CHAT_KIND_KO[block.kind] || block.kind;
  const sum = block.summary || state.preview?.summary || label;
  const da = `data-ca="${esc(id)}"`;
  if (status === "cancelled") return `<div class="cm-act s-cancelled" ${da}><span class="ca-k">⚡ ${esc(label)}</span> <span class="ca-done">취소됨</span></div>`;
  const editable = status === "idle" || status === "failed";
  const text = state.text ?? block.text ?? "";
  const tgt = state.preview?.target_label || targetGuess(block);
  const r = state.result;
  const link = r?.link && safeUrl(r.link);
  const foot = status === "running" ? `<div class="ca-st"><span class="spin"></span>실행 중…${state.tick ? ` <span class="ca-tick">${esc(state.tick)}</span>` : ""}</div>`
    : status === "executed" ? `<div class="ca-st ${r?.ok === false ? "bad" : "ok"}">${r?.ok === false ? "⚠ 결과를 확인하지 못했어" : "✓ 실행됨"}${r?.detail ? ` — <span class="ca-det">${esc(r.detail)}</span>` : ""}${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">열기</a>` : ""}</div>`
    : `${status === "failed" && r?.detail ? `<div class="ca-st bad">⚠ ${esc(r.detail)}</div>` : ""}${state.previewError ? `<div class="ca-st bad">⚠ ${esc(state.previewError)}</div>` : ""}
    <div class="ca-btns"><button type="button" class="btn small go" data-ca-run>${status === "failed" ? "다시 실행" : "실행"}</button><button type="button" class="btn small" data-ca-cancel>취소</button></div>`;
  const tx = editable
    ? `<textarea class="ca-tx" data-ca-text rows="${Math.min(block.kind === "session_create" ? 14 : 8, Math.max(2, text.split("\n").length + 1))}" maxlength="${TEXT_MAX[block.kind] || 4000}" aria-label="${esc(TEXT_KO[block.kind] || "보낼 텍스트")}" placeholder="${esc(TEXT_KO[block.kind] || "보낼 텍스트")}">${esc(text)}</textarea>`
    : `<div class="ca-tx ro">${text ? esc(text).replace(/\n/g, "<br>") : "<i>(텍스트 없음)</i>"}</div>`;
  return `<div class="cm-act s-${esc(status)}" ${da} role="group" aria-label="실행 제안: ${esc(label)}">
  <div class="ca-hd"><span class="ca-k">⚡ 실행 제안 · ${esc(label)}</span></div>
  <div class="ca-sum">${esc(sum)}</div>
  <div class="ca-tg" title="대상은 바꿀 수 없어 — 다른 대상이면 대화로 다시 요청해 줘"><span class="ca-l">대상</span> ${esc(tgt)}</div>
  <div class="ca-l">${esc(TEXT_KO[block.kind] || "텍스트")}${editable ? " <span class=\"ca-hint\">(고칠 수 있어)</span>" : ""}</div>
  ${tx}
  ${foot}
</div>`;
}

const linkOf = (s) => /https:\/\/[^\s"')]+/.exec(String(s || ""))?.[0];

/** {ok, status, data} from postJson / sendAndWait → the card's result. `final` = no retry (outcome unknown or done). */
export function outcomeOf(r) {
  const d = r?.data || {};
  if (r?.status === 409 && d.already_sent) return { ok: true, final: true, detail: `이미 실행됨${d.sent_at ? ` (${d.sent_at})` : ""}${d.detail ? ` · ${d.detail}` : ""}`, link: safeUrl(d.link) || linkOf(d.detail) };
  // 세션 만들기: a session already exists past this point (worktree / terminal) — never offer a blind retry.
  if (!d.ok && d.session?.handle) return { ok: false, final: true, detail: String(d.error || d.detail || "세션은 만들어졌지만 끝까지 확인하지 못했어").slice(0, 300) };
  if (r?.ok && d.ok) return { ok: true, final: true, detail: String(d.detail || "완료").slice(0, 300), link: safeUrl(d.link) || safeUrl(d.event?.html_link) || linkOf(d.detail) };
  if (r?.unknown) return { ok: false, final: true, detail: d.error || "결과를 확인하지 못했어 — 설정 → 오늘 한 액션에서 확인해 줘" };
  return { ok: false, final: false, detail: String(d.error || d.detail || `HTTP ${r?.status ?? "?"}`).slice(0, 300) };
}

/** Match a Jira transition by the card text: exact name / target status first, then a substring. */
export function pickTransition(list, want) {
  const w = String(want || "").trim().toLowerCase();
  if (!w) return null;
  const n = (x) => String(x || "").toLowerCase();
  return list.find((t) => n(t.name) === w || n(t.to) === w) || list.find((t) => n(t.name).includes(w) || n(t.to).includes(w)) || null;
}

/**
 * Validate + run one proposal with `text`. deps: { postJson, sendAndWait, onTick }. Resolves { ok, final, detail, link }.
 * Never invents a request: the endpoint + payload come from the server's validate answer.
 */
export async function runChatAction(block, text, { postJson, sendAndWait, onTick } = {}) {
  const v = await postJson("/api/chat/actions/validate", { block, text }).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
  if (!v.ok || !v.data?.ok) return { ok: false, final: false, detail: v.data?.error || `검증 실패 (HTTP ${v.status})` };
  const d = v.data;
  if (d.endpoint === "/api/todos") {
    const r = await postJson("/api/todos", d.payload).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
    return r.ok ? { ok: true, final: true, detail: `할 일 추가됨: ${r.data?.title || text}${r.data?.due ? ` (마감 ${r.data.due})` : ""}` } : outcomeOf(r);
  }
  let payload = d.payload;
  if (d.lookup) {
    const l = await sendAndWait(d.lookup, { label: "Jira 전환 목록", onTick });
    const list = l.data?.transitions;
    if (!Array.isArray(list)) return { ...outcomeOf(l), ok: false, final: false };
    const t = pickTransition(list, text);
    if (!t) return { ok: false, final: false, detail: `'${text}' 로 가는 전환이 없어 (가능: ${list.map((x) => x.to || x.name).join(", ") || "없음"})` };
    payload = { ...payload, ref: { ...payload.ref, transition_id: t.id, transition_name: t.name } };
  }
  const opts = { label: `대화창 · ${d.label}`, onTick };
  if (d.endpoint === "/api/calendar/events") Object.assign(opts, { endpoint: d.endpoint, match: { source: "calendar", mode: "create", ref: { title: payload.title, calendar_id: "primary" } } });
  else if (d.endpoint && d.endpoint !== "/api/send") Object.assign(opts, { endpoint: d.endpoint, ...(d.match ? { match: d.match } : {}), ...(d.max_wait_ms ? { maxWaitMs: d.max_wait_ms } : {}) });
  return outcomeOf(await sendAndWait(payload, opts));
}

/**
 * Wire every card under `root` (event delegation; survives innerHTML re-renders). handlers:
 *   get(id) → { block, state } | null        — current block + state (state.text = edited text)
 *   set(id, patch, rerender = true)          — merge into the caller's state (draft typing passes rerender=false)
 *   persist(id, {state, text?, result?})     — save to the chat (resolves {ok, status}); a 409 means another run won
 *   deps                                     — { postJson, sendAndWait } for runChatAction
 * Double clicks / a second [실행] while running are ignored; executed and cancelled cards have no buttons.
 */
export function wireActionCards(root, h) {
  const busy = new Set();
  const idOf = (el) => el.closest("[data-ca]")?.dataset.ca;
  root.addEventListener("input", (e) => {
    const ta = e.target.closest?.("[data-ca-text]"); if (!ta) return;
    const id = idOf(ta); if (id != null) h.set(id, { text: ta.value }, false);
  });
  root.addEventListener("click", async (e) => {
    const run = e.target.closest?.("[data-ca-run]"), cancel = e.target.closest?.("[data-ca-cancel]");
    if (!run && !cancel) return;
    const id = idOf(run || cancel); if (id == null) return;
    const cur = h.get(id); if (!cur || busy.has(id)) return;
    const st = cur.state?.status || "idle";
    if (st !== "idle" && st !== "failed") return;
    if (cancel) {
      busy.add(id);
      try { await h.persist(id, { state: "cancelled" }); } finally { busy.delete(id); }
      h.set(id, { status: "cancelled" });
      return;
    }
    const ta = (run.closest("[data-ca]")).querySelector("[data-ca-text]");
    const text = (ta ? ta.value : cur.state?.text ?? cur.block.text ?? "").trim();
    busy.add(id);
    try {
      h.set(id, { status: "running", text, result: null, tick: "" });
      const claim = await h.persist(id, { state: "running", text }).catch(() => ({ ok: false, status: 0 }));
      if (claim?.status === 409) { h.set(id, { status: "executed", result: { ok: false, detail: claim.data?.error || "이미 처리된 카드야" } }); return; }
      const res = await runChatAction(cur.block, text, { ...h.deps, onTick: (ms, stage) => h.set(id, { tick: `${STAGE_KO[stage] ? `${STAGE_KO[stage]} · ` : ""}${Math.round(ms / 1000)}초` }) });
      const status = res.ok || res.final ? "executed" : "failed";
      const result = { ok: res.ok, detail: res.detail, ...(res.link ? { link: res.link } : {}) };
      await h.persist(id, { state: status, text, result }).catch(() => null);
      h.set(id, { status, result, tick: "" });
    } finally { busy.delete(id); }
  });
}
