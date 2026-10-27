#!/usr/bin/env node
// Development-only integration harness. Secrets and raw frames stay outside the repo.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, privateDir, assertPrivate, readJSON, writeJSON, profileDir, validateProfile, statOrNull, withLock } from '../src/storage.mjs';
import { createProfile } from '../src/profiles.mjs';
import { inspectBinary, resolveBinary } from '../src/runtime.mjs';
import { baseline, baselineChanges, capture, observations, inventory, activeSessions, validateBaselineReview } from '../poc/lib.mjs';
import { Session, summarizeAuth } from '../poc/verify.mjs';

const MARKER = 'ag-switch-product-validation-v1';
const names = { a: 'ag-check-a', b: 'ag-check-b' };
const stages = ['login', 'reconnect', 'concurrent', 'renewal'];
const unchanged = diff => !diff.files.length && !diff.keychain;
const tokenFile = (store, name) => path.join(profileDir(store, name), 'data/antigravity-cli/antigravity-oauth-token');
const stateFile = root => path.join(root, 'validation.json');
export async function initialize(parent = '/private/tmp', { getBaseline = baseline, inspect = inspectBinary, binary: input } = {}) {
  const binary = await resolveBinary(input);
  const checked = await inspect(binary);
  const original = await getBaseline();
  // Previous PoC established that this machine has a default keychain entry.
  // A sandbox's false "absent" must not become an accepted baseline.
  if (original.keychain.status !== 'found') throw new Error('기존 키체인 항목을 확인하지 못했습니다. 실제 사용자 권한에서 init을 실행하세요.');
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'ag-switch-oauth-')));
  await fs.chmod(root, 0o700);
  for (const dir of ['workspace', 'evidence', 'sessions', 'locks']) await privateDir(path.join(root, dir));
  const store = await openStore(path.join(root, 'store'), true);
  for (const name of Object.values(names)) await createProfile(store, name, binary, { inspect });
  const state = { marker: MARKER, root, uid: process.getuid(), store: store.root, names, ...checked, original,
    createdAt: new Date().toISOString(), key: randomBytes(32).toString('hex'), phases: {}, conversations: {},
    markers: { a: `AG_PRODUCT_A_${randomBytes(8).toString('hex')}`, b: `AG_PRODUCT_B_${randomBytes(8).toString('hex')}` } };
  await writeJSON(stateFile(root), state);
  return { root, store: store.root, next: 'probe', launchers: Object.fromEntries(Object.entries(names).map(([p, name]) => [p, path.join(store.root, 'bin', name)])) };
}
export async function loadValidation(input) {
  if (!input || !path.isAbsolute(input)) throw new Error('--root에 init 결과의 절대 경로가 필요합니다.');
  await assertPrivate(input, true);
  const root = await fs.realpath(input);
  const state = await readJSON(stateFile(root));
  if (state.marker !== MARKER || state.root !== root || state.uid !== process.getuid() || state.store !== path.join(root, 'store') || JSON.stringify(state.names) !== JSON.stringify(names)) throw new Error('검증 루트의 소유·경로 정보가 다릅니다.');
  for (const dir of ['workspace', 'evidence', 'sessions', 'locks']) await assertPrivate(path.join(root, dir), true);
  const store = await openStore(state.store);
  for (const name of Object.values(names)) await validateProfile(store, name);
  return { root, state, store };
}
async function assertIdle(root, store) {
  if ((await fs.readdir(path.join(store.root, 'locks'))).length || (await activeSessions(root)).length) throw new Error('먼저 검증 프로필의 CLI를 종료하세요. 남은 잠금은 실제 프로세스 종료를 확인한 뒤 unlock으로 복구하세요.');
}
async function pinned(state, inspect = inspectBinary) {
  const checked = await inspect(state.binary);
  if (checked.sha256 !== state.sha256) throw new Error('검증 시작 이후 바이너리가 변경됐습니다.');
}
async function saveReport(context, phase, report) {
  const { root, state } = context;
  const file = path.join(root, 'evidence', `${phase}-${Date.now()}.json`);
  await writeJSON(file, report);
  if (report.status === 'pass') state.phases[phase] = { status: 'pass', at: new Date().toISOString(), evidence: file };
  await writeJSON(stateFile(root), state);
  return { ...report, evidence: file };
}
export async function probe(context, { getBaseline = baseline, inspect = inspectBinary, run = capture } = {}) {
  const { root, state, store } = context;
  await assertIdle(root, store); await pinned(state, inspect);
  if (state.phases.probe || Object.keys(state.phases).some(key => stages.includes(key))) throw new Error('빈 프로필 검사는 새 검증에서 한 번만 수행합니다.');
  for (const name of Object.values(names)) if (await statOrNull(tokenFile(store, name))) throw new Error('이미 인증 파일이 있습니다. 빈 프로필 검사를 실행할 수 없습니다.');
  const before = await getBaseline();
  if (!unchanged(baselineChanges(state.original, before))) throw new Error('시작 기준과 기존 환경이 달라졌습니다. 원인 검토 전에는 진행하지 않습니다.');
  const profiles = {};
  for (const [p, name] of Object.entries(names)) {
    const result = await run(path.join(store.root, 'bin', name), ['-p', 'Reply exactly AG_PRODUCT_UNEXPECTED_LOGIN. Do not use tools.'], { cwd: path.join(root, 'workspace'), timeoutMs: 20000 });
    let text = result.output;
    const data = path.join(profileDir(store, name), 'data');
    for (const [relative, entry] of Object.entries(await inventory(data))) {
      if (entry.type === 'file' && /\.log$/.test(relative) && entry.size <= 1024 * 1024) text += await fs.readFile(path.join(data, relative), 'utf8');
    }
    const seen = observations(text);
    const checks = { sshFileStorage: seen.sshFileStorage, loginRequired: seen.loginRequired, noFallbackStorage: !seen.fallbackStorage,
      noAuthenticatedResponse: !seen.authSucceeded && !(result.code === 0 && result.output.includes('AG_PRODUCT_UNEXPECTED_LOGIN')),
      credentialAbsent: !await statOrNull(tokenFile(store, name)), cleanExit: !result.overflow && result.signal !== 'SIGKILL' };
    profiles[p] = { checks, code: result.code, timedOut: result.timedOut };
    if (!Object.values(checks).every(Boolean)) break;
  }
  await assertIdle(root, store); await pinned(state, inspect);
  const comparison = baselineChanges(before, await getBaseline());
  const passed = Object.keys(profiles).length === 2 && Object.values(profiles).every(p => Object.values(p.checks).every(Boolean)) && unchanged(comparison);
  return saveReport(context, 'probe', { phase: 'probe', at: new Date().toISOString(), status: passed ? 'pass' : 'unverified', profiles, comparison });
}
export async function credentials(store, key) {
  const result = {};
  for (const [p, name] of Object.entries(names)) {
    const file = tokenFile(store, name);
    if (!await statOrNull(file)) { result[p] = null; continue; }
    await assertPrivate(file);
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw new Error('인증 파일 형식을 읽을 수 없습니다. 원문은 출력하지 않습니다.'); }
    result[p] = summarizeAuth(value, '600', key);
  }
  return result;
}
export function readiness(auth, previous, stage, now = Date.now()) {
  if (!auth.a || !auth.b) return { ready: false, reason: 'official-login-required', profiles: Object.entries(auth).filter(([, value]) => !value).map(([p]) => p) };
  if (auth.a.account === auth.b.account) throw new Error('A와 B에 서로 다른 Google 계정으로 로그인하세요.');
  if (previous && ['a', 'b'].some(p => previous[p].account !== auth[p].account)) throw new Error('이전 검증과 계정이 다릅니다.');
  if (stage === 'renewal') {
    if (!previous) throw new Error('앞 단계의 인증 상태가 필요합니다.');
    if (['a', 'b'].some(p => auth[p].access !== previous[p].access || auth[p].expiry !== previous[p].expiry)) throw new Error('대기 중 인증이 변경됐습니다. 자연 갱신 관찰을 새 기준으로 덮어쓰지 않습니다.');
    const due = Math.max(...Object.values(auth).map(value => Date.parse(value.expiry))) + 5000;
    if (now < due) return { ready: false, reason: 'natural-expiry-pending', nextCheckAt: new Date(due).toISOString() };
  }
  return { ready: true };
}
export function productSession(context, p, conversation) {
  const { root, state, store } = context;
  return new Session(root, state, p, conversation, { launch: async () => ({
    binary: path.join(store.root, 'bin', names[p]),
    args: ['--input-format', 'stream-json', '--output-format', 'stream-json', ...(conversation ? ['--conversation', conversation] : [])],
    cwd: path.join(root, 'workspace'), env: { ...process.env },
  }) });
}
export const baselineDigest = original => createHash('sha256').update(JSON.stringify(original)).digest('hex');
export function assessBaseline(context, current, review) {
  const originalComparison = baselineChanges(context.state.original, current);
  if (review) {
    validateBaselineReview(review, context.root, baselineDigest(context.state.original), context.state.original, current);
    return { originalComparison, baselineReviewAccepted: true };
  }
  if (!unchanged(originalComparison)) throw new Error('기존 환경이 원래 기준과 달라졌습니다. 차이를 검토한 뒤 --baseline-review로 재개하세요.');
  return { originalComparison, baselineReviewAccepted: false };
}
export async function verify(context, stage, { getBaseline = baseline, inspect = inspectBinary, session = productSession, review } = {}) {
  const { root, state, store } = context;
  if (!stages.includes(stage)) throw new Error('단계는 login, reconnect, concurrent, renewal입니다.');
  for (const prior of ['probe', ...stages.slice(0, stages.indexOf(stage))]) if (state.phases[prior]?.status !== 'pass') throw new Error(`${prior} 단계부터 통과해야 합니다.`);
  if (state.phases[stage]) throw new Error('이미 통과한 단계입니다. 기존 근거를 보존합니다.');
  await assertIdle(root, store); await pinned(state, inspect);
  const auth = await credentials(store, state.key);
  const ready = readiness(auth, state.auth, stage);
  if (!ready.ready) return { stage, status: 'unverified', ...ready };
  const before = await getBaseline();
  const baselineAssessment = assessBaseline(context, before, review);
  const requests = [], sessions = [], startedAt = new Date().toISOString();
  let peerUnchanged = false, restartedWithPeer = false;
  const start = async p => { const s = session(context, p, stage === 'login' ? null : state.conversations[p]); sessions.push(s); await s.start(); return s; };
  const ask = async s => {
    const p = s.profile;
    const prompt = stage === 'login' ? `Remember this marker: ${state.markers[p]}. Reply exactly ${state.markers[p]}, nothing else. Do not use tools.` : 'What exact marker did I ask you to remember at the start of this conversation? Reply only that marker. Do not use tools.';
    const result = await s.ask(prompt, state.markers[p]); requests.push(result);
    if (!result.successful || !result.responseMatches || !result.conversation || (stage !== 'login' && result.conversation !== state.conversations[p])) throw new Error('응답 또는 대화 복원 검증 실패');
    state.conversations[p] = result.conversation;
  };
  let failure = false;
  try {
    if (stage === 'concurrent') {
      const a = await start('a'), b = await start('b');
      const first = await Promise.allSettled([ask(a), ask(b)]);
      if (first.some(result => result.status === 'rejected')) throw new Error('동시 요청 실패');
      await a.close(); await ask(b);
      const again = await start('a'); restartedWithPeer = !b.closed;
      const second = await Promise.allSettled([ask(again), ask(b)]);
      if (second.some(result => result.status === 'rejected')) throw new Error('재시작 요청 실패');
    } else {
      for (const p of stage === 'reconnect' ? ['a', 'b', 'a'] : ['a', 'b']) {
        const s = await start(p); await ask(s); await s.close();
        if (stage === 'renewal' && p === 'a') peerUnchanged = JSON.stringify((await credentials(store, state.key)).b) === JSON.stringify(auth.b);
      }
    }
  } catch { failure = true; }
  finally { if ((await Promise.allSettled(sessions.map(s => s.close()))).some(result => result.status === 'rejected')) failure = true; }
  const after = await credentials(store, state.key), comparison = baselineChanges(before, await getBaseline());
  await pinned(state, inspect); await assertIdle(root, store);
  const storage = {};
  for (const [p, name] of Object.entries(names)) {
    const files = Object.keys(await inventory(path.join(profileDir(store, name), 'data/antigravity-cli/conversations')));
    storage[p] = files.some(file => file.includes(state.conversations[p])) && !files.some(file => file.includes(state.conversations[p === 'a' ? 'b' : 'a']));
  }
  const checks = { expectedRequestsCompleted: requests.length === ({ login: 2, reconnect: 3, concurrent: 5, renewal: 2 }[stage]),
    responsesMatched: requests.every(r => r.successful && r.responseMatches), accountsStable: ['a', 'b'].every(p => auth[p]?.account === after[p]?.account),
    accountsDifferent: after.a?.account !== after.b?.account, credentialsPrivate: Boolean(after.a && after.b), noToolEvents: sessions.every(s => !s.record.toolEvents),
    conversationsSeparated: state.conversations.a !== state.conversations.b && Object.values(storage).every(Boolean), nativeStateUnchanged: unchanged(comparison) };
  if (stage === 'concurrent') Object.assign(checks, { restartedWithPeer, requestsOverlapped: requests.length >= 2 && Math.max(...requests.slice(0, 2).map(r => Date.parse(r.startedAt))) < Math.min(...requests.slice(0, 2).map(r => Date.parse(r.endedAt))) });
  if (stage === 'renewal') Object.assign(checks, { peerUnchanged, bothRenewed: ['a', 'b'].every(p => after[p]?.access !== auth[p].access && Date.parse(after[p]?.expiry) > Date.parse(auth[p].expiry)) });
  const passed = !failure && Object.values(checks).every(Boolean);
  if (passed) state.auth = after;
  return saveReport(context, stage, { stage, startedAt, endedAt: new Date().toISOString(), status: passed ? 'pass' : 'unverified', checks, comparison,
    ...baselineAssessment,
    tokenExpiresAt: Object.fromEntries(Object.entries(after).map(([p, a]) => [p, a?.expiry ?? null])) });
}
async function main(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--root', '--stage', '--baseline-review'].includes(key) || !rest[i + 1] || options[key]) throw new Error('잘못된 옵션입니다.');
    options[key] = rest[i + 1];
  }
  if (command === 'init') {
    if (rest.length) throw new Error('init은 옵션 없이 실행하세요.');
    return initialize();
  }
  if (!['probe', 'status', 'verify'].includes(command)) throw new Error('사용법: node scripts/validate-oauth.mjs init | probe/status --root 경로 | verify --root 경로 --stage login/reconnect/concurrent/renewal');
  const context = await loadValidation(options['--root']);
  if (command === 'status') {
    const auth = await credentials(context.store, context.state.key);
    return { root: context.root, phases: context.state.phases, credentials: Object.fromEntries(Object.entries(auth).map(([p, value]) => [p, { present: Boolean(value), expiry: value?.expiry ?? null }])), accountsDifferent: auth.a && auth.b ? auth.a.account !== auth.b.account : null };
  }
  if (options['--baseline-review'] && command !== 'verify') throw new Error('--baseline-review는 verify에서만 사용할 수 있습니다.');
  const review = options['--baseline-review'] ? await readJSON(path.resolve(context.root, options['--baseline-review'])) : undefined;
  return withLock({ root: context.root }, () => command === 'probe' ? probe(context) : verify(context, options['--stage'], { review }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  main(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result, null, 2)); if (result.status === 'unverified' && !result.reason) process.exitCode = 1; }).catch(error => {
    // Unexpected OS/JSON errors can contain secret bytes or raw child output.
    console.error(`제품 OAuth 검증: ${error.code ? `파일·프로세스 접근 오류 (${error.code})` : error instanceof SyntaxError ? 'JSON 형식 오류' : error.message}`); process.exitCode = 1;
  });
}
