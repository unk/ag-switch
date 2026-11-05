# ag-switch

Antigravity CLI의 Google OAuth 계정을 독립된 프로필로 실행합니다. 프로필마다 인증·설정·대화·캐시를 분리하고, 현재 작업폴더에서 `agy`를 실행합니다. Node.js 22 이상이 필요하며 npm 의존성은 없습니다.

현재 버전은 **0.2.2**이며, 지원 환경은 **macOS arm64**입니다. 다음 바이너리의 검증 정보를 포함합니다. 검증 목록 안의 바이너리로 업데이트하면 기존 프로필도 안내 없이 실행되며, 다시 등록할 필요는 없습니다.

| agy | 검증 범위 | SHA-256 |
| --- | --- | --- |
| 1.4.7 | [로그인·자연 갱신·로그아웃을 포함한 OAuth 전체 수명주기](poc/RESULTS.md) | `b7a13e53c9f49921692676ef8edc2e60ceb67064c00bc732d9a364ec3ad75b32` |
| 1.5.1 | [빈 프로필 격리·기존 두 계정 응답·재접속·동시 실행](validation/AGY_1.5.1_RESULTS.md) | `5ce7fbe126eb9abdc78634332a0a1bdd428327fba37ef7d1aeba7553eec55f3f` |

목록에 없는 바이너리나 같은 버전의 다른 빌드는 호환성 미확인 안내만 표시하고 실행합니다. `doctor`도 이 안내만으로 실패 종료하지 않습니다. 1.5.1의 새 OAuth 로그인·자연 갱신·로그아웃/재로그인은 이번 업그레이드 검사에 포함하지 않았습니다.

