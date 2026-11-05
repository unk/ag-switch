import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProfile, setupProfile, removeProfile, launcherText, doctor } from '../src/profiles.mjs';
import { openStore, loadRegistry, saveRegistry, profileDir, atomicWrite } from '../src/storage.mjs';
import { sha256 } from '../src/runtime.mjs';
import { configure } from '../src/prompts.mjs';
import { parse } from '../src/cli.mjs';

const exec = promisify(execFile);
const isolatedEnv = { ...process.env, PATH: '/usr/bin:/bin' };
async function fixture(t) {
  const temp = await fs.mkdtemp('/private/tmp/ag-switch-lifecycle-');
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "npx's cache");
  await fs.mkdir(source);
  await fs.cp(fileURLToPath(new URL('../src', import.meta.url)), path.join(source, 'src'), { recursive: true });
  await fs.copyFile(fileURLToPath(new URL('../package.json', import.meta.url)), path.join(source, 'package.json'));
  const binary = path.join(temp, 'fake-agy');
  await fs.writeFile(binary, '#!/bin/sh\nprintf \'<%s>\\n\' "$@"\n', { mode: 0o700 });
  // Adapt only the platform so the CLI exercises informational compatibility
  // checks for an unverified executable on every test host.
  const runtime = path.join(source, 'src/runtime.mjs');
  await fs.writeFile(runtime, (await fs.readFile(runtime, 'utf8')).replace("platform: 'darwin', arch: 'arm64'", `platform: '${process.platform}', arch: '${process.arch}'`));
  const store = await openStore(path.join(temp, "store's space"), true);
  const cli = path.join(source, 'src/cli.mjs');
  const binDir = path.join(temp, 'bin');
  const rcPath = path.join(temp, '.zshrc');
  const inspect = async binary => ({ binary, sha256: await sha256(binary), version: 'fixture' });
  const command = (...args) => exec(process.execPath, [cli, ...args, '--root', store.root], { env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` } });
  return { temp, source, store, binary, inspect, cli, binDir, rcPath, command };
}
const tokenPath = (store, name = 'ag-c') => path.join(profileDir(store, name), 'data/antigravity-cli/antigravity-oauth-token');

test('CLI and installed launcher keep running after updates with warnings and valid doctor JSON', async t => {
  const { store, binary, binDir, command } = await fixture(t);
  const versionScript = version => `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = --version ]; then echo ${version}; exit 0; fi\ndone\nprintf '<%s>\\n' "$@"\nexit 17\n`;
  await fs.writeFile(binary, versionScript('1.5.1'));
  const created = await command('create', 'ag-c', '--binary', binary, '--launcher', 'script', '--bin-dir', binDir);
  assert.match(created.stderr, /안내/);
  assert.equal((await loadRegistry(store)).profiles[0].version, '1.5.1');
  await fs.writeFile(tokenPath(store), 'synthetic credential', { mode: 0o600 });
  await fs.writeFile(binary, versionScript('1.5.2'));
  const launched = await exec(path.join(binDir, 'ag-c'), ['--version']);
  assert.equal(launched.stdout.trim(), '1.5.2');
  assert.match(launched.stderr, /변경.*실행을 계속/);
  assert.equal((launched.stderr.match(/안내:/g) ?? []).length, 1);
  await assert.rejects(exec(path.join(binDir, 'ag-c'), ['-p', 'hello world']), error => {
    assert.equal(error.code, 17);
    assert.match(error.stdout, /<hello world>/);
    assert.match(error.stdout, /--gemini_dir=/);
    return true;
  });
  const report = JSON.parse((await command('doctor', '--json', '--binary', binary)).stdout);
  assert.equal(report[0].version, '1.5.2');
  assert.ok(report.every(item => item.ok && item.warnings.length));
  assert.match((await command('doctor', '--binary', binary)).stdout, /WARN ag-c/);
  await command('setup', 'ag-c', '--launcher', 'script');
  assert.equal((await loadRegistry(store)).profiles[0].version, '1.5.2');
  assert.equal(await fs.readFile(tokenPath(store), 'utf8'), 'synthetic credential');
  assert.deepEqual(await fs.readdir(path.join(store.root, 'locks')), []);
});

test('verified upgrades clear warnings for existing registrations but same-version unknown builds still warn', async t => {
  const { store, binary, source, command } = await fixture(t);
  const runtime = path.join(source, 'src/runtime.mjs');
  await fs.writeFile(binary, '#!/bin/sh\necho 1.5.1\n');
  await fs.writeFile(runtime, (await fs.readFile(runtime, 'utf8')).replace(
    '5ce7fbe126eb9abdc78634332a0a1bdd428327fba37ef7d1aeba7553eec55f3f', await sha256(binary),
  ));
  const created = await command('create', 'ag-c', '--binary', binary, '--launcher', 'internal');
  assert.equal(created.stderr, '');
  const registry = await loadRegistry(store);
  registry.profiles[0].sha256 = 'b7a13e53c9f49921692676ef8edc2e60ceb67064c00bc732d9a364ec3ad75b32';
  registry.profiles[0].version = '1.4.7';
  await saveRegistry(store, registry);
  const launcher = path.join(store.root, 'bin/ag-c');
  const launched = await exec(launcher, ['--version']);
  assert.equal(launched.stdout.trim(), '1.5.1');
  assert.equal(launched.stderr, '');
  const known = JSON.parse((await command('doctor', '--json', '--binary', binary)).stdout);
  assert.ok(known.every(item => item.ok && !item.warnings));
  await fs.appendFile(binary, '# different build, same version\n');
  const changed = await exec(launcher, ['--version']);
  assert.equal(changed.stdout.trim(), '1.5.1');
  assert.match(changed.stderr, /안내:.*실행을 계속/);
  const unknown = JSON.parse((await command('doctor', '--json', '--binary', binary)).stdout);
  assert.ok(unknown.every(item => item.ok && item.warnings.length));
});

test('CLI same-name create edits in place, remove/reuse restores shell and named execution', async t => {
  const { store, binary, binDir, rcPath, command } = await fixture(t);
  await command('create', 'ag-c', '--binary', binary, '--launcher', 'both', '--shell', 'zsh', '--rc', rcPath, '--bin-dir', binDir);
  await fs.writeFile(tokenPath(store), 'synthetic credential', { mode: 0o600 });
  const before = await loadRegistry(store);
  const rc = await fs.readFile(rcPath, 'utf8');
  assert.match((await command('create', 'ag-c')).stdout, /실행 설정 변경/);
  assert.equal((await loadRegistry(store)).profiles.length, 1);
  assert.equal((await loadRegistry(store)).profiles[0].createdAt, before.profiles[0].createdAt);
  assert.equal(await fs.readFile(rcPath, 'utf8'), rc);
  await command('remove', 'ag-c', '--yes');
  assert.equal(await fs.readFile(rcPath, 'utf8'), '');
  await assert.rejects(command('create', 'ag-c'), error => /--reuse \/ --recreate/.test(error.stderr));
  await command('create', 'ag-c', '--reuse');
  assert.equal(await fs.readFile(rcPath, 'utf8'), rc);
  assert.equal(await fs.readFile(tokenPath(store), 'utf8'), 'synthetic credential');
  const { stdout } = await exec('/bin/sh', ['-c', 'ag-c -p "one two"'], { env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` } });
  assert.match(stdout, /<one two>/);
  assert.match(stdout, /--gemini_dir=/);
  const alias = await exec('/bin/zsh', ['-f', '-c', 'source "$1"; eval \'ag-c --version\'', '_', rcPath]);
  assert.match(alias.stdout, /<--version>/);
});

