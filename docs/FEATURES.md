# Ned 기능 가이드

> 코드 기준 사용자 가이드. 맨 위 "요약"(≤2,500자)은 Ned 대화창(Ned Net) 시스템 프롬프트에 그대로 들어간다(`packages/daemon/src/chat.ts`).
> 기능을 추가/변경하면 아래 해당 항목과 **요약을 같이** 고친다. 설정 키는 `~/.ned/config.yaml` 기준 점 표기.

## 요약

Ned = 에이전트 세션·업무 신호(Slack·메일·캘린더·Jira·GitHub·Sentry)를 모아 보여 주는 로컬 대시보드(탭: 홈·인박스·타임라인·설정). 전역 키: h 홈, i 인박스, r 지금 점검, ⌘K(또는 /) 검색, ⌘J 통신기.
- **홈**: 일정(일/주, ＋·드래그로 일정 만들기, ⋯ 수락/미정/거절), 할 일(NED 액션 아이템 + 개인 할 일, n 입력), 소스 카드(메일·Jira·Slack·GitHub — `확인 필요 | 전체` 전환, ↻ 소스별 갱신), 팔로업 채널 카드(멘션 없어도 따라가는 Slack 채널 24h 요약, "나한테" 강조). 데이터: agenda.json(소스별 주기 갱신).
- **인박스**: 우선(확인 필요 attention)·기타(브리핑의 업데이트/참고)·기록(브리핑 목록) 3탭 + 오른쪽 "장비실"(에이전트 세션 상태: 실행 중/입력 대기/완료/오류). j/k 이동, e 닫기, ⏎ 열기, 1/2/3 탭.
- **타임라인**: 세션 이벤트(시작·프롬프트·알림·응답 완료·오류 등)와 브리핑을 시간순으로, 유형·워크트리 칩 필터. 무슨 일이 언제 있었는지 되짚을 때.
- **순찰/브리핑**: 헤더 "지금 점검"(r) = 소스를 새로 가져온 뒤 판단해 알림·attention 생성. 자동 순찰은 `heartbeat_minutes`, 아침 브리핑은 `briefing_time`.
- **통신기 Ned Net**(⌘J): "대화" 탭 = Ned 에게 질문(읽기 전용), "메시지" 탭 = 새 알림·브리핑·새 Slack 답글 피드.
- **답장 초안 ✎**: 항목의 연필 → 3가지 말투 초안 → 복사/열기/보내기. 실제 쓰기는 설정에서 켠 것만: `actions.slack_send`, `actions.gmail_draft`(기본 켬), `actions.gmail_send`, `actions.session_send`(기본 켬), `actions.jira_comment`, `actions.jira_transition`, `actions.github_review`, `actions.calendar_rsvp`, `actions.calendar_create`. Jira·GitHub·캘린더는 항목 ⋯ 메뉴.
- **확인 완료 ✓**: 항목을 처리됨으로 접음(바뀌면 다시 열림). Slack 은 내 답글이나 해제 이모지 리액션(`filters.slack.ack_reactions`)이 있으면 자동 해제.
- **Gmail 읽음 표시**: 설정 → 쓰기 액션 → Gmail → "메일 확인 시: Gmail 읽음 표시까지" 선택 후 저장(`actions.gmail_mark_read`, 기본 꺼짐). 메일 ✓ 때 Gmail 스레드도 읽음 처리, ✓ 취소해도 안 읽음으로 안 되돌림.
- **검색 ⌘K**: 주의 항목·세션·일정·Jira·GitHub·메일·Slack·할 일·브리핑·이벤트·초안·설정 항목 통합 검색(초성 지원).
- **설정**(바꾼 뒤 하단 "저장"): 외형(테마 `dashboard.theme` 시스템/라이트/다크, 카드 배치·잠금 `dashboard.locked`, 팔로업 별도 카드 `dashboard.watch_cards`) · 소스(`sources.*`, Slack 팔로업 채널 `filters.slack.watch_channels`, 트래킹 제외 채널 `filters.slack.exclude_channels`, 답 필요 해제 이모지 `filters.slack.ack_reactions`, Jira 제외 프로젝트 `filters.jira.exclude_projects`) · 알림(`notifications.*`, 조용한 시간 `quiet_hours`) · 순찰 주기(`heartbeat_minutes`, `signal_check_minutes`, `briefing_time`, `agenda_refresh_minutes`, 소스별 주기 `agenda_source_minutes.*`) · 쓰기 액션(`actions.*`, 기본 말투 `reply_tone`, 소스별 답장 말투 `reply_tone_by_source.*`, 오늘 한 액션 로그) · Claude(모델 `claude_model`, 최대 턴 `claude_max_turns`, 하루 사용 상한 `agenda_daily_budget_usd` 기본 $15 — 닿으면 자동 실행·대화가 멈춤).

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
- 버튼·키: 일/주, ◀ 오늘 ▶ (카드 포커스 시 ←/→, t 오늘, d/w 일/주). ⋯ → 수락/미정/거절(`actions.calendar_rsvp`, 주최 일정엔 없음).

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

