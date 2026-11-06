/** Calendar event creation (src/calendar-create.ts + actions/send-jobs): input validation, create_event args, verify, gate, dedupe. */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SENT_ACTIONS_LOG, gateKey, performSend, readActionLog, type SendRequest, type SendResult } from "../src/actions.js";
import { buildCalendarCreate, createEventArgs, eventKey, parseCalendarCreate, verifyCreate, type CalendarEventInput } from "../src/calendar-create.js";
import { invalidateCalendarRanges } from "../src/calendar.js";
import { DEFAULT_ACTIONS, loadConfig, normalizeActions } from "../src/config.js";
import { CALENDAR_DIR } from "../src/paths.js";
import { _resetSendJobs, getSendJob, startSendJob, viewJob } from "../src/send-jobs.js";

const body = (over: Record<string, unknown> = {}) => ({ title: "디자인 리뷰", date: "2026-11-09", start_time: "14:00", end_time: "15:00", ...over });
const parse = (over: Record<string, unknown> = {}) => parseCalendarCreate(body(over));
const ev = (over: Record<string, unknown> = {}) => {
  const e = parse(over);
  if (typeof e === "string") throw new Error(e);
  return e;
};
const reqOf = (e: CalendarEventInput): SendRequest => ({ source: "calendar", mode: "create", text: "", ref: { title: e.title, calendar_id: e.calendar_id }, event: e });

describe("parseCalendarCreate", () => {
  it("accepts a timed event and fills defaults", () => {
    expect(ev()).toEqual({ title: "디자인 리뷰", all_day: false, start: "2026-11-09T14:00", end: "2026-11-09T15:00", location: "", description: "", attendees: [], meet: false, calendar_id: "primary" });
  });

  it("400s: empty title, bad date / time, end before (or equal to) start", () => {
    expect(parse({ title: "   " })).toBe("title required");
    expect(parse({ title: "x".repeat(201) })).toMatch(/title longer/);
    expect(parse({ date: "2026-02-30" })).toMatch(/date must be/);
    expect(parse({ date: "11/09" })).toMatch(/date must be/);
    expect(parse({ start_time: "9:00" })).toMatch(/HH:MM/);
    expect(parse({ end_time: "13:00" })).toBe("end must be after start");
    expect(parse({ end_time: "14:00" })).toBe("end must be after start");
    expect(parse({ end_date: "2026-11-08" })).toBe("end must be after start");
  });

  it("an end on the next day is fine (until midnight), too long is not", () => {
    expect(ev({ start_time: "23:00", end_time: "00:00", end_date: "2026-11-10" }).end).toBe("2026-11-10T00:00");
    expect(parse({ end_date: "2026-12-30" })).toMatch(/longer than/);
  });

  it("all-day: end_date inclusive, defaults to date, must not precede it", () => {
    expect(ev({ all_day: true, start_time: undefined, end_time: undefined })).toMatchObject({ all_day: true, start: "2026-11-09", end: "2026-11-09" });
    expect(ev({ all_day: true, end_date: "2026-11-11" }).end).toBe("2026-11-11");
    expect(parse({ all_day: true, end_date: "2026-11-08" })).toBe("end must be on or after start");
  });

  it("attendees: comma string or array, deduped / lowercased, format checked", () => {
    expect(ev({ attendees: "A@x.com, b@y.co.kr ,a@x.com" }).attendees).toEqual(["a@x.com", "b@y.co.kr"]);
    expect(ev({ attendees: ["c@z.io"] }).attendees).toEqual(["c@z.io"]);
    expect(parse({ attendees: "a@x.com, not-an-email" })).toMatch(/invalid attendee email: not-an-email/);
    expect(parse({ attendees: "a@x" })).toMatch(/invalid attendee email/);
  });

  it("calendar_id: primary or an id-looking string", () => {
    expect(ev({ calendar_id: "team@group.calendar.google.com" }).calendar_id).toBe("team@group.calendar.google.com");
    expect(parse({ calendar_id: "x; rm -rf" })).toMatch(/calendar_id/);
  });
});

