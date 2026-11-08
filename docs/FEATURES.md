# Ned 기능 가이드

> 코드 기준 사용자 가이드. 맨 위 "요약"(≤2,500자)은 Ned 대화창(Ned Net) 시스템 프롬프트에 그대로 들어간다(`packages/daemon/src/chat.ts`).
> 기능을 추가/변경하면 아래 해당 항목과 **요약을 같이** 고친다. 설정 키는 `~/.ned/config.yaml` 기준 점 표기.

## 요약

Ned = 에이전트 세션·업무 신호(Slack·메일·캘린더·Jira·GitHub·Sentry)를 모아 보여 주는 로컬 대시보드(탭: 홈·인박스·타임라인·설정). 전역 키: h 홈, i 인박스, r 지금 점검, ⌘K·/ 검색, ⌘J 통신기.
- **홈**: 일정(일/주, ＋·드래그로 일정 만들기, ⋯ 수락/미정/거절), 할 일(NED 액션 아이템 / 개인 할 일 — 구분선·접기, n 입력), 소스 카드(메일·Jira·Slack·GitHub — `확인 필요 | 전체`, 이력 7/30일, ↻ 소스별 갱신), 팔로업 채널 카드(멘션 없어도 따라가는 Slack 채널 요약, "나한테" 강조).
- **인박스**: 우선(attention)·기타(업데이트/참고)·기록(브리핑) 3탭 + "장비실"(세션 상태, 대화창 출처 배지). 키 j/k·e·⏎·1/2/3.
- **타임라인**: 세션 이벤트와 브리핑을 시간순으로(유형·워크트리 필터).
- **순찰/브리핑**: "지금 점검"(r) = 소스를 새로 가져와 판단 → 알림·attention. 자동 순찰은 `heartbeat_minutes`(무변경이면 건너뜀 `heartbeat_skip_unchanged`), 아침 브리핑은 `briefing_time` — 실패하면 10분 뒤 재시도(최대 3회).
- **야간·유휴 감속**: 조용한 시간·유휴(`idle_schedule`)엔 자동 순찰·홈 갱신을 늦추거나 멈춤(`quiet_schedule.mode` normal/slow/pause). 홈 상단 칩. 수동 실행은 늘 즉시.
- **통신기 "Ned Net"**(⌘J): "대화" 탭 = 질문(읽기 전용; `actions.chat_write` 면 쓰기를 확인 카드로 제안, 텍스트만 고쳐 실행; `actions.chat_session_create` 면 새 세션도; 회의·문서·메일 정리는 노트로 저장), "메시지" 탭 = 새 알림·브리핑·새 Slack 답글 피드.
- **답장 초안 ✎**: 연필 → 초안 3개 → 복사/열기/보내기. 실제 쓰기는 설정 → 쓰기 액션에서 켠 것만: `actions.slack_send`·`gmail_draft`(기본 켬)·`gmail_send`·`session_send`(기본 켬)·`jira_comment`·`jira_transition`·`github_review`·`calendar_rsvp`·`calendar_create`. Jira·GitHub·캘린더는 ⋯ 메뉴.
- **확인 완료 ✓**: 항목을 처리됨으로 접음(바뀌면 다시 열림). Slack 은 내 답글·해제 이모지(`filters.slack.ack_reactions`, 앞 `ack_check_max`개만 검색)면 자동 해제.
- **Gmail 읽음 표시**(`actions.gmail_mark_read`, 기본 꺼짐): 메일 ✓ 때 Gmail 도 읽음.
- **검색 ⌘K**: 전체 통합 검색(초성, 수집 이력 포함).
- **아카이브(Obsidian)**: 설정 → 아카이브에 볼트 `archive.vault` + 켜기 `archive.enabled` → 매일 `<archive.folder>/Daily/YYYY-MM/날짜.md` 에 브리핑·순찰·보낸 것·결과물·들어온 것·통계 자동 기록(Claude 호출 없음, 마커 밖 메모 보존). `archive.daily_embed` = 내 데일리 노트에 embed 한 줄.
- **수집 이력**: 가져온 항목을 소스별로 보관(`history.keep_days.*`). 수집은 새 것만(증분), Slack·메일 카드·순찰·초안은 이력에서 표시 구간(`history.display.*`, 24시간·3일)만큼.
- **설정**(바꾼 뒤 하단 "저장"): 외형(테마 `dashboard.theme` 시스템/라이트/다크, 카드 배치·잠금 `dashboard.locked`, 팔로업 별도 카드 `dashboard.watch_cards`) · 소스(`sources.*`, Slack 팔로업·제외 채널·해제 이모지·그룹 멘션 `filters.slack.*`, Jira 제외 `filters.jira.exclude_projects`) · 알림(`notifications.*`, 조용한 시간 `quiet_hours`) · 순찰 주기(`heartbeat_minutes`, `signal_check_minutes`, `briefing_time`, `agenda_refresh_minutes`, `agenda_source_minutes.*`, `quiet_schedule.*`, `idle_schedule.*`) · 쓰기 액션(`actions.*`, 기본 말투 `reply_tone`, 소스별 답장 말투 `reply_tone_by_source.*`, 오늘 한 액션 로그) · 수집·보관(`history.*`) · 아카이브(`archive.*`) · Claude(모델 `claude_model`, 최대 턴 `claude_max_turns`, 하루 상한 `agenda_daily_budget_usd` $15 — 닿으면 자동 실행·대화 멈춤). 저장마다 백업 10개 → "이전 설정으로 되돌리기".

## 상세

각 항목: **보여 주는 것 / 데이터 / 언제 / 버튼·단축키·설정 키**.

### 공통 — 헤더·탭·갱신
- 보여 주는 것: 탭 홈·인박스·타임라인·설정, 데몬 생존·마지막/다음 점검·조용한 시간 배지, "지금 점검"·"아침 브리핑" 버튼, "🔍 검색 ⌘K".
- 데이터: `GET /api/state`(10초 폴링), agenda·할 일 60초 폴링(갱신 중엔 3초).
- 언제: 대시보드 첫 화면. 상태 이상(데몬 꺼짐 등)을 헤더에서 먼저 확인.
- 키: h 홈 · i 인박스 · r 지금 점검 · ⌘K 또는 / 검색 · ⌘J 통신기 (입력 중엔 무시).

### 홈 — 일정 카드
- 보여 주는 것: 오늘/주간 타임라인(지금 선, 종일 일정, 겹침 나란히), "회의 N · 종일 N", RSVP 칩(응답 필요/미정/거절/주최), "진행 중"·"N분 후", 장소·Meet 링크.
- 데이터: agenda.json `calendar`(어제~+13일). 그 밖의 날짜는 `GET /api/calendar` → `~/.ned/calendar/` 캐시(6시간).
- 언제: 오늘 회의 흐름·응답 안 한 초대 확인, 빈 시간에 일정 잡기.
- 버튼·키: 일/주, ◀ 오늘 ▶ (카드 포커스 시 ←/→, t 오늘, d/w 일/주). ⋯ → 수락/미정/거절(`actions.calendar_rsvp`, 주최 일정엔 없음). "이력" = 지난 7일/30일 동안 본 일정 목록(아래 "수집 이력").

### 홈 — 일정 만들기
- 보여 주는 것: "새 일정" 모달 — 제목·날짜·시작/끝·종일·장소·설명·참석자 이메일·"Google Meet 링크 추가"·캘린더(기본 primary).
- 데이터: Google Calendar 커넥터로 생성(`src/calendar-create.ts`), 결과는 `~/.ned/sent-actions.log`.
- 언제: 대시보드에서 바로 일정을 잡고 싶을 때.
- 버튼·키: 일정 카드 헤더 ＋, 주간 그리드 드래그(15분 단위), 빈 칸 클릭. "만들기 ⌘⏎" → 확인 → 생성, Esc 취소. 설정 키 `actions.calendar_create`(기본 꺼짐).

