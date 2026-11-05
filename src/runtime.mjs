import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const capture = promisify(execFile);

export const VERIFIED = Object.freeze({
  platform: 'darwin', arch: 'arm64', version: '1.4.7',
  sha256: 'b7a13e53c9f49921692676ef8edc2e60ceb67064c00bc732d9a364ec3ad75b32',
});
export const VERIFIED_BINARIES = Object.freeze([
  Object.freeze({ ...VERIFIED, validation: 'oauth-lifecycle', evidence: 'poc/evidence/ag-switch-poc-O92xjF.json' }),
  Object.freeze({
    ...VERIFIED, version: '1.5.1',
    sha256: '5ce7fbe126eb9abdc78634332a0a1bdd428327fba37ef7d1aeba7553eec55f3f',
    validation: 'upgrade-compatibility', evidence: 'validation/evidence/agy-1.5.1-darwin-arm64.json',
  }),
]);
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function resolveBinary(input, env = process.env) {
  const candidates = input ? [path.resolve(input)] : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, 'agy'));
  for (const file of candidates) {
    try {
      const real = await fs.realpath(file);
      if (!(await fs.stat(real)).isFile()) continue;
      await fs.access(real, fs.constants.X_OK);
      return real;
    } catch (e) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(e.code)) throw e; }
  }
  throw new Error('agy 실행 파일을 찾을 수 없습니다. PATH 또는 --binary 경로를 확인하세요.');
}
export async function inspectBinary(binary) {
  if (process.platform !== VERIFIED.platform || process.arch !== VERIFIED.arch) throw new Error('현재 지원 환경은 macOS arm64입니다.');
  const digest = await sha256(binary);
  await fs.access(binary, fs.constants.X_OK);
  const known = VERIFIED_BINARIES.find(info => info.sha256 === digest && info.platform === process.platform && info.arch === process.arch);
  if (known) return { binary, sha256: digest, version: known.version, verified: true, validation: known.validation };
  let version = 'unknown';
  try {
    const { stdout } = await capture(binary, ['--version'], {
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, timeout: 3000, maxBuffer: 4096,
    });
    version = stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? version;
  } catch { /* Version detection is informational and must not block execution. */ }
  return { binary, sha256: digest, version, warnings: [`agy ${version === 'unknown' ? '(버전 미확인)' : version}의 프로필 격리 호환성은 아직 검증하지 않았습니다.`] };
}
export function binaryWarnings(info, previous) {
  const warnings = [...(info.warnings ?? [])];
  if (previous && info.sha256 !== previous.sha256 && !info.verified) warnings.push('agy 바이너리가 등록 이후 변경됐습니다.');
  return warnings;
}
export function reportBinaryWarnings(info, previous, warn = message => console.error(`ag-switch: 안내: ${message}`)) {
  const warnings = binaryWarnings(info, previous);
  if (warnings.length) warn(`${warnings.join(' ')} 실행을 계속합니다.`);
}
export function childEnv(source, dir) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(AGY_|ANTIGRAVITY_|GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|JETSKI_|CLOUD_CODE_|SSH_)/.test(key) || /^(API_KEY|ACCESS_TOKEN|OAUTH_TOKEN)$/.test(key)) delete env[key];
  }
  return Object.assign(env, {
    SSH_TTY: '/dev/ag-switch', AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    TMPDIR: path.join(dir, 'tmp'), XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_CONFIG_HOME: path.join(dir, 'xdg-config'), XDG_DATA_HOME: path.join(dir, 'xdg-data'),
  });
}
export function launchArgs(dir, args) {
  // Flag normalization in agy may treat hyphens and underscores alike.
  for (const arg of args) {
    const flag = arg.split('=')[0].replaceAll('-', '').replaceAll('_', '').toLowerCase();
    if (/^\-/.test(arg) && ['geminidir', 'appdatadir'].includes(flag)) throw new Error('프로필 경로 옵션은 전달할 수 없습니다.');
  }
  return [`--gemini_dir=${path.join(dir, 'data')}`, '--app_data_dir=antigravity-cli', ...args];
}
export async function runChild(binary, args, env, onSpawn = async () => {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: 'inherit' });
    let registration = Promise.resolve();
    child.once('spawn', () => {
      registration = Promise.resolve().then(() => onSpawn(child.pid));
      registration.catch(() => child.kill('SIGTERM'));
    });
    // SIGINT already reaches both processes through the terminal's process group.
    // Keep the parent alive so its lease remains held until agy has exited.
    const interrupt = () => {};
    const terminate = () => child.kill('SIGTERM');
    const hangup = () => child.kill('SIGHUP');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    process.on('SIGHUP', hangup);
    const dispose = () => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.off('SIGHUP', hangup);
    };
    child.once('error', error => { dispose(); reject(error); });
    child.once('exit', async (code, signal) => {
      dispose();
      try { await registration; resolve(code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1)); }
      catch (e) { reject(e); }
    });
  });
}
