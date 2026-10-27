import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { initialize, loadValidation, readiness, credentials, probe, verify, productSession, assessBaseline, baselineDigest } from '../scripts/validate-oauth.mjs';
import { sha256 } from '../src/runtime.mjs';
import { profileDir, writeJSON, readJSON } from '../src/storage.mjs';
import { Session } from '../poc/verify.mjs';

const original = { at: 'fixture', files: {}, keychain: { status: 'found', metadataDigest: 'fixture' } };
const getBaseline = async () => structuredClone(original);
async function fixture(t) {
  const parent = await fs.mkdtemp('/private/tmp/ag-switch-oauth-test-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const binary = path.join(parent, 'fake-agy');
  await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const inspect = async file => ({ binary: file, sha256: await sha256(file), version: 'fixture' });
  const info = await initialize(parent, { binary, inspect, getBaseline });
  const context = await loadValidation(info.root);
  return { parent, context, binary, inspect };
}
async function login(context, p, email = `${p}@example.invalid`) {
  const name = context.state.names[p];
  await writeJSON(path.join(profileDir(context.store, name), 'data/antigravity-cli/antigravity-oauth-token'), {
    id_token_email: email, token: { access_token: `secret-access-${p}`, refresh_token: `secret-refresh-${p}`, expiry: '2099-01-01T00:00:00Z' },
  });
}
test('validation init requires visible native keychain and creates private product profiles', async t => {
  const { context, binary, inspect, parent } = await fixture(t);
  assert.equal((await fs.stat(context.root)).mode & 0o777, 0o700);
  assert.equal((await credentials(context.store, context.state.key)).a, null);
  await assert.rejects(initialize(parent, { binary, inspect, getBaseline: async () => ({ ...original, keychain: { status: 'absent' } }) }), /키체인/);
});
test('development stream sessions invoke the generated product launcher with passthrough arguments', async t => {
  const { context } = await fixture(t);
  const session = productSession(context, 'a', '11111111-1111-1111-1111-111111111111');
  const command = await session.launch();
  assert.equal(command.binary, path.join(context.store.root, 'bin/ag-check-a'));
  assert.equal(command.args.includes('--gemini_dir'), false);
  assert.deepEqual(command.args.slice(-2), ['--conversation', '11111111-1111-1111-1111-111111111111']);
  assert.equal(command.cwd, path.join(context.root, 'workspace'));
});
test('readiness requires distinct accounts and natural expiry without changing the prior snapshot', () => {
  assert.equal(readiness({ a: null, b: null }, null, 'login').reason, 'official-login-required');
  const a = { account: 'a', access: 'a1', expiry: '2099-01-01T00:00:00Z' }, b = { ...a, account: 'b', access: 'b1' };
  assert.throws(() => readiness({ a, b: a }, null, 'login'), /서로 다른/);
  const auth = { a, b };
  assert.equal(readiness(auth, auth, 'renewal', 0).reason, 'natural-expiry-pending');
  assert.equal(readiness(auth, auth, 'renewal', Date.parse(a.expiry) + 5000).ready, true);
  assert.throws(() => readiness({ a: { ...a, access: 'changed' }, b }, auth, 'renewal'), /대기 중/);
});
test('missing official login returns pending without launching sessions or declaring success', async t => {
  const { context, inspect } = await fixture(t);
  context.state.phases.probe = { status: 'pass' };
  const result = await verify(context, 'login', { inspect, getBaseline, session: () => { throw new Error('must not launch'); } });
  assert.equal(result.reason, 'official-login-required');
  assert.equal(context.state.phases.login, undefined);
  await assert.rejects(verify(context, 'reconnect', { inspect }), /login/);
});
test('credential snapshots contain only keyed comparisons and never raw account/token values', async t => {
  const { context } = await fixture(t);
  await login(context, 'a'); await login(context, 'b');
  const snapshot = await credentials(context.store, context.state.key);
  assert.notEqual(snapshot.a.account, snapshot.b.account);
  for (const secret of ['secret-access', 'secret-refresh', '@example.invalid']) assert.equal(JSON.stringify(snapshot).includes(secret), false);
});
test('empty-profile probe records only observations and stops before B on unexpected authentication', async t => {
  const { context, inspect } = await fixture(t);
  let calls = 0;
  const result = await probe(context, { inspect, getBaseline, run: async () => {
    calls++;
    return { code: 0, output: 'Successfully authenticated secret@example.invalid\nAG_PRODUCT_UNEXPECTED_LOGIN', timedOut: false, overflow: false };
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'unverified');
  assert.equal(JSON.stringify(result).includes('secret@'), false);
  assert.equal(context.state.phases.probe, undefined);
});
test('baseline drift prevents probes before any model request', async t => {
  const { context, inspect } = await fixture(t);
  await assert.rejects(probe(context, { inspect, getBaseline: async () => ({ ...original, files: { changed: true } }), run: async () => { throw new Error('must not launch'); } }), /기존 환경/);
});
test('explicit baseline review retains original drift and rejects changes since the reviewed checkpoint', async t => {
  const { context } = await fixture(t);
  const current = { ...structuredClone(original), keychain: { status: 'found', metadataDigest: 'reviewed-change' } };
  const review = { marker: 'ag-switch-baseline-review-v1', root: context.root, originalBaselineSha256: baselineDigest(context.state.original),
    acceptedChanges: { files: [], keychain: true }, checkpoint: current, note: '검증 시작 전 차이를 검토함. 원인은 미확정으로 보존.' };
  assert.throws(() => assessBaseline(context, current), /검토/);
  assert.deepEqual(assessBaseline(context, current, review), { originalComparison: { files: [], keychain: true }, baselineReviewAccepted: true });
  assert.deepEqual(context.state.original, original);
  assert.throws(() => assessBaseline(context, { ...current, keychain: { status: 'found', metadataDigest: 'changed-again' } }, review), /추가 변경/);
  assert.throws(() => assessBaseline(context, current, { ...review, originalBaselineSha256: 'wrong' }), /출처/);
});
test('failed stream responses cannot pass login or store an authentication checkpoint', async t => {
  const { context, inspect } = await fixture(t);
  context.state.phases.probe = { status: 'pass' };
  await login(context, 'a'); await login(context, 'b');
  const session = (_context, p) => ({ profile: p, record: {}, start: async () => {}, close: async () => {}, ask: async () => ({ successful: false, responseMatches: false }) });
  const result = await verify(context, 'login', { inspect, getBaseline, session });
  assert.equal(result.status, 'unverified');
  const saved = await readJSON(path.join(context.root, 'validation.json'));
  assert.equal(saved.phases.login, undefined);
  assert.equal(saved.auth, undefined);
});
test('successful login and reconnect persist only verified checkpoints and detect conversation separation', async t => {
  const { context, inspect } = await fixture(t);
  context.state.phases.probe = { status: 'pass' };
  await login(context, 'a'); await login(context, 'b');
  const seen = [];
  const session = (_context, p, previous) => ({
    profile: p, record: {}, start: async () => { seen.push({ p, previous }); }, close: async () => {},
    ask: async () => {
      const conversation = `${p === 'a' ? '11111111' : '22222222'}-1111-1111-1111-111111111111`;
      const folder = path.join(profileDir(context.store, context.state.names[p]), 'data/antigravity-cli/conversations');
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(folder, `${conversation}.json`), '{}', { mode: 0o600 });
      return { successful: true, responseMatches: true, conversation };
    },
  });
  assert.equal((await verify(context, 'login', { inspect, getBaseline, session })).status, 'pass');
  assert.equal((await verify(context, 'reconnect', { inspect, getBaseline, session })).status, 'pass');
  assert.deepEqual(seen.map(item => item.p), ['a', 'b', 'a', 'b', 'a']);
  assert.equal(seen[0].previous, null);
  assert.equal(seen[2].previous, context.state.conversations.a);
  const saved = await readJSON(path.join(context.root, 'validation.json'));
  assert.equal(saved.phases.reconnect.status, 'pass');
  for (const secret of ['secret-access', 'secret-refresh', '@example.invalid']) assert.equal(JSON.stringify(saved).includes(secret), false);
});
test('stream protocol launch adapter executes the supplied command and preserves frame validation', async t => {
  const { context } = await fixture(t);
  const script = path.join(context.root, 'stream-fixture.mjs');
  await fs.writeFile(script, `import readline from 'node:readline';
if (process.argv[2] !== 'adapter-command') process.exit(9);
readline.createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:request.message.content,conversation_id:'11111111-1111-1111-1111-111111111111'}}));
});\n`, { mode: 0o600 });
  const session = new Session(context.root, context.state, 'a', null, { launch: async () => ({ binary: process.execPath, args: [script, 'adapter-command'], env: process.env, cwd: path.join(context.root, 'workspace') }) });
  t.after(() => session.close());
  await session.start();
  assert.equal((await session.ask('ADAPTER_OK', 'ADAPTER_OK')).responseMatches, true);
  await session.close();
  assert.equal(session.record.result.code, 0);
});
