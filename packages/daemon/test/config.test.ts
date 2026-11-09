import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { CONFIG_PATH } from "../src/paths.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_DASHBOARD,
  DEFAULT_LAYOUT,
  inQuietHours,
  jqlExclude,
  loadConfig,
  isGroupId,
  mergeFilters,
  normalizeGroupMentions,
  normalizeAckReactions,
  normalizeActions,
  normalizeDashboard,
  normalizeFilters,
  normalizeHistory,
  normalizeNotifications,
  normalizePersona,
  normalizeTheme,
  saveConfig,
  watchChannels,
  type NedConfig,
} from "../src/config.js";

const write = (o: unknown) => fs.writeFileSync(CONFIG_PATH, YAML.stringify(o));
const at = (h: number, m = 0) => new Date(2026, 10, 6, h, m);

beforeEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("loadConfig", () => {
  it("creates config.yaml with defaults when missing", () => {
    const cfg = loadConfig();
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    expect(cfg.heartbeat_minutes).toBe(DEFAULT_CONFIG.heartbeat_minutes);
    expect(cfg.port).toBe(7791); // NED_PORT override from test/setup.ts
  });

  it("deep-merges sources: a partial block keeps the other defaults", () => {
    write({ sources: { slack: false } });
    const cfg = loadConfig();
    expect(cfg.sources).toEqual({ ...DEFAULT_CONFIG.sources, slack: false });
  });

  it("deep-merges actions / notifications and drops non-boolean junk", () => {
    write({ actions: { slack_send: true, gmail_send: "yes" }, notifications: { kinds: { slack: false }, summary_threshold: 999, quiet_delivery: "loud" } });
    const cfg = loadConfig();
    expect(cfg.actions).toEqual({ ...DEFAULT_CONFIG.actions, slack_send: true });
    expect(cfg.notifications.kinds.slack).toBe(false);
    expect(cfg.notifications.kinds.email).toBe(true);
    expect(cfg.notifications.summary_threshold).toBe(50);
    expect(cfg.notifications.quiet_delivery).toBe("skip");
  });

  it("filters merge per source and normalize (#, case, invalid keys)", () => {
    write({ filters: { slack: { exclude_channels: ["#random", " dev chat "] }, jira: { exclude_projects: ["mnt", "bad key", "IP2"] } } });
    const cfg = loadConfig();
    expect(cfg.filters.slack.exclude_channels).toEqual(["random", "devchat"]);
    expect(cfg.filters.slack.watch_channels).toEqual([]);
    expect(cfg.filters.slack.ack_reactions).toEqual(["white_check_mark", "eyes", "+1", "heavy_check_mark"]);
    expect(cfg.filters.jira.exclude_projects).toEqual(["MNT", "IP2"]);
  });

  it("clamps numeric agenda settings and keeps null light model", () => {
    write({ agenda_all_limit: 500, agenda_context_batch: 0, agenda_daily_budget_usd: "abc", agenda_light_model: null, draft_context_max_age_minutes: -5 });
    const cfg = loadConfig();
    expect(cfg.agenda_all_limit).toBe(50);
    expect(cfg.agenda_context_batch).toBe(1);
    expect(cfg.agenda_daily_budget_usd).toBe(DEFAULT_CONFIG.agenda_daily_budget_usd);
    expect(cfg.agenda_light_model).toBeNull();
    expect(cfg.draft_context_max_age_minutes).toBe(DEFAULT_CONFIG.draft_context_max_age_minutes);
  });

  it("unknown persona falls back to ned; empty file = defaults", () => {
    write({ persona: "batman" });
    expect(loadConfig().persona).toBe("ned");
    fs.writeFileSync(CONFIG_PATH, "");
    expect(loadConfig().sources).toEqual(DEFAULT_CONFIG.sources);
  });

  it("persona (hidden feature): default ned, invalid → ned, an existing non-ned choice is kept", () => {
    expect(DEFAULT_CONFIG.persona).toBe("ned");
    for (const bad of [undefined, null, "", 3, "NED", ["alfred"]]) expect(normalizePersona(bad)).toBe("ned");
    write({ heartbeat_minutes: 5 }); // no persona key
    expect(loadConfig().persona).toBe("ned");
    write({ persona: "alfred" });
    expect(loadConfig().persona).toBe("alfred");
    saveConfig({ ...loadConfig(), heartbeat_minutes: 7 }); // unrelated save doesn't reset it
    expect(YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")).persona).toBe("alfred");
    expect(loadConfig().persona).toBe("alfred");
  });

  it("saveConfig keeps the on-disk port while NED_PORT overrides", () => {
    write({ port: 7777 });
    saveConfig({ ...loadConfig(), heartbeat_minutes: 5 });
    const onDisk = YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    expect(onDisk.port).toBe(7777);
    expect(onDisk.heartbeat_minutes).toBe(5);
  });
});

describe("normalizers", () => {
  it("normalizeHistory: history.collect.slack_hours — default 24, integer 1..168, junk → base, partial patch keeps it", () => {
    expect(DEFAULT_CONFIG.history.collect).toEqual({ slack_hours: 24 });
    expect(normalizeHistory({}).collect.slack_hours).toBe(24);
    expect(normalizeHistory({ collect: { slack_hours: 96 } }).collect.slack_hours).toBe(96);
    expect(normalizeHistory({ collect: { slack_hours: 0 }, display: { slack_hours: 1 } }).collect.slack_hours).toBe(1);
    // never below the display window (incremental runs floor at it), and Slack keep ≥ the collect window in days
    expect(normalizeHistory({ collect: { slack_hours: 1 } }).collect.slack_hours).toBe(24);
    expect(normalizeHistory({ collect: { slack_hours: 6 }, display: { slack_hours: 48 } }).collect.slack_hours).toBe(48);
    expect(normalizeHistory({ collect: { slack_hours: 96 }, keep_days: { slack: 1 } }).keep_days.slack).toBe(4);
    expect(normalizeHistory({ collect: { slack_hours: 96 }, keep_days: { slack: 0 } }).keep_days.slack).toBe(0);
    expect(normalizeHistory({ collect: { slack_hours: 500 } }).collect.slack_hours).toBe(168);
    expect(normalizeHistory({ collect: { slack_hours: 36.6 } }).collect.slack_hours).toBe(37);
    for (const junk of ["", null, "abc", true]) expect(normalizeHistory({ collect: { slack_hours: junk } }).collect.slack_hours).toBe(24);
    const base = normalizeHistory({ collect: { slack_hours: 72 } });
    expect(normalizeHistory({ display: { slack_hours: 48 } }, base).collect.slack_hours).toBe(72);
    expect(normalizeHistory({ collect: { slack_hours: null } }, base).collect.slack_hours).toBe(72);
  });
  it("loadConfig reads history.collect.slack_hours from config.yaml", () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ history: { collect: { slack_hours: 96 } } }));
    expect(loadConfig().history.collect.slack_hours).toBe(96);
  });
  it("normalizeDashboard: dedupes, drops unknown ids, appends missing, validates spans", () => {
    const d = normalizeDashboard({ card_order: ["jira", "jira", "bogus", "mail"], card_span: { jira: 2, mail: 3 } });
    expect(d.card_order).toEqual(["jira", "mail", "slack", "github"]);
    expect(d.card_span.jira).toBe(2);
    expect(d.card_span.mail).toBe(1);
  });
  it("normalizeDashboard: layout absent keeps base, null clears, cells clamped to the grid + min sizes; locked boolean", () => {
    expect(normalizeDashboard({}).layout).toBeNull();
    expect(normalizeDashboard({}).locked).toBe(false);
    const base = normalizeDashboard({ layout: DEFAULT_LAYOUT, locked: true });
    expect(base.layout).toEqual(DEFAULT_LAYOUT);
    expect(normalizeDashboard({ card_order: ["mail"] }, base).layout).toEqual(DEFAULT_LAYOUT);
    expect(normalizeDashboard({ card_order: ["mail"] }, base).locked).toBe(true);
    expect(normalizeDashboard({ layout: null, locked: "yes" }, base)).toMatchObject({ layout: null, locked: true });
    const d = normalizeDashboard({ layout: { jira: { x: 11, y: -3, w: 4.7, h: 1 }, cal: { x: 0, y: 0, w: 99, h: 99 }, bogus: { x: 0, y: 0, w: 1, h: 1 }, mail: { x: "a" } } });
    expect(d.layout).toEqual({ jira: { x: 8, y: 0, w: 4, h: 2 }, cal: { x: 0, y: 0, w: 12, h: 48 } });
    expect(normalizeDashboard({ layout: { bogus: {} } }).layout).toBeNull();
  });
  it("normalizeDashboard: watch:<ch> ids only for followed channels (order / span / layout), new ones appended", () => {
    const watch = ["dev-ops", "release"];
    const d = normalizeDashboard({
      card_order: ["watch:release", "slack", "watch:gone", "WATCH:x", "watch:", "watch:#Dev-Ops", "mail"],
      card_span: { "watch:release": 2, "watch:gone": 2, "watch:dev-ops": 7 },
      layout: { slack: { x: 3, y: 0, w: 6, h: 4 }, "watch:release": { x: 3, y: 4, w: 1, h: 1 }, "watch:gone": { x: 0, y: 0, w: 3, h: 3 }, "watch:DEV-OPS": { x: 9, y: 0, w: 3, h: 4 } },
    }, DEFAULT_DASHBOARD, watch);
    // canonical spelling from the watch list; unknown / unfollowed / empty dropped; missing fixed cards appended
    expect(d.card_order).toEqual(["watch:release", "slack", "watch:dev-ops", "mail", "jira", "github"]);
    expect(d.card_span).toMatchObject({ "watch:release": 2, "watch:dev-ops": 1, slack: 2, mail: 1 });
    expect(d.card_span).not.toHaveProperty("watch:gone");
    expect(d.layout).toEqual({ slack: { x: 3, y: 0, w: 6, h: 4 }, "watch:release": { x: 3, y: 4, w: 2, h: 2 }, "watch:dev-ops": { x: 9, y: 0, w: 3, h: 4 } });
    expect(d.watch_cards).toBe(true);
    // a channel followed but not in card_order yet → appended after the fixed cards
    expect(normalizeDashboard({ card_order: ["mail"] }, DEFAULT_DASHBOARD, watch).card_order).toEqual(["mail", "slack", "jira", "github", "watch:dev-ops", "watch:release"]);
  });
  it("normalizeDashboard: unfollowing a channel drops its card from base too; watch_cards boolean else base's", () => {
    const base = normalizeDashboard({ layout: { ...DEFAULT_LAYOUT, "watch:release": { x: 3, y: 12, w: 3, h: 4 } }, watch_cards: false }, DEFAULT_DASHBOARD, ["release"]);
    expect(base.card_order).toContain("watch:release");
    expect(base.layout).toHaveProperty("watch:release");
    expect(base.watch_cards).toBe(false);
    const after = normalizeDashboard({}, base, []); // PUT with only filters: release no longer followed
    expect(after.card_order).toEqual(["slack", "mail", "jira", "github"]);
    expect(after.layout).toEqual(DEFAULT_LAYOUT);
    expect(after.card_span).not.toHaveProperty("watch:release");
    expect(after.watch_cards).toBe(false);
    expect(normalizeDashboard({ watch_cards: true }, base, []).watch_cards).toBe(true);
    expect(normalizeDashboard({ watch_cards: "no" }, base, []).watch_cards).toBe(false);
    expect(normalizeDashboard({}).watch_cards).toBe(true);
    // no watch list given → no watch ids at all
    expect(normalizeDashboard({ card_order: ["watch:release"] }).card_order).toEqual(["slack", "mail", "jira", "github"]);
  });
  it("normalizeTheme / normalizeDashboard.theme: system | light | dark, junk → system, absent keeps base's", () => {
    expect(DEFAULT_DASHBOARD.theme).toBe("system");
    expect(["system", "light", "dark", "Light", "", null, undefined, 1, {}].map(normalizeTheme)).toEqual(["system", "light", "dark", "system", "system", "system", "system", "system", "system"]);
    expect(normalizeDashboard({}).theme).toBe("system");
    expect(normalizeDashboard({ theme: "light" }).theme).toBe("light");
    expect(normalizeDashboard({ theme: "neon" }).theme).toBe("system");
    const dark = normalizeDashboard({ theme: "dark" });
    expect(normalizeDashboard({ locked: true }, dark).theme).toBe("dark"); // home lock / layout saves don't reset it
    expect(normalizeDashboard({ theme: "system" }, dark).theme).toBe("system");
    expect(normalizeDashboard({ theme: null }, dark).theme).toBe("system");
  });
  it("loadConfig: dashboard.theme from config.yaml, junk → system, missing → system", () => {
    write({ dashboard: { theme: "light" } });
    expect(loadConfig().dashboard.theme).toBe("light");
    write({ dashboard: { theme: "sepia" } });
    expect(loadConfig().dashboard.theme).toBe("system");
    write({ dashboard: { locked: true } });
    expect(loadConfig().dashboard.theme).toBe("system");
  });
  it("loadConfig keeps watch:<ch> only for followed, non-excluded channels", () => {
    write({
      filters: { slack: { watch_channels: ["release", "noise"], exclude_channels: ["noise"] } },
      dashboard: { card_order: ["watch:noise", "watch:release", "slack"], layout: { "watch:noise": { x: 0, y: 0, w: 3, h: 3 }, "watch:release": { x: 3, y: 4, w: 3, h: 4 } } },
    });
    const d = loadConfig().dashboard;
    expect(d.card_order).toEqual(["watch:release", "slack", "mail", "jira", "github"]);
    expect(Object.keys(d.layout ?? {})).toEqual(["watch:release"]);
  });
  it("normalizeActions ignores non-objects", () => {
    expect(normalizeActions("x")).toEqual(DEFAULT_CONFIG.actions);
  });
  it("normalizeActions: gmail_mark_read defaults off, takes a boolean, keeps base on junk", () => {
    expect(DEFAULT_CONFIG.actions.gmail_mark_read).toBe(false);
    expect(normalizeActions({}).gmail_mark_read).toBe(false);
    const on = normalizeActions({ gmail_mark_read: true });
    expect(on.gmail_mark_read).toBe(true);
    expect(normalizeActions({ gmail_mark_read: "yes" }, on).gmail_mark_read).toBe(true);
    expect(normalizeActions({ gmail_mark_read: false }, on).gmail_mark_read).toBe(false);
  });
  it("normalizeNotifications truncates threshold", () => {
    expect(normalizeNotifications({ summary_threshold: 4.9 }).summary_threshold).toBe(4);
  });
  it("mergeFilters: a patch with only slack keeps jira", () => {
    const cur = normalizeFilters({ slack: { exclude_channels: ["a"] }, jira: { exclude_projects: ["MNT"] } });
    const next = mergeFilters(cur, { slack: { watch_channels: ["#ops"] } });
    expect(next).toEqual({ slack: { exclude_channels: ["a"], watch_channels: ["ops"], ack_reactions: ["white_check_mark", "eyes", "+1", "heavy_check_mark"], ack_check_max: 3, group_mentions: [] }, jira: { exclude_projects: ["MNT"] } });
  });
  it("ack_check_max: default 3, clamped to 1..8, junk → default, survives a patch without it", () => {
    expect(normalizeFilters({}).slack.ack_check_max).toBe(3);
    expect(normalizeFilters({ slack: { ack_check_max: 0 } }).slack.ack_check_max).toBe(1);
    expect(normalizeFilters({ slack: { ack_check_max: 99 } }).slack.ack_check_max).toBe(8);
    expect(normalizeFilters({ slack: { ack_check_max: "x" } }).slack.ack_check_max).toBe(3);
    expect(normalizeFilters({ slack: { ack_check_max: null } }).slack.ack_check_max).toBe(3);
    const cur = mergeFilters(normalizeFilters({}), { slack: { ack_check_max: 5 } });
    expect(cur.slack.ack_check_max).toBe(5);
    expect(mergeFilters(cur, { slack: { exclude_channels: ["x"] } }).slack.ack_check_max).toBe(5);
  });
  it("ack_reactions: absent → defaults, explicit [] stays off, colons/case stripped, junk dropped, deduped, capped", () => {
    expect(normalizeFilters({}).slack.ack_reactions).toEqual(["white_check_mark", "eyes", "+1", "heavy_check_mark"]);
    expect(normalizeFilters({ slack: { ack_reactions: [] } }).slack.ack_reactions).toEqual([]);
    expect(normalizeAckReactions([":White_Check_Mark:", " eyes ", ":+1:", "eyes", "bad emoji", "", 3, "::", "skin-tone-2", ":통신보안:", "a:b"])).toEqual(["white_check_mark", "eyes", "+1", "skin-tone-2", "통신보안"]);
    expect(normalizeAckReactions(":done:, :Eyes:")).toEqual(["done", "eyes"]);
    expect(normalizeAckReactions(Array.from({ length: 12 }, (_, i) => `e${i}`))).toHaveLength(8);
  });
  it("mergeFilters: ack_reactions replaces as a list and survives a patch without it", () => {
    const cur = mergeFilters(normalizeFilters({}), { slack: { ack_reactions: [":ok_hand:"] } });
    expect(cur.slack.ack_reactions).toEqual(["ok_hand"]);
    expect(mergeFilters(cur, { slack: { exclude_channels: ["x"] } }).slack.ack_reactions).toEqual(["ok_hand"]);
    expect(mergeFilters(cur, { slack: { ack_reactions: [] } }).slack.ack_reactions).toEqual([]);
  });
  it("group_mentions: default [], leading @ and spaces stripped, IDs kept as typed, junk dropped, deduped, capped at 8", () => {
    expect(normalizeFilters({}).slack.group_mentions).toEqual([]);
    expect(normalizeGroupMentions(["@mobile-dev", " mobile-dev ", "S0ABC1234", "@@ios team", "bad<tag>", "", 3, "@", "모바일_팀"])).toEqual(["mobile-dev", "S0ABC1234", "iosteam", "모바일_팀"]);
    expect(normalizeGroupMentions("@a, b  @a")).toEqual(["a", "b"]);
    expect(normalizeGroupMentions(["s0abc1234", "S0ABC1234", "@Mobile-Dev", "mobile-dev", "sales"])).toEqual(["S0ABC1234", "mobile-dev", "sales"]);
    expect(normalizeGroupMentions(Array.from({ length: 12 }, (_, i) => `g${i}`))).toHaveLength(8);
    expect(isGroupId("S0ABC1234")).toBe(true);
    expect(isGroupId("mobile-dev")).toBe(false);
    expect(isGroupId("SALES")).toBe(false);
    const cur = mergeFilters(normalizeFilters({}), { slack: { group_mentions: ["@mobile-dev"] } });
    expect(cur.slack.group_mentions).toEqual(["mobile-dev"]);
    expect(mergeFilters(cur, { slack: { exclude_channels: ["x"] } }).slack.group_mentions).toEqual(["mobile-dev"]);
    expect(mergeFilters(cur, { slack: { group_mentions: [] } }).slack.group_mentions).toEqual([]);
  });
  it("watchChannels removes excluded channels case-insensitively; jqlExclude formats", () => {
    const f = normalizeFilters({ slack: { exclude_channels: ["OPS"], watch_channels: ["ops", "dev"] }, jira: { exclude_projects: ["A", "B"] } });
    expect(watchChannels(f)).toEqual(["dev"]);
    expect(jqlExclude(f)).toBe("AND project NOT IN (A, B)");
    expect(jqlExclude(normalizeFilters({}))).toBe("");
  });
});

