# @ned/daemon

Ned 의 코어 데몬. Claude Code 훅이 남긴 세션 이벤트를 집계하고, 주기적으로 `claude -p` 를 호출해
업무 신호(Gmail/Slack/Jira/Sentry/GitHub/Google Calendar, claude.ai 커넥터 경유)를 브리핑으로 정리하며,
menu bar 앱과 로컬 대시보드가 읽는 `state.json` 을 유지한다. 읽기 전용: 어떤 쓰기 액션도 하지 않는다.

## Build

```sh
pnpm install            # 모노레포 루트에서 한 번
pnpm --filter @ned/daemon build   # tsc → dist/
```

## Commands

```sh
node dist/cli.js run                 # 데몬: 대시보드(127.0.0.1:7777) + 이벤트 감시 + heartbeat 스케줄러
node dist/cli.js heartbeat [--daily] # heartbeat 1회 강제 실행 (claude -p 호출, 결과 JSON 을 stdout 에 출력)
node dist/cli.js state               # events → sessions 를 다시 계산해 state.json 을 갱신하고 출력
node dist/cli.js agenda              # agenda 잡 1회 실행 (calendar/jira/github → agenda.json, 결과를 stdout 에 출력)
```

`run` 은 시작 직후 heartbeat 를 한 번 돌린다. 이후 `heartbeat_minutes` 마다 tick 하며,
새 세션 이벤트도 없고 `signal_check_minutes` 가 지나지 않았으면 LLM 을 부르지 않고 침묵한다.
`briefing_time` 이 지난 첫 tick 은 `prompts/briefing.md` 로 아침 브리핑을 만든다 (하루 1회).

**Agenda 잡** (`src/agenda.ts`, `prompts/agenda.md`): 대시보드 HOME 탭용 구조화 데이터. 시작 직후 1회,
이후 `agenda_refresh_minutes`(기본 60) 마다, 그리고 `POST /api/agenda/refresh` 때 `claude -p` 를 돌린다.
허용 도구는 `ToolSearch`, Calendar `list_events`/`search_events`, Jira `searchJiraIssuesUsingJql`,
`Bash(gh search prs:*)`/`Bash(gh pr list:*)`/`Bash(gh api:*)` 뿐이고 `--max-turns 10`. `sources.*` 가 꺼진 블록은
조회하지 않고 `[]`. 동시에 여러 번 요청돼도 실행 중인 한 번을 공유한다 (busy guard). 모델 출력이 깨지면
이전 목록을 유지하고 `error` 를 채운다. `NED_NO_LLM=1` 이면 claude 없이 빈 agenda 를 쓴다.

### HTTP API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/state` | `state.json` (sessions, attention, last_briefing, …) |
| GET | `/api/events?days=2` | 최근 N일의 훅 이벤트 (오래된 것부터) |
| GET | `/api/briefings?limit=30` | 브리핑 히스토리 (최신 먼저) |
| GET / PUT | `/api/config` | `config.yaml` 조회 / 부분 갱신 |
| POST | `/api/heartbeat?daily=1` | heartbeat 강제 실행 |
| POST | `/api/attention/:id/dismiss` | attention 항목 제거. 세션 항목은 `dismissed.json` 에 기억돼 같은 알림으로는 다시 안 뜬다 |
| GET | `/api/agenda` | `agenda.json` (+ `busy`). 없으면 빈 배열과 `updated_at: 0` |
| POST | `/api/agenda/refresh` | agenda 잡 실행 후 새 payload 반환 (실행 중이면 그 결과를 기다려 반환) |
| GET | `/api/todos` | 개인 할 일 목록 |
| POST | `/api/todos` | `{title, due?, note?}` → 생성된 항목 (201). title 이 비면 400 |
| PATCH | `/api/todos/:id` | `{title?, done?, due?, note?}` 부분 갱신. 없으면 404 |
| DELETE | `/api/todos/:id` | 삭제. 없으면 404 |

Agenda 응답 형태:

```json
{
  "updated_at": 0, "cost_usd": 0, "error": "(실패 시에만)",
  "calendar": [{"id":"","title":"","start":"ISO","end":"ISO","all_day":false,"location":"","url":"","meet_url":"","rsvp":"accepted|needsAction|declined|tentative|organizer","attendees":0}],
  "jira":     [{"key":"","title":"","status":"","priority":"","due":"YYYY-MM-DD|null","url":"","updated":"ISO"}],
  "github":   [{"repo":"owner/name","number":0,"title":"","url":"","author":"","updated":"ISO","reason":"review_requested|my_pr_changes_requested|my_pr_approved"}]
}
```

