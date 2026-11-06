/* Generic modal shell: show / hide (body.modal-open stops page scroll) and the Tab focus trap.
 * The reply-draft modal (features/drafts.js) is the only user today; a new modal = markup + these three. */

export function showModal(el) {
  el.hidden = false;
  document.body.classList.add("modal-open");
}

export function hideModal(el) {
  el.hidden = true;
  document.body.classList.remove("modal-open");
}

/** Call from a keydown handler while the modal is open: Tab / Shift+Tab cycle inside `el`. */
export function trapTab(el, e) {
  if (e.key !== "Tab") return;
  const f = [...el.querySelectorAll("button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled])")];
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
}
