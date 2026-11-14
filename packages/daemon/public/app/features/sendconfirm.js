/* 보내기 확인 단계 — the one shared step for a 409 {need_confirm} from POST /api/send (· /api/calendar/events):
 * a `confirm` 보내기 규칙 and/or 자동 검토 issues. Shows the reasons + issues with [그래도 보내기] [취소] in the page
 * (never window.confirm — the WKWebView has no panel for it). sendjob.js sendAndWait calls askSendConfirm and, on
 * [그래도 보내기], posts the same body + confirm_token (the daemon checks it: 5 min, bound to that exact request).
 * Where it shows: inside the open modal's body (답장 초안 / 새 일정) when one is open, else a panel pinned to the
 * bottom of the window (⋯ 메뉴, 대화창 확인 카드, 세션 답하기). */
import { esc } from "../util.js";

export const REVIEW_KIND_KO = { recipient: "받는 이", secret: "비밀 노출", commitment: "약속·날짜", tone: "어조", other: "기타" };

/** A 403 from a `block` 보내기 규칙 (not a switched-off action): its message, else null. */
export const ruleBlockMsg = (r) => (r?.status === 403 && /보내기 규칙/.test(String(r.data?.detail || "")) ? String(r.data.detail) : null);

/** The 409 body asks for the confirm step (and carries a token to answer with). */
export const needsConfirm = (r) => r?.status === 409 && !!r.data?.need_confirm && typeof r.data.confirm_token === "string";

/** Pure: the panel's inner HTML for a need_confirm body. */
export function sendConfirmHtml(d = {}) {
  const reasons = Array.isArray(d.reasons) ? d.reasons : [];
  const issues = Array.isArray(d.review?.issues) ? d.review.issues : [];
  const again = d.token_problem === "expired" ? "확인한 지 5분이 지나 다시 물어볼게." : d.token_problem === "mismatch" ? "확인한 뒤 내용·대상이 바뀌어 다시 물어볼게." : "";
  return `<div class="scf-h" id="scf-h">⚠️ 보내기 전에 확인해 줘</div>
    ${again ? `<div class="scf-again">${esc(again)}</div>` : ""}
    ${reasons.length ? `<ul class="scf-list" aria-label="보내기 규칙">${reasons.map((x) => `<li class="scf-rule">${esc(x)}</li>`).join("")}</ul>` : ""}
    ${issues.length ? `<div class="scf-sub">자동 검토</div><ul class="scf-list" aria-label="자동 검토 이슈">${issues.map((i) => `<li class="scf-issue" data-kind="${esc(i.kind)}"><b>${esc(REVIEW_KIND_KO[i.kind] || i.kind)}</b> ${esc(i.detail)}</li>`).join("")}</ul>` : ""}
    <div class="scf-btns"><button type="button" class="btn go" data-scf="go">그래도 보내기</button><button type="button" class="btn" data-scf="cancel">취소 <kbd>Esc</kbd></button></div>`;
}

export const SEND_CONFIRM_CSS = `.sendconfirm { border: 1px solid var(--amber, #c90); border-radius: 8px; padding: 10px 12px; margin: 8px 0; background: var(--bg, #fff); color: inherit; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.sendconfirm.float { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); width: min(520px, calc(100vw - 32px)); z-index: 10000; box-shadow: 0 8px 28px rgba(0,0,0,.28); margin: 0; }
.sendconfirm .scf-h { font-weight: 600; }
.sendconfirm .scf-again, .sendconfirm .scf-sub { color: var(--dim, #888); font-size: 12px; }
.sendconfirm .scf-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.sendconfirm .scf-issue b { font-weight: 600; margin-right: 4px; }
.sendconfirm .scf-btns { display: flex; gap: 8px; justify-content: flex-end; }`;

let cssDone = false;
function ensureCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const st = document.createElement("style"); st.textContent = SEND_CONFIRM_CSS; document.head.appendChild(st);
}

/** Where the panel goes: `host` if given, else the open modal's body, else null (→ a floating panel). */
function hostFor(host) {
  if (host) return host;
  return document.querySelector(".modal:not([hidden]) .mbd") || null;
}

/**
 * Show the confirm step for a need_confirm body; resolves true on [그래도 보내기], false on [취소] / Esc.
 * Only one at a time: a newer one cancels an older one still open.
 */
let current = null;
export function askSendConfirm(data, host) {
  ensureCss();
  current?.(false);
  return new Promise((resolve) => {
    const el = document.createElement("div");
    const at = hostFor(host);
    el.className = `sendconfirm${at ? "" : " float"}`;
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-labelledby", "scf-h");
    el.innerHTML = sendConfirmHtml(data);
    (at || document.body).appendChild(el);
    const prev = document.activeElement;
    // The modal it sits in was closed (✕ / 바깥 클릭): count it as 취소 so the caller never waits forever.
    const gone = setInterval(() => { if (!el.isConnected) done(false); }, 400);
    const done = (go) => {
      if (current !== done) return;
      current = null;
      clearInterval(gone);
      el.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey, true);
      el.remove();
      try { prev?.focus?.(); } catch { /* gone */ }
      resolve(go);
    };
    const onClick = (e) => { const b = e.target.closest?.("[data-scf]"); if (b) { e.preventDefault(); e.stopPropagation(); done(b.dataset.scf === "go"); } };
    // window capture: runs before the modal's / 대화창's own Esc handlers, so Esc only closes this step.
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); done(false); } };
    current = done;
    el.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    el.querySelector('[data-scf="cancel"]')?.focus(); // safe default: Enter / Space cancels
  });
}

/** Test helper: is a confirm step open right now? */
export const _confirmOpen = () => !!current;