describe("create_event arguments + verify", () => {
  it("timed: local times without offset, only the fields that were set", () => {
    expect(createEventArgs(ev())).toEqual({ summary: "디자인 리뷰", startTime: "2026-11-09T14:00:00", endTime: "2026-11-09T15:00:00" });
    expect(createEventArgs(ev({ location: "3F", description: "agenda", attendees: "a@x.com", meet: true, calendar_id: "t@group.calendar.google.com" }))).toEqual({
      summary: "디자인 리뷰", startTime: "2026-11-09T14:00:00", endTime: "2026-11-09T15:00:00", calendarId: "t@group.calendar.google.com",
      location: "3F", description: "agenda", attendees: [{ email: "a@x.com" }], addGoogleMeetUrl: true,
    });
  });

  it("all-day: end is the exclusive next midnight", () => {
    expect(createEventArgs(ev({ all_day: true, end_date: "2026-11-30" }))).toMatchObject({ allDay: true, startTime: "2026-11-09T00:00:00", endTime: "2026-12-01T00:00:00" });
  });

  it("the prompt carries the args as JSON and the single tool", () => {
    const b = buildCalendarCreate(reqOf(ev({ title: 'say "hi"' })));
    if (typeof b === "string") throw new Error(b);
    expect(b.tool).toBe("mcp__claude_ai_Google_Calendar__create_event");
    expect(b.prompt).toContain(JSON.stringify(createEventArgs(ev({ title: 'say "hi"' }))));
    expect(buildCalendarCreate({ source: "calendar", mode: "create", text: "", ref: {} })).toMatch(/event required/);
  });

  it("verify: id required; htmlLink only when it is a Google Calendar URL", () => {
    expect(verifyCreate('{"ok":true,"id":"abc123","htmlLink":"https://www.google.com/calendar/event?eid=xyz"}')).toEqual({ ok: true, detail: "created abc123 https://www.google.com/calendar/event?eid=xyz", event: { id: "abc123", html_link: "https://www.google.com/calendar/event?eid=xyz" } });
    expect(verifyCreate('{"ok":true,"id":"abc","htmlLink":"https://evil.example/x"}')).toMatchObject({ ok: true, event: { id: "abc", html_link: undefined } });
    expect(verifyCreate('{"ok":true}').ok).toBe(false);
    expect(verifyCreate('{"ok":false,"error":"forbidden"}')).toMatchObject({ ok: false, detail: "failed: forbidden" });
    expect(verifyCreate("I created it!").detail).toMatch(/^unverified/);
  });
});

describe("gate + performSend", () => {
  beforeEach(() => fs.rmSync(SENT_ACTIONS_LOG, { force: true }));

  it("calendar_create is its own switch, default off", () => {
    expect(DEFAULT_ACTIONS.calendar_create).toBe(false);
    expect(normalizeActions({ calendar_create: true }).calendar_create).toBe(true);
    expect(gateKey({ source: "calendar", mode: "create" })).toBe("calendar_create");
    expect(gateKey({ source: "calendar", mode: "rsvp" })).toBe("calendar_rsvp");
  });

  it("off → 403 refused and logged with the event key", async () => {
    const e = ev();
    const r = await performSend(reqOf(e), { ...loadConfig(), actions: { ...DEFAULT_ACTIONS, calendar_rsvp: true } });
    expect(r).toMatchObject({ ok: false, status: 403, action: "refused" });
    expect(r.detail).toContain("calendar_create");
    expect(readActionLog(5)[0]).toMatchObject({ source: "calendar", mode: "create", action: "refused", event_key: eventKey(e), ref: { title: "디자인 리뷰" } });
  });

  it("on (dry run) → builds a create_event-only dontAsk argv, never spawns claude", async () => {
    const r = await performSend(reqOf(ev()), { ...loadConfig(), actions: { ...DEFAULT_ACTIONS, calendar_create: true } });
    expect(r).toMatchObject({ ok: false, status: 200 });
    expect(r.action).toMatch(/^dry_run:calendar_create 2026-11-09 14:00–15:00/);
    const args = readActionLog(1)[0].claude_args!;
    expect(args).toContain("dontAsk");
    expect(args.join(" ")).toContain("mcp__claude_ai_Google_Calendar__create_event");
    expect(args.join(" ")).not.toMatch(/respond_to_event|delete_event|update_event/);
  });
});

