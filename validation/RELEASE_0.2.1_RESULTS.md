# 0.2.1 공개 배포 결과

배포일: 2026-10-27 · 상태: **GitHub·npm 배포 및 공개 설치 검증 완료**

- 릴리스: [v0.2.1](https://github.com/unk/ag-switch/releases/tag/v0.2.1)
- npm: [@naram/ag-switch 0.2.1](https://www.npmjs.com/package/@naram/ag-switch/v/0.2.1)
- CI: [Node.js 22·24 통과](https://github.com/unk/ag-switch/actions/runs/40440078953)
- [검증 결과 JSON](evidence/ag-switch-release-0.2.1.json)

같은 프로필을 여러 터미널·작업폴더에서 동시에 실행하도록 실행별 공유 잠금을 도입했다. 마지막 실행까지 setup·remove를 차단하며, 짧은 저장소 잠금은 최대 5초 기다린다. 이전 버전의 독점 잠금과 각 실행의 부모·자식 PID를 확인하는 unlock 복구도 유지했다.

릴리스 소스 커밋은 `c46938e7f44056ab634079f987e89e848d531372`이며 main과 v0.2.1 태그를 GitHub에 게시했다. 로컬 기본 자동 테스트 72개와 GitHub의 Node.js 22·24 테스트·패키지 dry run이 모두 통과했다. npm이 요구한 사용자 브라우저 본인 인증을 거쳐 public/latest로 게시했으며, 처리 완료 후 11:46 KST에 공개 레지스트리의 0.2.1·latest를 확인했다.

공개 tarball의 SHA-1은 `88f08e66bf28569a9515a66f0c0c9c9956091861`이며 배포 전 검증한 파일과 일치한다. GitHub 릴리스에도 같은 파일을 첨부했다. 빈 설치 경로·새 캐시로 공개 npm 배포본을 내려받아 설치하고, 설치 잠금 파일의 integrity와 제품 소스 6개가 배포 소스와 일치하는지 확인했다. 배포본의 version·help, 임시 프로필 생성, 실제 agy 1.4.7의 동일 프로필 동시 `--version` 실행 4개, 종료 후 잠금 0개, remove --purge와 빈 목록까지 확인하고 검증 프로필을 삭제했다.

동시 실행의 중첩 구간·마지막 실행까지 삭제 보호·독립된 종료 기록·복구는 모의 실행과 별도 프로세스 회귀 테스트로 확인했다. 실제 agy 검사는 버전 출력 범위이며 OAuth 요청을 보내지 않았다. 같은 프로필의 OAuth 동시 요청·동시 토큰 갱신은 아직 검증하지 않았다. 기존 두 프로필의 OAuth 검증을 이 범위의 근거로 확대하지 않는다.

기존 CLI를 모두 종료한 뒤 업데이트한다.

```sh
npm install -g @naram/ag-switch@0.2.1
ag-switch version
```

이전 공개 배포 기록은 [0.2.0 결과](RELEASE_RESULTS.md)에 보존한다.
