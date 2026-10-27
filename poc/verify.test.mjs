import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { summarizeAuth, parseResult, Session, verifyProfiles } from './verify.mjs';
import { sha256, readJSON, writeJSON, STAGES } from './lib.mjs';
const auth = { id_token_email: 'synthetic@example.invalid', token: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expiry: '2026-10-26T23:39:15+09:00' } };
test('auth evidence contains only keyed fingerprints and whitelisted metadata', () => {
  const evidence = summarizeAuth(auth, '600', 'test-run-key');
  assert.equal(evidence.expiry, '2026-10-26T14:39:15.000Z');
  for (const secret of ['synthetic', 'fixture-access', 'fixture-refresh']) assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.notEqual(summarizeAuth(auth, '600', 'other-key').account, evidence.account);
  assert.equal(summarizeAuth({ ...auth, id_token_email: 'SYNTHETIC@example.invalid ' }, '600', 'test-run-key').account, evidence.account);
});
test('auth evidence rejects missing accounts, tokens and malformed expiry', () => {
  assert.throws(() => summarizeAuth({}, '600', 'key'));
  assert.throws(() => summarizeAuth({ ...auth, token: { ...auth.token, expiry: 'invalid' } }, '600', 'key'));
  assert.throws(() => summarizeAuth({ ...auth, token: { ...auth.token, refresh_token: '' } }, '600', 'key'));
});
test('result checks require success, exact marker and a valid conversation ID', () => {
  const event = { event: 'result', result: { status: 'SUCCESS', response: 'EXPECTED\n', conversation_id: '11111111-1111-1111-1111-111111111111' } };
  assert.deepEqual(parseResult(event, 'EXPECTED'), { successful: true, responseMatches: true, conversation: event.result.conversation_id });
  assert.equal(parseResult({ event: 'init' }, 'EXPECTED'), null);
  assert.equal(parseResult({ ...event, result: { ...event.result, status: 'ERROR' } }, 'EXPECTED').successful, false);
  assert.equal(parseResult({ ...event, result: { ...event.result, response: 'wrong' } }, 'EXPECTED').responseMatches, false);
  assert.equal(parseResult({ ...event, result: { ...event.result, conversation_id: 'not-a-uuid' } }, 'EXPECTED').conversation, null);
});
test('stream session handles multiple turns, records its PID and closes idempotently', async t => {
  const root = await fs.mkdtemp('/private/tmp/ag-switch-poc-stream-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['sessions', 'workspace']) await fs.mkdir(path.join(root, dir));
  const binary = path.join(root, 'fake-agy');
  await fs.writeFile(binary, `#!/usr/bin/env node
const readline = require('node:readline');
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{const x=JSON.parse(line);process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:x.message.content,conversation_id:'11111111-1111-1111-1111-111111111111'}})+'\\n');});
`, { mode: 0o700 });
  const session = new Session(root, { binary, sha256: await sha256(binary) }, 'a');
  t.after(() => session.close());
  await session.start();
  assert.equal((await session.ask('FIRST', 'FIRST')).responseMatches, true);
  assert.equal((await session.ask('SECOND', 'SECOND')).responseMatches, true);
  await session.close();
  const once = await readJSON(session.file);
  await session.close();
  assert.deepEqual(await readJSON(session.file), once);
  assert.ok(once.pid > 1);
  assert.equal(once.result.code, 0);
  assert.equal(JSON.stringify(once).includes('FIRST'), false);
});

test('renewal verification returns a future time without launching CLI before natural expiry', async t => {
  const root = await fs.mkdtemp('/private/tmp/ag-switch-poc-expiry-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence'));
  const key = 'fixture-key', state = { key, auth: {}, conversations: {} };
  for (const profile of ['a', 'b']) {
    const directory = path.join(root, 'profiles', profile, 'antigravity-cli');
    await fs.mkdir(directory, { recursive: true });
    const value = { ...auth, id_token_email: `${profile}@example.invalid`, token: { ...auth.token, expiry: '2099-01-01T00:00:00Z' } };
    await writeJSON(path.join(directory, 'antigravity-oauth-token'), value);
    state.auth[profile] = summarizeAuth(value, '600', key);
  }
  await writeJSON(path.join(root, 'evidence', 'verification-state.json'), state);
  const manifest = { binary: '/does-not-exist', stages: Object.fromEntries(STAGES.map(stage => [stage, { status: 'pass' }])) };
  const report = await verifyProfiles(root, manifest, 'P5');
  assert.equal(report.status, 'unverified');
  assert.equal(report.reason, 'natural-expiry-pending');
  assert.equal(report.nextCheckAt, '2099-01-01T00:00:05.000Z');
  assert.equal(JSON.stringify(report).includes('fixture'), false);
});
test('default control uses its private directory and omits synthetic SSH authentication', async t => {
  const root = await fs.mkdtemp('/private/tmp/ag-switch-poc-control-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['sessions', 'workspace']) await fs.mkdir(path.join(root, dir));
  const binary = path.join(root, 'fake-agy');
  await fs.writeFile(binary, `#!/usr/bin/env node
if(process.env.SSH_TTY || !process.argv.some(x=>x.endsWith('/profiles/default-control'))) process.exit(9);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line); console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:x.message.content,conversation_id:'11111111-1111-1111-1111-111111111111'}}));
});
`, { mode: 0o700 });
  const session = new Session(root, { binary, sha256: await sha256(binary) }, 'default-control');
  t.after(() => session.close());
  await session.start();
  assert.equal((await session.ask('CONTROL', 'CONTROL')).responseMatches, true);
  await session.close();
  assert.equal((await fs.stat(path.join(root, 'profiles/default-control'))).mode & 0o777, 0o700);
});
