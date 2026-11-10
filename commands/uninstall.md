---
description: Ned 제거 — 앱 종료·삭제, 런타임 삭제 (데이터 ~/.ned 는 유지). 확인 후 실행
allowed-tools: Bash, AskUserQuestion
disable-model-invocation: true
---

Ned 를 이 Mac 에서 제거한다.

## 1. 확인

먼저 사용자에게 묻는다(AskUserQuestion 이 있으면 그것으로, 없으면 한 줄 질문 후 답을 기다림):
"Ned.app 을 종료하고 /Applications/Ned.app 과 빌드 런타임(~/.ned/runtime)을 지웁니다. 데이터·설정(~/.ned 의 나머지)은 남깁니다. 진행할까요?"
아니라고 하면 아무것도 하지 않고 끝낸다.

## 2. 실행

진행하면 Bash 도구로 그대로 실행한다:

```
NED_PLUGIN_MODE=1 bash "${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.sh" < /dev/null
```

플러그인 모드라 `~/.claude/settings.json` 은 건드리지 않는다 — 세션 훅은 플러그인과 함께 지워진다.

## 3. 마무리 안내

결과를 짧게 요약하고 다음을 알려 준다:
- 플러그인 자체(세션 훅·`/ned:*` 명령)를 지우려면: `/plugin uninstall ned` (마켓플레이스까지: `/plugin marketplace remove ned`)
- 데이터까지 지우려면 사용자가 직접: `rm -rf ~/.ned`
- Login Items 에 등록했었다면 앱이 사라지면서 목록에서도 빠진다
