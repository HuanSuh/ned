import fs from "node:fs";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENDA_PATH, TODOS_PATH } from "../src/paths.js";
import { registerSearch, scoreFields, search, tokenize } from "../src/search.js";

const NOW = 1_762_400_000_000;

describe("tokenize / scoreFields", () => {
  it("tokenize lower-cases, splits on whitespace, caps at 8", () => {
    expect(tokenize("  Foo   BAR ")).toEqual(["foo", "bar"]);
    expect(tokenize("a b c d e f g h i j")).toHaveLength(8);
    expect(tokenize("   ")).toEqual([]);
  });

  it("prefix > word start > substring", () => {
    const s = (text: string) => scoreFields([[text, 1]], ["deploy"], null, NOW);
    expect(s("deploy failed")).toBe(6);
    expect(s("prod-deploy failed")).toBe(4);
    expect(s("redeploy")).toBe(2);
    expect(s("nothing")).toBe(0);
  });

  it("weights multiply and every token must match (AND)", () => {
    expect(scoreFields([["release notes", 3], ["misc", 1]], ["release"], null, NOW)).toBe(18);
    expect(scoreFields([["release notes", 3]], ["release", "zzz"], null, NOW)).toBe(0);
  });

  it("초성 query matches Hangul initials", () => {
    expect(scoreFields([["배포 실패", 1]], ["ㅂㅍ"], null, NOW)).toBe(1.5);
  });

  it("recency bonus: <1 day +2, <7 days +1", () => {
    expect(scoreFields([["abc", 1]], ["abc"], NOW - 3_600_000, NOW)).toBe(8);
    expect(scoreFields([["abc", 1]], ["abc"], NOW - 3 * 86_400_000, NOW)).toBe(7);
    expect(scoreFields([["abc", 1]], ["abc"], NOW - 30 * 86_400_000, NOW)).toBe(6);
  });
});

describe("search over a temp NED_HOME", () => {
  beforeAll(() => {
    fs.writeFileSync(TODOS_PATH, JSON.stringify([{ id: "t1", title: "Quarterly report draft", done: false, created_at: Date.now(), done_at: null, due: null, note: null }]));
    fs.writeFileSync(
      AGENDA_PATH,
      JSON.stringify({ updated_at: 1, cost_usd: 0, calendar: [], github: [], jira: [{ key: "APP-42", title: "Fix report export", status: "To Do", priority: "High", due: null, url: "https://jira/APP-42", updated: new Date().toISOString() }], mail: null, slack: null }),
    );
  });

  it("finds todos and jira, best score first", () => {
    const hits = search("report");
    expect(hits.map((h) => h.type).sort()).toEqual(["jira", "todo"]);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  it("jira key match and empty query", () => {
    expect(search("app-42")[0]).toMatchObject({ type: "jira", id: "APP-42", url: "https://jira/APP-42" });
    expect(search("")).toEqual([]);
  });

  it("GET /api/search via Hono app.request (no network) clamps limit", async () => {
    const app = new Hono();
    registerSearch(app);
    const res = await app.request("/api/search?q=report&limit=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });
});
