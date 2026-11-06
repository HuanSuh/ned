/**
 * Ned 채팅: storage / restore / prune, context digest cap, read-only run options, budget + concurrency gates and the SSE
 * stream end-to-end (NED_NO_LLM stub streams a canned answer), parsed with the dashboard's own parser (chat-core.js).
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { loadConfig, DEFAULT_CONFIG } = await import("../src/config.js");
const { CONFIG_PATH } = await import("../src/paths.js");
const { COSTS_PATH, recordCost } = await import("../src/costs.js");
const { buildClaudeArgs } = await import("../src/claude.js");
const chat = await import("../src/chat.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const core = await import("../public/app/features/chat-core.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const post = (p: string, body: unknown) => request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const setConfig = (extra: Record<string, unknown> = {}) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", ...extra }));

/** Read a whole SSE response through the dashboard's parser, fed in awkward 7-byte slices. */
async function readSse(r: Response): Promise<{ ev: string; data: Record<string, unknown> }[]> {
  const out: { ev: string; data: Record<string, unknown> }[] = [];
  const p = core.createSseParser((ev: string, data: Record<string, unknown>) => out.push({ ev, data }));
  const text = await r.text();
  for (let i = 0; i < text.length; i += 7) p.feed(text.slice(i, i + 7));
  p.end();
  return out;
}

beforeAll(() => {
  setConfig();
  startServer(() => loadConfig());
});
afterEach(() => {
  delete process.env.NED_NO_LLM_CHAT;
  delete process.env.NED_NO_LLM_DELAY_MS;
  delete process.env.NED_NO_LLM_COST;
  fs.rmSync(COSTS_PATH, { force: true });
  setConfig();
});

describe("chat storage", () => {
  it("save → read round-trips; bad ids never touch the filesystem", () => {
    const c = chat.newChat(1_700_000_000_000);
    c.title = "오늘 일정";
    c.session_id = "sess-1";
    c.messages.push({ role: "user", text: "오늘 일정?", ts: 1 }, { role: "ned", text: "3시 미팅 하나.", ts: 2, cost_usd: 0.01 });
    chat.saveChat(c);
    expect(chat.readChat(c.id)).toEqual(c);
    for (const bad of ["../config", "c-../../x", "", "c-A"]) expect(chat.readChat(bad)).toBeNull();
  });

  it(`keeps only the ${20} most recently updated chats`, () => {
    for (const f of fs.readdirSync(chat.CHATS_DIR)) fs.rmSync(path.join(chat.CHATS_DIR, f));
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const c = chat.newChat(1_000 + i);
      c.updated_at = 1_000 + i;
      chat.saveChat(c);
      ids.push(c.id);
    }
    const left = chat.listChats().map((x: { id: string }) => x.id);
    expect(left).toHaveLength(chat.CHAT_KEEP);
    expect(left[0]).toBe(ids[22]); // newest first
    expect(left).not.toContain(ids[0]);
    expect(left).not.toContain(ids[2]);
  });
});

