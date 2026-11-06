/** 메일 확인 완료 → Gmail 읽음 표시 (src/mail-read.ts): option gate, optimistic unread, job, 10-min dedupe, budget stop. */
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { SENT_ACTIONS_LOG, buildActionPrompt, gateKey, parseSendRequest, readActionLog, type SendResult } from "../src/actions.js";
import { patchAgenda, readAgenda, type Agenda } from "../src/agenda.js";
import { DEFAULT_ACTIONS, loadConfig } from "../src/config.js";
import { COSTS_PATH, recordCost } from "../src/costs.js";
import { markThreadReadLocally, onMailReviewed } from "../src/mail-read.js";
import { _resetSendJobs, getSendJob } from "../src/send-jobs.js";

const on = { ...loadConfig(), actions: { ...DEFAULT_ACTIONS, gmail_mark_read: true } };
const off = { ...loadConfig(), actions: { ...DEFAULT_ACTIONS } };
const ok = (t: string): SendResult => ({ ok: true, action: `gmail_mark_read ${t}`, detail: `thread ${t} → read`, logged_at: new Date().toISOString(), status: 200 });
const tick = () => new Promise((r) => setTimeout(r, 0));
const mail = (): Agenda["mail"] => ({
  summary: "",
  unread: 2,
  unread_capped: false,
  items: [],
  all: [
    { id: "t1", from: "a", subject: "s1", ts: "2026-11-06T00:00:00Z", url: "", unread: true },
    { id: "t2", from: "b", subject: "s2", ts: "2026-11-06T00:00:00Z", url: "", unread: true },
  ],
});

beforeEach(() => {
  _resetSendJobs();
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
  fs.rmSync(COSTS_PATH, { force: true });
  patchAgenda((a) => void (a.mail = mail()));
});

describe("config + action plumbing", () => {
  it("gmail_mark_read defaults off and gates email/mark_read", () => {
    expect(DEFAULT_ACTIONS.gmail_mark_read).toBe(false);
    expect(gateKey({ source: "email", mode: "mark_read" })).toBe("gmail_mark_read");
    expect(parseSendRequest({ source: "email", mode: "mark_read", ref: { thread_id: "t1" } })).toMatchObject({ mode: "mark_read", text: "" });
  });

  it("prompt allows only unlabel_thread, maxTurns 3, and needs a clean thread id", () => {
    const b = buildActionPrompt({ source: "email", mode: "mark_read", text: "", ref: { thread_id: "18f0abc" } }, {});
    if (typeof b === "string") throw new Error(b);
    expect(b.tool).toBe("mcp__claude_ai_Gmail__unlabel_thread");
    expect(b.prompt).toContain("UNREAD");
    const o = b.opts!(on);
    expect(o).toMatchObject({ allowedTools: ["ToolSearch", "mcp__claude_ai_Gmail__unlabel_thread"], permissionMode: "dontAsk", maxTurns: 3 });
    expect(b.verify!('{"ok":true,"id":"18f0abc"}').ok).toBe(true);
    expect(b.verify!('{"ok":false,"error":"nope"}').ok).toBe(false);
    expect(typeof buildActionPrompt({ source: "email", mode: "mark_read", text: "", ref: { thread_id: "x y`" } }, {})).toBe("string");
    expect(typeof buildActionPrompt({ source: "email", mode: "mark_read", text: "", ref: {} }, {})).toBe("string");
  });
});

describe("markThreadReadLocally", () => {
  it("flips one unread row and decrements once", () => {
    const a = readAgenda();
    expect(markThreadReadLocally(a, "t1")).toBe(true);
    expect(a.mail!.all[0].unread).toBe(false);
    expect(a.mail!.unread).toBe(1);
    expect(markThreadReadLocally(a, "t1")).toBe(false); // already read: no double count
    expect(markThreadReadLocally(a, "zz")).toBe(false); // not in all[]: unknown, leave the count
    expect(a.mail!.unread).toBe(1);
  });
  it("never goes below 0 and ignores a missing mail block", () => {
    const a = readAgenda();
    a.mail!.unread = 0;
    markThreadReadLocally(a, "t2");
    expect(a.mail!.unread).toBe(0);
    expect(markThreadReadLocally({ ...a, mail: null }, "t1")).toBe(false);
  });
});

describe("onMailReviewed", () => {
  it("option off (or not mail) → nothing: no job, agenda untouched", async () => {
    expect(await onMailReviewed("mail:t1", off)).toBeNull();
    expect(await onMailReviewed("jira:APP-1", on)).toBeNull();
    expect(readAgenda().mail!.all[0].unread).toBe(true);
    expect(readAgenda().mail!.unread).toBe(2);
    expect(readActionLog()).toEqual([]);
  });

  it("option on → optimistic unread in agenda.json + a background job (NED_NO_LLM: dry run, logged)", async () => {
    const r = await onMailReviewed("mail:t1", on);
    expect(r?.job_id).toBeTypeOf("string");
    const a = readAgenda();
    expect(a.mail!.all.find((x) => x.id === "t1")!.unread).toBe(false);
    expect(a.mail!.unread).toBe(1);
    await tick();
    await tick();
    const j = getSendJob(r!.job_id!)!;
    expect(j.state).toBe("done");
    expect(j.result).toMatchObject({ ok: false, action: "dry_run:gmail_mark_read t1" });
    const log = readActionLog()[0];
    expect(log).toMatchObject({ source: "email", mode: "mark_read", ref: { thread_id: "t1" }, ok: false });
    expect(log.claude_args?.join(" ")).toContain("mcp__claude_ai_Gmail__unlabel_thread");
    expect(log.claude_args?.join(" ")).toContain("--max-turns 3");
  });

  it("same thread marked read ok within 10 min → skipped (no second run)", async () => {
    let calls = 0;
    const run = async () => (calls++, ok("t1"));
    const first = await onMailReviewed("mail:t1", on, run);
    expect(first?.job_id).toBeTruthy();
    await tick();
    const second = await onMailReviewed("mail:t1", on, run);
    expect(second).toMatchObject({ skipped: "already" });
    expect(calls).toBe(1);
    // a different thread still runs
    expect((await onMailReviewed("mail:t2", on, run))?.job_id).toBeTruthy();
  });

  it("a failed run doesn't block a retry", async () => {
    let calls = 0;
    const run = async (): Promise<SendResult> => (calls++, { ...ok("t1"), ok: false, status: 502, detail: "failed: boom" });
    await onMailReviewed("mail:t1", on, run);
    await tick();
    await onMailReviewed("mail:t1", on, run);
    await tick();
    expect(calls).toBe(2);
  });

  it("daily budget hard stop → no job, logged as skipped:budget (optimistic mark still applied)", async () => {
    recordCost("agenda", on.agenda_daily_budget_usd + 1);
    let calls = 0;
    const r = await onMailReviewed("mail:t1", on, async () => (calls++, ok("t1")));
    expect(r).toMatchObject({ skipped: "budget" });
    expect(calls).toBe(0);
    expect(readActionLog()[0]).toMatchObject({ action: "skipped:budget", ok: false, mode: "mark_read" });
    expect(readAgenda().mail!.all[0].unread).toBe(false);
  });

  it("bad thread id → invalid, no job", async () => {
    expect(await onMailReviewed("mail:a b", on)).toMatchObject({ skipped: "invalid" });
    expect(readActionLog()).toEqual([]);
  });
});
