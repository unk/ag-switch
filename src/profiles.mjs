import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKER, validateName, privateDir, atomicWrite, writeJSON, loadRegistry, saveRegistry,
  profileDir, validateProfile, statOrNull, assertPrivate, withLock, lock,
} from './storage.mjs';
import { inspectBinary, childEnv, launchArgs, runChild } from './runtime.mjs';
import { shellQuote, planIntegration, applyEdits, checkIntegration } from './shells.mjs';
export { shellQuote } from './shells.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
export function launcherText(store, name) {
  return `#!/bin/sh\n# ag-switch launcher: ${name}\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} run ${shellQuote(name)} --root ${shellQuote(store.root)} -- "$@"\n`;
}
export async function createProfile(store, name, binary, { reuse = false, inspect = inspectBinary, integration, env = process.env } = {}) {
  validateName(name);
  const checked = await inspect(binary);
  return withLock(store, async () => {
    const registry = await loadRegistry(store);
    if (registry.profiles.some(p => p.name === name)) throw new Error('이미 등록된 프로필입니다.');
    const plan = integration ? await planIntegration(store, name, null, integration, { env }) : null;
    const dir = profileDir(store, name);
    const wrapper = path.join(store.root, 'bin', name);
    if (await statOrNull(wrapper)) throw new Error('같은 이름의 런처 파일이 있습니다. 덮어쓰지 않습니다.');
    const existing = await statOrNull(dir);
    if (existing && !reuse) throw new Error('보존된 프로필 데이터가 있습니다. --reuse로 다시 등록할 수 있습니다.');
    if (existing) await validateProfile(store, name);
    else {
      await privateDir(dir);
      await writeJSON(path.join(dir, 'profile.json'), { marker: MARKER, name, uid: process.getuid() });
      for (const child of ['data', 'data/antigravity-cli', 'data/config', 'tmp', 'cache', 'xdg-config', 'xdg-data']) await privateDir(path.join(dir, child));
    }
    const entry = { name, ...checked, createdAt: new Date().toISOString() };
    if (plan?.integration) entry.integration = plan.integration;
    let receipt;
    try {
      await atomicWrite(wrapper, launcherText(store, name), 0o700);
      if (plan) receipt = await applyEdits(plan.edits);
      registry.profiles.push(entry);
      await saveRegistry(store, registry);
    } catch (error) {
      await receipt?.rollback();
      await fs.rm(wrapper, { force: true });
      // Authentication and user data are always retained, even after a failed write.
      throw error;
    }
    return { ...entry, backups: receipt?.backups ?? [] };
  });
}
export async function setupProfile(store, name, integration, { inspect = inspectBinary, env = process.env } = {}) {
  validateName(name);
  return withLock(store, async () => {
    const registry = await loadRegistry(store);
    const entry = registry.profiles.find(p => p.name === name);
    if (!entry) throw new Error('등록되지 않은 프로필입니다.');
    await validateProfile(store, name);
    const wrapper = path.join(store.root, 'bin', name);
    await assertPrivate(wrapper, false, 0o700);
    if (await fs.readFile(wrapper, 'utf8') !== launcherText(store, name)) throw new Error('변경된 내부 런처는 셸에 연결하지 않습니다.');
    const checked = await inspect(entry.binary);
    if (checked.sha256 !== entry.sha256) throw new Error('등록된 바이너리가 변경됐습니다.');
    const release = await lock(store, name);
    try {
      const plan = await planIntegration(store, name, entry.integration, integration, { env });
      const receipt = await applyEdits(plan.edits);
      if (plan.integration) entry.integration = plan.integration; else delete entry.integration;
      try { await saveRegistry(store, registry); } catch (error) { await receipt.rollback(); throw error; }
      return { ...entry, backups: receipt.backups };
    } finally { await release(); }
  });
}
export async function removeProfile(store, name, { purge = false } = {}) {
  validateName(name);
  return withLock(store, async () => {
    const registry = await loadRegistry(store);
    const entry = registry.profiles.find(p => p.name === name);
    if (!entry) throw new Error('등록되지 않은 프로필입니다.');
    const release = await lock(store, name);
    try {
      const dir = await validateProfile(store, name);
      const wrapper = path.join(store.root, 'bin', name);
      if (await statOrNull(wrapper)) {
        await assertPrivate(wrapper, false, 0o700);
        if (await fs.readFile(wrapper, 'utf8') !== launcherText(store, name)) throw new Error('변경된 런처는 자동 제거하지 않습니다.');
      }
      // Unregister first: an interrupted removal can never leave a runnable record
      // pointing at a partly deleted credential directory.
      const plan = await planIntegration(store, name, entry.integration, { mode: 'internal' });
      const receipt = await applyEdits(plan.edits);
      registry.profiles = registry.profiles.filter(p => p.name !== name);
      try { await saveRegistry(store, registry); } catch (error) { await receipt.rollback(); throw error; }
      await fs.rm(wrapper, { force: true });
      if (purge) await fs.rm(dir, { recursive: true });
      return { backups: receipt.backups };
    } finally { await release(); }
  });
}
export async function runProfile(store, name, args, { inspect = inspectBinary, execute = runChild, env = process.env } = {}) {
  validateName(name);
  let release;
  const context = await withLock(store, async () => {
    const entry = (await loadRegistry(store)).profiles.find(p => p.name === name);
    if (!entry) throw new Error('등록되지 않은 프로필입니다.');
    const dir = await validateProfile(store, name);
    const forwarded = launchArgs(dir, args);
    release = await lock(store, name);
    return { entry, dir, forwarded };
  });
  try {
    const checked = await inspect(context.entry.binary);
    if (checked.sha256 !== context.entry.sha256) throw new Error('프로필 생성 이후 바이너리가 변경됐습니다.');
    const code = await execute(context.entry.binary, context.forwarded, childEnv(env, context.dir), release.registerChild);
    const after = await inspect(context.entry.binary);
    if (after.sha256 !== context.entry.sha256) throw new Error('실행 중 바이너리가 변경됐습니다.');
    await validateProfile(store, name);
    return code;
  } finally { await release(); }
}
export async function doctor(store, { inspect = inspectBinary } = {}) {
  const results = [];
  for (const entry of (await loadRegistry(store)).profiles) {
    try {
      const dir = await validateProfile(store, entry.name);
      const checked = await inspect(entry.binary);
      if (checked.sha256 !== entry.sha256) throw new Error('등록된 바이너리 해시 불일치');
      const wrapper = path.join(store.root, 'bin', entry.name);
      await assertPrivate(wrapper, false, 0o700);
      if (await fs.readFile(wrapper, 'utf8') !== launcherText(store, entry.name)) throw new Error('런처 내용 불일치');
      await checkIntegration(entry.integration);
      const token = await statOrNull(path.join(dir, 'data/antigravity-cli/antigravity-oauth-token'));
      results.push({ name: entry.name, ok: true, credentialFile: Boolean(token), ...(entry.integration ? { launcher: entry.integration.mode, shell: entry.integration.shell ?? null } : {}) });
    } catch (e) { results.push({ name: entry.name, ok: false, error: e.message }); }
  }
  return results;
}
