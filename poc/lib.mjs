import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const STAGES = Array.from({ length: 8 }, (_, i) => `P${i}`);
export const APP_DIR = 'antigravity-cli';
export const MARKER = 'ag-switch-poc-v1';
export const now = () => new Date().toISOString();
export function profilePath(root, profile) {
  if (!['a', 'b'].includes(profile)) throw new Error('프로필은 a 또는 b여야 합니다.');
  return path.join(root, 'profiles', profile);
}
export function profileArgs(root, profile) {
  return [`--gemini_dir=${profilePath(root, profile)}`, `--app_data_dir=${APP_DIR}`];
}

// Keep HOME and the shell intact. Remove inherited auth, routing and SSH hints.
export function childEnv(source = process.env, root) {
  const env = { ...source };
  const removed = [];
  for (const key of Object.keys(env)) {
    if (/^(AGY_|ANTIGRAVITY_|GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|JETSKI_|CLOUD_CODE_|SSH_)/.test(key) ||
        /^(API_KEY|ACCESS_TOKEN|OAUTH_TOKEN)$/.test(key)) {
      removed.push(key);
      delete env[key];
    }
  }
  env.SSH_TTY = '/dev/ag-switch-poc';
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  // Crash reports, temporary files and XDG caches also belong to this run.
  env.TMPDIR = path.join(root, 'tmp');
  env.XDG_CACHE_HOME = path.join(root, 'cache');
  env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
  env.XDG_DATA_HOME = path.join(root, 'xdg-data');
  return { env, removed: removed.sort() };
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function writeJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}
export async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function assertPrivateDirectory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('실행 루트는 현재 사용자 소유의 실제 디렉터리이며 권한이 0700이어야 합니다.');
  }
}
export async function loadRun(input) {
  if (!input || !path.isAbsolute(input)) throw new Error('--root에 절대 경로가 필요합니다.');
  if ((await fs.lstat(input)).isSymbolicLink()) throw new Error('실행 루트의 심볼릭 링크는 허용하지 않습니다.');
  const root = await fs.realpath(input);
  const temp = await fs.realpath('/private/tmp');
  if (path.dirname(root) !== temp || !path.basename(root).startsWith('ag-switch-poc-')) {
    throw new Error('전용 /private/tmp/ag-switch-poc-* 루트만 사용할 수 있습니다.');
  }
  await assertPrivateDirectory(root);
  const manifestPath = path.join(root, 'run.json');
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('안전하지 않은 실행 매니페스트입니다.');
  }
  const manifest = await readJSON(manifestPath);
  if (manifest.marker !== MARKER || manifest.root !== root || manifest.uid !== process.getuid()) {
    throw new Error('이 도구가 만든 실행 루트가 아닙니다.');
  }
  for (const relative of ['profiles', 'profiles/a', 'profiles/b', 'workspace', 'evidence', 'sessions', 'tmp', 'cache', 'xdg-config', 'xdg-data']) {
    await assertPrivateDirectory(path.join(root, relative));
  }
  return { root, manifest };
}
export async function assertPinned(manifest) {
  if (await sha256(manifest.binary) !== manifest.sha256) throw new Error('바이너리 해시가 바뀌었습니다. 새 run을 시작하세요.');
}

// Bound raw CLI output in memory. Persist only explicit observations, never transcripts.
export async function capture(binary, args, options = {}) {
  const { timeoutMs = 15000, onSpawn, ...spawnOptions } = options;
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { ...spawnOptions, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, overflow = false;
    let registration = Promise.resolve();
    child.once('spawn', () => {
      registration = Promise.resolve().then(() => onSpawn?.(child.pid));
      registration.catch(() => terminate('SIGTERM'));
    });
    const terminate = (signal) => { if (!Number.isSafeInteger(child.pid)) return; try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const onInt = () => terminate('SIGINT');
    const onTerm = () => terminate('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const dispose = () => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); };
    const timer = setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, timeoutMs);
    const hardTimer = setTimeout(() => terminate('SIGKILL'), timeoutMs + 2000);
    const collect = (chunk) => {
      if (output.length < 1024 * 1024) output += chunk.toString('utf8');
      else { overflow = true; terminate('SIGTERM'); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', e => { clearTimeout(timer); clearTimeout(hardTimer); dispose(); reject(e); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer); clearTimeout(hardTimer); dispose();
      try { await registration; resolve({ code, signal, timedOut, overflow, output }); }
      catch (error) { reject(error); }
    });
  });
}
export function observations(text) {
  return {
    sshFileStorage: /Using file-based token storage because SSH(?:_TTY| session| environment)? detected/i.test(text),
    fallbackStorage: /file-based token storage because (?:a keyring timeout|.*(?:unavailable|failed))/i.test(text),
    loginRequired: /not (?:logged|signed) in|not authenticated|authentication required|please (?:log|sign) in|sign in to|login required|no (?:stored |saved )?(?:token|credentials)|run.*interactively.*(?:auth|sign)/i.test(text),
    loginScreen: /Sign in with Google|Continue with Google|Welcome to Antigravity|Select.*(?:account|authentication)/i.test(text),
    authSucceeded: /Successfully authenticated|Authenticated as|Logged in as|Signed in as/i.test(text),
  };
}

