/* 세션에 답하기 — 대기 중인 세션 행(인박스 세션 rail · 휴대폰 서랍 · 인박스 상세)에서 짧은 답을 그 세션의 Orca 터미널로.
 * waiting 행: 빠른 버튼(config.dashboard.session_quick_replies, 기본 ㄱㄱ·승인·계속) + 한 줄 입력(⏎ 전송, 한글 조합 중 ⏎ 무시).
 * running / done 행: ⋯ → "메시지 보내기" 로 같은 입력(실행 중 세션에 추가 지시). can_reply false(Orca 터미널 기록 없음) → 안내 한 줄만.
 * 전송 = POST /api/send {source:"session", mode:"session", ref:{session_id}, text, origin:"session"} → 202 → job 폴링(sendjob.js).
 * 성공 → 행이 "보냄 — 응답 기다리는 중" 으로 바뀌고, 그 세션에 새 이벤트가 오면(다음 /api/state) 실제 상태로 덮인다.
 * 상태는 모듈 안 R 에만(새로고침이면 사라짐 — 결과는 sendjob 의 pending 이 이어 받는다). 다시 그리기는 emit("sessreply"). */
import { S, emit } from "../state.js";
import { toast } from "../ui/toast.js";
import { esc } from "../util.js";
import { sendAndWait } from "./sendjob.js";

export const DEFAULT_QUICK = ["ㄱㄱ", "승인", "계속"];
export const TEXT_MAX = 2000;
/** "보냄" 표시를 붙들고 있는 최대 시간 — 세션 이벤트가 안 와도 이 뒤엔 실제 상태로. */
export const SENT_HOLD_MS = 90_000;
export const CLOSED_MSG = "터미널이 닫혀 있어 보낼 수 없음 — 터미널에서 직접 입력";

/** open: ⋯ 로 연 입력(비대기 세션), draft: 입력 중 글, busy: 전송 중, sent: id → {at, ts(보낼 때의 last_event_ts)}, menu: ⋯ 메뉴가 열린 세션. */
export const R = { open: new Set(), draft: new Map(), busy: new Set(), sent: new Map(), menu: null };
export function _resetReply() { R.open.clear(); R.draft.clear(); R.busy.clear(); R.sent.clear(); R.menu = null; }

export const quickReplies = () => {
  const q = S.config?.dashboard?.session_quick_replies;
  return Array.isArray(q) ? q.filter((x) => typeof x === "string" && x.trim()).slice(0, 5) : DEFAULT_QUICK;
};
/** actions.session_send (기본 켜짐) — 꺼져 있으면 답하기 UI 를 안 그린다. */
export const replyOn = () => S.config?.actions?.session_send !== false;
/** 옛 데몬(can_reply 없음)은 보낼 수 있다고 보고, 실제 가능 여부는 전송 때 409 로. */
export const canReply = (x) => x?.can_reply !== false;

/** 보낸 뒤 아직 세션이 반응하지 않았나 (새 이벤트 없음 · 90초 안). */
export function sentPending(x, now = Date.now()) {
  const s = R.sent.get(x.id);
  if (!s) return false;
  if ((x.last_event_ts || 0) > s.ts || now - s.at > SENT_HOLD_MS) { R.sent.delete(x.id); return false; }
  return true;
}

/** 실패 결과 → 토스트 문구. 409(터미널 없음/닫힘)는 고정 안내, 그 밖엔 데몬이 준 사유 그대로. */
export function failText(r) {
  if (r.status === 409) return CLOSED_MSG;
  if (r.status === 403) return "세션에 보내기가 꺼져 있어 — 설정 → 쓰기 액션에서 켜 줘";
  const why = r.data?.error || r.data?.detail || (r.status ? `HTTP ${r.status}` : "연결 실패");
  return `보내지 못했어: ${String(why).slice(0, 200)}`;
}

/** 행 다시 그리기용 서명 — 인박스 상세의 sig 에 붙여 상태가 바뀌면 다시 그린다. */
export const replySig = (x) => (x ? `${R.open.has(x.id)}|${R.busy.has(x.id)}|${sentPending(x)}|${R.menu === x.id}|${x.can_reply}|${replyOn()}|${quickReplies().join(",")}` : "");

/** ⋯ 버튼 (running / done 등 대기 아닌 세션, 보낼 곳이 있을 때만) + 열린 메뉴. */
export function replyMenu(x, where) {
  if (!replyOn() || !canReply(x) || x.status === "waiting" || x.status === "ended") return "";
  const open = R.menu === `${where}:${x.id}`;
  return `<span class="srm"><button type="button" class="srmore" data-srmenu="${esc(x.id)}" data-where="${esc(where)}" aria-haspopup="menu" aria-expanded="${open}" title="세션 메뉴" aria-label="${esc(x.worktree)} 세션 메뉴">⋯</button>${open ? `<span class="srpop" role="menu"><button type="button" role="menuitem" data-sropen="${esc(x.id)}" data-where="${esc(where)}">메시지 보내기</button></span>` : ""}</span>`;
}

