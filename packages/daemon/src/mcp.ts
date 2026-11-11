/**
 * MCP 서버 — 같은 데몬(127.0.0.1:<port>)이 Streamable HTTP 엔드포인트 /mcp 를 연다. 플러그인 .mcp.json 이 이걸
 * 가리켜, 플러그인을 설치한 모든 Claude Code 세션에서 Ned 도구(src/mcp-tools.ts)를 쓸 수 있다.
 *
 * - 트랜스포트: @modelcontextprotocol/sdk WebStandardStreamableHTTPServerTransport (웹 표준 Request/Response → hono
 *   c.req.raw 를 그대로 넘긴다). Stateless(sessionIdGenerator: undefined) + JSON 응답(enableJsonResponse) — 요청마다
 *   McpServer·트랜스포트를 새로 만들고 응답 뒤 닫는다(SDK 예제 simpleStatelessStreamableHttp 와 같은 방식).
 *   GET(서버→클라이언트 SSE 스트림)·DELETE(세션 종료)는 세션이 없으니 405.
 * - 로컬 전용: 데몬은 127.0.0.1 에만 묶여 있고, DNS rebinding 방지 가드(src/request-guard.ts — server.ts 가 모든 라우트에
 *   건다)가 loopback 이 아닌 Host·Origin 을 403. 인증은 없다(/api·/mcp 모두 같은 가드).
 * - 쓰기는 ned_mark_reviewed(✓) 하나뿐.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readAgenda } from "./agenda.js";
import { readFeaturesSummary } from "./chat.js";
import { loadConfig } from "./config.js";
import { listBriefings } from "./heartbeat.js";
import { log } from "./paths.js";
import { readReviewed, readState } from "./state.js";
import {
  MAX_BRIEFINGS, attentionInput, briefingInput, briefingView, feedInput, historyInput, markReviewedInput, sessionsInput,
  toolAttention, toolBriefing, toolFeed, toolHistory, toolMarkReviewed, toolSessions, type ToolCtx, type ToolOut,
} from "./mcp-tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.resolve(here, "../../../package.json"), "utf8")).version || "0.0.0"); } catch { return "0.0.0"; }
})();

/** What the tool handlers read — fresh from disk on every call (config.yaml, state.json, agenda.json, reviewed.json, briefings/). */
export function readToolCtx(now = Date.now()): ToolCtx {
  return { cfg: loadConfig(), state: readState(), agenda: readAgenda(), marks: readReviewed(), briefings: listBriefings(30), now };
}

/** ToolOut → MCP CallToolResult: a one-line summary block + the JSON block. */
const result = (o: ToolOut) => ({
  content: [
    { type: "text" as const, text: o.summary },
    { type: "text" as const, text: JSON.stringify(o.data) },
  ],
  ...(o.error ? { isError: true } : {}),
});

