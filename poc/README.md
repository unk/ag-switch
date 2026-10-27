# 멀티 프로필 PoC 실행 방법

macOS의 공식 `agy`와 Node.js 22 이상이 필요합니다. `node poc/run.mjs`는 설치·셸 별칭 변경 없이 실행합니다. 기본 바이너리는 `~/.local/bin/agy`이며, 다른 경로는 `init --binary /absolute/path/agy`로 지정합니다.

이 도구는 [계획서](../POC_PLAN.md)의 P0~P7 실험을 돕습니다. 실제 통과 여부는 관찰 근거를 검토한 뒤 `record`로 기록합니다. 명령이 성공했다는 사실만으로 실험 단계를 자동 통과시키지 않습니다.

## 완료한 실험

2026-10-26~27에 **P0~P7 전체를 통과**했습니다. [결과표](RESULTS.md)와 [공유 결과 JSON](evidence/ag-switch-poc-O92xjF.json)에 판정·근거를 보존했습니다.

기존 실험 루트 `/private/tmp/ag-switch-poc-O92xjF`는 P7에서 삭제했습니다. 이 경로의 `launch`·`check`는 더 이상 실행할 수 없습니다. 새 실험은 아래 `init`으로 시작하고 A·B를 다시 로그인합니다.

## 새 실험 시작: P0

```sh
node poc/run.mjs init
```

출력된 `root`를 아래 변수에 지정합니다. 고정된 기존 프로필 경로를 재사용하지 않고 실행마다 별도의 루트를 만듭니다.

```sh
AG_POC_ROOT=/private/tmp/ag-switch-poc-새실행ID
node poc/run.mjs inspect --root "$AG_POC_ROOT"
node poc/run.mjs check --root "$AG_POC_ROOT"
```

`inspect`는 버전과 SHA-256, 공개 도움말, 두 경로 옵션의 **값 누락 오류**를 확인합니다. 알 수 없는 옵션과 함께 `--help`가 성공하는 동작은 옵션 지원 근거로 사용하지 않습니다. `staticMarkers`는 바이너리 안의 문자열 존재 여부만 의미합니다. 새 버전에서는 SSH 감지·저장소 선택과 업데이트 억제 조건을 별도로 다시 확인해야 합니다.

검증한 1.4.7은 `AGY_CLI_DISABLE_AUTO_UPDATE=true`로 자동 업데이트를 억제합니다. `1`은 해당 버전의 억제 조건과 다릅니다. 도구는 각 실행 전후 바이너리 해시를 비교해 교체를 발견하면 중단합니다. 외부에서 바이너리를 갱신했다면 새 run으로 다시 시작합니다.

`init`은 기존 설정·인증 파일의 해시·시각·권한, `gemini` 서비스의 첫 키체인 일치 항목 메타데이터 다이제스트를 수집합니다. `security`에 `-g`·`-w`를 전달하지 않으며 비밀값을 읽지 않습니다. 계정 레이블이나 메타데이터 원문도 저장하지 않습니다. 여러 일치 항목 전체를 열거하는 비교는 지원하지 않습니다.

**macOS 샌드박스 안의 키체인 조회는 실제 존재하는 항목에도 `absent`를 반환할 수 있습니다.** 이 실험에서는 실제 사용자 터미널에서 일관된 권한으로 `init`·`inspect`·`probe`·`check`를 실행해야 합니다. 키체인 부재만으로 기존 인증이 없다고 결론 내리지 않습니다. `unavailable`이 나오거나 권한 조건을 확인할 수 없다면 P0을 통과 처리하지 않습니다.

기준 상태와 옵션·업데이트 억제 조건을 검토한 다음 기록합니다.

```sh
node poc/run.mjs record --root "$AG_POC_ROOT" --stage P0 --status pass \
  --note '현재 버전·해시·경로 옵션·업데이트 억제 조건과 실제 사용자 권한의 전후 비교 기준 확인'
```

## 빈 프로필 검사: P1

```sh
node poc/run.mjs probe --root "$AG_POC_ROOT"
```

A·B를 순서대로 실행합니다. 이 명령은 완전히 빈 프로필에만 허용되며, 새 run에서 `--profile a` 또는 `--profile b`로 한쪽만 검사할 수도 있습니다. 기존 인증을 예상치 않게 재사용하더라도 요청 범위는 짧은 텍스트 응답으로 제한합니다.

