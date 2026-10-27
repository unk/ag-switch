import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore, loadRegistry, profileDir, statOrNull, atomicWrite } from '../src/storage.mjs';
import { createProfile, setupProfile, removeProfile, doctor } from '../src/profiles.mjs';
import { detectShell, buildBlock, applyEdits, planIntegration, integrationConfig, assertCommandAvailable } from '../src/shells.mjs';
import { configure } from '../src/prompts.mjs';
import { sha256 } from '../src/runtime.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const temp = await fs.mkdtemp('/private/tmp/ag-switch-shell-test-');
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const store = await openStore(path.join(temp, 'store'), true);
  const binary = path.join(temp, 'fake-agy'); await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const inspect = async file => ({ binary: file, sha256: await sha256(file), version: 'fixture' });
  const rcPath = path.join(temp, '.zshrc');
  const binDir = path.join(temp, 'bin');
  return { temp, store, binary, inspect, rcPath, binDir };
}
test('shell detection honors ZDOTDIR, XDG config and macOS bash login files', async t => {
  const { temp } = await fixture(t);
  assert.deepEqual(await detectShell({ home: temp, env: { SHELL: '/bin/zsh', ZDOTDIR: path.join(temp, 'dotfiles') } }), { name: 'zsh', rcPath: path.join(temp, 'dotfiles/.zshrc') });
  assert.equal((await detectShell({ home: temp, env: { SHELL: '/bin/fish', XDG_CONFIG_HOME: path.join(temp, 'config') } })).rcPath, path.join(temp, 'config/fish/config.fish'));
  await fs.writeFile(path.join(temp, '.bash_profile'), '# login');
  assert.equal((await detectShell({ home: temp, env: { SHELL: '/bin/bash' } })).rcPath, path.join(temp, '.bash_profile'));
  assert.equal((await detectShell({ home: temp, env: { SHELL: '/bin/unknown' } })).name, 'unknown');
});
test('integrated creation, doctor, backup and removal preserve original rc bytes and credential data', async t => {
  const { store, binary, inspect, rcPath, binDir } = await fixture(t);
  const original = '# user settings without a final newline';
  await fs.writeFile(rcPath, original, { mode: 0o644 });
  const entry = await createProfile(store, 'ag-personal', binary, { inspect, integration: { mode: 'both', shell: 'zsh', rcPath, binDir } });
  assert.equal(entry.backups.length, 1);
  assert.equal(await fs.readFile(entry.backups[0], 'utf8'), original);
  assert.equal((await fs.stat(entry.backups[0])).mode & 0o777, 0o600);
  assert.equal((await fs.stat(rcPath)).mode & 0o777, 0o644);
  assert.equal((await doctor(store, { inspect }))[0].ok, true);
  const credential = path.join(profileDir(store, 'ag-personal'), 'data/antigravity-cli/antigravity-oauth-token');
  await fs.writeFile(credential, 'synthetic secret', { mode: 0o600 });
  await removeProfile(store, 'ag-personal');
  assert.equal(await fs.readFile(rcPath, 'utf8'), original);
  assert.equal(await fs.readFile(credential, 'utf8'), 'synthetic secret');
  assert.equal(await statOrNull(path.join(binDir, 'ag-personal')), null);
});
test('setup is idempotent across multiple profiles and does not reorder or duplicate blocks', async t => {
  const { store, binary, inspect, rcPath } = await fixture(t);
  const integration = { mode: 'alias', shell: 'zsh', rcPath };
  await createProfile(store, 'ag-a', binary, { inspect, integration });
  await createProfile(store, 'ag-b', binary, { inspect, integration });
  const before = await fs.readFile(rcPath, 'utf8');
  assert.equal((await setupProfile(store, 'ag-a', integration, { inspect })).backups.length, 0);
  assert.equal(await fs.readFile(rcPath, 'utf8'), before);
  await removeProfile(store, 'ag-a');
  assert.ok((await fs.readFile(rcPath, 'utf8')).includes('ag-b'));
  await removeProfile(store, 'ag-b');
  assert.equal(await fs.readFile(rcPath, 'utf8'), '');
});
test('changing launcher mode removes the old rc block and old external script without touching profile data', async t => {
  const { temp, store, binary, inspect, rcPath, binDir } = await fixture(t);
  await fs.writeFile(rcPath, '# user\n');
  await createProfile(store, 'ag-work', binary, { inspect, integration: { mode: 'both', shell: 'bash', rcPath, binDir } });
  const otherBin = path.join(temp, 'other-bin');
  await setupProfile(store, 'ag-work', { mode: 'script', binDir: otherBin }, { inspect });
  assert.equal(await fs.readFile(rcPath, 'utf8'), '# user\n');
  assert.equal(await statOrNull(path.join(binDir, 'ag-work')), null);
  assert.ok(await statOrNull(path.join(otherBin, 'ag-work')));
  await setupProfile(store, 'ag-work', { mode: 'internal' }, { inspect });
  assert.equal((await loadRegistry(store)).profiles[0].integration, undefined);
  assert.ok(await statOrNull(profileDir(store, 'ag-work')));
});
test('changed managed blocks and scripts prevent removal rather than clobbering user edits', async t => {
  const { store, binary, inspect, rcPath, binDir } = await fixture(t);
  await createProfile(store, 'ag-work', binary, { inspect, integration: { mode: 'both', shell: 'bash', rcPath, binDir } });
  const original = await fs.readFile(rcPath, 'utf8');
  await fs.writeFile(rcPath, original.replace('alias ag-work=', 'alias ag-renamed='));
  await assert.rejects(removeProfile(store, 'ag-work'), /변경되거나/);
  assert.equal((await loadRegistry(store)).profiles.length, 1);
  await fs.writeFile(rcPath, original);
  await fs.appendFile(path.join(binDir, 'ag-work'), '# user edit');
  assert.equal((await doctor(store, { inspect }))[0].ok, false);
  await assert.rejects(removeProfile(store, 'ag-work'), /변경된 외부/);
  assert.equal(await fs.readFile(rcPath, 'utf8'), original);
});
test('existing commands, rc aliases, foreign markers and external files are refused before edits', async t => {
  const { store, binary, inspect, rcPath, binDir } = await fixture(t);
  await assert.rejects(assertCommandAvailable('ls'), /기존 명령/);
  await assert.rejects(assertCommandAvailable('if'), /예약어/);
  await fs.writeFile(rcPath, "alias ag-work='echo user'\n");
  await assert.rejects(createProfile(store, 'ag-work', binary, { inspect, integration: { mode: 'alias', shell: 'zsh', rcPath } }), /같은 이름/);
  assert.equal((await loadRegistry(store)).profiles.length, 0);
  await fs.writeFile(rcPath, '# user\n');
  await fs.mkdir(binDir, { mode: 0o700 }); await fs.writeFile(path.join(binDir, 'ag-work'), 'keep');
  await assert.rejects(createProfile(store, 'ag-work', binary, { inspect, integration: { mode: 'both', shell: 'zsh', rcPath, binDir } }), /덮어쓰지/);
  assert.equal(await fs.readFile(rcPath, 'utf8'), '# user\n');
  await fs.writeFile(rcPath, '# >>> ag-switch: ag-work >>>\nforeign block\n');
  await assert.rejects(planIntegration(store, 'ag-work', null, { mode: 'alias', shell: 'zsh', rcPath }), /다른 저장소/);
});
test('unsafe paths and incompatible installation flags fail without editing user files', async t => {
  const { temp, store, rcPath } = await fixture(t);
  await fs.writeFile(rcPath, '# keep');
  const link = path.join(temp, 'linked-rc'); await fs.symlink(rcPath, link);
  await assert.rejects(planIntegration(store, 'ag-work', null, { mode: 'alias', shell: 'zsh', rcPath: link }), /심볼릭/);
  await assert.rejects(planIntegration(store, 'ag-work', null, { mode: 'alias', shell: 'zsh', rcPath: path.join(store.root, 'profiles.json') }), /관리 저장소/);
  await assert.rejects(integrationConfig({ mode: 'script', shell: 'zsh' }), /설정을 수정하지/);
  await assert.rejects(integrationConfig({ mode: 'internal', binDir: temp }), /internal/);
  assert.equal(await fs.readFile(rcPath, 'utf8'), '# keep');
});
test('failed multi-file updates restore prior bytes and stale plans do not overwrite concurrent edits', async t => {
  const { temp, rcPath } = await fixture(t);
  await fs.writeFile(rcPath, '# original', { mode: 0o600 });
  const badParent = path.join(temp, 'not-a-directory'); await fs.writeFile(badParent, 'keep');
  const edit = { file: rcPath, before: { text: '# original', mode: 0o600 }, text: '# changed', mode: 0o600 };
  await assert.rejects(applyEdits([edit, { file: path.join(badParent, 'rc'), before: { text: null, mode: 0o600 }, text: 'new', mode: 0o600 }]));
  assert.equal(await fs.readFile(rcPath, 'utf8'), '# original');
  await fs.writeFile(rcPath, '# concurrent');
  await assert.rejects(applyEdits([edit]), /계획 이후/);
  assert.equal(await fs.readFile(rcPath, 'utf8'), '# concurrent');
  const receipt = await applyEdits([{ ...edit, before: { text: '# concurrent', mode: 0o600 }, mode: 0o644 }]);
  await fs.chmod(rcPath, 0o600);
  await assert.rejects(receipt.rollback(), /자동 복원하지/);
  assert.equal(await fs.readFile(rcPath, 'utf8'), '# changed');
});
test('atomic replacements preserve an existing rc mode under the private CLI umask', async t => {
  const { rcPath } = await fixture(t);
  const before = process.umask(0o077);
  try { await atomicWrite(rcPath, '# user settings', 0o644); }
  finally { process.umask(before); }
  assert.equal((await fs.stat(rcPath)).mode & 0o777, 0o644);
});
for (const shell of ['bash', 'zsh', ...(process.env.AG_SWITCH_TEST_FISH ? ['fish'] : [])]) test(`${shell} aliases preserve literal paths and argv and register usable completion`, async t => {
  const { temp, rcPath } = await fixture(t);
  const launcher = path.join(temp, "quote's space $literal `literal` #launcher");
  await fs.writeFile(launcher, '#!/bin/sh\nprintf \'<%s>\\n\' "$@"\n', { mode: 0o700 });
  const prelude = shell === 'zsh' ? 'autoload -Uz compinit\ncompinit -D\n' : '';
  await fs.writeFile(rcPath, prelude + buildBlock('ag-quote', launcher, shell));
  const executable = shell === 'fish' ? process.env.AG_SWITCH_TEST_FISH : `/bin/${shell}`;
  await exec(executable, ['-n', rcPath]);
  const code = shell === 'fish' ? `source "$argv[1]"; ag-quote "one two" 'literal$arg'; complete -C 'ag-quote --mo'` : shell === 'bash' ? `shopt -s expand_aliases; source "$1"; eval 'ag-quote "one two" "literal$arg"'; COMP_WORDS=(ag-quote --mo); COMP_CWORD=1; _ag_switch_ag_quote; printf '%s\\n' "\${COMPREPLY[@]}"` : `source "$1"; eval 'ag-quote "one two" "literal\\$arg"'; print -r -- "\${_comps[ag-quote]}"`;
  const result = await exec(executable, shell === 'fish' ? ['--no-config', '-c', code, rcPath] : ['-c', code, '_', rcPath], { env: { ...process.env, arg: '$arg' } });
  assert.ok(result.stdout.includes('<one two>'));
  assert.ok(result.stdout.includes('<literal$arg>'), result.stdout);
  assert.ok(result.stdout.includes(shell === 'zsh' ? '_ag_switch_ag_quote' : '--model'));
});
test('wizard gathers explicit configuration and cancellation does not apply the preflight plan', async t => {
  const { temp, binary, inspect, rcPath, binDir } = await fixture(t);
  const answers = ['ag-new', binary, rcPath, binDir];
  let planned = false;
  const ui = { text: async (_label, { validate }) => validate(answers.shift()), select: async (_label, choices) => choices.some(c => c.value === 'both') ? 'both' : 'fish', print: () => {}, confirm: async () => false };
  const result = await configure({}, { ui, home: temp, inspect, resolve: async value => value ?? binary, preflight: async config => { planned = true; assert.equal(config.integration.shell, 'fish'); return { edits: [{}] }; } });
  assert.equal(result, null); assert.equal(planned, true);
  assert.equal(await statOrNull(rcPath), null); assert.equal(await statOrNull(binDir), null);
});
