/**
 * POST /api/calendar/events — new Google Calendar event (config.actions.calendar_create, default off).
 * Runs through the same send-job machinery as POST /api/send (source "calendar", mode "create"): 202 + polling,
 * join a running identical request, 409 when the same title + time was created ok in the last 10 min.
 *
 * The model never composes the event: Ned builds the exact `create_event` arguments here and the child is told to
 * pass them through unchanged (dontAsk, ToolSearch + create_event only).
 */
import type { BuiltAction, SendRequest } from "./actions.js";
import { extractJson } from "./claude.js";
import { parseAddress } from "./address.js";

export const CAL_CREATE = "mcp__claude_ai_Google_Calendar__create_event";

export interface CalendarEventInput {
  title: string;
  all_day: boolean;
  /** timed: local "YYYY-MM-DDTHH:MM"; all-day: "YYYY-MM-DD". */
  start: string;
  /** timed: local "YYYY-MM-DDTHH:MM" (> start); all-day: last day, inclusive "YYYY-MM-DD" (>= start). */
  end: string;
  location: string;
  description: string;
  attendees: string[];
  meet: boolean;
  calendar_id: string;
}

export interface CreatedEvent {
  id: string;
  html_link?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Pragmatic address check (what the dashboard form can reasonably catch). */
export const EMAIL = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;
const CAL_ID = /^[\w@.+-]{3,200}$/;
export const MAX_TITLE = 200;
const MAX_LOCATION = 500;
const MAX_DESCRIPTION = 4000;
const MAX_ATTENDEES = 50;
const MAX_TIMED_DAYS = 14;
const MAX_ALLDAY_DAYS = 60;

const validDay = (s: string) => DAY.test(s) && sameDay(s);
/** Rejects 2026-02-31 (Date rolls it over to March). */
function sameDay(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
export function addDay(ymd: string, n = 1): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/**
 * Coerce a POST /api/calendar/events body. Returns an error string for a 400.
 * Body: {title, date, start_time?, end_time?, end_date?, all_day?, location?, description?, attendees? (string "a@x, b@y" | string[]),
 *        meet?, calendar_id? (default "primary")}
 */
export function parseCalendarCreate(body: Record<string, unknown>): CalendarEventInput | string {
  const title = str(body.title);
  if (!title) return "title required";
  if (title.length > MAX_TITLE) return `title longer than ${MAX_TITLE} chars`;
  const date = str(body.date);
  if (!validDay(date)) return "date must be YYYY-MM-DD";
  const endDate = str(body.end_date) || date;
  if (!validDay(endDate)) return "end_date must be YYYY-MM-DD";
  const all_day = body.all_day === true;
  let start: string, end: string;
  if (all_day) {
    if (endDate < date) return "end must be on or after start";
    if ((Date.parse(`${endDate}T00:00:00`) - Date.parse(`${date}T00:00:00`)) / 86400_000 >= MAX_ALLDAY_DAYS) return `all-day event longer than ${MAX_ALLDAY_DAYS} days`;
    start = date;
    end = endDate;
  } else {
    const st = str(body.start_time), et = str(body.end_time);
    if (!TIME.test(st) || !TIME.test(et)) return "start_time / end_time must be HH:MM";
    start = `${date}T${st}`;
    end = `${endDate}T${et}`;
    const a = Date.parse(`${start}:00`), b = Date.parse(`${end}:00`);
    if (!(b > a)) return "end must be after start";
    if ((b - a) / 86400_000 > MAX_TIMED_DAYS) return `event longer than ${MAX_TIMED_DAYS} days`;
  }
  const location = str(body.location);
  if (location.length > MAX_LOCATION) return `location longer than ${MAX_LOCATION} chars`;
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > MAX_DESCRIPTION) return `description longer than ${MAX_DESCRIPTION} chars`;
  const rawAtt = Array.isArray(body.attendees) ? body.attendees : typeof body.attendees === "string" ? body.attendees.split(/[,;\s]+/) : [];
  const given = [...new Set(rawAtt.map((x) => str(x).toLowerCase()).filter(Boolean))];
  // Sent only in the normalized ASCII / punycode form the 보내기 규칙 judged (address.ts) — no look-alike that reads
  // one way here and resolves another way at Google.
  const bad = given.find((a) => !EMAIL.test(a) || !parseAddress(a));
  if (bad) return `invalid attendee email: ${bad.slice(0, 80)}`;
  const attendees = [...new Set(given.map((a) => parseAddress(a)!))];
  if (attendees.length > MAX_ATTENDEES) return `at most ${MAX_ATTENDEES} attendees`;
  const calendar_id = str(body.calendar_id) || "primary";
  if (calendar_id !== "primary" && !CAL_ID.test(calendar_id)) return "calendar_id must be 'primary' or a calendar id (email)";
  return { title, all_day, start, end, location, description, attendees, meet: body.meet === true, calendar_id };
}

/** "Same event" for dedupe: calendar + title + times. */
export function eventKey(e: Pick<CalendarEventInput, "calendar_id" | "title" | "start" | "end" | "all_day">): string {
  return `${e.calendar_id}|${e.all_day ? "D" : "T"}|${e.start}|${e.end}|${e.title}`;
}

/** The exact create_event arguments (local times, no offset — the connector resolves the user's time zone). */
export function createEventArgs(e: CalendarEventInput): Record<string, unknown> {
  const args: Record<string, unknown> = {
    summary: e.title,
    // Google all-day end is exclusive: the day after the last day, at midnight.
    startTime: e.all_day ? `${e.start}T00:00:00` : `${e.start}:00`,
    endTime: e.all_day ? `${addDay(e.end)}T00:00:00` : `${e.end}:00`,
  };
  if (e.all_day) args.allDay = true;
  if (e.calendar_id !== "primary") args.calendarId = e.calendar_id;
  if (e.location) args.location = e.location;
  if (e.description) args.description = e.description;
  if (e.attendees.length) args.attendees = e.attendees.map((email) => ({ email }));
  if (e.meet) args.addGoogleMeetUrl = true;
  return args;
}

const GCAL_LINK = /^https:\/\/(www\.google\.com\/calendar|calendar\.google\.com)\/[^\s"']+$/;

/** Did the model's report prove the event exists? Needs an id; htmlLink kept only when it is a Google Calendar URL. */
export function verifyCreate(text: string): { ok: boolean; detail: string; event?: CreatedEvent } {
  const j = extractJson<{ ok?: boolean; id?: unknown; htmlLink?: unknown; error?: unknown }>(text);
  if (!j) return { ok: false, detail: `unverified: no JSON in model output: ${text.slice(0, 200)}` };
  if (j.ok !== true) return { ok: false, detail: `failed: ${String(j.error ?? "ok != true").slice(0, 300)}` };
  const id = typeof j.id === "string" ? j.id.trim() : "";
  if (!id || id.length > 300) return { ok: false, detail: `unverified: no event id in ${JSON.stringify(j).slice(0, 200)}` };
  const link = typeof j.htmlLink === "string" && GCAL_LINK.test(j.htmlLink.trim()) ? j.htmlLink.trim() : undefined;
  return { ok: true, detail: `created ${id}${link ? ` ${link}` : ""}`, event: { id, html_link: link } };
}

/** The connector action for SendRequest {source: "calendar", mode: "create", event}. */
export function buildCalendarCreate(req: SendRequest): BuiltAction | string {
  const e = req.event;
  if (!e) return "event required (POST /api/calendar/events)";
  const args = JSON.stringify(createEventArgs(e));
  const when = e.all_day ? `${e.start}${e.end !== e.start ? `~${e.end}` : ""} 종일` : `${e.start.replace("T", " ")}–${e.end.slice(0, 10) === e.start.slice(0, 10) ? e.end.slice(11) : e.end.replace("T", " ")}`;
  return {
    tool: CAL_CREATE,
    action: `calendar_create ${when} ${e.title.slice(0, 60)}`,
    prompt: [
      `create exactly one Google Calendar event with exactly these arguments and reply with its id and link.`,
      `먼저 ToolSearch 로 \`select:${CAL_CREATE}\` 를 로드한 뒤 ${CAL_CREATE} 를 아래 JSON 객체 그대로를 인자로 한 번 호출한다. 키를 더하거나 빼거나 값을 바꾸지 않는다 (timeZone 도 넣지 않는다).`,
      "규칙: 이 도구 하나만, 한 번만 호출한다. 다른 도구·다른 캘린더·추가 일정 금지. 실패하면 재시도하지 말고 실패를 보고한다.",
      `arguments (JSON): ${args}`,
      `출력은 JSON 하나만: 성공 {"ok":true,"id":"<event id>","htmlLink":"<event htmlLink>"} / 실패 {"ok":false,"error":"이유"}`,
    ].join("\n"),
    verify: verifyCreate,
  };
}
