# 제품 런처 OAuth 통합 검증

이 절차는 제품이 생성한 `store/bin/ag-check-a`, `store/bin/ag-check-b`를 실제로 실행한다. PoC의 원래 경로로 직접 `agy`를 실행한 결과와 구분한다. 검증 도구는 개발용 `scripts/validate-oauth.mjs`이며 npm 배포 파일에는 포함하지 않는다.

## 완료한 실행

2026-10-27 실행은 **제품 OAuth 검증 전체 통과 후 08:51 KST에 정리 완료**했다. [결과](RESULTS.md)와 [공유 JSON](evidence/ag-switch-oauth-dIvoAC.json)에 판정·근거를 보존했다.

기존 `/private/tmp/ag-switch-oauth-dIvoAC`의 프로필·런처·인증·비교 기준·HMAC 키·검증 상태는 모두 삭제됐다. 이 경로의 명령은 더 이상 실행할 수 없다. 새 검증은 아래 `init`으로 시작한다. 실행 중에는 로그인·자연 갱신·로그아웃·재로그인을 모두 마치기 전에 루트를 삭제하지 않는다.

`login`은 계정 두 개가 다름을 HMAC 지문으로 비교하고, 프로필별 표식이 있는 대화를 생성한다. `reconnect`는 새 프로세스로 A → B → A를 실행해 기존 대화의 표식을 복원한다. `concurrent`는 두 요청의 실행 구간이 실제 겹치는지, A 종료 중 B 응답과 B 유지 중 A 재시작이 동작하는지 확인한다. 설정 파일에 임시 테마를 쓰는 기존 PoC P4 검사는 이 도구의 동시 실행 검사에 포함하지 않는다.

`renewal`은 앞 단계 직후 기록한 토큰의 자연 만료를 기다린다. 아직 만료 전이면 요청을 보내지 않고 `natural-expiry-pending`과 `nextCheckAt`을 출력한다. 해당 시각 이후 같은 명령으로 재개한다. 만료값이나 시스템 시각을 바꾸지 않는다. 대기 중 다른 실행이 토큰을 갱신했다면 관찰 기준을 덮어쓰지 않고 중단한다.

각 단계는 앞 단계 통과 기록을 요구한다. 통과한 단계를 다시 실행해 기록을 덮어쓰지 않는다. 원래 기준 대비 기존 파일·키체인 차이가 생기면 요청 전에 중단한다. 정상 앱 사용으로 생긴 차이도 자동 승인하지 않으며, 원인·시점을 검토해 별도 재개 절차를 결정한다. `status`는 상태와 인증 파일 유무·만료 시각만 보여주고 모델 요청을 보내지 않는다.

차이를 검토했다면 `verify --baseline-review evidence/baseline-review.json`으로 명시적인 검토 기록을 연결할 수 있다. 기존 PoC와 같은 `ag-switch-baseline-review-v1` 형식을 사용하고, `originalBaselineSha256`은 원래 기준 객체의 `baselineDigest()` 값이다. 검토 기록에는 원본 식별자·허용한 차이·체크포인트·비밀값 없는 검토 설명이 필요하며, 출처가 다르거나 검토 이후 추가 변화가 있으면 재개하지 않는다. 검토 기록을 자동 생성해 차이를 승인하는 명령은 없다. 원인을 확정하지 못했다면 그 사실도 남긴다. 원본 차이는 단계 보고서의 `originalComparison`에 유지하고 실제 요청 구간 비교와 구분한다.

## 새 검증 시작

```sh
node scripts/validate-oauth.mjs init
# 출력된 root를 지정
AG_VALIDATION_ROOT=/private/tmp/ag-switch-oauth-새실행ID
node scripts/validate-oauth.mjs probe --root "$AG_VALIDATION_ROOT"
```

빈 프로필 검사 통과 후 사용자 터미널에서 두 런처에 각각 다른 Google 계정으로 공식 로그인하고 각 CLI를 종료한다(Ctrl+C 두 번). 인증 URL·코드·토큰·이메일을 채팅이나 저장소에 붙여 넣지 않는다.

```sh
"$AG_VALIDATION_ROOT/store/bin/ag-check-a"
"$AG_VALIDATION_ROOT/store/bin/ag-check-b"

node scripts/validate-oauth.mjs verify --root "$AG_VALIDATION_ROOT" --stage login
node scripts/validate-oauth.mjs verify --root "$AG_VALIDATION_ROOT" --stage reconnect
node scripts/validate-oauth.mjs verify --root "$AG_VALIDATION_ROOT" --stage concurrent
node scripts/validate-oauth.mjs verify --root "$AG_VALIDATION_ROOT" --stage renewal
```

