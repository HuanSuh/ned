/**
 * /mcp 통합: 임시 NED_HOME 으로 데몬 HTTP 서버를 실제 빈 포트에 띄우고, @modelcontextprotocol/sdk 의 Client +
 * StreamableHTTPClientTransport 로 initialize → tools/list → tools/call(ned_attention, ned_sessions) 를 호출한다.
 * DNS rebinding 방지: 잘못된 Origin / Host → 403, GET/DELETE → 405 (stateless).
 */
import fs from "node:fs";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const servers: { close(): void }[] = [];
vi.mock("@hono/node-server", async (orig) => {
  const real = await orig<typeof import("@hono/node-server")>();
  return { ...real, serve: (...a: Parameters<typeof real.serve>) => { const s = real.serve(...a); servers.push(s); return s; } };
});

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const PORT = await freePort();
process.env.NED_PORT = String(PORT);
console.log(`mcp-server.test: NED_HOME=${process.env.NED_HOME} port=${PORT}`);

const { startServer } = await import("../src/server.js");
const { loadConfig } = await import("../src/config.js");
const { CONFIG_PATH, STATE_PATH } = await import("../src/paths.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const NOW = Date.now();
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const post = (headers: Record<string, string>) => fetch(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(INIT) });

beforeAll(async () => {
  expect(process.env.NED_HOME).toMatch(/ned-test-/);
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { slack: true, gmail: true, jira: true, github: true, calendar: true, sentry: false } }));
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    updated_at: NOW, daemon_pid: 1, last_briefing: null, last_heartbeat_at: null, next_heartbeat_at: null, quiet: false, persona: "ned", attention_open_count: 1,
    sessions: [{ id: "abcdef12-3456", cwd: "/w/app", worktree: "app", status: "waiting", since: NOW - 60_000, last_event_ts: NOW, last_prompt: "테스트 돌려줘", last_summary: "권한 필요", subagents_active: 0, orca_worktree: null, alert_ts: NOW, is_worker: false }],
    attention: [{ id: "session:abcdef12-3456", kind: "session", title: "app 입력 대기", detail: "권한 필요", ts: NOW, source: "sessions" }],
  }));
  startServer(() => loadConfig());
  // serve() listens asynchronously — wait until the port answers.
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
});
afterAll(() => { for (const s of servers) s.close(); });

describe("MCP over Streamable HTTP (/mcp)", () => {
  it("initialize → tools/list → tools/call ned_attention + ned_sessions", async () => {
    const client = new Client({ name: "ned-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
    expect(client.getServerVersion()?.name).toBe("ned");
    expect(client.getInstructions()).toMatch(/ned_attention/);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ned_attention", "ned_briefing", "ned_feed", "ned_history", "ned_mark_reviewed", "ned_sessions"]);
    expect(tools.find((t) => t.name === "ned_attention")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "ned_mark_reviewed")!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(tools.find((t) => t.name === "ned_attention")!.description).toMatch(/응답 필요 일정.*맨 앞/);

    const att = (await client.callTool({ name: "ned_attention", arguments: { limit: 5 } })) as { content: { type: string; text: string }[]; isError?: boolean };
    console.log("ned_attention →", att.content[0].text, "\n", att.content[1].text.slice(0, 400));
    expect(att.isError).toBeFalsy();
    expect(att.content[0].text).toMatch(/확인할 것 1건 열림/);
    expect(JSON.parse(att.content[1].text).items[0]).toMatchObject({ review_key: "session:abcdef12-3456", source: "session", open: true });

    const ses = (await client.callTool({ name: "ned_sessions", arguments: {} })) as { content: { text: string }[] };
    console.log("ned_sessions →", ses.content[0].text, "\n", ses.content[1].text.slice(0, 400));
    expect(JSON.parse(ses.content[1].text).sessions[0]).toMatchObject({ id: "abcdef12", status: "waiting", waiting_for_input: true });

    // input validation by the zod schema → an error result, not a crash
    const bad = (await client.callTool({ name: "ned_attention", arguments: { source: "fax" } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);

    const res = await client.readResource({ uri: "ned://briefing/latest" });
    expect(res.contents[0].uri).toBe("ned://briefing/latest");
    await client.close();
  });

  // fetch won't let us set Host — a raw HTTP/1.1 request.
  const rawRequest = (method: string, p: string, host: string, body = "") => new Promise<string>((resolve, reject) => {
    const s = net.connect(PORT, "127.0.0.1", () => {
      s.write(`${method} ${p} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    let out = "";
    s.on("data", (d) => (out += d)).on("end", () => resolve(out)).on("error", reject);
  });

  it("Origin / Host guard on /mcp: a foreign Origin or Host → 403, loopback Origin → 200", async () => {
    expect((await post({ origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({ origin: `http://localhost:${PORT}` })).status).toBe(200);
    expect(await rawRequest("POST", "/mcp", `attacker.example:${PORT}`, JSON.stringify(INIT))).toMatch(/^HTTP\/1\.1 403/);
  });

  it("the same guard covers /api/* and the dashboard: forged Host / foreign Origin → 403, loopback → 200", async () => {
    expect(await rawRequest("GET", "/api/state", `attacker.example:${PORT}`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await rawRequest("GET", "/", `rebind.example:${PORT}`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await rawRequest("GET", "/api/state", `127.0.0.1:${PORT}`)).toMatch(/^HTTP\/1\.1 200/);
    expect(await rawRequest("GET", "/api/state", `localhost:${PORT}`)).toMatch(/^HTTP\/1\.1 200/);
    expect((await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    // Ned.app's WKWebView / the dashboard page: Origin http://127.0.0.1:<port>
    expect((await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { origin: `http://127.0.0.1:${PORT}` } })).status).toBe(200);
  });

  it("GET / DELETE → 405 (stateless: POST only)", async () => {
    expect((await fetch(URL_, { headers: { accept: "text/event-stream" } })).status).toBe(405);
    expect((await fetch(URL_, { method: "DELETE" })).status).toBe(405);
  });
});
