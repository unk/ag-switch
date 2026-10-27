#!/usr/bin/env node
import path from 'node:path';
import { realpathSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT, openStore, loadRegistry, unlock, validateName } from './storage.mjs';
import { resolveBinary, inspectBinary } from './runtime.mjs';
import { createProfile, setupProfile, removeProfile, runProfile, doctor, shellQuote } from './profiles.mjs';
import { integrationConfig, planIntegration, assertCommandAvailable, expandPath } from './shells.mjs';
import { configure, terminalUI, Cancelled } from './prompts.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `ag-switch — Antigravity CLI 독립 OAuth 프로필

  ag-switch create [이름] [--interactive] [--binary 경로] [--reuse]
  ag-switch setup <이름> [--launcher 방식]
  ag-switch list [--json]
  ag-switch run <이름> -- [agy 인자...]
  ag-switch remove <이름> [--purge] [--yes]
  ag-switch doctor [--json] [--binary 경로]
  ag-switch unlock <이름|store>
  ag-switch help | version

공통 옵션: --root <절대 경로> (기본: ~/.ag-switch)
설치 옵션: --launcher internal|alias|script|both
           --shell zsh|bash|fish --rc 경로 --bin-dir 디렉터리
이름 없는 create, --interactive, 방식 없는 setup은 대화형으로 실행합니다.
remove는 인증·대화 데이터를 보존합니다. --purge는 데이터도 삭제합니다.
전달할 agy 인자는 반드시 -- 뒤에 넣으세요.`;
export function parse(argv) {
  let [command = 'create', ...rest] = argv;
  command = ({ '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version', ls: 'list', rm: 'remove' })[command] ?? command;
  const allowed = {
    create: ['root', 'binary', 'reuse', 'interactive', 'launcher', 'shell', 'rc', 'bin-dir', 'yes'],
    setup: ['root', 'interactive', 'launcher', 'shell', 'rc', 'bin-dir', 'yes'], list: ['root', 'json'], run: ['root'],
    remove: ['root', 'purge', 'yes'], doctor: ['root', 'json', 'binary'], unlock: ['root'], help: [], version: [],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('알 수 없는 명령입니다. help를 확인하세요.');
  const options = {}, positional = [];
  let forwarded = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') {
      if (command !== 'run') throw new Error('-- 구분자는 run에만 사용할 수 있습니다.');
      forwarded = rest.slice(i + 1); break;
    }
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (!arg.startsWith('--') || !allowed[command].includes(key) || Object.hasOwn(options, key)) throw new Error('잘못되었거나 중복된 옵션입니다.');
    if (['reuse', 'json', 'purge', 'yes', 'interactive'].includes(key)) options[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('-')) throw new Error(`--${key}에 값이 필요합니다.`);
      options[key] = value;
    }
  }
  if (positional.length > (['create', 'setup', 'run', 'remove', 'unlock'].includes(command) ? 1 : 0)) throw new Error('인자가 너무 많습니다.');
  return { command, options, name: positional[0], forwarded };
}
async function ask(question) {
  const ui = terminalUI();
  try { return await ui.text(question); } finally { ui.close(); }
}
export async function main(argv) {
  const parsed = parse(argv);
  const { command, options, forwarded } = parsed;
  let { name } = parsed;
  if (command === 'help') { console.log(HELP); return 0; }
  if (command === 'version') { console.log(VERSION); return 0; }
  if (['setup', 'run', 'remove', 'unlock'].includes(command) && !name) throw new Error('프로필 이름이 필요합니다.');
  if (command === 'remove' && !options.yes) {
    const answer = await ask(`${name}: ${options.purge ? '인증·대화 데이터를 영구 삭제' : '등록 제거, 데이터 보존'}합니다. 이름을 다시 입력하세요: `);
    if (answer !== name) { console.log('취소했습니다.'); return 0; }
  }
  const root = expandPath(options.root ?? ROOT);
  let store = await openStore(root);
  let config;
  if (['create', 'setup'].includes(command)) {
    const profiles = store ? (await loadRegistry(store)).profiles : [];
    const existing = command === 'setup' ? profiles.find(p => p.name === name) : undefined;
    if (command === 'setup' && !existing) throw new Error('등록되지 않은 프로필입니다.');
    const preflight = async candidate => {
      await inspectBinary(candidate.binary);
      await assertCommandAvailable(candidate.name, [path.join(root, 'bin', candidate.name), existing?.integration?.scriptPath].filter(Boolean));
      return planIntegration(store ?? { root }, candidate.name, existing?.integration, candidate.integration);
    };
    if (options.interactive || (command === 'create' && !name) || (command === 'setup' && !options.launcher)) {
      const ui = terminalUI();
      try { config = await configure({ name, binary: options.binary, launcher: options.launcher, shell: options.shell, rcPath: options.rc, binDir: options['bin-dir'], yes: options.yes }, { ui, existing, names: profiles.map(p => p.name), preflight }); }
      finally { ui.close(); }
      if (!config) { console.log('취소했습니다.'); return 0; }
    } else {
      validateName(name);
      const binary = existing?.binary ?? await resolveBinary(options.binary ? expandPath(options.binary) : undefined);
      const needsAlias = ['alias', 'both'].includes(options.launcher);
      const needsScript = ['script', 'both'].includes(options.launcher);
      const shell = options.shell ?? (needsAlias ? existing?.integration?.shell : undefined);
      const rcPath = options.rc ?? (needsAlias && (!options.shell || options.shell === existing?.integration?.shell) ? existing?.integration?.rcPath : undefined);
      const binDir = options['bin-dir'] ?? (needsScript && existing?.integration?.scriptPath ? path.dirname(existing.integration.scriptPath) : undefined);
      config = { name, binary, integration: await integrationConfig({ mode: options.launcher, shell, rcPath, binDir }) };
      await preflight(config);
    }
    name = config.name;
    // All prompts, conflict checks and executable checks precede store creation.
    if (!store) store = await openStore(root, true);
  }
  if (command === 'doctor') {
    const results = [];
    try { const info = await inspectBinary(await resolveBinary(options.binary)); results.push({ name: 'agy', ok: true, version: info.version }); }
    catch (e) { results.push({ name: 'agy', ok: false, error: e.message }); }
    if (store) results.push(...await doctor(store));
    if (options.json) console.log(JSON.stringify(results, null, 2));
    else for (const item of results) console.log(`${item.ok ? 'OK' : 'FAIL'} ${item.name}: ${item.error ?? (item.name === 'agy' ? item.version : item.credentialFile ? '인증 파일 있음 (실제 로그인은 미확인)' : '아직 로그인하지 않음')}`);
    return results.every(item => item.ok) ? 0 : 1;
  }
  if (command === 'list') {
    const profiles = store ? (await loadRegistry(store)).profiles : [];
    if (options.json) console.log(JSON.stringify(profiles, null, 2));
    else console.log(profiles.length ? profiles.map(p => `${p.name}\tagy ${p.version}\t${p.integration?.mode ?? 'internal'}\t${p.createdAt}`).join('\n') : '등록된 프로필이 없습니다.');
    return 0;
  }
  if (!store) throw new Error('등록된 프로필이 없습니다. create부터 실행하세요.');
  if (command === 'create' || command === 'setup') {
    const entry = command === 'create' ? await createProfile(store, name, config.binary, { reuse: options.reuse, integration: config.integration }) : await setupProfile(store, name, config.integration);
    console.log(`${command === 'create' ? '프로필 생성' : '실행 설정 변경'}: ${name}\n직접 실행: ${shellQuote(path.join(store.root, 'bin', name))}`);
    if (entry.integration?.rcPath) console.log(`새 ${entry.integration.shell} 터미널에서 ${name} 명령을 실행하세요.\n셸 설정: ${entry.integration.rcPath}`);
    if (entry.integration?.scriptPath) {
      const dir = path.dirname(entry.integration.scriptPath);
      console.log(`실행 스크립트: ${entry.integration.scriptPath}`);
      if (!(process.env.PATH ?? '').split(path.delimiter).some(value => value && path.resolve(value) === dir)) console.log(`PATH에 이 디렉터리를 추가하세요: ${dir}`);
    }
    for (const backup of entry.backups) console.log(`백업: ${backup}`);
    if (command === 'create') console.log('처음 실행할 때 공식 Google 로그인 절차를 진행하세요.');
  } else if (command === 'remove') {
    const result = await removeProfile(store, name, { purge: options.purge });
    for (const backup of result.backups) console.log(`백업: ${backup}`);
    console.log(options.purge ? `${name}: 등록과 데이터를 삭제했습니다.` : `${name}: 등록을 제거하고 데이터를 보존했습니다. create ${name} --reuse로 재등록할 수 있습니다.`);
  } else if (command === 'run') return runProfile(store, name, forwarded);
  else if (command === 'unlock') { await unlock(store, name); console.log('종료된 프로세스의 잠금을 해제했습니다.'); }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.umask(0o077);
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Cancelled ? error.message : `ag-switch: ${error.message}`); process.exitCode = error.exitCode ?? 1;
  });
}
