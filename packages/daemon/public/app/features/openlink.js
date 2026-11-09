/* 링크 열기 — every external link in the dashboard goes through openLink(web):
 * toDeepLink (links.js, settings from S.config.dashboard) → an app deep link, or null.
 *  - deep + Ned.app (WKWebView, window.webkit.messageHandlers.openLink) → postMessage({ deep, web }); the app checks the
 *    deep link's app is installed / opened, else opens the web URL (DashboardWindow.swift OpenLinkHandler).
 *  - deep in a plain browser → location.href = deep, then after FALLBACK_MS, if the page never went hidden (no app took
 *    over), window.open(web) — tryDeepThenWeb, environment injected so tests drive it without a browser.
 *  - no deep → window.open(web, "_blank", "noopener") (= what target=_blank did before).
 * Anchors keep href = the web URL + target=_blank (hover, copy, right-click unchanged); one delegated click handler on
 * document (init) turns a plain left click on an external http(s) anchor into openLink. ⌘/Ctrl/⇧/⌥ clicks, other
 * buttons, already-handled clicks and the dashboard's own links (127.0.0.1 / localhost / same host / "#") pass through.
 * No DOM access at import: tests load it directly. */
import { S } from "../state.js";
import { linkCtxOf, toDeepLink } from "./links.js";

/** Plain browser: how long the page may stay visible after location.href = deep before the web URL opens. */
export const FALLBACK_MS = 1500;

/**
 * Plain-browser attempt. env: go(deep) navigates, openWeb(web) opens the fallback, isHidden() reads visibility,
 * onHidden(fn) → unsubscribe, setTimer(fn, ms). Falls back once, only when the page was never hidden.
 */
export function tryDeepThenWeb(deep, web, env) {
  let left = false;
  const off = env.onHidden(() => { left = true; });
  env.go(deep);
  env.setTimer(() => {
    if (typeof off === "function") off();
    if (!left && !env.isHidden()) env.openWeb(web);
  }, env.waitMs ?? FALLBACK_MS);
}

/** The real browser environment for tryDeepThenWeb. */
export function browserEnv(win = window) {
  const doc = win.document;
  return {
    go: (deep) => { win.location.href = deep; },
    openWeb: (web) => { win.open(web, "_blank", "noopener"); },
    isHidden: () => doc.visibilityState === "hidden",
    // hidden = the tab went away; blur = another app (the one that took the deep link) got focus while the browser
    // window stays partly visible — either means "the app opened", so no web fallback.
    onHidden: (fn) => {
      const vis = () => { if (doc.visibilityState === "hidden") fn(); };
      doc.addEventListener("visibilitychange", vis);
      win.addEventListener("blur", fn);
      return () => { doc.removeEventListener("visibilitychange", vis); win.removeEventListener("blur", fn); };
    },
    setTimer: (fn, ms) => win.setTimeout(fn, ms),
  };
}

/**
 * Open a web URL, in its app when settings allow and a deep link exists. Returns "app" (handed to Ned.app),
 * "try" (browser deep-link attempt with fallback) or "web". opts: { win, cfg (= config.dashboard), env }.
 */
export function openLink(webUrl, opts = {}) {
  const win = opts.win || window;
  const web = String(webUrl ?? "");
  if (!web) return "web";
  const cfg = opts.cfg !== undefined ? opts.cfg : S.config?.dashboard;
  const deep = toDeepLink(web, cfg, linkCtxOf(cfg));
  if (!deep) { win.open(web, "_blank", "noopener"); return "web"; }
  const handler = win.webkit?.messageHandlers?.openLink;
  if (handler) { handler.postMessage({ deep, web }); return "app"; }
  tryDeepThenWeb(deep, web, opts.env || browserEnv(win));
  return "try";
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** An http(s) link that leaves the dashboard (not 127.0.0.1 / localhost / this page's host). */
export function isExternalUrl(href, here = globalThis.location) {
  if (typeof href !== "string" || !/^https?:\/\//i.test(href)) return false;
  let u;
  try { u = new URL(href); } catch { return false; }
  if (LOCAL_HOSTS.has(u.hostname)) return false;
  return !(here && here.host && u.host === here.host);
}

/** The delegated click: plain left click on an external anchor → preventDefault + openLink. Returns whether it took it. */
export function onLinkClick(e, open = openLink) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const a = e.target?.closest?.('a[href^="http"]');
  if (!a || a.hasAttribute("download")) return false;
  const href = a.getAttribute("href");
  if (!isExternalUrl(href, a.ownerDocument?.defaultView?.location)) return false;
  e.preventDefault();
  open(href);
  return true;
}

/** main.js: one listener on document (bubble — row handlers run first and may cancel). */
export function init(doc = document) {
  doc.addEventListener("click", (e) => { onLinkClick(e); });
}
