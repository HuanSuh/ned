/* Error badge (⚠) + its popover (full message, time, retry, copy). */
import { select } from "../tabs/inbox.js";
import { toast } from "./toast.js";
import { $, esc, mdhm, rel } from "../util.js";

// ---------- error badge: ⚠ icon (tooltip = short summary) → popover with full message, time, retry, copy ----------
export const ERRS = {};
/** "API Error: 400 {"type":"error","error":{"message":"…"}}" → "API 400 · …" ; other text → first line, trimmed. */
export function errSummary(msg) {
  const t = String(msg || "").trim();
  const code = /\b(?:API Error|status|→)\s*:?\s*(\d{3})\b/i.exec(t)?.[1];
  let inner = "";
  const j = t.indexOf("{"), k = t.lastIndexOf("}");
  if (j >= 0 && k > j) { try { const o = JSON.parse(t.slice(j, k + 1)); inner = o?.error?.message || o?.message || o?.error?.type || o?.error || ""; } catch { /* not JSON */ } }
  const head = (inner || t.split("\n")[0].replace(/\{.*$/s, "")).replace(/\s+/g, " ").trim();
  const s = [code && !head.includes(code) ? `HTTP ${code}` : "", head].filter(Boolean).join(" · ");
  return s.length > 90 ? s.slice(0, 88) + "…" : s || "알 수 없는 오류";
}
/** Register an error and return its badge. `retry` is a function (re-runs the job) or null. */
export function errBadge(id, { where, message, at = Date.now(), retry = null, label = "" }) {
  ERRS[id] = { where, message: String(message || ""), at, retry, short: errSummary(message) };
  const tip = `${where}: ${ERRS[id].short} — 눌러서 자세히`;
  return `<button type="button" class="erri" data-err="${esc(id)}" title="${esc(tip)}" aria-label="${esc("오류 — " + tip)}" aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4L12 3.5zM12 10v4.5M12 17.2v.3"/></svg>${label ? `<span>${esc(label)}</span>` : ""}</button>`;
}
export function closeErrPop() { const p = $("errpop"); if (!p.hidden) { p.hidden = true; p._back?.focus?.(); } }
export function openErrPop(btn) {
  const e = ERRS[btn.dataset.err]; if (!e) return;
  const p = $("errpop");
  p.innerHTML = `<div class="eph"><span class="erri" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3.5 2.8 19.5h18.4L12 3.5zM12 10v4.5M12 17.2v.3"/></svg></span><b>${esc(e.where)}</b><span class="sp"></span><span class="when">${esc(mdhm(e.at))} · ${esc(rel(e.at))}</span></div>
      <pre class="epmsg">${esc(e.message)}</pre>
      <div class="epf">${e.retry ? `<button type="button" class="btn small go" data-epretry="1">다시 시도</button>` : ""}<button type="button" class="btn small" data-epcopy="1">로그 복사</button><button type="button" class="btn small" data-epclose="1">닫기</button></div>`;
  p._err = btn.dataset.err; p._back = btn;
  p.hidden = false;
  const r = btn.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
  p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  p.style.top = `${r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  p.querySelector("button")?.focus();
}

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-err]");
    if (b) { ev.preventDefault(); ev.stopPropagation(); const p = $("errpop"); if (!p.hidden && p._err === b.dataset.err) closeErrPop(); else openErrPop(b); return; }
    const p = $("errpop"); if (p.hidden) return;
    if (!ev.target.closest("#errpop")) return closeErrPop();
    const e = ERRS[p._err];
    if (ev.target.closest("[data-epclose]")) return closeErrPop();
    if (ev.target.closest("[data-epcopy]") && e) {
      const text = `[${new Date(e.at).toISOString()}] ${e.where}\n${e.message}`;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch {
        const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
        try { ok = document.execCommand("copy"); } catch { ok = false; } ta.remove();
      }
      toast(ok ? "오류 로그를 복사했어." : "복사하지 못했어 — 팝오버의 메시지를 직접 선택해 줘.");
      return;
    }
    if (ev.target.closest("[data-epretry]") && e?.retry) { closeErrPop(); e.retry(); }
  }, true);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("errpop").hidden) { ev.stopImmediatePropagation(); closeErrPop(); } }, true);
}
