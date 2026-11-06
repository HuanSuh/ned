/* Pure helpers for the settings save (no DOM): what changed since the form was rendered, and how a patch lands on a config.
 * The server merges the same way (src/config.ts deepMerge), so a PUT carries only what the user touched. */

const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `now` minus `saved`: plain objects are compared key by key (recursively, so notifications.kinds.slack alone is sent),
 * arrays and scalars as a whole. Keys missing from `now` are not sent (the server keeps what it has).
 * Returns {} when nothing changed.
 */
export function diffConfig(saved, now) {
  const out = {};
  if (!isPlain(now)) return out;
  const base = isPlain(saved) ? saved : {};
  for (const [k, v] of Object.entries(now)) {
    if (v === undefined) continue;
    if (!(k in base)) { out[k] = v; continue; }
    const b = base[k];
    if (isPlain(b) && isPlain(v)) {
      const sub = diffConfig(b, v);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (!same(b, v)) out[k] = v;
  }
  return out;
}

/** `patch` over `base` the way PUT /api/config merges: objects key by key, everything else replaces. */
export function mergePatch(base, patch) {
  if (!isPlain(base) || !isPlain(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlain(out[k]) && isPlain(v) ? mergePatch(out[k], v) : v;
  }
  return out;
}

export const isEmptyPatch = (p) => !isPlain(p) || Object.keys(p).length === 0;
