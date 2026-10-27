import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import {
  now, profilePath, profileArgs, childEnv, writeJSON, readJSON, assertPinned,
  baseline, baselineChanges, processIdentity, requirePrevious, inventory, observations, APP_DIR, assertPrivateDirectory,
} from './lib.mjs';

export function summarizeAuth(value, mode, key) {
  const email = value?.id_token_email;
  const token = value?.token;
  if (typeof email !== 'string' || !email.includes('@') || typeof token?.access_token !== 'string' || !token.access_token || typeof token?.refresh_token !== 'string' || !token.refresh_token || !Number.isFinite(Date.parse(token.expiry))) {
    throw new Error('지원하는 로그인 파일·만료 시각을 확인할 수 없습니다. 인증 원문은 출력하지 않습니다.');
  }
  const fingerprint = text => createHmac('sha256', key).update(text).digest('hex');
  return {
    account: fingerprint(email.trim().toLowerCase()), access: fingerprint(token.access_token),
    refresh: fingerprint(token.refresh_token), expiry: new Date(token.expiry).toISOString(), mode,
  };
}
export async function authSnapshot(root, key) {
  const result = {};
  for (const profile of ['a', 'b']) {
    const file = path.join(profilePath(root, profile), 'antigravity-cli', 'antigravity-oauth-token');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('안전한 프로필 인증 파일을 확인할 수 없습니다.');
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw new Error('인증 파일 형식을 읽을 수 없습니다. 인증 원문은 출력하지 않습니다.'); }
    result[profile] = summarizeAuth(value, (stat.mode & 0o777).toString(8), key);
  }
  return result;
}
export function parseResult(event, expected) {
  const result = event?.event === 'result' ? event.result : null;
  if (!result) return null;
  return {
    successful: result.status === 'SUCCESS',
    responseMatches: typeof result.response === 'string' && result.response.trim() === expected,
    conversation: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.conversation_id ?? '') ? result.conversation_id : null,
  };
}

