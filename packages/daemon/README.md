# @ned/daemon

Ned 의 코어 데몬. Claude Code 훅이 남긴 세션 이벤트를 집계하고, 주기적으로 `claude -p` 를 호출해
업무 신호(Gmail/Slack/Jira/Sentry/GitHub/Google Calendar, claude.ai 커넥터 경유)를 브리핑으로 정리하며,
menu bar 앱과 로컬 대시보드가 읽는 `state.json` 을 유지한다. 읽기 전용: 어떤 쓰기 액션도 하지 않는다 — 단 하나의 예외는
사용자가 켠 경우의 `POST /api/send` (아래 "답장 초안 · 보내기" — Slack/Gmail/세션, Jira 코멘트·상태 변경, GitHub 리뷰·코멘트, 캘린더 참석 응답).

> 사용자 기능 가이드(탭·카드·버튼·단축키·설정 키): [`docs/FEATURES.md`](../../docs/FEATURES.md) — 맨 위 "요약" 은 Ned 대화창 프롬프트에도 들어간다.

## Build

사용자 설치는 Claude Code 플러그인(`/ned:install` — 루트 [README](../../README.md)): 소스를 `~/.ned/runtime/` 으로 동기화해 거기서 빌드하고,
Ned.app 이 그 경로의 `packages/daemon/dist/cli.js run` 을 띄운다. 세션 훅은 플러그인 `hooks/hooks.json` 이 등록한다. 개발 중에는:

```sh
pnpm install            # 모노레포 루트에서 한 번
pnpm --filter @ned/daemon build   # tsc → dist/
```

## Commands

```sh
node dist/cli.js run                 # 데몬: 대시보드(127.0.0.1:7777) + 이벤트 감시 + heartbeat 스케줄러
node dist/cli.js heartbeat [--daily] # heartbeat 1회 강제 실행 (claude -p 호출, 결과 JSON 을 stdout 에 출력)
node dist/cli.js state               # events → sessions 를 다시 계산해 state.json 을 갱신하고 출력
node dist/cli.js agenda              # agenda 잡 1회 실행 (calendar/jira/github/gmail/slack → agenda.json, 결과를 stdout 에 출력)
node dist/cli.js prompt agenda       # dry-run: heartbeat | briefing | agenda 프롬프트를 치환된 그대로 출력 (claude 호출·이벤트 커서 커밋 없음)
node dist/cli.js setup-check [--json] # 시작하기 점검 1회(아래 "시작하기") — /ned:install 이 설치 뒤 실행. 사람이 읽는 표, --json 은 GET /api/setup 과 같은 모양(onboarding 빼고)
```

### 시작하기 (`src/setup-check.ts`)

설정에서 켠 소스(`sources.*`)가 실제로 읽히는지 + Slack 팀 ID + 코드 서명. 대시보드 "시작하기" 창(`GET /api/setup`)과 `ned setup-check` 가 같은 함수.
- 커넥터: `claude -p --output-format stream-json --verbose --max-turns 1`(argv 는 `buildClaudeArgs` — runClaude 와 같은 바이너리·env, 빠른 시작 설정 포함)을 띄워
  `system/init` 줄의 `mcp_servers[{name, status}]` 만 읽고 그 자리에서 끈다 — 모델 호출 전이라 비용 0. `claude mcp list` 는 쓰지 않는다(인증이 필요한 Gmail 을
  "Connected" 로 보여 줬다). 빠른 시작에서 claude.ai 서버가 하나도 없으면 전체 설정으로 한 번 더(runClaude 의 폴백과 같음). `NED_NO_LLM=1` 이면 띄우지 않고 확인 실패.
- 소스 ↔ 서버 이름 표 `SETUP_SOURCES` 하나(대소문자 무시, 표 이름 + " …" 로 긴 이름도 맞음): slack `claude.ai Slack` · gmail `claude.ai Gmail` · calendar `claude.ai Google Calendar` ·
  jira `claude.ai Atlassian` · sentry `Sentry`(~/.claude.json MCP 서버, `mcp__Sentry__*`) · github 은 커넥터가 아니라 `gh auth status`(exit 0 = 연결됨, gh 없음 = 연결 안 됨).
- 상태: `connected` · `needs-auth` · `pending`(아직 붙는 중 — 5초 뒤 한 번 더 보고, 그래도면 pending) · 그 밖의 status(`failed` 등) = `error` · 목록에 없음 = `not-connected`. 띄우기 실패·90초 초과 = 커넥터 전부 `error`(detail 에 이유).
- 코드 서명: `security find-identity -v -p codesigning` 에 "Ned Local Signing" → ok, `-v` 없이만 보이면 `untrusted`, 없으면 `missing`. `command` = `bash <레포>/scripts/make-signing-cert.sh`(다음 설치부터 적용 — package.sh 가 빌드 때 고름).
- Login Item 은 여기 없다 — `SMAppService` 는 Ned.app 만 읽고 바꾼다(대시보드 → `webkit.messageHandlers.loginItem`, apps/menubar README).

### 업데이트 확인 (`src/update-check.ts`)

