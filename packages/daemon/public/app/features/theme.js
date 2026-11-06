/* 테마 (라이트 / 다크 / 시스템): config.dashboard.theme → <html data-theme> (css/tokens.css, css/theme.css).
 * index.html's <head> script applies localStorage "ned.theme" before any CSS paints (no flash); once /api/config loads,
 * syncTheme() takes the server value (and re-caches it). Settings → 외형 previews a pick right away (applyTheme without
 * saving) and saving writes both config and the cache. No DOM access at import: tests load it directly. */
export const THEMES = ["system", "light", "dark"];
export const THEME_KEY = "ned.theme";
export const THEME_LABEL = { system: ["🖥️", "시스템"], light: ["☀️", "라이트"], dark: ["🌙", "다크"] };
/** Same rule as src/config.ts normalizeTheme: anything else → "system". */
export const normTheme = (v) => (THEMES.includes(v) ? v : "system");
/** Current <html data-theme> (absent → "system"). */
export const currentTheme = (doc = document) => normTheme(doc.documentElement.dataset.theme);
/** Set <html data-theme>; save → also cache it for the next boot's <head> script. */
export function applyTheme(t, { save = false, doc = document, store = globalThis.localStorage } = {}) {
  const v = normTheme(t);
  doc.documentElement.dataset.theme = v;
  if (save) try { store?.setItem(THEME_KEY, v); } catch {}
  return v;
}
/** After GET/PUT /api/config: the server value wins (an older daemon sends no theme → keep what's applied). */
export function syncTheme(dashboard, opts) {
  if (!dashboard || dashboard.theme === undefined) return currentTheme(opts?.doc);
  return applyTheme(dashboard.theme, { ...opts, save: true });
}
/** Settings → 외형: three radios (name="c-theme"), `cur` checked. */
export function themeHtml(cur) {
  const sel = normTheme(cur);
  return THEMES.map((t) => `<label><input type="radio" name="c-theme" value="${t}"${t === sel ? " checked" : ""}><span class="thic" aria-hidden="true">${THEME_LABEL[t][0]}</span>${THEME_LABEL[t][1]}</label>`).join("");
}
