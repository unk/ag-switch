import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const ROOT = path.join(os.homedir(), '.ag-switch');
export const MARKER = 'ag-switch-v1';
export function validateName(name) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name ?? '') || ['agy', 'ag-switch', 'node', 'npm', 'npx', 'store'].includes(name)) {
    throw new Error('이름은 영문 소문자로 시작하는 1~48자의 소문자·숫자·하이픈이어야 하며 기존 도구 이름은 사용할 수 없습니다.');
  }
  return name;
}
export async function statOrNull(file) {
  try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function assertPrivate(file, directory = false, mode = directory ? 0o700 : 0o600) {
  const s = await fs.lstat(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid() || (s.mode & 0o777) !== mode) {
    throw new Error(`경로의 종류·소유자·권한을 확인하세요 (${mode.toString(8)}): ${file}`);
  }
}
export async function privateDir(dir) {
  try { await fs.mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  await assertPrivate(dir, true);
}
export async function atomicWrite(file, text, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode, flag: 'wx' });
    // Preserve the requested mode even when the CLI's private umask is active.
    await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
export const writeJSON = (file, data) => atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
export async function readJSON(file) {
  await assertPrivate(file);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new Error(`JSON 파일 형식을 확인하세요: ${file}`); }
}
export async function openStore(root = ROOT, create = false) {
  if (!path.isAbsolute(root)) throw new Error('저장 루트에는 절대 경로가 필요합니다.');
  if (!await statOrNull(root)) {
    if (!create) return null;
    await privateDir(root);
    await writeJSON(path.join(root, 'store.json'), { marker: MARKER, uid: process.getuid() });
  }
  await assertPrivate(root, true);
  root = await fs.realpath(root);
  const marker = await readJSON(path.join(root, 'store.json'));
  if (marker.marker !== MARKER || marker.uid !== process.getuid()) throw new Error('ag-switch 저장소가 아닙니다.');
  for (const name of ['profiles', 'bin', 'locks']) await privateDir(path.join(root, name));
  return { root };
}
export async function loadRegistry(store) {
  const file = path.join(store.root, 'profiles.json');
  if (!await statOrNull(file)) return { schema: 1, profiles: [] };
  const data = await readJSON(file);
  if (data.schema !== 1 || !Array.isArray(data.profiles)) throw new Error('지원하지 않는 레지스트리 형식입니다.');
  const names = new Set();
  for (const p of data.profiles) {
    validateName(p.name);
    if (names.has(p.name) || !path.isAbsolute(p.binary ?? '') || !/^[a-f0-9]{64}$/.test(p.sha256 ?? '') || typeof p.createdAt !== 'string') throw new Error('프로필 메타데이터가 손상됐습니다.');
    names.add(p.name);
    const i = p.integration;
    if (i && (!['alias', 'script', 'both'].includes(i.mode) ||
        (['alias', 'both'].includes(i.mode) && (!['zsh', 'bash', 'fish'].includes(i.shell) || !path.isAbsolute(i.rcPath ?? '') || typeof i.block !== 'string' || !i.block.includes(`# >>> ag-switch: ${p.name} >>>`))) ||
        (['script', 'both'].includes(i.mode) && (!path.isAbsolute(i.scriptPath ?? '') || typeof i.script !== 'string' || !i.script.startsWith(`#!/bin/sh\n# ag-switch external launcher: ${p.name}\n`))))) throw new Error('셸 연동 메타데이터가 손상됐습니다.');
  }
  return data;
}
export const saveRegistry = (store, data) => writeJSON(path.join(store.root, 'profiles.json'), data);
export const profileDir = (store, name) => path.join(store.root, 'profiles', validateName(name));
export async function validateProfile(store, name) {
  const dir = profileDir(store, name);
  await assertPrivate(dir, true);
  const owner = await readJSON(path.join(dir, 'profile.json'));
  if (owner.marker !== MARKER || owner.name !== name || owner.uid !== process.getuid()) throw new Error('프로필 소유 정보를 확인할 수 없습니다.');
  for (const child of ['data', 'data/antigravity-cli', 'data/config', 'tmp', 'cache', 'xdg-config', 'xdg-data']) await assertPrivate(path.join(dir, child), true);
  const token = path.join(dir, 'data/antigravity-cli/antigravity-oauth-token');
  if (await statOrNull(token)) await assertPrivate(token);
  return dir;
}

