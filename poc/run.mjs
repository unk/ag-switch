#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyProfiles } from './verify.mjs';
import { verifyLogout } from './logout.mjs';
import {
  STAGES, MARKER, now, profilePath, profileArgs, childEnv, sha256, writeJSON, readJSON,
  loadRun, assertPinned, capture, observations, inventory, baseline,
  requirePrevious, safeNote, processIdentity, activeSessions, baselineChanges, validateBaselineReview,
} from './lib.mjs';

const HELP = `Antigravity 멀티 프로필 PoC (Node.js 22+, macOS)
  node poc/run.mjs init [--binary /absolute/path/agy]
  node poc/run.mjs inspect --root /private/tmp/ag-switch-poc-...
  node poc/run.mjs probe --root ROOT [--profile a|b]
  node poc/run.mjs launch --root ROOT --profile a|b
  node poc/run.mjs check --root ROOT
  node poc/run.mjs verify --root ROOT --stage P2|P3|P4|P5|P6
  node poc/run.mjs record --root ROOT --stage P0 --status pass|fail|unverified --note '비밀값 없는 근거'
  node poc/run.mjs stop --root ROOT
  node poc/run.mjs unlock --root ROOT
  node poc/run.mjs cleanup --root ROOT [--baseline-review baseline-review.json] [--discard-run ag-switch-poc-...]

init이 만든 절대 경로를 후속 명령에 사용합니다. launch는 실제 터미널에서만 실행하며,
P0·P1 통과 기록이 필요합니다. 인증 코드는 해당 CLI에만 입력하세요.
probe는 빈 프로필에만 실행합니다. 원시 CLI 출력과 인증 정보는 저장하지 않습니다.
일반 cleanup은 P7 통과 후에 허용됩니다. 미검증 실험의 의도적 폐기는 --discard-run으로 지정합니다.`;

function parse(argv) {
  const [command = 'help', ...args] = argv;
  const options = {};
  const allowed = {
    init: ['binary'], inspect: ['root'], probe: ['root', 'profile'], launch: ['root', 'profile'],
    check: ['root'], verify: ['root', 'stage'], unlock: ['root'], record: ['root', 'stage', 'status', 'note'], stop: ['root'], cleanup: ['root', 'discard-run', 'baseline-review'], help: [],
  };
  if (!(command in allowed)) throw new Error('알 수 없는 명령입니다. help를 확인하세요.');
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed[command].includes(key) || !args[i + 1] || Object.hasOwn(options, key)) throw new Error('잘못되었거나 중복된 옵션입니다. help를 확인하세요.');
    options[key] = args[i + 1];
  }
  return { command, options };
}
const emit = value => console.log(JSON.stringify(value, null, 2));
const evidencePath = (root, name) => path.join(root, 'evidence', name);
const saveManifest = (root, manifest) => writeJSON(path.join(root, 'run.json'), manifest);

async function init(binaryOption) {
  if (process.platform !== 'darwin') throw new Error('이 PoC는 macOS 환경만 검증합니다.');
  const binary = await fs.realpath(binaryOption ?? path.join(os.homedir(), '.local/bin/agy'));
  const stat = await fs.stat(binary);
  if (!stat.isFile()) throw new Error('실행 바이너리를 찾지 못했습니다.');
  const root = await fs.mkdtemp('/private/tmp/ag-switch-poc-');
  await fs.chmod(root, 0o700);
  for (const relative of ['profiles', 'profiles/a', 'profiles/b', 'workspace', 'evidence', 'sessions', 'tmp', 'cache', 'xdg-config', 'xdg-data']) {
    await fs.mkdir(path.join(root, relative), { mode: 0o700 });
  }
  const manifest = {
    marker: MARKER, root, uid: process.getuid(), createdAt: now(), binary,
    sha256: await sha256(binary), platform: process.platform, arch: process.arch,
    node: process.version, sshVariable: 'SSH_TTY', updateVariable: 'AGY_CLI_DISABLE_AUTO_UPDATE=true',
    stages: Object.fromEntries(STAGES.map(stage => [stage, { status: 'unverified' }])),
  };
  await writeJSON(evidencePath(root, 'baseline.json'), await baseline());
  await saveManifest(root, manifest);
  emit({ root, binary, sha256: manifest.sha256, next: 'inspect', stages: manifest.stages });
}