[npm](https://www.npmjs.com/package/@naram/ag-switch) · [GitHub 릴리스](https://github.com/unk/ag-switch/releases/tag/v0.2.2)

0.2.1부터 **같은 프로필을 여러 터미널에서 동시에 실행**할 수 있습니다. 0.2.2에서는 agy 1.5.1 지원과 바이너리 변경 시 실행 차단을 안내로 바꾸는 수정, npx 캐시와 분리된 런처를 제공합니다.

```sh
npx @naram/ag-switch@latest

# 또는 전역 설치
npm install -g @naram/ag-switch
ag-switch
```

기존 프로필에 새 실행 코드를 적용하려면 해당 프로필의 실행을 모두 종료한 뒤 `setup`을 실행합니다. 인증·대화와 기존 실행 방식을 유지할 수 있으며 삭제·재등록은 필요하지 않습니다. npx로 패키지를 새로 받는 것만으로 이미 생성된 런처의 코드 참조가 자동 변경되지는 않습니다.

```sh
npx @naram/ag-switch@latest version
npx @naram/ag-switch@latest setup ag-work
```

`ag-work`는 실제 프로필 이름으로 바꾸고, 표시되는 기존 실행 방식을 유지해 적용합니다. 전역 설치 사용자도 업데이트 후 `ag-switch setup ag-work`를 실행합니다.

## 빠른 시작

저장소에서 실행합니다. `agy`가 PATH에 있어야 합니다. 다른 설치 경로는 `--binary /absolute/path/agy`로 지정합니다.

```sh
# 이름 → agy 경로 → 런처 방식 → 셸·설정 경로 → 적용 확인
node src/cli.mjs
node src/cli.mjs list
node src/cli.mjs doctor

# 각 명령을 실행하고 공식 Google 로그인 절차를 진행합니다.
~/.ag-switch/bin/ag-personal
~/.ag-switch/bin/ag-work
```

대화형 생성에서 `ag-personal` 같은 이름과 실행 방식을 선택합니다. 권장 방식은 **셸 별칭 + 자동완성**입니다. 마지막 확인 전에는 새 저장소나 셸 설정을 쓰지 않으며, `Ctrl+C`로 취소할 수 있습니다. 실제 로그인은 실행된 공식 CLI에서 진행하며, SSH 감지로 인해 브라우저 URL·코드를 수동으로 입력하는 흐름이 표시될 수 있습니다. 검증용 임시 인증 데이터는 이미 삭제됐으므로 새 프로필에서 로그인해야 합니다.

별칭을 설치했다면 안내된 `source` 명령을 실행하거나 새 셸에서 프로필 이름으로 실행합니다. 이미 있는 이름을 입력하면 인증·대화를 유지하면서 실행 설정을 수정할 수 있습니다. 내부 런처만 있는 프로필도 같은 이름으로 `create`하거나 `setup`하여 셸 연동을 추가합니다.

```sh
node src/cli.mjs setup ag-personal
ag-personal
ag-personal -p '간단히 인사해 줘'
```

로컬 패키지를 설치하려면 `npm install -g .`를 사용합니다. 설치 후 `ag-switch` 명령을 사용할 수 있습니다. 생성된 런처는 `~/.ag-switch/runtime/`에 보관한 실행 코드를 사용하므로 npx 캐시를 삭제하거나 소스 저장소를 이동해도 유지됩니다. Node 실행 파일의 절대 경로는 계속 사용하므로 Node 설치 경로가 바뀌면 새 Node에서 같은 이름으로 `create` 또는 `setup`을 실행해 갱신합니다. 이전 버전의 npx 런처도 삭제·재등록 없이 갱신됩니다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `create [이름] [--binary 경로] [--interactive]` | 새 프로필 생성 또는 같은 이름의 기존 프로필 설정 수정. 터미널에서 방식 생략 시 대화형 |
| `create <이름> --reuse` | 보존된 인증·대화 및 기존 실행 방식을 복원하여 등록 |
| `create <이름> --recreate` | 기존 데이터를 비공개 백업 디렉터리에 보존한 뒤 새로 생성 |
| `setup <이름> [--launcher 방식]` | 기존 프로필의 셸·외부 런처 설정. 방식 생략 시 대화형 |
| `list [--json]` | 레지스트리 조회 |
| `run <이름> -- [agy 인자...]` | 현재 작업폴더에서 지정한 프로필 실행 |
| `remove <이름> [--yes]` | 런처·등록 제거. 인증·대화 데이터 보존 |
| `remove <이름> --purge [--yes]` | 런처·등록·인증·대화 데이터 삭제 |
| `doctor [--json] [--binary 경로]` | 설치 바이너리, 프로필 경로·권한, 인증 파일 유무, 런처 검사 |
| `unlock <이름\|store>` | 비정상 종료 후 소유 프로세스와 자식이 종료된 잠금만 해제 |
| `help` / `version` | 도움말 / 버전 |

모든 관리 명령은 `--root /absolute/path`로 별도 저장소를 선택할 수 있습니다. `remove`는 대화형 터미널에서 이름 재입력을 요구하며, 자동 실행에서는 `--yes`를 명시합니다. `--purge`는 해당 프로필의 로컬 데이터를 영구 삭제하며, Google 계정의 토큰 폐기를 요청하지 않습니다. OAuth 로그아웃이 필요하면 삭제 전에 해당 프로필의 공식 CLI에서 `/logout`을 실행합니다.

## 런처와 셸 설치

`create`와 `setup`에서 `--launcher`를 선택합니다. 내부 런처는 모든 방식에서 생성됩니다.

| 방식 | 설치되는 항목 |
| --- | --- |
| `internal` | `~/.ag-switch/bin/<이름>`만 생성 |
| `alias` | 내부 런처 + 셸 별칭·자동완성 블록 |
| `script` | 내부 런처 + PATH 디렉터리의 실행 스크립트 |
| `both` | 내부 런처 + 셸 별칭·자동완성 + 실행 스크립트 |

터미널에서 `create ag-work`처럼 이름만 지정해도 대화형으로 실행 방식을 선택합니다. 같은 이름이 있으면 설정 수정·백업 후 재생성·취소를, 삭제 후 데이터만 남아 있으면 재사용·백업 후 재생성·취소를 안내합니다. `--reuse`를 따로 입력할 필요가 없습니다.

`--launcher`를 명시하면 질문 없이 적용하며, 마지막 확인까지 받고 싶으면 `--interactive`를 추가합니다. 대화형 모드의 `--yes`는 마지막 적용 확인만 생략합니다. 비대화형 자동 실행에서 방식 생략 시 기존 실행 설정을 유지·복원하고 새 프로필만 `internal`이 기본입니다. 보존 데이터가 있으면 비대화형에서는 `--reuse` 또는 `--recreate`를 명시합니다. `internal`은 이름으로 실행할 셸 연결을 만들지 않으므로 결과에 직접 실행 경로와 `setup` 안내를 표시합니다.

재생성 시 이전 인증·대화 전체를 `~/.ag-switch/backups/<이름>.<시각>.<ID>/`로 옮겨 보존합니다. 새 프로필은 다시 로그인해야 하며, 적용 실패 시 이전 프로필과 실행 설정을 복구합니다. 백업은 자동 삭제하지 않습니다. `--reuse`와 `--recreate`는 함께 사용할 수 없습니다.

```sh
# 대화형 생성
node src/cli.mjs create --interactive

# 명시적인 zsh 설치: ~/.zshrc와 ~/.local/bin 사용
node src/cli.mjs create ag-work --launcher both --shell zsh

# 다른 설정 파일·설치 경로 지정
node src/cli.mjs setup ag-work --launcher both --shell bash \
  --rc ~/.bash_profile --bin-dir ~/.local/bin

# 셸·외부 스크립트 연동만 해제하고 프로필 데이터 유지
node src/cli.mjs setup ag-work --launcher internal
```

지원 셸은 zsh·bash·fish입니다. zsh는 `ZDOTDIR/.zshrc`, macOS bash는 기존 `.bash_profile`·`.bash_login`·`.profile` 중 첫 파일(없으면 `.bash_profile`), fish는 `XDG_CONFIG_HOME/fish/config.fish`를 기본으로 선택합니다. 환경변수가 없으면 일반적인 홈 경로를 사용합니다. bash 비로그인 셸을 사용한다면 `--rc ~/.bashrc`로 지정합니다.

설정 파일에는 프로필 이름을 포함한 `# >>> ag-switch: ... >>>` 표시 블록만 추가합니다. 기존 파일을 수정하거나 제거할 때마다 `<파일>.ag-switch.<시각>.<ID>.bak` 백업을 0600으로 저장하고 원래 파일 권한을 유지합니다. 적용 중 실패하면 이미 쓴 파일을 복구하며, 다른 작업이 내용·권한을 바꾼 파일은 덮어써 복구하지 않습니다. `setup`은 기존 연동을 교체하고 `remove`는 등록한 별칭·자동완성·외부 스크립트까지 정리합니다. 현재 열린 셸의 기존 별칭은 남을 수 있으므로 제거·설정 변경 후에는 새 셸을 엽니다.

PATH의 명령·셸 내장 명령, 지정한 설정 파일의 직접 정의된 별칭·함수, 외부 스크립트 충돌을 검사합니다. 셸 설정을 실행해 검사하지 않으므로 다른 파일에서 불러오는 조건부 별칭·함수까지 탐지하지는 않습니다. 변경된 관리 블록이나 스크립트는 자동 덮어쓰기·제거를 거부합니다. 심볼릭 링크인 설정 파일은 실제 대상 경로를 `--rc`로 지정하세요. 스크립트 방식을 선택한 디렉터리가 PATH에 없으면 적용 결과에 안내합니다.

자동완성은 기존 `agy` 설정을 활용하며(zsh의 `agy` 연결, bash의 `_agy`, fish의 wraps), 없으면 검증한 1.4.7의 공개 옵션·명령을 기본 제안합니다. zsh는 표시 블록보다 앞에서 `compinit`을 초기화해야 합니다. 기본 제안은 모든 하위 명령·옵션 값의 완전한 자동완성을 제공하지 않습니다. fish 연동은 [공식 complete 문서](https://fishshell.com/docs/current/cmds/complete.html)의 wraps 동작을 따릅니다.

같은 프로필도 여러 터미널·작업폴더에서 동시에 실행할 수 있습니다. 예를 들어 두 터미널에서 각각 `ag-personal`을 실행하면 됩니다. 실행마다 독립된 잠금 기록을 유지하며, 하나를 종료해도 다른 실행은 유지됩니다. 동시에 시작할 때 저장소 관리 잠금은 최대 5초간 기다립니다. 해당 프로필의 모든 실행이 끝나기 전에는 `setup`·`remove`를 할 수 없습니다.

같은 프로필의 실행들은 인증·설정·저장된 대화 데이터를 공유합니다. 공식 CLI에서 로그인·로그아웃하거나 공통 설정을 변경할 때는 해당 프로필의 다른 실행을 종료하세요. 서로 다른 계정과 데이터를 분리하려면 다른 프로필을 사용합니다. 이번 변경의 실행 관리·잠금 복구는 자동 테스트로 검증했으며, 같은 프로필의 실제 OAuth 동시 요청·동시 토큰 갱신은 별도 실사용 검증이 필요합니다.

0.2.0에서 실행 중이던 CLI는 모두 종료한 뒤 새 코드를 사용하세요. 비정상 종료로 이전 잠금이 남았다면 `ag-switch unlock <이름>`으로 복구합니다. 새 실행 기록도 모든 소유 프로세스·자식의 종료를 확인한 뒤 같은 명령으로 정리하며, 실행 중이거나 손상된 기록이 있으면 해제하지 않습니다.

프로필 경로를 덮어쓰는 `--gemini_dir`·`--app_data_dir` 인자는 거부합니다. `doctor`의 인증 파일 유무는 실제 로그인 성공이나 토큰 갱신을 증명하지 않으며, 모델 요청을 보내지 않습니다.

## 저장 구조와 격리

```text
~/.ag-switch/                  # 0700
  store.json                  # 저장소 소유 표시, 0600
  profiles.json               # 비밀값 없는 레지스트리, 0600
  bin/ag-personal             # 실행 런처, 0700
  runtime/<코드 해시>/         # npx 캐시와 독립된 실행 코드, Node.js로 실행
  backups/<이름>.<시각>.<ID>/   # 재생성 전 데이터 보존, 0700
  locks/                      # store.json·<이름>.json: 독점 관리 잠금
                              # <이름>.<실행 ID>.json: 각 CLI 실행 기록
  profiles/ag-personal/
    profile.json              # 프로필 소유 표시, 0600
    data/
      antigravity-cli/         # 인증 파일·대화·CLI 상태
      config/                  # 프로필 설정
    tmp/
    cache/
    xdg-config/
    xdg-data/
```

런처는 `--gemini_dir=<프로필>/data --app_data_dir=antigravity-cli`를 지정합니다. 자식 환경에 `SSH_TTY=/dev/ag-switch`와 `AGY_CLI_DISABLE_AUTO_UPDATE=true`를 설정하고, 경쟁하는 Google·Gemini·Antigravity·ADC·게이트웨이·기존 SSH 환경을 제거합니다. 이 SSH 감지 변수는 플러그인·MCP·하위 도구에도 전달됩니다. 해당 통합의 전체 호환성은 아직 검증하지 않았습니다.

런처는 `HOME`을 바꾸지 않습니다. 사용자 셸 설정은 `alias`·`both` 설치를 선택했을 때 지정한 파일의 관리 블록으로만 수정합니다. 키체인을 읽거나 교체하지 않으며, 기존 기본 계정의 인증을 프로필로 복사하지 않습니다. 인증 파일의 내용은 ag-switch가 읽지 않고 존재·권한만 검사합니다. 관리 경로의 심볼릭 링크와 느슨한 권한은 거부하며, 재귀 삭제는 내부 링크의 대상을 따라가지 않습니다. 파일 기반 인증이므로 이 저장소를 공유하거나 커밋하지 마세요.

## 개발과 검증

```sh
npm test                  # 제품 회귀 테스트 + 기존 PoC 테스트
npm run test:product      # 제품 테스트만 실행
npm run test:shell        # 설치·셸 연동 테스트
npm start -- help
```

제품 회귀 테스트는 모의 바이너리로 프로필 수명주기·환경 격리·동시 실행·삭제 보호·잠금 복구와 셸 설정 보존을 확인합니다. 제품 런처의 두 계정 로그인·재접속·동시 실행·자연 갱신·A 로그아웃과 공식 재로그인, B·기본 계정 유지도 [실제 검증](validation/RESULTS.md)을 모두 통과했습니다. 0.2.0의 대화형 설치와 세 셸 실행은 [설치 검증 결과](validation/SETUP_RESULTS.md)에 기록했습니다. 버전별 변경은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

공개 0.2.1의 기본 자동 테스트는 **72개**이며, 현재 작업본에는 재생성·복원·npx 캐시 제거 후 실행 회귀 검사가 추가되어 있습니다. fish가 있으면 `AG_SWITCH_TEST_FISH=/absolute/path/fish npm test`로 추가 실행 검사를 활성화합니다. 기존 PoC와 스트리밍 검증 테스트는 `ps`로 프로세스를 조회하므로 macOS 샌드박스에서는 EPERM이 발생할 수 있습니다. 해당 경우 프로세스 조회가 가능한 사용자 터미널에서 실행합니다.

다중 실행 변경에는 같은 프로필의 중첩 실행·별도 프로세스 4개의 동시 시작·마지막 실행까지 삭제 보호·이전 잠금 호환·다중 잠금 복구 검사를 추가했습니다.

- [본 개발 범위와 진행 상태](DEVELOPMENT.md)
- [제품 런처 OAuth 검증·재개 방법](validation/README.md)
- [PoC 실행·로그인·재개 방법](poc/README.md)
- [검증 계획과 통과 조건](POC_PLAN.md)
- [공유용 PoC 결과 JSON](poc/evidence/ag-switch-poc-O92xjF.json)
- [0.2.1 공개 배포 검증 결과](validation/RELEASE_0.2.1_RESULTS.md)

## 라이선스

[MIT](LICENSE)
