/* Pure helpers for creating calendar events (no DOM, no imports) — drag range math, default slot, form ⇄ body.
 * calcreate.js / calendar.js use them; test/calrange.test.ts covers them. */

export const SNAP_MIN = 15;
export const DAY_MIN = 24 * 60;
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDaysYmd = (s, n) => { const [y, m, d] = String(s).split("-").map(Number); return ymd(new Date(y, m - 1, d + n)); };

/** Minutes since midnight → "HH:MM" (1440 → "00:00", the next day's midnight). */
export const minToHHMM = (m) => `${pad(Math.floor((m % DAY_MIN) / 60))}:${pad(m % 60)}`;
/** "HH:MM" → minutes, or NaN. */
export const hhmmToMin = (s) => { const x = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || "")); return x ? Number(x[1]) * 60 + Number(x[2]) : NaN; };

/** Pixel offset inside a timegrid column (top = hour h0) → minutes since midnight, unsnapped and clamped to [h0, h1]. */
export function minuteAtY(y, { h0, h1, pph }) {
  const m = h0 * 60 + (y / pph) * 60;
  return Math.min(h1 * 60, Math.max(h0 * 60, m));
}

/**
 * Drag from y0 to y1 (either direction) in a column whose top is hour h0 → {start, end} minutes, snapped outward to
 * `snap` (start floors, end ceils) so the block covers what was swept; at least one snap long; clamped to [h0, h1].
 */
export function dragRange(y0, y1, { h0, h1, pph, snap = SNAP_MIN }) {
  const a = minuteAtY(Math.min(y0, y1), { h0, h1, pph }), b = minuteAtY(Math.max(y0, y1), { h0, h1, pph });
  let start = Math.floor(a / snap) * snap, end = Math.ceil(b / snap) * snap;
  if (end - start < snap) end = start + snap;
  if (end > h1 * 60) { end = h1 * 60; start = Math.min(start, end - snap); }
  return { start: Math.max(h0 * 60, start), end };
}

/** A click (no drag) at y → the snapped time, `lenMin` long (default 1 h), never past midnight. */
export function clickRange(y, { h0, h1, pph, snap = SNAP_MIN, lenMin = 60 }) {
  const start = Math.min(Math.floor(minuteAtY(y, { h0, h1, pph }) / snap) * snap, DAY_MIN - snap);
  return { start, end: Math.min(DAY_MIN, start + lenMin) };
}

/** ＋ button default: today, the next full hour, 1 h (after 23:00 → tomorrow 00:00–01:00). */
export function defaultSlot(now = new Date()) {
  const next = new Date(now); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  const date = ymd(next), start = next.getHours() * 60;
  return { date, start: minToHHMM(start), end: minToHHMM(start + 60), end_date: start + 60 >= DAY_MIN ? addDaysYmd(date, 1) : date };
}

/** Prefill for a range on `day` (minutes). end 1440 = the next day 00:00. */
export function slotFromRange(day, { start, end }) {
  return { date: day, start: minToHHMM(start), end: minToHHMM(end), end_date: end >= DAY_MIN ? addDaysYmd(day, 1) : day };
}

export const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;
/** "a@x.com, b@y.com" → unique, lowercased list. */
export const splitEmails = (s) => [...new Set(String(s || "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

/**
 * Form values → POST /api/calendar/events body, or {error}. Timed: an end time at or before the start time on the
 * same date is only accepted as "00:00" (= midnight that night); anything else is an error, like the daemon's 400.
 * f = {title, date, start, end, all_day, end_date?, location, description, attendees, meet, calendar_id}
 */
export function formToBody(f) {
  const title = String(f.title || "").trim();
  if (!title) return { error: "제목을 입력해 줘." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || "")) return { error: "날짜를 골라 줘." };
  const attendees = splitEmails(f.attendees);
  const bad = attendees.find((a) => !EMAIL_RE.test(a));
  if (bad) return { error: `참석자 이메일 형식이 이상해: ${bad}` };
  const base = { title, date: f.date, location: String(f.location || "").trim(), description: String(f.description || "").trim(), attendees, meet: !!f.meet, calendar_id: String(f.calendar_id || "").trim() || "primary" };
  if (f.all_day) {
    const end_date = /^\d{4}-\d{2}-\d{2}$/.test(f.end_date || "") ? f.end_date : f.date;
    if (end_date < f.date) return { error: "끝나는 날이 시작보다 빨라." };
    return { body: { ...base, all_day: true, end_date } };
  }
  const s = hhmmToMin(f.start), e = hhmmToMin(f.end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return { error: "시작·끝 시각을 입력해 줘." };
  let end_date = f.date;
  if (e <= s) {
    if (e !== 0) return { error: "끝 시각이 시작보다 빨라." };
    end_date = addDaysYmd(f.date, 1); // "~ 00:00" = until midnight
  }
  return { body: { ...base, all_day: false, start_time: f.start, end_time: f.end, end_date } };
}

/** The optimistic card item for a body sent to /api/calendar/events (shape of agenda.calendar[] + pending). */
export function pendingEvent(body, key) {
  const start = body.all_day ? body.date : new Date(`${body.date}T${body.start_time}:00`).toISOString();
  const end = body.all_day ? addDaysYmd(body.end_date || body.date, 1) : new Date(`${body.end_date || body.date}T${body.end_time}:00`).toISOString();
  return { id: `pending:${key}`, title: body.title, start, end, all_day: !!body.all_day, location: body.location || "", url: "", meet_url: "", rsvp: "organizer", attendees: (body.attendees || []).length, pending: true };
}

/** One-line "when" for the confirm step: "11/8 (토) 14:00–15:00" / "11/8 (토) 종일" / "11/8 ~ 11/9 종일". */
export function whenLabel(body, WEEK = "일월화수목금토") {
  const d = (s) => { const [y, m, dd] = s.split("-").map(Number); const t = new Date(y, m - 1, dd); return `${m}/${dd} (${WEEK[t.getDay()]})`; };
  if (body.all_day) return body.end_date && body.end_date !== body.date ? `${d(body.date)} ~ ${d(body.end_date)} 종일` : `${d(body.date)} 종일`;
  return `${d(body.date)} ${body.start_time}–${body.end_date && body.end_date !== body.date ? `${body.end_time === "00:00" ? "24:00" : `${d(body.end_date)} ${body.end_time}`}` : body.end_time}`;
}
