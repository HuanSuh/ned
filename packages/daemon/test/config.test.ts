import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { CONFIG_PATH } from "../src/paths.js";
import {
  DEFAULT_CONFIG,
  inQuietHours,
  jqlExclude,
  loadConfig,
  mergeFilters,
  normalizeActions,
  normalizeDashboard,
  normalizeFilters,
  normalizeNotifications,
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

  it("saveConfig keeps the on-disk port while NED_PORT overrides", () => {
    write({ port: 7777 });
    saveConfig({ ...loadConfig(), heartbeat_minutes: 5 });
    const onDisk = YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    expect(onDisk.port).toBe(7777);
    expect(onDisk.heartbeat_minutes).toBe(5);
  });
});

describe("normalizers", () => {
  it("normalizeDashboard: dedupes, drops unknown ids, appends missing, validates spans", () => {
    const d = normalizeDashboard({ card_order: ["jira", "jira", "bogus", "mail"], card_span: { jira: 2, mail: 3 } });
    expect(d.card_order).toEqual(["jira", "mail", "slack", "github"]);
    expect(d.card_span.jira).toBe(2);
    expect(d.card_span.mail).toBe(1);
  });
  it("normalizeActions ignores non-objects", () => {
    expect(normalizeActions("x")).toEqual(DEFAULT_CONFIG.actions);
  });
  it("normalizeNotifications truncates threshold", () => {
    expect(normalizeNotifications({ summary_threshold: 4.9 }).summary_threshold).toBe(4);
  });
  it("mergeFilters: a patch with only slack keeps jira", () => {
    const cur = normalizeFilters({ slack: { exclude_channels: ["a"] }, jira: { exclude_projects: ["MNT"] } });
    const next = mergeFilters(cur, { slack: { watch_channels: ["#ops"] } });
    expect(next).toEqual({ slack: { exclude_channels: ["a"], watch_channels: ["ops"] }, jira: { exclude_projects: ["MNT"] } });
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