### 홈 — 할 일 카드
- 보여 주는 것: "NED 액션 아이템"(Ned 가 뽑은 확인 필요 항목, 확인 완료는 "확인 완료 N" 접힘) + "개인 할 일"(마감일, 완료는 "완료 N" 접힘). 소스 pill 필터.
- 데이터: `state.json` attention, `~/.ned/todos.json`(완료 7일 뒤 정리).
- 언제: 오늘 처리할 것 한 곳에서 보기, 내 메모성 할 일 관리.
- 버튼·키: n 입력 포커스, "할 일 추가… (⏎)", 체크=완료, ✕=삭제.
- 레이아웃: 위 = 확인 필요 그룹(스크롤), 아래 = 개인 할 일(입력폼 고정, 목록 스크롤, 최소 ≈180px — 항목이 적으면 내용만큼). 기본 60/40, 개인 할 일이 짧으면 남는 높이는 위로. 사이 구분선 드래그(↑↓ 키도)로 비율 조절·브라우저에 저장(`ned.todo.split`), 더블클릭 = 기본값. "개인 할 일" 헤더 클릭 = 접기/펼치기(`ned.todo.meFold`, 접히면 위가 전부; n·검색 이동 시 자동 펼침). 좁은 화면(<1100px, 자유 배치 아님)은 구분선 없이 자연 높이.

### 홈 — 소스 카드 (메일·Jira·Slack·GitHub)
- 보여 주는 것: 📬 메일 확인 필요(결재/마감/답장/확인, 안 읽은 N) · 📋 Jira 내 이슈(마감 지난/오늘/진행 중) · 💬 Slack 답할 것(DM/멘션/스레드/그룹, 답 필요/답함/새 답글) · 🐙 GitHub 리뷰 요청(리뷰 요청/변경 요청/승인됨). 접힘/펼침, 메일·Slack 은 `확인 필요 | 전체`(전체 = 표시 구간 — 메일 `history.display.mail_days`·Slack `history.display.slack_hours` — 의 스레드·멘션·DM).
- 데이터: agenda.json — 소스별 `claude -p`(커넥터 읽기) 또는 GitHub 는 `gh search prs`. 소스별 주기마다 자동, 답장 맥락은 백그라운드 수집("맥락 수집 N/M"). Slack 스레드·DM 의 최근 대화는 갱신마다 다시 읽되, 마지막으로 읽은 뒤 새 메시지가 안 보이면 건너뜀(6시간마다 한 번은 재확인).
- 언제: 답할 메시지·리뷰·마감 이슈를 소스별로 훑을 때.
- 버튼·설정: 카드 ↻(그 소스만 지금 갱신), ⚠ 오류 배지, 항목 ✎ 초안·열기·✓ 확인. **이력 `표시 구간 | 지난 7일 | 30일`**(메일·Slack 은 전체 보기 위, Jira·GitHub 은 목록 아래): 표시 구간 밖까지 Ned 가 모은 항목을 날짜 구분선과 함께 최신순(최대 200, 지금 카드에 있는 건 "지금", 상태 칩 답함/답 필요/안 읽음/목록에서 빠짐), 카드별 기억(`ned.cardhist.<카드>`). `sources.*`, `agenda_source_minutes.*`, `dashboard.card_order`/`card_span`, `agenda_all_limit`.

### 홈 — 팔로업 채널 카드
- 보여 주는 것: 멘션이 없어도 따라가는 Slack 채널마다 24시간 요약 + 하이라이트. 나를 향한 것은 "나한테" 칩으로 앞에, 할 일 카드 개수에도 포함. 없으면 "지난 24시간 눈에 띄는 대화 없음."
- 데이터: agenda.json `slack.watch`(수집 이력에서 표시 구간만큼 — 하이라이트·최근 메시지, 새 메시지가 없으면 이전 요약 유지). 펼친 카드 아래 이력 `지난 7일 | 30일` = 그 채널에서 모은 메시지(`/api/history?channel=`).
- 언제: 내가 태그되진 않지만 결정·공지를 놓치면 안 되는 채널.
- 설정: 설정 → 소스 → Slack → "팔로업 채널"(`filters.slack.watch_channels`, 최대 20). 별도 카드 대신 Slack 카드 안 "채널 팔로업 N" 으로 접으려면 설정 → 외형 → "팔로업 채널을 별도 카드로" 끄기(`dashboard.watch_cards`).

### 홈 — 배치
- 보여 주는 것: 일정·카드·할 일 패널의 자유 배치(12열 그리드).
- 언제: 화면 구성을 바꾸고 싶을 때.
- 버튼·키: 패널 헤더 ⠿ 드래그·가장자리 크기 조절, 그립에서 화살표 이동·Shift+화살표 크기·⏎ 저장·Esc 취소. 잠금 버튼 / 설정 → 외형 "홈 배치 잠금"(`dashboard.locked`), "배치 초기화".

### 외형 — 테마
- 보여 주는 것: 대시보드 색 테마 🖥️시스템(macOS 라이트/다크를 따라감) / ☀️라이트 / 🌙다크.
- 데이터: config.yaml `dashboard.theme`(기본 system). 고르면 바로 미리보기, "저장" 해야 유지.
- 언제: 대시보드만 OS 와 다른 밝기로 쓰고 싶을 때.
- 설정: 설정 → 외형 → 테마 → `dashboard.theme`(system|light|dark).

### 인박스
- 보여 주는 것: "우선"(확인 필요 attention) · "기타"(브리핑의 업데이트/참고) · "기록"(브리핑 목록, 연속 NED_OK 는 "이상 무" 로 묶음). 상세: 행동 필요/업데이트/참고/세션/메타.
- 데이터: `state.json` attention, `~/.ned/briefings/`.
- 언제: Ned 가 판단한 "지금 봐야 할 것" 을 하나씩 처리할 때.
- 키·버튼: j/k(↓/↑) 이동, ⏎ 열기, e 닫기(처리 완료로 치우기), 1/2/3 탭, Esc 상세 닫기. ✎ 초안, ✓ 확인 완료, "← 목록".

### 에이전트 세션 — 장비실
- 보여 주는 것: 인박스 오른쪽 "장비실 · 세션" 패널 — 세션별 LED 상태(실행 중/입력 대기/완료/오류/종료), 워크트리, 서브에이전트 수, 마지막 요약, Ned 대화창에서 만든 세션이면 "대화창에서 시작" 배지(상세의 "출처"도) + "순찰 기록"(최근 8회). 없으면 "출동 중인 에이전트 없음."
- 데이터: Claude Code 훅 이벤트(`~/.ned/events/`) → `state.json` sessions. `session_stale_minutes`(기본 180) 동안 이벤트 없으면 사라짐.
- 언제: 여러 Claude 세션 중 입력을 기다리는 것·오류 난 것을 찾을 때.
- 버튼·설정: 세션 항목 ✎ 초안 → "세션에 보내기"(Orca 터미널로 전송, `actions.session_send` 기본 켬), "접기".