### 홈 — 소스 카드 (메일·Jira·Slack·GitHub)
- 보여 주는 것: 📬 메일 확인 필요(결재/마감/답장/확인, 안 읽은 N) · 📋 Jira 내 이슈(마감 지난/오늘/진행 중) · 💬 Slack 답할 것(DM/멘션/스레드, 답 필요/답함/새 답글) · 🐙 GitHub 리뷰 요청(리뷰 요청/변경 요청/승인됨). 접힘/펼침, 메일·Slack 은 `확인 필요 | 전체`(전체 = 메일 최근 2일 안 읽음, Slack 최근 24h 멘션·DM).
- 데이터: agenda.json — 소스별 `claude -p`(커넥터 읽기) 또는 GitHub 는 `gh search prs`. 소스별 주기마다 자동, 답장 맥락은 백그라운드 수집("맥락 수집 N/M").
- 언제: 답할 메시지·리뷰·마감 이슈를 소스별로 훑을 때.
- 버튼·설정: 카드 ↻(그 소스만 지금 갱신), ⚠ 오류 배지, 항목 ✎ 초안·열기·✓ 확인. `sources.*`, `agenda_source_minutes.*`, `dashboard.card_order`/`card_span`, `agenda_all_limit`.

### 홈 — 팔로업 채널 카드
- 보여 주는 것: 멘션이 없어도 따라가는 Slack 채널마다 24시간 요약 + 하이라이트. 나를 향한 것은 "나한테" 칩으로 앞에, 할 일 카드 개수에도 포함. 없으면 "지난 24시간 눈에 띄는 대화 없음."
- 데이터: agenda.json `slack.watch`(채널당 최근 24h 검색).
- 언제: 내가 태그되진 않지만 결정·공지를 놓치면 안 되는 채널.
- 설정: 설정 → 소스 → Slack → "팔로업 채널"(`filters.slack.watch_channels`, 최대 20). 별도 카드 대신 Slack 카드 안 "채널 팔로업 N" 으로 접으려면 설정 → 외형 → "팔로업 채널을 별도 카드로" 끄기(`dashboard.watch_cards`).

### 홈 — 배치
- 보여 주는 것: 일정·카드·할 일 패널의 자유 배치(12열 그리드).
- 언제: 화면 구성을 바꾸고 싶을 때.
- 버튼·키: 패널 헤더 ⠿ 드래그·가장자리 크기 조절, 그립에서 화살표 이동·Shift+화살표 크기·⏎ 저장·Esc 취소. 잠금 버튼 / 설정 → 외형 "홈 배치 잠금"(`dashboard.locked`), "배치 초기화".

### 인박스
- 보여 주는 것: "우선"(확인 필요 attention) · "기타"(브리핑의 업데이트/참고) · "기록"(브리핑 목록, 연속 NED_OK 는 "이상 무" 로 묶음). 상세: 행동 필요/업데이트/참고/세션/메타.
- 데이터: `state.json` attention, `~/.ned/briefings/`.
- 언제: Ned 가 판단한 "지금 봐야 할 것" 을 하나씩 처리할 때.
- 키·버튼: j/k(↓/↑) 이동, ⏎ 열기, e 닫기(처리 완료로 치우기), 1/2/3 탭, Esc 상세 닫기. ✎ 초안, ✓ 확인 완료, "← 목록".

