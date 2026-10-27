import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { validateName } from './storage.mjs';
import { resolveBinary, inspectBinary } from './runtime.mjs';
import { detectShell, integrationConfig, expandPath } from './shells.mjs';

export class Cancelled extends Error {
  constructor() { super('취소했습니다.'); this.exitCode = 130; }
}
export function terminalUI() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('대화형 터미널이 필요합니다. 이름과 --launcher 등의 옵션을 명시하세요.');
  const abort = new AbortController();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => abort.abort());
  rl.on('close', () => abort.abort());
  const ui = {
    print: message => console.log(message), close: () => rl.close(),
    async text(label, { initial = '', validate = value => value } = {}) {
      while (true) {
        if (abort.signal.aborted) throw new Cancelled();
        let input;
        try { input = await rl.question(`${label}${initial ? ` [${initial}]` : ''}: `, { signal: abort.signal }); }
        catch (error) { if (abort.signal.aborted) throw new Cancelled(); throw error; }
        if (abort.signal.aborted) throw new Cancelled();
        try { return await validate(input.trim() || initial); }
        catch (error) { console.log(error.message); }
      }
    },
    async select(label, choices, initial) {
      console.log(label);
      choices.forEach((choice, i) => console.log(`  ${i + 1}. ${choice.label}`));
      const selected = await ui.text('선택', { initial: initial ? String(choices.findIndex(c => c.value === initial) + 1) : '', validate: value => {
        const choice = choices.find((c, i) => String(i + 1) === value || c.value === value);
        if (!choice) throw new Error('목록의 번호를 선택하세요.');
        return choice.value;
      } });
      return selected;
    },
    async confirm(label) { return await ui.text(`${label} [y/N]`, { validate: value => {
      if (!['', 'y', 'yes', 'n', 'no'].includes(value.toLowerCase())) throw new Error('y 또는 n을 입력하세요.');
      return ['y', 'yes'].includes(value.toLowerCase());
    } }); },
  };
  return ui;
}
export async function configure(initial, { ui, existing, names = [], home = os.homedir(), env = process.env, inspect = inspectBinary, resolve = resolveBinary, preflight = async () => {} } = {}) {
  const name = existing?.name ?? await ui.text('프로필 실행 이름 (예: ag-personal)', { initial: initial.name ?? '', validate: value => {
    validateName(value);
    if (names.includes(value)) throw new Error('이미 등록된 이름입니다. 기존 프로필은 setup 명령으로 설정하세요.');
    return value;
  } });
  let binary = existing?.binary;
  if (!binary) {
    let candidate = initial.binary;
    if (!candidate) { try { candidate = await resolve(undefined, env); } catch { candidate = ''; } }
    binary = await ui.text('agy 실행 파일 경로', { initial: candidate, validate: async value => {
      const resolved = await resolve(expandPath(value, home), env);
      await inspect(resolved); return resolved;
    } });
  }
  const mode = await ui.select('프로필을 어떻게 실행할까요?', [
    { value: 'alias', label: '셸 별칭 + 자동완성 (권장)' },
    { value: 'script', label: 'PATH 디렉터리에 실행 스크립트 설치' },
    { value: 'both', label: '셸 별칭 + 자동완성 + 실행 스크립트' },
    { value: 'internal', label: '프로필 내부 런처만 생성' },
  ], initial.launcher ?? existing?.integration?.mode ?? 'alias');
  const options = { mode };
  if (['alias', 'both'].includes(mode)) {
    const detected = await detectShell({ home, env, shell: initial.shell ?? existing?.integration?.shell });
    options.shell = await ui.select('사용할 셸', ['zsh', 'bash', 'fish'].map(value => ({ value, label: value })), detected.name === 'unknown' ? undefined : detected.name);
    const selected = await detectShell({ home, env, shell: options.shell });
    options.rcPath = await ui.text('별칭·자동완성을 추가할 설정 파일', { initial: initial.rcPath ?? (existing?.integration?.shell === options.shell ? existing.integration.rcPath : undefined) ?? selected.rcPath, validate: value => expandPath(value, home) });
  }
  if (['script', 'both'].includes(mode)) options.binDir = await ui.text('실행 스크립트 설치 디렉터리', { initial: initial.binDir ?? (existing?.integration?.scriptPath ? path.dirname(existing.integration.scriptPath) : path.join(home, '.local/bin')), validate: value => expandPath(value, home) });
  const integration = await integrationConfig(options, { env, home });
  const config = { name, binary, integration };
  const plan = await preflight(config);
  ui.print(`\n프로필: ${name}\nagy: ${binary}\n런처: ${mode}${integration.rcPath ? `\n셸 설정: ${integration.rcPath}` : ''}${integration.binDir ? `\n스크립트: ${path.join(integration.binDir, name)}` : ''}`);
  if (plan?.edits?.length) ui.print('기존 파일을 수정하기 전에 0600 권한의 백업을 만듭니다.');
  if (!initial.yes && !await ui.confirm('이 설정을 적용할까요?')) return null;
  return config;
}