/** 답하기 영역 HTML (그릴 것 없으면 ""). `where` = rail | drawer | detail — 같은 세션이 여러 곳에 있어도 포커스를 제자리로. */
export function replyBox(x, where) {
  if (!x || !replyOn() || x.status === "ended") return "";
  const sid = esc(x.id), wh = esc(where);
  if (sentPending(x)) return `<div class="sreply sent" data-sr="${sid}" data-where="${wh}" role="status">보냄 — 응답 기다리는 중</div>`;
  const waiting = x.status === "waiting";
  if (!waiting && !R.open.has(x.id)) return "";
  if (!canReply(x)) return waiting ? `<div class="sreply nohint" data-sr="${sid}" data-where="${wh}">터미널에서 직접 입력 — 이 세션은 Orca 터미널 기록이 없어 Ned 가 보낼 수 없어</div>` : "";
  const busy = R.busy.has(x.id), dis = busy ? " disabled" : "";
  const quick = waiting ? quickReplies() : [];
  return `<div class="sreply${busy ? " busy" : ""}" data-sr="${sid}" data-where="${wh}">`
    + (quick.length ? `<div class="srq" role="group" aria-label="빠른 답">${quick.map((q) => `<button type="button" class="btn small" data-srq="${esc(q)}"${dis}>${esc(q)}</button>`).join("")}</div>` : "")
    + `<div class="srin"><input type="text" data-sri maxlength="${TEXT_MAX}" placeholder="${waiting ? "답 입력 ⏎" : "추가 지시 ⏎"}" value="${esc(R.draft.get(x.id) || "")}" aria-label="${esc(x.worktree)} 에 ${waiting ? "답하기" : "메시지 보내기"}"${dis}>`
    + `<button type="button" class="btn small go" data-srsend${dis}>${busy ? "보내는 중…" : "보내기"}</button>`
    + (waiting ? "" : `<button type="button" class="btn small" data-srclose${dis}>닫기</button>`)
    + `</div></div>`;
}

/** 다시 그리는 동안 입력 포커스·커서를 지킨다 (10초 폴링이 rail 을 innerHTML 로 다시 그려도 타이핑이 끊기지 않게). */
export function keepFocus(render) {
  const a = document.activeElement;
  const box = a?.matches?.("[data-sri]") ? a.closest("[data-sr]") : null;
  const at = box ? { sid: box.dataset.sr, where: box.dataset.where, s: a.selectionStart, e: a.selectionEnd } : null;
  render();
  if (!at) return;
  const inp = [...document.querySelectorAll("[data-sr]")].find((b) => b.dataset.sr === at.sid && b.dataset.where === at.where)?.querySelector("[data-sri]");
  if (inp && document.activeElement !== inp) { inp.focus(); try { inp.setSelectionRange(at.s, at.e); } catch { /* not a text input */ } }
}

const rerender = () => emit("sessreply");
const sessionOf = (sid) => (S.state?.sessions || []).find((s) => s.id === sid);

/** 한 번 보내고 결과까지 (중복 클릭은 무시). 실패면 입력 글은 그대로 남는다. */
export async function sendReply(sid, text) {
  const t = String(text ?? "").trim();
  if (!t || R.busy.has(sid)) return null;
  if (t.length > TEXT_MAX) { toast(`${TEXT_MAX}자까지 보낼 수 있어 (지금 ${t.length}자)`); return null; }
  const x = sessionOf(sid);
  const name = x?.worktree || sid.slice(0, 8);
  R.busy.add(sid); R.menu = null; rerender();
  let r;
  try {
    r = await sendAndWait({ source: "session", mode: "session", text: t, ref: { session_id: sid }, origin: "session" }, { label: `${name} 에 답하기` });
  } catch (e) {
    r = { ok: false, status: 0, data: { error: e.message } };
  }
  R.busy.delete(sid);
  if (r.ok) {
    R.sent.set(sid, { at: Date.now(), ts: x?.last_event_ts || 0 });
    R.draft.delete(sid); R.open.delete(sid);
    toast(`${name} 에 보냄`);
  } else toast(failText(r), 5000);
  rerender();
  return r;
}

/** 위임 이벤트 (document 하나) — main.js init 목록. */
export function init(root = document) {
  root.addEventListener("click", (ev) => {
    const t = ev.target;
    const m = t.closest?.("[data-srmenu]");
    if (m) { ev.preventDefault(); const k = `${m.dataset.where}:${m.dataset.srmenu}`; R.menu = R.menu === k ? null : k; rerender(); return; }
    const o = t.closest?.("[data-sropen]");
    if (o) {
      ev.preventDefault(); R.menu = null; R.open.add(o.dataset.sropen); rerender();
      const where = o.dataset.where, sid = o.dataset.sropen;
      [...document.querySelectorAll("[data-sr]")].find((b) => b.dataset.sr === sid && b.dataset.where === where)?.querySelector("[data-sri]")?.focus();
      return;
    }
    if (R.menu && !t.closest?.(".srpop")) { R.menu = null; rerender(); }
    const box = t.closest?.("[data-sr]");
    if (!box) return;
    const sid = box.dataset.sr;
    const q = t.closest("[data-srq]");
    if (q && !q.disabled) { ev.preventDefault(); sendReply(sid, q.dataset.srq); return; }
    if (t.closest("[data-srsend]")) { ev.preventDefault(); sendReply(sid, box.querySelector("[data-sri]")?.value); return; }
    if (t.closest("[data-srclose]")) { ev.preventDefault(); R.open.delete(sid); rerender(); }
  });
  root.addEventListener("input", (ev) => {
    const inp = ev.target;
    if (!inp.matches?.("[data-sri]")) return;
    const sid = inp.closest("[data-sr]")?.dataset.sr;
    if (sid) R.draft.set(sid, inp.value);
  });
  root.addEventListener("keydown", (ev) => {
    const inp = ev.target;
    if (!inp.matches?.("[data-sri]")) return;
    const sid = inp.closest("[data-sr]")?.dataset.sr;
    if (ev.key === "Escape") {
      if (sid && R.open.has(sid)) { R.open.delete(sid); rerender(); } else inp.blur();
      return;
    }
    if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return; // 한글 조합 중 ⏎ 는 글자 확정
    ev.preventDefault(); // Shift+⏎ 도 줄바꿈 없음 — 한 줄 입력
    if (!ev.shiftKey && sid) sendReply(sid, inp.value);
  });
}