describe("chat context digest", () => {
  const cfg = { sources: { ...DEFAULT_CONFIG.sources } };
  const big = (n: number) => "가".repeat(n);
  const agenda = {
    updated_at: Date.now() - 5 * 60_000,
    cost_usd: 0,
    calendar: Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, title: `회의 ${i} ${big(200)}`, start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString(), all_day: false, location: "", url: `https://cal/${i}`, meet_url: "", rsvp: "accepted", attendees: 3 })),
    jira: Array.from({ length: 40 }, (_, i) => ({ key: `NED-${i}`, title: big(300), status: "To Do", priority: "", due: null, url: `https://jira/NED-${i}`, updated: "" })),
    github: Array.from({ length: 40 }, (_, i) => ({ repo: "o/r", number: i, title: big(300), url: `https://gh/${i}`, author: "a", updated: "", reason: "review_requested" })),
    mail: { summary: "", unread: 3, unread_capped: false, items: [{ id: "m1", from: "boss", subject: "결재 요청", snippet: "", received: "", url: "https://mail/m1", reason: "approval", why: "오늘까지" }], all: [] },
    slack: { summary: "조용", items: [{ channel: "#dev", from: "kim", text: "배포 언제?", url: "https://slack/1", ts: "", reason: "mention" }], all: [], watch: [], threads: [], dms: [] },
  };
  const state = { attention: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, kind: "slack", title: `확인 ${i} ${big(300)}`, url: `https://x/${i}`, ts: i, source: "b" })), sessions: [{ id: "s", cwd: "/w/ned", worktree: "ned-chat", status: "running", last_prompt: "채팅 붙여 줘", is_worker: true }] };
  const briefings = [{ id: "b1", ts: Date.now(), type: "heartbeat", status: "UPDATE", headline: "결재 2건 기다려", action_items: [], updates: [], fyi: [] }];
  const todos = [{ id: "t", title: "보고서", done: false, created_at: 0, done_at: null, due: "2026-11-08", note: null }];

  it(`never exceeds ${6000} chars, even with huge inputs`, () => {
    const s = chat.buildChatContext({ cfg, agenda, state, briefings, todos } as never);
    expect(s.length).toBeLessThanOrEqual(chat.CHAT_CONTEXT_MAX);
    expect(s).toContain("### 확인 필요 (30건)");
    expect(s).toContain("https://x/29"); // newest attention first
    expect(s).not.toContain('"attention"'); // a digest, not the JSON
    const tight = chat.buildChatContext({ cfg, agenda, state, briefings, todos } as never, 1500);
    expect(tight.length).toBeLessThanOrEqual(1500);
    expect(tight).toContain("…(이하 생략)");
    expect(tight).toContain("### 확인 필요"); // priority order: attention survives, later sections go
  });

  it("small inputs: every section with titles + urls", () => {
    const small = { ...agenda, calendar: agenda.calendar.slice(0, 1), jira: agenda.jira.slice(0, 1).map((j) => ({ ...j, title: "로그인 버그" })), github: [] };
    const s = chat.buildChatContext({ cfg, agenda: small, state: { ...state, attention: state.attention.slice(0, 1) }, briefings, todos } as never);
    for (const want of ["### 오늘 일정", "https://cal/0", "### Slack 답할 것 — 조용", "배포 언제? https://slack/1", "결재 요청", "NED-0 [To Do] 로그인 버그", "### 열린 에이전트 세션", "ned-chat · running (워커) · 채팅 붙여 줘", "결재 2건 기다려", "보고서 (마감 2026-11-08)"]) expect(s).toContain(want);
    expect(s).not.toContain("…(이하 생략)");
  });

  it("system prompt: persona + rules + context", () => {
    const sys = chat.buildChatSystemPrompt(loadConfig(), "CTX-MARKER");
    expect(sys).toContain("### Ned");
    expect(sys).toContain("쓰기 도구는 절대 쓰지 않는다");
    expect(sys).toContain("CTX-MARKER");
    expect(sys).not.toMatch(/\{\{[A-Z]+\}\}/);
  });
});

