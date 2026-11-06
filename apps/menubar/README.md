# Ned.app

Ned.app is the one thing you run. It:

- **supervises the daemon**: on launch it checks `GET /api/state`; if nothing healthy answers within
  ~2 s it spawns `node <repo>/packages/daemon/dist/cli.js run` as a child, restarts it with backoff
  when it exits (more than 5 exits in 10 min → failed state), and stops it on quit (SIGTERM, 3 s, SIGKILL).
  If a daemon is already healthy on the port (e.g. a leftover LaunchAgent), it **adopts** it and spawns nothing.
- **hosts the dashboard** in a native window (`WKWebView` at `http://127.0.0.1:<port>/`),
- shows attention items and agent sessions in a menu bar item (AppKit `NSStatusItem` + popover), read from `state.json`,
- can register itself as a Login Item (`SMAppService.mainApp`),
- posts native notifications (`UNUserNotificationCenter`) from `state.json` changes — see below.

The daemon and the dashboard HTML are unchanged; the app only wraps them.

| File | Role |
| --- | --- |
| `Sources/Ned/NedApp.swift` | `@main` app (empty Settings scene), app delegate (store, status item, starts/stops the daemon, SIGTERM → quit) |
| `Sources/Ned/StatusItemController.swift` | `NSStatusItem` (unique autosave name, icon/badge/count), MenuContent popover, StatusItemGuard |
| `Sources/Ned/MenuContent.swift` | Dropdown: daemon status, attention, sessions, Login Item toggle, repo picker, footer |
| `Sources/Ned/StateStore.swift` | `state.json` model, directory watcher, daemon HTTP calls |
| `Sources/Ned/DaemonManager.swift` | Daemon supervisor + `node`/`claude` resolution |
| `Sources/Ned/DashboardWindow.swift` | Single dashboard window (`WKWebView`), placeholder, external links |
| `Sources/Ned/Notifier.swift` | Native notifications: diffs `state.json`, seen-id store, actions |
| `Sources/Ned/AppConfig.swift` | `NED_HOME` / `NED_PORT` / user defaults |
| `Resources/Ned.icns` | App icon, generated from `packages/daemon/public/proposals/ned-glasses.svg` by `scripts/make-icon.sh` |

Requires macOS 14+ and Swift 6.2 (Xcode 26).

## Build and install

```sh
cd apps/menubar
swift build -c release          # binary: .build/release/Ned
scripts/package.sh              # bundle: .build/Ned.app (icon, version 0.2.0, LSUIElement, signed — see below)
scripts/make-icon.sh            # only when the SVG changes: regenerates Resources/Ned.icns
```

From the repo root, `scripts/install.sh` builds everything, installs the hooks, removes the old
`com.ned.daemon` LaunchAgent, copies the bundle to `/Applications/Ned.app` and opens it.
`scripts/uninstall.sh` quits the app, removes it and the hooks, and leaves `~/.ned` alone.

The `-parse-as-library` flag in `Package.swift` is required. Without it the app exits right
after launch.

### macOS 가 권한을 매번 다시 물으면 (권한 확인이 매번 뜨면)

macOS 의 TCC 는 앱을 코드 서명으로 알아본다. ad-hoc 서명(`codesign --sign -`)은 빌드할 때마다
코드 해시가 달라지므로, 다시 설치할 때마다 새 앱으로 보고 "문서 폴더 접근 허용" 같은 확인을 또 띄운다.
고정된 서명 정체성을 한 번 만들어 두면 이후 재설치에서는 묻지 않는다.

```sh
scripts/make-signing-cert.sh --dry-run   # 무엇을 할지 보기만
scripts/make-signing-cert.sh             # 로그인 키체인에 "Ned Local Signing" (자체 서명, 10년) 생성 + 코드 서명용 신뢰
# codesign 이 매번 키체인 암호를 묻지 않게 (로그인 암호 입력, 한 번만):
security set-key-partition-list -S apple-tool:,apple: -s -k "<로그인 암호>" ~/Library/Keychains/login.keychain-db
security find-identity -v -p codesigning # "Ned Local Signing" 이 valid 로 1개 보여야 한다
scripts/install.sh                       # 이제 "Ned Local Signing" 으로 서명된다
```

- `make-signing-cert.sh` 는 두 단계다: ① 키·인증서 생성 후 import(키체인 대화상자), ② `security add-trusted-cert
  -r trustRoot -p codeSign` 로 코드 서명 정책 신뢰 설정(인증 대화상자 1회 — 로그인 암호/Touch ID 로 직접 승인).
  자체 서명 인증서는 ②가 없으면 `find-identity` 에 `CSSMERR_TP_NOT_TRUSTED` 로 나오고 `-v` 에선 0 valid 라
  ad-hoc 으로 폴백한다. 멱등: 이미 valid 면 아무것도 안 하고, import 만 된 상태면 재생성 없이 ②만 한다.
  끝에 `find-identity -v -p codesigning` 결과로 성공(✓)/실패를 출력한다.
