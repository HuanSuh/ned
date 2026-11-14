/**
 * DNS rebinding·로컬 다른 포트 방지 — 데몬의 모든 라우트(대시보드 정적 파일·/api/*·/mcp)에 거는 공용 미들웨어
 * (server.ts `app.use("*", requestGuardMiddleware(port))`).
 * 데몬은 127.0.0.1 에만 묶여 있지만, 브라우저가 공격자 도메인을 127.0.0.1 로 다시 풀면 그 페이지가 같은 출처로 요청할 수 있고,
 * 같은 Mac 의 다른 포트 로컬 웹페이지(개발 서버 등)도 fetch 할 수 있다. 그런 요청은 Host·Origin 이 다르므로 여기서 403.
 *
 * 규칙(port = 데몬이 실제로 listen 하는 포트):
 * - Host 가 있으면 loopback 호스트(127.0.0.1·localhost·[::1]) + `:port` 만 허용. 포트 생략은 거부(데몬은 80 이 아님).
 * - Origin 이 있으면 `http(s)://{127.0.0.1|localhost|[::1]}:port` 만 허용(`null`·다른 스킴·다른 포트 거부).
 * - `Sec-Fetch-Site` 가 있으면 `same-origin`·`none` 만 허용 — 브라우저의 다른 사이트·다른 포트(same-site) 페이지가 Origin 없이
 *   보내는 no-cors GET(<img src>) 도 403.
 * - 이 헤더들이 없으면 허용(CLI·URLSession·MCP 클라이언트·테스트의 Request 객체).
 * 대시보드·Ned.app WKWebView(Origin http://127.0.0.1:<port>)·Ned.app URLSession·status.sh(curl)·MCP 클라이언트는
 * 모두 http://127.0.0.1:<port> 로 붙으므로 Host 가 `127.0.0.1:<port>`.
 */
import type { MiddlewareHandler } from "hono";
import { log } from "./paths.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** null = allowed; else why the request is refused (403). `port` is the daemon's listening port. */
export function requestGuard(headers: { get(name: string): string | null }, port: number): string | null {
  const host = headers.get("host");
  if (host) {
    let u: URL;
    try { u = new URL(`http://${host}`); } catch { return `bad Host: ${host.slice(0, 80)}`; }
    if (!LOOPBACK.has(u.hostname)) return `Host not allowed: ${host.slice(0, 80)}`;
    // URL drops ":80" for http — an explicit port must be present in the raw header and equal the daemon port.
    if (!/:\d+$/.test(host) || Number(host.slice(host.lastIndexOf(":") + 1)) !== port) return `Host port not allowed: ${host.slice(0, 80)}`;
  }
  const origin = headers.get("origin");
  if (origin != null) {
    let u: URL;
    try { u = new URL(origin); } catch { return `Origin not allowed: ${origin.slice(0, 80)}`; }
    if (!/^https?:$/.test(u.protocol) || !LOOPBACK.has(u.hostname)) return `Origin not allowed: ${origin.slice(0, 80)}`;
    const p = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (p !== port) return `Origin port not allowed: ${origin.slice(0, 80)}`;
  }
  // A browser marks every request with Sec-Fetch-Site. A no-cors GET from another page (<img src=…/api/calendar>) carries
  // no Origin, but it is cross-site / same-site (another 127.0.0.1 port is same-site) — refused, so it cannot trigger
  // costly GETs (claude -p, ?refresh=1). Only the dashboard itself (same-origin) and a typed URL / app-opened page (none) pass.
  const site = headers.get("sec-fetch-site");
  if (site != null && site !== "same-origin" && site !== "none") return `Sec-Fetch-Site not allowed: ${site.slice(0, 40)}`;
  return null;
}

/** 403 for a refused request: JSON-RPC error shape on /mcp (MCP clients read it), plain JSON elsewhere. */
export function requestGuardMiddleware(port: number): MiddlewareHandler {
  return async (c, next) => {
    const why = requestGuard(c.req.raw.headers, port);
    if (!why) return next();
    log(`request-guard: refused ${c.req.method} ${c.req.path.slice(0, 80)} — ${why}`);
    if (c.req.path === "/mcp") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: `Forbidden: ${why}` }, id: null }, 403);
    return c.json({ error: `forbidden: ${why}` }, 403);
  };
}