- calendar: 오늘(로컬 날짜) 일정, 종일 일정 먼저 그다음 시작 시각 순
- jira: `assignee = currentUser() AND statusCategory != Done`, 마감 오름차순 → 갱신 내림차순, 최대 25
- github: 내 리뷰 요청 PR + 변경 요청/승인된 내 열린 PR, 최대 20

Todo 항목: `{id, title, done, created_at, done_at|null, due|null, note|null}` (ms 타임스탬프).

## Environment variables

| 변수 | 기본 | 설명 |
|---|---|---|
| `NED_HOME` | `~/.ned` | 데이터 루트. 테스트 시 `/tmp/ned-test` 같은 경로로 격리 |
| `NED_PORT` | (unset) | 설정 시 `config.yaml` 의 `port` 대신 이 포트로 listen (저장되지 않음). Ned.app 이 띄울 때 넘기고, 테스트 격리에 쓴다 |
| `NED_NO_LLM` | (unset) | `1` 이면 heartbeat 가 `claude -p` 를 호출하지 않고 `NED_OK` 를 기록하며, agenda 잡은 빈 agenda 를 쓴다 (비용 0, 테스트용) |
| `NED_CHILD` | — | 데몬이 띄운 `claude -p` 자식에 `1` 로 설정됨 (훅이 자기 자신을 관찰하지 않도록 쓸 수 있음) |

`claude` 바이너리는 `PATH` 에서 찾는다. 보통은 Ned.app 이 데몬을 자식 프로세스로 띄우며 `node`/`claude` 위치를 로그인 셸에서 찾아 `PATH` 에 넣는다 (`apps/menubar/README.md`).

## Data layout (`$NED_HOME`, 기본 `~/.ned`)

```
~/.ned/
  config.yaml            설정 (없으면 기본값으로 생성). heartbeat_minutes, signal_check_minutes,
                         briefing_time, quiet_hours, sources.{gmail,slack,jira,github,sentry,calendar},
                         port, claude_model, claude_max_turns, session_stale_minutes, agenda_refresh_minutes
  state.json             menu bar / 대시보드가 읽는 단일 뷰 (sessions, attention, last_briefing, quiet …)
  cursor.json            heartbeat 가 처리한 마지막 이벤트 ts
  events/YYYY-MM-DD.jsonl  훅(packages/hook/ned-hook.sh)이 append 하는 이벤트. 로컬 날짜 기준
  briefings/<iso-ts>.json  heartbeat / daily 브리핑 결과 (status, action_items, updates, fyi, sessions, cost_usd)
  briefings/sent.log     이미 알린 항목 키 (title 또는 url) — 중복 억제
  agenda.json            HOME 탭 agenda: {updated_at, cost_usd, error?, calendar, jira, github}
  todos.json             개인 할 일. 완료 후 7일 지난 항목은 로드할 때 정리된다
  dismissed.json         dismiss 한 세션 attention: {id: {alert_ts, at}} (7일 보관)
  logs/daemon.log        데몬 로그
  hook.err               훅 파이썬 단계의 stderr (정상이면 비어 있음)
```

세션 상태 머신 (`src/sessions.ts`): `UserPromptSubmit/SessionStart → running`, `Notification → waiting`,
`Stop → done`, `StopFailure → error`, `SessionEnd → 목록에서 제거`. 마지막 이벤트가
`session_stale_minutes` 보다 오래된 세션도 제거된다 (`0` 이면 비활성화).
`waiting`/`error` 세션은 매 tick `attention` 에 다시 올라온다. 단, 사용자가 dismiss 한 경우
그 알림(`alert_ts` = 마지막 `Notification`/`StopFailure` 시각)이 바뀌기 전까지는 올리지 않는다.

## Smoke test (LLM 호출 없이)

```sh
export NED_HOME=/tmp/ned-test NED_NO_LLM=1
echo '{"hook_event_name":"Notification","session_id":"s1","cwd":"/x/wt","message":"needs permission"}' \
  | sh ../hook/ned-hook.sh                       # prints {} and appends to $NED_HOME/events/<today>.jsonl
node dist/cli.js state                            # sessions[0].status == "waiting"
node dist/cli.js run &  curl 127.0.0.1:7777/api/state;  kill %1
```