### 대화창에서 세션 만들기
- 보여 주는 것: Ned Net "대화" 에서 일을 맡기면 Ned 가 ned-action `session_create` 로 새 에이전트 세션을 제안 → 확인 카드(대상 줄에 레포 · 워크트리 새로/기존 · 모델 opus/sonnet — 읽기 전용, 첫 프롬프트 **전문**만 편집 가능) → [실행] / [취소]. 실행 중엔 단계(워크트리 만드는 중 → 에이전트 기동 대기 → 첫 프롬프트 전송 → 제출 확인)와 경과 초, 실패하면 단계별 사유. 워크트리·터미널이 이미 생긴 뒤의 실패는 "다시 실행" 없이 끝냄(중복 생성 방지). 카드를 미리 볼 때 등록 레포·기존 워크트리·상한도 검사해 실행 전에 거절 사유를 보여 줌.
- 데이터: `POST /api/sessions/create`(백그라운드 작업, 202 + 폴링) → 새 워크트리면 `orca worktree create --agent claude --model <m>`, 기존이면 `orca agent launch` → Claude 가 뜰 때까지 화면 확인(최대 90초) → `orca terminal send --enter --wait-submit 15` 로 첫 프롬프트 → 입력창이 비고 첫 활동이 보이면 성공. 첫 프롬프트는 항상 "먼저 계획을 제시하고 승인받은 뒤 구현한다." 로 시작(없으면 Ned 가 붙임). 레포는 Orca 에 등록된 것만. 대화창에서 시작해 아직 살아 있는 세션은 **2개까지**(넘으면 거절 사유 표시). 만든 세션은 `~/.ned/chat-sessions.json` 에 기록 → 장비실 "대화창에서 시작" 배지. 모든 시도는 `~/.ned/sent-actions.log`(action `session_create`, origin chat — "오늘 한 액션" 에 "대화창 ·" 표시).
- 언제: 대화하다 "이거 세션 하나 띄워서 해줘" 할 때 — 터미널을 열지 않고 Ned 에서 바로 시작.
- 설정: 설정 → 쓰기 액션 → 세션 → "대화창에서 세션 만들기" `actions.chat_session_create`(기본 꺼짐) **그리고** 대화창 → "대화창에서 쓰기 허용" `actions.chat_write`. 둘 다 켜져 있어야 대화 프롬프트에 이 제안이 들어가고(Orca 등록 레포 목록 포함, 10분 캐시) 실행도 됨.

### 타임라인
- 보여 주는 것: 세션 이벤트(세션 시작/종료, 프롬프트, 서브에이전트 시작/종료, 알림, 응답 완료, 오류, 컨텍스트 압축)와 📝 브리핑(아침/점검)을 최신순(최대 300).
- 데이터: `GET /api/events?days=2` + 브리핑.
- 언제: 어떤 세션에서 언제 무엇이 일어났는지 되짚을 때.
- 버튼: "유형"·"워크트리" 칩 필터(전체), "새로 고침".

### 순찰·브리핑 (지금 점검)
- 보여 주는 것: Ned 의 판단 결과 — 알림 배너, 확인 필요(attention), 인박스 기록의 브리핑(NED_OK = 이상 무 / UPDATE).
- 데이터: 자동 순찰은 `heartbeat_minutes`(기본 10)마다, 신호 판단은 `signal_check_minutes`(기본 60)가 지났거나 세션 이벤트가 있을 때만 LLM 호출. agenda.json 재사용 + Sentry 직접 조회. 아침 브리핑은 `briefing_time`(기본 09:00) 뒤 첫 순찰, 하루 1회.
- 아침 브리핑 재시도: 자동 아침 브리핑은 **성공했을 때만** 그날 완료로 친다(Claude 실패·답 해석 실패는 브리핑 파일에 `ok: false` + raw 로 남고 인박스·타임라인·검색에 "아침 실패"로 표시, 아카이브 🌅·대화 맥락엔 안 들어감). 실패하면 10분 뒤 다시(최대 3회 = 총 4번), 다 실패하면 그날은 포기하고 `state.json` 에 `daily_failed_at` → 홈 한 줄 "오늘 아침 브리핑 실패 — '아침 브리핑'이나 '지금 점검'으로 다시"(성공한 아침 브리핑이 지움). 데몬을 다시 켜면 오늘 **성공한** 아침 브리핑 파일이 있을 때만 건너뛰고, 재시도 횟수는 0부터. 설정 키 없음.
- 오프라인·잠 깬 직후: 자동 실행(소스 갱신·순찰·아침 브리핑)은 Claude 를 띄우기 전에 `api.anthropic.com` DNS 조회(3초, 결과 30초 캐시)로 온라인인지 보고, 오프라인이면 그 틱을 통째로 건너뜀(로그 `offline — …`, 비용·소스 오류 없음, 재시도 횟수도 안 씀). 앞 틱과 3분 이상 벌어진 틱(맥이 잠들었다 깸)은 아무것도 안 돌리고 다음 틱에(로그 `wake: …`). 수동 실행(지금 점검·아침 브리핑·카드 ↻)은 확인 없이 늘 즉시.
- 무변경 건너뛰기(`heartbeat_skip_unchanged`, 기본 켬): 지난번 판단한 순찰 뒤로 소스 목록(서명)·2시간 안 일정·팔로우 스레드의 새 답글·세션 알림(응답 완료/오류/입력 대기)이 하나도 안 바뀌었으면 자동 순찰은 Claude 를 부르지 않고 다음 주기로 넘김(로그 `heartbeat: skipped — unchanged`). Sentry 가 켜져 있으면 3시간마다 한 번은 실제로 돔. 아침 브리핑·지금 점검·`/api/heartbeat` 는 늘 실행.
- 언제: 방금 들어온 것까지 반영해 판단받고 싶을 때 "지금 점검".
- 버튼·키·설정: 헤더 "지금 점검"(r, 데이터 갱신 중 → 판단 중, 1~2분), "아침 브리핑". 설정 → 순찰 주기. 하루 상한(`agenda_daily_budget_usd`) 도달 시 자동 실행만 멈춤.

