/** POST /api/send job registry (src/send-jobs.ts): 202→done, dedupe while running, 409 after an ok send, crash → logged failure. */
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { SENT_ACTIONS_LOG, readActionLog, type SendRequest, type SendResult } from "../src/actions.js";
import { DEFAULT_ACTIONS, loadConfig } from "../src/config.js";
import { _resetSendJobs, getSendJob, linkOf, startSendJob, viewJob } from "../src/send-jobs.js";

const cfg = { ...loadConfig(), actions: { ...DEFAULT_ACTIONS, slack_send: true } };
const req = (over: Partial<SendRequest> = {}): SendRequest => ({ source: "slack", mode: "send", text: "hello", ref: { channel: "C1" }, draft_id: "d1", ...over });
const okResult = (detail = "https://x.slack.com/archives/C1/p1700000000000100 ($0.010)"): SendResult => ({ ok: true, action: "slack_message C1", detail, logged_at: new Date().toISOString(), status: 200 });

/** A run() that waits until released — stands in for a 40s claude -p. */
function slowRun(result: SendResult) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const run = async () => {
    calls++;
    await gate;
    return result;
  };
  return { run, release, calls: () => calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetSendJobs();
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
});

describe("send jobs", () => {
  it("returns a running job at once, then done with the result", async () => {
    const s = slowRun(okResult());
    const st = await startSendJob(req(), cfg, s.run);
    expect(st.kind).toBe("job");
    if (st.kind !== "job") return;
    expect(viewJob(st.job)).toMatchObject({ state: "running" });
    expect(viewJob(st.job).result).toBeUndefined();
    s.release();
    await tick();
    const v = viewJob(getSendJob(st.job.id)!);
    expect(v.state).toBe("done");
    expect(v.result).toMatchObject({ ok: true, http_status: 200 });
  });

  it("same draft + text while running → same job, run() called once", async () => {
    const s = slowRun(okResult());
    const a = await startSendJob(req(), cfg, s.run);
    const b = await startSendJob(req(), cfg, s.run);
    expect(a.kind === "job" && b.kind === "job" && a.job.id === b.job.id).toBe(true);
    expect(b.kind === "job" && b.reused).toBe(true);
    expect(s.calls()).toBe(1);
    // different text is a different send
    const c = await startSendJob(req({ text: "other" }), cfg, s.run);
    expect(c.kind === "job" && c.job.id !== (a.kind === "job" ? a.job.id : "")).toBe(true);
    s.release();
    await tick();
  });

  it("after an ok send, the same draft (same source/mode) within 10 min → already_sent", async () => {
    const s = slowRun(okResult());
    await startSendJob(req(), cfg, s.run);
    s.release();
    await tick();
    const again = await startSendJob(req({ text: "edited" }), cfg, s.run);
    expect(again.kind).toBe("already_sent");
    if (again.kind === "already_sent") expect(linkOf(again.sent.detail)).toBe("https://x.slack.com/archives/C1/p1700000000000100");
    expect(s.calls()).toBe(1);
  });

  it("a failed send does not block a retry", async () => {
    const fail = slowRun({ ok: false, action: "slack_message C1", detail: "failed: channel_not_found", logged_at: new Date().toISOString(), status: 502 });
    await startSendJob(req(), cfg, fail.run);
    fail.release();
    await tick();
    const retry = await startSendJob(req(), cfg, fail.run);
    expect(retry.kind).toBe("job");
  });

  it("a switched-off action is refused synchronously (no job)", async () => {
    const st = await startSendJob(req(), { ...cfg, actions: { ...cfg.actions, slack_send: false } });
    expect(st.kind).toBe("sync");
    if (st.kind === "sync") expect(st.result.status).toBe(403);
  });

  it("a crash in run() becomes a logged 502 result", async () => {
    const st = await startSendJob(req({ draft_id: "boom" }), cfg, async () => {
      throw new Error("kaboom");
    });
    await tick();
    if (st.kind !== "job") throw new Error("expected a job");
    expect(viewJob(st.job).result).toMatchObject({ ok: false, http_status: 502, action: "error" });
    expect(readActionLog(5)[0]).toMatchObject({ draft_id: "boom", ok: false, action: "error" });
  });
});
