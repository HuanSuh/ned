/**
 * POST /api/attention/:id/review for source keys: malformed → 400, Slack ✓ lands in /api/agenda `reviewed` (base key)
 * and in the thread's seen_reply_ts (newest known ts), old `@…` keys are stored under the base key, mail / Jira keys
 * are untouched. Same no-network harness as server.test.ts.
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { loadConfig } = await import("../src/config.js");
const { CONFIG_PATH, REVIEWED_PATH } = await import("../src/paths.js");
const { patchAgenda, readAgenda } = await import("../src/agenda.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const review = (key: string, reviewed = true) => request(`/api/attention/${encodeURIComponent(key)}/review`, json("POST", { reviewed }));

const ROOT = "1794193000.000100", SEARCH = "1794193600.000100";

beforeAll(() => {
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { slack: true, gmail: true, jira: true, github: false, calendar: false, sentry: false } }));
  startServer(() => loadConfig());
});

describe("POST /api/attention/:id/review — source keys", () => {
  it("400 for an empty / malformed source key", async () => {
    for (const k of ["slack:", "mail:", "jira: x", " "]) expect((await review(k)).status, k).toBe(400);
  });

  it("Slack ✓ → /api/agenda reviewed (base key) + thread seen = the mark time; mail / Jira keys untouched", async () => {
    const M = Date.now() - 60_000, J = Date.now() - 30_000; // inside setReviewed's 30-day keep window
    fs.writeFileSync(REVIEWED_PATH, JSON.stringify({ "mail:th1": M, "jira:AB-1": J }));
    patchAgenda((a) => {
      a.slack = {
        summary: "", items: [], watch: [],
        all: [{ channel: "#dev", from: "Kim", text: "배포?", url: `https://x.slack.com/archives/C1/p${ROOT.replace(".", "")}`, ts: new Date(Number(ROOT) * 1000).toISOString(), reason: "mention", answered: true }],
        threads: [{ key: `C1:${ROOT}`, channel_id: "C1", thread_ts: ROOT, channel: "#dev", url: "", prio: 1, first_seen_at: "", reply_count: 1, new_since_me: 1, participants: [], recent: [], last_reply_ts: ROOT, search_latest_ts: SEARCH, my_last_reply_ts: ROOT }],
      };
    });
    const r = await review(`slack:C1:${ROOT}@${ROOT}`); // an old-style key from a stale tab
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.id).toBe(`slack:C1:${ROOT}`);
    const ag = await (await request("/api/agenda")).json();
    expect(ag.reviewed[`slack:C1:${ROOT}`]).toBe(body.reviewed_at);
    expect(Object.keys(ag.reviewed).some((k: string) => k.includes("@"))).toBe(false);
    expect(ag.reviewed["mail:th1"]).toBe(M);
    expect(ag.reviewed["jira:AB-1"]).toBe(J);
    // seen = the mark itself (same instant the ✓ rule compares), Slack ts format
    expect(readAgenda().slack?.threads?.[0].seen_reply_ts).toBe((body.reviewed_at / 1000).toFixed(6));
    expect(readAgenda().slack?.items ?? []).toHaveLength(0); // not reopened as 새 답글
    // un-review clears both
    expect((await review(`slack:C1:${ROOT}`, false)).status).toBe(200);
    expect((await (await request("/api/agenda")).json()).reviewed[`slack:C1:${ROOT}`]).toBeUndefined();
    expect(readAgenda().slack?.threads?.[0].seen_reply_ts).toBeUndefined();
  });
});