### 수집 이력 · 수집/표시 구간
- 보여 주는 것: 데몬이 소스 목록을 가져올 때마다 항목을 `~/.ned/history/<소스>.json` 에 key 기준으로 기록(같은 항목은 갱신) — Slack(permalink)·메일(스레드 id)·Jira(이슈 키)·GitHub(PR url)·캘린더(이벤트 id). 항목마다 처음 본 때·마지막 본 때와 상태(Slack 답함·해제 이모지·답 필요, 메일 안 읽음·행동 필요, Jira/GitHub 목록에 있음 `open` — 빠지면 false·다시 보이면 true, 캘린더 RSVP).
- 데이터: Claude 호출 없음 — 데몬이 씀(임시 파일 → rename). 하루 한 번 보관 기간이 지난 항목을 지움(마지막 정리 일자 `~/.ned/history/meta.json`), 그 폴더의 Ned 파일만.
- 표시 구간: Slack·메일 카드, 순찰 프롬프트, 초안·대화 맥락이 보는 `agenda.json` 의 slack/mail 블록은 이번 목록이 아니라 **이력에서 표시 구간만큼 다시 조립**(Slack `history.display.slack_hours` 기본 24시간, 메일 `history.display.mail_days` 기본 3일). 확인 필요 = 구간 안·답 안 함·해제 이모지 아님·✓ 확인 완료 아님(최대 10, 목록이 매긴 급한 순), 전체 = 구간 안 전부(`agenda_all_limit`). DM 은 대화당 한 줄, 제외 채널은 뺌. 새 것이 없는 수집 뒤에도 카드는 그대로이고 "변화 없음"(무변경 순찰 건너뛰기·2단계 건너뛰기)은 이 조립 결과로 판단. 스레드·DM 을 2단계가 다시 읽다 내 답을 보면 바로 답함 처리. Jira·GitHub·캘린더 카드는 지금처럼 마지막 목록(이력엔 기록만).
- 수집 구간(증분): Slack·메일 목록은 매번 전체 창을 다시 읽지 않고 **지난 성공 수집 − 30분 이후**만 검색(Slack `after`, 메일 두 번째 검색 `after:날짜`). 첫 실행·이력 파일이 없을 때·마지막 전체 검색이 6시간 넘었을 때는 전체 창(Slack 24시간, 메일 3일). 새 것이 없으면 모델은 빈 목록만 내고 끝(빈 결과 재시도도 안 함). 메일 안 읽음 수는 늘 최근 2일 전체. 증분 결과에 보인 **내 메시지**(`mine`)·내가 마지막으로 보낸 메일 스레드(`replied`)로 이전 항목을 답함 처리, 해제 이모지 검색은 기억하는 열린 항목까지 거슬러 봄. 설정 키 없음(상수).
- API: `GET /api/history?source=slack|mail|jira|github|calendar&days=7&q=&channel=`(최신순 최대 200, 표시 구간 안·열린 항목은 `current: true`) · `GET /api/history/status`(소스별 건수·일수·바이트, 마지막 수집·전체 재검색 시각, 다음 수집 창, 마지막 정리).
- 설정: 설정 → 수집·보관 — `history.enabled`(기본 켬 — 끄면 기록 안 함, 예전처럼 마지막 목록만) · 보관 기간 `history.keep_days.slack`·`history.keep_days.mail`(30)·`history.keep_days.jira`·`history.keep_days.github`·`history.keep_days.calendar`(90), 0~365일, 0 = 그 소스 기록 안 함. 표시 구간 `history.display.slack_hours`(24, 1~168)·`history.display.mail_days`(3, 1~14) — 보관이 표시보다 짧으면 표시에 맞춰 늘림.

### 야간 모드 · 유휴 모드 (자동 작업 감속)
- 보여 주는 것: 조용한 시간이나 유휴 상태에서 자동 순찰·홈 소스 갱신(과 그 뒤 답장 맥락 수집)을 느리게(모든 주기 × 배수) 하거나 멈춤. 홈 상단 칩 "야간 모드 · 느리게 ×6 · 08:00 재개" / "유휴 모드 · 멈춤 · 활동 시 재개"(둘 다면 유휴 표시). 감속이 없으면 칩 없음.
- 데이터: 데몬 스케줄러(`src/scheduler.ts`, 1분 틱). 유휴 = (1) `idle_schedule.after_minutes` 동안 활동 없음(대시보드 사용 핑 `POST /api/activity`, Claude Code 세션 이벤트, Mac 키보드/마우스 입력 중 최신) **그리고** (2) 최근 `unchanged_runs` 번의 자동 갱신이 모두 변화 없음. 둘이 겹치면 더 느린 쪽(멈춤 > 큰 배수). 조용한 시간/유휴가 끝나면 전 소스를 한 번에 갱신한 뒤 순찰 1회(아침 브리핑이 새 목록을 읽도록).
- 언제: 밤·자리 비움 동안 Claude 비용과 호출을 줄이고 싶을 때. 수동 실행(지금 점검·아침 브리핑·카드 ↻)은 영향 없이 늘 즉시.
- 설정: 설정 → 순찰 주기 → "조용한 시간 동작": 평소대로/느리게 ×N/멈춤 → `quiet_schedule.mode`(normal|slow|pause, 기본 slow), `quiet_schedule.slow_factor`(2~24, 기본 6). 시간대는 설정 → 알림 → 조용한 시간(`quiet_hours`, 꺼져 있으면 이 칸은 흐려짐). "유휴 시 동작": 사용 `idle_schedule.enabled`(기본 켬) · N분 활동 없고 `idle_schedule.after_minutes`(10~1440, 120) · N회 연속 변화 없으면 `idle_schedule.unchanged_runs`(1~50, 6) · 느리게 ×N/멈춤 `idle_schedule.mode`(slow|pause, 기본 slow) · `idle_schedule.slow_factor`(2~24, 6).

### 통신기 — Ned Net
- 보여 주는 것: 모든 탭에 떠 있는 패널, 제목 "Ned Net"(태그 NED · NET; 페르소나를 바꾸면 이름도 바뀜). "대화" 탭 = Ned 에게 질문(Ned 가 아는 맥락 + 읽기 도구로 답, 쓰기 안 함), "메시지" 탭 = 열린 attention·최근 24h 업데이트 브리핑·"내 답 이후 새 답글 N건" Slack 스레드·닫혀 있던 동안 온 답(안 읽음 배지).
- 데이터: 대화 = 턴마다 `claude -p`(읽기 전용, 최대 12턴, 질문 2,000자), `~/.ned/chats/`(최근 20개). 비용은 "대화 $x · 오늘 $y".
- 언제: "오늘 뭐 남았어?", "이 PR 상태는?", "이 기능 어떻게 켜?" 같은 질문.
- 코드 블록: 답의 ``` 블록마다 우상단 복사 버튼(키보드 Enter/Space 가능) — 언어 표기 줄 빼고 원문만 복사, 1.5초 ✓.
- 키·버튼·설정: ⌘J(Ctrl+J) 열고 닫기, Esc 닫기, ⏎ 전송, ⇧⏎ 줄바꿈, "중단", "새 대화", ▾ 접기, 가장자리 크기 조절. 하루 상한 도달 시 대화도 막힘 — 예외는 config.yaml `chat_ignore_budget: true`.

### 통신기 — 대화창에서 쓰기 (확인 카드)
- 보여 주는 것: "Slack 에 이렇게 답해 줘", "이거 할 일에 넣어 줘" 같은 요청에 Ned 가 답 끝에 **실행 제안 카드**를 붙인다 — 요약, 대상(읽기 전용: 채널·메일·이슈·PR·일정·세션), 텍스트(편집 가능 — 할 일 제목·보낼 글·일정 제목·Jira 옮길 상태), [실행] [취소]. 실행하면 결과(✓ 실행됨 + 링크 / ⚠ 실패 → "다시 실행")가 카드에 남고, 취소하면 "취소됨"으로 접힌다. 한 카드는 한 번만 실행된다.
- 데이터: 모델은 여전히 읽기 도구만 쓰고 ```ned-action 블록으로 **제안만** 한다(시스템 프롬프트엔 지금 허용된 동작만 들어감). [실행] → `/api/chat/actions/validate` 가 스위치와 대상(최근 agenda/state 에 있는 항목인지 url·id 로)을 확인해 요청을 만들고, 기존 `/api/send` · `/api/calendar/events` · `/api/todos` 로 실행(`origin: "chat"`). 카드 상태는 `~/.ned/chats/` 의 그 답에 저장(`/api/chat/:id/action`). 기록은 `~/.ned/sent-actions.log` → 설정 → 오늘 한 액션에 "대화창" 배지.
- 언제: 대화하다가 그 자리에서 답장·할 일·일정·리뷰까지 끝내고 싶을 때. 대상은 바꿀 수 없어 — 다른 대상이면 대화로 다시 요청.
- 설정: 설정 → 쓰기 액션 → 대화창 → "대화창에서 쓰기 허용" `actions.chat_write`(기본 꺼짐). 각 동작은 자기 스위치도 켜져 있어야 함(할 일 추가는 chat_write 만): `todo_add` · `slack_send` · `gmail_draft` · `gmail_send` · `jira_comment` · `jira_transition` · `github_review` · `calendar_create` · `calendar_rsvp` · `session_send` · `session_create`(`actions.chat_session_create`, 아래 "대화창에서 세션 만들기").