- `package.sh` 는 `$NED_SIGN_IDENTITY` → 키체인의 **valid** "Ned Local Signing"(`find-identity -v`) → ad-hoc 순으로
  고르고 (`--identifier com.ned.menubar`), ad-hoc 이면 경고 한 줄을 남긴다 — 인증서는 있는데 신뢰가 안 된 경우엔
  `make-signing-cert.sh` 를 다시 실행(신뢰 단계)하라고 안내한다. 서명 결과(`Authority=`)는 빌드 로그에 찍힌다.
  확인: `codesign -dv --verbose=2 /Applications/Ned.app 2>&1 | grep Authority`.
- 인증서로 바꾼 뒤 첫 설치에서는 한 번 더 묻는다(서명 정체성이 바뀌었으므로). 그다음부터는 묻지 않는다.
- 문서 폴더 접근이 생기는 이유: node/claude 를 찾을 때 쓰던 `zsh -lic` 가 `.zshrc` 전체(oh-my-zsh, p10k,
  `~/Documents/…` 아래 PATH 항목·스크립트)를 실행했기 때문. 이제 `zsh -lc` + nvm 기본 버전(`~/.nvm/alias/default`)
  + 잘 알려진 경로로 먼저 찾고, node ≥ 18 이나 claude 를 못 찾을 때만 `zsh -lic` 를 쓴다.

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
`--login-item-status` prints `SMAppService.mainApp.status` to stdout and exits (read-only, no UI; see Login Item below).
`--persona-selftest` logs persona resolution and exercises the persona PUT (see Persona below).
`--wake-selftest` fakes a wedged-after-sleep daemon (SIGSTOP on the child) and runs the wake check (see Sleep / wake below).
`--notify-selftest` runs synthetic state.json through the notification planner and the badge / open-item /
`is_worker` decoding, prints the results and exits non-zero on failure (headless).
`--boot-selftest` (headless, stdout) checks the node/claude tool cache (cold miss → cached, warm hit, broken
cache → miss; own defaults suite, the app's cache is untouched) and writes the boot screen HTML per persona to
`$NED_BOOT_HTML_OUT` (default `$TMPDIR/ned-boot-selftest`) for a headless render check.
`--statusitem-selftest` (run the bare `.build/release/Ned`, not the bundle) creates the status item, logs autosaveName /
isVisible / behavior / button image, checks a re-render keeps the same NSStatusItem, sizes the popover content, removes it.
`--boot-transition-selftest [--cold]` (no scene / menu bar item; temp `NED_HOME` + `NED_PORT`, `NED_REPO` = a checkout
with a built daemon, `NED_TOOL_CACHE_SUITE` = throwaway defaults suite) runs the real daemon start + the boot screen
in a window-less web view and passes if the dashboard load starts ≤ outro + 1 s after healthy (or after the minimum on-screen time):
`NED_HOME=$TMPDIR/bt NED_PORT=7789 NED_NO_LLM=1 NED_REPO=~/orca/projects/ned NED_TOOL_CACHE_SUITE=com.ned.menubar.transition-selftest .build/Ned.app/Contents/MacOS/Ned --boot-transition-selftest --cold`

## Start-up (tool cache + boot screen)

- **Tool cache**: the last node/claude that worked are kept in user defaults (`toolCache.node` / `toolCache.claude` /
  `toolCache.version`). If the cached node still passes `node --version` (≥ 18, 3 s timeout) it is used at once
  (`resolved … (cache hit, node v22, 0.1s)` in the log) and the slow `zsh -lic` / `zsh -lc` search runs in the
  background; a different result only updates the cache (applies from the next restart). No/broken cache → the
  full search as before. A fresh child is probed every 0.4 s until healthy (not only on the 5 s tick).
- **Boot screen** (dashboard window, `Sources/Ned/BootScreen.swift`): the persona's mark draws in, light sweeps
  across it, Ned gets a faint web; steps 도구 찾는 중 → 데몬 시작 → 연결 확인 → 대시보드 로드 + status line + elapsed,
  pushed every 0.5 s via `nedBoot(step, text, elapsed, failed)` — fire-and-forget: the switch never waits on a JS
  round-trip (those took up to 18 s with a cold / occluded web view); it follows DaemonManager's `$status`. Shown at least 2.5 s
  (`DashboardWindowController.minBootScreenSeconds`); skipped when the daemon is already healthy as the window opens.
  `.failed` → red step + 다시 시작 button. Reduced motion → static mark, 0.3 s outro.
- **Greeting**: under the name, a random line from the persona's pool (`BootScreen.copy` — time-of-day lines +
  any-time lines, persona tone), never the same as the previous boot's (`bootScreen.lastGreeting` in user defaults).
