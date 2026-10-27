import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MARKER, STAGES, childEnv, profilePath, profileArgs, inventory, changes, safeNote,
  requirePrevious, observations, sha256, assertPinned, writeJSON, loadRun, capture, baseline,
} from './lib.mjs';
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp('/private/tmp/ag-switch-poc-test-');
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['profiles', 'profiles/a', 'profiles/b', 'workspace', 'evidence', 'sessions', 'tmp', 'cache', 'xdg-config', 'xdg-data']) await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  const binary = path.join(root, 'fake-agy');
  await fs.writeFile(binary, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true' || !process.env.SSH_TTY) process.exit(9);
if (args.includes('--version')) {console.log('1.4.7'); process.exit(0)}
if (args.includes('--help')) {console.log('Usage: agy'); process.exit(0)}
for (const name of ['gemini_dir','app_data_dir']) if(args.includes('--'+name)){console.error('flag needs an argument: --'+name);process.exit(2)}
const root=args.find(x=>x.startsWith('--gemini_dir=')).split('=').slice(1).join('=');
fs.mkdirSync(path.join(root,'antigravity-cli','log'),{recursive:true});
fs.writeFileSync(path.join(root,'antigravity-cli','log','cli.log'),'Using file-based token storage because SSH session detected');
console.log('Not logged in. https://example.invalid/oauth?code=SECRET_FIXTURE user@example.invalid');
process.exit(1);
`, { mode: 0o700 });
  const manifest = { marker: MARKER, root, uid: process.getuid(), binary, sha256: await sha256(binary), stages: Object.fromEntries(STAGES.map(s => [s, { status: 'unverified' }])) };
  await writeJSON(path.join(root, 'run.json'), manifest);
  return { root, binary, manifest };
}
const run = args => capture(process.execPath, [runner, ...args], { timeoutMs: 15000 });

test('child env removes competing auth and remote hints without mutating the parent', () => {
  const parent = { HOME: '/real/home', PATH: '/bin', GEMINI_API_KEY: 'secret', AGY_ADC_AUTH: 'true', AGY_LLM_GATEWAY_URL: 'secret', GOOGLE_APPLICATION_CREDENTIALS: '/secret', ANTIGRAVITY_CREDENTIAL_SCOPE: 'other', SSH_CONNECTION: 'real', SSH_AUTH_SOCK: '/sock' };
  const original = { ...parent };
  const { env, removed } = childEnv(parent, '/private/tmp/example');
  assert.deepEqual(parent, original);
  assert.equal(env.HOME, parent.HOME);
  assert.equal(env.PATH, parent.PATH);
  assert.equal(env.SSH_TTY, '/dev/ag-switch-poc');
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(removed.length, 7);
});
test('profile path and args reject traversal and remain distinct', () => {
  assert.throws(() => profilePath('/tmp/run', '../a'));
  assert.throws(() => profilePath('/tmp/run', undefined));
  assert.notDeepEqual(profileArgs('/tmp/run', 'a'), profileArgs('/tmp/run', 'b'));
});
test('inventory never traverses a symlink and detects content/mode changes', async t => {
  const { root } = await fixture(t);
  const dir = profilePath(root, 'a');
  await fs.symlink('/etc', path.join(dir, 'escape'));
  await fs.writeFile(path.join(dir, 'token'), 'fixture', { mode: 0o600 });
  const before = await inventory(dir);
  assert.equal(before.escape.type, 'symlink');
  assert.equal(Object.keys(before).some(x => x.startsWith('escape/')), false);
  await fs.chmod(path.join(dir, 'token'), 0o644);
  assert.deepEqual(changes(before, await inventory(dir)), ['token']);
});
test('runtime rejects foreign roots, broad permissions and symlinked profiles', async t => {
  const { root } = await fixture(t);
  await loadRun(root);
  const alias = `${root}-link`;
  await fs.symlink(root, alias);
  t.after(() => fs.rm(alias, { force: true }));
  await assert.rejects(loadRun(alias), /심볼릭/);
  await assert.rejects(loadRun('/private/tmp'), /전용/);
  await fs.chmod(root, 0o755);
  await assert.rejects(loadRun(root), /0700/);
  await fs.chmod(root, 0o700);
  await fs.rmdir(path.join(root, 'profiles/a'));
  await fs.symlink(path.join(root, 'workspace'), path.join(root, 'profiles/a'));
  await assert.rejects(loadRun(root), /0700/);
});
test('version pin detects a replaced CLI', async t => {
  const { binary, manifest } = await fixture(t);
  await assertPinned(manifest);
  await fs.appendFile(binary, '\n// replaced');
  await assert.rejects(assertPinned(manifest), /해시/);
});
test('later experiments cannot skip required evidence', () => {
  const manifest = { stages: Object.fromEntries(STAGES.map(s => [s, { status: 'unverified' }])) };
  assert.throws(() => requirePrevious(manifest, 'P2'), /P0/);
  manifest.stages.P0.status = 'pass';
  assert.throws(() => requirePrevious(manifest, 'P2'), /P1/);
  manifest.stages.P1.status = 'pass';
  requirePrevious(manifest, 'P2');
  assert.throws(() => requirePrevious(manifest, 'P6'), /P2/);
});
test('notes reject common credentials, URLs and real account labels', () => {
  for (const note of ['', 'a@example.com', 'https://example.com', 'refresh_token=secret', 'ya29.secret', '1//example_token']) assert.throws(() => safeNote(note));
  assert.equal(safeNote(' A·B 경로가 다름 '), 'A·B 경로가 다름');
});
test('observations distinguish intentional SSH storage from a timeout fallback', () => {
  const ssh = observations('Using file-based token storage because SSH session detected\nNot logged in');
  assert.equal(ssh.sshFileStorage, true);
  assert.equal(ssh.loginRequired, true);
  assert.equal(ssh.fallbackStorage, false);
  const timeout = observations('Using file-based token storage because a keyring timeout was recorded within the last 24h');
  assert.equal(timeout.fallbackStorage, true);
  assert.equal(timeout.sshFileStorage, false);
});
test('capture terminates a stalled process group', async () => {
  const result = await capture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
});
test('CLI validates parser behavior, protects stages and persists no raw output', async t => {
  const { root } = await fixture(t);
  const inspected = await run(['inspect', '--root', root]);
  assert.equal(inspected.code, 0, inspected.output);
  const info = JSON.parse(inspected.output);
  assert.equal(info.version, '1.4.7');
  assert.equal(info.flags.gemini_dir.missingValueRecognized, true);
  assert.equal(info.flags.app_data_dir.missingValueRecognized, true);
  const gated = await run(['probe', '--root', root]);
  assert.equal(gated.code, 1);
  const recorded = await run(['record', '--root', root, '--stage', 'P0', '--status', 'pass', '--note', '테스트의 환경 기준 확인']);
  assert.equal(recorded.code, 0, recorded.output);
  const probed = await run(['probe', '--root', root]);
  assert.equal(probed.code, 0, probed.output);
  assert.equal(probed.output.includes('SECRET_FIXTURE'), false);
  assert.equal(probed.output.includes('user@example'), false);
  const names = await fs.readdir(path.join(root, 'evidence'));
  for (const name of names) {
    const content = await fs.readFile(path.join(root, 'evidence', name), 'utf8');
    assert.equal(content.includes('SECRET_FIXTURE'), false);
    assert.equal(content.includes('user@example'), false);
  }
  const data = await loadRun(root);
  assert.equal(data.manifest.stages.P1.status, 'unverified');
  const launch = await run(['launch', '--root', root, '--profile', 'a']);
  assert.equal(launch.code, 1);
  assert.match(launch.output, /P1/);
  const secondProbe = await run(['probe', '--root', root]);
  assert.equal(secondProbe.code, 1);
  const cleanup = await run(['cleanup', '--root', root]);
  assert.equal(cleanup.code, 1);
  await fs.access(root);
});
test('stop ignores a recorded PID when its start identity does not match', async t => {
  const { root } = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} });
  await writeJSON(path.join(root, 'sessions', 'stale.json'), { pid: child.pid, profile: 'a', identity: 'wrong identity' });
  const result = await run(['stop', '--root', root]);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output).signaled, []);
  assert.equal(process.kill(child.pid, 0), true);
});
test('stop terminates only the registered process group', async t => {
  const { root } = await fixture(t);
  const { processIdentity } = await import('./lib.mjs');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { for (const proc of [child, other]) { try { process.kill(-proc.pid, 'SIGTERM'); } catch {} } });
  const closed = new Promise(resolve => child.once('exit', resolve));
  await writeJSON(path.join(root, 'sessions', 'live.json'), { pid: child.pid, profile: 'a', identity: await processIdentity(child.pid) });
  const result = await run(['stop', '--root', root]);
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(result.output).signaled[0].pid, child.pid);
  await closed;
  assert.equal(process.kill(other.pid, 0), true);
});
test('unfinished runs require the exact discard identifier and cleanup never follows symlinks', async t => {
  const { root } = await fixture(t);
  const external = await fs.mkdtemp('/private/tmp/ag-switch-external-test-');
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.writeFile(path.join(external, 'keep'), 'keep');
  await fs.symlink(external, path.join(root, 'profiles/a/link'));
  const wrong = await run(['cleanup', '--root', root, '--discard-run', 'wrong']);
  assert.equal(wrong.code, 1);
  await fs.access(root);
  const discarded = await run(['cleanup', '--root', root, '--discard-run', path.basename(root)]);
  assert.equal(discarded.code, 0, discarded.output);
  await assert.rejects(fs.access(root), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(external, 'keep'), 'utf8'), 'keep');
});
test('unlock preserves an active owner and recovers an abandoned operation', async t => {
  const { root } = await fixture(t);
  const lock = path.join(root, 'operation.lock');
  await writeJSON(lock, { pid: process.pid });
  const busy = await run(['unlock', '--root', root]);
  assert.equal(busy.code, 1);
  await fs.access(lock);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  await writeJSON(lock, { pid: child.pid });
  const recovered = await run(['unlock', '--root', root]);
  assert.equal(recovered.code, 0, recovered.output);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});
test('unexpected authenticated model response aborts P1 before starting B', async t => {
  const { root, binary, manifest } = await fixture(t);
  const text = await fs.readFile(binary, 'utf8');
  await fs.writeFile(binary, text.replace('process.exit(1);', "console.log('AG_SWITCH_POC_A');process.exit(0);"));
  manifest.sha256 = await sha256(binary);
  manifest.stages.P0 = { status: 'pass' };
  await writeJSON(path.join(root, 'run.json'), manifest);
  const result = await run(['probe', '--root', root]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /중단 조건/);
  assert.equal((await loadRun(root)).manifest.stages.P1.status, 'fail');
  assert.deepEqual(await fs.readdir(profilePath(root, 'b')), []);
});

test('normal cleanup compares the original baseline after deleting a completed run', async t => {
  const { root, manifest } = await fixture(t);
  for (const stage of STAGES) manifest.stages[stage] = { status: 'pass' };
  await writeJSON(path.join(root, 'run.json'), manifest);
  await writeJSON(path.join(root, 'evidence/baseline.json'), await baseline());
  const result = await run(['cleanup', '--root', root]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /"postCleanupMatchesBaseline": true/);
  await assert.rejects(fs.access(root), { code: 'ENOENT' });
});
test('cleanup preserves unfinished review data when the original baseline has drifted', async t => {
  const { root, manifest } = await fixture(t);
  for (const stage of STAGES) manifest.stages[stage] = { status: 'pass' };
  await writeJSON(path.join(root, 'run.json'), manifest);
  const original = await baseline();
  original.keychain = { status: 'fixture-before-external-use' };
  await writeJSON(path.join(root, 'evidence/baseline.json'), original);
  const result = await run(['cleanup', '--root', root]);
  assert.equal(result.code, 1);
  assert.match(result.output, /원래 기준 상태와 차이/);
  await fs.access(root);
});
test('cleanup accepts an explicit reviewed checkpoint while retaining the original difference', async t => {
  const { root, manifest } = await fixture(t);
  for (const stage of STAGES) manifest.stages[stage] = { status: 'pass' };
  await writeJSON(path.join(root, 'run.json'), manifest);
  const current = await baseline(), original = structuredClone(current);
  original.keychain = { status: 'fixture-before-external-use' };
  const originalFile = path.join(root, 'evidence/baseline.json');
  await writeJSON(originalFile, original);
  await writeJSON(path.join(root, 'evidence/baseline-review.json'), {
    marker: 'ag-switch-baseline-review-v1', root, originalBaselineSha256: await sha256(originalFile),
    acceptedChanges: { files: [], keychain: true }, checkpoint: current, note: '테스트의 외부 변경 원인 확인',
  });
  const result = await run(['cleanup', '--root', root, '--baseline-review', 'baseline-review.json']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /"postCleanupMatchesBaseline": false/);
  assert.match(result.output, /"postCleanupMatchesReviewedBaseline": true/);
  await assert.rejects(fs.access(root), { code: 'ENOENT' });
});
test('baseline review rejects a replaced original or new changes after review', async () => {
  const { validateBaselineReview } = await import('./lib.mjs');
  const original = { files: {}, keychain: { status: 'old' } };
  const current = { files: {}, keychain: { status: 'found', metadataDigest: 'first' } };
  const review = { marker: 'ag-switch-baseline-review-v1', root: '/run', originalBaselineSha256: 'digest', checkpoint: current, acceptedChanges: { files: [], keychain: true }, note: '외부 변경 확인' };
  validateBaselineReview(review, '/run', 'digest', original, current);
  assert.throws(() => validateBaselineReview(review, '/run', 'replacement', original, current), /출처/);
  assert.throws(() => validateBaselineReview(review, '/run', 'digest', original, { ...current, keychain: { status: 'found', metadataDigest: 'second' } }), /추가 변경/);
});
