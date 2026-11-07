/* Copy button on fenced code blocks rendered by chat-core.js mdLite (codeBlockHtml). One delegated click listener on
 * document covers every surface that renders mdLite. It's a real <button>, so Enter/Space and focus come for free. */

export const COPIED_MS = 1500;

/** The original block text: <pre><code>'s textContent (the ```lang line never reaches the DOM). */
export const codeOf = (btn) => btn.closest(".cm-code")?.querySelector("pre code")?.textContent ?? "";

/** Hidden textarea + execCommand('copy') — for when navigator.clipboard is missing or refuses (non-secure origin, no focus). */
export function legacyCopy(text, doc = document) {
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const prev = doc.activeElement;
  doc.body.appendChild(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  let ok = false;
  try { ok = doc.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  prev?.focus?.({ preventScroll: true });
  return ok;
}

export async function copyText(text, doc = document) {
  const clip = doc.defaultView?.navigator?.clipboard;
  if (clip?.writeText) {
    try { await clip.writeText(text); return true; } catch { /* fall through */ }
  }
  return legacyCopy(text, doc);
}

const timers = new WeakMap();
function flash(btn) {
  clearTimeout(timers.get(btn));
  btn.classList.add("ok");
  btn.setAttribute("aria-label", "복사됨"); btn.title = "복사됨";
  timers.set(btn, setTimeout(() => {
    btn.classList.remove("ok");
    btn.setAttribute("aria-label", "복사"); btn.title = "복사";
  }, COPIED_MS));
}

export async function onCopyClick(e) {
  const btn = e.target.closest?.(".cm-copy");
  if (!btn) return;
  e.preventDefault();
  if (await copyText(codeOf(btn), btn.ownerDocument)) flash(btn);
}

let bound = null;
/** Idempotent: one listener per document. */
export function bindCodeCopy(doc = document) {
  if (bound === doc) return;
  bound = doc;
  doc.addEventListener("click", onCopyClick);
}
