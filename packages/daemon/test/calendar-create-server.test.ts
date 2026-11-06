/** POST /api/calendar/events + GET /api/calendar/events/:id — routes only (serve mocked, no port), NED_NO_LLM / dry-run. */
import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const { CONFIG_PATH } = await import("../src/paths.js");
const { SENT_ACTIONS_LOG } = await import("../src/actions.js");
const { _resetSendJobs } = await import("../src/send-jobs.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const post = (body: unknown) => request("/api/calendar/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const setActions = (actions: Record<string, boolean>) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", actions }));
const good = { title: "1:1", date: "2026-11-09", start_time: "10:00", end_time: "10:30", attendees: "a@x.com" };
const logLines = () => (fs.existsSync(SENT_ACTIONS_LOG) ? fs.readFileSync(SENT_ACTIONS_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeAll(() => {
  startServer(() => loadConfig());
});
beforeEach(() => {
  _resetSendJobs();
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
});

describe("POST /api/calendar/events", () => {
  it("400 on bad input, before the gate and without logging", async () => {
    setActions({ calendar_create: true });
    for (const [b, msg] of [
      [{ ...good, title: "" }, "title required"],
      [{ ...good, end_time: "09:00" }, "end must be after start"],
      [{ ...good, attendees: "a@x.com, nope" }, "invalid attendee email"],
    ] as const) {
      const r = await post(b);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toContain(msg);
    }
    expect(logLines()).toHaveLength(0);
  });

  it("403 when calendar_create is off (default), logged as refused", async () => {
    setActions({ calendar_rsvp: true });
    const r = await post(good);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, action: "refused" });
    expect(logLines()).toEqual([expect.objectContaining({ source: "calendar", mode: "create", action: "refused", ok: false })]);
  });

  it("on → 202 job, polled to done (dry run under NED_NO_LLM), logged once", async () => {
    setActions({ calendar_create: true });
    const r = await post(good);
    expect(r.status).toBe(202);
    const { job_id } = await r.json();
    let j: { state: string; result?: Record<string, unknown> } = { state: "running" };
    for (let i = 0; i < 100 && j.state !== "done"; i++) {
      const g = await request(`/api/calendar/events/${job_id}`);
      expect(g.status).toBe(200);
      j = await g.json();
      if (j.state !== "done") await new Promise((res) => setTimeout(res, 10));
    }
    expect(j.state).toBe("done");
    expect(j.result).toMatchObject({ ok: false, http_status: 200 });
    expect(String(j.result!.action)).toMatch(/^dry_run:calendar_create/);
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toMatchObject({ source: "calendar", mode: "create", ref: { title: "1:1", calendar_id: "primary" } });
  });

  it("409 already_sent when the same title + time was created ok in the last 10 min", async () => {
    setActions({ calendar_create: true });
    fs.writeFileSync(SENT_ACTIONS_LOG, JSON.stringify({ ts: new Date().toISOString(), source: "calendar", mode: "create", action: "calendar_create", ref: {}, text: "", ok: true, result: "created e1 https://www.google.com/calendar/event?eid=e1 ($0.010)", event_key: "primary|T|2026-11-09T10:00|2026-11-09T10:30|1:1" }) + "\n");
    const r = await post(good);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ already_sent: true, link: "https://www.google.com/calendar/event?eid=e1" });
  });

  it("GET unknown job → 404; /api/send refuses mode=create", async () => {
    expect((await request("/api/calendar/events/nope")).status).toBe(404);
    const r = await request("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "calendar", mode: "create", ref: {} }) });
    expect(r.status).toBe(400);
  });
});