test('created launchers survive deletion of the npx/source package', async t => {
  const { store, binary, binDir, source, command } = await fixture(t);
  await command('create', 'ag-c', '--binary', binary, '--launcher', 'script', '--bin-dir', binDir);
  const wrapper = await fs.readFile(path.join(store.root, 'bin/ag-c'), 'utf8');
  assert.ok(!wrapper.includes(source));
  await fs.rm(source, { recursive: true });
  const result = await exec(path.join(binDir, 'ag-c'), ['--version']);
  assert.match(result.stdout, /<--version>/);
  assert.deepEqual(await fs.readdir(path.join(store.root, 'locks')), []);
});

test('recreate archives credentials and conversations and keeps the installed command usable', async t => {
  const { store, binary, binDir, command } = await fixture(t);
  await command('create', 'ag-c', '--binary', binary, '--launcher', 'script', '--bin-dir', binDir);
  await fs.writeFile(tokenPath(store), 'synthetic credential', { mode: 0o600 });
  await fs.writeFile(path.join(profileDir(store, 'ag-c'), 'data/history'), 'conversation');
  const result = await command('create', 'ag-c', '--recreate');
  assert.match(result.stdout, /프로필 재생성/);
  const archives = await fs.readdir(path.join(store.root, 'backups'));
  assert.equal(archives.length, 1);
  const archive = path.join(store.root, 'backups', archives[0]);
  assert.equal(await fs.readFile(path.join(archive, 'data/antigravity-cli/antigravity-oauth-token'), 'utf8'), 'synthetic credential');
  assert.equal(await fs.readFile(path.join(archive, 'data/history'), 'utf8'), 'conversation');
  assert.equal((await fs.stat(archive)).mode & 0o777, 0o700);
  await assert.rejects(fs.stat(tokenPath(store)), { code: 'ENOENT' });
  assert.match((await exec(path.join(binDir, 'ag-c'), ['--version'])).stdout, /<--version>/);
  await command('remove', 'ag-c', '--yes');
  assert.match((await command('create', 'ag-c', '--recreate')).stdout, /프로필 재생성/);
});

