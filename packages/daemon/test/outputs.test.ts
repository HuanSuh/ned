/**
 * 정리 결과물 (src/outputs.ts): ```ned-output extraction, ~/.ned/outputs (always) + vault note (config.archive), the
 * /api/outputs routes, a NED_NO_LLM chat turn end to end (message.output + done SSE + daily report link), and the
 * dashboard's 저장 카드 (public/app/features/chat-output.js). Temp vault only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { loadConfig, DEFAULT_ARCHIVE } = await import("../src/config.js");
const { CONFIG_PATH, localDay } = await import("../src/paths.js");
const outputs = await import("../src/outputs.js");
// @ts-expect-error — plain browser ES modules (public/app), no types
const core = await import("../public/app/features/chat-core.js");
// @ts-expect-error — plain browser ES module
const card = await import("../public/app/features/chat-output.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const post = (p: string, body: unknown) => request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ned-vault-out-"));
const V = path.join(tmpRoot, "vault");
afterAll(() => {
  if (tmpRoot.startsWith(path.join(os.tmpdir(), "ned-vault-out-"))) fs.rmSync(tmpRoot, { recursive: true, force: true });
});
const arch = (o: Record<string, unknown> = {}) => ({ ...DEFAULT_ARCHIVE, enabled: true, vault: V, ...o });
const fence = (j: unknown) => "```ned-output\n" + (typeof j === "string" ? j : JSON.stringify(j)) + "\n```";
const MD = "배포는 목요일.\n\n## 결정\n- 목요일 배포\n\n## 액션 아이템\n- [ ] 릴리즈 노트 #task 📅 2026-11-12\n\n## 출처\n- https://slack.example/p1.";

beforeAll(() => startServer(() => loadConfig()));
beforeEach(() => {
  fs.rmSync(V, { recursive: true, force: true });
  fs.mkdirSync(path.join(V, ".obsidian"), { recursive: true });
  fs.rmSync(outputs.OUTPUTS_DIR, { recursive: true, force: true });
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
  delete process.env.NED_NO_LLM_CHAT;
});

describe("extractOutputBlock", () => {
  it("none / valid / last one wins / kind + title fallbacks", () => {
    expect(outputs.extractOutputBlock("그냥 답")).toBeNull();
    expect(outputs.extractOutputBlock(`요약\n${fence({ kind: "meeting", title: "주간", markdown: MD })}`)).toEqual({ block: { kind: "meeting", title: "주간", markdown: MD } });
    const two = `${fence({ kind: "mail", title: "A", markdown: "a" })}\n${fence({ kind: "document", title: "B", markdown: "b" })}`;
    expect(outputs.extractOutputBlock(two)).toMatchObject({ block: { title: "B", kind: "document" } });
    expect(outputs.extractOutputBlock(fence({ kind: "weird", markdown: "## 제목에서\n본문" }))).toMatchObject({ block: { kind: "other", title: "제목에서" } });
    expect(outputs.extractOutputBlock(fence({ markdown: "본문" }))).toMatchObject({ block: { title: "정리 정리" } });
  });
  it("malformed → error (never thrown)", () => {
    expect(outputs.extractOutputBlock(fence("{nope"))).toEqual({ error: expect.stringMatching(/JSON/) });
    expect(outputs.extractOutputBlock(fence({ kind: "meeting", markdown: "  " }))).toEqual({ error: expect.stringMatching(/비어/) });
    expect(outputs.extractOutputBlock(fence("[1]"))).toEqual({ error: expect.any(String) });
  });
  it("slugify keeps Korean, drops path / link characters", () => {
    expect(outputs.slugify("주간 동기화: 11/7 [최종]#1?")).toBe("주간 동기화 11 7 최종 1");
    expect(outputs.slugify("../../etc")).toBe("etc");
    expect(outputs.slugify("  ")).toBe("정리");
  });
});

describe("saveOutput", () => {
  it("archive off → ~/.ned/outputs only (json + md), no vault write", () => {
    const r = outputs.saveOutput({ ...DEFAULT_ARCHIVE, vault: V }, { kind: "meeting", title: "주간", markdown: MD });
    expect(r.vault_rel).toBeUndefined();
    expect(fs.existsSync(path.join(outputs.OUTPUTS_DIR, `${r.id}.json`))).toBe(true);
    expect(fs.readFileSync(path.join(outputs.OUTPUTS_DIR, `${r.id}.md`), "utf8")).toContain("# 주간");
    expect(fs.existsSync(path.join(V, "Ned"))).toBe(false);
    expect(r.sources).toEqual(["https://slack.example/p1"]);
  });

  it("archive on → Notes/YYYY-MM/DAY.slug.md with frontmatter; a second one with the same title gets (2)", () => {
    const now = new Date(2026, 10, 7, 14, 0).getTime();
    const a = outputs.saveOutput(arch(), { kind: "meeting", title: "주간 동기화", markdown: MD }, { now });
    expect(a.vault_rel).toBe("Ned/Notes/2026-11/2026-11-07.주간 동기화.md");
    const note = fs.readFileSync(path.join(V, a.vault_rel!), "utf8");
    expect(note).toBe(`---\ndate: 2026-11-07\nkind: meeting\nsource:\n  - https://slack.example/p1\ntags:\n  - ned\n  - meeting\n---\n\n# 주간 동기화\n\n${MD}\n`);
    expect(a.obsidian_url).toBe(`obsidian://open?vault=vault&file=${encodeURIComponent("Ned/Notes/2026-11/2026-11-07.주간 동기화")}`);
    const b = outputs.saveOutput(arch(), { kind: "meeting", title: "주간 동기화", markdown: "# 이미 제목\n본문" }, { now });
    expect(b.vault_rel).toBe("Ned/Notes/2026-11/2026-11-07.주간 동기화 (2).md");
    expect(fs.readFileSync(path.join(V, b.vault_rel!), "utf8")).toContain("---\n\n# 이미 제목\n본문\n"); // no duplicate heading
    expect(outputs.listOutputs({ day: "2026-11-07" }).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(outputs.listOutputs({ day: "2026-11-06" })).toEqual([]);
  });

  it("include.outputs off → not in the vault; a broken vault → vault_error, ~/.ned copy kept", () => {
    const off = outputs.saveOutput(arch({ include: { ...DEFAULT_ARCHIVE.include, outputs: false } }), { kind: "other", title: "x", markdown: "y" });
    expect(off.vault_rel).toBeUndefined();
    expect(off.vault_error).toBeUndefined();
    const bad = outputs.saveOutput(arch({ vault: path.join(tmpRoot, "gone") }), { kind: "other", title: "x", markdown: "y" });
    expect(bad.vault_error).toMatch(/볼트에 못 썼어/);
    expect(outputs.readOutput(bad.id)?.vault_error).toBe(bad.vault_error);
  });
});

describe("chat turn → saved output (NED_NO_LLM)", () => {
  it("done SSE + saved message carry `output`; /api/outputs lists it; reveal is a dry run; the daily report links it", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", archive: { enabled: true, vault: V } }));
    process.env.NED_NO_LLM_CHAT = `회의 정리했어. 결론: 목요일 배포.\n\n${fence({ kind: "meeting", title: "주간 동기화", markdown: MD })}`;
    const r = await post("/api/chat", { text: "방금 회의 정리해 줘" });
    const events: { ev: string; data: Record<string, unknown> }[] = [];
    const p = core.createSseParser((ev: string, data: Record<string, unknown>) => events.push({ ev, data }));
    p.feed(await r.text());
    p.end();
    const done = events.find((e) => e.ev === "done")!.data as { conversation_id: string; output: { id: string; vault_rel: string; obsidian_url: string } };
    expect(done.output).toMatchObject({ kind: "meeting", title: "주간 동기화" });
    expect(done.output.vault_rel).toMatch(/^Ned\/Notes\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}\.주간 동기화\.md$/);

    const chat = await (await request(`/api/chat/${done.conversation_id}`)).json();
    expect(chat.messages[1].output).toEqual(done.output);

    const list = await (await request("/api/outputs")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: done.output.id, kind: "meeting", chat_id: done.conversation_id });
    expect(list[0].markdown).toBeUndefined();
    expect((await (await request(`/api/outputs/${done.output.id}`)).json()).markdown).toBe(MD);
    expect((await request("/api/outputs/o-nope1234")).status).toBe(404);
    expect((await request("/api/outputs/..%2Fconfig")).status).toBe(404);

    const rv = await (await post(`/api/outputs/${done.output.id}/reveal`, {})).json();
    expect(rv).toMatchObject({ ok: true, dry_run: true, path: path.join(V, done.output.vault_rel) });

    const day = localDay();
    const rep = fs.readFileSync(path.join(V, "Ned", "Daily", day.slice(0, 7), `${day}.md`), "utf8");
    expect(rep).toContain(`[[${done.output.vault_rel.replace(/\.md$/, "")}|주간 동기화]] · 회의`);
  });

  it("a malformed block → output_error on the message, nothing saved", async () => {
    process.env.NED_NO_LLM_CHAT = `정리\n${fence("{broken")}`;
    const r = await post("/api/chat", { text: "정리해 줘" });
    const text = await r.text();
    expect(text).toContain("output_error");
    expect(outputs.listOutputs()).toEqual([]);
  });
});

describe("dashboard 저장 카드 (chat-output.js)", () => {
  const answer = `요약 세 줄.\n\n${fence({ kind: "meeting", title: "주간", markdown: "## 결정\n- 목요일" })}`;

  it("parseOutputBlock hides the fence; an unterminated one (streaming) is pending", () => {
    expect(card.parseOutputBlock(answer)).toEqual({ text: "요약 세 줄.", block: { kind: "meeting", title: "주간", markdown: "## 결정\n- 목요일" }, pending: false });
    expect(card.parseOutputBlock('요약\n```ned-output\n{"kind":"me')).toEqual({ text: "요약", block: null, pending: true });
    expect(card.parseOutputBlock("그냥 답")).toEqual({ text: "그냥 답", block: null, pending: false });
  });

  it("messagesHtml: saved card with Obsidian + Finder buttons and the note under 내용 보기; no raw fence", () => {
    const out = { id: "o-abc123", kind: "meeting", title: "주간", vault_rel: "Ned/Notes/2026-11/2026-11-07.주간.md", obsidian_url: "obsidian://open?vault=v&file=Ned%2FNotes" };
    const html = core.messagesHtml([{ role: "ned", text: answer, ts: 1, output: out }], core.commsVoice("ned"));
    expect(html).not.toContain("ned-output");
    expect(html).toContain("📎 회의 정리 저장됨");
    expect(html).toContain('href="obsidian://open?vault=v&amp;file=Ned%2FNotes"');
    expect(html).toContain('data-out-reveal="o-abc123"');
    expect(html).toContain("볼트: Ned/Notes/2026-11/2026-11-07.주간.md");
    expect(html).toContain("<summary>내용 보기</summary>");
  });

  it("vault off / vault error / output_error / a non-obsidian url is never linked", () => {
    expect(card.renderOutputCard({ out: { id: "o-1234", kind: "mail", title: "t" } })).toContain("Obsidian 아카이브 꺼짐");
    expect(card.renderOutputCard({ out: { id: "o-1234", kind: "mail", title: "t", vault_error: "볼트에 못 썼어: x" } })).toContain("Ned 에만 저장 — 볼트에 못 썼어: x");
    expect(card.renderOutputCard({ err: "JSON 형식 오류" })).toContain("⚠ JSON 형식 오류");
    expect(card.renderOutputCard({ out: { id: "o-1234", kind: "mail", title: "t", obsidian_url: "javascript:alert(1)" } })).not.toContain("javascript:");
  });

  it("live answer: the fence shows as '저장 준비 중'", () => {
    const html = core.messagesHtml([], core.commsVoice("ned"), { text: '요약\n```ned-output\n{"kind"', tool: "" });
    expect(html).toContain("정리 결과 저장 준비 중");
    expect(html).not.toContain("ned-output");
  });
});