describe("feature guide (docs/FEATURES.md 요약) in the system prompt", () => {
  const md = ["# Ned 기능 가이드", "", "## 요약", "", "- 인박스: 확인 필요 모음", "```", "## 코드블록 속 제목은 무시", "```", "### 하위 제목은 포함", "- 타임라인", "", "## 상세", "", "상세 본문"].join("\n");

  it("extracts only the 요약 section (sub-headings kept, fenced headings ignored, stops at the next same-level heading)", () => {
    const s = chat.extractFeaturesSummary(md)!;
    expect(s.startsWith("- 인박스")).toBe(true);
    expect(s).toContain("## 코드블록 속 제목은 무시");
    expect(s).toContain("### 하위 제목은 포함");
    expect(s).toContain("- 타임라인");
    expect(s).not.toContain("상세 본문");
    expect(chat.extractFeaturesSummary("# 제목\n\n## 상세\n본문")).toBeNull();
    expect(chat.extractFeaturesSummary("## 요약\n\n## 상세\n본문")).toBeNull();
    expect(chat.extractFeaturesSummary("## 요약 (≤2,500자)\n본문\n# 끝")).toBe("본문");
  });

  it("clamps at FEATURES_SUMMARY_MAX (3,000) independent of the context cap", () => {
    const long = `## 요약\n${"가".repeat(5000)}\n## 상세\n`;
    const s = chat.extractFeaturesSummary(long)!;
    expect(chat.FEATURES_SUMMARY_MAX).toBe(3000);
    expect(s.length).toBe(3000);
    expect(s.endsWith("…")).toBe(true);
    expect(chat.extractFeaturesSummary(long, 100)!.length).toBe(100);
  });

  it("clamps at a line boundary: over 3,000 chars the last kept line is whole", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `- 항목 ${String(i).padStart(2, "0")}: ${"설명".repeat(20)} 끝`);
    const s = chat.extractFeaturesSummary(`## 요약\n${lines.join("\n")}\n## 상세\n`)!;
    expect(lines.join("\n").length).toBeGreaterThan(3000);
    expect(s.length).toBeLessThanOrEqual(3000);
    expect(s.endsWith("끝…")).toBe(true);
    const kept = s.slice(0, -1).split("\n");
    expect(kept.every((l, i) => l === lines[i])).toBe(true);
    expect(kept.length).toBeLessThan(lines.length);
  });

  it("missing file / no section → null; the prompt drops only that section", () => {
    const dir = fs.mkdtempSync(path.join(process.env.NED_HOME!, "feat-"));
    expect(chat.readFeaturesSummary(path.join(dir, "nope.md"))).toBeNull();
    fs.writeFileSync(path.join(dir, "nosec.md"), "# 가이드\n\n## 상세\n본문\n");
    expect(chat.readFeaturesSummary(path.join(dir, "nosec.md"))).toBeNull();
    fs.writeFileSync(path.join(dir, "ok.md"), md);
    expect(chat.readFeaturesSummary(path.join(dir, "ok.md"))).toContain("- 인박스");

    const without = chat.buildChatSystemPrompt(loadConfig(), "CTX-MARKER", new Date(), null);
    expect(without).not.toContain("Ned 기능 안내 (docs");
    expect(without).toContain("CTX-MARKER");
    expect(without).not.toMatch(/\{\{[A-Z]+\}\}/);
    const withF = chat.buildChatSystemPrompt(loadConfig(), "CTX-MARKER", new Date(), "FEAT-MARKER");
    expect(withF).toContain("## Ned 기능 안내");
    expect(withF).toContain("FEAT-MARKER");
    expect(withF.indexOf("FEAT-MARKER")).toBeLessThan(withF.indexOf("CTX-MARKER"));
    expect(withF).toContain("설정 경로(탭 → 섹션 → 항목)와 설정 키");
  });

  it("the repo's docs/FEATURES.md has a 요약 section within 2,500 chars", () => {
    const s = chat.readFeaturesSummary();
    expect(s).toBeTruthy();
    expect(s!.length).toBeLessThanOrEqual(2500);
    expect(s).toContain("actions.gmail_mark_read");
  });
});

describe("chat run options are read-only", () => {
  it("allowedTools: reads only; --tools has no Edit/Write; plan mode; resume + system prompt + partial deltas", () => {
    const cfg = { ...loadConfig(), sources: { ...DEFAULT_CONFIG.sources, sentry: true } };
    const o = chat.chatRunOptions(cfg, "SYS", "sess-9");
    for (const t of o.allowedTools) expect(t).not.toMatch(/send|create|update|delete|trash|reply|draft|_label_|unlabel|edit|transition|addComment|merge|respond|share|Write|Edit/i);
    expect(o.allowedTools).toContain("mcp__claude_ai_Slack__slack_read_thread");
    expect(o.allowedTools).toContain("Bash(gh pr view:*)");
    expect(o.allowedTools).toContain("Bash(orca status:*)");
    expect(o.allowedTools.some((t: string) => t.startsWith("Bash(gh api"))).toBe(false);
    expect(o.tools).toEqual(["ToolSearch", "Bash"]);
    expect(o.maxTurns).toBe(12);
    expect(o.job).toBe("chat");
    const argv = buildClaudeArgs({ ...o, fastStartup: false });
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "plan"]);
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", "sess-9"]);
    expect(argv.slice(argv.indexOf("--append-system-prompt"), argv.indexOf("--append-system-prompt") + 2)).toEqual(["--append-system-prompt", "SYS"]);
    expect(argv).toContain("--include-partial-messages");
    expect(buildClaudeArgs({ ...chat.chatRunOptions(cfg, "S", null), fastStartup: false })).not.toContain("--resume");
  });

  it("source switched off → its connector tools are not allowed", () => {
    const o = chat.chatRunOptions({ ...loadConfig(), sources: { ...DEFAULT_CONFIG.sources, gmail: false } }, "S", null);
    expect(o.allowedTools.some((t: string) => t.includes("Gmail"))).toBe(false);
  });
});

