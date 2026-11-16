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
  const block = { kind: j.kind, target, text: btext, summary: typeof j.summary === "string" ? j.summary.trim().slice(0, 200) : "" };
  // slack_send extras (WU-07) travel to validate as-is; the server cleans and checks them.
  if (Array.isArray(j.mentions) && j.mentions.length) block.mentions = j.mentions;
  if (typeof j.target_excerpt === "string" && j.target_excerpt.trim()) block.target_excerpt = j.target_excerpt.trim().slice(0, 300);
  if (typeof j.channel_external === "boolean") block.channel_external = j.channel_external;
  return { text, block, error: "", pending: false };
}

/** "@이름" → "<@U…>" for the block's mentions that are settled: one candidate, or the one picked on the card. */
export function mentionMap(block, choices = {}) {
  const out = {};
  for (const m of Array.isArray(block?.mentions) ? block.mentions : []) {
    const text = typeof m?.text === "string" ? (m.text.startsWith("@") ? m.text : `@${m.text}`) : "";
    const cands = (Array.isArray(m?.candidates) ? m.candidates : []).filter((c) => /^[UW][A-Z0-9]{6,}$/.test(String(c?.id || "")));
    if (!text || m.group) continue;
    const pick = cands.length === 1 ? cands[0] : cands.find((c) => c.id === choices[text]);
    if (pick) out[text] = `<@${pick.id}>`;
  }
  return out;
}

const SRC_KO = { known: "Ned 가 아는 항목", pasted: "붙인 링크", found: "Ned 가 찾은 대상 — 맞는지 확인" };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "U0TESTPA01" → "U0TE…" — the chip shows whose id it really is (the name alone is the model's word). */
export const shortId = (id) => (String(id).length > 5 ? `${String(id).slice(0, 4)}…` : String(id));

/**
 * The text to send with `<@U…>` / `<!subteam^S…>` as name chips (+ the id's start), not-found / glued mentions as
 * yellow chips and broadcast mentions (@here · @channel · @everyone) as red chips (the server refuses those: 400).
 */
export function mentionPreviewHtml(text, sl) {
  const res = sl?.mentions?.resolved || [], miss = sl?.mentions?.missing || [];
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  const alts = ["<@([A-Z0-9]+)(?:\\|[^>]*)?>", "<!subteam\\^([A-Z0-9]+)(?:\\|[^>]*)?>", "(<!(?:channel|here|everyone)(?:\\|[^>]*)?>|(?<![\\w@])@(?:channel|here|everyone)(?![\\w-]))", ...miss.map((m) => `(${reEsc(m.text)})(?![A-Za-z0-9._-])`)];
  const re = new RegExp(alts.join("|"), "gi");
  let out = "", last = 0, m;
  const src = String(text ?? "");
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    if (m[1]) { const r = byId[m[1]]; out += `<span class="ca-chip${r?.external ? " ext" : ""}" title="${esc(m[1])}">@${esc(r?.name || m[1])} · <span class="ca-id">${esc(shortId(m[1]))}</span></span>`; }
    else if (m[2]) { const r = byId[m[2]]; out += `<span class="ca-chip grp" title="${esc(m[2])}">👥 ${esc(r?.name || m[2])} · <span class="ca-id">${esc(shortId(m[2]))}</span></span>`; }
    else if (m[3]) out += `<span class="ca-chip bad" title="전체 알림 멘션은 대화창에서 보낼 수 없음 — Slack 에서 직접">${esc(m[3])} — 전체 알림, 보낼 수 없음</span>`;
    else {
      const mm = miss.find((x) => x.text === m[0]);
      out += mm?.reason
        ? `<span class="ca-chip warn" title="${esc(mm.reason)}">${esc(m[0])} — 이름 경계 모름, 글자로 보냄</span>`
        : mm?.kind === "group"
          ? `<span class="ca-chip warn grp" title="그룹 ID 를 설정 → 소스 → Slack 에 넣으면 멘션됨">👥 ${esc(m[0])} — 그룹 ID 없음, 글자로 보냄</span>`
          : `<span class="ca-chip warn">${esc(m[0])} — 못 찾음, 글자로 보냄</span>`;
    }
    last = re.lastIndex;
    if (m[0] === "") re.lastIndex++;
  }
  return out + esc(src.slice(last));
}

/** "알림 받는 사람: 이름, 이름 (외부: 이름)" — "" when nobody is notified. */
export function notifyLine(sl) {
  const res = sl?.mentions?.resolved || [];
  if (!res.length) return "";
  const inside = res.filter((r) => !r.external).map((r) => (r.kind === "group" ? `👥 ${r.name}` : r.name));
  const outside = res.filter((r) => r.external).map((r) => r.name);
  return `알림 받는 사람: ${[inside.join(", "), outside.length ? `(외부: ${outside.join(", ")})` : ""].filter(Boolean).join(" ")}`;
}