### 에이전트 세션 — 장비실
- 보여 주는 것: 인박스 오른쪽 "장비실 · 세션" 패널 — 세션별 LED 상태(실행 중/입력 대기/완료/오류/종료), 워크트리, 서브에이전트 수, 마지막 요약 + "순찰 기록"(최근 8회). 없으면 "출동 중인 에이전트 없음."
- 데이터: Claude Code 훅 이벤트(`~/.ned/events/`) → `state.json` sessions. `session_stale_minutes`(기본 180) 동안 이벤트 없으면 사라짐.
- 언제: 여러 Claude 세션 중 입력을 기다리는 것·오류 난 것을 찾을 때.
- 버튼·설정: 세션 항목 ✎ 초안 → "세션에 보내기"(Orca 터미널로 전송, `actions.session_send` 기본 켬), "접기".

### 타임라인
- 보여 주는 것: 세션 이벤트(세션 시작/종료, 프롬프트, 서브에이전트 시작/종료, 알림, 응답 완료, 오류, 컨텍스트 압축)와 📝 브리핑(아침/점검)을 최신순(최대 300).
- 데이터: `GET /api/events?days=2` + 브리핑.
- 언제: 어떤 세션에서 언제 무엇이 일어났는지 되짚을 때.
- 버튼: "유형"·"워크트리" 칩 필터(전체), "새로 고침".

### 순찰·브리핑 (지금 점검)
- 보여 주는 것: Ned 의 판단 결과 — 알림 배너, 확인 필요(attention), 인박스 기록의 브리핑(NED_OK = 이상 무 / UPDATE).
- 데이터: 자동 순찰은 `heartbeat_minutes`(기본 10)마다, 신호 판단은 `signal_check_minutes`(기본 60)가 지났거나 세션 이벤트가 있을 때만 LLM 호출. agenda.json 재사용 + Sentry 직접 조회. 아침 브리핑은 `briefing_time`(기본 09:00) 뒤 첫 순찰, 하루 1회.
- 언제: 방금 들어온 것까지 반영해 판단받고 싶을 때 "지금 점검".
- 버튼·키·설정: 헤더 "지금 점검"(r, 데이터 갱신 중 → 판단 중, 1~2분), "아침 브리핑". 설정 → 순찰 주기. 하루 상한(`agenda_daily_budget_usd`) 도달 시 자동 실행만 멈춤.

### 통신기 — Ned Net
- 보여 주는 것: 모든 탭에 떠 있는 패널. "대화" 탭 = Ned 에게 질문(Ned 가 아는 맥락 + 읽기 도구로 답, 쓰기 안 함), "메시지" 탭 = 열린 attention·최근 24h 업데이트 브리핑·"내 답 이후 새 답글 N건" Slack 스레드·닫혀 있던 동안 온 답(안 읽음 배지).
- 데이터: 대화 = 턴마다 `claude -p`(읽기 전용, 최대 12턴, 질문 2,000자), `~/.ned/chats/`(최근 20개). 비용은 "대화 $x · 오늘 $y".
- 언제: "오늘 뭐 남았어?", "이 PR 상태는?", "이 기능 어떻게 켜?" 같은 질문.
- 키·버튼·설정: ⌘J(Ctrl+J) 열고 닫기, Esc 닫기, ⏎ 전송, ⇧⏎ 줄바꿈, "중단", "새 대화", ▾ 접기, 가장자리 크기 조절. 하루 상한 도달 시 대화도 막힘 — 예외는 config.yaml `chat_ignore_budget: true`.

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
  - 세션: "세션에 보내기" `actions.session_send`(켬)
  - Jira: "Jira 코멘트" `actions.jira_comment` · "Jira 상태 변경" `actions.jira_transition`(⋯ → 코멘트 초안 쓰기…/상태 변경…)
  - GitHub: "GitHub 리뷰·코멘트" `actions.github_review`(⋯ → 리뷰 초안 쓰기…/바로 승인; 리뷰 코멘트·변경 요청·승인+코멘트·PR 코멘트)
  - 캘린더: "캘린더 참석 응답" `actions.calendar_rsvp` · "캘린더 일정 생성" `actions.calendar_create`
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
- 설정: 설정 → 소스 → Slack → "답 필요 해제 이모지"(`filters.slack.ack_reactions`, 기본 white_check_mark·eyes·+1·heavy_check_mark, 최대 8, 비우면 리액션 안 봄).