describe("POST /api/chat (SSE)", () => {
  it("streams start → delta… → done, saves both messages, and resumes on the next turn", async () => {
    process.env.NED_NO_LLM_CHAT = "오늘은 3시 미팅 하나야. [캘린더](https://cal/x) 봐.";
    process.env.NED_NO_LLM_COST = "0.02";
    const r = await post("/api/chat", { text: "오늘 일정 뭐야?" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const evs = await readSse(r);
    expect(evs[0].ev).toBe("start");
    const id = evs[0].data.conversation_id as string;
    const deltas = evs.filter((e) => e.ev === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((e) => e.data.text).join("")).toBe(process.env.NED_NO_LLM_CHAT);
    const done = evs.at(-1)!;
    expect(done.ev).toBe("done");
    expect(done.data).toMatchObject({ conversation_id: id, stopped: false, cost_usd: 0.02, chat_cost_usd: 0.02 });

    const saved = chat.readChat(id)!;
    expect(saved.messages.map((m: { role: string }) => m.role)).toEqual(["user", "ned"]);
    expect(saved.session_id).toBe(`stub-${id}`);
    expect(saved.title).toBe("오늘 일정 뭐야?");

    const r2 = await post("/api/chat", { conversation_id: id, text: "그 다음은?" });
    const evs2 = await readSse(r2);
    expect(evs2.at(-1)!.data.chat_cost_usd).toBe(0.04);
    expect(chat.readChat(id)!.messages).toHaveLength(4);
    const got = await (await request(`/api/chat/${id}`)).json();
    expect(got).toMatchObject({ id, running: false, cost_usd: 0.04 });
    expect(JSON.parse(fs.readFileSync(COSTS_PATH, "utf8")).days[Object.keys(JSON.parse(fs.readFileSync(COSTS_PATH, "utf8")).days)[0]].jobs.chat.runs).toBe(2);
  });

  it("400 empty / too long, 404 unknown conversation", async () => {
    expect((await post("/api/chat", { text: "  " })).status).toBe(400);
    const long = await post("/api/chat", { text: "x".repeat(2001) });
    expect(long.status).toBe(400);
    expect((await long.json()).error).toContain("2000자");
    expect((await post("/api/chat", { text: "hi", conversation_id: "c-nothere1" })).status).toBe(404);
  });

  it("409 while another turn runs; stop SIGTERMs (stub: aborts) it → done{stopped}", async () => {
    process.env.NED_NO_LLM_DELAY_MS = "40";
    process.env.NED_NO_LLM_CHAT = "아주 긴 답이 천천히 흘러나오는 중이야. ".repeat(4);
    const r = await post("/api/chat", { text: "길게 말해 줘" });
    expect(r.status).toBe(200);
    const id = chat.activeChat();
    expect(id).toBeTruthy();
    const busy = await post("/api/chat", { text: "또" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).conversation_id).toBe(id);
    await new Promise((res) => setTimeout(res, 60));
    expect((await post(`/api/chat/${id}/stop`, {})).status).toBe(200);
    const evs = await readSse(r);
    expect(evs.at(-1)).toMatchObject({ ev: "done", data: { stopped: true } });
    expect(chat.activeChat()).toBeNull();
    const last = chat.readChat(id!)!.messages.at(-1)!;
    expect(last.stopped).toBe(true);
    expect(last.text.length).toBeLessThan(process.env.NED_NO_LLM_CHAT!.length);
    expect((await post(`/api/chat/${id}/stop`, {})).status).toBe(404); // nothing running any more
  });

  it("429 over the daily budget unless chat_ignore_budget", async () => {
    setConfig({ agenda_daily_budget_usd: 1 });
    recordCost("agenda", 1.5);
    const r = await post("/api/chat", { text: "예산?" });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ budget: true });
    setConfig({ agenda_daily_budget_usd: 1, chat_ignore_budget: true });
    const ok = await post("/api/chat", { text: "예산?" });
    expect(ok.status).toBe(200);
    expect((await readSse(ok)).at(-1)!.ev).toBe("done");
  });

  it("GET /api/chats lists newest first", async () => {
    const j = await (await request("/api/chats")).json();
    expect(j.input_max).toBe(2000);
    expect(j.chats.length).toBeGreaterThan(0);
    expect(j.chats[0].updated_at).toBeGreaterThanOrEqual(j.chats.at(-1).updated_at);
  });
});

describe("dashboard SSE parser", () => {
  it("frames split anywhere, CRLF, comments, multi-line data, raw strings", () => {
    const got: [string, unknown][] = [];
    const p = core.createSseParser((ev: string, d: unknown) => got.push([ev, d]));
    const text = ': hi\r\nevent: delta\r\ndata: {"text":"안녕"}\r\n\r\nevent: x\ndata: a\ndata: b\n\ndata: {"n":1}\n\n';
    for (const ch of text) p.feed(ch);
    p.end();
    expect(got).toEqual([["delta", { text: "안녕" }], ["x", "a\nb"], ["message", { n: 1 }]]);
  });
});
