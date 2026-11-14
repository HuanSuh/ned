/**
 * requestGuard (src/request-guard.ts) — the DNS-rebinding / other-local-port rule server.ts applies to every route (/api/*, /mcp, static).
 * The real-socket checks (forged Host, other-port Origin/Host on /api/state and /mcp) are in test/mcp-server.test.ts.
 */
import { describe, expect, it } from "vitest";
import { requestGuard } from "../src/request-guard.js";

const h = (o: Record<string, string>) => new Headers(o);
const PORT = 7804;

describe("requestGuard", () => {
  it("allows a loopback Host on the daemon port, and no headers at all", () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) expect(requestGuard(h({ host }), PORT), host).toBeNull();
    expect(requestGuard(h({}), PORT)).toBeNull();
  });
  it("allows a loopback http(s) Origin on the daemon port (dashboard, Ned.app WKWebView)", () => {
    for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `https://localhost:${PORT}`, `http://[::1]:${PORT}`]) expect(requestGuard(h({ host: `127.0.0.1:${PORT}`, origin }), PORT), origin).toBeNull();
  });
  it("refuses a loopback Host / Origin on another port, and a Host without a port", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "127.0.0.1", "localhost", "[::1]", "127.0.0.1:80"]) expect(requestGuard(h({ host }), PORT), host).toMatch(/Host port not allowed/);
    for (const origin of ["http://127.0.0.1:3000", "http://localhost:5173", "http://127.0.0.1", "https://localhost", `http://127.0.0.1:${PORT + 1}`]) expect(requestGuard(h({ host: `127.0.0.1:${PORT}`, origin }), PORT), origin).toMatch(/Origin port not allowed/);
    // other-port Origin is refused even without a Host header
    expect(requestGuard(h({ origin: "http://127.0.0.1:3000" }), PORT)).toMatch(/Origin port not allowed/);
  });
  it("a daemon on 80 / 443 accepts the scheme-default port", () => {
    expect(requestGuard(h({ host: "127.0.0.1:80", origin: "http://127.0.0.1" }), 80)).toBeNull();
    expect(requestGuard(h({ origin: "https://localhost" }), 443)).toBeNull();
  });
  it("Sec-Fetch-Site: same-origin / none / absent pass; cross-site / same-site / anything else → 403 (no-cors <img> GETs carry no Origin)", () => {
    const host = `127.0.0.1:${PORT}`;
    for (const site of ["same-origin", "none"]) expect(requestGuard(h({ host, "sec-fetch-site": site }), PORT), site).toBeNull();
    expect(requestGuard(h({ host, origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" }), PORT)).toBeNull();
    expect(requestGuard(h({ host }), PORT)).toBeNull();
    // another 127.0.0.1 port is "same-site" to the browser — must be refused too
    for (const site of ["cross-site", "same-site", "bogus", ""]) expect(requestGuard(h({ host, "sec-fetch-site": site }), PORT), site).toMatch(/Sec-Fetch-Site not allowed/);
  });
  it("refuses a non-loopback Host or Origin, a null Origin and a non-http scheme", () => {
    expect(requestGuard(h({ host: `attacker.example:${PORT}` }), PORT)).toMatch(/Host not allowed/);
    expect(requestGuard(h({ host: "127.0.0.1.nip.io" }), PORT)).toMatch(/Host not allowed/);
    for (const origin of ["http://evil.example", "null", "file://", "chrome-extension://abc", "http://127.0.0.1.evil.example"]) expect(requestGuard(h({ host: `127.0.0.1:${PORT}`, origin }), PORT), origin).toMatch(/Origin not allowed/);
  });
});
