import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { initialize, loadValidation, credentials } from '../scripts/validate-oauth.mjs';
import { prepareLogout, verifyLoggedOut, verifyRelogin } from '../scripts/validate-logout.mjs';
import { sha256 } from '../src/runtime.mjs';
import { profileDir, writeJSON, readJSON } from '../src/storage.mjs';

async function fixture(t) {
  const parent = await fs.mkdtemp('/private/tmp/ag-switch-logout-test-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const binary = path.join(parent, 'fake-agy');
  await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const inspect = async file => ({ binary: file, sha256: await sha256(file), version: 'fixture' });
  let metadata = 'initial';
  const getBaseline = async () => ({ files: {}, keychain: { status: 'found', metadataDigest: metadata } });
  const info = await initialize(parent, { binary, inspect, getBaseline });
  const context = await loadValidation(info.root);
  const token = p => path.join(profileDir(context.store, context.state.names[p]), 'data/antigravity-cli/antigravity-oauth-token');
  const login = (p, access = `access-${p}`, email = `${p}@example.invalid`) => writeJSON(token(p), { id_token_email: email, token: { access_token: access, refresh_token: `refresh-${p}`, expiry: '2099-01-01T00:00:00Z' } });
  await login('a'); await login('b');
  context.state.auth = await credentials(context.store, context.state.key);
  context.state.phases.renewal = { status: 'pass' };
  context.state.conversations = { a: '11111111-1111-1111-1111-111111111111', b: '22222222-1111-1111-1111-111111111111' };
  const control = async () => ({ successful: true, conversation: '33333333-1111-1111-1111-111111111111', fileCredentialsAbsent: true });
  const requested = [];
  const session = (ctx, p) => ({ profile: p, record: {}, start: async () => {}, close: async () => {}, ask: async () => { requested.push(p); return { successful: true, responseMatches: true, conversation: ctx.state.conversations[p] }; } });
  const run = async () => ({ output: 'Not logged in', code: 1, timedOut: true });
  return { context, token, login, requested, changeMetadata: () => { metadata = 'background-change'; }, options: { inspect, getBaseline, control, session, run } };
}
test('logout verification requires renewal and never treats an authenticated A as logged out', async t => {
  const { context, options, requested } = await fixture(t);
  delete context.state.phases.renewal;
  await assert.rejects(prepareLogout(context, options), /자연 갱신/);
  context.state.phases.renewal = { status: 'pass' };
  await prepareLogout(context, options);
  const result = await verifyLoggedOut(context, options);
  assert.equal(result.reason, 'official-logout-required');
  assert.deepEqual(requested, []);
});
test('logout and relogin validate functional isolation while preserving unrelated keychain observations', async t => {
  const { context, options, token, login, requested, changeMetadata } = await fixture(t);
  assert.equal((await prepareLogout(context, options)).phase, 'awaiting-logout');
  await fs.unlink(token('a')); changeMetadata();
  const loggedOut = await verifyLoggedOut(context, options);
  assert.equal(loggedOut.status, 'pass');
  assert.equal(loggedOut.phase, 'awaiting-relogin');
  assert.equal(loggedOut.comparisons.userLogout.keychain, true);
  assert.equal(loggedOut.metadataChangesAreObservations, true);
  assert.equal((await verifyRelogin(context, options)).reason, 'official-relogin-required');
  await login('a', 'replacement-access');
  const relogged = await verifyRelogin(context, options);
  assert.equal(relogged.status, 'pass');
  assert.equal(context.state.phases.logout.status, 'pass');
  assert.deepEqual(requested, ['b', 'a', 'b']);
  assert.equal(JSON.stringify(relogged).includes('replacement-access'), false);
});
test('logout verification detects a changed peer credential before any validation request', async t => {
  const { context, options, token, login, requested } = await fixture(t);
  await prepareLogout(context, options);
  await fs.unlink(token('a')); await login('b', 'unexpected-change');
  const result = await verifyLoggedOut(context, options);
  assert.equal(result.status, 'unverified');
  assert.equal(result.checks.bCredentialUnchangedDuringUserLogout, false);
  assert.deepEqual(requested, []);
  assert.equal((await readJSON(context.root + '/evidence/logout-checkpoint.json')).phase, 'review-required');
});
test('relogin must use the original A account and default-control failures cannot create a checkpoint', async t => {
  const { context, options, token, login, requested } = await fixture(t);
  await assert.rejects(prepareLogout(context, { ...options, control: async () => { throw new Error('default request failed'); } }), /default request failed/);
  await assert.rejects(fs.stat(context.root + '/evidence/logout-checkpoint.json'), { code: 'ENOENT' });
  await prepareLogout(context, options); await fs.unlink(token('a'));
  await verifyLoggedOut(context, options);
  await login('a', 'new-access', 'wrong@example.invalid');
  await assert.rejects(verifyRelogin(context, options), /원래 A 계정/);
  assert.deepEqual(requested, ['b']);
});
