import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agenda } from "../src/agenda.js";
import { DEFAULT_CONFIG, type NedConfig } from "../src/config.js";
import { DraftError, agendaContext, fastContext, generateDraft, parseDraftRequest, parseSlackUrl, pregenCandidates, refKey } from "../src/drafts.js";
import { AGENDA_PATH } from "../src/paths.js";

const cfg: NedConfig = { ...DEFAULT_CONFIG, draft_context_max_age_minutes: 180 };
const URL1 = "https://x.slack.com/archives/C111/p1700000000000100";
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function fakeAgenda(slackAgeMin: number, mailAgeMin: number): Agenda {
  return {
    updated_at: Date.now(),
    cost_usd: 0,
    calendar: [],
    jira: [],
    github: [],
    slack: {
      summary: "",
      items: [{ channel: "dev", from: "kim", text: "can you review?", url: URL1, ts: minsAgo(30), reason: "mention", context: { participants: ["kim"], messages: [{ from: "kim", ts: minsAgo(30), text: "can you review?" }], collected_at: minsAgo(slackAgeMin) } }],
      all: [],
      watch: [],
    },
    mail: {
      summary: "",
      unread: 0,
      unread_capped: false,
      items: [
        { id: "th1", from: "boss", subject: "Approve budget", snippet: "", received: minsAgo(60), url: "u", reason: "approval", why: "needs approval", context: { from: "boss", to: "me", subject: "Approve budget", body_excerpt: "Please approve.", attachments: [], collected_at: minsAgo(mailAgeMin) } },
        { id: "th2", from: "hr", subject: "Deadline", snippet: "", received: minsAgo(60), url: "u2", reason: "deadline", why: "", context: { from: "hr", to: "me", subject: "D", body_excerpt: "x", attachments: [], collected_at: minsAgo(1) } },
      ],
      all: [],
    },
  };
}
const writeAgenda = (a: Agenda) => fs.writeFileSync(AGENDA_PATH, JSON.stringify(a));

describe("request parsing", () => {
  it("parseDraftRequest rejects unknown source with 400 and keeps known ref keys", () => {
    expect(() => parseDraftRequest({ source: "fax" })).toThrowError(DraftError);
    const r = parseDraftRequest({ source: "slack", ref: { url: ` ${URL1} `, evil: "x" }, force: true });
    expect(r.ref).toEqual({ url: URL1 });
    expect(r.force).toBe(true);
  });
  it("parseSlackUrl extracts channel, ts and thread_ts", () => {
    expect(parseSlackUrl(`${URL1}?thread_ts=1699999999.000001&cid=C111`)).toEqual({ channel: "C111", ts: "1700000000.000100", thread_ts: "1699999999.000001" });
    expect(parseSlackUrl("https://example.com")).toEqual({});
  });
  it("refKey is stable for the same Slack message via url or channel+ts", () => {
    expect(refKey("slack", { url: URL1 })).toBe(refKey("slack", { channel: "C111", ts: "1700000000.000100" }));
  });
});

describe("fast / full path decision", () => {
  beforeEach(() => writeAgenda(fakeAgenda(10, 20)));

  it("fresh Slack context → fast with its age", () => {
    const c = fastContext({ source: "slack", ref: { url: URL1 } }, cfg)!;
    expect(c.kind).toBe("slack");
    expect(c.age).toBeGreaterThanOrEqual(9);
    expect(c.age).toBeLessThanOrEqual(11);
  });

  it("Slack ref by channel+ts (no url) also finds the context", () => {
    expect(agendaContext({ source: "slack", ref: { channel: "C111", ts: "1700000000.000100" } })?.kind).toBe("slack");
  });

  it("mail by thread id → fast; unknown thread → null", () => {
    expect(fastContext({ source: "email", ref: { thread_id: "th1" } }, cfg)?.kind).toBe("email");
    expect(fastContext({ source: "email", ref: { thread_id: "zzz" } }, cfg)).toBeNull();
  });

  it("stale context (older than draft_context_max_age_minutes) → null (full path)", () => {
    writeAgenda(fakeAgenda(500, 500));
    expect(fastContext({ source: "slack", ref: { url: URL1 } }, cfg)).toBeNull();
    expect(fastContext({ source: "email", ref: { thread_id: "th1" } }, cfg)).toBeNull();
  });

  it("sessions never use agenda context", () => {
    expect(fastContext({ source: "session", ref: { session_id: "s1" } }, cfg)).toBeNull();
  });
});

describe("generateDraft (NED_NO_LLM stub, no claude)", () => {
  beforeEach(() => writeAgenda(fakeAgenda(10, 20)));

  it("fresh context → mode fast with context_age_minutes and 3 labelled drafts", async () => {
    const r = await generateDraft({ source: "slack", ref: { url: URL1 } }, cfg);
    expect(r.mode).toBe("fast");
    expect(r.context_age_minutes).toBeGreaterThanOrEqual(9);
    expect(r.drafts.map((d) => d.label)).toEqual(["짧게", "보통", "정중하게"]);
    expect(r.meta.channel_id).toBe("C111");
  });

  it("stale context → mode full, context_age null", async () => {
    writeAgenda(fakeAgenda(500, 500));
    const r = await generateDraft({ source: "email", ref: { thread_id: "th1", title: "Approve" } }, cfg);
    expect(r.mode).toBe("full");
    expect(r.context_age_minutes).toBeNull();
  });

  it("session → fast with age 0", async () => {
    const r = await generateDraft({ source: "session", ref: { session_id: "sess-1" } }, cfg);
    expect(r).toMatchObject({ mode: "fast", context_age_minutes: 0 });
  });

  it("fastOnly without fresh context → DraftError 404", async () => {
    writeAgenda(fakeAgenda(500, 500));
    await expect(generateDraft({ source: "slack", ref: { url: URL1 } }, cfg, { fastOnly: true })).rejects.toMatchObject({ status: 404 });
  });

  it("validation errors → DraftError 400", async () => {
    await expect(generateDraft({ source: "session", ref: {} }, cfg)).rejects.toMatchObject({ status: 400 });
    await expect(generateDraft({ source: "slack", ref: {} }, cfg)).rejects.toMatchObject({ status: 400 });
    await expect(generateDraft({ source: "email", ref: {} }, cfg)).rejects.toMatchObject({ status: 400 });
  });
});

describe("pregenCandidates", () => {
  it("only items with context; mail only reply/approval/request; alternates sources", () => {
    const c = pregenCandidates(fakeAgenda(1, 1));
    expect(c.map((r) => r.source)).toEqual(["slack", "email"]);
    expect(c[1].ref.thread_id).toBe("th1");
  });
});
