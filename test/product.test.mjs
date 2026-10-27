import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openStore, loadRegistry, profileDir, validateName, lock, unlock, writeJSON, validateProfile,
} from '../src/storage.mjs';
import { createProfile, removeProfile, runProfile, doctor, shellQuote } from '../src/profiles.mjs';
import { childEnv, launchArgs, inspectBinary, sha256, runChild } from '../src/runtime.mjs';
import { parse } from '../src/cli.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-switch-product-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const store = await openStore(path.join(temp, "store's space #"), true);
  const binary = path.join(temp, 'fake-agy');
  await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const inspect = async file => ({ binary: file, sha256: await sha256(file), version: 'fixture' });
  return { temp, store, binary, inspect };
}
async function capture(binary, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

test('names and command parsing reject traversal, reserved names, duplicates and accidental forwarded flags', () => {
  for (const value of ['../a', 'A', '', 'a/b', 'agy', 'store', 'a'.repeat(49), undefined]) assert.throws(() => validateName(value));
  assert.equal(validateName('ag-work'), 'ag-work');
  for (const args of [['list', '--purge'], ['run', 'a', '-p', 'hi'], ['create', 'a', '--binary'], ['list', '--json', '--json'], ['remove', 'a', 'b']]) assert.throws(() => parse(args));
  assert.deepEqual(parse(['run', 'ag-work', '--root', '/tmp/root', '--', '-p', 'hello world']).forwarded, ['-p', 'hello world']);
});
test('product environment isolates credentials and caches without changing HOME, cwd or parent env', () => {
  const source = { HOME: '/real/home', PATH: '/bin', SSH_AUTH_SOCK: 'secret', SSH_CONNECTION: 'secret', GOOGLE_API_KEY: 'secret', GEMINI_API_KEY: 'secret', AGY_LLM_GATEWAY_URL: 'secret', API_KEY: 'secret', TERM: 'xterm' };
  const before = { ...source };
  const env = childEnv(source, '/profile');
  assert.deepEqual(source, before);
  assert.equal(env.HOME, '/real/home');
  assert.equal(env.TERM, 'xterm');
  for (const key of ['SSH_AUTH_SOCK', 'SSH_CONNECTION', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AGY_LLM_GATEWAY_URL', 'API_KEY']) assert.equal(env[key], undefined);
  assert.equal(env.SSH_TTY, '/dev/ag-switch');
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(env.TMPDIR, '/profile/tmp');
  assert.equal(env.XDG_CONFIG_HOME, '/profile/xdg-config');
});
test('path override arguments cannot bypass profile isolation', () => {
  for (const value of ['--gemini_dir=/other', '--gemini-dir', '-gemini_dir', '--app_data_dir=x', '--app-data-dir=x', '--GEMINI_DIR=x']) assert.throws(() => launchArgs('/root', [value]));
  assert.deepEqual(launchArgs('/root', ['-p', 'a b', '--', 'file']), ['--gemini_dir=/root/data', '--app_data_dir=antigravity-cli', '-p', 'a b', '--', 'file']);
});
test('registry and launchers survive reload with private permissions and safely quoted paths', async t => {
  const { store, binary, inspect } = await fixture(t);
  await createProfile(store, 'ag-personal', binary, { inspect });
  const reloaded = await openStore(store.root);
  assert.equal((await loadRegistry(reloaded)).profiles[0].name, 'ag-personal');
  await assert.rejects(createProfile(store, 'ag-personal', binary, { inspect }), /이미/);
  for (const [relative, mode] of [['profiles.json', 0o600], ['bin/ag-personal', 0o700], ['profiles/ag-personal/profile.json', 0o600], ['profiles/ag-personal/data', 0o700]]) assert.equal((await fs.stat(path.join(store.root, relative))).mode & 0o777, mode);
  const result = await capture('/bin/sh', ['-c', `printf '%s' ${shellQuote(store.root)}`]);
  assert.equal(result.output, store.root);
  const wrapper = await fs.readFile(path.join(store.root, 'bin/ag-personal'), 'utf8');
  assert.equal(wrapper.includes('fake-agy'), false);
  assert.equal(wrapper.includes(' -- "$@"'), true);
});
test('unknown binaries fail closed before persistent profile state is written', async t => {
  const { store, binary } = await fixture(t);
  await assert.rejects(inspectBinary(binary), /검증|macOS/);
  await assert.rejects(createProfile(store, 'ag-work', binary), /검증|macOS/);
  assert.equal((await loadRegistry(store)).profiles.length, 0);
  const result = await capture(process.execPath, [cli, 'create', 'ag-work', '--root', path.join(store.root, 'untouched'), '--binary', binary]);
  assert.equal(result.code, 1);
  await assert.rejects(fs.stat(path.join(store.root, 'untouched')), { code: 'ENOENT' });
});
test('same-profile lease blocks run and removal while different profiles run concurrently', async t => {
  const { store, binary, inspect } = await fixture(t);
  await createProfile(store, 'ag-a', binary, { inspect });
  await createProfile(store, 'ag-b', binary, { inspect });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const a = runProfile(store, 'ag-a', ['-p', 'a b'], { inspect, execute: async (_binary, args, env) => {
    assert.equal(args[2], '-p'); assert.equal(args[3], 'a b');
    assert.equal(env.HOME, process.env.HOME);
    ready(); await pending; return 17;
  } });
  await started;
  await assert.rejects(runProfile(store, 'ag-a', [], { inspect }), /잠금/);
  await assert.rejects(removeProfile(store, 'ag-a', { purge: true }), /잠금/);
  assert.equal(await runProfile(store, 'ag-b', [], { inspect, execute: async () => 0 }), 0);
  finish(); assert.equal(await a, 17);
  await removeProfile(store, 'ag-a', { purge: true });
});
test('changed binary never starts and launch failures release leases', async t => {
  const { store, binary, inspect } = await fixture(t);
  await createProfile(store, 'ag-work', binary, { inspect });
  await assert.rejects(runProfile(store, 'ag-work', [], { inspect, execute: async () => { throw new Error('spawn fixture'); } }), /spawn fixture/);
  await fs.appendFile(binary, '# replaced\n');
  let executed = false;
  await assert.rejects(runProfile(store, 'ag-work', [], { inspect, execute: async () => { executed = true; } }), /변경/);
  assert.equal(executed, false);
  await removeProfile(store, 'ag-work');
});
test('remove preserves credentials, reuse restores them, purge stays within its profile', async t => {
  const { temp, store, binary, inspect } = await fixture(t);
  await createProfile(store, 'ag-a', binary, { inspect });
  await createProfile(store, 'ag-b', binary, { inspect });
  const token = path.join(profileDir(store, 'ag-a'), 'data/antigravity-cli/antigravity-oauth-token');
  await fs.writeFile(token, 'fixture-credential', { mode: 0o600 });
  await removeProfile(store, 'ag-a');
  assert.equal(await fs.readFile(token, 'utf8'), 'fixture-credential');
  await assert.rejects(createProfile(store, 'ag-a', binary, { inspect }), /reuse/);
  await createProfile(store, 'ag-a', binary, { inspect, reuse: true });
  assert.equal(await fs.readFile(token, 'utf8'), 'fixture-credential');
  const outside = path.join(temp, 'keep');
  await fs.writeFile(outside, 'preserve');
  await fs.symlink(outside, path.join(profileDir(store, 'ag-a'), 'nested-link'));
  await removeProfile(store, 'ag-a', { purge: true });
  assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
  await validateProfile(store, 'ag-b');
  await assert.rejects(fs.stat(profileDir(store, 'ag-a')), { code: 'ENOENT' });
});
test('symlinked roots, profile data, wrappers and loose token permissions are refused', async t => {
  const { temp, store, binary, inspect } = await fixture(t);
  const linked = path.join(temp, 'linked');
  await fs.symlink(store.root, linked);
  await assert.rejects(openStore(linked), /종류/);
  await createProfile(store, 'ag-work', binary, { inspect });
  const dir = profileDir(store, 'ag-work');
  const token = path.join(dir, 'data/antigravity-cli/antigravity-oauth-token');
  await fs.writeFile(token, 'fixture', { mode: 0o644 });
  await fs.chmod(token, 0o644);
  await assert.rejects(runProfile(store, 'ag-work', [], { inspect }), /권한/);
  await fs.unlink(token);
  await fs.rmdir(path.join(dir, 'data/config'));
  await fs.symlink(temp, path.join(dir, 'data/config'));
  await assert.rejects(removeProfile(store, 'ag-work', { purge: true }), /종류/);
  await fs.unlink(path.join(dir, 'data/config'));
  await fs.mkdir(path.join(dir, 'data/config'), { mode: 0o700 });
  const wrapper = path.join(store.root, 'bin/ag-work');
  await fs.unlink(wrapper); await fs.symlink(binary, wrapper);
  await assert.rejects(removeProfile(store, 'ag-work'), /종류/);
});
test('doctor reports credential file presence without reading or printing secret contents', async t => {
  const { store, binary, inspect } = await fixture(t);
  await createProfile(store, 'ag-work', binary, { inspect });
  const file = path.join(profileDir(store, 'ag-work'), 'data/antigravity-cli/antigravity-oauth-token');
  await fs.writeFile(file, 'SECRET user@example.invalid', { mode: 0o600 });
  const report = await doctor(store, { inspect });
  assert.deepEqual(report, [{ name: 'ag-work', ok: true, credentialFile: true }]);
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
  await fs.appendFile(path.join(store.root, 'bin/ag-work'), '# edited');
  assert.equal((await doctor(store, { inspect }))[0].ok, false);
});
test('mutation locks are exclusive and live owners cannot be unlocked', async t => {
  const { store } = await fixture(t);
  const release = await lock(store, 'store');
  await assert.rejects(lock(store, 'store'), /잠금/);
  await assert.rejects(unlock(store, 'store'), /실행 중/);
  await release();
  const again = await lock(store, 'store'); await again();
});
test('unlock refuses a live orphaned child even when its parent is gone', async t => {
  const { store } = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);
  t.after(() => child.kill());
  // Obtain an actually exited PID, rather than guessing an unused one.
  const exited = spawn(process.execPath, ['-e', '']);
  const deadPid = exited.pid;
  await new Promise(resolve => exited.once('close', resolve));
  const file = path.join(store.root, 'locks/ag-work.json');
  await writeJSON(file, { pid: deadPid, childPid: child.pid, id: 'fixture' });
  await assert.rejects(unlock(store, 'ag-work'), /실행 중/);
  child.kill(); await new Promise(resolve => child.once('close', resolve));
  await unlock(store, 'ag-work');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
test('registry corruption fails closed without resetting saved state', async t => {
  const { store } = await fixture(t);
  const file = path.join(store.root, 'profiles.json');
  await fs.writeFile(file, '{bad', { mode: 0o600 });
  await assert.rejects(loadRegistry(store), /JSON/);
  assert.equal(await fs.readFile(file, 'utf8'), '{bad');
});
test('CLI entry works through npm-style symlinks and does not create a store for list', async t => {
  const { temp } = await fixture(t);
  const link = path.join(temp, 'ag-switch'); await fs.symlink(cli, link);
  const version = await capture(process.execPath, [link, '--version']);
  assert.equal(version.output.trim(), '0.2.0');
  const missing = path.join(temp, 'missing');
  const list = await capture(process.execPath, [cli, 'list', '--root', missing, '--json']);
  assert.equal(list.code, 0); assert.deepEqual(JSON.parse(list.output), []);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
});
test('spawn runner preserves exit status and reports its child PID', async () => {
  let registered;
  assert.equal(await runChild(process.execPath, ['-e', 'process.exit(23)'], process.env, async pid => { registered = pid; }), 23);
  assert.equal(Number.isSafeInteger(registered), true);
});