async function runCaptured(root, manifest, profile, args, options) {
  const file = path.join(root, 'sessions', `${randomUUID()}.json`);
  await assertPinned(manifest);
  const session = { profile, startedAt: now(), kind: 'captured', binarySha256: manifest.sha256 };
  const result = await capture(manifest.binary, args, { ...options, onSpawn: async pid => {
    session.pid = pid;
    session.identity = await processIdentity(pid);
    await writeJSON(file, session);
  } });
  session.endedAt = now();
  session.result = { code: result.code, signal: result.signal, timedOut: result.timedOut };
  session.binaryUnchanged = await sha256(manifest.binary) === manifest.sha256;
  await writeJSON(file, session);
  if (!session.binaryUnchanged) throw new Error('바이너리 해시가 바뀌었습니다. 새 run을 시작하세요.');
  return result;
}
function profileSummary(files) {
  return {
    entryCount: Object.keys(files).length,
    directories: Object.entries(files).filter(([name, entry]) => name && !name.includes('/') && entry.type === 'directory').map(([name]) => name),
    sensitiveFiles: Object.entries(files).filter(([name, entry]) => entry.type === 'file' && /token|credential|secret|oauth/i.test(name)).map(([name, entry]) => ({ path: name, mode: entry.mode })),
  };
}

async function inspect(root, manifest) {
  await assertIdle(root);
  await assertPinned(manifest);
  const { env, removed } = childEnv(process.env, root);
  const common = { cwd: path.join(root, 'workspace'), env };
  const version = await runCaptured(root, manifest, 'a', [...profileArgs(root, 'a'), '--version'], common);
  const help = await runCaptured(root, manifest, 'a', [...profileArgs(root, 'a'), '--help'], common);
  const flags = {};
  // No --help here: help can accept an otherwise unknown flag.
  for (const flag of ['gemini_dir', 'app_data_dir']) {
    const other = profileArgs(root, 'a').filter(arg => !arg.startsWith(`--${flag}=`));
    const result = await runCaptured(root, manifest, 'a', [...other, `--${flag}`], common);
    flags[flag] = {
      code: result.code, timedOut: result.timedOut,
      missingValueRecognized: result.code !== 0 && !result.timedOut && new RegExp(`(?:needs an argument|requires (?:an? )?(?:argument|value)|missing.*(?:argument|value)).{0,100}${flag}|${flag}.{0,100}(?:needs an argument|requires (?:an? )?(?:argument|value)|missing.*(?:argument|value))`, 'is').test(result.output),
      unknownFlag: /unknown (?:flag|option)|flag provided but not defined/i.test(result.output),
    };
  }
  const bytes = await fs.readFile(manifest.binary);
  const report = {
    at: now(), version: version.output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null,
    versionExitCode: version.code, helpExitCode: help.code, flags,
    helpMentionsProfile: /--(?:profile|account|credential[-_]store)\b/i.test(help.output),
    staticMarkers: Object.fromEntries(['AGY_CLI_DISABLE_AUTO_UPDATE', 'Using file-based token storage because %s detected', 'SSH_TTY'].map(marker => [marker, bytes.includes(Buffer.from(marker))])),
    removedEnvironmentNames: removed,
  };
  await assertPinned(manifest);
  await writeJSON(evidencePath(root, `inspect-${Date.now()}.json`), report);
  manifest.version = report.version;
  await saveManifest(root, manifest);
  emit(report);
}
async function assertIdle(root, profile) {
  const sessions = await activeSessions(root);
  if (sessions.some(session => !profile || session.profile === profile)) throw new Error('관련 PoC 프로세스를 먼저 종료하세요.');
}

