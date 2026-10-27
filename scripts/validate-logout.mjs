#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadValidation, credentials, productSession } from './validate-oauth.mjs';
import { readJSON, writeJSON, privateDir, statOrNull, profileDir } from '../src/storage.mjs';
import { inspectBinary, sha256 } from '../src/runtime.mjs';
import { Session } from '../poc/verify.mjs';
import { baseline, baselineChanges, activeSessions, capture, observations } from '../poc/lib.mjs';

const checkpointFile = context => path.join(context.root, 'evidence/logout-checkpoint.json');
const tokenFile = (context, p) => path.join(profileDir(context.store, context.state.names[p]), 'data/antigravity-cli/antigravity-oauth-token');
const sameAuth = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function ready(context, inspect = inspectBinary) {
  if (context.state.phases.renewal?.status !== 'pass') throw new Error('자연 갱신 검증부터 통과해야 합니다.');
  if (context.state.phases.logout?.status === 'pass') throw new Error('로그아웃 검증은 이미 통과했습니다.');
  const checked = await inspect(context.state.binary);
  if (checked.sha256 !== context.state.sha256) throw new Error('검증 바이너리가 변경됐습니다.');
  if ((await activeSessions(context.root)).length || (await fs.readdir(context.store.root + '/locks')).length) throw new Error('검증 프로필을 먼저 종료하세요.');
}
async function request(context, p, { session = productSession } = {}) {
  const s = session(context, p, context.state.conversations[p]);
  try {
    await s.start();
    const result = await s.ask('What exact marker did I ask you to remember at the start of this conversation? Reply only that marker. Do not use tools.', context.state.markers[p]);
    if (!result.successful || !result.responseMatches || result.conversation !== context.state.conversations[p] || s.record.toolEvents) throw new Error('프로필 인증·대화 복원 검증 실패');
    return { successful: true, conversationRestored: true, noToolEvents: true };
  } finally { await s.close(); }
}
export async function defaultControl(context, conversation) {
  for (const dir of ['tmp', 'cache', 'xdg-config', 'xdg-data']) await privateDir(path.join(context.root, dir));
  const file = path.join(context.root, 'profiles/default-control/antigravity-cli/antigravity-oauth-token');
  if (await statOrNull(file)) throw new Error('기본 계정 대조군에 파일 인증이 있습니다.');
  const s = new Session(context.root, context.state, 'default-control', conversation);
  try {
    await s.start();
    const result = await s.ask('Reply exactly AG_PRODUCT_DEFAULT_OK, nothing else. Do not use tools.', 'AG_PRODUCT_DEFAULT_OK');
    if (!result.successful || !result.responseMatches || !result.conversation || s.record.toolEvents || await statOrNull(file)) throw new Error('기본 키체인 인증 대조 요청을 통과하지 못했습니다.');
    return { successful: true, conversation: result.conversation, fileCredentialsAbsent: true, noToolEvents: true };
  } finally { await s.close(); }
}
async function report(context, phase, value) {
  const file = path.join(context.root, 'evidence', `${phase}-${Date.now()}.json`);
  await writeJSON(file, value);
  return { ...value, evidence: file };
}
async function checkpoint(context) {
  const value = await readJSON(checkpointFile(context));
  if (value.marker !== 'ag-switch-product-logout-v1' || value.root !== context.root) throw new Error('로그아웃 체크포인트의 출처가 다릅니다.');
  return value;
}
export async function prepareLogout(context, { getBaseline = baseline, inspect = inspectBinary, control = defaultControl } = {}) {
  await ready(context, inspect);
  if (await statOrNull(checkpointFile(context))) throw new Error('기존 로그아웃 체크포인트가 있습니다. 해당 단계에서 재개하세요.');
  const auth = await credentials(context.store, context.state.key);
  if (!auth.a || !auth.b || !['a', 'b'].every(p => auth[p].account === context.state.auth[p].account)) throw new Error('기존 A·B 계정을 확인할 수 없습니다.');
  const initial = await getBaseline();
  const defaultBefore = await control(context);
  const before = await getBaseline();
  const current = await credentials(context.store, context.state.key);
  if (!sameAuth(auth, current)) throw new Error('기본 계정 대조 중 프로필 인증이 변경됐습니다.');
  if (baselineChanges(initial, before).files.length) throw new Error('기본 계정 대조 중 기존 설정이 바뀌었습니다.');
  const value = { marker: 'ag-switch-product-logout-v1', root: context.root, phase: 'awaiting-logout', preparedAt: new Date().toISOString(),
    auth, bDigest: await sha256(tokenFile(context, 'b')), before, defaultBefore,
    originalComparison: baselineChanges(context.state.original, before), defaultControlComparison: baselineChanges(initial, before) };
  await writeJSON(checkpointFile(context), value);
  return report(context, 'logout-prepare', { stage: 'logout', phase: value.phase, at: value.preparedAt,
    defaultAuthenticated: true, defaultFileCredentialsAbsent: true, profileCredentialsUnchanged: true, originalComparison: value.originalComparison,
    defaultControlComparison: value.defaultControlComparison, launcher: path.join(context.store.root, 'bin', context.state.names.a) });
}
export async function verifyLoggedOut(context, { getBaseline = baseline, inspect = inspectBinary, control = defaultControl, session = productSession, run = capture } = {}) {
  await ready(context, inspect);
  const cp = await checkpoint(context);
  if (cp.phase !== 'awaiting-logout') throw new Error('로그아웃 검사 단계가 아닙니다.');
  if (await statOrNull(tokenFile(context, 'a'))) return { stage: 'logout', status: 'unverified', reason: 'official-logout-required' };
  const afterUserLogout = await getBaseline();
  const bUnchanged = cp.bDigest === await sha256(tokenFile(context, 'b'));
  if (!bUnchanged) {
    cp.phase = 'review-required';
    cp.checks = { bCredentialUnchangedDuringUserLogout: false };
    await writeJSON(checkpointFile(context), cp);
    return report(context, 'logout-check', { stage: 'logout', phase: cp.phase, status: 'unverified', checks: cp.checks, reason: 'peer-credential-changed' });
  }
  const result = await run(path.join(context.store.root, 'bin', context.state.names.a), ['-p', 'Reply exactly AG_PRODUCT_LOGOUT_FAILURE. Do not use tools.'], { cwd: path.join(context.root, 'workspace'), timeoutMs: 15000 });
  const seen = observations(result.output);
  const aRequiresLogin = seen.loginRequired && !seen.authSucceeded && !(result.code === 0 && result.output.includes('AG_PRODUCT_LOGOUT_FAILURE')) && !await statOrNull(tokenFile(context, 'a'));
  const bResponse = await request(context, 'b', { session });
  const afterProfiles = await getBaseline();
  const bAfter = (await credentials(context.store, context.state.key)).b;
  const defaultAfter = await control(context, cp.defaultBefore.conversation);
  const afterControl = await getBaseline();
  const checks = { aCredentialRemoved: !await statOrNull(tokenFile(context, 'a')), aRequiresLogin: Boolean(aRequiresLogin),
    bCredentialUnchangedDuringUserLogout: bUnchanged, bCredentialUnchangedDuringChecks: cp.bDigest === await sha256(tokenFile(context, 'b')),
    bAccountStable: bAfter?.account === cp.auth.b.account, bConversationRestored: bResponse.conversationRestored,
    defaultAuthenticatedBeforeAndAfter: cp.defaultBefore.successful && defaultAfter.successful && defaultAfter.fileCredentialsAbsent,
    nativeFilesUnchanged: baselineChanges(cp.before, afterControl).files.length === 0 };
  const comparisons = { userLogout: baselineChanges(cp.before, afterUserLogout), profileChecks: baselineChanges(afterUserLogout, afterProfiles),
    defaultControl: baselineChanges(afterProfiles, afterControl), original: baselineChanges(context.state.original, afterControl) };
  const passed = Object.values(checks).every(Boolean);
  cp.phase = passed ? 'awaiting-relogin' : 'review-required';
  Object.assign(cp, { checks, comparisons, afterLogout: afterControl, loggedOutAt: new Date().toISOString() });
  await writeJSON(checkpointFile(context), cp);
  return report(context, 'logout-check', { stage: 'logout', phase: cp.phase, status: passed ? 'pass' : 'unverified', checks, comparisons,
    metadataChangesAreObservations: true, at: cp.loggedOutAt });
}
export async function verifyRelogin(context, { getBaseline = baseline, inspect = inspectBinary, control = defaultControl, session = productSession } = {}) {
  await ready(context, inspect);
  const cp = await checkpoint(context);
  if (cp.phase !== 'awaiting-relogin') throw new Error('재로그인 검사 단계가 아닙니다.');
  const auth = await credentials(context.store, context.state.key);
  if (!auth.a) return { stage: 'logout', status: 'unverified', reason: 'official-relogin-required' };
  if (auth.a.account !== cp.auth.a.account) throw new Error('원래 A 계정으로 재로그인해야 합니다.');
  const before = await getBaseline();
  const bBefore = await sha256(tokenFile(context, 'b'));
  const aResponse = await request(context, 'a', { session });
  const bResponse = await request(context, 'b', { session });
  const afterProfiles = await getBaseline();
  const defaultAfter = await control(context, cp.defaultBefore.conversation);
  const after = await getBaseline();
  const finalAuth = await credentials(context.store, context.state.key);
  const checks = { ...cp.checks, aReloggedIntoSameAccount: finalAuth.a?.account === cp.auth.a.account,
    aNewAccessToken: auth.a.access !== cp.auth.a.access, bAuthUnchangedAcrossRelogin: sameAuth(auth.b, cp.auth.b),
    bCredentialUnchangedDuringValidation: bBefore === await sha256(tokenFile(context, 'b')),
    aAndBConversationsRestored: aResponse.conversationRestored && bResponse.conversationRestored,
    defaultAuthenticatedAfterRelogin: defaultAfter.successful && defaultAfter.fileCredentialsAbsent,
    nativeFilesUnchangedAcrossRelogin: baselineChanges(cp.afterLogout, after).files.length === 0,
    bothCredentialFilesPrivate: Boolean(finalAuth.a && finalAuth.b) };
  const comparisons = { ...cp.comparisons, acrossRelogin: baselineChanges(cp.afterLogout, after), profileChecksAfterRelogin: baselineChanges(before, afterProfiles),
    defaultControlAfterRelogin: baselineChanges(afterProfiles, after), original: baselineChanges(context.state.original, after) };
  const passed = Object.values(checks).every(Boolean);
  const value = await report(context, 'logout', { stage: 'logout', status: passed ? 'pass' : 'unverified', at: new Date().toISOString(), checks, comparisons, metadataChangesAreObservations: true });
  if (passed) {
    context.state.phases.logout = { status: 'pass', at: value.at, evidence: value.evidence };
    context.state.auth = finalAuth;
    cp.phase = 'complete'; await writeJSON(checkpointFile(context), cp);
    await writeJSON(path.join(context.root, 'validation.json'), context.state);
  }
  return value;
}
async function main(argv) {
  const [command, flag, root] = argv;
  if (argv.length !== 3 || flag !== '--root' || !['prepare', 'check', 'relogin'].includes(command)) throw new Error('사용법: node scripts/validate-logout.mjs prepare|check|relogin --root 검증경로');
  const context = await loadValidation(root);
  const { withLock } = await import('../src/storage.mjs');
  return withLock({ root: context.root }, () => ({ prepare: prepareLogout, check: verifyLoggedOut, relogin: verifyRelogin }[command])(context));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  main(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result, null, 2)); if (result.status === 'unverified' && !result.reason) process.exitCode = 1; }).catch(error => {
    console.error(`제품 로그아웃 검증: ${error.code ? `파일·프로세스 접근 오류 (${error.code})` : error instanceof SyntaxError ? 'JSON 형식 오류' : error.message}`); process.exitCode = 1;
  });
}
