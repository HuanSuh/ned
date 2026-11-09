/* 링크를 앱으로 열기 — copy of src/links.ts (the single definition); test/links-shared.test.ts runs both on the same
 * fixtures. Pure (no DOM, no imports). openlink.js does the opening; this only maps a web URL to an app deep link.
 * - Slack  https://<ws>.slack.com/archives/<C|D|G…>/p<ts10><ts6>[?thread_ts=<x>] → slack://channel?team=<T>&id=<C>&message=<ts>[&thread_ts=<x>]
 *          (no team id → null = stay on the web; …/archives/<C> → slack://channel?team=<T>&id=<C>;
 *          ctx.slackTeamDomain set → only <domain>(.enterprise).slack.com converts)
 * - Figma  https://(www.)figma.com/(design|file|board|proto)/<key>… → figma://<same path>[?<same query>]
 * - Notion https://(www.)notion.(so|com)/<path with a 32-hex or 8-4-4-4-12 id>[?…][#block] → notion://www.notion.so/<path>[?…][#block]
 *          (notion.site: not converted) */

export const LINK_SERVICES = ["slack", "figma", "notion"];
export const SLACK_TEAM_ID_RE = /^T[A-Z0-9]{6,}$/;

const SLACK_HOST_RE = /^[a-z0-9-]+(\.enterprise)?\.slack\.com$/i;
const SLACK_PATH_RE = /^\/archives\/([CDG][A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?\/?$/;
const SLACK_TS_RE = /^\d{10}\.\d{6}$/;
export const SLACK_TEAM_DOMAIN_RE = /^[a-z0-9-]+$/;
const slackHostIs = (host, domain) => {
  const h = host.toLowerCase(), d = domain.toLowerCase();
  return h === `${d}.slack.com` || h === `${d}.enterprise.slack.com`;
};
const FIGMA_HOST_RE = /^(www\.)?figma\.com$/i;
const FIGMA_PATH_RE = /^\/(design|file|board|proto)\/[A-Za-z0-9]+(\/|$)/;
const NOTION_HOST_RE = /^(www\.)?notion\.(so|com)$/i;
const NOTION_ID_RE = /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const LINK_RULES = [
  {
    service: "slack",
    match: (u) => SLACK_HOST_RE.test(u.hostname) && SLACK_PATH_RE.test(u.pathname),
    toDeep: (u, ctx) => {
      const team = ctx?.slackTeamId;
      if (typeof team !== "string" || !SLACK_TEAM_ID_RE.test(team)) return null;
      const domain = ctx?.slackTeamDomain;
      if (domain && !slackHostIs(u.hostname, domain)) return null;
      const m = SLACK_PATH_RE.exec(u.pathname);
      if (!m) return null;
      let out = `slack://channel?team=${team}&id=${m[1]}`;
      if (m[2]) out += `&message=${m[2]}.${m[3]}`;
      const thread = u.searchParams.get("thread_ts");
      if (m[2] && thread && SLACK_TS_RE.test(thread)) out += `&thread_ts=${thread}`;
      return out;
    },
  },
  {
    service: "figma",
    match: (u) => FIGMA_HOST_RE.test(u.hostname) && FIGMA_PATH_RE.test(u.pathname),
    toDeep: (u) => `figma://${u.pathname.slice(1)}${u.search}`,
  },
  {
    service: "notion",
    match: (u) => NOTION_HOST_RE.test(u.hostname) && NOTION_ID_RE.test(u.pathname),
    toDeep: (u) => `notion://www.notion.so${u.pathname}${u.search}${u.hash}`,
  },
];

function parseWeb(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return null;
  try { return new URL(url.trim()); } catch { return null; }
}

export function linkService(url) {
  const u = parseWeb(url);
  return u ? LINK_RULES.find((r) => r.match(u))?.service ?? null : null;
}

export function toDeepLink(url, cfg, ctx = {}) {
  if (cfg?.open_links_in_app === false) return null;
  const u = parseWeb(url);
  if (!u) return null;
  const rule = LINK_RULES.find((r) => r.match(u));
  if (!rule || cfg?.open_links_in_app_by_service?.[rule.service] === false) return null;
  return rule.toDeep(u, ctx ?? {});
}

export const linkCtxOf = (dashboard) => ({
  slackTeamId: typeof dashboard?.slack_team_id === "string" ? dashboard.slack_team_id : "",
  slackTeamDomain: typeof dashboard?.slack_team_domain === "string" ? dashboard.slack_team_domain : "",
});

export function normalizeSlackTeamDomain(v, fallback = "") {
  if (v == null) return "";
  if (typeof v !== "string") return fallback;
  const d = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/(\.enterprise)?\.slack\.com$/, "");
  if (!d) return "";
  return SLACK_TEAM_DOMAIN_RE.test(d) ? d : fallback;
}

export function normalizeSlackTeamId(v, fallback = "") {
  if (v == null) return "";
  if (typeof v !== "string") return fallback;
  const t = v.trim().toUpperCase();
  if (!t) return "";
  return SLACK_TEAM_ID_RE.test(t) ? t : fallback;
}
