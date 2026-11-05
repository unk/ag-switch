import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { installRuntime } from './install.mjs';
import {
  MARKER, validateName, privateDir, writeJSON, loadRegistry, saveRegistry,
  profileDir, validateProfile, statOrNull, assertPrivate, withLock, lock, readJSON,
} from './storage.mjs';
import { inspectBinary, binaryWarnings, reportBinaryWarnings, childEnv, launchArgs, runChild } from './runtime.mjs';
import { shellQuote, planIntegration, applyEdits, checkIntegration, integrationOptions } from './shells.mjs';
export { shellQuote } from './shells.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
export function launcherText(store, name, runtime = { node: process.execPath, cli }) {
  return `#!/bin/sh\n# ag-switch launcher: ${name}\nexec ${shellQuote(runtime.node)} ${shellQuote(runtime.cli)} run ${shellQuote(name)} --root ${shellQuote(store.root)} -- "$@"\n`;
}
function matchesLauncher(text, store, name, entry) {
  if (entry?.launcher) return text === launcherText(store, name, entry.launcher);
  // Older launchers have no recorded runtime. Accept only the exact generated
  // shell grammar, including this profile and root, when migrating installations.
  const prefix = `#!/bin/sh\n# ag-switch launcher: ${name}\nexec `;
  const suffix = ` run ${shellQuote(name)} --root ${shellQuote(store.root)} -- "$@"\n`;
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return false;
  const command = text.slice(prefix.length, -suffix.length);
  const match = command.match(/^('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*')$/);
  if (!match) return false;
  const [node, source] = match.slice(1).map(value => value.slice(1, -1).replaceAll("'\\''", "'"));
  return path.isAbsolute(node) && path.basename(node) === 'node' && path.isAbsolute(source) && source.endsWith('/src/cli.mjs');
}
async function wrapperEdit(store, name, entry, text) {
  const file = path.join(store.root, 'bin', name);
  let before = { text: null, mode: 0o600 };
  if (await statOrNull(file)) {
    await assertPrivate(file, false, 0o700);
    before = { text: await fs.readFile(file, 'utf8'), mode: 0o700 };
    if (!entry || !matchesLauncher(before.text, store, name, entry)) throw new Error('변경된 런처는 자동 덮어쓰기·제거하지 않습니다.');
  }
  return { file, before, text, mode: 0o700 };
}
export async function profileState(store, name, profiles) {
  validateName(name);
  const entry = profiles.find(p => p.name === name);
  if (entry || !await statOrNull(profileDir(store, name))) return entry;
  await validateProfile(store, name);
  const owner = await readJSON(path.join(profileDir(store, name), 'profile.json'));
  return { name, binary: owner.settings?.binary, integration: owner.settings?.integration, retained: true };
}
async function initializeProfile(dir, name, settings) {
  await privateDir(dir);
  await writeJSON(path.join(dir, 'profile.json'), { marker: MARKER, name, uid: process.getuid(), settings });
  for (const child of ['data', 'data/antigravity-cli', 'data/config', 'tmp', 'cache', 'xdg-config', 'xdg-data']) await privateDir(path.join(dir, child));
}
export async function createProfile(store, name, binary, options = {}) {
  return saveProfile(store, name, binary, options);
}
export async function setupProfile(store, name, integration, options = {}) {
  return saveProfile(store, name, undefined, { ...options, integration, requireExisting: true });
}
async function saveProfile(store, name, binary, { reuse = false, recreate = false, inspect = inspectBinary, warn, integration, env = process.env, requireExisting = false } = {}) {
  validateName(name);
  if (reuse && recreate) throw new Error('--reuse와 --recreate는 함께 사용할 수 없습니다.');
  return withLock(store, async () => {
    const registry = await loadRegistry(store);
    const previous = registry.profiles.find(p => p.name === name);
    if (requireExisting && !previous) throw new Error('등록되지 않은 프로필입니다.');
    const state = await profileState(store, name, registry.profiles);
    if (state?.retained && !reuse && !recreate) throw new Error('보존된 프로필 데이터가 있습니다. 대화형 create 또는 --reuse / --recreate를 사용하세요.');
    const checked = await inspect(binary ?? state?.binary);
    reportBinaryWarnings(checked, previous, warn);
    const plan = await planIntegration(store, name, previous?.integration, integration ?? integrationOptions(state?.integration), { env });
    const wrapper = await wrapperEdit(store, name, previous, launcherText(store, name));
    const release = await lock(store, name);
    let archive, receipt;
    const dir = profileDir(store, name);
    try {
      if (state) await validateProfile(store, name);
      const runtime = { node: process.execPath, cli: await installRuntime(store) };
      wrapper.text = launcherText(store, name, runtime);
      if (recreate && state) {
        const backups = path.join(store.root, 'backups');
        await privateDir(backups);
        archive = path.join(backups, `${name}.${Date.now()}.${randomUUID()}`);
        await fs.rename(dir, archive);
      }
      const settings = { binary: checked.binary, ...(plan.integration ? { integration: plan.integration } : {}) };
      if (!state || archive) await initializeProfile(dir, name, settings);
      const marker = path.join(dir, 'profile.json');
      const before = await fs.readFile(marker, 'utf8');
      const owner = { marker: MARKER, name, uid: process.getuid(), settings };
      const edits = [wrapper, ...plan.edits, { file: marker, before: { text: before, mode: 0o600 }, text: `${JSON.stringify(owner, null, 2)}\n`, mode: 0o600 }].filter(edit => edit.text !== edit.before.text || edit.mode !== edit.before.mode);
      receipt = await applyEdits(edits);
      const entry = { name, ...checked, createdAt: !recreate && previous ? previous.createdAt : new Date().toISOString(), launcher: runtime };
      if (plan.integration) entry.integration = plan.integration;
      if (previous) registry.profiles[registry.profiles.indexOf(previous)] = entry;
      else registry.profiles.push(entry);
      await saveRegistry(store, registry);
      return { ...entry, backups: [...(archive ? [archive] : []), ...receipt.backups], updated: Boolean(previous), recreated: Boolean(archive) };
    } catch (error) {
      await receipt?.rollback();
      if (archive) {
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(archive, dir);
      }
      throw error;
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
        if (!matchesLauncher(await fs.readFile(wrapper, 'utf8'), store, name, entry)) throw new Error('변경된 런처는 자동 제거하지 않습니다.');
      }
      // Unregister first: an interrupted removal can never leave a runnable record
      // pointing at a partly deleted credential directory.
      const plan = await planIntegration(store, name, entry.integration, { mode: 'internal' });
      const marker = path.join(dir, 'profile.json');
      const owner = await readJSON(marker);
      owner.settings = { binary: entry.binary, ...(entry.integration ? { integration: entry.integration } : {}) };
      await writeJSON(marker, owner);
      const receipt = await applyEdits(plan.edits);
      registry.profiles = registry.profiles.filter(p => p.name !== name);
      try { await saveRegistry(store, registry); } catch (error) { await receipt.rollback(); throw error; }
      await fs.rm(wrapper, { force: true });
      if (purge) await fs.rm(dir, { recursive: true });
      return { backups: receipt.backups };
    } finally { await release(); }
  });
}
export async function runProfile(store, name, args, { inspect = inspectBinary, execute = runChild, warn, env = process.env } = {}) {
  validateName(name);
  let release;
  try {
    const context = await withLock(store, async () => {
      const entry = (await loadRegistry(store)).profiles.find(p => p.name === name);
      if (!entry) throw new Error('등록되지 않은 프로필입니다.');
      const dir = await validateProfile(store, name);
      const forwarded = launchArgs(dir, args);
      release = await lock(store, name, { shared: true });
      return { entry, dir, forwarded };
    });
    const checked = await inspect(context.entry.binary);
    reportBinaryWarnings(checked, context.entry, warn);
    const code = await execute(context.entry.binary, context.forwarded, childEnv(env, context.dir), release.registerChild);
    const after = await inspect(context.entry.binary);
    if (after.sha256 !== checked.sha256) reportBinaryWarnings(after, checked, warn);
    await validateProfile(store, name);
    return code;
  } finally { await release?.(); }
}
export async function doctor(store, { inspect = inspectBinary } = {}) {
  const results = [];
  for (const entry of (await loadRegistry(store)).profiles) {
    try {
      const dir = await validateProfile(store, entry.name);
      const checked = await inspect(entry.binary);
      const warnings = binaryWarnings(checked, entry);
      const wrapper = path.join(store.root, 'bin', entry.name);
      await assertPrivate(wrapper, false, 0o700);
      if (!matchesLauncher(await fs.readFile(wrapper, 'utf8'), store, entry.name, entry)) throw new Error('런처 내용 불일치');
      if (entry.launcher) await fs.access(entry.launcher.cli);
      await checkIntegration(entry.integration);
      const token = await statOrNull(path.join(dir, 'data/antigravity-cli/antigravity-oauth-token'));
      results.push({ name: entry.name, ok: true, credentialFile: Boolean(token), ...(warnings.length ? { warnings } : {}), ...(entry.integration ? { launcher: entry.integration.mode, shell: entry.integration.shell ?? null } : {}) });
    } catch (e) { results.push({ name: entry.name, ok: false, error: e.message }); }
  }
  return results;
}