### 검색 ⌘K
- 보여 주는 것: 주의 항목·세션·일정·Jira·GitHub·메일·Slack·개인 할 일·브리핑·타임라인 이벤트·초안·설정 항목 통합 검색, 한글 초성 매칭.
- 데이터: `GET /api/search`(state, 브리핑 전체, 최근 30일 이벤트, 할 일, agenda.json, 초안) — 읽기 전용.
- 언제: "그 메일 어디 있었지", "알림 설정 어디야" 처럼 찾을 때.
- 키: ⌘K/Ctrl+K 또는 /, ↑/↓(Ctrl+N/P, Tab) 이동, ⏎ 열기, ⌘⏎ 새 탭, ⇧⏎ 대시보드에서 보기, Esc 지우기→닫기.

### 설정 탭
상단 바로가기: 외형 · 소스 · 알림 · 순찰 주기 · 쓰기 액션 · Claude. "다시 불러오기", 하단 "● 저장 안 된 변경" + "저장".
- **외형**: 테마 🖥️시스템/☀️라이트/🌙다크 `dashboard.theme`(바로 미리보기, 저장해야 유지) · 홈 카드 배치 ↑/↓·1열/2열 `dashboard.card_order`/`dashboard.card_span` · "홈 배치 잠금" `dashboard.locked` · "팔로업 채널을 별도 카드로" `dashboard.watch_cards` · "배치 초기화".
- **소스**: Gmail/Slack/Jira/GitHub/Sentry/캘린더 `sources.*`(끄면 조회·보고 안 함). Slack: 팔로업 채널 `filters.slack.watch_channels` · 트래킹 제외 채널 `filters.slack.exclude_channels`(팔로업보다 우선) · 답 필요 해제 이모지 `filters.slack.ack_reactions`. Jira: 제외 프로젝트 `filters.jira.exclude_projects`. 칩 입력: ⏎/쉼표 추가, 빈 입력 Backspace 삭제.
- **알림**: 알림 켜기 `notifications.enabled` · 소스별 `notifications.kinds.*` · 아침 브리핑 알림 `notifications.briefing` · 소리 `notifications.sound` · 묶음 기준 `notifications.summary_threshold`(기본 3) · 조용한 시간 `quiet_hours`(기본 23:00~08:00) · 그 시간엔 보내지 않음/소리 없이 `notifications.quiet_delivery`.
- **순찰 주기**: heartbeat 간격 `heartbeat_minutes`(10) · 신호 조회 최소 간격 `signal_check_minutes`(60) · 아침 브리핑 시각 `briefing_time`(09:00) · 홈 자동 갱신 기본 주기 `agenda_refresh_minutes`(60) · 소스별 주기 Slack/메일/캘린더/Jira/GitHub `agenda_source_minutes.*`(비우면 기본).
- **쓰기 액션**: 기본 말투 `reply_tone` · 소스별 그룹 토글 `actions.*`(위 "쓰기 액션") · 답장 말투 `reply_tone_by_source.*` · 오늘 한 액션.
- **Claude**: 모델 `claude_model`(비우면 기본) · 최대 턴 `claude_max_turns`(25) · 하루 사용 상한 `agenda_daily_budget_usd`(15, 닿으면 자동 실행과 대화가 멈춤, 버튼 실행은 계속).
- UI 없이 config.yaml 로만: `persona`, `port`, `notify`, `session_stale_minutes`, `draft_fast_model`, `draft_context_max_age_minutes`, `drafts_pregenerate`, `agenda_all_limit`, `agenda_context_batch`, `agenda_light_model`, `chat_ignore_budget`, `dashboard.layout`.