const guarded = (name: string, fn: () => ToolOut | Promise<ToolOut>) => async () => {
  try {
    return result(await fn());
  } catch (e) {
    log(`mcp: ${name} failed — ${String(e).slice(0, 200)}`);
    return result({ summary: `${name} 실패: ${String((e as Error)?.message ?? e).slice(0, 200)}`, data: { error: String(e).slice(0, 500) }, error: true });
  }
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const MCP_TOOL_NAMES = ["ned_attention", "ned_sessions", "ned_briefing", "ned_history", "ned_feed", "ned_mark_reviewed"] as const;

/** A fresh McpServer with Ned's tools and resources (one per request — stateless). */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "ned", version: VERSION },
    {
      instructions:
        "Ned 데몬이 모은 업무 신호(Slack·메일·Jira·GitHub·일정)와 에이전트 세션을 읽는다. 지금 볼 것은 ned_attention, 세션은 ned_sessions, 최근 판단은 ned_briefing. " +
        "Read what the local Ned daemon collected: open attention items, agent sessions, briefings, history, feed. The only write is ned_mark_reviewed (✓).",
    },
  );

  server.registerTool("ned_attention", {
    title: "Ned: 확인할 것",
    description: "열린 '확인할 것' 목록(소스·제목·링크·시각·review_key·열림 여부) — 응답 필요 일정(시작 시각이 미래)은 맨 앞, 나머지는 최신순.\nOpen attention items Ned collected (Slack, mail, Jira, GitHub, calendar RSVPs, sessions) with review keys — RSVP-needed events first (future start), the rest newest first.",
    inputSchema: attentionInput,
    annotations: READ,
  }, (args) => guarded("ned_attention", () => toolAttention(args, readToolCtx()))());

  server.registerTool("ned_sessions", {
    title: "Ned: 세션",
    description: "Claude Code 세션 목록(id 앞 8자·워크트리·상태·시작 시각·마지막 프롬프트/요약·입력 대기 여부).\nAgent sessions Ned tracks via hooks: worktree, status, last prompt / summary, waiting-for-input.",
    inputSchema: sessionsInput,
    annotations: READ,
  }, (args) => guarded("ned_sessions", () => toolSessions(args, readToolCtx()))());

  server.registerTool("ned_briefing", {
    title: "Ned: 브리핑",
    description: "최신 브리핑(또는 since 이후 브리핑들)의 헤드라인·할 일·업데이트·참고·시각·상태.\nThe latest Ned briefing (or those since a time): headline, action items, updates, FYI.",
    inputSchema: briefingInput,
    annotations: READ,
  }, (args) => guarded("ned_briefing", () => toolBriefing(args, readToolCtx()))());

  server.registerTool("ned_history", {
    title: "Ned: 수집 이력",
    description: "한 소스의 지난 N일 수집 이력(기본 1일), 검색어·채널 필터.\nCollected history of one source over the last N days (default 1), with optional search / channel filter.",
    inputSchema: historyInput,
    annotations: READ,
  }, (args) => guarded("ned_history", () => toolHistory(args, readToolCtx()))());

  server.registerTool("ned_feed", {
    title: "Ned: 메시지 피드",
    description: "펫/통신기 메시지 피드 최근 n개(열린 attention·24시간 브리핑·내 답 이후 새 답글 스레드).\nRecent message feed (what the desktop pet shows): open attention, recent briefing headlines, threads with new replies.",
    inputSchema: feedInput,
    annotations: READ,
  }, (args) => guarded("ned_feed", () => toolFeed(args, readToolCtx()))());

  server.registerTool("ned_mark_reviewed", {
    title: "Ned: 확인 완료(✓)",
    description: "review_key 로 확인 완료(✓) 표시/해제 — 대시보드 ✓ 와 같다(메일은 설정에 따라 Gmail 읽음 처리도).\nMark / unmark an item as reviewed by its review_key (same as the dashboard ✓).",
    inputSchema: markReviewedInput,
    // openWorld: with actions.gmail_mark_read on, a mail ✓ also marks the Gmail thread read (an outside side effect).
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => guarded("ned_mark_reviewed", () => toolMarkReviewed(args))());

  server.registerResource("briefing-latest", "ned://briefing/latest", {
    title: "Ned 최신 브리핑",
    description: "The latest Ned briefing as JSON",
    mimeType: "application/json",
  }, (uri) => {
    const b = listBriefings(MAX_BRIEFINGS)[0];
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(b ? briefingView(b) : null) }] };
  });

  server.registerResource("features", "ned://features", {
    title: "Ned 기능 요약",
    description: "docs/FEATURES.md 요약 — what Ned does",
    mimeType: "text/markdown",
  }, (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: readFeaturesSummary() ?? "(FEATURES.md 요약을 읽을 수 없어)" }] }));

  return server;
}

/** POST /mcp (JSON-RPC), GET / DELETE /mcp → 405 (stateless: no standalone SSE stream, no sessions). */
// Host / Origin are checked before any route by the server-wide guard (src/request-guard.ts).
export function registerMcp(app: Hono): void {
  const notAllowed = () => Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }, { status: 405, headers: { allow: "POST" } });

  app.post("/mcp", async (c) => {
    const server = buildMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (e) {
      log(`mcp: request failed — ${String(e).slice(0, 200)}`);
      return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }, { status: 500 });
    } finally {
      // JSON mode: the response body is complete once handleRequest resolves.
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    }
  });
  app.get("/mcp", () => notAllowed());
  app.delete("/mcp", () => notAllowed());
}
