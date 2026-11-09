/* 링크 열기 — every external link in the dashboard goes through openLink(web):
 * toDeepLink (links.js, settings from S.config.dashboard) → an app deep link, or null.
 *  - deep + Ned.app (WKWebView, window.webkit.messageHandlers.openLink) → postMessage({ deep, web }); the app checks the
 *    deep link's app is installed / opened, else opens the web URL (DashboardWindow.swift OpenLinkHandler).
 *  - anything else (no deep link, or a plain browser — no handler) → window.open(web, "_blank", "noopener") (= what
 *    target=_blank did before). A browser never tries the deep link: Chrome's "open Slack.app?" prompt gives no signal to
 *    time a fallback against (both would open) and Safari blocks a delayed window.open (nothing would open).
 * Anchors keep href = the web URL + target=_blank (hover, copy, right-click unchanged); one delegated click handler on
 * document (init) turns a plain left click on an external http(s) anchor into openLink. ⌘/Ctrl/⇧/⌥ clicks, other
 * buttons, already-handled clicks and the dashboard's own links (127.0.0.1 / localhost / same host / "#") pass through.
 * No DOM access at import: tests load it directly. */
import { S } from "../state.js";
import { linkCtxOf, toDeepLink } from "./links.js";

/**
 * Open a web URL — in its app only inside Ned.app (message handler present) when settings allow and a deep link exists.
 * Returns "app" (handed to Ned.app) or "web". opts: { win, cfg (= config.dashboard) }.
 */
export function openLink(webUrl, opts = {}) {
  const win = opts.win || window;
  const web = String(webUrl ?? "");
  if (!web) return "web";
  const handler = win.webkit?.messageHandlers?.openLink;
  if (handler) {
    const cfg = opts.cfg !== undefined ? opts.cfg : S.config?.dashboard;
    const deep = toDeepLink(web, cfg, linkCtxOf(cfg));
    if (deep) { handler.postMessage({ deep, web }); return "app"; }
  }
  win.open(web, "_blank", "noopener");
  return "web";
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

/**
 * main.js: one CAPTURE listener on document, registered before every other module's. Capture because reviewed.js stops
 * propagation of clicks on inbox-row icons (`#items .row .ib`, incl. the ↗ open anchor) in the capture phase — a bubble
 * listener never saw them. stopPropagation can't stop another listener on the same node, and registering first means
 * no earlier handler can have cancelled the click either. No module cancels clicks on external anchors on purpose.
 */
export function init(doc = document) {
  doc.addEventListener("click", (e) => { onLinkClick(e); }, true);
}
