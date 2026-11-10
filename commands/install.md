---
description: Ned 를 이 Mac 에 설치·업데이트 — 새 런타임 빌드 후 교체, Ned.app 빌드, 옛 settings.json 훅 정리
allowed-tools: Read
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

## 2. 실행

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
- 임의로 다른 명령을 실행해 고치지 않는다.

## 3. 결과 요약

성공하면 짧게 정리한다:
- 설치된 버전(출력의 `synced (version …)`), 앱 경로, 대시보드 `http://127.0.0.1:7777`
- 옛 훅 제거 결과(`Removed N …` 또는 `No Ned hooks to remove`)
- 서명 경고(`ad-hoc 서명`)가 있었으면: `bash ~/.ned/runtime/scripts/make-signing-cert.sh` 를 한 번 실행하면 재설치마다 권한을 다시 묻지 않는다
- 세션 훅은 **새 Claude Code 세션(또는 `/reload-plugins`)부터** 기록된다

처음 설치라면 다음도 안내한다:
1. 메뉴 막대의 안경 아이콘 → 대시보드. macOS 26 이상에서 아이콘이 안 보이면 시스템 설정 > 메뉴 막대에서 Ned 를 허용한다.
2. 설정 → 외형 → 링크 열기에서 **Slack 팀 ID**(`T…`) 입력 — Slack 링크를 앱으로 열 때 필요하다.
3. 업무 신호는 claude.ai 커넥터로 읽는다 — Ned 는 토큰을 갖지 않는다. claude.ai → 설정 → 커넥터에서 Slack·Gmail·Google Calendar·Atlassian(Jira)·GitHub 를 **본인 계정으로** 연결해야 카드가 채워진다.
4. 자동 실행: 메뉴 > "Login Items 에 등록".
