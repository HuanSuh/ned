/**
 * Cheap "are we online?" probe for *automatic* runs (src/scheduler.ts): one DNS lookup of api.anthropic.com,
 * 3s timeout, result cached 30s. Offline → the scheduler skips that tick (no claude spawn, no cost, no source error).
 * Manual endpoints (POST /api/check, /api/heartbeat, /api/agenda/refresh) never call this.
 */
import dns from "node:dns";

export const ONLINE_HOST = "api.anthropic.com";
export const ONLINE_TIMEOUT_MS = 3_000;
export const ONLINE_CACHE_MS = 30_000;

export interface OnlineCheckOptions {
  host?: string;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
  /** Injected in tests; default dns.promises.lookup. */
  lookup?: (host: string) => Promise<unknown>;
}

/** Returns a probe: resolves true when the lookup succeeds within the timeout. Never throws. */
export function createOnlineCheck(o: OnlineCheckOptions = {}): () => Promise<boolean> {
  const host = o.host ?? ONLINE_HOST;
  const timeoutMs = o.timeoutMs ?? ONLINE_TIMEOUT_MS;
  const cacheMs = o.cacheMs ?? ONLINE_CACHE_MS;
  const now = o.now ?? Date.now;
  const lookup = o.lookup ?? ((h: string) => dns.promises.lookup(h));
  let cached: { at: number; ok: boolean } | null = null;
  let inflight: Promise<boolean> | null = null;
  return () => {
    const t = now();
    if (cached && t - cached.at < cacheMs) return Promise.resolve(cached.ok);
    if (inflight) return inflight;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    inflight = Promise.race([
      Promise.resolve()
        .then(() => lookup(host))
        .then(
          () => true,
          () => false,
        ),
      timeout,
    ]).then((ok) => {
      clearTimeout(timer);
      cached = { at: now(), ok };
      inflight = null;
      return ok;
    });
    return inflight;
  };
}
