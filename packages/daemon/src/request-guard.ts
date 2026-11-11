/**
 * DNS rebinding 방지 — 데몬의 모든 라우트(대시보드 정적 파일·/api/*·/mcp)에 거는 공용 미들웨어(server.ts `app.use("*")`).
 * 데몬은 127.0.0.1 에만 묶여 있지만, 브라우저가 공격자 도메인을 127.0.0.1 로 다시 풀면 그 페이지가 같은 출처로 요청할 수 있다.
 * 그런 요청은 Host·Origin 이 공격자 도메인이라 여기서 403.
 *
 * 규칙: Host 가 있는데 loopback(127.0.0.1·localhost·[::1], 포트 무관)이 아니면 403 · Origin 이 있는데 http(s) loopback 이
 * 아니면 403(`null` 포함) · 둘 다 없으면 허용(CLI·테스트의 Request 객체). 대시보드·Ned.app WKWebView(Origin
 * http://127.0.0.1:7777)·status.sh·curl 은 모두 loopback.
 */
import type { MiddlewareHandler } from "hono";
import { log } from "./paths.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** null = allowed; else why the request is refused (403). */
export function requestGuard(headers: { get(name: string): string | null }): string | null {
  const host = headers.get("host");
  if (host) {
    let h: string;
    try { h = new URL(`http://${host}`).hostname; } catch { return `bad Host: ${host.slice(0, 80)}`; }
    if (!LOOPBACK.has(h)) return `Host not allowed: ${host.slice(0, 80)}`;
  }
  const origin = headers.get("origin");
  if (origin != null) {
    let u: URL;
    try { u = new URL(origin); } catch { return `Origin not allowed: ${origin.slice(0, 80)}`; }
    if (!/^https?:$/.test(u.protocol) || !LOOPBACK.has(u.hostname)) return `Origin not allowed: ${origin.slice(0, 80)}`;
  }
  return null;
}

/** 403 for a refused request: JSON-RPC error shape on /mcp (MCP clients read it), plain JSON elsewhere. */
export const requestGuardMiddleware: MiddlewareHandler = async (c, next) => {
  const why = requestGuard(c.req.raw.headers);
  if (!why) return next();
  log(`request-guard: refused ${c.req.method} ${c.req.path.slice(0, 80)} — ${why}`);
  if (c.req.path === "/mcp") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: `Forbidden: ${why}` }, id: null }, 403);
  return c.json({ error: `forbidden: ${why}` }, 403);
};
