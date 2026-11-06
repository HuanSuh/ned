/* fetch wrappers for the daemon's /api/* routes. */

export async function api(path, opts) {
  const r = await fetch(path, { headers: { accept: "application/json", ...(opts && opts.body ? { "content-type": "application/json" } : {}) }, ...opts });
  if (!r.ok) {
    const e = new Error(`${(opts && opts.method) || "GET"} ${path} → ${r.status}`); e.status = r.status;
    try { e.data = JSON.parse(await r.text()); } catch { e.data = null; } // e.g. 409 { current } from PUT /api/config
    throw e;
  }
  const text = await r.text(); // DELETE may answer 204 with no body
  return text ? JSON.parse(text) : null;
}
export async function postJson(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* empty */ }
  return { status: r.status, ok: r.ok, data };
}
