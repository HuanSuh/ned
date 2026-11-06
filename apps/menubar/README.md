# Ned menu bar app

SwiftUI `MenuBarExtra` that shows Ned's attention items and agent sessions.
It reads `state.json` written by the daemon (`packages/daemon/src/state.ts`) and talks
back to the daemon over HTTP on `127.0.0.1:7777`.

| File | Role |
| --- | --- |
| `Sources/Ned/NedApp.swift` | `@main` app, status item label (icon + attention count) |
| `Sources/Ned/MenuContent.swift` | Dropdown: attention items, sessions, footer actions |
| `Sources/Ned/StateStore.swift` | `state.json` model, directory watcher, daemon HTTP calls |

Requires macOS 14+ and Swift 6.2 (Xcode 26).

## Build

```sh
cd apps/menubar
swift build -c release          # binary: .build/release/Ned
scripts/package.sh              # bundle: .build/Ned.app (Info.plist with LSUIElement=true)
```

`scripts/install.sh` at the repo root does the same packaging and launches the app.

The `-parse-as-library` flag in `Package.swift` is required. Without it the app exits right
after launch.

## Run

The app reads `$NED_HOME/state.json`, or `~/.ned/state.json` when `NED_HOME` is unset.

```sh
open .build/Ned.app                                  # real daemon state
open --env NED_HOME=/tmp/ned-mb .build/Ned.app       # fixture
NED_HOME=/tmp/ned-mb .build/release/Ned              # bare binary, handy while developing
pkill -x Ned                                         # quit
```

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
NED_HOME=/tmp/ned-mb .build/release/Ned
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
