# Changelog

## v0.1.1 (2026-03-26)

### Bug Fixes
- 에이전트 생성 시 시간 인지(time_aware), 스마트 스텝(smart_step), 최대 플랜 단계(max_plan_steps)가 저장되지 않던 버그 수정
- Windows Electron npm install spawn EINVAL 오류 수정 (CVE-2024-27980)
- 크론 스킬 힌트가 에이전트 스킬과 매칭되지 않던 버그 수정

### Features
- GitHub Actions CI/CD 파이프라인 (main 푸시 → 자동 빌드, 태그 푸시 → public 릴리스 자동 업로드)
- 서비스별 워크스페이스 폴더 열기 기능
- 랜딩 페이지 Windows 다운로드 활성화
- 에러 리포트 (Google Form) + Discord 커뮤니티 링크

### Chores
- 랜딩 페이지 정리 (GitHub 리포 링크 제거, hero 노트 통일, NanoClaw 레퍼런스 제거)
- 릴리스 & 배포 워크플로우 문서화

## v0.1.0 (2026-03-23)

- First Public Beta
