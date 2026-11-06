# Ned.app

Ned.app is the one thing you run. It:

- **supervises the daemon**: on launch it checks `GET /api/state`; if nothing healthy answers within
  ~2 s it spawns `node <repo>/packages/daemon/dist/cli.js run` as a child, restarts it with backoff
  when it exits (more than 5 exits in 10 min → failed state), and stops it on quit (SIGTERM, 3 s, SIGKILL).
  If a daemon is already healthy on the port (e.g. a leftover LaunchAgent), it **adopts** it and spawns nothing.
- **hosts the dashboard** in a native window (`WKWebView` at `http://127.0.0.1:<port>/`),
- shows attention items and agent sessions in a `MenuBarExtra`, read from `state.json`,
- can register itself as a Login Item (`SMAppService.mainApp`).

The daemon and the dashboard HTML are unchanged; the app only wraps them.

| File | Role |
| --- | --- |
| `Sources/Ned/NedApp.swift` | `@main` app, status item label, app delegate (starts/stops the daemon, SIGTERM → quit) |
| `Sources/Ned/MenuContent.swift` | Dropdown: daemon status, attention, sessions, Login Item toggle, repo picker, footer |
| `Sources/Ned/StateStore.swift` | `state.json` model, directory watcher, daemon HTTP calls |
| `Sources/Ned/DaemonManager.swift` | Daemon supervisor + `node`/`claude` resolution |
| `Sources/Ned/DashboardWindow.swift` | Single dashboard window (`WKWebView`), placeholder, external links |
| `Sources/Ned/AppConfig.swift` | `NED_HOME` / `NED_PORT` / user defaults |
| `Resources/Ned.icns` | App icon, generated from `packages/daemon/public/proposals/ned-glasses.svg` by `scripts/make-icon.sh` |

Requires macOS 14+ and Swift 6.2 (Xcode 26).

## Build and install

```sh
cd apps/menubar
swift build -c release          # binary: .build/release/Ned
scripts/package.sh              # bundle: .build/Ned.app (icon, version 0.2.0, LSUIElement, ad-hoc signed)
scripts/make-icon.sh            # only when the SVG changes: regenerates Resources/Ned.icns
```

From the repo root, `scripts/install.sh` builds everything, installs the hooks, removes the old
`com.ned.daemon` LaunchAgent, copies the bundle to `/Applications/Ned.app` and opens it.
`scripts/uninstall.sh` quits the app, removes it and the hooks, and leaves `~/.ned` alone.

The `-parse-as-library` flag in `Package.swift` is required. Without it the app exits right
after launch.

## Daemon supervision

| Menu line | Meaning |
| --- | --- |
| 데몬 실행 중 (pid N) | The app spawned the daemon and it answers `/api/state` |
| 데몬 시작 중… | Spawned, not answering yet |
| 외부 데몬 사용 중 — external | Something else already serves the port; the app adopted it. If it stops answering for ~15 s the app takes over |
| 데몬 실패: … | No repo, no `dist/cli.js`, no `node`, or too many exits. **다시 시작** retries |

**로그 열기** opens `$NED_HOME/logs/app-daemon.log`: supervisor lines prefixed `[ned.app …]` plus the
child's stdout/stderr.

- **Repo**: the nearest ancestor of the app bundle containing `packages/daemon` (dev builds live in
  `apps/menubar/.build`), else the `nedRepoPath` user default. Set it from **저장소 위치…**
  (`install.sh` writes it for `/Applications/Ned.app`).
- **`node` / `claude`**: taken from `zsh -lic`, then `zsh -lc`, then `/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.nvm/versions/node/*/bin`, `~/.local/bin`, `~/.claude/local`. The first `node` with major ≥ 18 wins.
  A non-interactive login shell often misses nvm and returns an old system node. Their directories are
  put first in the child's `PATH`.
- **Port**: `NED_PORT` env, else the `nedPort` user default, else 7777. The child gets the same value
  as `NED_PORT`, which the daemon prefers over `config.yaml` without saving it.

## Dashboard window

**대시보드** opens one window and reuses it after that. Its size and position are remembered.
Until `/api/state` answers it shows a "daemon starting…" placeholder.
Links with `target=_blank`, `window.open`, or any host other than the dashboard open in the default browser.
Keys: ⌘W close, ⌘R reload, ⌘C/⌘V/⌘X/⌘A/⌘Z edit. The app shows a Dock icon while the window is open.

## Run

The app reads `$NED_HOME/state.json`, or `~/.ned/state.json` when `NED_HOME` is unset.

```sh
open .build/Ned.app                                   # real setup (port 7777, ~/.ned)
# isolated: own data dir and port, no LLM calls; -n allows a second instance next to an installed one
open -n --env NED_HOME=/tmp/ned-app --env NED_PORT=7790 --env NED_NO_LLM=1 .build/Ned.app --args --dashboard
kill <pid>                                            # quits cleanly (stops the daemon child too)
```

Launch args: `--dashboard` opens the window at launch (`NED_OPEN_DASHBOARD=1` does the same).
`--login-item-selftest` registers then unregisters the Login Item and logs both results.

Logs go to the unified log:

```sh
log stream --info --predicate 'subsystem == "com.ned.menubar"' --style compact
```

### The status item does not appear (macOS 26)

On macOS 26 the system can hide a bundled app's status item. You can see this in the
preference the system writes for the app:

```sh
defaults read com.ned.menubar      # "NSStatusItem VisibleCC Item-0" = 0 means hidden
```

To show it, turn Ned on under System Settings > Menu Bar > Allow in the Menu Bar.
The app stays running while hidden because `MenuBarExtra(isInserted:)` is bound to a
state flag. Without that binding SwiftUI would quit the app. The bare binary is not
affected, which makes it the quickest way to check UI changes.

## Fixture testing

`fixtures/state.json` has two sessions (running and waiting), two attention items
(`session` and `email`, the email one has a URL) and an `UPDATE` briefing.

```sh
mkdir -p /tmp/ned-mb
python3 - <<'PY'
import json, time
s = json.load(open("fixtures/state.json"))
s["updated_at"] = int(time.time() * 1000)   # keep it fresh, or the UI shows "daemon down"
json.dump(s, open("/tmp/ned-mb/state.json", "w"), ensure_ascii=False, indent=2)
PY
NED_NO_DAEMON=1 NED_HOME=/tmp/ned-mb .build/release/Ned   # NED_NO_DAEMON: don't spawn a daemon that would overwrite the fixture
```

What to expect:

- The status item shows the eyeglasses icon and `2`.
- The dropdown lists both attention items and both sessions.
- The header shows the briefing headline.

The daemon treats `state.json` as data it owns and replaces it atomically. To test the
watcher the same way, write a temp file and rename it over the original:

```sh
cp /tmp/ned-mb/state.json /tmp/ned-mb/state.json.tmp   # edit the .tmp file
mv /tmp/ned-mb/state.json.tmp /tmp/ned-mb/state.json   # UI reloads within about 50 ms
```

How decoding copes with bad input:

| Input | Result |
| --- | --- |
| Unknown fields, or missing optional fields | Ignored, or filled with defaults |
| One array element missing `id` | That element is dropped and the rest are shown |
| Wrong type in `last_briefing` or another non-critical field | That field is treated as absent |
| Invalid JSON, such as a partial write | The previous state stays on screen with a small warning line |

The menu's Dismiss button removes the item at once and sends
`POST /api/attention/<id>/dismiss`. If the daemon is not running, the request fails, the
failure is logged, and the next reload of `state.json` restores the item.
