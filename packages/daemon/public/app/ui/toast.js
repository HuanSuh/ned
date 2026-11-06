/* Toast line. */
import { MINI } from "../features/personas.js";
import { $, esc } from "../util.js";

export let toastTimer = 0;
export function toast(msg, ms = 3200) {
  const t = $("toast");
  t.innerHTML = `${MINI}<span>${esc(msg)}</span>`;
  t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
