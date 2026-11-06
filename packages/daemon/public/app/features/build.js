/* Daemon build check: /api/state and /api/config carry build_id. The first one seen is what this page's JS was served
 * with; a different one later means the daemon restarted on new code → top banner "새 버전 — 새로고침", and the settings
 * save stays locked until the reload (an old page must not write an old idea of the config). */
import { $ } from "../util.js";

export const BUILD = { first: null, stale: false };
const listeners = new Set();
export const onBuildStale = (fn) => listeners.add(fn);

/** Feed every build_id seen; returns true once the daemon is on a different build than at page load. */
export function noteBuild(id) {
  if (typeof id !== "string" || !id) return BUILD.stale; // older daemon: no build_id, nothing to compare
  if (BUILD.first === null) { BUILD.first = id; return false; }
  if (id !== BUILD.first && !BUILD.stale) {
    BUILD.stale = true;
    showBanner();
    for (const fn of listeners) try { fn(); } catch (e) { console.warn("build", e); }
  }
  return BUILD.stale;
}

function showBanner() {
  if (typeof document === "undefined" || $("build-banner")) return;
  const b = document.createElement("div");
  b.id = "build-banner";
  b.setAttribute("role", "alert");
  b.style.cssText = "position:sticky;top:0;z-index:1000;display:flex;gap:10px;align-items:center;justify-content:center;padding:8px 12px;background:var(--amber,#b7791f);color:#fff;font-size:13px";
  b.innerHTML = `<span>새 버전의 Ned 가 실행 중이야 — 새로고침해야 최신 화면으로 바뀌어 (그 전까지 설정 저장은 잠겨).</span><button type="button" class="btn small" id="build-reload">새로고침</button>`;
  document.body.prepend(b);
  $("build-reload").addEventListener("click", () => location.reload());
}