`probe`는 `-p`로 짧은 요청을 실행하고 원시 출력을 메모리에서만 관찰합니다. 인증되지 않은 headless CLI가 계속 대기하면 각 프로세스 그룹에 20초 뒤 SIGTERM, 이후 필요 시 SIGKILL을 보냅니다. `timedOut: true`는 실행 제한에 도달했다는 뜻이며, 그 자체로 통과나 실패가 아닙니다.

출력·로그에서 다음을 검토합니다.

- `sshFileStorage: true`: 명시적인 SSH 감지에 따른 파일 저장소 선택 메시지. 표준 출력에는 없어도 CLI 로그에서 관찰할 수 있습니다.
- `fallbackStorage: false`: 키체인 오류·시간 초과에 따른 우회 메시지가 없음.
- `loginRequired: true`, `authSucceeded: false`: 기존 계정으로 자동 인증되지 않음.
- `files.directories`: 각 프로필 안의 `antigravity-cli`와 `config` 등 실제 생성 경로.
- `baselineChanges.files: []`, `baselineChanges.keychain: false`: 비교 대상 기존 파일·키체인 메타데이터에 변화가 없음.

전체 파일 메타데이터·해시는 전용 루트의 `evidence/probe-*.json`에 있습니다. 일치 메시지가 없으면 자동으로 실패를 단정하지 말고 원인을 확인합니다. 반대로 로그인 성공, 비교 대상 변경 또는 오류 기반 저장소 우회가 관찰되면 도구가 P1을 실패 처리하고 후속 로그인을 차단합니다. 계정·인증 저장소 분리가 실패한 경우 기본 키체인을 교체하거나 복원하지 않습니다.

저장소 선택, 미로그인 상태, 지정 경로 사용과 전후 비교를 모두 확인했다면 기록합니다.

```sh
node poc/run.mjs record --root "$AG_POC_ROOT" --stage P1 --status pass \
  --note 'A·B의 SSH 감지 파일 저장소 선택·미로그인 상태·프로필 내부 경로와 기존 비교 대상의 무변경 확인'
```

## 로그인 이후: P2~P6

`launch`는 P0·P1 통과 기록과 실제 TTY를 요구합니다. 두 프로필은 같은 임시 `workspace/`를 사용합니다. 동일 프로필의 중복 실행은 차단하고 A·B의 동시 실행은 허용합니다. 자식 환경에는 최소 SSH 감지 변수인 `SSH_TTY`만 설정하고 기존 SSH 변수, API 키·ADC·게이트웨이·인증 경로 관련 환경변수는 제거합니다. `HOME`과 셸 설정은 바꾸지 않습니다. 임시 파일과 XDG 경로도 이 run 내부로 지정합니다.

| 단계 | 실제 확인할 내용 |
| --- | --- |
| P2 | A·B가 서로 다른 계정이며 짧은 응답이 정상 동작. 인증 파일이 각 프로필 안에 생성되고 권한이 0600인지, 키체인 비교 결과와 기존 기본 인증이 유지되는지 확인. |
| P3 | CLI를 종료한 뒤 A → B → A 순서로 재접속. 재로그인 없이 계정·설정·대화 목록이 복원되는지 확인. |
| P4 | 터미널 두 개에서 A·B를 동시에 실행. 서로 다른 짧은 요청·설정·대화를 사용하고 한쪽 재시작이 다른 쪽에 영향을 주지 않는지 확인. |
| P5 | 접근 토큰의 **자연 만료** 후 A·B에서 인증 요청·재접속. 각 인증 파일의 갱신과 동일 계정 유지, 기존 기본 인증 무영향을 확인. |
| P6 | A에서 `/logout`. A만 로그아웃되고 B와 기존 기본 환경은 인증을 유지하는지 확인한 뒤 A에 재로그인. |

P1 통과 후 실제 사용자 터미널에서 A·B를 각각 다른 계정으로 로그인합니다. 공식 URL은 본인의 브라우저에서 열고 인증 코드는 해당 CLI 입력란에만 입력합니다. 인증 URL·코드·토큰·실제 이메일은 공유하지 않습니다. 종료는 `Ctrl+C` 두 번입니다.

```sh
node poc/run.mjs launch --root "$AG_POC_ROOT" --profile a
node poc/run.mjs launch --root "$AG_POC_ROOT" --profile b
```

각 단계를 마친 뒤 `check` 결과와 직접 관찰을 함께 검토하고 기록합니다. 기록은 앞 단계가 통과한 경우에만 `pass`를 허용하며, 앞 단계 기록을 바꾸면 뒤 단계 판정을 `unverified`로 되돌립니다.