### 통신기 — 정리 결과물 (노트 저장)
- 보여 주는 것: 대화창에서 "이 회의 정리해 줘", "이 문서 요약해서 남겨 줘", "오늘 메일 정리해 줘" 하면 Ned 가 짧은 요약으로 답하고 그 아래 **저장 카드** — "📎 회의 정리 저장됨 · 제목", 저장 위치(볼트 경로 / "Ned 에만 저장"), [Obsidian 에서 열기] [Finder 에서 보기], "내용 보기"(노트 전문). 답이 흐르는 동안은 "정리 결과 저장 준비 중…".
- 형식(모델이 지킴): 회의 = 한 줄 결론 → 결정 → 액션 아이템(담당·기한, 내 것 먼저) → 미결 → 출처 / 문서 = TL;DR 3줄 → 핵심 → 나에게 요구되는 것 → 리스크 → 출처 / 메일 = 답장 필요·승인·읽기만·보관 그룹(한 줄 + 발신자 + 링크). 액션 아이템은 `- [ ] 내용 #task 📅 YYYY-MM-DD` 라 Obsidian Tasks 에 바로 잡힘.
- 데이터: 모델이 답 끝에 ```ned-output 블록(JSON `kind`·`title`·`markdown`)을 붙이면 데몬이 꺼내 저장 — 추가 Claude 호출 없음. 항상 `~/.ned/outputs/`(목록 `/api/outputs`, 하나 `/api/outputs/:id`), 아카이브가 켜져 있고 "담을 것 → 정리 결과물"(`archive.include.outputs`)이면 볼트에도 `<archive.folder>/Notes/YYYY-MM/YYYY-MM-DD.<제목>.md`(frontmatter `date`·`kind`·`source` 링크·`tags: [ned, kind]`, 같은 이름이면 " (2)"). 그날 데일리 리포트 "📎 정리 결과물"에 링크. "Finder 에서 보기" = `/api/outputs/:id/reveal`.
- 언제: 회의록·긴 문서·메일 더미를 대화로 정리하고 기록으로 남기고 싶을 때.

### 답장 초안 ✎
- 보여 주는 것: 맥락 요약·발췌 + 초안 3개(짧게/보통/정중하게), 편집 가능, "다시 생성"(힌트).
- 데이터: 백그라운드로 모은 답장 맥락(신선하면 빠른 경로) 또는 커넥터로 스레드를 읽어 생성. 캐시 `~/.ned/drafts/`(1시간). 초안을 열면 항목은 확인 완료.
- 언제: Slack·메일 답장, 세션에 지시, Jira 코멘트, PR 리뷰 문구를 빨리 쓰고 싶을 때.
- 키·설정: ⌘⏎ 주 액션, Esc 닫기. 말투 = `reply_tone`(기본 "간결하고 정중한 존댓말, 핵심 먼저") / 소스별 `reply_tone_by_source.slack|email|session`. 미리 생성 `drafts_pregenerate`(config.yaml 만).

### 쓰기 액션
- 보여 주는 것: 초안 팝업·⋯ 메뉴의 실제 쓰기 버튼. 꺼진 동작은 비활성("설정 → 쓰기 액션에서 'X' 을 허용해야 써"). 보내기는 대상을 보여 주는 확인 단계 후 실행.
- 데이터: 소스별 커넥터 도구 하나만 허용한 `claude -p`(GitHub 는 `gh pr review/comment`, 세션은 `orca terminal send`). 모든 시도는 `~/.ned/sent-actions.log`.
- 언제: Ned 화면에서 바로 답·처리까지 끝내고 싶을 때.
- 설정 키(설정 → 쓰기 액션 → 허용할 동작(소스별)):
  - Slack: "Slack 전송" `actions.slack_send`(꺼짐)
  - Gmail: "Gmail 초안 저장" `actions.gmail_draft`(켬) · "메일 보내기" `actions.gmail_send`(꺼짐) · "메일 확인 시: 확인 완료만 / Gmail 읽음 표시까지" `actions.gmail_mark_read`(꺼짐)
  - 세션: "세션에 보내기" `actions.session_send`(켬) · "대화창에서 세션 만들기" `actions.chat_session_create`(꺼짐)
  - Jira: "Jira 코멘트" `actions.jira_comment` · "Jira 상태 변경" `actions.jira_transition`(⋯ → 코멘트 초안 쓰기…/상태 변경…)
  - GitHub: "GitHub 리뷰·코멘트" `actions.github_review`(⋯ → 리뷰 초안 쓰기…/바로 승인; 리뷰 코멘트·변경 요청·승인+코멘트·PR 코멘트)
  - 캘린더: "캘린더 참석 응답" `actions.calendar_rsvp` · "캘린더 일정 생성" `actions.calendar_create`
  - 대화창: "대화창에서 쓰기 허용" `actions.chat_write`(꺼짐) — 통신기 대화가 확인 카드로 쓰기를 제안(위 "대화창에서 쓰기")
  - 아래 "오늘 한 액션" 표(소스·결과 필터, "읽기 포함", 새로고침).
- Slack 이모지 리액션 보내기는 없음(커넥터에 도구 없음).

### Gmail 읽음 표시
- 보여 주는 것: 메일 항목 ✓(확인 완료) 때 Gmail 에서도 그 스레드의 안 읽음 표시를 지움.
- 데이터: 백그라운드 작업(`src/mail-read.ts`), 같은 스레드 10분 내 중복·하루 상한 도달 시 생략. 실패해도 확인 완료는 유지, ✓ 취소해도 안 읽음으로 되돌리지 않음.
- 언제: Ned 에서 확인한 메일을 Gmail 에서도 읽음으로 맞추고 싶을 때.
- 켜는 법: 설정 → 쓰기 액션 → Gmail → "메일 확인 시:" 에서 "Gmail 읽음 표시까지" 선택 → 저장. 키 `actions.gmail_mark_read`(기본 false).

### 확인 완료 ✓ · 답 필요 해제 이모지
- 보여 주는 것: ✓ 누른 항목은 "확인 완료 N" 아래로 접힘(흐리게, 다시 누르면 되돌림). 카운트·배지는 열린 것만. 항목이 나중에 바뀌면(새 답글 등) 다시 열림.
- 데이터: `~/.ned/reviewed.json`(attention 7일, 소스 항목 30일). Slack 은 agenda 가 내 답글 / 내 리액션 이모지를 찾아 자동으로 확인 처리.
- 언제: 처리했거나 볼 필요 없는 항목을 목록에서 치울 때.
- 설정: 설정 → 소스 → Slack → "답 필요 해제 이모지"(`filters.slack.ack_reactions`, 기본 white_check_mark·eyes·+1·heavy_check_mark, 최대 8, 비우면 리액션 안 봄). 이모지 하나 = Slack 검색 한 번이라, 한 번에 앞에서부터 "한 번에 확인할 이모지"(`filters.slack.ack_check_max`, 기본 3, 1~8)개만 보고, 답 필요 후보가 하나도 없으면 이모지 검색 자체를 건너뜀.

### Slack 그룹 멘션
- 보여 주는 것: 내가 속한 Slack 유저그룹(@mobile-dev 등)을 향한 멘션도 Slack 카드에 "그룹"(👥) 칩으로. `전체` 에는 모두, `확인 필요` 에는 그룹에 구체적으로 묻거나 요청했는데 아무도(나 포함) 답하지 않은 것만(공지·공유 제외). 같은 메시지가 개인 멘션에도 걸리면 개인 멘션으로(dm > 멘션 > 스레드 > 그룹). 그룹 멘션은 스레드 팔로업 대상이 아님.
- 데이터: agenda Slack 1단계에서 그룹마다 검색 1번 추가(기존 검색과 같은 턴, 턴 수 그대로) — ID 면 `<!subteam^S…>`, 핸들이면 `"@핸들"` 로 찾음. `reason: "group"`.
- 설정: 설정 → 소스 → Slack → "그룹 멘션"(`filters.slack.group_mentions`, 기본 [], 최대 8). 그룹 ID(`S…`, Slack 그룹 프로필 ⋯ → ID 복사 — 가장 정확) 또는 핸들(`@mobile-dev`, 앞 @ 는 떼어 저장). 비우면 검색 안 함.

### 검색 ⌘K
- 보여 주는 것: 주의 항목·세션·일정·Jira·GitHub·메일·Slack·개인 할 일·브리핑·타임라인 이벤트·초안·설정 항목 통합 검색, 한글 초성 매칭.
- 데이터: `GET /api/search`(state, 브리핑 전체, 최근 30일 이벤트, 할 일, agenda.json, 수집 이력, 초안) — 읽기 전용. 수집 이력은 지금 카드에 없는 것만(같은 항목이 두 번 안 나옴) "이력 · 날짜" 로, ⇧⏎ 는 그 소스 카드로.
- 언제: "그 메일 어디 있었지", "알림 설정 어디야" 처럼 찾을 때.
- 키: ⌘K/Ctrl+K 또는 /, ↑/↓(Ctrl+N/P, Tab) 이동, ⏎ 열기, ⌘⏎ 새 탭, ⇧⏎ 대시보드에서 보기, Esc 지우기→닫기.

### 아카이브 — Obsidian
- 보여 주는 것: Obsidian 볼트 안 Ned 폴더(`archive.folder`, 기본 Ned)에 매일 **데일리 리포트** `Daily/YYYY-MM/YYYY-MM-DD.md` — 🌅 브리핑(아침 브리핑의 행동 필요/업데이트/참고, 링크) · 🔔 순찰(그날 순찰 알림 시간순, 같은 항목 한 번) · ✉️ 보낸 것(답장·일정 생성·읽음 처리·할 일 추가 등 성공한 쓰기, 시각·대상·요약) · 📎 정리 결과물(결과물 노트 링크) · 🤖 세션(켜면) · 📥 들어온 것(수집 이력에서 그날 처음 본 항목, 소스별 최대 30줄 +N — Slack 채널·보낸이·한 줄·링크 / 메일 보낸이·제목 / Jira 키·제목 / GitHub 레포·PR 제목 / 캘린더 시각·제목) · 📊 오늘(순찰 횟수, 소스별 갱신 수, 비용). frontmatter `created`·`tags: [ned, daily]`·`ned_version`. Ned 데일리 리포트는 내 데일리 노트와 별도 파일.
- 데이터: 이미 있는 것(`~/.ned/briefings/`, `~/.ned/sent-actions.log`, `~/.ned/outputs/`, 세션 이벤트, `~/.ned/costs.json`, agenda 갱신)으로 데몬이 마크다운을 씀 — Claude 호출 없음, 비용 0. 섹션마다 `<!-- ned:섹션 -->` … `<!-- ned:/섹션 -->` 사이만 다시 쓰고 **마커 밖에 적은 메모는 그대로**(마커를 지우면 그 섹션은 파일 끝에 새로 붙음). 임시 파일 → rename 으로 원자적 쓰기, 볼트 밖 경로(.. · 심링크)는 거부. 상태는 `~/.ned/archive.json`.
- 언제 쓰나: 아침 브리핑·순찰 알림·쓰기 성공·결과물 저장 직후 바로, 그 밖의 변화(순찰 횟수·소스 갱신)는 1분 틱에서 마지막 쓰기 후 5분 지나면. 자정 넘어 끝난 순찰은 그 순찰이 시작된 날 파일로, 지난 날 파일은 그 뒤로 안 건드림.
- 내 데일리 노트 embed(`archive.daily_embed`, 기본 꺼짐): 켜면 그날 내 데일리 노트가 **이미 있을 때만**(없으면 만들지 않음) "## 📝 Notes & Logs" 바로 아래에 `<!-- ned:embed -->![[Ned/Daily/YYYY-MM/YYYY-MM-DD]]<!-- ned:/embed -->` 한 줄. 다른 줄은 손대지 않음. 데일리 노트 위치는 `<볼트>/.obsidian/daily-notes.json` 의 folder·format(없으면 건너뜀).
- 설정: 설정 → 아카이브 — "아카이브 켜기" `archive.enabled`(기본 꺼짐) · "볼트 경로" `archive.vault`(절대 경로, 있는 폴더여야 하고 ~/.ned·Ned 레포 안은 거부 — `.obsidian` 이 있으면 "볼트 확인됨" 배지, 없으면 경고만) · "Ned 폴더" `archive.folder` · "담을 것" `archive.include.briefings`·`archive.include.updates`·`archive.include.actions`·`archive.include.outputs`·`archive.include.history`(📥 들어온 것, 기본 켬)·`archive.include.sessions`(기본 꺼짐) · "내 데일리 노트에 embed" `archive.daily_embed`. 상태 줄: 오늘 리포트 경로("Obsidian 에서 열기"), 마지막 쓰기, 대기 중인 날, 마지막 오류(권한 거부면 macOS 파일 접근 허용 안내), "지금 쓰기"(`/api/archive/flush`), 상태는 `/api/archive/status`. 쓰기가 실패해도 데몬은 계속 돌고 다음 틱에 다시 시도(쓰는 중 파일이 계속 바뀌면 4번까지 다시 합친 뒤 다음 틱으로, 7일 넘게 못 쓴 날은 경고 후 포기).

### 설정 탭
상단 바로가기: 외형 · 소스 · 알림 · 순찰 주기 · 수집·보관 · 쓰기 액션 · 아카이브 · Claude. "다시 불러오기", 하단 "● 저장 안 된 변경" + "저장".
- **외형**: 테마 🖥️시스템/☀️라이트/🌙다크 `dashboard.theme`(바로 미리보기, 저장해야 유지) · 홈 카드 배치 ↑/↓·1열/2열 `dashboard.card_order`/`dashboard.card_span` · "홈 배치 잠금" `dashboard.locked` · "팔로업 채널을 별도 카드로" `dashboard.watch_cards` · "배치 초기화".
- **소스**: Gmail/Slack/Jira/GitHub/Sentry/캘린더 `sources.*`(끄면 조회·보고 안 함). Slack: 팔로업 채널 `filters.slack.watch_channels` · 트래킹 제외 채널 `filters.slack.exclude_channels`(팔로업보다 우선) · 답 필요 해제 이모지 `filters.slack.ack_reactions` · 한 번에 확인할 이모지 `filters.slack.ack_check_max`(3) · 그룹 멘션 `filters.slack.group_mentions`(유저그룹 ID·핸들). Jira: 제외 프로젝트 `filters.jira.exclude_projects`. 칩 입력: ⏎/쉼표 추가, 빈 입력 Backspace 삭제.
- **알림**: 알림 켜기 `notifications.enabled` · 소스별 `notifications.kinds.*` · 아침 브리핑 알림 `notifications.briefing` · 소리 `notifications.sound` · 묶음 기준 `notifications.summary_threshold`(기본 3) · 조용한 시간 `quiet_hours`(기본 23:00~08:00) · 그 시간엔 보내지 않음/소리 없이 `notifications.quiet_delivery`.
- **순찰 주기**: heartbeat 간격 `heartbeat_minutes`(10) · 신호 조회 최소 간격 `signal_check_minutes`(60) · "바뀐 게 없으면 순찰 건너뛰기" `heartbeat_skip_unchanged`(켬) · 아침 브리핑 시각 `briefing_time`(09:00) · 홈 자동 갱신 기본 주기 `agenda_refresh_minutes`(60) · 소스별 주기 Slack/메일/캘린더/Jira/GitHub `agenda_source_minutes.*`(비우면 기본) · 조용한 시간 동작 `quiet_schedule.*` · 유휴 시 동작 `idle_schedule.*`(위 "야간 모드 · 유휴 모드").
- **쓰기 액션**: 기본 말투 `reply_tone` · 소스별 그룹 토글 `actions.*`(위 "쓰기 액션") · 답장 말투 `reply_tone_by_source.*` · 오늘 한 액션.
- **수집·보관**: 수집 이력 기록 `history.enabled`(`c-hist-on`) · 표시 구간 Slack 시간 `history.display.slack_hours`·메일 일 `history.display.mail_days` · 보관 기간 Slack/메일/Jira/GitHub/캘린더 `history.keep_days.*`(0 = 기록 안 함) · 상태 줄(소스별 건수·일수·크기, 마지막 수집·전체 재검색, 다음 수집 창 — `/api/history/status`).
- **아카이브**: 켜기 `archive.enabled` · 볼트 경로 `archive.vault` · Ned 폴더 `archive.folder` · 담을 것 `archive.include.*` · 내 데일리 노트 embed `archive.daily_embed` · 상태·"지금 쓰기"(위 "아카이브 — Obsidian").
- **Claude**: 모델 `claude_model`(비우면 기본) · 최대 턴 `claude_max_turns`(25) · 하루 사용 상한 `agenda_daily_budget_usd`(15, 닿으면 자동 실행과 대화가 멈춤, 버튼 실행은 계속).
- **저장·되돌리기**:
  - 보여 주는 것: 하단 "● 저장 안 된 변경" + "저장". 바뀐 항목만 저장("바뀐 항목이 없어."면 저장할 게 없음). 다른 곳(다른 탭·config.yaml 직접 수정·데몬 업그레이드)에서 그 사이 바뀌었으면 덮어쓰지 않고 최신 값을 불러온 뒤 내가 수정한 항목은 유지 → 다시 저장.
  - 데이터: `PUT /api/config`(부분 패치 + 마지막으로 읽은 시점 비교, 어긋나면 409). 저장할 때마다 직전 config.yaml 을 `~/.ned/config-backups/` 에 백업(최근 10개).
  - 언제: 설정을 실수로 바꿨거나 예전 값으로 돌아가고 싶을 때 → 설정 탭 맨 아래 "이전 설정으로 되돌리기" → 시점 선택 → "되돌리기 확인"(지금 설정도 백업됨).
  - 새 버전: 데몬이 새 코드로 재시작되면 상단 배너 "새 버전의 Ned 가 실행 중이야 — 새로고침…" + "새로고침" 버튼, 새로고침 전까지 설정 저장이 잠김(옛 화면이 옛 설정을 쓰지 않도록).
- UI 없이 config.yaml 로만: `persona`, `port`, `notify`, `session_stale_minutes`, `draft_fast_model`, `draft_context_max_age_minutes`, `drafts_pregenerate`, `agenda_all_limit`, `agenda_context_batch`, `agenda_light_model`, `chat_ignore_budget`, `dashboard.layout`.

## 부록 A — 설정 키 전체 (`~/.ned/config.yaml`)

| 키 | 기본 | 화면 위치 |
|---|---|---|
| `heartbeat_minutes` | 10 | 설정 → 순찰 주기 → heartbeat 간격 |
| `signal_check_minutes` | 60 | 순찰 주기 → 신호 조회 최소 간격 |
| `heartbeat_skip_unchanged` | true | 순찰 주기 → 바뀐 게 없으면 순찰 건너뛰기 |
| `briefing_time` | 09:00 | 순찰 주기 → 아침 브리핑 시각 |
| `agenda_refresh_minutes` | 60 | 순찰 주기 → 홈 자동 갱신 기본 주기 |
| `agenda_source_minutes.slack` · `agenda_source_minutes.mail` · `agenda_source_minutes.calendar` · `agenda_source_minutes.jira` · `agenda_source_minutes.github` | null(=기본 주기) | 순찰 주기 → 소스별 주기 |
| `quiet_schedule.mode` · `quiet_schedule.slow_factor` | slow · 6 | 순찰 주기 → 조용한 시간 동작 |
| `idle_schedule.enabled` · `idle_schedule.after_minutes` · `idle_schedule.unchanged_runs` · `idle_schedule.mode` · `idle_schedule.slow_factor` | true · 120 · 6 · slow · 6 | 순찰 주기 → 유휴 시 동작 |
| `quiet_hours` (start/end) | 23:00~08:00 | 알림 → 조용한 시간 |
| `sources.gmail` · `sources.slack` · `sources.jira` · `sources.github` · `sources.sentry` · `sources.calendar` | 전부 true | 소스 |
| `filters.slack.watch_channels` | [] (최대 20) | 소스 → Slack → 팔로업 채널 |
| `filters.slack.exclude_channels` | [] | 소스 → Slack → 트래킹 제외 채널 |
| `filters.slack.ack_reactions` | white_check_mark, eyes, +1, heavy_check_mark | 소스 → Slack → 답 필요 해제 이모지 |
| `filters.slack.ack_check_max` | 3 (1~8) | 소스 → Slack → 한 번에 확인할 이모지 |
| `filters.slack.group_mentions` | [] (최대 8) | 소스 → Slack → 그룹 멘션 |
| `filters.jira.exclude_projects` | [] | 소스 → Jira → 제외 프로젝트 |
| `notifications.enabled` · `notifications.briefing` · `notifications.sound` · `notifications.summary_threshold` · `notifications.quiet_delivery` | true · true · true · 3 · skip | 알림 |
| `notifications.kinds.session` · `notifications.kinds.email` · `notifications.kinds.slack` · `notifications.kinds.jira` · `notifications.kinds.github` · `notifications.kinds.sentry` · `notifications.kinds.calendar` | 전부 true | 알림 → 소스별 |
| `actions.slack_send` · `actions.gmail_draft` · `actions.gmail_send` · `actions.gmail_mark_read` · `actions.session_send` · `actions.jira_comment` · `actions.jira_transition` · `actions.github_review` · `actions.calendar_rsvp` · `actions.calendar_create` · `actions.chat_write` · `actions.chat_session_create` | gmail_draft·session_send 만 true | 쓰기 액션 → 허용할 동작 |
| `reply_tone` · `reply_tone_by_source.slack` · `reply_tone_by_source.email` · `reply_tone_by_source.session` | "간결하고 정중한 존댓말, 핵심 먼저" · null | 쓰기 액션 → 기본 말투 / 답장 말투 |
| `dashboard.theme` · `dashboard.card_order` · `dashboard.card_span` · `dashboard.locked` · `dashboard.watch_cards` · `dashboard.layout` | system · slack,mail,jira,github · — · false · true · null | 외형 (layout 은 홈 드래그 배치) |
| `claude_model` · `claude_max_turns` · `agenda_daily_budget_usd` | null · 25 · 15 | Claude |
| `archive.enabled` · `archive.vault` · `archive.folder` · `archive.daily_embed` | false · "" · Ned · false | 아카이브 |
| `archive.include.briefings` · `archive.include.updates` · `archive.include.actions` · `archive.include.outputs` · `archive.include.sessions` · `archive.include.history` | true · true · true · true · false · true | 아카이브 → 담을 것 |
| `history.enabled` | true | 수집·보관 → 수집 이력 기록 |
| `history.display.slack_hours` · `history.display.mail_days` | 24 · 3 | 수집·보관 → 표시 구간 |
| `history.keep_days.slack` · `history.keep_days.mail` · `history.keep_days.jira` · `history.keep_days.github` · `history.keep_days.calendar` | 30 · 30 · 90 · 90 · 90 (0 = 기록 안 함) | 수집·보관 → 보관 기간 |
| `persona` | ned | UI 없음 (ned/alfred/oracle/jarvis — 말투·테마·통신기 이름) |
| `port` | 7777 | UI 없음 (`NED_PORT` 가 우선) |
| `notify` | auto | UI 없음 (auto/osascript/off) |
| `session_stale_minutes` | 180 | UI 없음 — 이 시간 이벤트 없는 세션은 사라짐 |
| `draft_context_max_age_minutes` · `draft_fast_model` · `drafts_pregenerate` | 180 · sonnet · false | UI 없음 — 초안 빠른 경로·미리 생성 |
| `agenda_all_limit` · `agenda_context_batch` · `agenda_thread_batch` · `agenda_light_model` | 20 · 5 · 8 · sonnet | UI 없음 — 전체 목록 길이, 맥락·스레드 수집 묶음, 목록 모델 |
| `chat_ignore_budget` | false | UI 없음 — true 면 하루 상한이 넘어도 통신기 대화는 허용 |

## 부록 B — 설정 화면 요소 ↔ 설정 키 (`public/index.html`)

| 요소 id | 화면 라벨 | 키 |
|---|---|---|
| `c-theme` | 외형 → 테마 | `dashboard.theme` |
| `c-cards` | 외형 → 홈 카드 배치 | `dashboard.card_order` / `dashboard.card_span` |
| `c-sources` | 소스 토글 | `sources.*` |
| `x-watch-in` | 소스 → Slack → 팔로업 채널 | `filters.slack.watch_channels` |
| `x-slack-in` | 소스 → Slack → 트래킹 제외 채널 | `filters.slack.exclude_channels` |
| `x-ack-in` | 소스 → Slack → 답 필요 해제 이모지 | `filters.slack.ack_reactions` |
| `c-ackmax` | 소스 → Slack → 한 번에 확인할 이모지 | `filters.slack.ack_check_max` |
| `x-group-in` | 소스 → Slack → 그룹 멘션 | `filters.slack.group_mentions` |
| `x-jira-in` | 소스 → Jira → 제외 프로젝트 | `filters.jira.exclude_projects` |
| `n-on` | 알림 → 알림 켜기 | `notifications.enabled` |
| `n-kinds` | 알림 → 소스별 | `notifications.kinds.*` |
| `n-brief` | 알림 → 아침 브리핑 알림 | `notifications.briefing` |
| `n-sound` | 알림 → 소리 | `notifications.sound` |
| `n-th` | 알림 → 묶음 기준 | `notifications.summary_threshold` |
| `c-qon` · `c-qs` · `c-qe` | 알림 → 조용한 시간 사용 · 시작 · 끝 | `quiet_hours` |
| `c-hb` | 순찰 주기 → heartbeat 간격 | `heartbeat_minutes` |
| `c-sig` | 순찰 주기 → 신호 조회 최소 간격 | `signal_check_minutes` |
| `c-hbskip` | 순찰 주기 → 바뀐 게 없으면 순찰 건너뛰기 | `heartbeat_skip_unchanged` |
| `c-bt` | 순찰 주기 → 아침 브리핑 시각 | `briefing_time` |
| `c-agmin` | 순찰 주기 → 홈 자동 갱신 기본 주기 | `agenda_refresh_minutes` |
| `c-int-slack` · `c-int-mail` · `c-int-calendar` · `c-int-jira` · `c-int-github` | 순찰 주기 → 소스별 주기 | `agenda_source_minutes.*` |
| `c-hist-on` | 수집·보관 → 수집 이력 기록 | `history.enabled` |
| `c-hist-slack-h` · `c-hist-mail-d` | 수집·보관 → 표시 구간 Slack(시간) · 메일(일) | `history.display.slack_hours` · `history.display.mail_days` |
| `c-keep-slack` · `c-keep-mail` · `c-keep-jira` · `c-keep-github` · `c-keep-calendar` | 수집·보관 → 보관 기간 | `history.keep_days.*` |
| `c-tone` | 쓰기 액션 → 기본 말투 | `reply_tone` |
| `c-model` | Claude → 모델 | `claude_model` |
| `c-turns` | Claude → 최대 턴 | `claude_max_turns` |
| `c-budget` | Claude → 하루 사용 상한 | `agenda_daily_budget_usd` |
| `c-arch-on` | 아카이브 → 아카이브 켜기 | `archive.enabled` |
| `c-arch-vault` | 아카이브 → 볼트 경로 | `archive.vault` |
| `c-arch-folder` | 아카이브 → Ned 폴더 | `archive.folder` |
| `c-arch-inc` | 아카이브 → 담을 것 | `archive.include.*` |
| `c-arch-embed` | 아카이브 → 내 데일리 노트 embed | `archive.daily_embed` |

쓰기 액션 토글은 `data-act="<키>"` → `actions.<키>` (부록 A).

## 부록 C — HTTP API (대시보드가 쓰는 로컬 API, 127.0.0.1)

- 수집 이력: `/api/history`(카드 "지난 7일/30일", `source`·`days`·`q`·`channel`) · `/api/history/status`(설정 → 수집·보관 상태 줄)
- 상태·데이터: `/api/state` · `/api/agenda` · `/api/briefings` · `/api/events` · `/api/costs` · `/api/actions`(오늘 한 액션) · `/api/search`(⌘K)
- 순찰·갱신: `/api/check`(지금 점검, GET 은 진행 상태) · `/api/heartbeat`(아침 브리핑 `?daily=1`) · `/api/agenda/refresh`(카드 ↻) · `/api/agenda/context`(맥락 지금 수집) · `/api/activity`(대시보드 활동 핑 — 유휴 해제)
- 할 일·확인: `/api/todos` · `/api/todos/:id`(완료·삭제) · `/api/attention/:id/review`(확인 완료) · `/api/attention/:id/dismiss`(닫기)
- 일정: `/api/calendar`(기간 조회) · `/api/calendar/events`(일정 만들기)
- 초안·보내기: `/api/draft` · `/api/send`
- 세션 만들기: `/api/sessions/create`(대화창 확인 카드 [실행], 진행은 `/api/sessions/create/:job_id`)
- 통신기: `/api/chat`(SSE) · `/api/chat/:id` · `/api/chat/:id/stop` · `/api/chats` · `/api/chat/actions/validate`(확인 카드 검증) · `/api/chat/:id/action`(카드 상태 저장)
- 아카이브: `/api/archive/status`(볼트 배지·마지막 쓰기·마지막 오류) · `/api/archive/flush`(지금 쓰기) · `/api/outputs`(정리 결과물 목록) · `/api/outputs/:id`(하나, 마크다운 포함) · `/api/outputs/:id/reveal`(Finder 에서 보기)
- 설정: `/api/config`(GET/PUT — 바뀐 키만, 충돌 시 409) · `/api/config/backups` · `/api/config/restore`(이전 설정으로 되돌리기)
