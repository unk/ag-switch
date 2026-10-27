import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Session, authSnapshot } from './verify.mjs';
import {
  profilePath, profileArgs, childEnv, assertPinned, capture, baseline, baselineChanges,
  sha256, now, readJSON, writeJSON, processIdentity, requirePrevious,
} from './lib.mjs';
const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const tokenPath = (root, profile) => path.join(profilePath(root, profile), 'antigravity-cli', 'antigravity-oauth-token');
const unchanged = comparison => !comparison.files.length && !comparison.keychain;

async function request(root, manifest, profile, conversation, prompt, expected) {
  const session = new Session(root, manifest, profile, conversation);
  try {
    await session.start();
    const result = await session.ask(prompt, expected);
    if (!result.successful || !result.responseMatches || !result.conversation || session.record.toolEvents) throw new Error('인증 확인 요청이 정상 응답하지 않았습니다.');
    return result;
  } finally { await session.close(); }
}
async function defaultControl(root, manifest, conversation) {
  const file = path.join(root, 'profiles', 'default-control', 'antigravity-cli', 'antigravity-oauth-token');
  if (await exists(file)) throw new Error('기본 인증 대조군에서 파일 인증이 발견됐습니다.');
  const result = await request(root, manifest, 'default-control', conversation, 'Reply exactly AG_DEFAULT_P6_OK, nothing else. Do not use tools.', 'AG_DEFAULT_P6_OK');
  if (await exists(file)) throw new Error('기본 인증 대조군이 파일 인증을 생성했습니다.');
  return { ...result, fileCredentialsAbsent: true };
}

