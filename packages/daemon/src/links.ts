/**
 * 링크를 앱으로 열기 — web URL → app deep link (Slack · Figma · Notion). Pure, no imports: this file is the single
 * definition, public/app/features/links.js a line-for-line copy; test/links-shared.test.ts runs both on the same fixtures.
 * A new service = one more entry in LINK_RULES (+ its toggle key in LINK_SERVICES).
 *
 * - Slack  https://<ws>.slack.com/archives/<C|D|G…>/p<ts10><ts6>[?thread_ts=<x>&cid=<C>]
 *          → slack://channel?team=<T>&id=<C>&message=<ts10>.<ts6>[&thread_ts=<x>]   (no team id → null = stay on the web)
 *          A channel link without a message (…/archives/<C>) → slack://channel?team=<T>&id=<C>.
 *          ctx.slackTeamDomain set → only <domain>(.enterprise).slack.com converts; empty → every *.slack.com.
 * - Figma  https://(www.)figma.com/(design|file|board|proto)/<key>[/<name>][?node-id=…] → figma://<same path>[?<same query>]
 * - Notion https://(www.)notion.(so|com)/<path with a page id — 32 hex or 8-4-4-4-12>[?…][#block] → notion://www.notion.so/<path>[?…][#block]
 *          <ws>.notion.site (public sites) is NOT converted: the page may not be in the user's workspace, the web view works.
 */

export const LINK_SERVICES = ["slack", "figma", "notion"] as const;
export type LinkService = (typeof LINK_SERVICES)[number];

/** Slack workspace (team) id: "T" + 6 or more upper-case letters / digits. */
export const SLACK_TEAM_ID_RE = /^T[A-Z0-9]{6,}$/;

/** The dashboard settings toggles read here (config.dashboard). Missing keys = on. */
export interface LinkPrefs {
  open_links_in_app?: boolean;
  open_links_in_app_by_service?: Partial<Record<LinkService, boolean>>;
}
export interface LinkCtx {
  slackTeamId?: string | null;
  /** "<name>" of <name>.slack.com: when set, only that workspace's links convert (others stay on the web). */
  slackTeamDomain?: string | null;
}
export interface LinkRule {
  service: LinkService;
  match(url: URL): boolean;
  toDeep(url: URL, ctx: LinkCtx): string | null;
}

const SLACK_HOST_RE = /^[a-z0-9-]+(\.enterprise)?\.slack\.com$/i;
const SLACK_PATH_RE = /^\/archives\/([CDG][A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?\/?$/;
const SLACK_TS_RE = /^\d{10}\.\d{6}$/;
/** Slack workspace subdomain ("acme" of acme.slack.com). */
export const SLACK_TEAM_DOMAIN_RE = /^[a-z0-9-]+$/;
const slackHostIs = (host: string, domain: string) => {
  const h = host.toLowerCase(), d = domain.toLowerCase();
  return h === `${d}.slack.com` || h === `${d}.enterprise.slack.com`;
};
const FIGMA_HOST_RE = /^(www\.)?figma\.com$/i;
const FIGMA_PATH_RE = /^\/(design|file|board|proto)\/[A-Za-z0-9]+(\/|$)/;
const NOTION_HOST_RE = /^(www\.)?notion\.(so|com)$/i;
/** A page / database id: 32 hex, or the dashed 8-4-4-4-12 form. */
const NOTION_ID_RE = /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const LINK_RULES: readonly LinkRule[] = [
  {
    service: "slack",
    match: (u) => SLACK_HOST_RE.test(u.hostname) && SLACK_PATH_RE.test(u.pathname),
    toDeep: (u, ctx) => {
      const team = ctx?.slackTeamId;
      if (typeof team !== "string" || !SLACK_TEAM_ID_RE.test(team)) return null;
      // Another workspace's link with my team id would open "channel not found" in the app — keep it on the web.
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
    toDeep: (u) => `notion://www.notion.so${u.pathname}${u.search}${u.hash}`, // #<block id> scrolls to the block
  },
];

/** http(s) URL → URL, anything else (other schemes, junk, non-strings) → null. */
function parseWeb(url: unknown): URL | null {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return null;
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

/** Which service a web URL belongs to (regardless of toggles / team id), else null. */
export function linkService(url: unknown): LinkService | null {
  const u = parseWeb(url);
  return u ? LINK_RULES.find((r) => r.match(u))?.service ?? null : null;
}

/** The app deep link for `url`, or null (= open the web URL): master toggle off, that service off, no rule, rule declined. */
export function toDeepLink(url: unknown, cfg: LinkPrefs | null | undefined, ctx: LinkCtx = {}): string | null {
  if (cfg?.open_links_in_app === false) return null;
  const u = parseWeb(url);
  if (!u) return null;
  const rule = LINK_RULES.find((r) => r.match(u));
  if (!rule || cfg?.open_links_in_app_by_service?.[rule.service] === false) return null;
  return rule.toDeep(u, ctx ?? {});
}

/** ctx from config.dashboard (slack_team_id, slack_team_domain). */
export const linkCtxOf = (dashboard: { slack_team_id?: unknown; slack_team_domain?: unknown } | null | undefined): LinkCtx => ({
  slackTeamId: typeof dashboard?.slack_team_id === "string" ? dashboard.slack_team_id : "",
  slackTeamDomain: typeof dashboard?.slack_team_domain === "string" ? dashboard.slack_team_domain : "",
});

/**
 * " ACME " / "acme.slack.com" / "https://acme.enterprise.slack.com/" → "acme"; "" / null → ""; anything else that isn't
 * a subdomain (SLACK_TEAM_DOMAIN_RE after lower-casing and stripping scheme / .slack.com) → `fallback`.
 */
export function normalizeSlackTeamDomain(v: unknown, fallback = ""): string {
  if (v == null) return "";
  if (typeof v !== "string") return fallback;
  const d = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/(\.enterprise)?\.slack\.com$/, "");
  if (!d) return "";
  return SLACK_TEAM_DOMAIN_RE.test(d) ? d : fallback;
}

/** " t0abc123 " → "T0ABC123"; "" / null → ""; anything that isn't a team id → `fallback`. */
export function normalizeSlackTeamId(v: unknown, fallback = ""): string {
  if (v == null) return "";
  if (typeof v !== "string") return fallback;
  const t = v.trim().toUpperCase();
  if (!t) return "";
  return SLACK_TEAM_ID_RE.test(t) ? t : fallback;
}
