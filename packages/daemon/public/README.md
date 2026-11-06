# Ned 대시보드 (`public/index.html`)

daemon(`src/server.ts`) 이 `http://127.0.0.1:<port>/` 에서 그대로 서빙하는 **단일 파일** 로컬 대시보드.
빌드 단계·프레임워크·CDN 의존성 없음 (오프라인 동작). 시스템 폰트, `prefers-color-scheme` 라이트/다크.

## 섹션
| 섹션 | 데이터 | 비고 |
|---|---|---|
| 헤더 | `GET /api/state` | daemon 생존 표시(`updated_at` 20분 이내), 마지막/다음 점검, 조용한 시간 배지, `지금 점검`(`POST /api/heartbeat`) · `아침 브리핑 생성`(`POST /api/heartbeat?daily=1`) — 1~3분 걸리므로 busy 상태 표시 |
| 지금 봐야 할 것 | `state.attention` | kind 아이콘(session/email/slack/jira/github/sentry/calendar/other), 링크, 닫기(`POST /api/attention/:id/dismiss`) |
| 에이전트 세션 | `state.sessions` | 워크트리·상태(색상)·마지막 요약/프롬프트·서브에이전트 수·상대 시간 |
| 브리핑 히스토리 | `GET /api/briefings?limit=30` | 최신순, 펼치면 headline/action_items/updates/fyi/sessions/cost/raw. `NED_OK` 는 접힘·흐리게 |
| 타임라인 | `GET /api/events?days=2` + 브리핑 | ts 로 병합, 이벤트 유형·워크트리 칩 필터 |
| 설정 | `GET/PUT /api/config` | heartbeat/신호 간격, 브리핑 시각, 조용한 시간, 소스 토글(`config.sources` 키에서 자동 생성), claude_model, claude_max_turns |

## 갱신 주기
- `/api/state` 10초 폴링(탭이 다시 보이면 즉시).
- 이벤트·브리핑·설정은 로드 시 + 각 섹션의 새로 고침 버튼 + 점검 완료 후.

## 로컬 확인
daemon 을 `NED_HOME=/some/fixture` 로 띄우거나, 같은 라우트를 흉내내는 간단한 http 서버로 이 파일을 서빙하면 된다.
