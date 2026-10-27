// Rebuilds the workshop catalog that workbenches download from this repository:
//   npm run workshop:build              packs workshop/src/* into workshop/packages and rewrites workshop/registry.json
//   npm run workshop:build -- --check   changes nothing; exits 1 if either is out of date (CI runs this)
// Built-in plugins are listed as well, marked bundled, so the workshop can show them; they are never downloaded.
// Only maintainers edit workshop/official.json, which decides who gets the 「官方」 badge.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { packPlugin, serializeBundle, parseRegistry, validateManifest, minVersionOf, SURFACES, SLOTS, LIMITS } from '../lib/plugins.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workshop = path.join(root, 'workshop'), registryFile = path.join(workshop, 'registry.json');
const NAME = '浮生氪劳德工作台 · 创意工坊';
const SWATCHES = ['bg', 'brand', 'brand-4', 'amber-2', 'red', 'ink'];
const check = process.argv.includes('--check');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function folders(dir) {
  try { return (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function entry(manifest, extra) {
  const theme = manifest.type === 'theme';
  return {
    id: manifest.id, type: manifest.type, name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author,
    tags: manifest.tags, permissions: manifest.permissions, icon: manifest.icon, accent: manifest.accent,
    surfaces: theme ? [] : [...SURFACES, ...SLOTS].filter(s => manifest.contributes[s]), minVersion: minVersionOf(manifest), ...extra,
    ...(theme ? { preview: { scheme: manifest.theme.scheme, swatches: [...new Set(SWATCHES.map(k => manifest.theme.tokens[k]).filter(c => /^#[0-9a-f]{6}$/i.test(c || '')))] } } : {}),
  };
}

async function build() {
  const official = new Set(JSON.parse(await read(path.join(workshop, 'official.json')) || '[]'));
  const items = [], packages = new Map();
  for (const id of await folders(path.join(root, 'plugins'))) {
    const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(root, 'plugins', id, 'manifest.json'), 'utf8')));
    items.push(entry(manifest, { official: true, bundled: true }));
  }
  for (const id of await folders(path.join(workshop, 'src'))) {
    const where = `workshop/src/${id}`;
    const bundle = await packPlugin(path.join(workshop, 'src', id)).catch(error => { throw new Error(`${where}：${error.message}`); });
    const manifest = bundle.manifest;
    if (manifest.id !== id) throw new Error(`${where}：目录名需要与插件 id「${manifest.id}」一致。`);
    if (items.some(item => item.id === id)) throw new Error(`${where}：与内置插件重名。`);
    if (!minVersionOf(manifest)) throw new Error(`${where}：请在 engines.workbench 中写明需要的最低工作台版本，例如 ">=1.1.0"。`);
    const text = serializeBundle(bundle), bytes = Buffer.from(text), file = `packages/${id}-${manifest.version}.json`;
    if (bytes.length > LIMITS.packageBytes) throw new Error(`${where}：插件包超过 ${LIMITS.packageBytes / 1048576} MB。`);
    packages.set(file, text);
    items.push(entry(manifest, { official: official.has(id), bundled: false, path: file, sha256: sha256(bytes), size: bytes.length }));
  }
  for (const id of official) if (!items.some(item => item.id === id)) console.warn(`提示：official.json 里的「${id}」没有对应的条目。`);
  // Built-in first, then official, then community; plugins before skins.
  const rank = item => (item.bundled ? 0 : item.official ? 2 : 4) + (item.type === 'theme' ? 1 : 0);
  items.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));

  // Store exactly what a workbench will read back, and keep updatedAt when nothing changed.
  const parsed = parseRegistry({ schema: 1, name: NAME, items });
  if (parsed.skipped || parsed.items.length !== items.length) throw new Error('有条目没有通过创意工坊目录的校验。');
  let previous = null;
  try { previous = JSON.parse(await read(registryFile) || 'null'); } catch {}
  const unchanged = previous && JSON.stringify(previous.items) === JSON.stringify(parsed.items) && Number.isFinite(Date.parse(previous.updatedAt));
  const registry = { schema: 1, name: NAME, updatedAt: unchanged ? previous.updatedAt : new Date().toISOString(), items: parsed.items };
  const text = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(text) > LIMITS.registryBytes) throw new Error(`registry.json 超过 ${LIMITS.registryBytes / 1024} KB。`);
  return { registry, text, packages };
}

try {
  const { registry, text, packages } = await build();
  const packageDir = path.join(workshop, 'packages');
  const stale = (await fs.readdir(packageDir).catch(() => [])).filter(name => name.endsWith('.json') && !packages.has(`packages/${name}`));
  const outdated = [];
  if (await read(registryFile) !== text) outdated.push('workshop/registry.json');
  for (const [file, content] of packages) if (await read(path.join(workshop, file)) !== content) outdated.push(`workshop/${file}`);
  const counts = `${registry.items.filter(i => i.type === 'plugin').length} 个插件、${registry.items.filter(i => i.type === 'theme').length} 款皮肤`;
  if (check) {
    if (outdated.length || stale.length) {
      console.error(`创意工坊目录不是最新的，请运行 npm run workshop:build 并提交结果：\n${[...outdated.map(f => `  需要更新  ${f}`), ...stale.map(f => `  需要删除  workshop/packages/${f}`)].join('\n')}`);
      process.exitCode = 1;
    } else console.log(`创意工坊目录是最新的（${counts}）。`);
  } else {
    await fs.mkdir(packageDir, { recursive: true });
    for (const [file, content] of packages) if (outdated.includes(`workshop/${file}`)) await fs.writeFile(path.join(workshop, file), content);
    for (const name of stale) await fs.rm(path.join(packageDir, name));
    if (outdated.includes('workshop/registry.json')) await fs.writeFile(registryFile, text);
    const changes = [...outdated.map(f => `  已写入  ${f}`), ...stale.map(f => `  已删除  workshop/packages/${f}`)];
    console.log(`创意工坊目录：${counts}${changes.length ? `\n${changes.join('\n')}` : '，没有变化。'}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
