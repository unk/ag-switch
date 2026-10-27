# 0.2.0 공개 배포 결과

배포일: 2026-10-27 · 상태: **GitHub·npm 배포 및 공개 설치 검증 완료**

- 저장소: [unk/ag-switch](https://github.com/unk/ag-switch)
- 릴리스: [v0.2.0](https://github.com/unk/ag-switch/releases/tag/v0.2.0)
- npm: [@naram/ag-switch 0.2.0](https://www.npmjs.com/package/@naram/ag-switch)
- [검증 결과 JSON](evidence/ag-switch-release-0.2.0.json)

## GitHub

이 작업 폴더를 main 브랜치의 Git 저장소로 초기화하고 origin을 `https://github.com/unk/ag-switch.git`으로 연결했다. 검증된 소스·문서·공유 결과·MIT 라이선스·CI를 커밋하고 main과 v0.2.0 태그를 푸시했다. HTTPS 인증 토큰에는 workflow 권한이 없어 첫 푸시가 거절됐고, 기존 SSH 인증을 사용한 명령별 연결로 정상 푸시했다. origin URL은 요청한 HTTPS 주소를 유지했다.

릴리스 소스 커밋은 `8734eaaeb8632a633f134aeb5d84be51563e08ef`다. [GitHub CI](https://github.com/unk/ag-switch/actions/runs/40426267321)에서 Node.js 22·24의 테스트와 패키지 dry run이 모두 통과했다. 공개 GitHub 릴리스에는 npm 게시 파일과 같은 tarball을 첨부했다.

## npm

계정 로그인과 npm이 요청한 브라우저 본인 인증을 완료한 후 `@naram/ag-switch@0.2.0`을 public/latest로 게시했다. npm 처리 중 잠시 보였던 `0.0.0-stage` 상태가 끝난 뒤, **09:28 KST**에 공개 레지스트리의 0.2.0과 latest 태그를 확인했다.

공개 tarball의 SHA-1은 `823bb5fba9b10ed49c022d3cc430bdf54fcb454e`로 배포 전 검증한 파일과 일치한다. 새 임시 작업폴더와 빈 캐시에서 `npm exec --package @naram/ag-switch@0.2.0`으로 실제 레지스트리 배포본을 내려받았고 `ag-switch version`이 0.2.0을 출력하며 도움말에 setup 명령이 있는지 확인했다. 검증용 폴더·캐시는 정리했다.

```sh
npx @naram/ag-switch

# 전역 설치
npm install -g @naram/ag-switch
ag-switch
```

배포 전 로컬 기본 테스트 67개가 통과했다. fish까지 포함한 기존 68개 검사, 실제 두 계정 OAuth 수명주기, 실제 PTY·세 셸 설치 검증은 별도 결과에 보존했다. 배포 tarball은 공개 소스·문서·비밀값 없는 결과만 포함하며 npm 인증 설정과 프로필 런타임 데이터는 포함하지 않는다.
