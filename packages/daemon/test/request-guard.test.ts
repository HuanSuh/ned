/**
 * requestGuard (src/request-guard.ts) — the DNS-rebinding rule server.ts applies to every route (/api/*, /mcp, static).
 * The real-socket checks (forged Host on /api/state, /mcp) are in test/mcp-server.test.ts.
 */
import { describe, expect, it } from "vitest";
import { requestGuard } from "../src/request-guard.js";

const h = (o: Record<string, string>) => new Headers(o);

describe("requestGuard", () => {
  it("allows loopback Host (any port) and no headers at all", () => {
    for (const host of ["127.0.0.1:7777", "localhost:7777", "[::1]:7777", "127.0.0.1", "localhost"]) expect(requestGuard(h({ host })), host).toBeNull();
    expect(requestGuard(h({}))).toBeNull();
  });
  it("allows a loopback http(s) Origin (dashboard, Ned.app WKWebView)", () => {
    for (const origin of ["http://127.0.0.1:7777", "http://localhost:7777", "https://localhost", "http://[::1]:7777"]) expect(requestGuard(h({ host: "127.0.0.1:7777", origin })), origin).toBeNull();
  });
  it("refuses a non-loopback Host or Origin, a null Origin and a non-http scheme", () => {
    expect(requestGuard(h({ host: "attacker.example:7777" }))).toMatch(/Host not allowed/);
    expect(requestGuard(h({ host: "127.0.0.1.nip.io" }))).toMatch(/Host not allowed/);
    for (const origin of ["http://evil.example", "null", "file://", "chrome-extension://abc", "http://127.0.0.1.evil.example"]) expect(requestGuard(h({ host: "127.0.0.1:7777", origin })), origin).toMatch(/Origin not allowed/);
  });
});