// Snapshot the configured paths, never symlink targets. Hashes stay outside the repo.
export async function inventory(base, depth = Infinity) {
  const result = {};
  async function visit(file, relative, level) {
    let stat;
    try { stat = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    const entry = { type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', mode: (stat.mode & 0o777).toString(8), size: stat.size, mtimeMs: stat.mtimeMs };
    // Directory mtime/size changes can be unrelated; children carry the evidence.
    if (stat.isDirectory()) { delete entry.size; delete entry.mtimeMs; }
    if (stat.isFile()) entry.sha256 = await sha256(file);
    result[relative] = entry;
    if (stat.isDirectory() && level < depth) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), relative ? `${relative}/${name}` : name, level + 1);
    }
  }
  await visit(base, '', 0);
  return result;
}
export function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
export async function baseline(home = os.homedir()) {
  const targets = [
    '.gemini/config/config.json', '.gemini/config/hooks.json', '.gemini/config/mcp_config.json',
    '.gemini/antigravity-cli/settings.json', '.gemini/antigravity-cli/installation_id',
    '.gemini/antigravity-cli/jetski_state.pbtxt', '.gemini/oauth_creds.json',
    '.gemini/credentials.json', '.gemini/antigravity-cli/credentials.json',
    '.gemini/antigravity-cli-oauth-token', '.gemini/cache/antigravity-cli-keyring-unavailable',
  ];
  const files = {};
  for (const target of targets) {
    const entries = await inventory(path.join(home, target), 0);
    files[target] = entries[''] ?? null;
  }
  return { at: now(), files, keychain: await keychainMetadata() };
}
export function requirePrevious(manifest, stage) {
  const index = STAGES.indexOf(stage);
  if (index < 0) throw new Error('단계는 P0~P7입니다.');
  for (const previous of STAGES.slice(0, index)) {
    if (manifest.stages[previous].status !== 'pass') throw new Error(`${previous} 통과 근거를 먼저 기록해야 합니다.`);
  }
}
export function safeNote(note) {
  if (!note?.trim() || note.length > 2000 || /https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:access_token|refresh_token|id_token|authorization|client_secret|password)\s*[=:]|ya29\.|1\/\/[A-Za-z0-9_-]+/i.test(note)) {
    throw new Error('근거는 1~2000자의 비밀값 없는 설명으로 입력하세요. URL·이메일·토큰은 기록하지 않습니다.');
  }
  return note.trim();
}

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const result = await capture('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'pgid=', '-o', 'comm='], { timeoutMs: 2000 });
  if (result.code === 0 && result.output.trim()) return result.output.trim();
  if (result.code === 1 && !result.output.trim() && !result.timedOut) return null;
  throw new Error('프로세스 식별자를 조회할 수 없습니다. 종료·정리를 중단합니다.');
}
export async function activeSessions(root) {
  const result = [];
  for (const name of (await fs.readdir(path.join(root, 'sessions'))).filter(x => x.endsWith('.json'))) {
    const session = await readJSON(path.join(root, 'sessions', name));
    if (!session.endedAt && session.identity && await processIdentity(session.pid) === session.identity) result.push(session);
  }
  return result;
}

// security without -g/-w returns attributes only; do not persist account labels.
export async function keychainMetadata() {
  if (process.platform !== 'darwin') return { status: 'unavailable', reason: 'platform' };
  const result = await capture('/usr/bin/security', ['find-generic-password', '-s', 'gemini'], { timeoutMs: 5000 });
  if (result.timedOut) return { status: 'unavailable', reason: 'timeout' };
  if (result.code === 0) return { status: 'found', service: 'gemini', metadataDigest: createHash('sha256').update(result.output).digest('hex') };
  if (result.code === 44 && /could not be found/i.test(result.output)) return { status: 'absent', service: 'gemini' };
  return { status: 'unavailable', service: 'gemini', exitCode: result.code };
}
export function baselineChanges(before, after) {
  return { files: changes(before.files, after.files), keychain: JSON.stringify(before.keychain) !== JSON.stringify(after.keychain) };
}

export function validateBaselineReview(review, root, originalDigest, original, current) {
  if (review?.marker !== 'ag-switch-baseline-review-v1' || review.root !== root || review.originalBaselineSha256 !== originalDigest || !review.checkpoint?.files || !review.checkpoint?.keychain) {
    throw new Error('기준 상태 검토 기록의 출처를 확인할 수 없습니다.');
  }
  safeNote(review.note);
  const actual = baselineChanges(original, current);
  if (JSON.stringify(actual) !== JSON.stringify(review.acceptedChanges)) throw new Error('검토한 차이와 현재 차이가 다릅니다. 정리를 중단합니다.');
  const sinceReview = baselineChanges(review.checkpoint, current);
  if (sinceReview.files.length || sinceReview.keychain) throw new Error('기준 상태 검토 이후 추가 변경이 있습니다. 정리를 중단합니다.');
}
