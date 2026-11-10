# Ned

Ned — the guy in the monitor. Claude Code 세션 이벤트와 업무 신호(Slack·Gmail·Google Calendar·Jira·GitHub·Sentry)를 모아
로컬 대시보드(`http://127.0.0.1:7777`)와 macOS 메뉴 막대 앱으로 보여 주고, 순찰·아침 브리핑을 만드는 조용한 조수.
업무 신호는 사용자의 claude.ai 커넥터를 통해 `claude -p` 로 읽는다 — Ned 는 토큰을 갖지 않는다.

기능 가이드: [`docs/FEATURES.md`](docs/FEATURES.md) · 변경 기록: [`CHANGELOG.md`](CHANGELOG.md) · 릴리스 규칙: [`docs/RELEASE.md`](docs/RELEASE.md)

## 설치 (Claude Code 플러그인)

필요한 것: macOS 14+, node 22+, pnpm(`corepack enable`), Xcode 명령줄 도구(`xcode-select --install`), claude CLI,
이 private 레포에 접근할 수 있는 GitHub 자격 증명.

Claude Code 에서:

```
/plugin marketplace add HuanSuh/ned
/plugin install ned@ned
/reload-plugins
/ned:install
```

`/reload-plugins`(또는 새 세션)를 해야 방금 설치한 플러그인의 `/ned:*` 명령과 훅이 이 세션에 로드된다.

`/ned:install` 은 플러그인 소스를 `~/.ned/runtime/` 으로 옮겨 데몬과 Ned.app 을 **이 Mac 에서** 빌드하고(공증 없는 앱을 내려받지 않기 위해),
`/Applications/Ned.app` 에 설치해 실행한다. 몇 분 걸린다. 새 빌드가 다 끝난 뒤에만 기존 설치를 바꾸므로, 중간에 실패해도 쓰던 Ned 는 그대로다
(로그 `~/.ned/logs/install.log`). 세션 훅은 새 Claude Code 세션부터 기록된다.

처음 한 번:
- claude.ai → 설정 → 커넥터에서 Slack·Gmail·Google Calendar·Atlassian(Jira)·GitHub 를 **본인 계정으로** 연결.
- 대시보드 설정 → 외형 → 링크 열기에서 Slack 팀 ID 입력(Slack 링크를 앱으로 열 때).
- 메뉴 > "Login Items 에 등록"(자동 실행). 서명 경고가 나오면 `bash ~/.ned/runtime/scripts/make-signing-cert.sh` 한 번 —
  재설치마다 macOS 가 권한을 다시 묻지 않게 된다([apps/menubar/README.md](apps/menubar/README.md)).

| 하고 싶은 것 | 명령 |
| --- | --- |
| 업데이트 | `/plugin update ned` → `/reload-plugins`(또는 새 세션) → `/ned:install` — reload 없이는 이 세션이 옛 버전을 쓰고 있어 설치가 멈춘다 |
| 상태 확인(읽기만) | `/ned:status` — 데몬·앱·런타임 vs 플러그인 버전·최근 로그·옛 훅 잔존 |
| 제거 | `/ned:uninstall` → `/plugin uninstall ned` (데이터 `~/.ned` 는 남음) |

예전에 `scripts/install.sh` 로 설치했던 Mac 도 위 순서 그대로 — `/ned:install` 이 `~/.claude/settings.json` 의 옛 Ned 훅을 지운다.

## 레포에서 직접 설치 (개발용)

```sh
pnpm install && pnpm -s build
bash scripts/install.sh      # 체크아웃에서 빌드, ~/.claude/settings.json 에 훅 등록, /Applications/Ned.app 설치
bash scripts/uninstall.sh
```

**플러그인으로 설치했으면 쓰지 말 것** — 훅이 두 벌이 되어 이벤트가 두 번 기록된다(`packages/hook/install-hooks.mjs` 도 같음).
스크립트 환경변수(`NED_HOME`·`NED_RUNTIME_DIR`·`NED_APP_DEST`·`NED_DEFAULTS_DOMAIN`·`NED_SKIP_OPEN`·`NED_PLUGIN_MODE`…)는 `scripts/install.sh` 머리말.

## 구조

| 경로 | 내용 |
| --- | --- |
| `packages/daemon` | 데몬·대시보드·API ([README](packages/daemon/README.md)) |
| `packages/hook` | Claude Code 훅 `ned-hook.sh` (플러그인 `hooks/hooks.json` 이 등록) |
| `apps/menubar` | 메뉴 막대 앱 Ned.app — 데몬을 띄우고 감독 ([README](apps/menubar/README.md)) |
| `prompts` | 순찰·브리핑·대화 프롬프트 |
| `.claude-plugin`, `hooks`, `commands` | 플러그인 매니페스트·마켓플레이스, 훅, `/ned:*` 명령 |

개발: `pnpm test`, `pnpm -s build`. 작업 규칙은 [`CLAUDE.md`](CLAUDE.md).
