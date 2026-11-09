/**
 * 링크를 앱으로 열기 — one rule table on both sides. src/links.ts is the definition, public/app/features/links.js a copy:
 * every fixture here runs through both.
 */
import { describe, expect, it } from "vitest";
import * as server from "../src/links.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import * as client from "../public/app/features/links.js";

const SIDES = [["server", server], ["client", client]] as const;
const T = "T0ABC1234";
const ON = { open_links_in_app: true, open_links_in_app_by_service: { slack: true, figma: true, notion: true } };
const ctx = { slackTeamId: T };

/** [web url, expected deep link with ON + team id]. */
const CASES: [string, string | null][] = [
  // Slack
  ["https://acme.slack.com/archives/C0123ABCD/p1794193614524359", `slack://channel?team=${T}&id=C0123ABCD&message=1794193614.524359`],
  ["https://acme.slack.com/archives/C0123ABCD/p1794193614524359?thread_ts=1794193470.379259&cid=C0123ABCD", `slack://channel?team=${T}&id=C0123ABCD&message=1794193614.524359&thread_ts=1794193470.379259`],
  ["https://acme.slack.com/archives/D087RE55D25/p1794193614524359", `slack://channel?team=${T}&id=D087RE55D25&message=1794193614.524359`],
  ["https://acme.slack.com/archives/G01PRIVATE/p1794193614524359", `slack://channel?team=${T}&id=G01PRIVATE&message=1794193614.524359`],
  ["https://acme.enterprise.slack.com/archives/C0123ABCD/p1794193614524359", `slack://channel?team=${T}&id=C0123ABCD&message=1794193614.524359`],
  ["https://acme.slack.com/archives/C0123ABCD", `slack://channel?team=${T}&id=C0123ABCD`],
  ["https://acme.slack.com/archives/C0123ABCD/p1794193614524359?thread_ts=junk", `slack://channel?team=${T}&id=C0123ABCD&message=1794193614.524359`],
  ["https://acme.slack.com/team/U0123", null],
  ["https://slack.com/archives/C0123ABCD/p1794193614524359", null],
  ["https://acme.slack.com.evil.io/archives/C0123ABCD/p1794193614524359", null],
  // Figma
  ["https://www.figma.com/design/AbC123xyz/My-File?node-id=12-34&t=zz", "figma://design/AbC123xyz/My-File?node-id=12-34&t=zz"],
  ["https://figma.com/file/AbC123xyz/Old-File", "figma://file/AbC123xyz/Old-File"],
  ["https://www.figma.com/board/AbC123xyz/Jam?node-id=0-1", "figma://board/AbC123xyz/Jam?node-id=0-1"],
  ["https://www.figma.com/proto/AbC123xyz/Proto?node-id=1-2&starting-point-node-id=1%3A2", "figma://proto/AbC123xyz/Proto?node-id=1-2&starting-point-node-id=1%3A2"],
  ["https://www.figma.com/design/AbC123xyz", "figma://design/AbC123xyz"],
  ["https://www.figma.com/files/recents-and-sharing", null],
  ["https://www.figma.com/community/file/123", null],
  ["https://www.figma.com/", null],
  // Notion
  ["https://www.notion.so/acme/Spec-0123456789abcdef0123456789abcdef", "notion://www.notion.so/acme/Spec-0123456789abcdef0123456789abcdef"],
  ["https://notion.so/0123456789abcdef0123456789abcdef?v=fedcba9876543210fedcba9876543210&pvs=4", "notion://www.notion.so/0123456789abcdef0123456789abcdef?v=fedcba9876543210fedcba9876543210&pvs=4"],
  ["https://acme.notion.site/Public-0123456789abcdef0123456789abcdef", null],
  ["https://www.notion.so/pricing", null],
  // Not ours / not a web URL
  ["https://github.com/o/r/pull/1", null],
  ["slack://channel?team=T0ABC1234&id=C1", null],
  ["javascript:alert(1)", null],
  ["not a url", null],
  ["https://", null],
  ["", null],
];

