# `claude -p` 시작 비용 (커넥터 호출)

데몬이 claude.ai 커넥터(Gmail/Slack/Calendar/Atlassian, + `~/.claude.json` 의 Sentry)를 쓰는 `claude -p` 를 부를 때마다
모델과 무관하게 ~18-20s 가 고정으로 붙던 원인과 해결. 구현: `packages/daemon/src/claude.ts` (`fastStartupArgs`, `runClaude`).

## 결론

| 구성 (기본 argv 에 추가) | init s | 총 s | overhead s (총 − API) | 비용 $ | claude.ai 커넥터 |
|---|---:|---:|---:|---:|---|
| baseline (기존) | 3.9 | 31.9 | 18.9 | 0.081 | y |
| `--setting-sources user` | 4.0 | 33.7 | 19.9 | 0.086 | y |
| `--setting-sources user --disable-slash-commands` | 3.7 | 28.5 | 15.5 | 0.081 | y |
| `--setting-sources ""` | 0.5 | 4.0 | 1.7 | 0.013 | **n** (MCP 서버 0개 — Sentry 도 없음) |
| `--setting-sources "" --disable-slash-commands` | 0.5 | 8.8 | 1.5 | 0.020 | **n** |
| `--settings '{"disableAllHooks":true}'` | 3.0 | 16.3 | 3.7 | 0.081 | y |
| `--settings '{disableAllHooks, 플러그인 전부 off}' --disable-slash-commands` (inline) | 2.5 | 15.2 | 3.4 | 0.073 | y |
| **같은 내용을 파일로 `--settings $NED_HOME/claude-settings.json --disable-slash-commands`** ← 채택 | 2.5 | 15.6 | 3.2 | 0.074 | y |
| 위 + `--no-session-persistence` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | 2.5 | 17.4 | 3.1 | 0.073 | y (이득 없음) |

각 3회 평균. 벤치 프롬프트: "ToolSearch 로 `select:mcp__claude_ai_Gmail__list_labels` 를 한 번 부르고 `mcp__claude_ai_*` 도구 개수를 답하라",
`--model sonnet --max-turns 3 --permission-mode plan --tools ToolSearch --allowedTools ToolSearch --output-format stream-json --verbose`,
빈 cwd(`/tmp/ned-startup/cwd`), `NED_CHILD=1`. "init s" = `system/init` 이벤트까지, "overhead" = 벽시계 − `duration_api_ms`.
API 시간(10-15s)은 이 프롬프트가 191개 도구를 세게 만들어서 길다 — 구성 간 비교에는 overhead 를 본다.

실제 호출로 확인 (`runClaude`, `Google_Calendar__list_calendars` 를 ToolSearch 로 불러 실행, sonnet, 3 turns):
fast **13.5s** / $0.068, `claude_fast_startup: false`(기존 argv) **26.1s** / $0.070 — 둘 다 결과 동일("7").

## 원인 (타임라인, `--include-hook-events`)

기존 argv 한 번의 이벤트 순서:

```
 0.6  SessionStart 훅 6개 시작 (사용자 settings 3: Orca, ned-hook, …  + oh-my-claudecode 플러그인 훅)
 1.5  SessionStart 끝 → UserPromptSubmit 훅 4개 (3.5 → 4.0)
 4.0  system/init
 7.6  tool_use ToolSearch → PreToolUse 훅 2개, PostToolUse 훅 3개 (+0.6s)
 9.4  답 "ok" → Stop 훅 6개
19.2  마지막 Stop 훅 종료 (`dmt collect` 추정, ~9.7s) → result
20.1  프로세스 종료 (SessionEnd 훅)
```

즉 고정 비용의 대부분은 **사용자 훅** (특히 Stop 훅 하나가 ~10s) 이고, 나머지는 플러그인(oh-my-claudecode, xavier, figma, telegram…)의
MCP 서버 기동·skills/agents 가 들어간 시스템 프롬프트다. 커넥터 연결 자체는 init 뒤 비동기라 지배적이지 않다.

## 왜 이 구성인가

