/**
 * 맡긴 일 (config.responsibilities): normalization, the heartbeat prompt section (absent when none is active — same prompt
 * as before), the answer parser (unknown id / status / url dropped, missing ones keep their rating) and the end-to-end
 * heartbeat that stores ratings in state.json even on NED_OK.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { Agenda } from "../src/agenda.js";
import { DEFAULT_CONFIG, activeResponsibilities, loadConfig, normalizeResponsibilities, normalizeUntil, responsibilitiesError, type NedConfig, type Responsibility } from "../src/config.js";
import { applyResponsibilityReport, buildHeartbeatPrompt, heartbeat, heartbeatWatchKey, promptUrls } from "../src/heartbeat.js";
import { AGENDA_PATH, CONFIG_PATH, SENT_LOG, STATE_PATH, localDay, writeJsonAtomic } from "../src/paths.js";
import { mergeConfigPatch } from "../src/server.js";
import { readState } from "../src/state.js";

const cfgWith = (responsibilities: Responsibility[], over: Partial<NedConfig> = {}): NedConfig => ({ ...DEFAULT_CONFIG, ...over, responsibilities });
const R = (over: Partial<Responsibility> = {}): Responsibility => ({ id: "rel-05-ab12", title: "0.5 릴리스 막히는 것", goal: "이번 주 0.5 릴리스를 막는 이슈·리뷰를 챙긴다", enabled: true, ...over });
const emptyState = () => ({ ...readState(), sessions: [], responsibilities: {} });
const tomorrow = () => localDay(new Date(Date.now() + 24 * 3600_000));
const yesterday = () => localDay(new Date(Date.now() - 24 * 3600_000));

describe("normalizeResponsibilities", () => {
  it("not a list → []; non-objects and title-less entries dropped; at most 5", () => {
    expect(normalizeResponsibilities(undefined)).toEqual([]);
    expect(normalizeResponsibilities({ title: "x" })).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `일 ${i}` }));
    const out = normalizeResponsibilities([null, "x", { goal: "no title" }, { title: "   " }, ...many]);
    expect(out).toHaveLength(5);
    expect(out.map((r) => r.title)).toEqual(["일 0", "일 1", "일 2", "일 3", "일 4"]);
  });

  it("title one line ≤ 60, goal ≤ 300, enabled defaults true, booleans only", () => {
    const [r] = normalizeResponsibilities([{ title: `  a\n b  ${"가".repeat(80)}`, goal: "g".repeat(400), enabled: "no" }]);
    expect(r.title.length).toBe(60);
    expect(r.title.startsWith("a b ")).toBe(true);
    expect(r.goal.length).toBe(300);
    expect(r.enabled).toBe(true);
    expect(normalizeResponsibilities([{ title: "t", enabled: false }])[0].enabled).toBe(false);
  });

  it("sources: known only (none left → omitted = all); keywords trimmed, deduped, ≤ 10, a string splits on commas", () => {
    const [a, b] = normalizeResponsibilities([
      { title: "a", sources: ["jira", "bogus", "slack", "jira"], keywords: [" 0.5 ", "0.5", "", 3, ...Array.from({ length: 12 }, (_, i) => `k${i}`)] },
      { title: "b", sources: ["bogus"], keywords: "고객 A, 문의 ,," },
    ]);
    expect(a.sources).toEqual(["slack", "jira"]);
    expect(a.keywords).toEqual(["0.5", "k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"]);
    expect(b.sources).toBeUndefined();
    expect(b.keywords).toEqual(["고객 A", "문의"]);
  });

  it("until: a real YYYY-MM-DD only", () => {
    expect(normalizeUntil("2026-11-20")).toBe("2026-11-20");
    expect(normalizeUntil("2026-02-30")).toBeNull();
    expect(normalizeUntil("2026-1-2")).toBeNull();
    expect(normalizeUntil(20261120)).toBeNull();
    const [r, s] = normalizeResponsibilities([{ title: "a", until: "2026-11-20" }, { title: "b", until: "next week" }]);
    expect(r.until).toBe("2026-11-20");
    expect("until" in s).toBe(false);
  });

  it("ids: valid unique ones kept, missing / bad / repeated ones generated (stable from the title on load)", () => {
    const out = normalizeResponsibilities([{ id: "keep-me", title: "A" }, { id: "keep-me", title: "Release 0.5" }, { id: "Bad Id!", title: "고객 문의" }]);
    expect(out[0].id).toBe("keep-me");
    expect(out[1].id).toMatch(/^release-0-5-[a-z0-9]{4}$/);
    expect(out[2].id).toMatch(/^r-[a-z0-9]{4}$/);
    expect(new Set(out.map((r) => r.id)).size).toBe(3);
    const x = normalizeResponsibilities([{ title: "Release 0.5" }], { stableIds: true })[0].id;
    expect(normalizeResponsibilities([{ title: "Release 0.5" }], { stableIds: true })[0].id).toBe(x);
  });

  it("PUT guard: > 5, not a list, or a missing title → error; absent → null", () => {
    expect(responsibilitiesError(undefined)).toBeNull();
    expect(responsibilitiesError([{ title: "a" }])).toBeNull();
    expect(responsibilitiesError("x")).toMatch(/목록/);
    expect(responsibilitiesError(Array.from({ length: 6 }, () => ({ title: "a" })))).toMatch(/5개/);
    expect(responsibilitiesError([{ title: " " }])).toMatch(/제목/);
  });

  it("config.yaml round trip + PUT merge (array replaces, ids kept, new ones get one)", () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ responsibilities: [{ title: "고객 A 문의 후속", sources: ["mail"] }] }));
    const cur = loadConfig();
    expect(cur.responsibilities).toHaveLength(1);
    expect(loadConfig().responsibilities[0].id).toBe(cur.responsibilities[0].id); // stable across reads
    const merged = mergeConfigPatch(cur, { responsibilities: [...cur.responsibilities, { title: "새 일", goal: "g", enabled: true } as Responsibility] });
    expect(merged.responsibilities[0].id).toBe(cur.responsibilities[0].id);
    expect(merged.responsibilities[1].id).toMatch(/^r-[a-z0-9]{4}$/);
    expect(mergeConfigPatch(cur, { heartbeat_minutes: 5 }).responsibilities).toEqual(cur.responsibilities);
    expect(DEFAULT_CONFIG.responsibilities).toEqual([]);
  });

  it("active = enabled and not past until (inclusive)", () => {
    const list = [R({ id: "a" }), R({ id: "b", enabled: false }), R({ id: "c", until: yesterday() }), R({ id: "d", until: localDay() }), R({ id: "e", until: tomorrow() })];
    expect(activeResponsibilities(cfgWith(list)).map((r) => r.id)).toEqual(["a", "d", "e"]);
  });
});

const AGENDA: Agenda = {
  updated_at: Date.now(),
  calendar: [],
  jira: [{ key: "REL-9", title: "0.5 빌드 실패", status: "In Progress", priority: "High", due: null, updated: new Date().toISOString(), url: "https://acme.atlassian.net/browse/REL-9" }],
  github: [{ repo: "acme/app", number: 42, title: "Release 0.5 PR", author: "kim", reason: "review_requested", updated: new Date().toISOString(), url: "https://github.com/acme/app/pull/42" }],
  mail: null,
  slack: null,
} as unknown as Agenda;

describe("heartbeat prompt — 맡긴 일 section", () => {
  beforeEach(() => fs.rmSync(SENT_LOG, { force: true }));
  const original = () => fs.readFileSync(new URL("../../../prompts/heartbeat.md", import.meta.url), "utf8");

  it("no active responsibility → no section, no schema field, no leftover markers", () => {
    for (const list of [[], [R({ enabled: false })], [R({ until: yesterday() })]]) {
      const p = buildHeartbeatPrompt(cfgWith(list), false, emptyState(), [], AGENDA);
      expect(p).not.toContain("맡긴 일");
      expect(p).not.toContain("responsibilities");
      expect(p).not.toMatch(/\{\{[#/]?[A-Z_]+\}\}/);
    }
    // The template minus its blocks is the pre-feature template: same prompt, same cost.
    const stripped = original().replace(/\{\{#RESP\}\}[\s\S]*?\{\{\/RESP\}\}/g, "");
    expect(stripped).not.toContain("RESP");
    expect(stripped).toContain("{{ALREADY_SENT}}\n\n## 출력 스키마");
    expect(stripped).toContain('"detail": "무엇을 했고 다음 결정은 무엇인지" } ]\n}');
  });

  it("active ones → section with id, title, goal, until, sources (only switched-on) and keywords, plus the schema field", () => {
    const list = [
      R({ sources: ["jira", "github", "mail"], keywords: ["0.5", "릴리스"], until: tomorrow() }),
      R({ id: "cust-a-1x2y", title: "고객 A 문의 후속", goal: "", sources: undefined }),
      R({ id: "off-one", title: "꺼진 일", enabled: false }),
    ];
    const p = buildHeartbeatPrompt(cfgWith(list, { sources: { ...DEFAULT_CONFIG.sources, gmail: false } }), false, emptyState(), [], AGENDA);
    expect(p).toContain("### 맡긴 일");
    expect(p).toContain("id `rel-05-ab12` · **0.5 릴리스 막히는 것**");
    expect(p).toContain(`(~${tomorrow()}까지)`);
    expect(p).toContain("챙길 것: 이번 주 0.5 릴리스를 막는 이슈·리뷰를 챙긴다");
    expect(p).toContain("볼 곳: Jira, GitHub\n"); // mail asked for, but Gmail is off
    expect(p).toContain("키워드: 0.5, 릴리스");
    expect(p).toContain("id `cust-a-1x2y`");
    expect(p).toContain("볼 곳: Slack, Jira, GitHub, 캘린더, 세션"); // omitted = all (switched-on)
    expect(p).not.toContain("off-one");
    expect(p).toContain('"responsibilities": [');
    expect(p).toMatch(/NED_OK.*responsibilities/);
    expect(p).not.toMatch(/\{\{[#/]?[A-Z_]+\}\}/);
  });

  it("the last rating is shown so the model stays consistent", () => {
    const st = { ...emptyState(), responsibilities: { "rel-05-ab12": { status: "watch" as const, note: "PR 리뷰 대기 중", urls: [], updated_at: Date.now() - 30 * 60_000 } } };
    const p = buildHeartbeatPrompt(cfgWith([R()]), false, st, [], AGENDA);
    expect(p).toContain("지난 평가: watch — PR 리뷰 대기 중 (30분 전)");
  });

  it("watch key moves when a responsibility is added, and is unchanged without any", () => {
    const none = heartbeatWatchKey(cfgWith([]), AGENDA);
    expect(JSON.parse(none)).toEqual({ cal: [], th: [] });
    expect(heartbeatWatchKey(cfgWith([R()]), AGENDA)).not.toBe(none);
  });
});

describe("applyResponsibilityReport", () => {
  const active = [R({ id: "a" }), R({ id: "b" })];
  const allowed = new Set(["https://acme.atlassian.net/browse/REL-9", "https://github.com/acme/app/pull/42"]);
  const prev = { b: { status: "watch" as const, note: "old", urls: [], updated_at: 1 }, gone: { status: "blocked" as const, note: "x", urls: [], updated_at: 1 } };

  it("drops unknown ids, bad statuses, repeats and links not in the 업무 목록; keeps missing ones as they were", () => {
    const out = applyResponsibilityReport(prev, [
      { id: "a", status: "blocked", note: "  빌드가\n깨졌어 ", urls: ["https://evil.example/x", "HTTPS://GITHUB.COM/acme/app/pull/42", "https://acme.atlassian.net/browse/REL-9", "https://github.com/acme/app/pull/42", 7] },
      { id: "a", status: "on_track", note: "second" },
      { id: "zzz", status: "watch", note: "unknown" },
      { id: "b", status: "great", note: "bad status" },
      null,
    ], active, allowed, 1000, ["a", "b"]);
    expect(out.a).toEqual({ status: "blocked", note: "빌드가 깨졌어", urls: ["https://github.com/acme/app/pull/42", "https://acme.atlassian.net/browse/REL-9"], updated_at: 1000 });
    expect(out.b).toEqual(prev.b); // bad status → previous rating kept, updated_at untouched
    expect(out).not.toHaveProperty("zzz");
    expect(out).not.toHaveProperty("gone"); // no longer in config
  });

  it("not a list → only the previous ratings (pruned to known ids)", () => {
    expect(applyResponsibilityReport(prev, "nope", active, allowed, 5, ["a", "b", "gone"])).toEqual(prev);
  });

  it("an inactive (ended / off) id is not rated even if the model answers it", () => {
    expect(applyResponsibilityReport({}, [{ id: "c", status: "watch", note: "n" }], active, allowed, 5, ["a", "b", "c"])).toEqual({});
  });

  it("promptUrls picks links out of digest lines (no trailing punctuation)", () => {
    expect([...promptUrls("- REL-9 [x] t https://a.example/b?c=1 (11/14 10:00) https://b.example/x.\n meet https://meet.example/abc ·")]).toEqual(["https://a.example/b?c=1", "https://b.example/x", "https://meet.example/abc"]);
  });
});

describe("heartbeat stores 맡긴 일 ratings (NED_NO_LLM, temp NED_HOME)", () => {
  beforeEach(() => {
    fs.rmSync(SENT_LOG, { force: true });
    fs.rmSync(STATE_PATH, { force: true });
    writeJsonAtomic(AGENDA_PATH, AGENDA);
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({
      notify: "off", quiet_hours: null, sources: { ...DEFAULT_CONFIG.sources, sentry: false },
      responsibilities: [{ id: "rel", title: "0.5 릴리스", goal: "막히는 것", enabled: true }, { id: "cust", title: "고객 A", goal: "후속", enabled: true }],
    }));
  });
  afterEach(() => {
    delete process.env.NED_NO_LLM_RESULT;
    fs.rmSync(AGENDA_PATH, { force: true });
  });

  it("NED_OK + responsibilities → saved; a later answer without one keeps the earlier rating", async () => {
    process.env.NED_NO_LLM_RESULT = JSON.stringify({
      status: "NED_OK",
      responsibilities: [
        { id: "rel", status: "blocked", note: "REL-9 빌드가 깨졌어.", urls: ["https://acme.atlassian.net/browse/REL-9", "https://not-in-agenda.example/1"] },
        { id: "cust", status: "on_track", note: "조용해.", urls: [] },
        { id: "ghost", status: "watch", note: "?" },
      ],
    });
    const b = (await heartbeat(loadConfig(), { force: true, agenda: "skip" }))!;
    expect(b.status).toBe("NED_OK");
    const s1 = readState().responsibilities!;
    expect(Object.keys(s1).sort()).toEqual(["cust", "rel"]);
    expect(s1.rel).toMatchObject({ status: "blocked", note: "REL-9 빌드가 깨졌어.", urls: ["https://acme.atlassian.net/browse/REL-9"] });
    expect(readState().attention.filter((a) => a.source !== "sessions")).toEqual([]); // no new attention kind, nothing on NED_OK

    process.env.NED_NO_LLM_RESULT = JSON.stringify({ status: "NED_OK", responsibilities: [{ id: "cust", status: "watch", note: "답이 늦어.", urls: [] }] });
    await heartbeat(loadConfig(), { force: true, agenda: "skip" });
    const s2 = readState().responsibilities!;
    expect(s2.rel).toEqual(s1.rel);
    expect(s2.cust.status).toBe("watch");
    expect(s2.cust.updated_at).toBeGreaterThanOrEqual(s1.cust.updated_at);
  });

  it("an unparsable answer leaves ratings alone", async () => {
    process.env.NED_NO_LLM_RESULT = JSON.stringify({ status: "NED_OK", responsibilities: [{ id: "rel", status: "watch", note: "n", urls: [] }] });
    await heartbeat(loadConfig(), { force: true, agenda: "skip" });
    process.env.NED_NO_LLM_RESULT = "not json at all";
    await heartbeat(loadConfig(), { force: true, agenda: "skip" });
    expect(readState().responsibilities?.rel.status).toBe("watch");
  });
});