// Official stream-json protocol. Raw frames and stderr remain in memory only.
export class Session {
  constructor(root, manifest, profile, conversation, { launch } = {}) {
    this.root = root; this.manifest = manifest; this.profile = profile; this.conversation = conversation;
    this.file = path.join(root, 'sessions', `${randomUUID()}.json`);
    this.record = { profile, kind: 'verification-stream', startedAt: now() };
    this.pending = null; this.buffer = ''; this.closed = false; this.observations = {};
    this.launch = launch;
  }
  async start() {
    await assertPinned(this.manifest);
    const env = childEnv(process.env, this.root).env;
    let args;
    if (this.profile === 'default-control') {
      const control = path.join(this.root, 'profiles', 'default-control');
      await fs.mkdir(control, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(control);
      delete env.SSH_TTY;
      args = [`--gemini_dir=${control}`, `--app_data_dir=${APP_DIR}`];
    } else args = profileArgs(this.root, this.profile);
    args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
    if (this.conversation) args.push('--conversation', this.conversation);
    const command = this.launch ? await this.launch(args) : { binary: this.manifest.binary, args, cwd: path.join(this.root, 'workspace'), env };
    this.child = spawn(command.binary, command.args, { cwd: command.cwd, env: command.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => this.fail('CLI 입력이 닫혔습니다.'));
    this.completion = new Promise(resolve => {
      this.child.once('error', () => { this.closed = true; this.fail('CLI 프로세스를 시작할 수 없습니다.'); resolve({ code: null, spawnError: true }); });
      this.child.once('close', (code, signal) => { this.closed = true; this.fail('결과 수신 전에 CLI가 종료됐습니다.'); resolve({ code, signal }); });
    });
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 1024 * 1024) { this.fail('CLI 프레임 크기 제한을 초과했습니다.'); this.signal('SIGTERM'); return; }
      const lines = this.buffer.split('\n'); this.buffer = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'step_update' && /tool/i.test(event.step_update?.step_type ?? '')) this.record.toolEvents = (this.record.toolEvents ?? 0) + 1;
        if (event.event === 'result' && this.pending) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
          pending.resolve({ ...parseResult(event, pending.expected), profile: this.profile, startedAt: pending.startedAt, endedAt: now() });
        }
      }
    });
    this.child.stderr.on('data', chunk => {
      const seen = observations(chunk.toString('utf8'));
      for (const [key, value] of Object.entries(seen)) this.observations[key] ||= value;
    });
    this.onInt = () => this.signal('SIGINT'); this.onTerm = () => this.signal('SIGTERM');
    process.on('SIGINT', this.onInt); process.on('SIGTERM', this.onTerm);
    try {
      this.record.pid = this.child.pid;
      this.record.identity = await processIdentity(this.child.pid);
      await writeJSON(this.file, this.record);
      if (this.closed || !this.record.identity) throw new Error('검증 프로세스의 실행 식별자를 확인할 수 없습니다.');
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  fail(message) {
    if (!this.pending) return;
    const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.reject(new Error(message));
  }
  signal(signal) {
    if (!this.closed && Number.isSafeInteger(this.child?.pid)) {
      try { process.kill(-this.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  ask(prompt, expected) {
    if (this.pending || this.closed) return Promise.reject(new Error('CLI 세션이 응답 가능한 상태가 아닙니다.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail('응답 제한 시간 90초에 도달했습니다.'); this.signal('SIGTERM'); }, 90000);
      this.pending = { resolve, reject, timer, expected, startedAt: now() };
      this.child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`);
    });
  }
  close() {
    this.closing ??= this.finish();
    return this.closing;
  }
  async finish() {
    if (!this.child) return;
    this.child.stdin.end();
    const term = setTimeout(() => this.signal('SIGTERM'), 3000);
    const kill = setTimeout(() => this.signal('SIGKILL'), 5000);
    const result = await this.completion;
    clearTimeout(term); clearTimeout(kill);
    process.off('SIGINT', this.onInt); process.off('SIGTERM', this.onTerm);
    this.record.endedAt = now(); this.record.result = result; this.record.observations = this.observations;
    await writeJSON(this.file, this.record);
  }
}
const recall = 'What exact marker did I ask you to remember at the start of this conversation? Reply with only that marker, nothing else. Do not use tools.';
const matches = request => request.successful && request.responseMatches && !!request.conversation;
const equalAccounts = (before, after) => ['a', 'b'].every(profile => before[profile].account === after[profile].account);

export async function verifyProfiles(root, manifest, stage) {
  if (!['P2', 'P3', 'P4', 'P5'].includes(stage)) throw new Error('verify --stage에는 P2, P3, P4 또는 P5를 지정하세요.');
  requirePrevious(manifest, stage);
  const file = path.join(root, 'evidence', 'verification-state.json');
  let state;
  try { state = await readJSON(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!state && stage !== 'P2') throw new Error('P2 검증 상태를 먼저 생성하세요.');
  if (!state) state = { key: randomBytes(32).toString('hex'), markers: { a: `AG_A_${randomBytes(8).toString('hex')}`, b: `AG_B_${randomBytes(8).toString('hex')}` }, conversations: {} };
  const beforeAuth = await authSnapshot(root, state.key);
  if (beforeAuth.a.account === beforeAuth.b.account || Object.values(beforeAuth).some(auth => auth.mode !== '600')) throw new Error('서로 다른 두 계정·인증 파일 권한 0600을 확인하지 못했습니다.');
  if (state.auth && !equalAccounts(state.auth, beforeAuth)) throw new Error('이전 검증과 계정이 달라졌습니다. 후속 실험을 중단합니다.');
  if (stage === 'P5') {
    const due = Math.max(...Object.values(state.auth).map(auth => Date.parse(auth.expiry))) + 5000;
    if (Date.now() < due) return { stage, status: 'unverified', reason: 'natural-expiry-pending', nextCheckAt: new Date(due).toISOString() };
  }
  const startedAt = now(), before = await baseline(), requests = [], sessions = [];
  const settings = {};
  let restartWhilePeerRunning = null, profileSettingsSeparated = false, peerAuthUnchangedAfterA = false;
  const start = async (profile, conversation) => {
    const session = new Session(root, manifest, profile, conversation); sessions.push(session); await session.start(); return session;
  };
  const ask = async session => {
    const request = await session.ask(stage === 'P2' ? `Remember this marker for this conversation: ${state.markers[session.profile]}. Reply with exactly ${state.markers[session.profile]}, nothing else. Do not use tools.` : recall, state.markers[session.profile]);
    requests.push(request);
    if (!matches(request)) throw new Error('정상 응답·대화 복원 검증을 통과하지 못했습니다. 원시 응답은 저장하지 않습니다.');
    if (stage !== 'P2' && request.conversation !== state.conversations[session.profile]) throw new Error('대화 ID가 바뀌었습니다.');
    state.conversations[session.profile] = request.conversation;
    return request;
  };
  let failure;
  try {
    if (stage === 'P4') {
      for (const profile of ['a', 'b']) {
        const location = path.join(profilePath(root, profile), 'antigravity-cli', 'settings.json');
        try { settings[profile] = await fs.readFile(location); } catch (error) { if (error.code !== 'ENOENT') throw error; settings[profile] = null; }
        const value = settings[profile] ? JSON.parse(settings[profile].toString('utf8')) : {};
        await writeJSON(location, { ...value, colorScheme: profile === 'a' ? 'dark' : 'light' });
      }
      const a = await start('a', state.conversations.a), b = await start('b', state.conversations.b);
      const first = await Promise.allSettled([ask(a), ask(b)]);
      for (const result of first) if (result.status === 'rejected') throw result.reason;
      await a.close();
      await ask(b);
      const a2 = await start('a', state.conversations.a);
      restartWhilePeerRunning = !b.closed && !!await processIdentity(b.child.pid);
      const second = await Promise.allSettled([ask(a2), ask(b)]);
      for (const result of second) if (result.status === 'rejected') throw result.reason;
      for (const profile of ['a', 'b']) {
        const value = await readJSON(path.join(profilePath(root, profile), 'antigravity-cli', 'settings.json'));
        if (value.colorScheme !== (profile === 'a' ? 'dark' : 'light')) throw new Error('프로필별 설정이 바뀌었습니다.');
      }
      profileSettingsSeparated = true;
    } else {
      for (const profile of stage === 'P3' ? ['a', 'b', 'a'] : ['a', 'b']) {
        const session = await start(profile, stage === 'P2' ? null : state.conversations[profile]);
        await ask(session); await session.close();
        if (stage === 'P5' && profile === 'a') peerAuthUnchangedAfterA = JSON.stringify((await authSnapshot(root, state.key)).b) === JSON.stringify(beforeAuth.b);
      }
    }
  } catch (error) { failure = error; }
  finally {
    const closed = await Promise.allSettled(sessions.map(session => session.close()));
    if (!failure) for (const result of closed) if (result.status === 'rejected') failure = result.reason;
    for (const [profile, original] of Object.entries(settings)) {
      const location = path.join(profilePath(root, profile), 'antigravity-cli', 'settings.json');
      if (original) await fs.writeFile(location, original, { mode: 0o600 }); else await fs.rm(location, { force: true });
    }
  }
  const afterAuth = await authSnapshot(root, state.key), after = await baseline();
  await assertPinned(manifest);
  const comparison = baselineChanges(before, after);
  const storage = {};
  for (const profile of ['a', 'b']) {
    const files = Object.keys(await inventory(path.join(profilePath(root, profile), 'antigravity-cli', 'conversations')));
    const other = profile === 'a' ? 'b' : 'a';
    storage[profile] = { ownConversationPresent: !!state.conversations[profile] && files.some(file => file.includes(state.conversations[profile])), foreignConversationAbsent: !state.conversations[other] || !files.some(file => file.includes(state.conversations[other])) };
  }
  const checks = {
    accountsDifferent: afterAuth.a.account !== afterAuth.b.account,
    accountsStable: equalAccounts(beforeAuth, afterAuth), authPermissionsPrivate: Object.values(afterAuth).every(auth => auth.mode === '600'),
    originalFilesUnchangedDuringVerification: comparison.files.length === 0,
    keychainUnchangedDuringVerification: !comparison.keychain,
    responsesMatched: requests.length > 0 && requests.every(matches),
    noToolEvents: sessions.every(session => !session.record.toolEvents),
    conversationsSeparated: state.conversations.a !== state.conversations.b && Object.values(storage).every(x => x.ownConversationPresent && x.foreignConversationAbsent),
  };
  if (stage === 'P4') {
    checks.restartWhilePeerRunning = restartWhilePeerRunning === true;
    checks.profileSettingsSeparated = profileSettingsSeparated;
    checks.concurrentRequestsOverlapped = requests.length >= 2 && Math.max(...requests.slice(0, 2).map(x => Date.parse(x.startedAt))) < Math.min(...requests.slice(0, 2).map(x => Date.parse(x.endedAt)));
  }
  if (stage === 'P5') checks.peerAuthUnchangedAfterA = peerAuthUnchangedAfterA;
  if (stage === 'P5') checks.bothTokensRenewed = ['a', 'b'].every(profile => state.auth[profile].access !== afterAuth[profile].access && Date.parse(afterAuth[profile].expiry) > Date.parse(state.auth[profile].expiry));
  const report = { stage, startedAt, endedAt: now(), status: !failure && Object.values(checks).every(Boolean) ? 'pass' : 'unverified', checks, comparison, requests, storage, tokenExpiresAt: Object.fromEntries(Object.entries(afterAuth).map(([p, auth]) => [p, auth.expiry])), ...(failure ? { error: failure instanceof SyntaxError ? '설정 파일 형식을 해석할 수 없습니다.' : failure.code ? '파일·프로세스 접근 오류' : failure.message } : {}) };
  const evidence = path.join(root, 'evidence', `verify-${stage}-${Date.now()}.json`);
  await writeJSON(evidence, report);
  if (report.status === 'pass') {
    state.auth = afterAuth;
    await writeJSON(file, state);
  }
  return { ...report, evidence };
}