- `--bare` — OAuth 를 끊고 `ANTHROPIC_API_KEY` 만 쓴다 → claude.ai 커넥터 불가. 제외.
- `--setting-sources ""` — 가장 빠르지만 **MCP 서버가 0개** (claude.ai 커넥터·Sentry 모두 사라짐). 기존 `isolated`(무도구 초안) 전용으로 유지.
- `--strict-mcp-config` — 커넥터를 버린다 (기존에 알려진 사실).
- `--setting-sources user` — user 만 남기면 훅·플러그인이 그대로라 효과 없음.
- `--settings <file>` 은 사용자 settings **위에 덧씌운다**: `disableAllHooks: true` 가 settings 훅과 플러그인 훅을 모두 끄고,
  `enabledPlugins: {<사용자가 켠 플러그인>: false}` 가 플러그인 MCP 서버·skills·agents 를 뺀다. model/effortLevel/env 등 나머지
  사용자 설정은 그대로라 모델이 바뀌지 않는다. `--disable-slash-commands` 는 skills/commands 목록을 프롬프트에서 뺀다.
- `--no-session-persistence`, auto-memory/CLAUDE.md 끄기 env 는 측정상 차이가 없어 넣지 않았다.

## 구현 (`packages/daemon/src/claude.ts`)

- `fastStartupArgs()` 가 매 호출마다 `~/.claude/settings.json` + `settings.local.json` 의 `enabledPlugins` 를 읽어(읽기 전용)
  `$NED_HOME/claude-settings.json` 을 내용이 바뀐 때만 다시 쓰고 `["--settings", <그 파일>, "--disable-slash-commands"]` 를 돌려준다.
  사용자가 나중에 켠 플러그인도 다음 호출부터 꺼진다. 파일을 못 쓰면 같은 JSON 을 inline 으로 넘긴다. `~/.claude` 는 절대 쓰지 않는다.
- `buildClaudeArgs` 는 `isolated` 가 아니고 `opts.fastStartup ?? config.claude_fast_startup !== false` 이면 이 인자를 붙인다.
- 출력은 `--output-format stream-json --verbose` 로 바꿨다 (`result` 줄은 `json` 출력과 같은 필드). `system/init` 의 `mcp_servers` 에
  `claude.ai …` 서버가 **하나도 없으면** (`pending` 은 있는 것으로 침) — `allowedTools` 에 `mcp__claude_ai_*` 가 있는 호출에 한해 —
  API 호출 전에 즉시 kill 하고 기존 argv 로 다시 돌리며, 그 데몬 프로세스는 이후 계속 기존 argv 를 쓴다 (로그: `fast start-up came up without claude.ai connectors`).
  폴백은 PATH shim(가짜 `claude` 가 커넥터 없는 init 을 냄)으로 확인: 감지 → 기존 argv 재실행 → 정상 결과, 추가 지연 없음.

## 다시 재기

```sh
mkdir -p /tmp/ned-startup/cwd && cd /tmp/ned-startup/cwd
echo 'Call ToolSearch with query "select:mcp__claude_ai_Gmail__list_labels" once, then reply "ok".' |
  NED_CHILD=1 claude -p --output-format stream-json --verbose --include-hook-events \
    --permission-mode plan --max-turns 3 --model sonnet --tools ToolSearch --allowedTools ToolSearch \
    --settings /tmp/ned-startup/claude-settings.json --disable-slash-commands   # 이 줄을 빼면 baseline
```

각 줄의 도착 시각을 찍으면 위 타임라인이 나오고, `system/init.mcp_servers` 로 커넥터 유무를, `result.duration_api_ms` 로 overhead 를 본다.

## 남은 것 / 미확인

- 측정 환경: Claude Code 2.1.319, 2026-11-06, 이 Mac 의 settings(훅: dmt/Orca/ned-hook, 플러그인 8개). 다른 머신에선 절대값이 다르다.
- `disableAllHooks` 는 managed(정책) 훅도 끄는지 확인하지 않았다 (이 Mac 엔 없음).
- daemon 의 cwd 가 프로젝트 settings 를 가진 레포라면 그 프로젝트의 플러그인은 `enabledPlugins` 목록에 없으므로 켜진 채로 남는다 (훅은 꺼짐).
- 시스템 프롬프트 캐시 생성(~13k 토큰)이 남은 비용의 대부분 — 더 줄이려면 `--tools` 를 더 좁히거나 `--system-prompt` 를 써야 하는데 이번 범위 밖.
