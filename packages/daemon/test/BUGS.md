# Bugs found while writing the test suite

Not fixed here (src is owned by other sessions). Each one is pinned by an `it.fails(...)` test: it passes while the bug
exists and turns red once fixed — then flip it to `it(...)`.

## BUG-1 (FIXED 2026-11-06) — partial `quiet_hours` crashed `inQuietHours` (`src/config.ts`)
`loadConfig` spreads `parsed.quiet_hours` as-is (no deep merge / validation). A hand-edited `config.yaml` with
`quiet_hours: {start: "23:00"}` (no `end`) makes `inQuietHours` call `undefined.split(":")` → TypeError, which is
called from `refreshSessions` every tick and from `notifyBriefing`. Same for a non-"HH:MM" string (NaN → never quiet, silent).
Fix idea: normalize `quiet_hours` in `loadConfig` (both strings matching `/^\d{1,2}:\d{2}$/`, else default or null).
Test: `test/config.test.ts` › BUG-1.

## BUG-2 (FIXED 2026-11-06) — briefing items with `url: ""` were never deduped (`src/heartbeat.ts`)
`keyOf = (s) => (s.url ?? s.title)…` — `??` doesn't fall back on an empty string, so the key is `""`; `sentKeys()`
filters empty lines out of `sent.log`, so the item is never "already sent" and is re-surfaced (and re-notified) on every
heartbeat. Fix: `(s.url || s.title)`. Test: `test/heartbeat-todos.test.ts` › BUG-2.

## Notes (not pinned by tests)
- Duplicates *within one* briefing are not deduped (both copies pass `fresh()` because `sent` is read before the run).
- `PUT /api/config` spreads the body over the config (`{...cur, ...body}`): scalar fields such as `heartbeat_minutes`,
  `port`, `session_stale_minutes` are saved without type/range checks (e.g. `"heartbeat_minutes": "abc"`), and
  `loadConfig` doesn't re-validate them either.
- `normalizeWatch` (`src/agenda.ts`) can emit `context: undefined` for a highlight whose context has no messages
  (cosmetic: the key is present with an undefined value).
