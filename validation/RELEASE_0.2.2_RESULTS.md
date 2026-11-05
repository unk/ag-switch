# 0.2.2 공개 배포 결과

배포일: 2026-11-06 · 상태: **GitHub·npm 배포 및 공개 npx 설치 검증 완료**

- 릴리스: [v0.2.2](https://github.com/unk/ag-switch/releases/tag/v0.2.2)
- npm: [@naram/ag-switch 0.2.2](https://www.npmjs.com/package/@naram/ag-switch/v/0.2.2)
- CI: [Node.js 22·24 통과](https://github.com/unk/ag-switch/actions/runs/42061326445)
- [검증 결과 JSON](evidence/ag-switch-release-0.2.2.json)

agy 업데이트 후 실행을 차단하던 검사를 안내로 바꾸고, 검증한 agy 1.5.1 바이너리를 지원 목록에 추가했다. doctor도 호환성 안내만으로 실패 종료하지 않는다. 기존 1.4.7 지원은 유지한다. 새 런처는 실행 코드를 저장소에 보관하여 npx 캐시 삭제 후에도 동작하며, 기존 이름의 설정 수정·보존 데이터 재사용·백업 후 재생성을 제공한다.

## 소스와 패키지

릴리스 소스 커밋은 `a97fd70944ff64a68536d3a37f51f20ae0379546`이다. 로컬 테스트 83개와 GitHub Node.js 22·24 테스트·패키지 dry run이 통과했다. GitHub의 HTTPS·SSH Git 전송이 원격 commit_refs 오류를 반환하여 Git API로 동일한 트리와 커밋 SHA를 생성하고 main을 비강제 갱신했다. v0.2.2 태그도 같은 커밋을 가리킨다.

배포 파일은 코드·문서·비밀값 없는 결과 27개이며 인증·프로필 런타임이나 npm 설정은 포함하지 않는다. npm 브라우저 로그인과 게시 본인 인증을 완료한 뒤, 검증한 tarball을 public/latest로 게시했다. 처리 완료 후 공개 레지스트리의 0.2.2와 latest를 확인했다.

공개 npm tarball SHA-1은 `a998dcdd072d7cb8b5373d683ce72f1c9f648d56`이다. GitHub 릴리스에도 같은 파일을 첨부했고, 공개된 첨부 파일을 다시 다운로드하여 해시가 일치함을 확인했다.

## 실제 설치 검사

- 배포 전 tarball을 새 임시 경로에 설치하여 버전·도움말·소스 7개 일치를 확인했다. 사라진 npx 경로를 가리키는 기존 런처를 setup으로 갱신하고, 설치 폴더를 삭제한 뒤에도 런처가 실행됨을 확인했다. 검증용 합성 인증 파일은 유지됐다.
- 공개 npm 반영 후 빈 작업폴더·새 캐시에서 `npm exec --package @naram/ag-switch@latest`로 실제 배포본을 내려받아 version=0.2.2·도움말을 확인했다.
- 별도 공개 설치의 잠금 파일 integrity·소스 7개가 검증한 tarball·배포 소스와 일치했다.
- 공개 배포본으로 임시 프로필을 만들고 실제 agy 1.5.1의 같은 프로필 동시 `--version` 실행 2개를 수행했다. 안내 출력 없음·doctor 정상·종료 후 잠금 0개·프로필 삭제와 빈 목록을 확인했다.

릴리스 설치 검사에서는 OAuth 요청을 보내지 않았다. 1.5.1의 실제 두 계정 응답·재접속·동시 실행 10개 요청은 [업그레이드 호환성 결과](AGY_1.5.1_RESULTS.md)에 별도로 기록했다. 새 로그인·통제된 자연 갱신·로그아웃/재로그인 재검증까지 포함한 결과로 확대하지 않는다.

## 기존 사용자 업데이트

패키지 업데이트만으로 기존 런처의 코드 참조가 바뀌지는 않는다. 해당 프로필의 실행을 모두 종료한 뒤 최신 패키지에서 setup을 실행하고 기존 실행 방식을 유지해 적용한다. 인증·대화 삭제나 재등록은 필요하지 않다.

```sh
npx @naram/ag-switch@latest version
npx @naram/ag-switch@latest setup ag-work
```

ag-work는 실제 프로필 이름으로 바꾼다. 전역 설치 사용자는 `npm install -g @naram/ag-switch@latest` 후 `ag-switch setup ag-work`를 실행한다.