- **Outro** (`nedBootDone()`, `BootScreen.outroSeconds` = 1.15 s): ready beat (all ✓, mark pulse + accent halo,
  the persona's ready line e.g. 다 됐어요, 가요!) → 0.6 s later the content lifts/blurs out while a veil fades to the
  dashboard's own `--bg` (persona × light/dark, mirrored from `tokens.css` in `BootScreen.dashboardBackground`).
  The dashboard then paints on that same colour and its top-level blocks fade + lift in (`revealScript`, a one-shot
  document-start user script removed after the load).
- **Menu**: while `.checking` / `.starting` the daemon line becomes a spinner + `시작 중 n/4 · <step>`; `.failed`
  shows a prominent 다시 시작. The menu bar label is unchanged (one Image + one Text).

## Menu bar badge and attention

- **Badge** = `state.attention_open_count` (attention not marked 확인 완료). An older daemon without that field:
  the count of `attention` items without `reviewed_at`.
- **지금 봐야 할 것** lists open items only (max 5). Reviewed items stay in `state.json` but are hidden here.
- **Worker sessions**: the daemon marks sessions whose cwd (or Orca worktree path) is under `~/orca/workspaces/`
  as `is_worker` (Orca child worktrees = the user's own agent workers). They never become attention items
  (`입력 대기` / `오류`) and are not counted, but stay in `state.sessions`. The menu lists them after your own
  sessions, dimmed, with a `워커` tag.

## Login Item

The toggle next to **Login Items 에 등록** shows **자동 시작: 켜짐 / 꺼짐**. 켜짐 only when
`SMAppService.mainApp.status == .enabled`; `requiresApproval` shows `꺼짐 (승인 필요)`.

```sh
.build/Ned.app/Contents/MacOS/Ned --login-item-status
# login-item-status: notFound (rawValue 3) — 자동 시작: 꺼짐
# bundle: …/apps/menubar/.build/Ned.app id=com.ned.menubar
```

| status | Meaning |
| --- | --- |
| `enabled` | Registered and allowed — Ned opens at login |
| `requiresApproval` | Registered, but macOS wants the user's OK (common for ad-hoc-signed bundles) |
| `notRegistered` | Not registered (toggle off) |
| `notFound` | macOS has no record for this bundle path — normal for a dev bundle that was never registered |

Status is per bundle path: check the installed app with `/Applications/Ned.app/Contents/MacOS/Ned --login-item-status`
(only with a build that has this flag — an older binary ignores it and launches normally).

**Approval** (when status is `requiresApproval`; the toggle also opens this pane):
System Settings > General > **Login Items & Extensions** (macOS 14: **Login Items**) → find Ned under
**Open at Login** (add it with + if missing), and if Ned is listed under **Allow in the Background**, turn it on.

## Sleep / wake

On `NSWorkspace.didWakeNotification` the app probes `GET /api/state` (first probe 3 s after wake, up to 3 probes
within ~10–15 s). If none answers it restarts the daemon: its own child gets SIGTERM, then SIGKILL after 3 s
(a stopped/wedged process may ignore SIGTERM), then the usual adopt-or-spawn. An adopted external daemon that
does not answer is replaced by a spawned child. Every step is logged to `app-daemon.log` as `wake: …`.

```sh
NED_HOME=/tmp/ned-wake NED_PORT=7793 NED_NO_LLM=1 .build/Ned.app/Contents/MacOS/Ned --wake-selftest
grep wake /tmp/ned-wake/logs/app-daemon.log    # … wake selftest: PASS — restarted, new pid N healthy (old M)
```

Logs go to the unified log:

```sh
log stream --info --predicate 'subsystem == "com.ned.menubar"' --style compact
```

### The status item does not appear (macOS 26)

On macOS 26 the system can hide a bundled app's status item. You can see this in the
preference the system writes for the app:

```sh
defaults read com.ned.menubar      # "NSStatusItem VisibleCC com.ned.menubar.status" = 0 means hidden
```

Root cause of the old "icon gone right after launch": SwiftUI `MenuBarExtra` gave the item the default autosave
name `Item-0`, and Control Center's own defaults (`com.apple.controlcenter`) held `NSStatusItem Visible Item-0`…`Item-9`
= false, so macOS hid it on every launch and wrote `NSStatusItem VisibleCC Item-0 = 0` into our domain. The item is
now an AppKit `NSStatusItem` with the unique autosave name `com.ned.menubar.status`, `isVisible = true` at creation
and `behavior = []` (no ⌘-drag removal); it is created once and only its image/title change. StatusItemGuard clears
hidden flags (legacy `Item-0` and the new name) at start-up and every 10 s and re-asserts `isVisible`.
If it is still hidden, turn Ned on under System Settings > Menu Bar > Allow in the Menu Bar.
The bare binary is not affected, which makes it the quickest way to check UI changes.

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

## Notifications

The app asks for notification permission (alert, sound, badge) on first launch. macOS shows a
"'Ned' 알림" banner; choose **옵션 → 허용**, or turn it on later under System Settings → 알림 → Ned.
The spawned daemon gets `NED_NOTIFY=app` and stops showing osascript ("Script Editor") banners.

On every `state.json` reload the app compares it with what it already notified:

- **New attention ids**: one notification each (title, detail; category `ned.<kind>`, `ned.<kind>.link`
  when the item has a url). More than 3 new at once: one summary, "Ned: 확인할 것 N건".
- **`last_briefing` with a new id and status UPDATE**: the headline, unless the attention notifications
  from the same reload came from that briefing.
- `session` items (waiting/error) use `.timeSensitive`, everything else `.active`. An ad-hoc-signed
  bundle has no time-sensitive entitlement, so macOS may treat them as `.active` (Focus still filters them).
- **`state.quiet`**: the `quietDelivery` user default — `skip` (default) or `silent` (Notification Center
  only, no sound, `.passive`). `defaults write com.ned.menubar quietDelivery silent`.
- Click → dashboard window. **열기** (items with a url) → default browser. **닫기** → `POST /api/attention/:id/dismiss`.

Seen ids are stored in UserDefaults per `NED_HOME` (`notifySeen:<home>`), so a restart does not
re-notify and a test run with `NED_HOME=/tmp/…` does not touch the real set. The very first run marks
existing items as seen instead of notifying. Session ids are forgotten once they leave `attention`
(the next alert notifies again); others after 7 days. Every request and its result is logged to
`$NED_HOME/logs/app-daemon.log` as `notify: …`. Notifications need the bundle (`scripts/package.sh`);
the bare `.build/release/Ned` binary cannot use `UNUserNotificationCenter`.

## Persona

`state.json` `persona` (the daemon's `config.persona`: `ned` | `alfred` | `oracle` | `jarvis`;
missing or unknown → `ned`) picks the name, colors and copy. It switches live on the next
state.json reload, no restart. Definitions are in `Sources/Ned/Persona.swift`.

| id | menu bar symbol idle / attention / offline | accent | quiet line |
|---|---|---|---|
| ned | `eye` / `eyeglasses` / `eye.slash` | #e23636 (LED #4a78f0) | 레이더 깨끗함 |
| alfred | `person.crop.circle` / `bell` / `person.crop.circle.badge.xmark` | #d4af37 | 현재 보고드릴 사항이 없습니다 |
| oracle | `headphones` / `waveform` / `antenna.radiowaves.left.and.right.slash` | #8b5cf6 (LED #3ddc84) | 이상 무. 대기 중. |
| jarvis | `circle.hexagongrid` / `circle.hexagongrid.fill` / `circle.slash` | #38bdf8 | 모든 시스템 정상입니다 |

All of these symbols exist on macOS 13 or earlier. If a name is ever missing at runtime,
Ned's eye symbols are used instead. While there is attention, the label shows a single
non-template image: the symbol plus a count capsule in the accent color.

- **Menu**: the header name and color, the quiet line, a time-of-day greeting when nothing
  needs attention, the LED and button tint, and a `페르소나: <name>` pop-up next to
  "저장소 위치…" — **hidden feature**: the pop-up only shows when you open the dropdown with
  ⌥ (option) held (otherwise edit `persona:` in config.yaml). Picking a persona there switches the UI right away and sends
  `PUT /api/config {"persona":"<id>"}`. If the PUT fails, the UI goes back to the previous
  persona.
- **Notifications**: the briefing title is the persona name, the persona name is the subtitle
  of per-item banners, and the >3 summary uses the persona's own wording.
- **App icon**: `Resources/marks/<id>.svg` holds plain original geometry (ned.svg is the
  existing glasses mark). `scripts/make-icon.sh --all` turns these into `Resources/Ned.icns`
  and `Ned-<id>.icns`. At runtime the app sets `NSApp.applicationIconImage` to the persona's
  icon, which shows in the Dock while the dashboard is open, in alerts, and in the About panel.
  **Limitation:** Finder, the Login Items list and notification banners take the bundle's
  `CFBundleIconFile`, which stays `Ned.icns`. Changing it per persona would mean rewriting
  `Info.plist` and re-signing, which we don't do.
- **Self-test** (log only, no UI input): `.build/Ned.app/Contents/MacOS/Ned --persona-selftest`
  writes every persona's resolution and the decode fallbacks to `$NED_HOME/logs/app-daemon.log`.
  It then calls `StateStore.setPersona` (the same function as the pop-up) for alfred and jarvis,
  and quits. Set `NED_SELFTEST_WAIT=<s>` to keep it running so you can edit state.json by hand.