describe("inQuietHours", () => {
  const cfg = (qh: NedConfig["quiet_hours"]) => ({ ...DEFAULT_CONFIG, quiet_hours: qh });
  it("wraps midnight (23:00 → 08:00)", () => {
    const c = cfg({ start: "23:00", end: "08:00" });
    expect(inQuietHours(c, at(23, 0))).toBe(true);
    expect(inQuietHours(c, at(2, 30))).toBe(true);
    expect(inQuietHours(c, at(7, 59))).toBe(true);
    expect(inQuietHours(c, at(8, 0))).toBe(false);
    expect(inQuietHours(c, at(22, 59))).toBe(false);
    expect(inQuietHours(c, at(12, 0))).toBe(false);
  });
  it("same-day window (12:00 → 13:30), end exclusive", () => {
    const c = cfg({ start: "12:00", end: "13:30" });
    expect(inQuietHours(c, at(12, 0))).toBe(true);
    expect(inQuietHours(c, at(13, 29))).toBe(true);
    expect(inQuietHours(c, at(13, 30))).toBe(false);
    expect(inQuietHours(c, at(11, 59))).toBe(false);
  });
  it("null quiet_hours is never quiet; start == end is an empty window", () => {
    expect(inQuietHours(cfg(null), at(3))).toBe(false);
    expect(inQuietHours(cfg({ start: "09:00", end: "09:00" }), at(9))).toBe(false);
  });
});

describe("known bugs (see test/BUGS.md) — it.fails passes while the bug exists", () => {
  it("BUG-1 (fixed): a partial quiet_hours block in config.yaml makes inQuietHours throw", () => {
    write({ quiet_hours: { start: "23:00" } });
    expect(() => inQuietHours(loadConfig(), at(1))).not.toThrow();
  });
});