// macOS script supplies a PTY; its transcript goes only to memory and /dev/null.
export async function terminalLogout(root, manifest) {
  await assertPinned(manifest);
  if (!process.stdin.isTTY) throw new Error('로그아웃 검증은 실제 TTY에서 실행해야 합니다.');
  const wrapper = spawn('/usr/bin/script', ['-q', '/dev/null', manifest.binary, ...profileArgs(root, 'a')], {
    cwd: path.join(root, 'workspace'), env: { ...childEnv(process.env, root).env, TERM: 'xterm-256color' }, detached: true, stdio: ['inherit', 'pipe', 'pipe'],
  });
  let screen = '';
  console.log(JSON.stringify({ phase: 'logout-terminal-ready', instruction: 'Type /logout and Enter in the terminal input.' }));
  wrapper.stdout.on('data', chunk => {
    screen = (screen + chunk.toString('utf8')).slice(-131072);
    // Raw UI content is retained only for Boolean diagnostics and never emitted.
  });
  wrapper.stderr.resume();
  let closed = false;
  const completion = new Promise(resolve => {
    wrapper.once('error', () => { closed = true; resolve({ spawnError: true }); });
    wrapper.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  const wrapperFile = path.join(root, 'sessions', `${randomUUID()}.json`);
  const wrapperRecord = { profile: 'a', kind: 'logout-pty-wrapper', pid: wrapper.pid, startedAt: now(), identity: await processIdentity(wrapper.pid) };
  await writeJSON(wrapperFile, wrapperRecord);
  let cli, cliFile, tokenRemoved = false;
  const stop = async signal => {
    for (const proc of [cli, closed ? null : wrapperRecord]) {
      if (proc?.identity && await processIdentity(proc.pid) === proc.identity) {
        try { process.kill(-proc.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  };
  const onSignal = () => { void stop('SIGTERM'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    const started = Date.now(), deadline = started + 25000;

    while (Date.now() < deadline && !closed) {
      if (!cli) {
        const ps = await capture('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { timeoutMs: 2000 });
        if (ps.code !== 0) throw new Error('터미널 자식 프로세스를 확인하지 못했습니다.');
        for (const line of ps.output.split('\n')) {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
          if (match && Number(match[2]) === wrapper.pid && Number(match[1]) === Number(match[3]) && match[4] === manifest.binary) {
            cli = { profile: 'a', kind: 'logout-pty-cli', pid: Number(match[1]), startedAt: now(), identity: await processIdentity(Number(match[1])) };
            cliFile = path.join(root, 'sessions', `${randomUUID()}.json`);
            await writeJSON(cliFile, cli);
          }
        }
      }
      if (!await exists(tokenPath(root, 'a'))) { tokenRemoved = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } finally {

    await stop('SIGTERM');
    const kill = setTimeout(() => { void stop('SIGKILL'); }, 2000);
    const result = await completion;
    clearTimeout(kill);
    // The PTY child has its own process group; do not rely on wrapper exit alone.
    await stop('SIGKILL');
    wrapperRecord.endedAt = now(); wrapperRecord.result = result;
    await writeJSON(wrapperFile, wrapperRecord);
    if (cli) { cli.endedAt = now(); await writeJSON(cliFile, cli); }
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  await assertPinned(manifest);
  return { at: now(), tokenRemoved, terminalChildRecorded: !!cli, uiIndicators: { logoutMentioned: /logout|log out/i.test(screen), confirmationMentioned: /are you sure|confirm|cancel/i.test(screen), loginScreenMentioned: /not signed in|Select login method/i.test(screen), commandInputMentioned: /Type|Enter|Ask|Send/i.test(screen) } };
}

async function unauthenticatedA(root, manifest) {
  const file = path.join(root, 'sessions', `${randomUUID()}.json`);
  const session = { profile: 'a', kind: 'logged-out-probe', startedAt: now() };
  const result = await capture(manifest.binary, [...profileArgs(root, 'a'), '-p', 'Reply exactly AG_A_LOGOUT_FAILURE. Do not use tools.'], {
    cwd: path.join(root, 'workspace'), env: childEnv(process.env, root).env, timeoutMs: 15000,
    onSpawn: async pid => { session.pid = pid; session.identity = await processIdentity(pid); await writeJSON(file, session); },
  });
  session.endedAt = now(); session.result = { code: result.code, signal: result.signal, timedOut: result.timedOut };
  await writeJSON(file, session);
  return { code: result.code, timedOut: result.timedOut, loginRequired: /not (?:logged|signed) in|authentication required|not authenticated|login required|please.*(?:log|sign).*in/i.test(result.output), modelResponded: result.code === 0 && result.output.includes('AG_A_LOGOUT_FAILURE'), tokenStillAbsent: !await exists(tokenPath(root, 'a')) };
}

export async function verifyLogout(root, manifest) {
  requirePrevious(manifest, 'P6');
  await assertPinned(manifest);
  const location = path.join(root, 'evidence', 'P6-state.json');
  const state = await readJSON(path.join(root, 'evidence', 'verification-state.json'));
  let checkpoint;
  try { checkpoint = await readJSON(location); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!checkpoint) {
    if (!process.stdin.isTTY) throw new Error('P6 첫 검증은 실제 TTY에서 /logout을 입력해야 합니다.');
    const original = await authSnapshot(root, state.key);
    const controlBefore = await defaultControl(root, manifest);
    const before = await baseline();
    const bHash = await sha256(tokenPath(root, 'b'));
    const logout = await terminalLogout(root, manifest);
    const comparison = baselineChanges(before, await baseline());
    const bUnchangedImmediately = bHash === await sha256(tokenPath(root, 'b'));
    const loggedOut = logout.tokenRemoved ? await unauthenticatedA(root, manifest) : null;
    const bResponse = await request(root, manifest, 'b', state.conversations.b, 'What exact marker did I ask you to remember at the start of this conversation? Reply with only that marker. Do not use tools.', state.markers.b);
    const controlAfter = await defaultControl(root, manifest, controlBefore.conversation);
    const totalComparison = baselineChanges(before, await baseline());
    const checks = {
      aTokenRemoved: logout.tokenRemoved, aRequiresLogin: loggedOut?.loginRequired === true && !loggedOut.modelResponded && loggedOut.tokenStillAbsent,
      bAuthUnchangedImmediately: bUnchangedImmediately, bAuthStillUnchanged: bHash === await sha256(tokenPath(root, 'b')),
      bResponded: bResponse.successful && bResponse.responseMatches,
      defaultKeychainAuthBeforeAndAfter: controlBefore.successful && controlAfter.successful && controlAfter.fileCredentialsAbsent,
      nativeStateUnchangedAtLogout: unchanged(comparison), nativeStateUnchangedThroughout: unchanged(totalComparison),
    };
    checkpoint = { at: now(), phase: Object.values(checks).every(Boolean) ? 'awaiting-relogin' : 'review-required', beforeAuth: original, before, afterLogout: await baseline(), checks, logout, loggedOut, bResponse, controlBefore, controlAfter, comparison, totalComparison };
    await writeJSON(location, checkpoint);
    if (checkpoint.phase !== 'awaiting-relogin') return { stage: 'P6', status: 'unverified', reason: 'logout-review-required', checks, evidence: location };
  }
  if (checkpoint.phase === 'review-required') return { stage: 'P6', status: 'unverified', reason: 'logout-review-required', checks: checkpoint.checks, evidence: location };
  if (!await exists(tokenPath(root, 'a'))) return { stage: 'P6', status: 'unverified', reason: 'official-relogin-required', checks: checkpoint.checks, evidence: location };
  const current = await authSnapshot(root, state.key);
  if (current.a.account !== checkpoint.beforeAuth.a.account) throw new Error('A 재로그인의 계정이 원래 A 계정과 다릅니다.');
  const before = await baseline(), bBefore = await sha256(tokenPath(root, 'b'));
  const aResponse = await request(root, manifest, 'a', state.conversations.a, 'What exact marker did I ask you to remember at the start of this conversation? Reply with only that marker. Do not use tools.', state.markers.a);
  const bResponse = await request(root, manifest, 'b', state.conversations.b, 'What exact marker did I ask you to remember at the start of this conversation? Reply with only that marker. Do not use tools.', state.markers.b);
  const control = await defaultControl(root, manifest, checkpoint.controlBefore.conversation);
  const after = await baseline(), finalAuth = await authSnapshot(root, state.key);
  const comparison = baselineChanges(before, after), reloginComparison = baselineChanges(checkpoint.afterLogout, after);
  const checks = { ...checkpoint.checks,
    aReloggedIntoSameAccount: current.a.account === checkpoint.beforeAuth.a.account && finalAuth.a.account === checkpoint.beforeAuth.a.account,
    bRetainedSameAccount: finalAuth.b.account === checkpoint.beforeAuth.b.account,
    aReloginIssuedDifferentAccessToken: current.a.access !== checkpoint.beforeAuth.a.access,
    bCredentialUnchangedAcrossRelogin: JSON.stringify(current.b) === JSON.stringify(checkpoint.beforeAuth.b),
    aAndBRespondedAfterRelogin: aResponse.successful && bResponse.successful,
    bCredentialFileUnchangedDuringValidation: bBefore === await sha256(tokenPath(root, 'b')),
    defaultAuthenticatedAfterRelogin: control.successful && control.fileCredentialsAbsent,
    bothCredentialFilesPrivate: finalAuth.a.mode === '600' && finalAuth.b.mode === '600',
    nativeStateUnchangedDuringValidation: unchanged(comparison), nativeStateUnchangedAcrossRelogin: unchanged(reloginComparison),
  };
  const report = { stage: 'P6', status: Object.values(checks).every(Boolean) ? 'pass' : 'unverified', at: now(), checks, aResponse, bResponse, control, comparison, reloginComparison };
  const evidence = path.join(root, 'evidence', `verify-P6-${Date.now()}.json`);
  await writeJSON(evidence, report);
  if (report.status === 'pass') { state.auth = finalAuth; await writeJSON(path.join(root, 'evidence', 'verification-state.json'), state); }
  await assertPinned(manifest);
  return { ...report, evidence };
}
