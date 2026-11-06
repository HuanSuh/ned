/**
 * Per-source reply tone: config.reply_tone_by_source normalize / load / PUT merge, and the draft tone choice
 * (request tone → reply_tone_by_source[source] → reply_tone). Never claude (NED_NO_LLM=1), temp NED_HOME, no port bound.
 */
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
const { DEFAULT_CONFIG, DEFAULT_REPLY_TONE, loadConfig, normalizeReplyToneBySource } = await import("../src/config.js");
const { draftTone, generateDraft } = await import("../src/drafts.js");
const { CONFIG_PATH } = await import("../src/paths.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const put = (body: unknown) => request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const OFF = { gmail: false, slack: false, jira: false, github: false, sentry: false, calendar: false };
const writeCfg = (extra: Record<string, unknown> = {}) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: OFF, ...extra }));

beforeAll(() => {
  startServer(() => loadConfig());
});
beforeEach(() => fs.rmSync(CONFIG_PATH, { force: true }));

describe("normalizeReplyToneBySource", () => {
  it("defaults to all null", () => {
    expect(DEFAULT_CONFIG.reply_tone_by_source).toEqual({ slack: null, email: null, session: null });
    expect(normalizeReplyToneBySource(undefined)).toEqual({ slack: null, email: null, session: null });
    expect(normalizeReplyToneBySource("x")).toEqual({ slack: null, email: null, session: null });
    expect(normalizeReplyToneBySource([1, 2])).toEqual({ slack: null, email: null, session: null });
  });
  it("trims, caps at 200, blank / non-string → null, ignores unknown keys", () => {
    const r = normalizeReplyToneBySource({ slack: "  반말, 짧게 ", email: "x".repeat(300), session: "   ", jira: "nope" });
    expect(r).toEqual({ slack: "반말, 짧게", email: "x".repeat(200), session: null });
    expect(normalizeReplyToneBySource({ slack: 3, email: null })).toEqual({ slack: null, email: null, session: null });
  });
  it("absent keys keep base; present null clears", () => {
    const base = { slack: "a", email: "b", session: "c" };
    expect(normalizeReplyToneBySource({ email: "B" }, base)).toEqual({ slack: "a", email: "B", session: "c" });
    expect(normalizeReplyToneBySource({ slack: null, session: "" }, base)).toEqual({ slack: null, email: "b", session: null });
    expect(normalizeReplyToneBySource(undefined, base)).toEqual(base);
  });
});

describe("config load / PUT", () => {
  it("loadConfig normalizes the yaml value", () => {
    writeCfg({ reply_tone_by_source: { slack: "  짧게 ", email: "" } });
    expect(loadConfig().reply_tone_by_source).toEqual({ slack: "짧게", email: null, session: null });
  });
  it("PUT /api/config normalizes and merges per key; a PUT without the key keeps it", async () => {
    writeCfg({ reply_tone_by_source: { session: "영어로" } });
    let r = await put({ reply_tone_by_source: { slack: " 반말 ", email: "  " } });
    expect(r.status).toBe(200);
    expect((await r.json()).reply_tone_by_source).toEqual({ slack: "반말", email: null, session: "영어로" });
    expect(YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")).reply_tone_by_source).toEqual({ slack: "반말", email: null, session: "영어로" });
    r = await put({ reply_tone: "기본" });
    const c = await r.json();
    expect(c.reply_tone).toBe("기본");
    expect(c.reply_tone_by_source).toEqual({ slack: "반말", email: null, session: "영어로" });
  });
});

describe("draft tone choice", () => {
  const cfg = { ...DEFAULT_CONFIG, reply_tone: "기본 말투", reply_tone_by_source: { slack: "슬랙 말투", email: null, session: "  " } };
  it("request tone > per-source > reply_tone > default", () => {
    expect(draftTone({ source: "slack", tone: "이번만" }, cfg)).toBe("이번만");
    expect(draftTone({ source: "slack" }, cfg)).toBe("슬랙 말투");
    expect(draftTone({ source: "email" }, cfg)).toBe("기본 말투");
    expect(draftTone({ source: "session" }, cfg)).toBe("기본 말투"); // blank per-source → 기본
    expect(draftTone({ source: "jira" }, cfg)).toBe("기본 말투"); // no per-source key
    expect(draftTone({ source: "slack" }, { reply_tone: "", reply_tone_by_source: undefined as never })).toBe(DEFAULT_REPLY_TONE);
  });
  it("generateDraft (NED_NO_LLM) records the per-source tone when the request has none", async () => {
    const r = await generateDraft({ source: "session", ref: { session_id: "tone-sess-1" } }, { ...cfg, reply_tone_by_source: { slack: null, email: null, session: "세션 말투" } });
    expect(r.tone).toBe("세션 말투");
    const r2 = await generateDraft({ source: "session", ref: { session_id: "tone-sess-2" } }, cfg);
    expect(r2.tone).toBe("기본 말투");
  });
});
