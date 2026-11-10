---
description: Ned 를 이 Mac 에 설치·업데이트 — 런타임 동기화, 데몬·Ned.app 빌드, 옛 settings.json 훅 정리
allowed-tools: Bash, Read
disable-model-invocation: true
---

Ned 를 이 Mac 에 설치(또는 업데이트)한다. 업데이트도 같은 명령이다: `/plugin update ned` 뒤에 `/ned:install` 을 다시 실행.

## 1. 사전 조건 안내

설치 스크립트가 먼저 점검하고, 없으면 설치 방법을 출력한 뒤 멈춘다. 사용자에게 한 줄로 알려 줘라:
node 22 이상 · pnpm(`corepack enable`) · Xcode 명령줄 도구(`xcode-select --install`, Ned.app 을 이 Mac 에서 빌드) · claude CLI.
Ned.app 은 공증이 없으므로 내려받지 않고 각 Mac 에서 빌드한다(몇 분 걸림).

## 2. 실행

Bash 도구로 아래 명령을 **그대로** 실행한다. 빌드가 몇 분 걸리므로 timeout 은 600000(10분)으로 준다.

```
NED_PLUGIN_MODE=1 bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" < /dev/null
```

하는 일: 플러그인 소스를 고정 경로 `~/.ned/runtime/` 로 동기화(플러그인 캐시 경로는 업데이트마다 바뀌므로) → 거기서
`pnpm install --frozen-lockfile` + 빌드 → `~/.claude/settings.json` 에 남은 옛 Ned 훅 제거(플러그인 훅과 이중 기록 방지) →
Ned.app 빌드·서명 → `/Applications/Ned.app` 복사 → 앱이 데몬을 찾을 경로(`nedRepoPath`)를 런타임으로 → 앱 실행.

실패하면 출력의 `✗` 줄과 그 아래 안내를 그대로 보여 주고, 고친 뒤 `/ned:install` 을 다시 실행하라고 한다. 임의로 다른 명령을 실행해 고치지 않는다.

## 3. 결과 요약

성공하면 짧게 정리한다:
- 설치된 버전(출력의 `synced (version …)`), 앱 경로, 대시보드 `http://127.0.0.1:7777`
- 옛 훅 제거 결과(`Removed N …` 또는 `No Ned hooks to remove`)
- 서명 경고(`ad-hoc 서명`)가 있었으면: `bash ~/.ned/runtime/scripts/make-signing-cert.sh` 를 한 번 실행하면 재설치마다 권한을 다시 묻지 않는다
- 세션 훅은 **새 Claude Code 세션(또는 `/reload-plugins`)부터** 기록된다

그리고 처음 설치라면 다음을 안내한다:
1. 메뉴 막대의 안경 아이콘(macOS 26+ 에서 안 보이면 시스템 설정 > 메뉴 막대에서 Ned 허용) → 대시보드.
2. 설정 → 외형 → 링크 열기에서 **Slack 팀 ID**(`T…`) 입력 — Slack 링크를 앱으로 열 때 필요.
3. 업무 신호는 claude.ai 커넥터로 읽는다 — Ned 는 토큰을 갖지 않는다. claude.ai → 설정 → 커넥터에서 Slack·Gmail·Google Calendar·Atlassian(Jira)·GitHub 를 **본인 계정으로** 연결해야 카드가 채워진다.
4. 자동 실행: 메뉴 > "Login Items 에 등록".
