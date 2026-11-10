# Ned — 작업 규칙

- **기능 문서 유지**: 기능을 추가/변경하면 `docs/FEATURES.md` 의 해당 항목과 맨 위 "요약" 섹션도 같은 커밋에서 같이 고친다.
  요약은 Ned 대화창(Ned Net) 시스템 프롬프트에 그대로 들어간다(`packages/daemon/src/chat.ts` `readFeaturesSummary`, 최대 3,000자 — 요약은 2,500자 이내로 유지).
  `pnpm test` 의 features-doc-coverage(`packages/daemon/test/features-doc-coverage.test.ts`)가 누락을 잡는다 — 설정 키·설정 탭 입력·`/api` 라우트가 문서에 없으면 실패. 일부러 빼는 항목은 그 파일의 `ALLOWLIST` 에 사유와 함께.
- 상세 동작·API 는 `packages/daemon/README.md`, 대시보드 구조는 `packages/daemon/public/README.md`.
- **브랜치**: `dev` = 통합(워커 브랜치 → 리뷰 → `--no-ff` 머지 → push, 동료 PR 도 dev 로), `main` = 설치본(플러그인 마켓플레이스 기본 브랜치 — 직접 커밋 금지).
  dev → main 승격(설치 확인 → `.claude-plugin/plugin.json` version + `CHANGELOG.md` → `merge --ff-only` → 태그)은 `docs/RELEASE.md`. version 을 안 올리면 사용자의 `/plugin update` 가 아무것도 받지 않는다.
- 테스트 `pnpm test`, 빌드 `pnpm -s build`. 테스트는 임시 `NED_HOME` 에서 돈다 — 실제 `~/.ned`·포트 7777 은 건드리지 않는다.
