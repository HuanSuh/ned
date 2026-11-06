# Ned 대시보드 디자인 리서치 (2026-11)

Ned 는 "모니터 속 비서"다. 에이전트 세션과 업무 신호를 지켜보다 **필요할 때만** 알려 준다. 그래서 참고할 질문은 셋이다. 지금 나를 필요로 하는 것을 어떻게 맨 위에 올리는가, 시간 흐름을 어떻게 보여 주는가, "새것 없음"을 어떻게 조용히 처리하는가.

## 살펴본 제품
| 범주 | 제품 | 관찰 |
|---|---|---|
| 비서·브리핑 | [Laya](https://github.com/aayushch/laya) | 작업 단위가 **Action Card** (승인/닫기). 아침 브리핑은 밤사이 활동·대기 카드·오늘 캘린더. Omni 뷰는 Attention → Recent → Period → Milestone 의 시간 층으로 갈수록 요약을 압축 |
| 트리아지 | [Linear Inbox](https://linear.app/docs/inbox) | 목록 + 상세 split, **Priority / Other 탭**, `J/K` 이동, `U` 읽음, `H` 스누즈, `Backspace` 삭제. 상세에서 바로 액션 |
| 메일 | [Superhuman Split Inbox](https://help.superhuman.com/hc/en-us/articles/38458483333907) | 소수의 집중 스트림으로 쪼개고, 라벨은 행 단위 시각 표시. 키보드 우선 |
| 이슈 스트림 | [Sentry 새 이슈 상세](https://sentry.io/changelog/new-issue-details-ui-now-available/) | "강한 정보 위계 + 점진적 공개": 트리아지 액션을 상세와 분리, 섹션 접기, 부가정보는 drawer |
| 관제 | [Grafana best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices.md) | 대시보드는 질문 하나에 답한다. 일반 → 구체, 큰 것 → 작은 것. 색은 의미(임계값)에만 |
| 런처 | Raycast ([추출된 디자인 토큰](https://design.hagicode.com/designs/raycast/DESIGN.md), 비공식) | near-black 캔버스 + 회색 elevation, 강조색 하나를 아껴 씀, 시스템 폰트 |
| menu bar | [so-agentbar](https://sotthang.github.io/so-agentbar/), [Claude Status](https://github.com/FatNine/claude-status-plugin) | 세션마다 소스 배지 + AI 생성 제목(경로 대신), 서브에이전트는 부모 밑에 `🤖×N` 로 접기. 상태는 active/waiting/idle/compacting |
| 아침 브리핑 | [daily.dev Presidential Briefing](https://docs.daily.dev/docs/plus/presidential-briefing), [Readwise Daily Digest](https://docs.readwise.io/reader/docs/faqs/daily-digest) | 3단(Must know / Good to know / Critical), **3~5분 분량**이 약속. 지난 브리핑은 자동 보관. Readwise 는 아직 안 본 digest 에만 배지 |
| 데스크탑 브리핑 예시 | [OpenDesign morning briefing](https://open-design.ai/showcase/morning-briefing-dashboard-design/) | 가운데 인사 + 날짜, 요약 카드 다섯 개, 그 아래 번호 매긴 우선순위 3개 |

Mem, Things 3, Arc 는 공개된 디자인 자료를 찾지 못해 위 사례로 대신했다.

## 가져올 패턴 10가지
1. **질문 하나에 답하는 첫 화면.** 맨 위는 "지금 내가 할 일이 있나?"에만 답한다(Grafana). 숫자 하나와 문장 하나면 된다. 나머지는 그 아래로 내린다.
2. **Priority / Other 두 갈래.** Linear 의 탭처럼 attention(행동 필요)과 updates·fyi(읽기만)를 시각적으로 분리한다. 브리핑 3분류와 그대로 대응한다.
3. **행 = 카드 = 하나의 결정.** Laya 의 Action Card 처럼 각 항목에 결정 하나(열기 / 닫기)만 붙인다. 버튼을 늘리지 않는다.
4. **목록 + 상세 split 과 `J/K`.** 항목이 10개를 넘는 날은 split 이 가장 빠르다. `J/K` 이동, `E` 닫기, `Enter` 열기, `?` 도움말.
5. **점진적 공개.** 헤드라인 → 항목 → 상세 → raw 순으로 펼친다(Sentry). `NED_OK` 브리핑과 비용·id 는 기본 접힘.
6. **색은 상태에만.** waiting=주황, error=빨강, running=초록, done=중립. 강조색은 하나만 쓰고 링크·선택에만 쓴다(Raycast, Grafana).
7. **"새것 없음"은 성공 상태.** 빈 섹션은 숨기고 한 줄로 끝낸다. 예: "조용합니다 · 다음 점검 6분 후". NED_OK 가 연달아 나오면 "NED_OK ×5" 처럼 접는다.
8. **시간 층으로 압축.** 타임라인은 최근 것은 자세히, 오래된 것은 요약으로 보인다(Laya Omni). 날짜 구분선과 상대 시간을 함께 쓴다.
9. **경로 대신 사람이 읽는 이름.** 워크트리 이름과 마지막 요약을 제목으로 쓴다. 서브에이전트는 `×N` 배지로 접는다(so-agentbar).
10. **브리핑은 분량을 약속한다.** "3분 브리핑"처럼 길이를 예측할 수 있어야 아침에 연다(daily.dev). 항목 수 상한과 접힌 "나머지 N건"을 둔다.

## 타이포·밀도·다크 모드
- 본문은 시스템 산세리프(-apple-system, Apple SD Gothic Neo)를 쓴다. 숫자와 시간은 tabular-nums 로 정렬한다. 로그·ID 에만 monospace 를 쓴다.
- 밀도는 표면에 따라 다르게 간다. 메모형은 넉넉하게, 관제형은 행 높이 24~28px, 사이드 패널은 카드 하나에 집중한다.
- 다크 모드는 순흑이 아닌 near-black 위에 1~2단계 elevation 을 둔다. 상태색은 다크에서 채도를 약간 낮추고 배경 틴트(15~18%)로 쓴다.