async function sessionLocks(store, name) {
  return (await fs.readdir(path.join(store.root, 'locks')))
    .filter(file => file.startsWith(`${name}.`) && file !== `${name}.json` && file.endsWith('.json'))
    .map(file => path.join(store.root, 'locks', file));
}

// Runs share a profile through independent leases. Mutations use the legacy
// exclusive path, so an older running launcher also prevents unsafe access.
export async function lock(store, name, { shared = false, waitMs = 0 } = {}) {
  if (name !== 'store') validateName(name);
  if (shared && name === 'store') throw new Error('저장소 잠금은 공유할 수 없습니다.');
  const id = randomUUID();
  const exclusive = path.join(store.root, 'locks', `${name}.json`);
  const file = shared ? path.join(store.root, 'locks', `${name}.${id}.json`) : exclusive;
  const busy = () => new Error(`다른 작업 또는 실행 중인 프로필이 잠금을 사용합니다: ${name}. 설정 변경·제거는 모든 실행을 종료한 뒤 시도하세요. 비정상 종료 후에는 unlock 명령을 사용하세요.`);
  const deadline = performance.now() + waitMs;
  if (shared && await statOrNull(exclusive)) throw busy();
  for (;;) {
    try {
      await fs.writeFile(file, `${JSON.stringify({ pid: process.pid, id })}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const remaining = deadline - performance.now();
      if (shared || remaining <= 0) throw busy();
      await delay(Math.min(20, remaining));
    }
  }
  try {
    // Check after creation too: a concurrent exclusive/shared acquisition must
    // not let both holders proceed, even outside the store mutation lock.
    if (shared ? await statOrNull(exclusive) : name !== 'store' && (await sessionLocks(store, name)).length) throw busy();
  } catch (e) {
    await fs.unlink(file);
    throw e;
  }
  const release = async () => {
    const owner = await readJSON(file);
    if (owner.id !== id) throw new Error('잠금 소유 정보가 변경됐습니다.');
    await fs.unlink(file);
  };
  release.registerChild = async childPid => {
    await writeJSON(file, { pid: process.pid, id, childPid });
  };
  return release;
}
export async function withLock(store, action) {
  // Startup and registry edits are brief; simultaneous launches should wait
  // for them rather than fail with a spurious profile lock error.
  const release = await lock(store, 'store', { waitMs: 5000 });
  try { return await action(); } finally { await release(); }
}
export async function unlock(store, name) {
  if (name !== 'store') validateName(name);
  const recover = async () => {
    const exclusive = path.join(store.root, 'locks', `${name}.json`);
    const files = [exclusive, ...(name === 'store' ? [] : await sessionLocks(store, name))];
    const abandoned = [];
    for (const file of files) {
      const stat = await statOrNull(file);
      if (!stat) continue;
      let owner;
      try { owner = await readJSON(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || typeof owner.id !== 'string') throw new Error('잠금 형식이 손상됐습니다. 자동 해제할 수 없습니다.');
      for (const pid of [owner.pid, owner.childPid].filter(value => value !== undefined)) {
        if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('잠금 프로세스 정보가 손상됐습니다.');
        try { process.kill(pid, 0); }
        catch (e) {
          if (e.code === 'ESRCH') continue;
          throw new Error('잠금 소유 프로세스를 조회할 수 없습니다.');
        }
        throw new Error('잠금 소유 프로세스가 실행 중입니다. 모든 실행을 종료한 뒤 다시 시도하세요.');
      }
      abandoned.push({ file, stat });
    }
    for (const { file, stat } of abandoned) {
      const current = await statOrNull(file);
      if (!current) continue;
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('잠금 소유 정보가 변경됐습니다.');
      await fs.unlink(file);
    }
  };
  // Serialize recovery with new launches and profile removal. The store lock
  // itself must be recoverable without acquiring it first.
  return name === 'store' ? recover() : withLock(store, recover);
}