describe("send jobs for create", () => {
  const cfg = { ...loadConfig(), actions: { ...DEFAULT_ACTIONS, calendar_create: true } };
  const okResult = (): SendResult => ({ ok: true, action: "calendar_create x", detail: "created ev1 https://www.google.com/calendar/event?eid=1 ($0.010)", logged_at: new Date().toISOString(), status: 200, event: { id: "ev1", html_link: "https://www.google.com/calendar/event?eid=1" } });
  function slowRun(result: SendResult) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    return { run: async () => { calls++; await gate; return result; }, release, calls: () => calls };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => { _resetSendJobs(); fs.rmSync(SENT_ACTIONS_LOG, { force: true }); });

  it("same event while running joins; a different time is a new job", async () => {
    const s = slowRun(okResult());
    const a = await startSendJob(reqOf(ev()), cfg, s.run);
    const b = await startSendJob(reqOf(ev()), cfg, s.run);
    expect(a.kind === "job" && b.kind === "job" && a.job.id === b.job.id && b.reused).toBe(true);
    const c = await startSendJob(reqOf(ev({ start_time: "16:00", end_time: "17:00" })), cfg, s.run);
    expect(c.kind === "job" && a.kind === "job" && c.job.id !== a.job.id).toBe(true);
    expect(s.calls()).toBe(2);
    s.release();
    await tick();
    if (a.kind === "job") expect(viewJob(getSendJob(a.job.id)!).result).toMatchObject({ ok: true, http_status: 200, event: { id: "ev1" } });
  });

  it("same title + time created ok in the last 10 min → already_sent (memory, then the log after a restart)", async () => {
    const s = slowRun(okResult());
    await startSendJob(reqOf(ev({ location: "A" })), cfg, s.run);
    s.release();
    await tick();
    // location differs, but title + time + calendar are the same event
    expect((await startSendJob(reqOf(ev({ location: "B" })), cfg, s.run)).kind).toBe("already_sent");
    // other title → fine
    expect((await startSendJob(reqOf(ev({ title: "다른 회의" })), cfg, s.run)).kind).toBe("job");

    _resetSendJobs(); // "restart": only the action log remembers
    fs.writeFileSync(SENT_ACTIONS_LOG, JSON.stringify({ ts: new Date().toISOString(), source: "calendar", mode: "create", action: "calendar_create x", ref: {}, text: "", ok: true, result: "created ev9", event_key: eventKey(ev()) }) + "\n");
    const again = await startSendJob(reqOf(ev()), cfg, s.run);
    expect(again.kind).toBe("already_sent");
    if (again.kind === "already_sent") expect(again.sent.detail).toBe("created ev9");
  });
});

describe("range cache invalidation", () => {
  it("drops cached ranges overlapping the event's days only", () => {
    fs.mkdirSync(CALENDAR_DIR, { recursive: true });
    for (const f of ["2026-11-02_2026-11-08.json", "2026-11-09_2026-11-15.json", "2026-11-16_2026-11-22.json"]) fs.writeFileSync(path.join(CALENDAR_DIR, f), "{}");
    expect(invalidateCalendarRanges("2026-11-09", "2026-11-09")).toBe(1);
    expect(fs.readdirSync(CALENDAR_DIR).sort()).toEqual(["2026-11-02_2026-11-08.json", "2026-11-16_2026-11-22.json"]);
  });
});