describe.each(SIDES)("%s: toDeepLink", (_name, m) => {
  it.each(CASES)("%s", (url, want) => {
    expect(m.toDeepLink(url, ON, ctx)).toBe(want);
  });

  it("Slack without a (valid) team id stays on the web; Figma / Notion don't need one", () => {
    const slack = "https://acme.slack.com/archives/C0123ABCD/p1794193614524359";
    expect(m.toDeepLink(slack, ON, {})).toBeNull();
    expect(m.toDeepLink(slack, ON, { slackTeamId: "" })).toBeNull();
    expect(m.toDeepLink(slack, ON, { slackTeamId: "t0abc1234" })).toBeNull();
    expect(m.toDeepLink(slack, ON)).toBeNull();
    expect(m.toDeepLink("https://www.figma.com/design/AbC/x", ON, {})).toBe("figma://design/AbC/x");
  });

  it("master off / service off → null; missing prefs = on", () => {
    const fig = "https://www.figma.com/design/AbC/x";
    const slack = "https://acme.slack.com/archives/C0123ABCD/p1794193614524359";
    expect(m.toDeepLink(fig, { ...ON, open_links_in_app: false }, ctx)).toBeNull();
    expect(m.toDeepLink(slack, { ...ON, open_links_in_app: false }, ctx)).toBeNull();
    expect(m.toDeepLink(fig, { open_links_in_app: true, open_links_in_app_by_service: { figma: false } }, ctx)).toBeNull();
    expect(m.toDeepLink(slack, { open_links_in_app: true, open_links_in_app_by_service: { figma: false } }, ctx)).toMatch(/^slack:\/\//);
    expect(m.toDeepLink(fig, undefined, ctx)).toBe("figma://design/AbC/x");
    expect(m.toDeepLink(fig, {}, ctx)).toBe("figma://design/AbC/x");
    expect(m.toDeepLink(fig, null, ctx)).toBe("figma://design/AbC/x");
  });

  it("non-string input → null; linkService ignores toggles", () => {
    for (const v of [undefined, null, 3, {}, []]) expect(m.toDeepLink(v, ON, ctx)).toBeNull();
    expect(m.linkService("https://acme.slack.com/archives/C1ABCDEF")).toBe("slack");
    expect(m.linkService("https://www.figma.com/board/AbC/x")).toBe("figma");
    expect(m.linkService("https://www.notion.so/0123456789abcdef0123456789abcdef")).toBe("notion");
    expect(m.linkService("https://github.com")).toBeNull();
    expect(m.linkService(42)).toBeNull();
  });

  it("slackTeamDomain: set → only <domain>(.enterprise).slack.com converts, other workspaces stay on the web; empty → all", () => {
    const mine = "https://acme.slack.com/archives/C0123ABCD/p1794193614524359";
    const ent = "https://ACME.enterprise.slack.com/archives/C0123ABCD/p1794193614524359";
    const other = "https://other-co.slack.com/archives/C0123ABCD/p1794193614524359";
    const want = `slack://channel?team=${T}&id=C0123ABCD&message=1794193614.524359`;
    const withDomain = { slackTeamId: T, slackTeamDomain: "acme" };
    expect(m.toDeepLink(mine, ON, withDomain)).toBe(want);
    expect(m.toDeepLink(ent, ON, withDomain)).toBe(want);
    expect(m.toDeepLink(other, ON, withDomain)).toBeNull();
    expect(m.toDeepLink("https://acme-other.slack.com/archives/C0123ABCD", ON, withDomain)).toBeNull();
    for (const d of ["", null, undefined]) {
      expect(m.toDeepLink(other, ON, { slackTeamId: T, slackTeamDomain: d })).toBe(want);
      expect(m.toDeepLink(mine, ON, { slackTeamId: T, slackTeamDomain: d })).toBe(want);
    }
    // domain alone (no team id) still can't build a slack:// link
    expect(m.toDeepLink(mine, ON, { slackTeamDomain: "acme" })).toBeNull();
    // Figma / Notion ignore it
    expect(m.toDeepLink("https://www.figma.com/design/AbC/x", ON, withDomain)).toBe("figma://design/AbC/x");
  });

  it("normalizeSlackTeamDomain", () => {
    expect(m.normalizeSlackTeamDomain(" ACME ")).toBe("acme");
    expect(m.normalizeSlackTeamDomain("acme-corp.slack.com")).toBe("acme-corp");
    expect(m.normalizeSlackTeamDomain("https://acme.enterprise.slack.com/")).toBe("acme");
    expect(m.normalizeSlackTeamDomain("")).toBe("");
    expect(m.normalizeSlackTeamDomain(null)).toBe("");
    expect(m.normalizeSlackTeamDomain("acme corp", "keep")).toBe("keep");
    expect(m.normalizeSlackTeamDomain("acme.example.com", "keep")).toBe("keep");
    expect(m.normalizeSlackTeamDomain(7, "keep")).toBe("keep");
    expect(m.linkCtxOf({ slack_team_id: T, slack_team_domain: "acme" })).toEqual({ slackTeamId: T, slackTeamDomain: "acme" });
  });

  it("normalizeSlackTeamId / linkCtxOf", () => {
    expect(m.normalizeSlackTeamId(" t0abc1234 ")).toBe("T0ABC1234");
    expect(m.normalizeSlackTeamId("")).toBe("");
    expect(m.normalizeSlackTeamId(null)).toBe("");
    expect(m.normalizeSlackTeamId(undefined)).toBe("");
    expect(m.normalizeSlackTeamId("T12", "TKEEP000")).toBe("TKEEP000");
    expect(m.normalizeSlackTeamId("C0123ABCD", "")).toBe("");
    expect(m.normalizeSlackTeamId("T0AB-123", "TOLD0000")).toBe("TOLD0000");
    expect(m.normalizeSlackTeamId(42, "TOLD0000")).toBe("TOLD0000");
    expect(m.linkCtxOf({ slack_team_id: T })).toEqual({ slackTeamId: T, slackTeamDomain: "" });
    expect(m.linkCtxOf(undefined)).toEqual({ slackTeamId: "", slackTeamDomain: "" });
  });
});

it("client copy has the same services and team-id rule", () => {
  expect(client.LINK_SERVICES).toEqual([...server.LINK_SERVICES]);
  expect(client.LINK_RULES.map((r: { service: string }) => r.service)).toEqual(server.LINK_RULES.map((r) => r.service));
  expect(String(client.SLACK_TEAM_ID_RE)).toBe(String(server.SLACK_TEAM_ID_RE));
  expect(String(client.SLACK_TEAM_DOMAIN_RE)).toBe(String(server.SLACK_TEAM_DOMAIN_RE));
});
