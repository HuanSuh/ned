---
description: Ned 를 이 Mac 에 설치·업데이트 — 새 런타임 빌드 후 교체, Ned.app 빌드, 옛 settings.json 훅 정리, 시작하기 점검(커넥터·서명·자동 실행)
allowed-tools: Read, AskUserQuestion
disable-model-invocation: true
---

Ned 를 이 Mac 에 설치(또는 업데이트)한다.

**업데이트 순서**: `/plugin update ned` → `/reload-plugins`(또는 새 세션) → `/ned:install`.
이미 실행 중인 세션은 업데이트 전에 로드한 플러그인 버전을 그대로 쓴다. 그래서 reload 없이 실행하면 옛 버전을 다시 설치하게 되고,
설치 스크립트가 이를 감지해 "/reload-plugins 후 다시" 로 멈춘다. 그런 출력이 나오면 사용자에게 `/reload-plugins` 뒤 `/ned:install` 을 다시 치라고만 안내한다.

## 1. 사전 조건 안내

스크립트가 먼저 점검하고, 없으면 설치 방법을 출력한 뒤 멈춘다. 사용자에게 한 줄로 알려 줘라:
node 22 이상 · pnpm(`npm i -g pnpm`) · Xcode 명령줄 도구(`xcode-select --install`, Ned.app 을 이 Mac 에서 빌드) · claude CLI.
Ned.app 은 공증이 없으므로 내려받지 않고 각 Mac 에서 빌드한다. 처음엔 몇 분에서 10분 넘게 걸릴 수 있다.

## 2. 코드 서명 (설치 전)

Ned.app 은 빌드할 때 "Ned Local Signing" 인증서가 있으면 그것으로 서명한다. 없으면 ad-hoc 서명이 되어
**설치할 때마다 macOS 가 권한(문서 폴더 접근 등)을 다시 묻는다**. 인증서는 빌드 **전에** 있어야 이번 설치에 적용된다.

먼저 Bash 로 아래 두 줄을 실행한다(읽기만 함). 첫 줄 출력에 `"Ned Local Signing"` 이 있으면 이 단계는 건너뛴다.
둘째 줄은 처음 설치인지(파일 없음) 업데이트인지(있음) 알려 준다 — 6단계에서 쓴다.

```
security find-identity -v -p codesigning
ls ~/.ned/runtime/packages/daemon/dist/cli.js
```

없으면 AskUserQuestion 으로 한 번 묻는다 — 질문: "코드 서명 인증서를 지금 만들까요?", 선택지 둘:
- **지금 만들기 (권장)** — 재설치마다 권한을 다시 묻지 않게 된다. macOS 대화상자 두 번(키체인 접근, 로그인 암호/Touch ID)을 직접 승인해야 한다.
- **건너뛰기** — ad-hoc 서명으로 설치. 나중에 만들고 `/ned:install` 을 다시 하면 그때부터 적용된다.

"지금 만들기" 면 먼저 "곧 macOS 대화상자가 뜨면 승인해 주세요" 라고 알린 뒤, Bash 로 아래 명령을 **그대로, 포그라운드로**(`run_in_background` 없이) 실행한다.
끝나면 출력의 마지막 줄(✓/✗)을 보여 준다. 실패해도 설치는 계속한다(ad-hoc 서명이 된다) — 원인 줄만 보여 주고 임의로 다른 명령을 실행해 고치지 않는다.

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/make-signing-cert.sh"
```

## 3. 실행

Bash 도구로 아래 명령을 **그대로**, `run_in_background: true` 로 실행한다(권한을 물으면 사용자가 승인한다).
스크립트가 출력 전체를 `~/.ned/logs/install.log` 에도 남긴다.

```
NED_PLUGIN_MODE=1 bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" < /dev/null
```

완료 알림이 올 때까지 기다린다. 기다리는 동안 출력 파일을 반복해서 읽지 않는다.

하는 일: 플러그인 소스를 `~/.ned/runtime.next` 로 옮겨 `pnpm install --frozen-lockfile`·빌드·Ned.app 빌드를 모두 끝낸 뒤에만
앱을 종료하고 `~/.ned/runtime` 과 `/Applications/Ned.app` 을 새것으로 바꾼다. 중간에 실패하면 기존 설치는 그대로다.
이어서 `~/.claude/settings.json` 에 남은 옛 Ned 훅을 지운다(플러그인 훅과 이중 기록 방지). 그다음 앱을 실행한다.

실패하면(`✗` 줄):
- 그 줄과 바로 아래 안내, 그리고 `~/.ned/logs/install.log` 끝 30줄 가운데 원인으로 보이는 줄을 보여 준다.
- "기존 설치는 유지됨. 원인을 고친 뒤 `/ned:install` 을 다시 실행" 이라고 안내한다.
- 임의로 다른 명령을 실행해 고치지 않는다. 실패했으면 4~6단계는 하지 않는다.

## 4. 결과 요약

성공하면 짧게 정리한다:
- 설치된 버전(출력의 `synced (version …)`), 앱 경로, 대시보드 `http://127.0.0.1:7777`
- 옛 훅 제거 결과(`Removed N …` 또는 `No Ned hooks to remove`)
- 서명 경고(`ad-hoc 서명`)가 있었으면: `bash ~/.ned/runtime/scripts/make-signing-cert.sh` 를 한 번 실행하고 `/ned:install` 을 다시 하면 재설치마다 권한을 다시 묻지 않는다
- 세션 훅은 **새 Claude Code 세션(또는 `/reload-plugins`)부터** 기록된다
- Claude Code 세션에서 `/mcp` 로 `ned` 서버(플러그인 제공, `http://127.0.0.1:7777/mcp`)를 확인 — 도구 `ned_attention`·`ned_sessions`·`ned_briefing`·`ned_history`·`ned_feed`·`ned_mark_reviewed`
- 메뉴 막대의 안경 아이콘 → 대시보드(처음이면). macOS 26 이상에서 아이콘이 안 보이면 시스템 설정 > 메뉴 막대에서 Ned 를 허용한다.

