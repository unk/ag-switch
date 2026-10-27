import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const VERIFIED = Object.freeze({
  platform: 'darwin', arch: 'arm64', version: '1.4.7',
  sha256: 'b7a13e53c9f49921692676ef8edc2e60ceb67064c00bc732d9a364ec3ad75b32',
});
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
  if (digest !== VERIFIED.sha256) throw new Error('PoC에서 검증하지 않은 agy 바이너리입니다. 해당 버전의 격리 검증 후 지원 정보를 갱신해야 합니다.');
  return { binary, sha256: digest, version: VERIFIED.version };
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
