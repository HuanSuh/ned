import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, extractJson, llmDisabled, noLlmResult } from "../src/claude.js";
import { lastAssistantText, parseLines } from "../src/events.js";
import { notifyBackend } from "../src/notify.js";

const home = () => process.env.NED_HOME!;
const line = (role: string, content: unknown) => JSON.stringify({ type: role, message: { role, content } });

describe("events.parseLines", () => {
  it("keeps valid events, skips blank / corrupt / incomplete lines", () => {
    const text = [JSON.stringify({ ts: 1, event: "Stop" }), "", "{not json", JSON.stringify({ ts: "2", event: "Stop" }), JSON.stringify({ ts: 3 }), JSON.stringify({ ts: 4, event: "Notification", session_id: "s" })].join("\n");
    expect(parseLines(text).map((e) => e.ts)).toEqual([1, 4]);
  });
  it("returns [] for empty input", () => {
    expect(parseLines("")).toEqual([]);
  });
});

describe("events.lastAssistantText", () => {
  it("null for missing / undefined path", () => {
    expect(lastAssistantText(undefined)).toBeNull();
    expect(lastAssistantText(path.join(home(), "nope.jsonl"))).toBeNull();
  });

  it("returns the last assistant text block, whitespace-collapsed", () => {
    const f = path.join(home(), "t1.jsonl");
    fs.writeFileSync(f, [line("assistant", [{ type: "text", text: "first" }]), line("user", [{ type: "text", text: "user says" }]), line("assistant", [{ type: "text", text: "  last\n\n  answer " }, { type: "text", text: "part2" }])].join("\n") + "\n");
    expect(lastAssistantText(f)).toBe("last answer part2");
  });

  it("skips assistant records that only have tool_use", () => {
    const f = path.join(home(), "t2.jsonl");
    fs.writeFileSync(f, [line("assistant", [{ type: "text", text: "real text" }]), line("assistant", [{ type: "tool_use", name: "Bash" }])].join("\n"));
    expect(lastAssistantText(f)).toBe("real text");
  });

  it("truncates to maxLen with an ellipsis", () => {
    const f = path.join(home(), "t3.jsonl");
    fs.writeFileSync(f, line("assistant", [{ type: "text", text: "a".repeat(50) }]));
    const out = lastAssistantText(f, 10)!;
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("tolerates a partial trailing line", () => {
    const f = path.join(home(), "t4.jsonl");
    fs.writeFileSync(f, line("assistant", [{ type: "text", text: "ok" }]) + '\n{"type":"assistant","message":{"con');
    expect(lastAssistantText(f)).toBe("ok");
  });
});

describe("claude.extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses a ```json fenced block", () => {
    expect(extractJson('Here:\n```json\n{"status":"UPDATE"}\n```\nbye')).toEqual({ status: "UPDATE" });
  });
  it("parses an unlabeled fence", () => {
    expect(extractJson('```\n{"x":[1,2]}\n```')).toEqual({ x: [1, 2] });
  });
  it("parses an object surrounded by prose", () => {
    expect(extractJson('Sure! {"status":"NED_OK","n":{"k":true}} hope that helps')).toEqual({ status: "NED_OK", n: { k: true } });
  });
  it("falls back to the whole text when the fence content is not JSON", () => {
    expect(extractJson('```bash\necho hi\n```\n{"ok":true}')).toEqual({ ok: true });
  });
  it("returns null for no object / broken JSON", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
    expect(extractJson("} {")).toBeNull();
  });
});

describe("claude helpers (no spawn)", () => {
  it("NED_NO_LLM=1 disables the LLM and yields NED_OK", () => {
    expect(llmDisabled()).toBe(true);
    expect(noLlmResult()).toMatchObject({ ok: true, text: '{"status":"NED_OK"}', cost_usd: 0 });
  });
  it("buildClaudeArgs: plan mode default, allowlist, isolation flags", () => {
    const a = buildClaudeArgs({ allowedTools: ["ToolSearch"], maxTurns: 3, model: "sonnet", isolated: true, effort: "low", tools: [] });
    // stream-json + --verbose since the fast-startup work (connector availability is read from the stream).
    expect(a.slice(0, 8)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan", "--max-turns", "3"]);
    expect(a).toContain("--allowedTools");
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--model") + 1]).toBe("sonnet");
  });
  it("buildClaudeArgs omits --allowedTools when empty", () => {
    expect(buildClaudeArgs({ allowedTools: [], maxTurns: 1 })).not.toContain("--allowedTools");
  });
});

describe("notify.notifyBackend", () => {
  it("off / osascript are explicit", () => {
    expect(notifyBackend("off", { NED_NOTIFY: "app" })).toBe("off");
    expect(notifyBackend("osascript", { NED_NOTIFY: "app" })).toBe("osascript");
  });
  it("auto delegates to Ned.app only when NED_NOTIFY=app", () => {
    expect(notifyBackend("auto", { NED_NOTIFY: "app" })).toBe("app");
    expect(notifyBackend("auto", {})).toBe("osascript");
    expect(notifyBackend(undefined, { NED_NOTIFY: "other" })).toBe("osascript");
  });
});