```sh
node poc/run.mjs check --root "$AG_POC_ROOT"
node poc/run.mjs record --root "$AG_POC_ROOT" --stage P2 --status pass \
  --note '서로 다른 두 계정의 응답·프로필별 인증 파일·권한·기본 환경 무영향 확인'
```

`verify --stage P2|P3|P4|P5`는 파일 인증 비교와 실제 응답을 자동 관찰합니다. P2는 두 표식으로 대화를 생성하고, P3는 저장된 대화를 A → B → A로 재개합니다. P4는 동시에 요청하고 A 종료·재시작 중 B 응답을 확인하며, 프로필별 설정 파일 값을 임시로 다르게 지정한 후 복원합니다. P5는 자연 만료 후 두 프로필의 갱신과 A 갱신 중 B 인증 불변을 검사합니다. 실행 중인 같은 run의 CLI는 먼저 종료해야 합니다. 이 명령은 단계 순서를 검사하지만 결과를 자동 `record`하지 않습니다.

검증 상태·계정 및 토큰 HMAC 지문은 `evidence/verification-state.json`에만 저장합니다. 원시 이메일·토큰은 결과 보고서에 남기지 않습니다. 각 검증은 실행 직전·직후를 비교하며, `check`의 원래 P0 기준 비교 결과도 계속 보존합니다. 기본 앱 사용으로 생긴 기존 차이를 새 기준으로 몰래 덮어쓰지 않습니다.

다음 단계들도 `--stage`와 실제 근거를 바꿔 같은 방식으로 기록합니다. `check`는 파일 권한·해시·로그 관찰과 지정한 기존 파일·키체인 메타데이터를 비교하며, 두 계정이 서로 다르다는 사실이나 기본 앱의 실제 인증 상태까지 자동 증명하지 않습니다. 모든 파일 시스템 쓰기를 추적하는 도구도 아닙니다. `observations`는 누적 로그에서 메시지를 발견했는지 나타내므로 현재 인증 상태는 실제 CLI 화면·요청으로 확인합니다.

P5를 기다리는 동안에는 프로필을 삭제하지 않습니다. 실제 저장 형식을 확인해 만료 시각만 로컬에서 읽고, 예정 확인 시각과 재실행 방법을 근거에 기록합니다. 토큰 파일·시스템 시각을 수정하지 않습니다. 아직 만료 시각이나 자연 갱신을 확인하지 못했다면 그대로 `unverified`로 둡니다.

```sh
node poc/run.mjs record --root "$AG_POC_ROOT" --stage P5 --status unverified \
  --note '자연 만료 후 확인 예정: 실제 예정 시각을 여기에 기록. launch로 A·B 인증 요청 및 재접속 후 check'
```

### P6 자동 관찰과 사용자 재로그인

P5 통과 후 실제 TTY에서 시작합니다.

```sh
node poc/run.mjs verify --root "$AG_POC_ROOT" --stage P6
```

첫 실행은 기본 키체인 인증 대조군을 확인한 뒤 `logout-terminal-ready`를 출력합니다. 터미널 입력에 `/logout`과 Enter를 입력합니다. PTY 화면 원문은 출력하지 않으며, A 인증 제거·로그인 필요 상태·B 파일 불변과 응답·기본 인증 대조군 응답을 검사합니다. 이 버전의 비대화형 `-p /logout`은 지원하지 않습니다.

결과가 `official-relogin-required`면 다음 명령으로 A를 원래 A 계정에 공식 재로그인한 뒤 종료합니다.

```sh
node poc/run.mjs launch --root "$AG_POC_ROOT" --profile a
node poc/run.mjs verify --root "$AG_POC_ROOT" --stage P6
```

두 번째 P6 실행은 재로그인된 A의 계정·대화 복원과 B·기본 인증 유지를 검사합니다. `status: pass`와 개별 근거를 확인한 뒤 P6를 기록합니다. 두 번째 실행은 PTY가 필요하지 않습니다. 기본 인증 대조군은 전용 `profiles/default-control/` 경로에 설정·대화만 저장하고 SSH 환경을 제거해 기존 키체인 인증으로 요청합니다. 대조군에 파일 인증이 생성되면 검증을 중단합니다.

## 종료·재개·정리: P7

```sh
node poc/run.mjs stop --root "$AG_POC_ROOT"
node poc/run.mjs check --root "$AG_POC_ROOT"
```