`init`은 검증된 바이너리를 검사하고 제품 API로 새 저장소·프로필 두 개를 만든다. 기존 기본 인증이 있는 이 머신에서는 키체인 항목을 관찰하지 못하면 준비를 중단한다. macOS 샌드박스는 실제 항목에도 `absent`를 반환할 수 있으므로 `init`·`probe`·`verify`는 동일한 실제 사용자 권한에서 실행한다. 키체인은 비밀값 없는 메타데이터만 비교한다. `security -g/-w`는 사용하지 않는다.

`probe`는 제품 런처로 빈 프로필을 실행하고, 각 20초 제한 안에서 미로그인 상태·SSH 감지 파일 인증 선택·오류 기반 우회 없음·인증 파일 없음·기존 환경 무변경을 확인한다. 미로그인 CLI가 대기해 시간 제한에 도달했다는 사실 자체를 성공으로 판정하지 않는다. 표준 출력·로그 관찰과 비교 결과가 모두 충족돼야 통과한다. 이 단계가 통과하기 전에는 로그인하지 않는다.

검증 상태는 전용 루트의 `validation.json`, 비밀값 없는 단계 보고서는 `evidence/`, 프로세스 식별·종료 기록은 `sessions/`에 저장한다. 원시 응답·인증 URL·이메일·토큰은 보고서에 저장하지 않는다. 인증 파일을 읽는 기능은 이 개발용 도구에만 있으며 제품 CLI의 `doctor`와 구분한다. 보고서에는 HMAC 지문도 노출하지 않는다.

## 후속 로그아웃 검증과 정리

자연 갱신 통과 후 A의 공식 `/logout`과 사용자 재로그인, B·기본 키체인 대조군 유지를 검사한다. 관리 명령은 다음 순서로 실행한다.

```sh
node scripts/validate-logout.mjs prepare --root "$AG_VALIDATION_ROOT"
# 사용자 터미널에서 A 런처 실행 → /logout → 종료. 아직 재로그인하지 않음.
node scripts/validate-logout.mjs check --root "$AG_VALIDATION_ROOT"
# awaiting-relogin이면 A 런처에서 원래 A 계정으로 공식 로그인 후 종료.
node scripts/validate-logout.mjs relogin --root "$AG_VALIDATION_ROOT"
```

`prepare`는 기본 키체인 인증의 실제 응답과 파일 인증 부재를 확인하고 A·B 비교 체크포인트를 저장한다. `check`는 A 인증 파일 제거·로그인 요구, B의 인증 파일 불변·대화 응답 및 기본 계정 응답을 확인한다. B 인증이 예상 밖으로 바뀌었으면 추가 요청 전에 중단한다. `relogin`은 원래 A 계정과 대화 복원, B 유지, 기본 계정의 실제 응답을 확인한다. 로그아웃 검증 완료 전에는 A·B 데이터를 보존한다.

평상시 Google 계정 사용을 중지할 필요는 없다. 기본 키체인 메타데이터 변화는 원인 분류를 위한 관찰 자료로 보존하며, 그 변화 하나로 인증 격리 실패를 판정하지 않는다. 실제 인증·대화 응답, A·B의 계정·토큰 독립성과 기본 설정 무변경을 검사한다. 기본 키체인 대조 요청 자체가 자연 갱신을 일으킬 수도 있으므로 프로필 요청 구간과 대조 요청 구간의 비교를 나누어 기록한다.

전체 결과를 보존한 뒤 제품의 `remove --purge --yes --root <root>/store`로 각 전용 프로필을 정리하고 기존 환경을 다시 비교한다. 자동으로 실행 루트 전체를 삭제하는 명령은 제공하지 않는다. 강제 종료로 남은 제품 잠금은 실제 프로세스가 모두 종료됐는지 확인한 뒤 `node src/cli.mjs unlock <이름> --root <root>/store`로 복구한다. 검증 도구 자체의 `locks/store.json`은 별도 잠금이므로 제품 저장소의 잠금과 혼동하지 않는다.

현재 실제 결과는 [RESULTS.md](RESULTS.md)에 기록한다.