/** The slack_send / mail extras: source badge, external badge, excerpt, preview with chips, notify line, mention dropdowns. */
function slackExtrasHtml(sl, choices = {}, editable = true) {
  if (!sl) return "";
  const ext = sl.external === "external" ? `<span class="ca-badge ext">외부</span>` : sl.external === "unknown" ? `<span class="ca-badge unk" title="채널·사람이 외부인지 정보가 없어">외부 여부 확인 못 함</span>` : "";
  const src = SRC_KO[sl.target_source] ? `<span class="ca-badge src s-${esc(sl.target_source)}">${esc(SRC_KO[sl.target_source])}</span>` : "";
  // a pasted / found channel Ned can't name: show its id and say so (the model's channel name is never shown)
  const unnamed = sl.channel && !sl.channel_name ? `<span class="ca-badge unk" title="Ned 가 모은 Slack 목록에 없는 채널이야 — ID 로 확인해 줘">채널 이름 확인 안 됨 · ${esc(sl.channel)}</span>` : "";
  const ex = sl.target_excerpt ? `<div class="ca-ex" title="Ned(모델)가 적은 발췌 — 원문과 다를 수 있어">Ned 발췌: “${esc(String(sl.target_excerpt).slice(0, 200))}”</div>` : "";
  const un = (sl.mentions?.unresolved || []).map((u) => `<label class="ca-mc">${esc(u.text)} 은(는) 누구?${u.via_cache ? ' <span class="ca-badge unk" title="모델이 후보를 못 줘서 Ned 의 캐시에서 이름으로 찾았어">캐시로 해석</span>' : ""} <select data-ca-mention="${esc(u.text)}"${editable ? "" : " disabled"}><option value="">고르기 (보내기 전에 필수)</option>${(u.candidates || []).map((c) => `<option value="${esc(c.id)}"${choices[u.text] === c.id ? " selected" : ""}>${esc([c.name, c.real_name, c.title, shortId(c.id)].filter(Boolean).join(" · "))}${c.external ? " (외부)" : ""}</option>`).join("")}</select></label>`).join("");
  const nl = notifyLine(sl);
  const m = sl.mentions || {};
  const pv = sl.preview_text != null && ((m.resolved || []).length || (m.missing || []).length || (m.broadcast || []).length)
    ? `<div class="ca-pv" aria-label="보낼 모양 미리보기">${mentionPreviewHtml(sl.preview_text, sl).replace(/\n/g, "<br>")}</div>` : "";
  return `<div class="ca-badges">${src}${unnamed}${ext}</div>${ex}${pv}${nl ? `<div class="ca-notify">${esc(nl)}</div>` : ""}${un}`;
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
  ${slackExtrasHtml(state.preview?.slack || (state.preview?.mail_external ? { external: state.preview.mail_external } : null), state.mention_choices || {}, editable)}
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

/** {conversation_id, mention_choices} for validate (붙인 링크 · Ned 가 읽은 메시지 · 동명이인 선택). */
export const validateCtx = (ctx = {}) => ({
  ...(ctx.conversation_id ? { conversation_id: ctx.conversation_id } : {}),
  ...(ctx.mention_choices && Object.keys(ctx.mention_choices).length ? { mention_choices: ctx.mention_choices } : {}),
});

/**
 * Validate + run one proposal with `text`. deps: { postJson, sendAndWait, onTick }. Resolves { ok, final, detail, link }.
 * Never invents a request: the endpoint + payload come from the server's validate answer.
 */
export async function runChatAction(block, text, { postJson, sendAndWait, onTick, ctx = {} } = {}) {
  const v = await postJson("/api/chat/actions/validate", { block, text, ...validateCtx(ctx) }).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
  if (!v.ok || !v.data?.ok) return { ok: false, final: false, detail: v.data?.error || `검증 실패 (HTTP ${v.status})`, ...(v.data?.slack ? { slack: v.data.slack } : {}) };
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
  // 동명이인: picking a person re-checks the card (the server says who gets notified, and whether it can be sent now).
  root.addEventListener("change", (e) => {
    const sel = e.target.closest?.("[data-ca-mention]"); if (!sel) return;
    const id = idOf(sel); if (id == null) return;
    const cur = h.get(id); if (!cur) return;
    const ta = sel.closest("[data-ca]")?.querySelector("[data-ca-text]");
    const choices = { ...(cur.state?.mention_choices || {}) };
    if (sel.value) choices[sel.dataset.caMention] = sel.value; else delete choices[sel.dataset.caMention];
    h.set(id, { mention_choices: choices, ...(ta ? { text: ta.value } : {}), preview: null, previewError: "" });
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
      const ctx = { ...(h.ctx ? h.ctx(id) : {}), mention_choices: cur.state?.mention_choices || {} };
      const res = await runChatAction(cur.block, text, { ...h.deps, ctx, onTick: (ms, stage) => h.set(id, { tick: `${STAGE_KO[stage] ? `${STAGE_KO[stage]} · ` : ""}${Math.round(ms / 1000)}초` }) });
      const status = res.ok || res.final ? "executed" : "failed";
      const result = { ok: res.ok, detail: res.detail, ...(res.link ? { link: res.link } : {}) };
      await h.persist(id, { state: status, text, result }).catch(() => null);
      h.set(id, { status, result, tick: "", ...(res.slack ? { preview: { ...(cur.state?.preview || {}), slack: res.slack } } : {}) });
    } finally { busy.delete(id); }
  });
}
