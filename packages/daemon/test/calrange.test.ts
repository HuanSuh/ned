/** public/app/features/calrange.js — drag range math, default slot, form → body (pure, no DOM). */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { clickRange, defaultSlot, dragRange, formToBody, minToHHMM, minuteAtY, pendingEvent, slotFromRange, whenLabel } from "../public/app/features/calrange.js";

const g = { h0: 8, h1: 20, pph: 60 }; // 1 px per minute, grid starts 08:00

describe("drag range", () => {
  it("y → minutes, clamped to the grid", () => {
    expect(minuteAtY(0, g)).toBe(480);
    expect(minuteAtY(90, g)).toBe(570);
    expect(minuteAtY(-50, g)).toBe(480);
    expect(minuteAtY(10_000, g)).toBe(1200);
  });

  it("snaps outward to 15 min, either direction", () => {
    expect(dragRange(62, 130, g)).toEqual({ start: 540, end: 615 }); // 09:02 → 10:10 ⇒ 09:00–10:15
    expect(dragRange(130, 62, g)).toEqual({ start: 540, end: 615 });
    expect(dragRange(120, 180, g)).toEqual({ start: 600, end: 660 }); // exact edges stay
  });

  it("at least one snap long; clamped at the bottom of the grid", () => {
    expect(dragRange(61, 63, g)).toEqual({ start: 540, end: 555 });
    expect(dragRange(700, 2000, g)).toEqual({ start: 1170, end: 1200 });
    expect(dragRange(720, 720, g)).toEqual({ start: 1185, end: 1200 });
  });

  it("other pixel scales", () => {
    expect(dragRange(26, 52, { h0: 9, h1: 18, pph: 52 })).toEqual({ start: 570, end: 600 }); // 09:30–10:00
  });

  it("click → snapped start, 1 h", () => {
    expect(clickRange(70, g)).toEqual({ start: 540, end: 600 });
    expect(clickRange(10_000, { h0: 0, h1: 24, pph: 60 })).toEqual({ start: 1425, end: 1440 });
  });

  it("slot: end 24:00 rolls to next day 00:00", () => {
    expect(slotFromRange("2026-11-09", { start: 540, end: 615 })).toEqual({ date: "2026-11-09", start: "09:00", end: "10:15", end_date: "2026-11-09" });
    expect(slotFromRange("2026-11-30", { start: 1380, end: 1440 })).toEqual({ date: "2026-11-30", start: "23:00", end: "00:00", end_date: "2026-12-01" });
    expect(minToHHMM(1440)).toBe("00:00");
  });
});

describe("default slot (＋)", () => {
  it("next full hour, one hour long", () => {
    expect(defaultSlot(new Date(2026, 10, 7, 14, 20))).toEqual({ date: "2026-11-07", start: "15:00", end: "16:00", end_date: "2026-11-07" });
    expect(defaultSlot(new Date(2026, 10, 7, 15, 0))).toEqual({ date: "2026-11-07", start: "16:00", end: "17:00", end_date: "2026-11-07" });
  });
  it("late evening → until midnight / tomorrow", () => {
    expect(defaultSlot(new Date(2026, 10, 7, 22, 30))).toEqual({ date: "2026-11-07", start: "23:00", end: "00:00", end_date: "2026-11-08" });
    expect(defaultSlot(new Date(2026, 10, 7, 23, 30))).toEqual({ date: "2026-11-08", start: "00:00", end: "01:00", end_date: "2026-11-08" });
  });
});

describe("form → body", () => {
  const f = { title: " 리뷰 ", date: "2026-11-09", start: "14:00", end: "15:00", all_day: false, location: "", description: "", attendees: "A@x.com, b@y.io", meet: true, calendar_id: "" };
  it("timed", () => {
    expect(formToBody(f)).toEqual({ body: { title: "리뷰", date: "2026-11-09", start_time: "14:00", end_time: "15:00", end_date: "2026-11-09", all_day: false, location: "", description: "", attendees: ["a@x.com", "b@y.io"], meet: true, calendar_id: "primary" } });
  });
  it("errors: title, end before start, bad email", () => {
    expect(formToBody({ ...f, title: "" }).error).toMatch(/제목/);
    expect(formToBody({ ...f, end: "13:00" }).error).toMatch(/끝 시각/);
    expect(formToBody({ ...f, attendees: "x@y" }).error).toMatch(/이메일/);
  });
  it("end 00:00 = midnight that night", () => {
    expect(formToBody({ ...f, start: "23:00", end: "00:00" }).body).toMatchObject({ end_time: "00:00", end_date: "2026-11-10" });
  });
  it("all-day", () => {
    expect(formToBody({ ...f, all_day: true, end_date: "" }).body).toMatchObject({ all_day: true, end_date: "2026-11-09" });
    expect(formToBody({ ...f, all_day: true, end_date: "2026-11-01" }).error).toMatch(/끝나는 날/);
  });
  it("pending item + label", () => {
    const b = formToBody(f).body;
    const p = pendingEvent(b, "k1");
    expect(p).toMatchObject({ id: "pending:k1", title: "리뷰", all_day: false, pending: true, attendees: 2 });
    expect(Date.parse(p.end) - Date.parse(p.start)).toBe(3600_000);
    expect(whenLabel(b)).toBe("11/9 (월) 14:00–15:00");
    const ad = formToBody({ ...f, all_day: true, end_date: "2026-11-10" }).body;
    expect(pendingEvent(ad, "k2")).toMatchObject({ start: "2026-11-09", end: "2026-11-11", all_day: true });
    expect(whenLabel(ad)).toBe("11/9 (월) ~ 11/10 (화) 종일");
  });
});
