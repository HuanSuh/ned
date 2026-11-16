# 보안 정책 / Security Policy

## 지원 버전 / Supported versions

최신 `main`(플러그인 마켓플레이스가 설치하는 버전)만 보안 수정을 받는다. 이전 버전은 업데이트(`/plugin update ned` → `/reload-plugins` → `/ned:install`)로 받는다.

Only the latest `main` (what the plugin marketplace installs) receives security fixes. Older installs get them by updating.

## 제보 / Reporting a vulnerability

공개 이슈로 올리지 말고, GitHub 의 **Security → Report a vulnerability**(Private vulnerability reporting)로 비공개 제보한다.
재현 단계, 영향, 확인한 버전(`.claude-plugin/plugin.json` 의 `version`)을 적어 주면 좋다. 확인 후 답하고, 수정은 새 버전으로 낸다.

Please do not open a public issue. Report privately via GitHub **Security → Report a vulnerability** (Private vulnerability reporting),
with steps to reproduce, impact, and the version you tested (`version` in `.claude-plugin/plugin.json`).

## 범위 / Scope

범위 안 / In scope:
- 로컬 데몬 — `127.0.0.1` 의 대시보드·`/api/*`·`/mcp` (예: DNS rebinding·다른 출처에서의 호출, 쓰기 액션 게이트 우회)
  / the local daemon on `127.0.0.1`: dashboard, `/api/*`, `/mcp` (e.g. DNS rebinding, cross-origin calls, bypassing write-action gates)
- 다른 사이트·같은 Mac 의 다른 포트 페이지가 브라우저로 일으키는 부수효과 있는 요청(예: `<img>` 로 비용이 드는 GET 반복 호출)
  / side-effecting requests a page on another site or another local port triggers through the browser (e.g. costly GETs via `<img>`)
- Ned.app (메뉴 막대 앱, WKWebView 브리지) / Ned.app (menu bar app, WKWebView bridges)
- 설치·업데이트 스크립트 (`scripts/*.sh`, `/ned:install`, 자동 업데이트) / install and update scripts

- 대화창 쓰기(확인 카드)의 Slack 대상(붙인 링크·Ned 가 찾은 대상)과 멘션 해석 — 모델과 모델이 읽은 메시지(프롬프트 인젝션 포함)는 신뢰하지 않는다. 서버 검사: 대상은 agenda·사용자가 직접 붙인 링크·Slack 메시지 도구 결과의 필드(본문 제외)와 채널 + 실제 답글 위치로 일치, 다른 워크스페이스 거부, 멘션 ID 는 본문에 남은 멘션의 후보(사용자가 넣은 ID 는 + 실제 전송으로 확인된 캐시)만, 모델이 쓴 ID·전체 알림(@here 등) 거부, 그룹 ID 는 설정만, 하루 상한, 이름 모르는 채널은 이름 규칙이 있으면 확인 후. 이를 우회해 사람이 카드에서 보지 못한 곳·사람에게 보내게 되는 경우는 범위 안
  / chat-proposed Slack sends (pasted links, threads Ned found) and mention resolution — the model and anything it read are untrusted; bypassing the server checks above so a send reaches a thread or a person the card did not show is in scope

범위 밖 / Out of scope:
- claude.ai 커넥터(Slack·Gmail·Google Calendar·Atlassian·GitHub)와 Claude Code 자체 — 각 제공자에게 제보한다
  / claude.ai connectors and Claude Code itself — report those to their providers
- 이 Mac 의 사용자 계정을 이미 가진 공격자(로컬 사용자 권한으로 `~/.ned` 를 읽거나 쓰는 것)
  / an attacker who already controls the local user account (reading or writing `~/.ned` as that user)
