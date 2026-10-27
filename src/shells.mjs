import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite, statOrNull, validateName } from './storage.mjs';

const exec = promisify(execFile);
export const MODES = ['internal', 'alias', 'script', 'both'];
export const SHELLS = ['zsh', 'bash', 'fish'];
export const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`;
const fishQuote = text => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
// Public agy 1.4.7 help. Internal path flags are deliberately excluded.
const words = '--help --version --continue --conversation --model --mode --effort --print --prompt --project --add-dir --agent --input-format --output-format --sandbox agent agents changelog help mcp models plugin plugins remote-control';
export function expandPath(input, home = os.homedir()) {
  if (typeof input !== 'string' || !input || /[\r\n\0]/.test(input)) throw new Error('유효한 경로를 입력하세요.');
  const expanded = input === '~' ? home : input.startsWith('~/') ? path.join(home, input.slice(2)) : input;
  return path.resolve(expanded);
}
export async function detectShell({ env = process.env, home = os.homedir(), shell } = {}) {
  const name = shell ?? path.basename(env.SHELL ?? '');
  if (!SHELLS.includes(name)) return { name: 'unknown', rcPath: null };
  if (name === 'zsh') return { name, rcPath: path.join(expandPath(env.ZDOTDIR || home, home), '.zshrc') };
  if (name === 'fish') return { name, rcPath: path.join(expandPath(env.XDG_CONFIG_HOME || path.join(home, '.config'), home), 'fish/config.fish') };
  const candidates = ['.bash_profile', '.bash_login', '.profile'];
  const bashrc = path.join(home, '.bashrc');
  if (process.platform !== 'darwin' && await statOrNull(bashrc)) return { name, rcPath: bashrc };
  for (const file of candidates) if (await statOrNull(path.join(home, file))) return { name, rcPath: path.join(home, file) };
  return { name, rcPath: path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc') };
}
export async function integrationConfig(options = {}, context = {}) {
  const mode = options.mode ?? 'internal';
  if (!MODES.includes(mode)) throw new Error('런처 방식은 internal, alias, script, both 중 하나여야 합니다.');
  if (mode === 'internal') {
    if (options.shell || options.rcPath || options.binDir) throw new Error('internal 방식에는 셸·rc·bin-dir 옵션을 사용할 수 없습니다.');
    return { mode };
  }
  const detected = await detectShell({ ...context, shell: options.shell });
  const needsAlias = ['alias', 'both'].includes(mode);
  if (needsAlias && !SHELLS.includes(detected.name)) throw new Error('--shell zsh|bash|fish를 지정하세요.');
  if (!needsAlias && (options.shell || options.rcPath)) throw new Error('script 방식은 셸 설정을 수정하지 않습니다. alias 또는 both를 선택하세요.');
  if (mode === 'alias' && options.binDir) throw new Error('--bin-dir은 script 또는 both 방식에서만 사용할 수 있습니다.');
  return { mode, ...(needsAlias ? { shell: detected.name, rcPath: expandPath(options.rcPath || detected.rcPath, context.home) } : {}),
    ...(['script', 'both'].includes(mode) ? { binDir: expandPath(options.binDir || path.join(context.home ?? os.homedir(), '.local/bin'), context.home) } : {}) };
}
export async function assertCommandAvailable(name, allowed = [], env = process.env) {
  validateName(name);
  const keywords = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'select', 'until', 'time', 'in', 'end', 'switch', 'begin'];
  if (keywords.includes(name)) throw new Error(`셸 예약어는 프로필 이름으로 사용할 수 없습니다: ${name}`);
  let result;
  try { result = await exec('/bin/sh', ['-c', 'command -v "$1"', 'ag-switch', name], { env }); }
  catch (error) { if (error.code === 1) return; throw error; }
  const found = result.stdout.trim();
  if (found && !allowed.includes(found)) throw new Error(`기존 명령과 이름이 겹칩니다: ${name}`);
}
export function buildBlock(name, launcher, shell) {
  validateName(name);
  if (!SHELLS.includes(shell)) throw new Error('지원하지 않는 셸입니다.');
  const fn = `_ag_switch_${name.replaceAll('-', '_')}`;
  const lines = [`# >>> ag-switch: ${name} >>>`];
  if (shell === 'fish') {
    lines.push(`function ${name} --wraps agy`, `    ${fishQuote(launcher)} $argv`, 'end', `complete -c ${name} -w agy`);
    const argumentsRequired = new Set(['conversation', 'model', 'mode', 'effort', 'print', 'prompt', 'project', 'add-dir', 'agent', 'input-format', 'output-format']);
    for (const flag of words.split(' ').filter(value => value.startsWith('--'))) lines.push(`complete -c ${name} -l ${flag.slice(2)}${argumentsRequired.has(flag.slice(2)) ? ' -r' : ''}`);
    lines.push(`complete -c ${name} -a ${fishQuote(words.split(' ').filter(value => !value.startsWith('-')).join(' '))}`);
  } else {
    lines.push(`alias ${name}=${shellQuote(shellQuote(launcher))}`);
    if (shell === 'zsh') lines.push(
      `${fn}() {`, `  local -a ag_switch_candidates`, `  ag_switch_candidates=(${words})`, `  _describe 'agy option' ag_switch_candidates`, '  _files', '}',
      'if (( $+functions[compdef] )); then', '  if (( ${+_comps[agy]} )); then', `    compdef ${name}=agy`, '  else', `    compdef ${fn} ${name}`, '  fi', 'fi');
    else lines.push(`${fn}() {`, `  COMPREPLY=( $(compgen -W ${shellQuote(words)} -- "\${COMP_WORDS[COMP_CWORD]}") )`, '}',
      'if declare -F _agy >/dev/null; then', `  complete -o default -F _agy ${name}`, 'else', `  complete -o default -F ${fn} ${name}`, 'fi');
  }
  lines.push(`# <<< ag-switch: ${name} <<<`, '');
  return lines.join('\n');
}
export function externalScript(name, launcher) {
  return `#!/bin/sh\n# ag-switch external launcher: ${name}\nexec ${shellQuote(launcher)} "$@"\n`;
}
async function snapshot(file) {
  const stat = await statOrNull(file);
  if (!stat) return { text: null, mode: 0o600 };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error(`직접 소유한 안전한 일반 파일이 필요합니다: ${file}. 심볼릭 링크라면 실제 파일 경로를 지정하세요.`);
  return { text: await fs.readFile(file, 'utf8'), mode: stat.mode & 0o777 };
}
function assertNoAlias(text, name) {
  const patterns = [new RegExp(`(?:^|[;\\n])\\s*alias\\s+(?:--\\s+)?${name}(?:=|\\s|$)`),
    new RegExp(`(?:^|[;\\n])\\s*(?:function\\s+${name}(?:\\s|\\(|$)|${name}\\s*\\(\\))`)];
  if (patterns.some(pattern => pattern.test(text))) throw new Error(`설정 파일에 같은 이름의 별칭 또는 함수가 있습니다: ${name}`);
}
export async function planIntegration(store, name, previous, options, { env = process.env } = {}) {
  const config = await integrationConfig(options);
  const launcher = path.join(store.root, 'bin', name);
  for (const target of [config.rcPath, config.binDir].filter(Boolean)) {
    if (target === store.root || target.startsWith(store.root + path.sep)) throw new Error('셸 설정과 외부 런처는 관리 저장소 밖의 경로를 지정하세요.');
  }
  const edits = new Map();
  const get = async file => {
    if (!edits.has(file)) { const before = await snapshot(file); edits.set(file, { file, before, text: before.text, mode: before.mode }); }
    return edits.get(file);
  };
  if (previous?.rcPath) {
    const edit = await get(previous.rcPath);
    if (edit.text !== null) {
      if (!edit.text.includes(previous.block) || edit.text.indexOf(previous.block) !== edit.text.lastIndexOf(previous.block)) throw new Error(`변경되거나 중복된 셸 블록은 자동 제거하지 않습니다: ${previous.rcPath}`);
      edit.text = edit.text.replace(previous.block, '');
    }
  }
  if (previous?.scriptPath) {
    const edit = await get(previous.scriptPath);
    if (edit.text !== null && edit.text !== previous.script) throw new Error(`변경된 외부 런처는 자동 제거하지 않습니다: ${previous.scriptPath}`);
    edit.text = null;
  }
  const integration = config.mode === 'internal' ? null : { mode: config.mode };
  if (integration) await assertCommandAvailable(name, [launcher, previous?.scriptPath].filter(Boolean), env);
  if (config.rcPath) {
    const edit = await get(config.rcPath);
    const original = edit.text ?? '';
    if (original.includes(`# >>> ag-switch: ${name} >>>`) || original.includes(`# <<< ag-switch: ${name} <<<`)) throw new Error(`다른 저장소 또는 손상된 셸 블록과 이름이 겹칩니다: ${name}`);
    assertNoAlias(original, name);
    const sameFile = previous?.rcPath === config.rcPath && edit.before.text !== null;
    const prefix = sameFile ? previous.block.slice(0, previous.block.indexOf(`# >>> ag-switch: ${name} >>>`)) : !original ? '' : original.endsWith('\n') ? '\n' : '\n\n';
    const block = prefix + buildBlock(name, launcher, config.shell);
    edit.text = sameFile ? edit.before.text.replace(previous.block, block) : original + block;
    Object.assign(integration, { shell: config.shell, rcPath: config.rcPath, block });
  }
  if (config.binDir) {
    const file = path.join(config.binDir, name);
    if (file === launcher || file === config.rcPath) throw new Error('외부 런처 경로는 내부 런처·셸 설정과 달라야 합니다.');
    const edit = await get(file);
    if (edit.text !== null) throw new Error(`기존 파일을 덮어쓰지 않습니다: ${file}`);
    edit.text = externalScript(name, launcher); edit.mode = 0o700;
    Object.assign(integration, { scriptPath: file, script: edit.text });
  }
  return { integration, edits: [...edits.values()].filter(edit => edit.text !== edit.before.text || edit.mode !== edit.before.mode) };
}
export async function applyEdits(edits) {
  const written = [], backups = [];
  const rollback = async () => {
    for (const edit of [...written].reverse()) {
      const current = await snapshot(edit.file);
      if (current.text !== edit.text || (edit.text !== null && current.mode !== edit.mode)) throw new Error(`다른 작업이 변경한 설정은 자동 복원하지 않습니다. 백업을 확인하세요: ${edit.file}`);
      if (edit.before.text === null) await fs.rm(edit.file, { force: true });
      else await atomicWrite(edit.file, edit.before.text, edit.before.mode);
    }
  };
  try {
    for (const edit of edits) {
      const current = await snapshot(edit.file);
      if (current.text !== edit.before.text || current.mode !== edit.before.mode) throw new Error(`설정 파일이 계획 이후 바뀌었습니다: ${edit.file}`);
      await fs.mkdir(path.dirname(edit.file), { recursive: true, mode: 0o700 });
      const parent = await fs.stat(path.dirname(edit.file));
      if (parent.uid !== process.getuid() || (parent.mode & 0o022)) throw new Error(`설정 디렉터리의 소유자·권한을 확인하세요: ${path.dirname(edit.file)}`);
      if (edit.before.text !== null) {
        const backup = `${edit.file}.ag-switch.${Date.now()}.${randomUUID()}.bak`;
        await fs.writeFile(backup, edit.before.text, { mode: 0o600, flag: 'wx' }); backups.push(backup);
      }
      if (edit.text === null) await fs.unlink(edit.file);
      else await atomicWrite(edit.file, edit.text, edit.mode);
      written.push(edit);
    }
  } catch (error) { await rollback(); throw error; }
  return { backups, rollback };
}
export async function checkIntegration(integration) {
  if (!integration) return;
  if (integration.rcPath) {
    const current = await snapshot(integration.rcPath);
    if (!current.text?.includes(integration.block)) throw new Error('셸 별칭·자동완성 블록이 없거나 변경됐습니다.');
  }
  if (integration.scriptPath) {
    const current = await snapshot(integration.scriptPath);
    if (current.text !== integration.script || current.mode !== 0o700) throw new Error('외부 런처 내용·권한이 다릅니다.');
  }
}