## 5. 연결 점검

업무 신호는 claude.ai 커넥터로 읽는다 — Ned 는 토큰을 갖지 않는다. 설정에서 켠 소스가 실제로 읽히는지 Bash 로 확인한다(claude 를 한 번 띄워
커넥터 상태만 읽고 끈다 — 모델 호출·비용 없음, 최대 1분쯤):

```
node ~/.ned/runtime/packages/daemon/dist/cli.js setup-check
```

출력을 짧은 표(소스 · 상태 · 할 일)로 정리한다. `✓` 는 그대로, 나머지는 할 일을 붙인다:
- 커넥터(Slack·Gmail·Google Calendar·Atlassian(Jira)): claude.ai → 설정 → 커넥터 https://claude.ai/settings/connectors 에서 **본인 계정으로** 연결(또는 다시 인증)
- GitHub: 터미널에서 `gh auth login`
- Sentry: Claude Code 에 Sentry MCP 서버 추가(쓰지 않으면 대시보드 설정 → 소스에서 끄기)
- Slack 팀 ID 없음: 대시보드 설정 → 외형 → 링크 열기(또는 대시보드의 **시작하기** 창)에서 `T…` 입력 — Slack 링크를 앱으로 열 때 필요
- 코드 서명 ✗: 2단계 안내와 같음(다음 설치부터 적용)

연결한 뒤에는 대시보드 **시작하기** 창(설정 → 시작하기)의 "다시 확인" 으로 다시 볼 수 있다고 알린다. 대시보드는 처음 열 때 준비 안 된 항목이 있으면 이 창을 스스로 띄운다.
명령이 실패하면 그 줄만 보여 주고 넘어간다(설치는 이미 끝났다).

## 6. 자동 실행 (Login Item)

Bash 로 상태를 읽는다(읽기만 함):

```
/Applications/Ned.app/Contents/MacOS/Ned --login-item-status
```

`자동 시작: 켜짐` 이면 한 줄로 알리고 끝. 아니면:
- **처음 설치**(2단계의 `ls` 가 파일 없음)일 때만 AskUserQuestion 으로 묻는다 — 질문: "로그인할 때 Ned 를 자동으로 실행할까요?", 선택지: **예** / **아니요**(대시보드 설정 → 앱(Ned.app) 에서 언제든 켤 수 있음).
  "예" 면 Bash 로 아래 명령을 그대로 실행하고 출력의 `login-item-status:` 줄을 보여 준다. Ned 가 이미 실행 중이어도 된다(같은 앱 번들의 등록).
  `승인 필요` 가 나오면 시스템 설정 > 일반 > 로그인 항목이 열리니 Ned 를 허용하라고 안내한다.
  ```
  /Applications/Ned.app/Contents/MacOS/Ned --login-item-register
  ```
- 업데이트일 때는 묻지 않고 "자동 실행은 꺼져 있음 — 대시보드 설정 → 앱(Ned.app) 또는 시작하기에서 켤 수 있음" 한 줄만.