Ned.app 메뉴 "업데이트 확인"과 설정 → 앱의 같은 버튼이 `GET /api/update-check` 를 부른다. 설치하지는 않는다(설치는 Claude Code 흐름).
- 현재 버전: `$NED_RUNTIME_DIR`(없으면 `$NED_HOME/runtime`)`/.claude-plugin/plugin.json` — `/ned:install` 이 빌드하는 곳. 런타임이 없는 개발 체크아웃이면 데몬이 도는 체크아웃(`REPO_ROOT`)의 것.
- 최신 버전: (a) `gh api -H "Accept: application/vnd.github.raw+json" repos/<owner>/<repo>/contents/.claude-plugin/plugin.json?ref=main`(비공개 레포 → `gh auth login` 필요; 슬러그는 plugin.json `repository`/`homepage` 에서) →
  실패하면 (b) `$CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)`/plugins/marketplaces/<marketplace.json name>/.claude-plugin/plugin.json`. 둘 다 안 되면 `error` 에 둘의 사유.
- 비교는 semver(프리릴리스 < 정식). 결과 10분 캐시(동시 요청은 한 번만), `?refresh=1` 은 새로. 테스트는 `setUpdateDeps({readFile, gh})` 로 파일·gh 를 바꾼다.

### 자동 업데이트 (`src/self-update.ts`, `scripts/self-update.sh`)

config `updates.{auto_check, check_hours, auto_install}`(기본 켬 · 24 · 끔). 스케줄러가 매 tick `updateTick(cfg, {quiet, idle, now})` 를 부른다(조용한 시간 pause 중에도).
- 확인: `checkDue(last_check_at, check_hours)` 면 위 확인 → `recordCheck` 가 `$NED_HOME/update-state.json` 의 `available {current, latest}` 를 갱신(실패한 확인은 이전 값 유지)하고
  `state.json` 의 `update_available {current, latest, notified}` 로 비춘다(`state.ts` `readUpdateBadge`, writeState 마다).
- 알림: `announceVerdict` — 버전마다 한 번(`notified_version`), 조용한 시간엔 `notifications.quiet_delivery` 가 silent 일 때만, `notifications.enabled=false` 면 안 함.
  알릴 때 `notified_version` 을 쓰고, Ned.app 은 `notified: true` 가 된 새 `latest` 를 배너로(NED_NOTIFY=app 이 아니면 osascript `notify()`).
- 설치 조건 `installVerdict`(순수): 새 버전 + `auto_install` + (조용한 시간 또는 유휴) + `state.sessions` 에 running·waiting 없음(워커 포함) + 락 없음 +
  마지막 실패 뒤 24시간(`RETRY_AFTER_FAIL_MS`; 2시간 넘은 "running" 은 실패로). "지금 업데이트"(`manual`)는 락·새 버전 여부만 본다.
- 실행 `startSelfUpdate`: `/bin/bash <runtime>/scripts/self-update.sh --to X --from Y --marketplace <marketplace.json name> --plugin <plugin.json name>` 를
  `detached: true`(setsid — install.sh 가 앱·데몬을 내려도 안 죽음), stdio = `~/.ned/logs/self-update.log`, `unref()`. `update-state.json` 에 `last_result: "running"`.
- 스크립트: `$NED_HOME/self-update.lock`(mkdir + pid, 죽은 소유자면 인수) → `claude plugin marketplace update` → `claude plugin update <plugin>@<marketplace>` →
  `installed_plugins.json` 의 installPath(없으면 `plugins/cache/<marketplace>/<plugin>/<to>`)의 버전이 `to` 인지 확인 → `NED_PLUGIN_MODE=1 bash …/scripts/install.sh < /dev/null` →
  `update-state.json` 에 `last_result ok|fail`, `fail_line`(실패한 단계의 마지막 줄), `finished_at`(ok 면 `available` 비움). 전부 `main()` 안이라 install.sh 가 런타임 폴더를 바꿔도 안전.
  종료 코드 0 / 1(단계 실패) / 2(인자) / 75(이미 실행 중). 테스트: `test/self-update.test.ts`(PATH 의 `claude` 스텁).

`run` 은 시작 직후 heartbeat 를 한 번 돌린다. 이후 `heartbeat_minutes` 마다 tick 하며,
새 세션 이벤트도 없고 `signal_check_minutes` 가 지나지 않았으면 LLM 을 부르지 않고 침묵한다.
`briefing_time` 이 지난 첫 tick 은 `prompts/briefing.md` 로 아침 브리핑을 만든다 (하루 1회).

**아침 브리핑 재시도** (`src/scheduler.ts`): 아침 브리핑은 성공했을 때만 그날 완료(`lastDaily`)로 친다. `heartbeat()` 는 결과 브리핑에
`ok`(claude 성공 && JSON 파싱 성공)를 남기고, 실패해도 파일은 `type: "daily"`, `ok: false`, `raw` 로 저장한다(`briefingOk()` — `ok` 없는
옛 파일은 `raw` 가 없으면 성공). 스케줄러는 실패(또는 throw)면 `DAILY_RETRY_MINUTES`(10) 뒤 다시, `DAILY_MAX_RETRIES`(3)번까지; 다 실패하면
그날은 포기하고 로그 + `onDailyFailed` → `state.daily_failed_at`(대시보드 홈 한 줄, 성공한 daily 가 `null` 로 지움). 재시도 중에도
`hbBusy` 락과 예산 가드는 그대로. 데몬 재시작 시 `hadGoodDailyOn(오늘)` — 성공한 daily 파일만 센다, 재시도 횟수는 0부터.
실패 브리핑은 아카이브 🌅·대화창 맥락에서 빠지고, 대시보드(인박스 기록·타임라인·검색)엔 "아침 실패"로 보인다.

**오프라인·wake grace** (`src/online.ts`, 스케줄러 deps `online`·`wakeGapMs`): 자동 실행이 있을 틱에만 `dns.promises.lookup("api.anthropic.com")`
(3초 타임아웃, 30초 캐시) → 실패면 그 틱 전체를 건너뛴다(전환 때만 로그 `offline — …` / `online again — …`, 비용 0, 소스 상태 그대로,
야간·유휴 종료 전체 갱신은 온라인 틱까지 미룸). 앞 틱과 `WAKE_GAP_MS`(3분) 이상 벌어진 틱은 잠에서 깬 것으로 보고 아무것도 안 돌린다.
수동 `POST /api/check`·`/api/heartbeat`·`/api/agenda/refresh` 는 스케줄러를 거치지 않으므로 확인 없이 즉시.

**무변경 skip** (`heartbeat_skip_unchanged`, 기본 true — `src/scheduler.ts`): 스케줄러가 자동 heartbeat 를 돌리기 직전, 아침 브리핑이 아니고
(a) 켜진 소스 전부의 `sources_status[k].signature`, (b) `heartbeatWatchKey`(앞으로 2시간 안 일정 id + 아직 안 알린 "내 답 이후 새 답글" 스레드 키 —
시간이 흐르거나 2단계가 스레드를 읽어도 목록 서명은 그대로라 따로 본다), (c) 처리 안 된 세션 알림 이벤트(Stop/StopFailure/Notification,
`pendingSessionNews` — heartbeat.ts 가 즉시 판단하는 기준과 같다; 프롬프트 입력 같은 일반 이벤트는 보지 않는다) 가 **마지막으로 판단한**
heartbeat 이후 그대로면 claude 를 부르지 않는다. `state.next_heartbeat_at` 은 다음 주기로 정상 갱신, 로그 `heartbeat: skipped — unchanged (…)`.
heartbeat.ts 가 침묵(null, `signalDue`·세션 알림 없음)으로 끝난 회차는 기준점이 되지 않는다. Sentry 는 heartbeat 만 읽으므로 켜져 있으면
`HEARTBEAT_SKIP_MAX_MINUTES`(180분)마다 한 번은 실제로 돈다. 수동 `POST /api/check`·`/api/heartbeat`·`ned heartbeat` 는 스케줄러를 거치지 않아 늘 실행.

**heartbeat = agenda 재사용** (`src/heartbeat.ts`, `prompts/heartbeat.md` · `briefing.md`): heartbeat 는 Gmail·Slack·Jira·GitHub·캘린더를
직접 읽지 않는다. 흐름 — (a) `agenda.json` 이 `signal_check_minutes` 보다 오래됐으면 agenda 1단계(`refreshAgenda`)를 돌리고 기다린다
(이미 돌고 있으면 그 실행에 합류; 실패하면 이전 목록으로 진행) → (b) 프롬프트 `{{AGENDA}}` 에 agenda 목록을 압축한 텍스트를 넣는다:
캘린더(heartbeat: 앞으로 2시간 + 응답 안 한 초대 / 아침: 오늘 일정 전체), Slack `items` + 답 안 한 `all` + 팔로업 채널 요약·하이라이트(`[나 필요]`),
메일 `items` + 안 읽은 수, Jira, GitHub. heartbeat 는 `sent.log` 에 이미 있는 url 의 항목을 미리 뺀다(아침 브리핑은 그대로) →
(c) `claude -p` 를 커넥터 없이 부른다: `sources.sentry` 가 켜져 있으면 `--tools ToolSearch` + `mcp__Sentry__search_issues`/`get_issue_details` 만,
`--max-turns 6` (Sentry 는 agenda 가 안 다루는 유일한 소스); 꺼져 있으면 도구 없이 isolated(설정·MCP 생략, 1턴). 모델은 `claude_model`.
`claude_max_turns` 는 더 이상 heartbeat 에 쓰지 않는다. NED_OK·`sent.log` 중복 억제·알림·attention 은 전과 같다. `{{SESSIONS}}`/`{{EVENTS}}` 는
`is_worker === true` 인 세션(Orca 워커)을 뺀다(필드가 있을 때). 측정(2026-11-06, Sentry 꺼짐, `claude-fable-5-1`, 신선한 agenda):
$0.36 · 1턴 · 46초 — 이전(커넥터 직접 조회) $2.09–2.34 · 12–15턴 · 107초–7분.
로그 한 줄에 `agenda reused (Nm old)` / `refreshed in Ns, $x` / `joined running refresh`, `judge Ns`, `total Ns` 가 찍힌다.

**맡긴 일** (`config.responsibilities`, `src/config.ts` `normalizeResponsibilities` · `src/heartbeat.ts`): 켜져 있고 `until`(로컬 날짜, 그날 포함)이
안 지난 책임(`activeResponsibilities`)이 있으면 heartbeat.md 의 `{{#RESP}}…{{/RESP}}` 블록이 살아나 "맡긴 일" 입력 절(`{{RESPONSIBILITIES}}`:
id·제목·until·챙길 것·켜진 볼 곳·키워드·지난 평가)과 출력 필드 `responsibilities: [{id, status: on_track|watch|blocked, note, urls≤3}]` 이 붙는다.
없으면 블록이 통째로 빠져 프롬프트가 기능 이전과 글자 하나 다르지 않다(테스트로 고정). 답은 `applyResponsibilityReport` 가 정리 —
모르는·꺼진 id, 잘못된 status, 중복 id 는 버리고, urls 는 그 회차 `{{AGENDA}}` 다이제스트에 있던 링크만(`promptUrls`, 대소문자 무시 → 원래 표기),
답에 없는 책임은 이전 평가·`updated_at` 유지, config 에서 지운 id 의 평가는 정리 → `state.json` `responsibilities.<id> = {status, note, urls, updated_at}`.
`status: NED_OK` 여도 저장(침묵 규칙은 알림·action_items 만), 답이 JSON 이 아니면 손대지 않음. blocked 이고 사용자가 움직여야 하면 프롬프트가
`action_items` 에도 `[책임 제목] …` 으로 넣게 한다 — 새 attention/pet/notify kind 없음. 활성 책임 목록은 `heartbeatWatchKey` 에도 들어가
추가·수정·만료가 무변경 skip 을 깬다. config.yaml 을 손으로 고쳐 id 가 없으면 제목 해시로 안정적인 id 를 주고(읽을 때마다 같음),
`PUT /api/config` 로 새로 들어온 행은 slug+난수 id. 6개 이상·목록 아님·제목 없는 행은 400 `{field: "responsibilities"}`.

**지금 점검** (`POST /api/check`): agenda 1단계를 **항상** 새로 돌린 뒤 heartbeat(강제). 동시에 여러 번 불러도 한 번만 돈다.
`GET /api/check` → `{running, phase: "agenda"|"judge"|null, daily, started_at, phase_started_at}` — 스케줄된 heartbeat·아침 브리핑도 같은 상태를 낸다.
`POST /api/heartbeat` 는 호환용으로 남는다(agenda 는 오래됐을 때만 갱신).

**확인 완료** (`reviewed_at`): attention 항목은 그대로 두고 `~/.ned/reviewed.json`(id → ms, 7일 보관)에 표시만 한다.
`writeState` 가 매번 `reviewed_at` 을 덧입히므로 refreshSessions / heartbeat 가 attention 을 새로 만들어도 유지되고, 표시 뒤에
항목이 바뀌면(`ts` 가 더 늦음 — 예: 세션의 새 알림) 다시 열린 상태가 된다. `POST /api/attention/:id/review {reviewed: boolean}`
(본문 없으면 표시, 없는 id 는 404) → `{ok, id, reviewed_at, attention_open_count}`. `state.json.attention_open_count` 는
확인 완료를 뺀 개수(메뉴바 배지용). 대시보드는 초안 생성(`POST /api/draft`) 성공 후 그 항목에 이 API 를 부른다.
attention id 가 없는 소스 항목도 같은 저장소·엔드포인트를 쓴다 — 키는 네임스페이스로: `mail:<thread id>`,
`slack:<채널 id>:<ts>`(permalink 에서; 못 뽑으면 링크), `jira:<KEY>`, `github:<repo>#<n>` (id 는 URL 인코딩, 없는 attention 이어도
이 형식이면 받는다). 30일 보관. `GET /api/agenda` 의 `reviewed` 에 이 키들만 실어 보내고, agenda 가 같은 항목을 다시 가져와도
키가 같아 유지된다. 키·판정은 `src/review-keys.ts` 한 곳(대시보드 `revkeys.js` 는 복제, `test/review-keys-shared.test.ts` 가 같은
픽스처로 양쪽 검증): Slack 키는 permalink 의 채널·메시지 ts 만(스레드 메타와 무관). 다시 열림 = 표시 시각 < 항목의 마지막 변경
(`activityMs` — 메일 `received`, Jira·GitHub `updated`, Slack `max(행 ts, thread.last_reply_ts, thread.search_latest_ts)`).
`finalizeSlackView`·`openSlack`/`isCurrent`(`slackRecReviewed`, agenda `slack.threads` 로 스레드 조회)·대시보드 카드/이력/팔로업이 같은 규칙.
예전 `slack:<ch>:<ts>@<답글 ts>` 표시는 `readReviewed` 가 기본 키로 접고(여럿이면 최대) 다음 `setReviewed` 가 새 형식으로만 다시 쓴다;
그런 키로 POST 해도 기본 키로 저장. 접두사는 맞는데 나머지가 비었거나 공백이 있는 키(`slack:` 등)는 400.
Slack ✓ 는 `markThreadSeen` 으로 그 스레드의 `seen_reply_ts` 에 **마크 시각**(reviewed.json 값, Slack ts 형식 `markTs` = `(ms/1000).toFixed(6)`)도
남긴다(해제 시 삭제). `hasNewSinceMe` = `new_since_me > 0 && latestTs(t) > seen_reply_ts` 라 ✓ 판정(마크 ms ≥ 스레드 최신 ts)과 같은 순간을 본다 —
✓ 전에 달렸지만 늦게 수집된 답글은 행도 "새 답글"(reopen·팔로업 needs_me·heartbeat·+N 칩)도 열지 않고, ✓ 뒤 답글은 둘 다 연다.
이 규칙 전 레코드의 `seen_reply_ts`(그때 본 답글 ts)는 형식이 같아 그대로 읽는다(마크보다 약간 이른 기준이 될 뿐, 마이그레이션 없음).

**알림 설정** (`config.notifications`): `{enabled, kinds:{session,email,slack,jira,github,sentry,calendar}, briefing,
summary_threshold (기본 3), quiet_delivery: skip|silent (기본 skip), sound}`. 읽을 때·`PUT /api/config` 모두 깊게 머지하고
타입을 맞춘다(잘못된 값은 이전 값). `state.json.notifications` 에 그대로 노출 — Ned.app 이 읽어 배너를 결정한다. 데몬의
osascript 폴백도 같은 규칙: 꺼져 있으면 안 보냄, 켜진 kind 의 액션만, 개수가 threshold 이하면 항목별·초과면 묶음 1건, 아침
브리핑은 `briefing`, 조용한 시간엔 skip(안 보냄)/silent(소리 없이), `sound` 면 소리.

**메일·Slack 전체 목록**: agenda 출력의 `mail.all[]`(최근 2일 안 읽은 메일, 최신 `agenda_all_limit`(기본 20)개: id, from, subject, ts, url, unread)과
`slack.all[]`(최근 24h 나를 멘션·DM 한 것, 최대 `agenda_all_limit`개: channel, from, text, url, ts, reason, answered). Slack DM 은 같은 대화(permalink 의 채널 ID, 없으면 channel+보낸 사람)당 최신 1건만 남기고 답 안 한 개수를 `count` 에 — 프롬프트가 그렇게 만들고, 정규화(`collapseDMs`)와 대시보드가 한 번 더 묶는다. 멘션·스레드는 그대로. 선별(`items`)과 같은
검색 결과로 같은 호출에서 만든다. **`all` 은 항상 `items` 의 상위집합**: 프롬프트가 요구하고, 정규화(`supersetSlack`/`supersetMail`)가 빠진
`items` 행을 permalink / thread id 기준으로 `all` 에 더한다(Slack `answered: false`, 메일 `unread: false`, 최신순 재정렬 — 이 때문에 `all` 이 한도보다 최대 10개 길 수 있다).

**캘린더 범위**: agenda 잡은 캘린더를 오늘이 아니라 로컬 날짜 **어제 ~ +13일**(2주)로 받아 `agenda.json` 에
`calendar_range: {from, to}` 를 남긴다. 홈 인사말·"다음 미팅" 같은 오늘 기준 계산은 오늘 날짜로 걸러 쓴다.
그 밖의 날짜는 `GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`(최대 42일): `~/.ned/calendar/<from>_<to>.json` 캐시가
6시간 안이면 그대로, 아니면 캘린더 도구만 허용한 `claude -p`(`prompts/calendar.md`, maxTurns 6)로 받아 캐시한다. 같은 범위는
실행 하나를 공유하고 다른 범위는 줄 세워 하나씩. `NED_NO_LLM=1` 이면 빈 배열(캐시 안 함).

**페르소나 — 미제공 기능** (`config.persona`: `ned` | `alfred` | `oracle` | `jarvis`, 기본 `ned`; 모르는 값은 PUT 에서 무시, 읽을 때 `ned`; 기존 값은 그대로 존중).
현재 UI 미제공 — 대시보드·메뉴바 어디에도 선택 진입점이 없고, config.yaml 의 `persona:` 로만 바꾼다.
기능·데이터는 그대로 두고 말투 + 대시보드 테마 + 마크만 바꾼다. heartbeat.md · briefing.md · agenda-lists.md 의 `{{PERSONA}}` 는
`prompts/personas/<id>.md`(이름, 말투 규칙 5줄, 헤드라인 예시 3개, NED_OK 멘트 예시 3개, 금지사항)로 치환된다. 상태값
`NED_OK` / `UPDATE` 와 JSON 키는 페르소나와 무관하게 그대로. `state.json.persona` 에 같은 값을 미러링한다(세션 갱신마다,
`PUT /api/config` 직후) — 대시보드와 메뉴바 앱이 이걸 읽는다. 캐릭터 이름만 표기하고 로고·실제 대사·이미지는 쓰지 않는다.

**홈 카드 배치** (`config.dashboard`): `{ card_order: ("slack"|"mail"|"jira"|"github")[], card_span: { <id>: 1|2 } }`, 기본
Slack(2) → 메일(1)·Jira(1) → GitHub(2). 읽을 때·`PUT /api/config`(보낸 경우만) 모두 `normalizeDashboard` — 모르는 id·중복은 버리고 빠진 카드는
뒤에 붙이고, 폭이 1|2 가 아니면 이전 값. 대시보드 화면만 쓴다(`public/README.md` "카드 높이").

**링크를 앱으로 열기** (`config.dashboard.open_links_in_app` 기본 true · `open_links_in_app_by_service.{slack,figma,notion}` 기본 true ·
`slack_team_id` 기본 ""): 규칙 테이블은 `src/links.ts`(순수, import 없음 — `public/app/features/links.js` 가 복제, `test/links-shared.test.ts`
가 같은 픽스처로 둘 다 돌림). Slack permalink `…slack.com/archives/<C|D|G…>/p<ts>[?thread_ts=]` → `slack://channel?team=<T>&id=<C>&message=<ts>[&thread_ts=]`
(팀 ID 없으면 변환 안 함; `slack_team_domain` 이 있으면 `<domain>.slack.com`·`<domain>.enterprise.slack.com` 만 — 다른 워크스페이스는 웹,
비면 모든 `*.slack.com`; `^[a-z0-9-]+$`, 소문자화·`.slack.com` 떼고 저장, 아니면 400 `{ field: "dashboard.slack_team_domain" }`), Figma `(design|file|board|proto)/<key>…` → `figma://` + 같은 경로·쿼리, Notion `notion.(so|com)/<…32-hex 또는 8-4-4-4-12 id…>[#블록]` →
`notion://www.notion.so/…`(`*.notion.site` 는 변환 안 함). `slack_team_id` 는 `^T[A-Z0-9]{6,}$` 만(대문자화) — 다른 값은 `PUT /api/config` 가
400 `{ field: "dashboard.slack_team_id" }`, 손으로 고친 config.yaml 이면 읽을 때 무시. 팀 ID 자동 감지는 없음(Slack 토큰 없음, 수집 데이터에
team 필드 없음). 열기는 대시보드(`features/openlink.js`) → Ned.app `openLink` 메시지 핸들러(`apps/menubar/…/DashboardWindow.swift`
`DeepLink.open`: 앱 미설치·열기 실패면 웹 URL, `open link: …` 로그 한 줄). 앱 딥링크는 Ned.app 창에서만 — 브라우저로 연 대시보드는
메시지 핸들러가 없어 늘 웹 URL 을 바로 연다(딥링크 시도·폴백 타이머 없음). WKWebView 탐색(`decidePolicyFor`·`createWebViewWith`)으로
직접 들어온 `slack://`·`figma://`·`notion://` 는 웹 URL 이 없어 앱이 없으면 아무것도 안 열림(로그 한 줄) — 대시보드는 이 경로를 쓰지 않는다.

**트래킹 제외** (`config.filters`): `slack.exclude_channels`(채널명, `#` 없이) · `jira.exclude_projects`(프로젝트 키, 대문자 영숫자만 —
JQL 에 그대로 들어가므로 그 밖의 값은 버린다). heartbeat.md · briefing.md · agenda-lists.md 의 `{{FILTERS}}` 가
`제외 채널: #a, #b / 제외 Jira 프로젝트: KEY1, KEY2 — 이들에 속한 항목은 조회·보고하지 말 것` + Jira JQL 에 넣을
`AND project NOT IN (...)` + Slack 결과에서 버리라는 지시로 바뀐다(비면 `(없음)`). agenda 는 JQL 에 그 절을 직접 넣고
(`{{JQL_EXCLUDE}}`), 정규화 단계에서 제외 프로젝트 이슈·제외 채널 Slack 항목을 한 번 더 걸러낸다. `PUT /api/config` 는
`filters` 를 소스별로 깊게 머지한다 (`filters.slack` 만 보내도 `filters.jira` 유지). API 라우트는 config.yaml 을 매번 새로 읽는다.

**팔로업 채널** (`config.filters.slack.watch_channels`, 기본 `[]`, 최대 20): 멘션·태그가 없어도 따라가 볼 Slack 채널(채널명, `#` 없이).
`exclude_channels` 에도 있으면 제외가 이긴다. 비어 있지 않으면 agenda-lists.md 의 `<!--@watch-->` 섹션이 Slack 호출에 들어가
채널마다 `slack_search_public_and_private`(`filters: "in:#채널"`, 최근 24h, 20개)를 다른 검색과 같은 턴에 병렬로 부르고
(`maxTurns` +2), `slack.watch[]` = `{channel:"#채널", summary(2~3줄: 정해진 것·물은 것), highlights:[{from, text(≤200), ts, url,
needs_me, reason}](채널당 최대 5)}` 를 돌려준다. `needs_me` = 나를 향한 듯한 질문·요청, 내 일에 영향 주는 결정, 마감.
heartbeat / briefing 의 `{{FILTERS}}` 에도 팔로업 목록이 붙어 needs_me 는 `action_items`(kind slack), 채널 결정은 `updates` 로 간다.
대시보드: 설정 → "팔로업 채널" 칩 입력, 홈 Slack 카드의 "채널 팔로업" 접힘 섹션(needs_me 는 강조 바), 카드·소스 pill·인사말 카운트에 needs_me 포함.

**답 필요 해제 이모지** (`config.filters.slack.ack_reactions`, 기본 `["white_check_mark","eyes","+1","heavy_check_mark"]`, 최대 8, `[]` 면 끔):
멘션·DM·참여 스레드에서 **내 답글이 보이거나 내가 이 이모지 중 하나로 리액션하면 확인 완료**다. Slack 검색 결과엔 리액션 목록이 없고
스레드 읽기에도 누가 달았는지는 안 나오므로, agenda-lists.md 의 `<!--@ack-->` 섹션이 이모지마다
`slack_search_public_and_private`(`filters: "hasmy::<이모지>:"`, 최근 24h, 20개, `response_format: "concise"`, `include_context: false`)를 한 번씩 부른다
(`has`/`hasmy` 는 반복하면 AND 라 이모지마다 따로; `hasmy:reaction` 같은 "아무 이모지" 필터는 Slack 이 무시한다).
비용 절감: (1) **조건부** — 모델은 먼저 멘션·DM·스레드(·팔로업) 검색만 한 턴에 하고, 그 결과에 답 필요 후보(`items` 후보, 팔로업 `needs_me` 후보)가
하나라도 있을 때만 다음 턴에 이모지 검색을 병렬로 한다. 후보 0개면 건너뛰고 `acked_urls: []`. (2) **상한** — `filters.slack.ack_check_max`(기본 3, 1~8)개,
`ack_reactions` 앞에서부터만 검색한다(`ackCheckEmojis`). 측정 전 기준 Slack 1단계 13턴·조회 12회 중 이모지 6회가 절반이었다.
(2단계로 옮기는 안은 버렸다 — `slack_read_thread`/`slack_read_channel` 결과에 누가 리액션했는지가 없어 `hasmy` 검색 말고는 확인할 방법이 없다.) 그 permalink 들 = `acked` →
`items` 에서 빼고, `all` 은 `answered: true`, `watch` 하이라이트는 `needs_me: false`. 모델은 `slack.acked_urls[]` 도 내고, 정규화(`normalize`)가
permalink(쿼리·해시 무시)로 같은 처리를 한 번 더 한다 — 확인한 DM 은 그 대화의 그 이전 메시지까지 닫는다. 이름은 콜론 제거·소문자, 한글 커스텀 이모지 가능.
설정 → "답 필요 해제 이모지" 칩 입력(쉼표·엔터로 추가).

**그룹 멘션** (`config.filters.slack.group_mentions`, 기본 `[]`, 최대 8): 내가 속한 Slack 유저그룹 멘션(원문 `<!subteam^S…|@이름>`)은
`<@me>` 검색에 안 걸리므로 그룹마다 따로 찾는다. 항목은 유저그룹 ID(`S0ABC123`, 소문자로 넣어도 대문자로) 또는 핸들(`@Mobile-Dev` → `mobile-dev`, 소문자; 공백 제거·대소문자 무시 중복 제거;
`normalizeGroupMentions`). 그룹이 있을 때만 items 규칙에 "그룹 멘션은 위 그룹 규칙을 따른다"·우선순위에 `> group` 이 붙는다(`{{GROUP_ITEMS_RULE}}`·`{{GROUP_PRIO}}`). 프롬프트 `{{GROUP_MENTIONS}}`(`groupMentionsPrompt`): 비어 있으면 `""`(프롬프트·턴 수 그대로), 있으면 멘션·DM·스레드
검색과 **같은 턴에** 그룹마다 `slack_search_public_and_private` 한 번 — `keywords: ["<!subteam^S…>"]`(ID) / `keywords: ["\"@핸들\""]`(핸들).
도구 설명상 `keywords` 배열은 **AND** 라서 여러 그룹·표기를 한 검색에 넣을 수 없다 → 그룹 수만큼 검색(결과 0이어도 다른 표기로 재검색 안 함).
결과 `reason: "group"`: `all` 엔 모두(answered 규칙 동일), `items` 엔 그룹에 구체적 질문·요청을 했고 아무도(나 포함) 답하지 않은 것만.
같은 permalink 가 여러 검색에 걸리면 `dedupeSlack` 이 하나로 합치고 reason 은 dm > mention > thread > group(answered 는 OR).
그룹 멘션은 스레드 팔로업(`syncThreadsFromList`/`threadCandidates`) 대상에서 뺀다. 대시보드 칩 "그룹"(👥).

**Agenda 잡** (`src/agenda.ts`, `src/agenda-context.ts`, `prompts/agenda-lists.md`, `prompts/agenda-context.md`): 대시보드 HOME 탭용
구조화 데이터. 시작 직후 1회(전 소스), 이후 1분마다 틱을 돌며 **소스별 주기**(`agenda_source_minutes.<slack|mail|calendar|jira|github>`,
null 이면 `agenda_refresh_minutes`(기본 60), 1..1440)가 지난 소스만 모아 한 번에 갱신한다(`src/schedule.ts`; 마지막 실행 =
스케줄러가 돌린 시각과 `sources_status.started_at` 중 늦은 것이라 카드 ↻ 수동 갱신도 다음 자동 갱신을 미룬다; 일일 예산 hard stop 은 그대로).
그리고 `POST /api/agenda/refresh` 때 돈다. 소스별 동시성 — 같은 소스는 한 번에 하나, 다른 소스는 나란히. 로그: `agenda: scheduled refresh [slack] (due: slack 15m)` / `(startup)` / `agenda: manual refresh [mail]`. 두 단계다 —
"메시지 목록 먼저, 맥락은 백그라운드".

- **1단계 — 목록 (소스별 병렬, 먼저 끝난 소스부터 반영)**: 소스마다 따로 `claude -p` 를 **동시에** 띄우고(시작 순서 = 우선순위:
  Slack → 메일 → Jira → 캘린더), 각 호출이 끝나는 즉시 그 소스 키만 `agenda.json` 에 병합 저장한다(원자적 read-modify-write).
  GitHub 는 LLM 없이 데몬이 `gh search prs` 3개를 직접 병렬 실행(~1s)하고, `gh` 가 실패할 때만 Jira 호출에 섞인다.
  호출마다 `prompts/agenda-lists.md` 에서 그 소스 섹션만 골라 쓰고(`<!--@slack-->…` 마커), 허용 도구는 `ToolSearch` + 그 소스의 목록 도구
  하나뿐(Slack `slack_search_public_and_private`, Gmail `search_threads`, Calendar `list_events`, Jira `searchJiraIssuesUsingJql`;
  github 폴백 시 `Bash(gh search prs:*)`), `--tools ToolSearch`, `--max-turns 6`, 모델 `agenda_light_model`(기본 `sonnet`, null 이면
  `claude_model`). 스레드·본문은 열지 않는다(맥락 없음). 시작하면 켜진 소스 전부 `sources_status.<key>.status = "running"` 이 되고,
  끝나면 `done`(또는 `error` — 이때 이전 목록 유지) + `updated_at`/`duration_ms`/`cost_usd`/`signature`/`unchanged`. 결과가 비면
  20초 뒤 한 번 더 묻고(커넥터가 늦게 붙는 경우), 두 번째도 비면 빈 목록으로 받아들인다. 실패·빈 응답 원문은 `agenda.raw.txt`.
- **2단계 — 답장 맥락 (백그라운드)**: Slack(그다음 메일) 목록이 병합되는 순간 시작한다. 대상은 답장이 필요한 항목 — slack `items`,
  `slack.watch[].highlights` 중 `needs_me`, mail `items` 중 reason `reply|approval|request` — 가운데 `draft_context_max_age_minutes` 안의
  `context` 가 없는 것. `agenda_context_batch`(기본 5)개씩 `prompts/agenda-context.md` 로 묶어 읽는다: Slack 은 `slack_read_thread`/
  `slack_read_channel`, 메일은 `get_thread`(PLAIN_TEXT)만 허용, `--max-turns 6`, 모델 `agenda_light_model`. 결과는 배치마다 즉시
  permalink / thread id 로 항목에 병합한다(`items`·`all`·watch 의 같은 행 모두). 맥락 모양은 그대로(`SlackContext`/`MailContext`)라
  `drafts.ts` fast path 는 변경 없음(watch highlight 의 맥락도 찾도록만 넓힘). 진행은 `context_status { pending, done, failed, running,
  updated_at, cost_usd, stopped, skipped }`. 끝나면(`drafts_pregenerate` 가 켜져 있으면) 초안 미리 생성.
  - **변경 없는 소스 건너뛰기**: 소스별 서명(정렬된 permalink / thread id 등의 sha1 12자)을 `sources_status.<key>.signature` 에 남기고,
    맥락 수집이 깨끗이 끝난 서명을 `context_sigs` 에 기록한다. 다음 실행의 서명이 같으면 그 소스의 2단계를 통째로 건너뛴다
    (`?force=1` 이면 무시). 목록이 새로 와도 기존 맥락은 항목 단위로 이월된다(Slack 은 같은 permalink, 메일은 같은 thread 이고 맥락을
    읽은 시각이 마지막 메시지보다 뒤일 때).
  - **팔로우 스레드·DM 재읽기** (`processThreads`, `src/slack-threads.ts`): 매 Slack 패스 뒤 `slack.threads[]`/`slack.dms[]` 중 최근 48h 활동이
    있는 것을 최대 `agenda_thread_batch`(8)·DM 5개 한 번에 읽는다. 읽을 때 1단계가 본 최신 ts(`search_latest_ts`)를 `read_search_ts` 로 남기고,
    다음 패스에서 그 값이 그대로면 건너뛴다(`followState` = `unchanged`). 한 번도 안 읽은 것(`never`)·1단계가 더 새 메시지를 본 것(`moved`)은
    지금처럼 읽고, 같은 ts 라도 마지막 읽기가 `THREAD_RECHECK_MINUTES`(6시간) 지났으면 1회 재확인(`recheck` — 1단계는 최신 20건만 봐서
    조용해 보이는 스레드도 움직일 수 있다). 후보가 0이면 claude 를 부르지 않고, 로그에 `agenda-threads: … skipped unchanged N thread(s), M DM(s)` 를 남긴다.
    `read_search_ts` 가 없는 예전 기록은 `last_reply_ts` 와 비교한다(예전 규칙).
    스레드 읽기 결과 검사(DM 은 대상 아님; 경고마다 `WARN agenda-threads: …` 1줄 + `agenda-threads: trace model output …` 1줄):
    ① **신뢰 불가** — 답글이 있어야 하는데(`reply_count > 0` 또는 `search_latest_ts > thread_ts`) ts 를 읽을 수 있는 메시지가 원글뿐이거나,
    같은 ts 가 겹침(원글 ts 를 답글에 재사용) → last_reply_*·new_since_me·요약·recent 를 덮어쓰지 않고 유지(`checked_at`·`read_search_ts` 는
    갱신 — 재읽기 루프 없음). ② **뒤처짐** — 마지막 메시지 ts < `search_latest_ts` → `last_reply_ts` 를 그 값으로 올리고 `last_reply_from` 은 비움,
    `last_reply_text` 는 `(답글 내용 미확인)`(`UNKNOWN_REPLY`), 내 마지막 답보다 뒤면 `new_since_me ≥ 1`. heartbeat 키는 `@last_reply_ts` 라
    나중에 같은 답글을 제대로 읽어도 알림이 다시 가지 않는다. 프롬프트(threads 절)는 각 메시지 자신의 ts, 원글 ts·`known_last_reply_ts` 재사용 금지,
    모르면 ts `""` 로 두고 메시지는 빼지 말라고 지시한다. 이미 잘못 기록된 예전 레코드는 확인 판정·`hasNewSinceMe` 가 `max(…)` 로 읽어 마이그레이션 없이 동작.
  - **일일 예산**: 배치 직전마다 오늘(로컬 날짜) 총 `claude -p` 비용(`~/.ned/costs.json`, agenda·agenda_context·heartbeat·draft·calendar·
    action 합산)이 `agenda_daily_budget_usd`(기본 15) 이상이면 멈추고 `context_status.stopped = "budget"`. 1단계 목록은 예산과 무관하게 돈다.
- 동시에 여러 번 요청돼도 실행 중인 1단계 한 번을 공유한다(busy guard). 2단계는 워커 하나가 소스 큐(Slack 우선)를 순서대로 처리한다.
  `NED_NO_LLM=1` 이면 claude 없이: 1단계는 `NED_NO_LLM_AGENDA`(모델 출력 모양의 JSON 파일) 또는 빈 목록, 2단계는 항목 텍스트로 만든
  스텁 맥락(비용 `NED_NO_LLM_COST`, 지연 `NED_NO_LLM_DELAY_MS`).

실측 (2026-11-06, 같은 계정·같은 날, 팔로업 채널 없음):

| 실행 | 1단계 소스별 병합 시각 (+초) | 1단계 | 2단계 | 합계 |
|---|---|---|---|---|
| 이전: 단일 `claude -p` (목록+맥락+all 50) | — (전부 한 번에) | >300s | (포함) | ~$4.6 |
| 콜드 (맥락 없음) | github +1 · jira +41 · slack +49 · calendar +83 · mail +83 | 83s, $1.03 | slack 1건 40s $0.13 · mail 1건 24s $0.10 | $1.25 |
| 재실행 (목록 변화 없음) | github +1 · jira +48 · mail +48 · slack +88 · calendar +88 | 88s, $1.03 | 전 소스 skip, $0 | $1.03 |

호출별 편차가 크다(같은 Slack 호출이 49~88s). 기동(사용자 settings·플러그인·커넥터 로드)만 ~18-20s 이고, 커넥터가 사용자 settings 를
필요로 해서 `--setting-sources ""` 로 줄일 수 없다(그러면 ToolSearch 가 커넥터를 못 찾음). 캘린더는 2주치(29개) JSON 출력(~9K 토큰)이
지배적이라 단독 호출로 분리했다.

### HTTP API

모든 라우트(`/api/*`·`/mcp`·정적 파일)는 `src/request-guard.ts` 를 먼저 거친다 — loopback 이 아닌 Host·Origin 은 403(DNS rebinding 방지, Origin·Host 가 없으면 허용).

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/state` | `state.json` (sessions, attention, last_briefing, …). 세션마다 `can_reply`: 그 세션의 훅 이벤트에 `orca_pane`/`orca_tab` 이 있었나(= Ned 가 Orca 터미널로 답을 보낼 수 있나 — 지금 열려 있는지는 전송 때 409), `notification_type`: 대기를 만든 Notification 의 종류(다른 상태 이벤트에 null — `inReplyDialog` = waiting + permission_prompt/elicitation_dialog) |
| GET | `/api/events?days=2` | 최근 N일의 훅 이벤트 (오래된 것부터) |
| GET | `/api/briefings?limit=30` | 브리핑 히스토리 (최신 먼저) |
| GET | `/api/feed` | 데스크톱 펫(Ned.app) 메시지 피드 `{items, pet, quiet, persona, quick_replies, session_send}` — `src/feed.ts`. `quick_replies` = `dashboard.session_quick_replies`, `session_send` = `actions.session_send`(펫 말풍선의 세션에 답하기). 통신기 메시지 탭(`chat-core.js buildFeed`)과 같은 입력·규칙(열린 attention, 24h 안 UPDATE 브리핑 headline, 내 답 이후 새 답글이 있는 Slack 스레드 — 소스 slack 이 꺼지면 빠짐, 같은 url 은 한 번), 최신순. 각 항목 `key`·`kind`·`title`·`detail`·`url`·`ts` + `pet_kind`(`pet.messages` 토글: email→mail, thread→slack, other→null=항상) + `deep`(링크 열기 규칙의 앱 딥링크). 브라우저 전용 chatNotes 는 없음. `test/feed-shared.test.ts` 가 같은 fixture 로 buildFeed 와 key·kind 순서를 비교 |
| GET / PUT | `/api/config` | `config.yaml` 조회 / 부분 갱신 |
| POST | `/mcp` | MCP Streamable HTTP(stateless·JSON 응답) — 도구 `ned_attention` 외 5개. GET/DELETE 405, loopback 아닌 Host·Origin 403. 아래 "MCP 서버" |
| POST | `/api/heartbeat?daily=1` | heartbeat 강제 실행 (agenda 는 오래됐을 때만 갱신 — 호환용) |
| POST | `/api/check?daily=1` | 대시보드 '지금 점검': agenda 1단계 새로 고침 → heartbeat. 결과 브리핑(또는 `{status:"skipped"}`) 반환, 동시 호출은 한 실행을 공유 |
| GET | `/api/check` | 진행 중인 점검 단계 `{running, phase: "agenda"\|"judge"\|null, daily, started_at, phase_started_at}` |
| POST | `/api/attention/:id/dismiss` | attention 항목 제거. 세션 항목은 `dismissed.json` 에 기억돼 같은 알림으로는 다시 안 뜬다 |
| GET | `/api/agenda` | `agenda.json` (+ `busy`, `sources_status`, `context_status`). 없으면 빈 배열과 `updated_at: 0`. 실행 중이 아닌데 `running` 으로 남은 소스(데몬이 도중에 죽음)는 `error: "interrupted"` 로 보여 준다 |
| POST | `/api/agenda/refresh` | body `{ sources?: ["slack", …] }`(없으면 켜진 전 소스). 요청 소스가 **모두** 이미 갱신 중이면 409 `{ busy }`; 일부만이면 나머지만 시작하고 갱신 중인 것은 기다린다. 1단계(목록)가 끝나면 `started`·`busy` 와 함께 반환. 2단계는 백그라운드로 계속 — 응답의 `context_status.running` |
| POST | `/api/agenda/context?force=1` | 2단계(답장 맥락)를 지금 백그라운드로 시작하고 `{context_status}` 를 바로 반환. `force=1` 은 "목록 변화 없음" 건너뛰기를 무시 (신선한 맥락이 있는 항목은 여전히 건너뜀) |
| GET | `/api/costs?days=14` | `{ today, today_usd, budget_usd, over_budget, days: [{day, total_usd, runs, jobs: {<job>: {usd, runs}}}] }` — `~/.ned/costs.json` |
| GET | `/api/todos` | 개인 할 일 목록 |
| POST | `/api/todos` | `{title, due?, note?}` → 생성된 항목 (201). title 이 비면 400 |
| PATCH | `/api/todos/:id` | `{title?, done?, due?, note?}` 부분 갱신. 없으면 404 |
| DELETE | `/api/todos/:id` | 삭제. 없으면 404 |
| POST | `/api/draft` | 답장·코멘트 초안 3개 (Slack / 메일 / 에이전트 세션 / Jira 코멘트 / GitHub 리뷰). 읽기 전용 `claude -p`. 아래 참고 |
| GET | `/api/draft/status` | 초안 미리 생성 마지막 실행 `{ pregenerated, skipped_cached, failed, cost_usd, last_run_ts, running }` |
| POST | `/api/chat` | Ned 채팅 한 턴 `{ conversation_id?, text ≤2000자 }` → `text/event-stream`: `start{conversation_id,title}` → `delta{text}`* (`turn` = 새 응답 시작, `tool{name,label}`) → `done{text,stopped,cost_usd,chat_cost_usd,today_usd,output?,output_error?}` \| `error{error}`. 400 빈/긴 입력, 404 모르는 대화, 409 다른 턴 진행 중, 429 일일 예산 초과(`chat_ignore_budget: true` 면 예외). 읽기 도구만(`--tools ToolSearch,Bash`, 커넥터 읽기 + `gh` 읽기·`orca status`), plan 모드, `--resume <session_id>` 로 이어감, 비용 job `chat`. 저장: `~/.ned/chats/<id>.json` (최근 20개) |
| GET | `/api/chats` | `{ chats: [{id,title,updated_at,messages,cost_usd}], active, input_max }` 최신순 |
| GET | `/api/chat/:id` | 저장된 대화 `{ id, title, session_id, cost_usd, messages: [{role: user\|ned, text, ts, cost_usd?, error?, stopped?, action?, output?, output_error?}], running }` |
| POST | `/api/chat/:id/stop` | 진행 중인 턴에 SIGTERM (없으면 404). 지금까지 흐른 텍스트가 `stopped: true` 로 저장됨 |
| POST | `/api/chat/actions/validate` | 확인 카드 검증 `{ block: <ned-action JSON>, text?: 고친 텍스트 }` → 200 `{ ok, kind, endpoint: /api/send\|/api/calendar/events\|/api/todos, payload (origin "chat"), label, summary, target_label, text, text_optional, lookup? }` · 400 형식 · 403 `actions.chat_write`/해당 스위치 꺼짐 · 409 대상이 최근 agenda/state 에 없음. 실행은 안 함 (`src/chat-actions.ts`) |
| POST | `/api/chat/:id/action` | 카드 상태 저장 `{ ts (ned 메시지), state: running\|executed\|failed\|cancelled, text?, result? }` → 메시지의 `action`. (없음\|failed)→running\|cancelled, running→나머지; executed·cancelled 는 최종(409) |
| POST | `/api/send` | 초안 보내기 — `config.actions` 로 켠 것만. 꺼져 있으면 403 |
| GET | `/api/actions` | `sent-actions.log` 최근 50건 (최신 먼저) |
| POST | `/api/sessions/create` | 대화창에서 세션 만들기 (`actions.chat_session_create`, 기본 off) `{repo, worktree:{mode:"new"\|"existing", name}, model:"opus"\|"sonnet"(기본 opus), prompt}`. 400 입력/미등록 레포/없는 기존 워크트리, 403 꺼짐, 409 대화창 출처로 살아 있는 세션 2개(상한), 202 `{job_id}` — 아래 "세션 만들기" |
| GET | `/api/sessions/create/:job_id` | 세션 만들기 작업 `{state, stage, elapsed_ms, result?{ok, detail, session:{worktree_path, handle, stage}}}` (`stage`: worktree_create\|agent_launch → agent_boot → prompt_send → submit_confirm) |
| GET | `/api/history?source=&days=7&q=&channel=&limit=200` | 수집 이력 한 소스(`slack\|mail\|jira\|github\|calendar`, 아니면 400): `ts` 가 `days`(1~90) 안인 레코드 최신순 최대 200 → `{source, days, total, items: [{key, source, ts, first_seen, last_seen, current, title, detail, url, channel?, state, item}]}`. `current` = 지금 카드에 있음(Slack: 표시 구간 안 또는 열린 요청, 메일: 표시 구간 안, Jira·GitHub: `open` 이고 agenda 목록에 있음, 캘린더: agenda 목록에 있음). `q` 는 공백으로 나눈 토큰이 제목·상세에 모두 있어야(대소문자 무시), `channel` 은 Slack 채널(팔로업 행 포함) |
| GET | `/api/history/status` | `{enabled, display, sources: {<src>: {keep_days, recording, count, days, bytes, oldest, newest}}, collect: {slack\|mail: {last_ok_at, last_full_at, full_hours, next: {full, reason, since}}}, last_prune_day, overlap_minutes, full_rescan_hours}` |
| GET | `/api/archive/status` | Obsidian 아카이브 상태 `{ enabled, vault, folder, check: {ok, obsidian, path, error?} \| null, today_rel, today_url (obsidian://, 파일 있을 때), last_write_at, last_write_path, last_error, last_error_at, last_embed: {day, result}, pending_days }` — 아래 "Obsidian 아카이브" |
| GET | `/api/setup?refresh=1` | 시작하기 점검(위 "시작하기") `{checked_at, sources: [{key, label, via: connector\|mcp\|gh, status: connected\|needs-auth\|not-connected\|pending\|error, detail?, fix?: {text, url?, command?}}], slack_team_id: {status: ok\|missing\|n/a, value}, signing: {status: ok\|untrusted\|missing\|error, identity, command, detail?}, complete, onboarding: {dismissed_at}}` — 켠 소스만. (sources, 팀 ID) 가 같으면 1분 캐시(동시 요청은 한 번만 띄움), `refresh=1` 은 새로 |
| POST | `/api/setup/dismiss` | `{dismissed?: boolean}`(기본 true) → `{onboarding: {dismissed_at}}` — 시작하기 창이 저절로 뜨지 않게. `~/.ned/onboarding.json`(config.yaml 아님), false 면 지움 |
| GET | `/api/update/status` | 자동 업데이트 상태 `{auto: config.updates, last_check_at, next_check_at, attempt: {at, result, from, to, log, fail_line} \| null, running, quiet_now, update_available}` — 확인을 돌리지 않음 |
| POST | `/api/update/install` | 지금 업데이트: 새로 확인 → 새 버전이면 self-update.sh 시작 → 202 `{started, reason, check, status}`, 아니면 409(`reason`: 새 버전 없음 / 이미 업데이트 중) |
| GET | `/api/update-check?refresh=1` | 업데이트 확인(위 "업데이트 확인") `{current, latest, source: github\|marketplace\|null, update_available, checked_at, repo, steps: ["/plugin update ned", "/reload-plugins", "/ned:install"], error?, note?}` — `note` = 마켓플레이스로 폴백했을 때 gh 가 안 된 이유. 10분 캐시, `refresh=1` 은 새로 |
| POST | `/api/archive/flush` | 오늘(+대기 중인 날) 리포트를 지금 씀 → `{ ok, written: [day], error?, status }` · 409 아카이브 꺼짐 · 500 쓰기 실패(`status.last_error`) |
| GET | `/api/outputs?limit=50` | 정리 결과물 목록(최신순, `markdown` 뺌) `[{ id, ts, kind, title, sources, chat_id?, message_ts?, vault_rel?, vault_path?, obsidian_url?, vault_error? }]` |
| GET | `/api/outputs/:id` | 결과물 하나(`markdown` 포함). 404 |
| POST | `/api/outputs/:id/reveal` | "Finder 에서 보기": 볼트 노트(없으면 `~/.ned/outputs/<id>.md`)에 `open -R`. 테스트·`NED_NO_LLM=1` 에선 실행 안 함(`dry_run: true`). 404 |

Agenda 응답 형태:

```json
{
  "updated_at": 0, "cost_usd": 0, "error": "(실패한 소스가 있을 때만: \"slack: …\")",
  "sources_status": {"slack": {"status": "running|done|error", "updated_at": 0, "started_at": 0, "duration_ms": 0, "cost_usd": 0, "signature": "", "unchanged": false, "error": "?"}, "mail": {}, "calendar": {}, "jira": {}, "github": {}},
  "context_status": {"pending": 0, "done": 0, "failed": 0, "running": false, "updated_at": 0, "cost_usd": 0, "stopped": "budget|null", "skipped": ["slack"]},
  "context_sigs": {"slack": "", "mail": ""},
  "calendar": [{"id":"","title":"","start":"ISO","end":"ISO","all_day":false,"location":"","url":"","meet_url":"","rsvp":"accepted|needsAction|declined|tentative|organizer","attendees":0}],
  "jira":     [{"key":"","title":"","status":"","priority":"","due":"YYYY-MM-DD|null","url":"","updated":"ISO"}],
  "github":   [{"repo":"owner/name","number":0,"title":"","url":"","author":"","updated":"ISO","reason":"review_requested|my_pr_changes_requested|my_pr_approved"}],
  "mail":     null | {"summary":"한 줄 요약 | \"\"","unread":0,"unread_capped":false,"items":[{"id":"thread id","from":"","subject":"","snippet":"","received":"ISO","url":"","reason":"reply|approval|deadline|request","why":"한 줄"}]},
  "slack":    null | {"summary":"한 줄 요약 | \"\"","items":[{"channel":"#채널|DM|그룹 DM","from":"","text":"한 줄","url":"permalink","ts":"ISO","reason":"mention|dm|thread"}]}
}
```

- calendar: 오늘(로컬 날짜) 일정, 종일 일정 먼저 그다음 시작 시각 순
- jira: `assignee = currentUser() AND statusCategory != Done`, 마감 오름차순 → 갱신 내림차순, 최대 25
- github: 내 리뷰 요청 PR + 변경 요청/승인된 내 열린 PR, 최대 20
- mail: `unread` 는 최근 2일 안 읽은 받은편지함 스레드 수(최대 50, 50 에 닿으면 `unread_capped: true` → 홈은 "50+통"), `items` 는 최근 3일 중 사람이 보낸 업무 메일로 내 행동이 필요한 것(최대 10, 급한 순). 선별은 검색 결과의 발신자·제목·스니펫으로 한다(1단계는 스레드를 열지 않음). 답장 초안용 `context: { from, to, subject, body_excerpt(인용 제거, ≤1500자), attachments[], message_id, reply_to, collected_at }` 는 2단계가 reason `reply|approval|request` 항목만 `get_thread`(PLAIN_TEXT)로 읽어 채운다. 읽음 처리 등 쓰기는 하지 않는다. `mail: null` 은 아직 안 가져옴(mail 도입 전 agenda.json) 또는 gmail 소스 꺼짐. `GET /api/agenda`·`POST /api/agenda/refresh` 응답에는 `mail_enabled`(= `sources.gmail`)가 붙고, false 면 홈은 메일 묶음을 숨긴다
- slack: 최근 24시간, 나를 멘션했거나 DM/스레드에서 질문·요청했고 내가 아직 답하지 않은 것(최대 10, 급한 순). 1단계는 검색 3번(멘션 `<@me>` / `is:dm` / `is:thread with:<@me>`, + 그룹 멘션 그룹마다 1번 — 아래 "그룹 멘션")뿐이고 스레드를 열지 않는다(답했는지는 검색 context 로 판단, 애매하면 넣음; 해제 이모지로 내가 리액션한 메시지도 답한 것 — 위 "답 필요 해제 이모지"). Slack epoch ts 는 ISO 로 바꾼다. `items[]` 와 `watch` 의 `needs_me` 하이라이트에는 2단계가 `slack_read_thread`/`slack_read_channel` 로 읽은 `context: { participants[], messages[{from,ts,text}](최근 5개, 각 ≤300자), collected_at }` 가 붙는다(같은 permalink 의 `all[]` 행에도 같이). 응답에는 `slack_enabled`(= `sources.slack`)가 붙고, false 면 홈은 Slack 카드를 숨긴다

### 답장 초안 · 보내기 (`src/drafts.ts`, `src/draft-thread.ts`, `src/actions.ts`, `prompts/draft-extract.md`·`draft-write.md`·`draft.md`)

**초안** `POST /api/draft`

```jsonc
// 요청
{ "source": "slack" | "email" | "session" | "jira" | "github",
  "ref": { "url?": "", "channel?": "C…", "ts?": "", "thread_ts?": "", "thread_id?": "", "message_id?": "", "session_id?": "", "title?": "", "text?": "",
           "key?": "ABC-123", "repo?": "owner/name", "number?": "92" },
  "hint?": "내일 오전 가능하다고", "tone?": "반말", "force?": false }
// 응답 200
{ "id": "16hex", "source": "slack",
  "context": { "summary": "답할 대상 한 줄", "excerpt": "[답할 대상] 원문 발췌" },
  "drafts": [ { "id": "<id>-0", "label": "짧게", "text": "", "covers?": [1, 2] }, { "id": "<id>-1", "label": "보통", "text": "" }, { "id": "<id>-2", "label": "정중하게", "text": "" } ],
  "asks": [ { "who": "kim", "what": "리뷰 완료 시점", "due": "", "status": "open" | "answered", "answered_in": "ts|''", "before_reply?": true } ],
  "mentions": [ { "id": "<@U…>", "name": "kim" } ],   // 옛 캐시는 "<@U…>" 문자열일 수 있음
  "cost_usd": 0.12, "cached": false,
  "meta": { "channel_id?": "", "thread_ts?": "", "thread_id?": "", "message_id?": "", "reply_to?": "", "subject?": "", "session_id?": "", "mode?": "2pass" | "legacy" } }
// 400 {error} (source/ref 부족) · 502 {error} (claude 실패·출력 깨짐)
```

- **2-pass** (slack·email·jira, `meta.mode: "2pass"`; session·github 은 `"legacy"` = `prompts/draft.md` 한 번):
  1. **Pass 1 추출** (`prompts/draft-extract.md`): 출력 `{transcript:[{ts,from,mine,text,user_id?}], asks:[{who,what,due,status,answered_in,asked_in[]}], participants:[{name,user_id?}], reply_meta?}`.
     fast 경로는 agenda 발췌만 보고 도구 없이(`draft_fast_model`, 1턴, isolated — `transcript` 는 `[]`, Ned 가 발췌를 그대로 씀), full 경로는
     지금 도구 세트(slack read_thread/read_channel, Gmail get_thread/search_threads, Jira getJiraIssue + `atlassianUserInfo`)로 읽고 `--max-turns 8`.
     full 의 transcript 는 `EXTRACT_MAX_MSGS`=25개 × `EXTRACT_MAX_CHARS`=250자(내 마지막 메시지와 그 뒤는 모두, 앞은 최근 것 위주) — 출력 토큰·타임아웃 때문.
     mine: Slack = 내 user_id(ToolSearch 로 불러온 `slack_search_public_and_private` 설명에서, 그 도구는 실행 불가), 메일 = SENT/내 주소, Jira = currentUser.
     "확인해 볼게요" 류 대기성 답글은 answered 가 아니라고 프롬프트에 명시.
  2. **데몬 구획·표시** (`src/draft-thread.ts`, 순수): `segment(transcript, {myLastTs})` — 마지막 `mine` 메시지(또는 팔로업 스레드의
     `my_last_reply_ts` → `SlackContext.my_last_ts`, 더 최신이면 — fast 는 발췌, full 은 `agendaContext(req)` 에서; ts 없는 mine 은 그 앞의 가장 늦은 ts 로
     본다)까지 `context`, 이후 `target`; mine 이 없으면 전부 target. 빈 글·이모지·`+1`·`ㅇㅇ`·`ㅋㅋ` 류는
     `(짧은 반응)`. context 는 `DRAFT_CTX_MAX_MSGS`=20 · `DRAFT_CTX_MAX_CHARS`=4000(오래된 것부터 잘라 "…앞 N개 생략"). `reconcileAsks` — **status 는
     Pass 1 그대로**(데몬이 answered 로 내리지 않음: 대기성 답글 뒤의 질문이 '이미 답함'이 되는 걸 막음). open 인데 `asked_in` 이 전부 내 마지막 답글
     이전(ts 는 `tsSec` 숫자로 비교)이면 `before_reply: true` — Pass 2 엔 `[내 마지막 답글 이전 질문 — 아직 답 안 됨]` 으로, 모달엔 "이전" 칩. 놓친 질문은 만들지 않음.
     from·who·due·what 은 공백 한 칸으로 정규화.
  3. **Pass 2 작성** (`prompts/draft-write.md`, 도구 없음, `draft_fast_model`, 1턴, isolated): `renderSegments`(참여자 `이름(<@U…>)`,
     `### [맥락] — 참고만, 요약하지 않는다`, `### [답할 대상] — 내 마지막 답글(MM/DD HH:mm) 이후`, 줄 `[MM/DD HH:mm] 나|이름: 내용`) + open asks 번호 목록 +
     이미 답한 것(반복 금지) + 말투·힌트. `{{OPEN_RULE}}`(`writeOpenRule`): open 있으면 번호 순서로 1:1(초안마다 `covers`); open 0 이고
     [답할 대상]에 다른 사람 메시지가 없으면(내가 마지막) 후속 확인(독촉)·추가 공유; Jira 면 진행 상황 공유; 그 밖엔 짧은 확인형. 힌트가 있으면 "힌트를
     우선한다" 를 덧붙임. `mentions` 는 Slack·참여자 2명 이상·알려진 `<@U…>` 만 `{id, name}` 으로 남김 — fast 경로는 발췌에 user_id 가 없어 Pass 1 의
     participants.user_id 를 버림(= 멘션 제안 없음). `excerpt` 를 비우면 Ned 가 [답할 대상] 의 마지막 실질 메시지로 채움.
  - 템플릿은 `fillTemplate` 한 번 치환(`/\{\{(\w+)\}\}/g`) — 메시지 본문에 `{{ASKS}}` 등이 있어도 다른 섹션으로 바뀌지 않음(extract·write·legacy 공통).
  - 실패: Pass 1 이 돌았는데 JSON 이 깨지면 legacy 1회(`meta.mode: "legacy"`). Pass 1 실행 자체 실패(`ok:false` — 타임아웃·커넥터 없음·spawn 오류)면
    fast 는 full 2-pass 로 1회, full 은 바로 502(같은 오류 메시지 — 4분 대기를 두 번 하지 않음). Pass 2 실패는 fast 면 full 2-pass 로 1회, full 이면
    Pass 2 만 1회 더(읽기는 다시 안 함) 후 502. 폴백 결과의 `cost_usd` 는 앞선 호출 합산이고 캐시 파일에도 그 값으로 저장(`withCost`).
  - 로그: `draft: … (fast, 2pass) — N drafts, K open asks; pass 1 $… s · pass 2 $… s · total $… s`. 두 호출 모두 `costs.json` job `draft`.
  - `NED_NO_LLM=1`: 2-pass 스텁 — [답할 대상] 에서 `?`·요청 어미가 있는 메시지를 open ask 로, 초안 `[stub …]`.

- 필요한 ref: slack 은 `url`(permalink — channel/ts/thread_ts 를 파싱) 또는 `channel`(+`ts`/`thread_ts`), 없으면 `text` 만으로 씀.
  email 은 `thread_id`(agenda `mail.items[].id`) 권장, 없으면 `title`/`text` 로 1회 검색. session 은 `session_id` 필수.
  jira 는 `url`(`https://<site>.atlassian.net/browse/KEY-1` — 사이트 호스트가 cloudId) 필수(+`key`). github 는 `repo`+`number` 또는 PR `url`.
- **jira** (코멘트 초안, full 경로): plan 모드 + `--tools ToolSearch` + `mcp__claude_ai_Atlassian__getJiraIssue`(summary·description·status·comment) + `atlassianUserInfo`(내 코멘트 구분).
  최근 코멘트의 질문이 있으면 답, 없으면 진행 상황 공유. `meta: {issue_key, cloud_id}`.
- **github** (리뷰 코멘트 초안, fast 경로·도구 없음): Ned 가 직접 읽기 전용 `gh pr view <n> --repo <r> --json title,body,author,…,files`
  (= 파일별 ±, `gh pr diff` 에는 `--stat` 플래그가 없어 이걸로 대신)와 `gh pr diff` 앞 6000자를 프롬프트에 넣는다. `meta: {repo, number}`.
  승인/변경 요청 여부는 초안이 아니라 보내기 단계에서 사용자가 고른다.
- 응답에 `mode: "fast" | "full"` 와 `context_age_minutes` 가 붙는다.
  - **fast** (목표 ≤10s): ref 가 agenda 항목(slack `items`/`all` 은 permalink 또는 channel+ts, mail `items` 는 thread id)과 맞고 그 항목의
    `context` 가 `config.draft_context_max_age_minutes`(기본 180) 안이면, 그 맥락만으로 프롬프트를 만들고
    `claude -p --tools "" --max-turns 1 --permission-mode plan --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands`
    `--effort low --model <draft_fast_model>`(기본 `sonnet`, null 이면 `claude_model`) 로 돌린다(사용자 hooks·플러그인·MCP 를 띄우지 않아
    기동 ~40s → ~3s). 지연의 대부분은 출력 토큰이라 모델은 `excerpt`/`reply_meta` 를 비워 두고 Ned 가 맥락(마지막 상대 메시지,
    메일 `message_id`·`reply_to`·`Re: 제목`)으로 채운다. hint·재생성도 같은 맥락을 쓴다. 실패하면 full 로 한 번 넘어간다.
    session 은 항상 fast(`context_age_minutes: 0`) — `~/.ned/events` 에서 그 세션의 `transcript_path` 를 찾아 최근 user/assistant 텍스트
    12개(최대 6000자)와 마지막 Notification/Stop 을 프롬프트에 넣는다. 도구 없음.
  - **full**: 맥락이 없거나 오래됐을 때. plan 모드 + `--tools ToolSearch` + 소스별 읽기 도구만: slack `slack_read_thread`/`slack_read_channel`,
    email `get_thread`/`search_threads`. `--max-turns 8`. `context_age_minutes: null`.
- 미리 생성(선택): `config.drafts_pregenerate: true`(기본 false)면 agenda 실행 뒤 백그라운드에서 답장이 필요한 항목(slack `items` +
  mail `items` 중 reason `reply|approval|request`, 맥락이 신선한 것)을 순서대로 최대 6개 fast 경로로 생성해 캐시한다(모달이 바로 열림).
  2-pass 라 항목당 claude 호출 2번(둘 다 도구 없는 fast 1턴).
  `GET /api/draft/status` → `{ pregenerated, skipped_cached, failed, cost_usd, last_run_ts, running }` (마지막 실행 기준, 로그에 총 비용).
- 초안은 **사용자 본인 목소리**: `{{PERSONA}}` 를 쓰지 않고 요청 `tone` → `config.reply_tone_by_source[source]`(slack/email/session, null 이면 건너뜀) → `config.reply_tone`(기본 말투, 기본 `간결하고 정중한 존댓말, 핵심 먼저`) 순으로 고른다 (`draftTone`). 대시보드는 `tone` 을 보내지 않고 서버가 정한다.
- 캐시: `~/.ned/drafts/<id>.json`, id = sha1(source + ref 키) 앞 16자 (Slack ref 키의 thread_ts 는 없으면 DM 이 아닌 한 ts —
  보내기와 같은 기본값이라 팔로업 ✎(thread_ts 명시)와 카드·이력 ✎ 가 같은 초안·미리 생성 캐시·10분 중복 방지를 공유). 1시간 안이고 hint·tone 이 같으면 `cached: true` 로 그대로
  (session 은 마지막 이벤트 ts 도 키에 들어가 세션이 진행되면 새로 쓴다). `force: true` 면 무시. 같은 키 동시 요청은 실행 하나를 공유.
- `meta` 는 보내기에 쓸 주소: slack 은 channel_id/thread_ts, email 은 모델이 스레드에서 찾은 `message_id`(답장할 마지막 메시지)·
  `reply_to`·`subject`. `POST /api/send` 에 `draft_id` 를 넘기면 이 meta 를 캐시에서 읽어 쓴다.
- `NED_NO_LLM=1` 이면 `[stub 짧게] …` 스텁 3개(비용 0, 캐시 안 함). 2단계 이전 캐시 파일(asks·mentions·meta.mode 없음)은 `asks: []`·`mentions: []` 로 채워 돌려준다.
- **오래된 스레드 맥락**은 아래 legacy 프롬프트 규칙이다 — 2-pass full 경로의 Pass 1 은 늘 스레드 전체(limit 50)를 읽는다.
- **오래된 스레드 맥락** (Slack full 경로만): ref 의 agenda 발췌(`agendaContext`)가 없거나 `collected_at` 이 `DRAFT_CTX_FRESH_HOURS`(6시간)보다
  오래됐으면 `prompts/draft.md` 의 `{{CONTEXT_RULE}}` 에 "먼저 `slack_read_thread`(channel_id, message_ts=thread_ts ?? ts, limit 50)로 스레드 전체를
  읽고 그 맥락으로 쓴다" 를 넣는다 (스레드 없는 DM `D…` 은 `slack_read_channel` limit 50). 6시간 이내 발췌면 빈 문자열 — fast 경로(180분 이내)와
  그 사이(180분~6시간, full 경로의 기존 읽기 지시)는 그대로 (`contextRule`, `buildDraftPrompt(…, ctx?)`).
- **origin** (선택): `card` | `history` | `watch` | `chat` (`src/origin.ts` `parseOrigin`, 그 밖의 값은 무시). 초안 로그 줄에만 쓰이고,
  대시보드는 같은 값을 `POST /api/send` 에도 실어 액션 로그에 남긴다.

**보내기** `POST /api/send` `{ draft_id?, source, ref, text, mode, origin? }` → `200 { ok, action, detail, logged_at }`,
그 외 `{ ok:false, action, detail, logged_at, error }` + 400(잘못된 요청·주소 없음) / 403(꺼짐) / 409(세션 터미널 없음) / 502(실패·검증 안 됨).

| source | mode | 스위치 (`config.actions`, 기본) | 동작 |
|---|---|---|---|
| slack | `send` | `slack_send` (false) | `claude -p --permission-mode dontAsk --tools ToolSearch --allowedTools ToolSearch mcp__claude_ai_Slack__slack_send_message --max-turns 4`. `thread_ts` 가 있으면(ref·permalink·draft meta) 스레드 답글, DM(`D…`)이 아니면 `ts` 스레드에 답글, 아니면 채널 메시지. 모델이 `{"ok":true,"permalink":"https://…slack.com/archives/…"}` 를 돌려줘야 성공 |
| email | `gmail_draft` | `gmail_draft` (true) | 같은 패턴, 도구는 `mcp__claude_ai_Gmail__create_draft` 하나 (`replyToMessageId` = message_id, `to`/`subject` = draft meta). 보내지 않고 Gmail 임시보관함에 회신 초안만 만든다. `{"ok":true,"id":…}` 여야 성공 |
| email | `send` | `gmail_send` (false) | 같은 패턴, 도구는 `mcp__claude_ai_Gmail__reply` 하나 (`messageId`, replyAll 없음) |
| session | `session` | `session_send` (true — 로컬·되돌릴 수 있음) | 세션 이벤트의 `orca_pane`(`<tabId>:<leafId>`)/`orca_tab` → `orca terminal list --json` 의 `leafId`/`tabId` 로 핸들을 찾아 `orca terminal send --terminal <handle> --text <text> --enter`. 이벤트에 Orca 정보가 없거나 터미널이 닫혔으면 409. 권한·선택 대화상자로 기다리는 세션(`inReplyDialog`)도 orca 호출 없이 409 — 그 화면에선 글자는 무시되고 Enter 가 강조된 항목을 확정한다(Claude Code keybindings: Confirmation `confirm:yes` = Enter). 글 ≤2,000자(다른 소스 4,000), CRLF→LF·앞뒤 공백·끝 줄바꿈 제거(Enter 는 `--enter` 한 번). 대기 아닌 세션에도 보낸다(추가 지시). 성공하면 그 세션의 현재 알림을 `dismissAttention` 과 같은 기록으로 내린다(새 Notification 이면 다시 뜸). 대시보드 세션 행(origin `session`)·펫 말풍선(origin `pet`)·초안 팝업·대화창이 쓴다. 테스트는 `_setSessionOrca(mock)` 로 orca 를 바꾼다 |
| jira | `comment` | `jira_comment` (false) | 같은 패턴, 도구는 `mcp__claude_ai_Atlassian__addCommentToJiraIssue` 하나 (cloudId = URL 의 사이트 호스트, `contentFormat: markdown`, 새 코멘트만). `{"ok":true,"id":…}` 여야 성공 |
| jira | `transitions` | `jira_transition` (false) | **읽기만**: 도구는 `getTransitionsForJiraIssue` 하나. 응답에 `transitions: [{id, name, to?}]` — 대시보드가 이 목록을 먼저 보여 준다. 로그에도 남는다(mode `transitions`) |
| jira | `transition` | `jira_transition` (false) | 도구는 `transitionJiraIssue` 하나, `ref.transition_id`(숫자, 위 목록의 id) 필수, `ref.transition_name` 은 로그용. 모델이 같은 id 로 `{"ok":true,"id":"<id>"}` 를 돌려줘야 성공 |
| github | `approve` · `request_changes` · `review_comment` | `github_review` (false) | `claude -p --permission-mode dontAsk --tools Bash --allowedTools "Bash(gh pr review:*)" --max-turns 3`. Ned 가 명령(`gh pr review <n> --repo <r> --approve\|--request-changes\|--comment [--body-file <파일>]`)을 직접 만들고, 본문은 `~/.ned/tmp/gh-body-*.md`(0600, 실행 뒤 삭제)로 넘겨 모델이 셸 인용을 하지 않는다. `approve` 만 본문 생략 가능. `gh pr review` 는 TTY 가 아니면 아무것도 출력하지 않으므로, 성공 판정은 실행 뒤 Ned 가 읽기 전용 `gh pr view --json reviews` + `gh api user` 로 **내 리뷰가 그 상태로 방금 달렸는지** 확인한다 |
| github | `comment` | `github_review` (false) | 같은 패턴, 허용은 `Bash(gh pr comment:*)` 하나 (`gh pr comment <n> --repo <r> --body-file <파일>`). 출력에 `github.com/<r>/pull/<n>#issuecomment-…` 가 있어야 성공 |
| calendar | `rsvp` | `calendar_rsvp` (false) | 도구는 `mcp__claude_ai_Google_Calendar__respond_to_event` 하나. `ref.event_id`(+`calendar_id`), `ref.response` = `accepted\|declined\|tentative`, `text` 는 선택(responseComment). `{"ok":true,"status":"<response>"}` 여야 성공 |

- Slack 반응(이모지 reaction)은 **없음**: claude.ai Slack 커넥터에 reaction 도구가 없다(send/schedule/draft/canvas/읽기만). 도구가 생기면 같은 패턴으로 추가.
- `text` 필수: slack·email·session·jira `comment`·github `request_changes`/`review_comment`/`comment`. 그 밖(`approve`, `transition(s)`, `rsvp`)은 선택.

- email 은 `message_id` 가 필요하다(ref 또는 `draft_id` 의 meta). 없으면 400 — 보내기 단계에서는 읽기 도구를 허용하지 않는다.
- 텍스트는 JSON 문자열로 프롬프트에 넣고 "글자 하나 바꾸지 말고 그대로, 도구 한 번만" 지시. 최대 4000자.
- 모든 시도(거절·실패·dry-run 포함)는 `~/.ned/sent-actions.log` 에 JSONL 한 줄:
  `{ts, source, mode, action, ref, draft_id, text(앞 120자), ok, result, claude_args?, origin?}` — `claude_args` 는 실제 spawn 한 argv.
  `origin` = 어디서 실행했는지: `card`(홈 카드 행 ✎·⋯) · `history`(카드의 "지난 N일" 이력 행) · `watch`(팔로업 카드 행·최근 대화·요약 줄) ·
  `chat`(Ned Net 확인 카드). 없으면(예전 줄·다른 클라이언트) 그대로 둔다. 게이트는 `chat` 에만 추가(`actions.chat_write`) — `/api/todos` 도
  `origin: "chat"` 일 때만 대화창 경로(그 밖의 origin 은 일반 추가). `GET /api/actions` 는 줄을 그대로 돌려주고 설정 → 오늘 한 액션이 출처 칩으로 보여 준다.
- `NED_NO_LLM=1` 또는 `NED_SEND_DRY_RUN=1` 이면 커넥터·gh 액션(Slack/Gmail/Jira/GitHub/Calendar)은 argv 와 프롬프트를 로그에 남기고 실행하지 않는다
  (`ok:false`, `action: "dry_run:…"`, gh 본문 파일도 만들지 않음). 세션 보내기는 로컬이라 그대로 실행한다. `NED_NO_LLM=1` 의 jira `transitions` 는
  화면 테스트용 `(stub)` 전환 2개를 돌려준다.
- 대시보드: Jira·GitHub·캘린더 항목의 **⋯ 메뉴**(`public/app/features/actions.js`) — Jira: 코멘트 초안 쓰기… / 상태 변경…(전환 목록을 먼저 읽음),
  GitHub: 리뷰 초안 쓰기…(팝업에서 리뷰 코멘트·변경 요청·승인+코멘트·PR 코멘트) / 바로 승인, 캘린더: 수락·미정·거절(주최한 일정엔 없음).
  꺼진 스위치는 '꺼짐' 으로 비활성, 쓰기는 모두 메뉴/팝업 안에서 한 번 더 확인. 설정 → 쓰기 액션 아래 **오늘 한 액션** 표(`GET /api/actions` 를 오늘·소스·결과로 거름).
- **대화창 쓰기**(`actions.chat_write`, 기본 꺼짐): 통신기 대화 모델은 그대로 읽기 전용이고, 쓰기 요청엔 답 끝에 ```` ```ned-action ```` 블록
  `{kind, target, text, summary}` 로 **제안만** 한다(프롬프트엔 지금 허용된 kind 만 — `chatWriteBlock`). 대시보드가 확인 카드
  (`public/app/features/chat-action.js` — `renderActionCard`·`wireActionCards`, 다른 화면에서 재사용 가능)로 보여 주고, [실행] 때
  `POST /api/chat/actions/validate` 가 만든 요청을 **기존** `/api/send`·`/api/calendar/events`·`/api/todos` 로 보낸다(`origin: "chat"`).
  `origin: "chat"` 요청은 각 스위치에 더해 `actions.chat_write` 도 켜져 있어야 하고(꺼지면 403 refused), 로그 줄에 `origin` 이 붙는다(할 일 추가도
  `source: "todo"` 줄로 남음) → 설정 → 오늘 한 액션의 "대화창" 배지. Jira 상태 변경은 카드 텍스트(상태 이름)로 전환 목록에서 id 를 찾아 실행.
- **세션 만들기**(`src/session-create.ts`): 검증(토글·`orca repo list` 허용 목록·상한 2 — `~/.ned/chat-sessions.json` 의 handle 이 `orca terminal list` 에 살아 있는 것 + 진행 중 작업) 후 작업에서
  `orca worktree create --name <n> --repo path:<repo> --parent-worktree path:<repo> --agent claude --model <m> --surface terminal`(기존이면 `orca agent launch --worktree path:<wt>`) —
  `--prompt` 는 쓰지 않는다(초안으로만 남는 버그) → `orca terminal read --screen` 에 Claude 입력줄/상태줄이 보일 때까지(최대 90초, 신뢰 확인 화면이면 409)
  → `orca terminal send --enter --wait-submit 15 --text <prompt>` → draft 가 비고 첫 활동(스피너·도구 줄, 또는 receipt `turn_started`)이면 성공. 실패는 `[단계] 사유`.
  첫 프롬프트는 "먼저 계획을 제시하고 승인받은 뒤 구현한다." 로 시작(없으면 붙임). 로그: `source:"session", mode:"create", action:"session_create", origin:"chat", session_create:{…}`.
  대화창: ned-action kind `session_create`(`actions.chat_write` + `actions.chat_session_create` 일 때만 프롬프트에, Orca 등록 레포 목록 10분 캐시 포함) →
  `/api/chat/actions/validate` 가 `/api/sessions/create` 페이로드(`origin:"chat"`)를 만들고 읽기 전용 Orca 검사(등록 레포·기존 워크트리·상한)까지 →
  카드(`chat-action.js`)는 레포·워크트리·모델 읽기 전용, 첫 프롬프트(8000자)만 편집, `sendAndWait(…, {endpoint, match, maxWaitMs: 8분})` 로 폴링하며 `stage` 표시.
  `origin:"chat"` 요청은 `actions.chat_write` 도 켜져 있어야 한다(403). 세션(handle)이 생긴 뒤의 실패는 카드에서 다시 실행 불가(중복 생성 방지).
  `refreshSessions` 가 cwd(또는 Orca 워크트리 경로)가 기록된 워크트리인 세션에 `origin:"chat"`, `origin_terminal` 을 단다(장비실 배지). `NED_SEND_DRY_RUN=1` 이면 검증까지만.
- `actions.ts` 의 `queryActionLog({since, source, result}, limit)` 는 서버 쪽 필터용으로 준비돼 있다(`GET /api/actions` 는 아직 최근 50건 그대로).

Todo 항목: `{id, title, done, created_at, done_at|null, due|null, note|null}` (ms 타임스탬프).

## 수집 이력 (`src/history.ts`, `config.history`)

agenda 1단계가 소스 목록을 병합할 때마다(`mergeSources` → `historyUpsert`) 항목을 `~/.ned/history/<source>.json` 에 key 기준으로 upsert 한다
(Claude 호출 없음). key: slack `slackUrlKey(permalink)` · mail thread id · jira 이슈 키 · github PR url · calendar event id(없으면 `url|start`).
레코드 `{key, source, first_seen, last_seen, ts, state, item}` — `item` 은 가벼운 스냅샷(2단계 context·thread 제외), `state`:
slack `{reason, need(items 에 뽑힘), answered, acked, count, rank, rank_at}` · mail `{unread, needs_action, rank, rank_at}` ·
jira/github `{open}`(목록에서 빠지면 false, 다시 보이면 true) · calendar `{rsvp}`. 파일 하나에 소스 전체(JSON, mtime 캐시) — 수천 건에서
읽기·쓰기 수 ms. 하루 한 번(`meta.json` `last_prune_day`) `keep_days` 넘게 안 보인 레코드를 지우고(0 = 파일 삭제), `HISTORY_SOURCES` 파일만 만진다.
`history.enabled=false` 면 기록·prune 모두 안 한다.

**표시 원천 = 이력** (`slackView`, `mailView`, `finalizeSlackView` — `agenda.ts` `mergeSources`): 소스 키를 upsert 한 직후, 그 run 의
slack/mail 블록을 이력 + `history.display` 구간으로 다시 만들어 agenda.json 에 쓴다 → heartbeat·drafts·chat·server·search·agenda-context 는
수정 없이 긴 구간을 본다. Slack items = `need && !answered && !acked`(`openAsk`) — **기간 무관**: 답 안 한 요청은 표시 구간이 지나도
답함(내 답글·`mine`·2단계)·해제 이모지·✓ 확인 완료·보관 기간 prune 전까지 남는다(정렬: 마지막으로 뽑힌 run 의 순서 → 최신). all = 구간 안
멘션·DM·스레드·그룹 행(최신순, `agenda_all_limit`, 구간 안 items 포함 보장 — 구간 밖 열린 요청은 items 에만), DM collapse·dedupe·제외 채널은 기존 함수 재사용, watch = 팔로업 채널
이력 행(하이라이트 needs_me 먼저 5개 + 최신 3개, 증분 run 이 요약을 비우면 이전 요약 유지). context·threads 는 `carryContexts` 가 이전
agenda 에서 이어 붙이고, 그 다음 `finalizeSlackView` 가 ✓ 확인 완료(reviewed.json, 대시보드 `srcKey`/`srcRevAt` 과 같은 규칙 — 스레드면
마지막 답글·1단계 최신 ts 까지 본 표시만)를 items 에서 빼고 10개로 자른다. 메일 items = `needs_action` && 확인 완료 아님(최대 10), all = 구간 안 스레드(최신순, `unread`),
`unread` 수·summary 는 이번 run. 증분 run 의 빈 summary 는 열린 항목이 남아 있으면 이전 것을 유지. 서명(`sourceSignature`)은 이 뷰로 계산 —
새 것이 없는 증분 run 은 `unchanged: true` 라 heartbeat skip·2단계 skip 이 그대로 동작한다. 2단계 `mergeThreads` 는 읽은 스레드의 내 마지막 답·DM 의
내 메시지로 이력의 옛 항목을 답함 처리(`historyFromThreads`)하고 그 행을 바로 items 에서 뺀다(`applyAnswered`). Jira/GitHub/캘린더는 스냅샷 그대로.
`history.enabled=false`(또는 그 소스 `keep_days` 0)면 예전처럼 이번 목록 그대로. 구간 밖 열린 요청의 스레드·DM 도 계속 2단계 재확인 대상이다 —
`slack-threads.ts` `followed`: items 행(prio 0)이면 48시간 활동 필터(`THREAD_FOLLOW_HOURS`)와 무관, 읽은 뒤 새 메시지가 없으면 6시간마다 재확인.
prio 는 `finalizeSlackView`(✓ 제외·10건) 뒤의 items 로 다시 매긴다(`mergeSources` 가 sync 를 한 번 더) — ✓ 한 옛 요청은 재확인 대상에서 빠진다.
스레드 200·DM 50 상한에서는 prio 0 을 먼저 남긴다. `/api/history` 의 `current` 도 구간 안이거나 ✓ 안 한 열린 요청이면 true.

**이름·채널명 안정화**: Ned 는 `users.info` 를 따로 부르지 않고 1단계 검색 결과에서 모델이 `from`/`channel` 을 옮겨 적는다. 프롬프트 규칙 —
`from` = 표시 이름 → 실명 → 사용자명 → 사용자 ID(`U…`), Slack Connect 외부 사용자도 같게, "알 수 없음"·빈 값 금지 / `channel` = 결과의 채널
이름 그대로 `#` 붙여서. 데몬 쪽 — `upsertSlack`/`fillSlack` 은 새 `from` 이 비었거나 자리표시(`namelessFrom`)거나 사용자 ID(`U…`/`W…`)뿐이면 레코드의 기존 실명을 유지하고(`pickName`),
채널명은 permalink 의 채널 ID 기준으로 하나로 맞춘다(`slackChannelNames`): 그 ID 레코드들이 보인 이름(`item.channel_seen`, 원문) 중 가장 많은 것(동률은 최신)
— 그 이름이 팔로업·제외 채널 설정과 대소문자·`#` 만 다르거나 설정 이름이 과반이면 설정 표기, 처음 보는 ID 면 이번 응답. 한 번 잘못 쓴 제외 채널명으로 채널 전체가 숨지 않는다. upsert 때마다 모든 레코드의
`item.channel` 을 그 이름으로 쓰고, `slackView` 도 같은 이름으로 조립한다(이전 레코드는 `channel` 을 원문으로 간주). 채널 이름이 바뀌면 새 이름의
레코드가 많아지거나 옛 레코드가 보관 기간으로 지워질 때 넘어간다.

**증분 수집** (`collectWindow`, `listWindows`, `prompts/agenda-lists.md`): Slack·메일 1단계 호출은 `meta.json` 의 `collect.<src>.last_ok_at`
(마지막으로 병합에 성공한 run 의 기준 시각) − `OVERLAP_MINUTES`(30) 이후만 검색한다 — Slack `{{SLACK_SINCE}}` = `max(now−collect.slack_hours, last_ok−30m)`,
메일 items 검색 `{{MAIL_ITEMS_RANGE}}` = `after:YYYY/MM/DD`(Gmail 은 날짜를 태평양 자정으로 읽으므로 UTC−8 날짜 — `gmailAfter`).
이력 파일이 없거나(첫 실행) 성공 기록이 없거나 `last_full_at` 이 `FULL_RESCAN_HOURS`(6) 지났으면 전체 창(Slack `history.collect.slack_hours` 기본 24h(1~168, 표시 구간 이상 — 증분 하한이라 짧으면 꺼져 있던 공백이 빠짐, Slack 보관 기간 ≥ ceil(수집 창/24)일, `slackFullHours`) — 프롬프트 `{{SLACK_RANGE}}` "최근 N시간", 메일 3d), 그 소스가
기록되지 않으면(`history.enabled=false`·`keep_days.<src>=0`) 늘 전체 창 = 예전 프롬프트와 byte 동일. 메일 `is:unread newer_than:2d` 검색(안 읽음 수·`all`)은
늘 전체. 증분 프롬프트는 "새 것이 없으면 `items:[]`, `all:[]` 로 끝" 문구를 넣고, 빈 결과 20초 재시도(`emptyFor`)는 전체 창 호출에서만 한다.
출력에 `slack.mine`(검색 결과에 보인 내 메시지 permalink)·`mail.replied`(마지막 메시지가 나인 스레드 id)가 추가돼 증분 창 밖의 옛 항목을
답함 처리한다. 해제 이모지 검색 `{{ACK_SINCE}}` = `min(수집 창 시작, ACK_LOOKBACK_HOURS(7일) 안의 가장 오래된 열린 요청)`, 전체·증분 모두(이모지당 20건 상한이라 더
넓히지 않는다). 7일보다 오래된 열린 요청은 ✓ 확인 완료나 내 답글(`mine`·2단계)로만 해제된다. 열린 요청이 있으면 후보가 없어도 돈다(`{{ACK_OPEN}}`).
열린 요청 수·가장 오래된 시각은 `openSlack`(제외 채널·✓ 확인 완료 — `slackRecReviewed` — 기본 키, 스레드 새 답글 뒤면 다시 열림 — 뺌).
팔로업 채널은 증분일 때 이전 요약(`{{WATCH_PREV}}`)을 받아 새 메시지가 있을 때만 다시 쓴다. 전체 창 run 은 반환된 가장 오래된 행보다 새로운데
목록에 없는 열린 항목을 닫는다(검색 상한 20 으로 밀린 옛 행은 그대로). `ned prompt agenda` 는 지금 쓸 창 그대로 출력.
기준 시각(`noteCollected`)은 진짜 수집일 때만 옮긴다: 응답 JSON 에 그 소스 키가 없으면(`missingKeys` — 실패 취급, 이력에도 안 씀),
`historyUpsert` 가 그 소스 쓰기에 실패하면(그 run 은 뷰 재조립 없이 이번 목록 그대로), 증분 run 의 이번 답이 비었으면(Slack items·all 0, 메일 all 0)
그대로 둔다 — 재시작 직후 커넥터가 안 붙어 빈 답이 와도 그 구간이 다음 run 에 다시 검색된다. 빈 증분 답은 메일 안 읽음 표시도 바꾸지 않는다.
`acked_urls` 는 이번 결과 밖의 기존 레코드에도 적용, 이력 파일이 파싱 안 되면 `<src>.json.corrupt-<ts>` 로 옮기고 빈 이력(→ `collectWindow` first).
2단계가 답함 처리로 목록을 바꾸면 `sources_status.slack.signature` 를 그 자리에서 뷰 기준으로 다시 계산(완료된 `context_sigs.slack` 도 따라감).
`/api/history`·검색의 이력 결과는 `filters.slack.exclude_channels` 를 뺀다(`excludedSlack`). 증분 run 의 답에 행이 없으면 summary 는 이전 것을 유지.

**검색·아카이브 연동**: `GET /api/search` 는 이력 레코드도 후보로 넣는다(`historyCands`) — agenda.json 이 지금 보여 주는 key(`currentKeys`)는
빼서 같은 항목이 두 번 안 나오고, id 는 agenda 히트와 같은 체계(slack permalink · mail thread id · jira key · github `repo#n` · calendar id),
detail `이력 · M/D · …`, `tab: home` / `anchor: card:<slack|mail|jira|gh|cal>`(팔로업 전용 행은 `card:watch:<ch>`). 아카이브 데일리 리포트는
`archive.include.history`(기본 true)면 `<!-- ned:history -->` "## 📥 들어온 것" — 그날 `first_seen` 레코드를 소스별(최대 `INCOMING_MAX` 30줄 + "… 외 N건").

## Obsidian 아카이브 (`src/archive.ts`, `src/vault.ts`, `src/outputs.ts`)

`config.archive` (기본 꺼짐): `enabled`, `vault` (절대 경로, `~/` 펼침), `folder` (기본 `Ned`, `..`·점으로 시작하는 세그먼트 거부),
`daily_embed` (기본 false), `include.{briefings, updates, actions, outputs, sessions}` (sessions 만 기본 false). Claude 호출 없음.

- **볼트 검증** (`checkVault`): 절대 경로 · 있는 폴더 · `~/.ned` 나 Ned 레포의 안/상위가 아닐 것. `PUT /api/config` 가 vault 를 바꾸거나 처음 켤 때 검사해
  400 `{error, field: "archive.vault"}`. `.obsidian` 유무는 상태(`check.obsidian`)로만 — 없으면 경고, 쓰기는 함.
- **경로 안전** (`resolveInVault`): 모든 쓰기는 `<vault>/<rel>` 이 볼트 안으로 정규화되는지(`..`, 절대 경로, NUL), 가장 깊은 기존 조상의
  realpath 가 볼트 안인지(심링크 탈출), 대상 자체가 심링크가 아닌지 확인한다. 쓰기는 같은 폴더의 `.<이름>.ned-tmp-<pid>` → rename.
- **데일리 리포트** `<vault>/<folder>/Daily/YYYY-MM/YYYY-MM-DD.md`: 처음 만들 때 frontmatter(`created`, `tags: [ned, daily]`, `ned_version`)
  + 제목. 섹션 `briefing`·`patrol`·`sent`·`outputs`·`sessions`·`today` 를 `<!-- ned:<이름> -->` … `<!-- ned:/<이름> -->` 사이에만 쓴다.
  짝은 "닫는 마커가 뒤에 있는 마지막 여는 마커 ~ 그 뒤 첫 닫는 마커" — 고아 마커가 사용자 글을 끼고 짝이 되지 않는다. 짝이 없으면
  그 섹션은 파일 끝에 새 블록. 꺼진 섹션은 새로 넣지 않고, 이미 있으면 비운다. 생성 텍스트의 `<!--` 는 `<!-` 로 바꿔 마커 위조를 막는다.
  내용은 디스크에 있는 것으로 매번 다시 그린다: 브리핑(그날 마지막 daily), 순찰(heartbeat UPDATE 의 action/updates/fyi, url·제목 키로 하루 한 번),
  보낸 것(`sent-actions.log` 의 ok — dry_run·`transitions` 읽기 제외), 결과물(`~/.ned/outputs` 그날 것), 세션(그날 이벤트로 `reduceSessions`, 워커 제외),
  오늘(heartbeat 수·UPDATE 수, agenda 소스별 갱신 수, `costs.json`). 쓰는 사이 파일이 바뀌면(Obsidian 저장) 새 내용 위에 다시 합친다 — 최대 `REPORT_WRITE_ATTEMPTS`(4)번, 끝까지 안 멈추면 쓰지 않고 경고 로그 + 그날을 대기로 남겨 다음 틱에 재시도.
- **언제**: `archiveTouch(ts, {immediate})` — heartbeat 저장 직후(daily·UPDATE 는 즉시, NED_OK 는 표시만), `appendActionLog` 의 ok 항목(즉시),
  결과물 저장(즉시). `archiveTick` — `cli.ts` 의 1분 `setInterval`(스케줄러 tick 옆, `scheduler.ts` 는 안 건드림)에서 agenda
  `sources_status.<k>.updated_at` 이 새로 done 이면 그날 소스 갱신 수 +1, 그리고 "바뀐 날 && 마지막 쓰기 후 5분(`ARCHIVE_FLUSH_MS`)" 이면 씀.
  날짜는 변화의 ts 기준(23:59 에 시작한 순찰은 그날 파일). 지난 날은 대기 중인 변화가 있을 때만 쓰고 그 뒤로는 안 건드림.
- **embed** (`daily_embed`): `<vault>/.obsidian/daily-notes.json` 의 `folder` + `format`(moment 부분집합 YYYY·YY·MM·M·DD·D·[문자]; format 이 없으면
  `folder/DAY.md`, `folder/YYYY-MM/DAY.md`)으로 그날 노트를 찾아, **있을 때만** `## 📝 Notes & Logs` 줄 바로 아래에
  `<!-- ned:embed -->![[<folder>/Daily/YYYY-MM/DAY]]<!-- ned:/embed -->` 한 줄을 넣는다(이미 있으면 그대로, 제목 없으면 건너뜀).
- **정리 결과물** (`src/outputs.ts`): 채팅 턴이 성공하면 `extractOutputBlock` 이 답의 마지막 완전한 ```` ```ned-output ```` 펜스를 읽는다
  (JSON `{kind: meeting|document|mail|other, title, markdown ≤100,000자}`; kind 모르면 other, title 없으면 첫 제목 줄). `saveOutput` 이
  `~/.ned/outputs/<id>.json`·`.md` 를 항상 쓰고, `archive.enabled && include.outputs` 면 `<folder>/Notes/YYYY-MM/DAY.<slug>.md`
  (slug = 제목에서 `\/:*?"<>|#^[]`·제어 문자 뺀 것 ≤60자, 같은 이름이면 ` (2)`… — 덮어쓰지 않음; frontmatter date·kind·source(본문의 https 링크)·tags).
  메시지에 `output: {id, kind, title, vault_rel?, obsidian_url?, vault_error?}`(깨진 블록이면 `output_error`), `done` 이벤트에도 같이.
  프롬프트 규칙은 `prompts/chat.md` 7번. 저장 후 `archiveTouch(즉시)` → 그날 리포트 "정리 결과물"에 `[[…|제목]]`.
- **실패**: 볼트 없음·권한(EPERM/EACCES — macOS 파일 접근 안내 포함) 등은 로그 + `~/.ned/archive.json` 의 `last_error` → 설정 → 아카이브.
  그날은 대기로 남아 다음 틱에 다시 시도. 데몬은 계속 돈다. 대기 중인 날이 `DIRTY_MAX_DAYS`(7일)보다 오래되면 경고 로그를 남기고 버린다(`archive.json` 이 끝없이 쌓이지 않게).

## MCP 서버 (`src/mcp.ts`, `src/mcp-tools.ts`, `src/review.ts`)

같은 데몬이 MCP Streamable HTTP 엔드포인트 `/mcp` 를 연다. 플러그인 루트 `.mcp.json`(`{"mcpServers":{"ned":{"type":"http","url":"http://127.0.0.1:7777/mcp"}}}`)이
이걸 가리켜, 플러그인을 설치한 모든 Claude Code 세션에 `ned` 서버가 붙는다(도구 이름 `mcp__plugin_ned_ned__<도구>`).

- 트랜스포트: `@modelcontextprotocol/sdk` 의 `WebStandardStreamableHTTPServerTransport` — 웹 표준 Request/Response 라 hono 의 `c.req.raw` 를 그대로 넘긴다.
  `sessionIdGenerator: undefined`(stateless) + `enableJsonResponse: true`. 요청마다 `buildMcpServer()` 로 McpServer·트랜스포트를 새로 만들고 응답 뒤 닫는다
  (SDK 예제 `simpleStatelessStreamableHttp.ts` 와 같은 방식). `GET`/`DELETE /mcp` → 405 `Allow: POST`.
- 로컬 전용: `127.0.0.1` 바인딩에 더해 서버 전체 가드 `src/request-guard.ts`(`app.use("*")` — `/api/*`·`/mcp`·정적 파일 모두) — Host 가 loopback(127.0.0.1·localhost·[::1], 포트 무관)이 아니거나, Origin 이 있는데 `http(s)://` loopback 이 아니면 403
  (DNS rebinding 방지; SDK 의 `allowedOrigins`·`allowedHosts` 옵션은 deprecated 라 "외부 미들웨어" 권고대로 직접). Origin 없음(CLI 클라이언트)은 허용. 인증 없음.
- 도구: 순수 핸들러 `toolAttention`·`toolSessions`·`toolBriefing`·`toolHistory`·`toolFeed`(입력 + `ToolCtx` = config·state·agenda·reviewed·briefings·now) →
  `{summary, data, error?}`. `mcp.ts` 가 매 호출 `readToolCtx()` 로 디스크에서 새로 읽고, 결과를 텍스트 블록 두 개(요약 한 줄, JSON)로 싼다. `error` 면 `isError: true`.
  입력 스키마는 zod(raw shape) — 범위 밖 값은 SDK 가 isError 결과로 돌려준다. 읽기 도구는 `readOnlyHint: true`.
- `ned_attention`: `state.attention` + agenda 소스 항목(`mail.items`·`slack.items`·`jira`·`github`, `sources.*` 가 꺼진 소스 제외) + 응답 필요(`rsvp: needsAction`)·안 끝난 일정.
  같은 URL 은 attention 쪽 하나만. ✓ 키·열림은 `review-keys.ts`(`srcKey`·`activityMs`·`reviewedAt`) — 대시보드와 같은 규칙.
- `ned_mark_reviewed`: `reviewItem(id, reviewed)`(`src/review.ts`) — `POST /api/attention/:id/review` 와 같은 함수(400 잘못된 키 · 404 없는 attention · 200).
- 리소스: `ned://briefing/latest`, `ned://features`(`readFeaturesSummary`).
- 상한: `MAX_ATTENTION` 100 · `MAX_SESSIONS` 50 · `MAX_BRIEFINGS` 5(섹션당 15항목) · `MAX_HISTORY` 100 · `MAX_FEED` 50, 제목 200자·본문 300~400자 clip.
- 데몬이 꺼져 있으면 Claude Code 는 연결을 최대 3번 재시도한 뒤 서버를 실패로 표시한다(`/mcp`, `claude mcp list` 의 `✘ Failed to connect`) — 도구가 없을 뿐 세션은 그대로.
  403 을 받으면 Claude Code 는 서버를 "인증 필요" 로 표시하니, 그렇게 보이면 Host/Origin 거부(`app-daemon.log` 의 `request-guard: refused`)를 의심한다. `/ned:status` 의 MCP 줄도 403 을 따로 알린다.
- 확인: `curl -s -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' http://127.0.0.1:7777/mcp`
  (`/ned:status` 의 MCP 줄도 같은 요청). 테스트: `test/mcp-tools.test.ts`(핸들러), `test/mcp-server.test.ts`(빈 포트에 실제로 띄워 SDK Client 로 initialize → tools/list → tools/call, 403/405).

## Environment variables

| 변수 | 기본 | 설명 |
|---|---|---|
| `NED_HOME` | `~/.ned` | 데이터 루트. 테스트 시 `/tmp/ned-test` 같은 경로로 격리 |
| `NED_PORT` | (unset) | 설정 시 `config.yaml` 의 `port` 대신 이 포트로 listen (저장되지 않음). Ned.app 이 띄울 때 넘기고, 테스트 격리에 쓴다 |
| `NED_NO_LLM` | (unset) | `1` 이면 heartbeat 가 `claude -p` 를 호출하지 않고 `NED_OK` 를 기록하며, agenda 1단계는 `NED_NO_LLM_AGENDA` 파일(없으면 빈 목록), 2단계는 스텁 맥락을 쓴다 (비용 0, 테스트용) |
| `NED_NO_LLM_RESULT` | (unset) | `NED_NO_LLM=1` 일 때 heartbeat 가 받을 브리핑 JSON (예: `{"status":"UPDATE","headline":"…","action_items":[…]}`). UPDATE 경로 테스트용 |
| `NED_NO_LLM_AGENDA` | (unset) | `NED_NO_LLM=1` 일 때 agenda 1단계가 쓸 모델 출력 모양 JSON 파일 경로 (`{"slack":{…},"mail":{…},"calendar":[…],…}`). 소스별 호출은 자기 키만 가져간다 |
| `NED_NO_LLM_DELAY_MS` | (unset) | `NED_NO_LLM=1` 일 때 agenda 소스별 스텁 호출 지연 (우선순위 n번째 = n×값) 과 2단계 배치 지연, heartbeat 스텁 판단 단계 지연(1×값) — 순서·진행 상태 테스트용 |
| `NED_NO_LLM_COST` | (unset) | `NED_NO_LLM=1` 일 때 2단계 스텁 배치 하나의 비용(USD) — `costs.json` 에 기록되어 일일 예산 중단 경로를 테스트할 수 있다 |
| `NED_SEND_DRY_RUN` | (unset) | `1` 이면 `POST /api/send` 의 커넥터·gh 액션(Slack/Gmail/Jira/GitHub/Calendar)이 `claude` argv·프롬프트만 로그에 남기고 실행하지 않는다 |
| `NED_NOTIFY` | (unset) | Ned.app 이 데몬을 띄울 때 `app` 으로 설정한다. `config.notify: auto` 이면 이때 osascript 배너를 띄우지 않는다 (알림은 Ned.app 이 `state.json` 을 보고 직접 보낸다) |
| `NED_CHILD` | — | 데몬이 띄운 `claude -p` 자식에 `1` 로 설정됨 (훅이 자기 자신을 관찰하지 않도록 쓸 수 있음) |

`claude` 바이너리는 `PATH` 에서 찾는다. 보통은 Ned.app 이 데몬을 자식 프로세스로 띄우며 `node`/`claude` 위치를 로그인 셸에서 찾아 `PATH` 에 넣는다 (`apps/menubar/README.md`).

## `claude -p` 빠른 시작 (`config.claude_fast_startup`, 기본 켬)

커넥터를 쓰는 `claude -p` 는 사용자 훅(Stop 훅 하나가 ~10s)·플러그인 때문에 호출마다 ~18-20s 가 고정으로 붙었다. 이제
`isolated` 가 아닌 모든 호출에 `--settings $NED_HOME/claude-settings.json --disable-slash-commands` 를 붙인다 — 그 파일은
`{"disableAllHooks": true, "enabledPlugins": {<사용자가 켠 플러그인>: false}}` 이고 `src/claude.ts` 가 `~/.claude/settings*.json` 을
읽어 내용이 바뀔 때만 다시 쓴다 (`~/.claude` 는 쓰지 않음). 사용자 settings 의 model/effort 와 claude.ai 커넥터·Sentry 는 그대로.
측정: overhead(총 − API) 18.9s → 3.2s, 실제 캘린더 호출 26.1s → 13.5s — 표와 근거는 `docs/claude-startup.md`.

- 출력 형식은 `--output-format stream-json --verbose` (`result` 줄을 파싱). `allowedTools` 에 `mcp__claude_ai_*` 가 있는 호출이
  `system/init` 에서 claude.ai 서버를 하나도 못 보면 즉시 kill → 기존 argv 로 재실행하고, 그 데몬 프로세스는 이후 기존 argv 를 쓴다
  (로그 `fast start-up came up without claude.ai connectors`).
- 끄기: `config.yaml` 에 `claude_fast_startup: false` (다음 호출부터 적용). 호출별로는 `ClaudeRunOptions.fastStartup`.

## 알림 (`config.notify`)

| 값 | 동작 |
|---|---|
| `auto` (기본) | `NED_NOTIFY=app` (Ned.app 이 띄운 데몬)이면 데몬은 배너를 띄우지 않고 Ned.app 이 네이티브 알림을 보낸다. 그 외(단독 실행·개발)에는 osascript `display notification` 으로 fallback |
| `osascript` | 항상 osascript (배너가 "Script Editor" 로 표시됨) |
| `off` | 데몬은 배너를 띄우지 않는다 |

어느 경우든 데몬 로그에 `notify: …` 한 줄이 남는다. quiet hours 에는 데몬이 배너를 보내지 않는다.

## Data layout (`$NED_HOME`, 기본 `~/.ned`)

```
~/.ned/
  config.yaml            설정 (없으면 기본값으로 생성). heartbeat_minutes, signal_check_minutes, heartbeat_skip_unchanged(true),
                         briefing_time, quiet_hours, sources.{gmail,slack,jira,github,sentry,calendar},
                         persona (ned|alfred|oracle|jarvis), filters.{slack.exclude_channels, slack.watch_channels, slack.ack_reactions, slack.ack_check_max, slack.group_mentions, jira.exclude_projects} (트래킹 제외 / 팔로업 채널 / 답 필요 해제 이모지 / 한 run 에 검색할 이모지 수(3) / 집계할 유저그룹 ID·핸들(최대 8), ack_reactions·ack_check_max 외 기본 []),
                         port, claude_model, claude_max_turns, session_stale_minutes, agenda_refresh_minutes, notify,
                         actions.{slack_send=false, gmail_draft=true, gmail_send=false, session_send=true,
                                  jira_comment=false, jira_transition=false, github_review=false, calendar_rsvp=false} (POST /api/send 허용),
                         reply_tone (답장 초안 말투, 기본 "간결하고 정중한 존댓말, 핵심 먼저"), reply_tone_by_source ({slack,email,session}: 소스별 말투, null = reply_tone),
                         draft_context_max_age_minutes=180 (agenda 맥락 → fast 초안), draft_fast_model="sonnet", drafts_pregenerate=false,
                         agenda_all_limit=20 (mail/slack all[] 상한), agenda_context_batch=5 (2단계 배치 크기),
                         agenda_daily_budget_usd=15 (2단계 일일 예산), agenda_light_model="sonnet" (agenda 전 호출 모델, null = claude_model),
                         history.{enabled=true, display.{slack_hours=24, mail_days=3}, collect.{slack_hours=24}, keep_days.{slack=30, mail=30, jira=90, github=90, calendar=90}} (수집 이력)
                         pet.{enabled=false, messages.{greeting,session,slack,mail,jira,github,sentry,calendar,briefing}=true} (데스크톱 펫 — Ned.app 이 state.json `pet` 미러와 GET /api/feed 로 읽음; 설정 저장마다 state.json 에 비춤)
                         responsibilities=[] (맡긴 일 ≤5: {id, title≤60, goal≤300, sources?, keywords?≤10, until?, enabled} — 아래 "맡긴 일")
  state.json             menu bar / 대시보드가 읽는 단일 뷰 (sessions, attention, last_briefing, daily_failed_at, quiet, persona·notifications·pet 미러, responsibilities 평가 …)
  cursor.json            heartbeat 가 처리한 마지막 이벤트 ts
  onboarding.json        시작하기 창 닫음 {dismissed_at} (POST /api/setup/dismiss)
  events/YYYY-MM-DD.jsonl  훅(packages/hook/ned-hook.sh)이 append 하는 이벤트. 로컬 날짜 기준
  briefings/<iso-ts>.json  heartbeat / daily 브리핑 결과 (status, ok, action_items, updates, fyi, sessions, cost_usd, 실패 시 raw)
  briefings/sent.log     이미 알린 항목 키 (title 또는 url) — 중복 억제
  agenda.json            HOME 탭 agenda: {updated_at, cost_usd, error?, sources_status, context_status, context_sigs, calendar, jira, github, mail, slack}
  history/<source>.json  수집 이력 (src/history.ts, slack|mail|jira|github|calendar): {v:1, records:[{key, source, first_seen, last_seen, ts, state, item}]} — key 기준 upsert, compact JSON, temp→rename
  history/meta.json      {last_prune_day, collect:{slack|mail:{last_ok_at, last_full_at}}} — 하루 1회 prune 일자, 증분 수집 기준 시각
  agenda.raw.txt         마지막으로 빈/깨진 agenda 호출의 모델 원문 (디버깅)
  costs.json             claude -p 비용 원장: {days: {YYYY-MM-DD: {total_usd, runs, jobs: {agenda, agenda_context, heartbeat, draft, calendar, action}}}} (30일)
  drafts/<id>.json       답장 초안 캐시 (1시간): {id, source, mode, context_age_minutes, context, drafts, cost_usd, created_at, hint, tone, meta}
  drafts/_pregenerate.json  마지막 미리 생성 실행 결과 (GET /api/draft/status)
  sent-actions.log       POST /api/send 시도 기록 JSONL (거절·실패 포함)
  archive.json           Obsidian 아카이브 상태: {dirty: {day: ms}, written: {day: ms}, src_seen, src_counts: {day: {source: n}}, last_write_at, last_write_path, last_error, last_error_at, last_embed} (14일)
  outputs/<id>.{json,md} 정리 결과물 (대화창 ```ned-output) — 아카이브가 꺼져 있어도 항상 저장
  chat-sessions.json     대화창에서 만든 세션: [{job_id, created_at, repo, mode, name, model, worktree_path, worktree_id, handle, ok, stage}] (14일)
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

## Testing (vitest)

```sh
pnpm test                          # 루트: @ned/daemon 의 vitest 실행 (= pnpm --filter @ned/daemon test)
pnpm --filter @ned/daemon test:watch
```

- 위치: `test/*.test.ts`, 설정 `test/vitest.config.ts`, 공통 준비 `test/setup.ts`.
- 격리: `setup.ts` 가 **테스트 파일마다** 새 임시 `NED_HOME`(`$TMPDIR/ned-test-*`, 끝나면 삭제)을 만들고 `NED_NO_LLM=1`,
  `NED_SEND_DRY_RUN=1`, `NED_NOTIFY=app`(osascript 배너 없음), `NED_PORT=7791` 을 건다. `paths.ts` 가 import 시점에 `NED_HOME` 을
  읽으므로 파일 단위 격리(`isolate: true`, forks)가 필요하다. `claude` 는 절대 spawn 되지 않고 `~/.ned` 는 건드리지 않는다.
- **실제 `~/.ned` 보호(워커·개발 검증 공통)**: `VITEST`·`NODE_ENV=test`·`NED_NO_LLM=1` 중 하나라도 켜진 실행에서 `NED_HOME` 이 비어 있거나
  `~/.ned` 로 해석되면 `paths.ts` 가 import 즉시 throw 한다("refusing to use the real ~/.ned in a test/stub run"). vitest 는 항상
  `pnpm test`(또는 `--config test/vitest.config.ts`; `packages/daemon/vitest.config.ts` 가 같은 설정을 다시 내보내 맨 `vitest run` 도
  setup 을 탄다)로, 데몬 스모크는 `NED_HOME=$(mktemp -d) NED_PORT=779x NED_NO_LLM=1` 로 — 시작 전에 `echo $NED_HOME` 확인.
- HTTP 라우트(`test/server.test.ts`): `@hono/node-server` 의 `serve` 를 `vi.mock` 으로 바꿔 `startServer` 가 넘기는 Hono `fetch` 를
  받아 `Request` 를 직접 넣는다 — 포트를 열지 않는다.
- 다루는 것: sessions 상태 머신 · events(parseLines, lastAssistantText) · claude(extractJson, argv) · notify · config(loadConfig 병합,
  정규화, quiet hours) · agenda normalize*(calendar/mail/slack context, all⊇items, isEmptyPayload, signature) · heartbeat(sent 키
  dedupe, NED_NO_LLM 종단) · todos CRUD · search 점수 · drafts fast/full 결정 · `/api/send` 게이팅(403) 외 라우트.
- 알려진 버그는 `test/BUGS.md` 에 적고 `it.fails` 로 고정한다(버그가 고쳐지면 빨개진다 → `it` 으로 바꾼다).
- 순수 함수를 테스트하려고 `export` 만 붙인 것: `events.parseLines`, `agenda.normalize`, `heartbeat.sentKeys/markSent/keyOf`.

## Smoke test (LLM 호출 없이)

```sh
export NED_HOME=$(mktemp -d) NED_PORT=7797 NED_NO_LLM=1   # never ~/.ned or 7777 — paths.ts refuses ~/.ned with NED_NO_LLM=1
echo '{"hook_event_name":"Notification","session_id":"s1","cwd":"/x/wt","message":"needs permission"}' \
  | sh ../hook/ned-hook.sh                       # prints {} and appends to $NED_HOME/events/<today>.jsonl
node dist/cli.js state                            # sessions[0].status == "waiting"
node dist/cli.js run &  curl 127.0.0.1:$NED_PORT/api/state;  kill %1
```