test('setup migrates legacy launchers from a removed installation and repairs missing launchers', async t => {
  const { store, binary, inspect, binDir, temp } = await fixture(t);
  await createProfile(store, 'ag-c', binary, { inspect, env: isolatedEnv });
  const registry = await loadRegistry(store);
  delete registry.profiles[0].launcher;
  await saveRegistry(store, registry);
  const wrapper = path.join(store.root, 'bin/ag-c');
  await atomicWrite(wrapper, launcherText(store, 'ag-c', { node: process.execPath, cli: path.join(temp, "missing's npx cache/src/cli.mjs") }), 0o700);
  await setupProfile(store, 'ag-c', { mode: 'script', binDir }, { inspect, env: isolatedEnv });
  assert.equal((await doctor(store, { inspect, env: isolatedEnv }))[0].ok, true);
  assert.ok(!(await fs.readFile(wrapper, 'utf8')).includes('missing'));
  await fs.unlink(wrapper);
  await setupProfile(store, 'ag-c', { mode: 'script', binDir }, { inspect, env: isolatedEnv });
  assert.equal((await doctor(store, { inspect, env: isolatedEnv }))[0].ok, true);
});

test('failed recreation restores original data, registry, shell and launchers', async t => {
  const { temp, store, binary, inspect, binDir, rcPath } = await fixture(t);
  await createProfile(store, 'ag-c', binary, { inspect, env: isolatedEnv, integration: { mode: 'both', shell: 'zsh', rcPath, binDir } });
  await fs.writeFile(tokenPath(store), 'synthetic credential', { mode: 0o600 });
  const registry = await loadRegistry(store);
  const rc = await fs.readFile(rcPath, 'utf8');
  const wrapper = await fs.readFile(path.join(store.root, 'bin/ag-c'), 'utf8');
  const badParent = path.join(temp, 'blocked');
  await fs.mkdir(badParent, { mode: 0o777 });
  await fs.chmod(badParent, 0o777);
  await assert.rejects(createProfile(store, 'ag-c', binary, { inspect, env: isolatedEnv, recreate: true, integration: { mode: 'both', shell: 'zsh', rcPath, binDir: badParent } }), /권한/);
  assert.equal(await fs.readFile(tokenPath(store), 'utf8'), 'synthetic credential');
  assert.deepEqual(await loadRegistry(store), registry);
  assert.equal(await fs.readFile(rcPath, 'utf8'), rc);
  assert.equal(await fs.readFile(path.join(store.root, 'bin/ag-c'), 'utf8'), wrapper);
  assert.equal((await doctor(store, { inspect, env: isolatedEnv }))[0].ok, true);
});

test('legacy retained data without saved settings can be reused and mutually exclusive actions fail', async t => {
  const { store, binary, inspect } = await fixture(t);
  await createProfile(store, 'ag-c', binary, { inspect, env: isolatedEnv });
  await removeProfile(store, 'ag-c');
  const marker = path.join(profileDir(store, 'ag-c'), 'profile.json');
  const owner = JSON.parse(await fs.readFile(marker, 'utf8'));
  delete owner.settings;
  await atomicWrite(marker, JSON.stringify(owner));
  await createProfile(store, 'ag-c', binary, { inspect, env: isolatedEnv, reuse: true });
  assert.equal((await doctor(store, { inspect, env: isolatedEnv }))[0].ok, true);
  assert.throws(() => parse(['create', 'ag-c', '--reuse', '--recreate']), /함께/);
});

for (const retained of [false, true]) test(`wizard accepts an existing name and offers edit/restore, recreate and cancel (retained=${retained})`, async () => {
  const existing = { name: 'ag-c', binary: '/fake/agy', retained, integration: { mode: 'script', scriptPath: '/tmp/bin/ag-c' } };
  for (const action of ['reuse', 'recreate', 'cancel']) {
    let lookedUp = false, planned = false;
    const ui = {
      text: async (_label, { initial, validate }) => validate(initial || 'ag-c'),
      select: async (_label, choices, initial) => {
        if (choices.some(c => c.value === 'cancel')) { assert.equal(initial, 'reuse'); return action; }
        assert.equal(initial, 'script'); return initial;
      },
      print: () => {}, confirm: async () => true,
    };
    const result = await configure({}, { ui, lookup: async name => { assert.equal(name, 'ag-c'); lookedUp = true; return existing; }, preflight: async config => { planned = true; assert.equal(config.integration.binDir, '/tmp/bin'); } });
    assert.equal(lookedUp, true);
    assert.equal(planned, action !== 'cancel');
    if (action === 'cancel') assert.equal(result, null);
    else { assert.equal(result.reuse, action === 'reuse'); assert.equal(result.recreate, action === 'recreate'); }
  }
});