async function logObservations(profile) {
  let text = '';
  const logDir = path.join(profile, 'antigravity-cli', 'log');
  try {
    for (const name of (await fs.readdir(logDir)).filter(x => x.endsWith('.log'))) {
      const file = path.join(logDir, name);
      const stat = await fs.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 4 * 1024 * 1024) text += await fs.readFile(file, 'utf8');
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return observations(text);
}
async function probe(root, manifest, selected) {
  requirePrevious(manifest, 'P1');
  await assertIdle(root);
  await assertPinned(manifest);
  const profiles = selected ? [selected] : ['a', 'b'];
  for (const profile of profiles) {
    if ((await fs.readdir(profilePath(root, profile))).length) throw new Error('probe는 완전히 빈 프로필만 허용합니다. 새 run을 만들거나 아직 실행하지 않은 프로필을 선택하세요.');
  }
  for (const profile of profiles) {
    const before = await baseline();
    const startedAt = now();
    const { env } = childEnv(process.env, root);
    const result = await runCaptured(root, manifest, profile, [...profileArgs(root, profile), '-p', `Reply exactly AG_SWITCH_POC_${profile.toUpperCase()}. Do not use tools.`], { cwd: path.join(root, 'workspace'), env, timeoutMs: 20000 });
    const output = { ...observations(result.output), modelResponded: result.code === 0 && result.output.includes(`AG_SWITCH_POC_${profile.toUpperCase()}`) };
    // The exact marker is deliberately not used as identity evidence.
    const report = {
      startedAt, endedAt: now(), profile, code: result.code, signal: result.signal,
      timedOut: result.timedOut, overflow: result.overflow, output,
      logs: await logObservations(profilePath(root, profile)),
      baselineChanges: baselineChanges(before, await baseline()),
      files: await inventory(profilePath(root, profile)),
    };
    const evidence = evidencePath(root, `probe-${profile}-${Date.now()}.json`);
    await writeJSON(evidence, report);
    await assertPinned(manifest);
    emit({ ...report, files: profileSummary(report.files), evidence });
    if (output.authSucceeded || report.logs.authSucceeded || output.modelResponded || (report.baselineChanges.files.length || report.baselineChanges.keychain) || output.fallbackStorage || report.logs.fallbackStorage) {
      manifest.stages.P1 = { status: 'fail', at: now(), note: '빈 프로필에서 인증 성공·기존 설정 변경·우회 실패 중 하나 감지. evidence 참조.' };
      await saveManifest(root, manifest);
      throw new Error('P1 중단 조건을 감지했습니다. 근거를 확인하기 전 로그인하지 마세요.');
    }
  }
}

async function check(root, manifest) {
  await assertPinned(manifest);
  const original = await readJSON(evidencePath(root, 'baseline.json'));
  const current = await baseline();
  const profiles = {};
  for (const profile of ['a', 'b']) {
    const files = await inventory(profilePath(root, profile));
    profiles[profile] = {
      files,
      // Mode checks alone do not prove where OAuth tokens are persisted.
      insecureSensitiveFiles: Object.entries(files).filter(([name, entry]) => entry.type === 'file' && /token|credential|secret|oauth/i.test(name) && (parseInt(entry.mode, 8) & 0o077)).map(([name]) => name),
      observations: await logObservations(profilePath(root, profile)),
    };
  }
  const report = { at: now(), baselineChanges: baselineChanges(original, current), activeSessions: await activeSessions(root), profiles, stages: manifest.stages };
  await writeJSON(evidencePath(root, `check-${Date.now()}.json`), report);
  emit({ ...report, profiles: Object.fromEntries(Object.entries(profiles).map(([name, data]) => [name, { ...data, files: profileSummary(data.files) }])) });
}

async function launch(root, manifest, profile, releaseLock) {
  profilePath(root, profile);
  requirePrevious(manifest, 'P2');
  if (STAGES.some(stage => manifest.stages[stage].status === 'fail')) throw new Error('실패 단계가 있습니다. 원인을 해결하고 새 run을 시작하세요.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('launch는 사용자 터미널에서 실행하세요. 인증 값을 채팅에 전달하지 마세요.');
  await assertIdle(root, profile);
  await assertPinned(manifest);
  const { env } = childEnv(process.env, root);
  const sessionFile = path.join(root, 'sessions', `${randomUUID()}.json`);
  const child = spawn(manifest.binary, profileArgs(root, profile), { cwd: path.join(root, 'workspace'), env, stdio: 'inherit', detached: true });
  const session = { profile, pid: child.pid, startedAt: now(), identity: null };
  // Install listeners immediately, including on spawn failure.
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  completion.catch(() => {});
  const forward = signal => { if (!Number.isSafeInteger(child.pid)) return; try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  const onInt = () => forward('SIGINT');
  const onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    session.identity = await processIdentity(child.pid);
    await writeJSON(sessionFile, session);
    await releaseLock();
    const result = await completion;
    session.endedAt = now();
    session.result = result;
    await writeJSON(sessionFile, session);
    await assertPinned(manifest);
    process.exitCode = result.code ?? (result.signal ? 1 : 0);
  } catch (error) {
    forward('SIGTERM');
    const killTimer = setTimeout(() => forward('SIGKILL'), 2000);
    await completion.catch(() => {});
    clearTimeout(killTimer);
    throw error;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

async function record(root, manifest, options) {
  const { stage, status } = options;
  if (!STAGES.includes(stage) || !['pass', 'fail', 'unverified'].includes(status)) throw new Error('단계 P0~P7, 상태 pass|fail|unverified가 필요합니다.');
  const note = safeNote(options.note);
  if (status === 'pass') requirePrevious(manifest, stage);
  if (status === 'pass') await assertPinned(manifest);
  if (status === 'pass' && stage === 'P7') await assertIdle(root);
  manifest.stages[stage] = { status, note, at: now(), source: 'operator-observation' };
  // Earlier evidence changing invalidates all later decisions.
  for (const later of STAGES.slice(STAGES.indexOf(stage) + 1)) manifest.stages[later] = { status: 'unverified' };
  await saveManifest(root, manifest);
  emit({ stage, ...manifest.stages[stage] });
}
async function stop(root) {
  const sessions = await activeSessions(root);
  const stopped = [];
  for (const session of sessions) {
    if (await processIdentity(session.pid) !== session.identity) continue;
    try { process.kill(-session.pid, 'SIGTERM'); stopped.push({ profile: session.profile, pid: session.pid }); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  emit({ signaled: stopped, note: '이 run의 PID와 시작 식별자가 일치하는 프로세스 그룹에만 SIGTERM을 전달했습니다. check로 종료 여부를 확인하세요.' });
}
async function cleanup(root, manifest, discardRun, reviewName) {
  const discard = discardRun === path.basename(root);
  if (discardRun && !discard) throw new Error('--discard-run 값은 실행 루트의 디렉터리 이름과 정확히 같아야 합니다.');
  if (!discard) requirePrevious(manifest, 'P7');
  if (!discard && manifest.stages.P7.status !== 'pass') throw new Error('P7 전후 비교와 종료 확인을 통과로 기록한 뒤 정리하세요.');
  await assertIdle(root);
  const original = discard ? null : await readJSON(evidencePath(root, 'baseline.json'));
  let reviewed = false;
  const beforeCleanup = original ? await baseline() : null;
  if (reviewName) {
    if (!original || reviewName !== 'baseline-review.json') throw new Error('검토 파일은 evidence/baseline-review.json이어야 합니다.');
    const reviewFile = evidencePath(root, reviewName);
    const stat = await fs.lstat(reviewFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('안전하지 않은 기준 상태 검토 파일입니다.');
    validateBaselineReview(await readJSON(reviewFile), root, await sha256(evidencePath(root, 'baseline.json')), original, beforeCleanup);
    reviewed = true;
  } else if (original) {
    const drift = baselineChanges(original, beforeCleanup);
    if (drift.files.length || drift.keychain) throw new Error('원래 기준 상태와 차이가 있습니다. evidence에 원인 검토를 보존한 뒤 --baseline-review로 지정하세요.');
  }
  const output = { root, version: manifest.version, sha256: manifest.sha256, stages: manifest.stages, baselineReviewAccepted: reviewed };
  // Keep the reviewable summary in stdout before deleting the private runtime.
  emit({ cleanupSummary: output, discardedUnverifiedRun: discard });
  await fs.rm(root, { recursive: true });
  if (original) {
    const current = await baseline();
    const comparison = baselineChanges(original, current);
    const duringCleanup = baselineChanges(beforeCleanup, current);
    const matches = !comparison.files.length && !comparison.keychain;
    const duringUnchanged = !duringCleanup.files.length && !duringCleanup.keychain;
    emit({ cleaned: true, postCleanupMatchesBaseline: matches, postCleanupBaselineChanges: comparison, postCleanupMatchesReviewedBaseline: reviewed ? duringUnchanged : null, changesDuringCleanup: duringCleanup });
    if (!duringUnchanged || (!matches && !reviewed)) process.exitCode = 1;
  }
}

async function unlock(root) {
  const lock = path.join(root, 'operation.lock');
  let stat;
  try { stat = await fs.lstat(lock); } catch (e) { if (e.code === 'ENOENT') { emit({ unlocked: false }); return; } throw e; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('잘못된 작업 잠금입니다.');
  const owner = await readJSON(lock);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1) throw new Error('잠금 소유 프로세스를 확인할 수 없습니다.');
  if (await processIdentity(owner.pid)) throw new Error('잠금 소유 프로세스가 실행 중입니다. 종료 후 재시도하세요.');
  if ((await fs.lstat(lock)).ino !== stat.ino) throw new Error('작업 잠금이 변경되었습니다. 다시 확인하세요.');
  await fs.unlink(lock);
  emit({ unlocked: true });
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const { command, options } = parse(argv);
  if (command === 'help') { console.log(HELP); return; }
  if (command === 'init') { await init(options.binary); return; }
  const { root } = await loadRun(options.root);
  if (command === 'unlock') { await unlock(root); return; }
  // Serialize startup; launch releases this after its PID is registered so B can start.
  const lock = path.join(root, 'operation.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('동일 작업 잠금이 있습니다. 실행 중인 작업을 확인하세요.'); throw e; }
  let released = false;
  const releaseLock = async () => {
    if (released) return;
    await handle.close();
    await fs.rm(lock, { force: true });
    released = true;
  };
  try {
    const { manifest } = await loadRun(root);
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
    if (command === 'inspect') await inspect(root, manifest);
    else if (command === 'probe') await probe(root, manifest, options.profile);
    else if (command === 'launch') await launch(root, manifest, options.profile, releaseLock);
    else if (command === 'check') await check(root, manifest);
    else if (command === 'verify') { await assertIdle(root); emit(await (options.stage === 'P6' ? verifyLogout(root, manifest) : verifyProfiles(root, manifest, options.stage))); }
    else if (command === 'record') await record(root, manifest, options);
    else if (command === 'stop') await stop(root);
    else if (command === 'cleanup') await cleanup(root, manifest, options['discard-run'], options['baseline-review']);
  } finally {
    await releaseLock();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // No raw subprocess errors: those can include inherited secrets/arguments.
    console.error(`ag-switch-poc: ${error.code ? `파일/프로세스 오류 (${error.code})` : error.message}`);
    process.exitCode = 1;
  });
}
