import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { privateDir, assertPrivate, statOrNull, atomicWrite } from './storage.mjs';

// Launchers must outlive an npx cache or a moved source checkout. Keep each
// runtime immutable so updating one profile cannot change another running CLI.
export async function installRuntime(store) {
  const source = fileURLToPath(new URL('.', import.meta.url));
  const files = new Map([['package.json', await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')]]);
  for (const name of (await fs.readdir(source)).filter(name => name.endsWith('.mjs')).sort()) {
    files.set(`src/${name}`, await fs.readFile(path.join(source, name), 'utf8'));
  }
  const digest = createHash('sha256').update(JSON.stringify([...files])).digest('hex');
  const parent = path.join(store.root, 'runtime');
  await privateDir(parent);
  const target = path.join(parent, digest);
  if (!await statOrNull(target)) {
    const staging = path.join(parent, `${digest}.${randomUUID()}.tmp`);
    try {
      await privateDir(staging);
      await privateDir(path.join(staging, 'src'));
      for (const [name, text] of files) await atomicWrite(path.join(staging, name), text);
      await fs.rename(staging, target);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  await assertPrivate(target, true);
  await assertPrivate(path.join(target, 'src'), true);
  for (const [name, text] of files) {
    const file = path.join(target, name);
    await assertPrivate(file);
    if (await fs.readFile(file, 'utf8') !== text) throw new Error(`저장된 실행 코드가 변경됐습니다: ${file}`);
  }
  return path.join(target, 'src/cli.mjs');
}
