---
description: Ned 상태 — 데몬·앱·런타임 버전(업데이트 필요 여부)·최근 로그·옛 훅 잔존 (읽기만)
allowed-tools: Bash
---

Ned 의 설치·실행 상태를 확인한다. **읽기만** 한다 — 아무것도 고치거나 재시작하지 않는다.

Bash 도구로 아래 명령을 그대로 실행한다:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh" "${CLAUDE_PLUGIN_ROOT}"
```

출력(데몬 `/api/state` 요약, Ned 프로세스, `nedRepoPath`, 런타임 vs 플러그인 버전, `app-daemon.log` 최근 10줄, `~/.claude/settings.json` 의 옛 Ned 훅)을
몇 줄로 요약한다. 문제가 보이면 해당하는 다음 행동만 제안한다:
- `⚠ 업데이트 필요` 또는 `nedRepoPath` 없음 → `/ned:install`
- 옛 훅이 남음 → `/ned:install` (설치 중에 제거된다; 남아 있으면 이벤트가 두 번 기록됨)
- 데몬 down, 앱은 실행 중 → 로그의 마지막 오류 줄을 짚어 준다
- 데몬·앱 모두 꺼짐 → `open /Applications/Ned.app` 을 사용자가 직접 실행하도록 안내(직접 실행하지 않는다)