`stop`은 이 run에 기록된 PID와 프로세스 시작 식별자가 일치하는 프로세스 그룹에만 SIGTERM을 전달합니다. 일반적인 대화형 종료는 각 CLI에서 `Ctrl+C` 두 번입니다. `check`에서 남은 세션과 비교 결과를 확인합니다. 모든 `agy`를 한꺼번에 종료하지 않습니다.

프로세스가 강제로 종료돼 `operation.lock`이 남았다면 다음 명령을 사용합니다. 잠금 소유 PID가 아직 실행 중이거나 PID 조회가 불가능하면 잠금을 제거하지 않습니다.

```sh
node poc/run.mjs unlock --root "$AG_POC_ROOT"
```

재개할 때는 같은 루트로 `check`와 `launch`를 실행합니다. 실행 조건·단계 기록은 `run.json`, 프로세스 기록은 `sessions/`, 자세한 비교 근거는 `evidence/`에 남아 있습니다.

P0~P6 통과, 종료·전후 상태 확인과 결과표 작성을 모두 마친 다음 P7을 기록하고 정리합니다. 전체 런타임이 삭제되므로 공유 가능한 결과와 판단은 먼저 [RESULTS.md](RESULTS.md)에 비밀값 없이 남깁니다. `cleanup`도 삭제 직전 요약을 출력하고, 삭제 후 원래 기준 상태와 다시 비교한 결과를 출력합니다. `postCleanupMatchesBaseline: true`까지 확인한 후 P7의 최종 정리 결과를 결과표에 반영합니다. 원본 기준과 미검토 차이가 있으면 삭제 전에 중단합니다. 삭제 중 추가 변경이 발견되면 종료 코드 1로 알리며 자동 복원하지 않습니다.

```sh
node poc/run.mjs record --root "$AG_POC_ROOT" --stage P7 --status pass \
  --note 'PoC 프로세스 종료, 기존 상태 비교와 결과표 보존 완료. 정리 가능한 상태 확인'
node poc/run.mjs cleanup --root "$AG_POC_ROOT"
```

기본 앱을 병행 사용해 이미 알려진 원본 기준 차이가 있다면, 원본을 바꾸지 말고 `evidence/baseline-review.json`에 출처와 원인 검토를 남깁니다. 검토 파일은 `marker`, `root`, `originalBaselineSha256`, `acceptedChanges`, `checkpoint`, 비밀값 없는 `note`를 포함하며 `validateBaselineReview`가 검증합니다. 검토 시점 이후 추가 변화가 있으면 정리를 중단합니다.

```sh
node poc/run.mjs cleanup --root "$AG_POC_ROOT" --baseline-review baseline-review.json
```

이 경우 원본과의 차이는 `postCleanupMatchesBaseline: false`로 그대로 남기고, `postCleanupMatchesReviewedBaseline: true`와 `changesDuringCleanup`으로 정리 중 무변경 여부를 확인합니다. 검토 파일을 자동으로 만들어 차이를 숨기는 기능은 없습니다. 원인·시점과 검토 근거를 공유 결과에 먼저 보존합니다.

실패·중단한 실험을 의도적으로 폐기하려면 실행 루트의 **디렉터리 이름 전체**를 `--discard-run`에 명시합니다. 단계 통과 여부와 관계없이 해당 전용 루트만 삭제합니다. 갱신 검증이나 다른 후속 실험에 필요한 데이터를 보존할지 먼저 판단합니다.

```sh
node poc/run.mjs cleanup --root "$AG_POC_ROOT" --discard-run "${AG_POC_ROOT##*/}"
```

전용 루트는 실제 `/private/tmp/ag-switch-poc-*` 바로 아래여야 하며 현재 사용자 소유인지, 루트·하위 디렉터리가 0700이고 매니페스트가 0600인지 검증합니다. 루트·프로필 경로의 심볼릭 링크는 거부하고 파일 목록 수집·삭제 중 내부 심볼릭 링크의 대상은 따라가지 않습니다. 인증 정보·CLI 로그가 있는 런타임을 저장소로 복사하지 않습니다.

## 도구 테스트

```sh
npm test
```

모의 CLI로 환경 격리·경로 검사·단계 순서·버전 고정·출력 비밀값 제외·시간 제한·프로세스 종료 범위·폐기 보호·잠금 복구를 검증합니다. 이 테스트는 실제 OAuth 로그인·토큰 갱신 검증을 대신하지 않습니다. macOS 프로세스 조회가 제한된 실행 환경에서는 `ps`를 사용할 수 있는 사용자 터미널에서 실행합니다.
