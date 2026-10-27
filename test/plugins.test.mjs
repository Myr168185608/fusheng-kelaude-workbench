import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from '../server.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { validateManifest, validateBundle, packPlugin, serializeBundle, normalizeWorkshopUrl, parseRegistry, BUNDLE_FORMAT, DEFAULT_WORKSHOP } from '../lib/plugins.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORIGIN = 'https://claude.test.invalid';
const WORKSHOP = 'https://workshop.test.invalid/catalog/';
const PASSWORD = 'test-only-password-do-not-deploy';
const record = await hashPassword(PASSWORD);
const BUILTINS = ['account-pool', 'ops-pulse', 'task-resume', 'usage-stats', 'xiaoyun-pet'];
const FRAME = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const exists = file => fs.lstat(file).then(() => true, () => false);
const offline = async () => { throw new TypeError('fetch failed'); };

const TOKENS = Object.fromEntries(['bg', 'surface', 'sunken', 'line', 'ink', 'ink-2', 'ink-3', 'brand'].map(name => [name, '#123456']));
function bundle(manifest = {}, files = { 'main.js': 'console.log("hello from a plugin")\n' }) {
  return {
    format: BUNDLE_FORMAT, formatVersion: 1,
    manifest: { id: 'demo', name: 'Demo', version: '1.0.0', main: 'main.js', contributes: { panel: { title: 'Demo' } }, ...manifest },
    files: Object.entries(files).map(([file, data]) => ({ path: file, encoding: 'utf8', data })),
  };
}
const skinBundle = (manifest = {}) => ({ format: BUNDLE_FORMAT, formatVersion: 1, manifest: { id: 'my-skin', type: 'theme', name: 'Mine', version: '1.0.0', theme: { scheme: 'dark', tokens: TOKENS }, ...manifest }, files: [] });

async function fixture(t, { dir = null, safeMode = false, workshopUrl = WORKSHOP, fetchImpl = offline } = {}) {
  const owned = !dir;
  dir ||= await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-ops-workbench-plugins-'));
  const usageSnapshot = { fiveHour: { utilization: 2, resetsAt: '2026-10-18T00:00:00Z' }, sevenDay: { utilization: 5, resetsAt: '2026-10-22T00:00:00Z' }, scopes: [], source: 'test', updatedAt: '2026-10-18T00:00:00Z', stale: false };
  const wb = await createWorkbench({
    dataDir: path.join(dir, 'data'), workspaceRoot: path.join(dir, 'workspaces'), origin: ORIGIN, passwordRecord: record,
    monitor: { async sample(activeRuns) { return { activeRuns, cpuPercent: 3 }; }, async auth() { return { loggedIn: true, subscriptionType: 'pro' }; } },
    usageMonitor: { read: () => usageSnapshot, refresh: async () => usageSnapshot, observe: () => {}, close: async () => {} },
    runFactory: () => { throw new Error('plugin tests never start a run'); },
    safeMode, workshopUrl, fetchImpl,
  });
  const server = await new Promise(resolve => { const s = wb.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '', closed = false;
  async function raw(route, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const h = { Origin: ORIGIN, ...(method !== 'GET' ? { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}), ...headers };
    return fetch(base + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function api(route, options) {
    const res = await raw(route, options), text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
  async function login() {
    const res = await api('/api/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(res.status, 200);
    cookie = res.headers.get('set-cookie').split(';')[0];
    csrf = res.body.csrfToken;
  }
  async function close() {
    if (closed) return;
    closed = true;
    await wb.close();
    await new Promise(resolve => server.close(resolve));
  }
  t.after(async () => { await close(); if (owned) await fs.rm(dir, { recursive: true, force: true }); });
  return { api, raw, login, close, wb, dataDir: path.join(dir, 'data') };
}
async function enable(f, id) {
  const plugin = (await f.api('/api/plugins')).body.plugins.find(p => p.id === id);
  const res = await f.api(`/api/plugins/${id}/enable`, { method: 'POST', body: { enabled: true, granted: plugin.permissions } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.plugins.find(p => p.id === id);
}
const install = (f, body) => f.api('/api/plugins/install', { method: 'POST', body });

test('manifests are validated strictly and normalizing twice changes nothing', async () => {
  for (const id of BUILTINS) {
    const once = validateManifest(JSON.parse(await fs.readFile(path.join(ROOT, 'plugins', id, 'manifest.json'), 'utf8')));
    assert.deepEqual(validateManifest(once), once);
  }
  const base = bundle().manifest;
  assert.equal(validateManifest(base).contributes.panel.title, 'Demo');
  assert.throws(() => validateManifest({ ...base, id: 'Demo' }), /插件 id/);
  assert.throws(() => validateManifest({ ...base, version: '1.0' }), /version/);
  assert.throws(() => validateManifest({ ...base, permissions: ['network'] }), /未知权限/);
  assert.throws(() => validateManifest({ ...base, engines: { workbench: '^1.1.0' } }), /engines/);
  assert.throws(() => validateManifest({ ...base, main: '../evil.js' }), /路径无效/);
  assert.throws(() => validateManifest({ ...base, main: 'main.exe' }), /不受支持/);
  assert.throws(() => validateManifest({ ...base, contributes: {} }), /至少一个界面/);
  assert.throws(() => validateManifest({ ...base, contributes: { panel: true, toolbar: true } }), /未知字段/);
  assert.throws(() => validateManifest({ ...base, contributes: { widget: true, commands: [{ id: 'go', title: 'Go', action: 'open-panel' }] } }), /需要插件声明 panel/);
  assert.throws(() => validateManifest({ ...base, contributes: { panel: true, commands: [{ id: 'go', title: 'Go', action: 'run-shell' }] } }), /action/);
  assert.throws(() => validateManifest({ ...base, icon: 'too long' }), /icon/);
  // Slots: a sidebar entry opens the panel, a composer picker is fed by the background surface.
  const slotted = validateManifest({ ...base, contributes: { panel: true, background: true, sidebar: { title: '账号空间', icon: 'layers' }, composer: { title: '账号' } } });
  assert.deepEqual(slotted.contributes.sidebar, { title: '账号空间', subtitle: '', icon: 'layers' });
  assert.deepEqual(slotted.contributes.composer, { title: '账号', icon: null });
  assert.deepEqual(validateManifest(slotted), slotted);
  assert.throws(() => validateManifest({ ...base, contributes: { background: true, sidebar: { title: 'X' } } }), /需要插件同时声明 panel/);
  assert.throws(() => validateManifest({ ...base, contributes: { panel: true, composer: { title: 'X' } } }), /需要插件同时声明 background/);
  assert.throws(() => validateManifest({ ...base, contributes: { panel: true, sidebar: {} } }), /sidebar\.title/);
  assert.throws(() => validateManifest({ ...base, contributes: { panel: true, sidebar: { title: '十三个字的侧边栏入口标题太长' } } }), /sidebar\.title/);
  assert.throws(() => validateManifest({ ...base, contributes: { panel: true, sidebar: { title: 'X', icon: '<svg>' } } }), /图标名/);
  assert.deepEqual(validateManifest({ ...base, contributes: { panel: true, background: true, composer: { title: 'X', extra: 1 } } }).contributes.composer, { title: 'X', icon: null });
  assert.throws(() => validateManifest({ ...base, theme: { scheme: 'dark', tokens: TOKENS } }), /只有 type 为 theme/);
  // Names cannot hide bidi overrides or zero-width characters.
  const rlo = String.fromCodePoint(0x202e), zwsp = String.fromCodePoint(0x200b);
  assert.equal(validateManifest({ ...base, name: `De${rlo}mo${zwsp}` }).name, 'Demo');
});

test('skins may only carry colors and gradients', () => {
  const skin = (theme = {}, extra = {}) => ({ ...skinBundle().manifest, ...extra, theme: { scheme: 'dark', tokens: TOKENS, ...theme } });
  assert.equal(validateManifest(skin()).theme.scheme, 'dark');
  assert.equal(validateManifest(skin({ tokens: { ...TOKENS, 'grad-ok': 'linear-gradient(90deg, var(--brand), #ffffff)' } })).theme.tokens['grad-ok'], 'linear-gradient(90deg, var(--brand), #ffffff)');
  for (const value of ['url(https://evil.invalid/x.png)', '#fff;background:red', 'var(--x-evil)', 'expression(alert(1))', '"x"', 'red /* x */', 'rgb(1,2,3', 'image-set(a)'])
    assert.throws(() => validateManifest(skin({ tokens: { ...TOKENS, bg: value } })), /皮肤变量/, value);
  assert.throws(() => validateManifest(skin({ tokens: { ...TOKENS, evil: '#ffffff' } })), /未知皮肤变量/);
  assert.throws(() => validateManifest(skin({ tokens: { bg: '#000000' } })), /至少需要定义 8 个/);
  assert.throws(() => validateManifest(skin({ terminal: { background: 'red' } })), /theme\.terminal\.background/);
  assert.throws(() => validateManifest(skin({ editor: { shell: '#ffffff' } })), /未知字段/);
  assert.throws(() => validateManifest(skin({}, { permissions: ['storage'] })), /不能申请权限/);
  assert.throws(() => validateManifest(skin({}, { main: 'main.js' })), /不能包含 main/);
  for (const id of ['spruce', 'ink-night', 'auto']) assert.throws(() => validateManifest(skin({}, { id })), /内置皮肤重名/);
});

test('bundles reject unsafe paths and pack deterministically', async t => {
  const file = (name, data = 'x') => ({ path: name, encoding: 'utf8', data });
  const withFiles = files => ({ ...bundle(), files });
  assert.equal(validateBundle(withFiles([file('main.js')])).files.length, 1);
  assert.throws(() => validateBundle(withFiles([file('main.js'), file('../up.js')])), /路径无效/);
  assert.throws(() => validateBundle(withFiles([file('main.js'), file('/abs.js')])), /路径无效/);
  assert.throws(() => validateBundle(withFiles([file('main.js'), file('manifest.json')])), /manifest\.json/);
  assert.throws(() => validateBundle(withFiles([file('main.js'), file('MAIN.js')])), /重复/);
  assert.throws(() => validateBundle(withFiles([file('main.js'), file('lib.js'), file('lib.js/x.js')])), /冲突/);
  assert.throws(() => validateBundle(withFiles([file('other.js')])), /缺少 main/);
  assert.throws(() => validateBundle(withFiles([file('main.js'), { path: 'a.png', encoding: 'base64', data: '***' }])), /base64/);
  assert.throws(() => validateBundle(withFiles([file('main.js'), file('big.txt', 'x'.repeat(2 * 1024 * 1024))])), /2 MB/);
  assert.throws(() => validateBundle({ ...bundle(), format: 'something-else' }), /不是浮生氪劳德工作台的插件包/);
  assert.throws(() => validateBundle({ ...skinBundle(), files: [file('main.js')] }), /只包含清单/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-ops-workbench-pack-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(bundle().manifest));
  await fs.writeFile(path.join(dir, 'main.js'), 'console.log("hi")\n');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=never-packed');
  await fs.mkdir(path.join(dir, 'img'));
  await fs.writeFile(path.join(dir, 'img', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
  const first = serializeBundle(await packPlugin(dir));
  assert.equal(serializeBundle(await packPlugin(dir)), first);
  assert.deepEqual(JSON.parse(first).files.map(f => [f.path, f.encoding]), [['img/logo.png', 'base64'], ['main.js', 'utf8']]);
  assert.doesNotMatch(first, /never-packed/);
  // A symlink could smuggle in a file from outside the folder.
  await fs.symlink('/etc/hostname', path.join(dir, 'leak.txt'));
  await assert.rejects(packPlugin(dir), /不支持的文件/);
});

test('workshop URLs must be https and registry entries are checked one by one', () => {
  assert.equal(normalizeWorkshopUrl(undefined), DEFAULT_WORKSHOP);
  assert.equal(normalizeWorkshopUrl('  '), DEFAULT_WORKSHOP);
  assert.equal(normalizeWorkshopUrl('off'), null);
  assert.equal(normalizeWorkshopUrl('http://example.invalid/w/'), null);
  assert.equal(normalizeWorkshopUrl('https://user:secret@example.invalid/w/'), null);
  assert.equal(normalizeWorkshopUrl('not a url'), null);
  assert.equal(normalizeWorkshopUrl('https://example.invalid/w?x=1#y'), 'https://example.invalid/w/');
  const good = { id: 'demo', type: 'plugin', name: 'Demo', version: '1.0.0', path: 'packages/demo-1.0.0.json', sha256: 'a'.repeat(64), size: 10 };
  const parsed = parseRegistry({ schema: 1, name: 'Test', items: [
    good, { ...good },
    { ...good, id: 'escape', path: '../../etc/passwd' },
    { ...good, id: 'unsigned', path: 'packages/unsigned-1.0.0.json', sha256: 'xyz' },
    { ...good, id: 'skin', type: 'theme', path: 'packages/skin-1.0.0.json', preview: { scheme: 'dark', swatches: ['#000000', 'red'] } },
    { id: 'builtin', type: 'plugin', name: 'Builtin', version: '1.0.0', bundled: true },
  ] });
  assert.deepEqual(parsed.items.map(i => i.id), ['demo', 'skin', 'builtin']);
  assert.equal(parsed.skipped, 3);
  assert.deepEqual(parsed.items[1].preview, { scheme: 'dark', swatches: ['#000000'] });
  assert.equal(parsed.items[2].path, undefined);
  assert.throws(() => parseRegistry({ schema: 2, items: [] }), /格式不受支持/);
});

test('the published workshop catalog matches its packages and the built-in plugins', async () => {
  const registry = JSON.parse(await fs.readFile(path.join(ROOT, 'workshop', 'registry.json'), 'utf8'));
  const parsed = parseRegistry(registry);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.items.length, registry.items.length);
  assert.deepEqual(parsed.items.filter(i => i.bundled).map(i => i.id).sort(), BUILTINS);
  for (const item of parsed.items) {
    if (item.bundled) {
      const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(ROOT, 'plugins', item.id, 'manifest.json'), 'utf8')));
      assert.deepEqual([item.version, item.permissions], [manifest.version, manifest.permissions]);
      continue;
    }
    const bytes = await fs.readFile(path.join(ROOT, 'workshop', item.path));
    assert.equal(bytes.length, item.size, item.id);
    assert.equal(sha256(bytes), item.sha256, item.id);
    const { manifest } = validateBundle(JSON.parse(bytes));
    assert.deepEqual([manifest.id, manifest.version, manifest.type, manifest.permissions], [item.id, item.version, item.type, item.permissions]);
  }
  // The catalog is generated, so the build script in check mode has to agree with what is committed.
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'workshop-build.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('plugins need login, explicit consent and a compatible workbench', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/plugins')).status, 401);
  await f.login();
  const list = (await f.api('/api/plugins')).body;
  assert.deepEqual(list.plugins.map(p => p.id), BUILTINS);
  assert.ok(list.plugins.every(p => p.source === 'builtin' && p.compatible && !p.enabled && !p.active));
  assert.equal(list.workshop.url, WORKSHOP);
  assert.equal((await f.api('/api/plugins/xiaoyun-pet/enable', { method: 'POST', body: { enabled: true, granted: ['activity'] } })).status, 400);
  assert.equal((await f.api('/api/plugins/xiaoyun-pet/enable', { method: 'POST', body: { enabled: true }, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.api('/api/plugins/nope/enable', { method: 'POST', body: { enabled: true, granted: [] } })).status, 404);
  const pet = await enable(f, 'xiaoyun-pet');
  assert.equal(pet.active, true);
  assert.deepEqual(pet.granted, pet.permissions);
  const off = await f.api('/api/plugins/xiaoyun-pet/enable', { method: 'POST', body: { enabled: false } });
  assert.equal(off.body.plugins.find(p => p.id === 'xiaoyun-pet').active, false);

  // A folder in the plugin directory is picked up on rescan; one that needs a newer workbench cannot run.
  const dev = path.join(f.dataDir, 'plugins', 'future');
  await fs.mkdir(dev);
  await fs.writeFile(path.join(dev, 'manifest.json'), JSON.stringify({ ...bundle().manifest, id: 'future', engines: { workbench: '>=99.0.0' } }));
  await fs.writeFile(path.join(dev, 'main.js'), '');
  const broken = path.join(f.dataDir, 'plugins', 'broken');
  await fs.mkdir(broken);
  await fs.writeFile(path.join(broken, 'manifest.json'), '{ not json');
  const scanned = (await f.api('/api/plugins/rescan', { method: 'POST', body: {} })).body;
  const future = scanned.plugins.find(p => p.id === 'future');
  assert.deepEqual([future.source, future.compatible], ['dev', false]);
  assert.deepEqual(scanned.errors.map(e => e.dir), ['broken']);
  assert.equal((await f.api('/api/plugins/future/enable', { method: 'POST', body: { enabled: true, granted: [] } })).status, 409);
});

test('plugin frames and assets are only served to the workbench page', async t => {
  const f = await fixture(t);
  await f.login();
  const page = await f.raw('/');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), new RegExp(`frame-src ${ORIGIN}/plugin-frame/;`));
  const url = '/plugin-frame/usage-stats/panel?scheme=dark';
  assert.equal((await f.raw(url, { headers: FRAME })).status, 404);
  await enable(f, 'usage-stats');

  const res = await f.raw(url, { headers: FRAME });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-dns-prefetch-control'), 'off');
  const csp = res.headers.get('content-security-policy'), html = await res.text();
  const main = html.match(/<script src="([^"]+\/main\.js)"/)[1], assets = main.slice(0, -'main.js'.length);
  assert.match(assets, new RegExp(`^${ORIGIN}/plugin-assets/usage-stats/[A-Za-z0-9_-]{24}/$`));
  for (const part of ["default-src 'none'", `script-src ${ORIGIN}/plugin-sdk/ ${assets};`, `connect-src ${assets};`, "frame-src 'none'", `frame-ancestors ${ORIGIN}`, 'sandbox allow-scripts'])
    assert.ok(csp.includes(part), part);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(html, /style="color-scheme:dark"/);
  assert.match(html, /<script src="https:\/\/claude\.test\.invalid\/plugin-sdk\/sdk\.js"><\/script>/);

  assert.equal((await f.raw(url, { headers: FRAME, auth: false })).status, 401);
  assert.equal((await f.raw(url, { headers: { ...FRAME, 'Sec-Fetch-Dest': 'document' } })).status, 403);
  assert.equal((await f.raw(url, { headers: { ...FRAME, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.raw('/plugin-frame/usage-stats/overlay', { headers: FRAME })).status, 404);
  assert.equal((await f.raw('/plugin-frame/xiaoyun-pet/overlay', { headers: FRAME })).status, 404);

  // Assets carry an HMAC token instead of the cookie, which an opaque-origin frame never sends.
  const assetPath = new URL(main).pathname, token = assetPath.split('/')[3];
  const script = await f.raw(assetPath, { auth: false });
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  assert.equal(script.headers.get('access-control-allow-origin'), '*');
  assert.match(script.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await f.raw(`/plugin-assets/usage-stats/${'A'.repeat(token.length)}/main.js`, { auth: false })).status, 404);
  assert.equal((await f.raw(`/plugin-assets/usage-stats/${token}/..%2f..%2fpackage.json`, { auth: false })).status, 404);
  assert.equal((await f.raw(`/plugin-assets/xiaoyun-pet/${token}/pet.js`, { auth: false })).status, 404);
  await f.api('/api/plugins/usage-stats/enable', { method: 'POST', body: { enabled: false } });
  assert.equal((await f.raw(assetPath, { auth: false })).status, 404);
});

test('plugin storage is per plugin, permissioned and limited to 256 KB', async t => {
  const f = await fixture(t);
  await f.login();
  const route = '/api/plugins/usage-stats/storage';
  assert.equal((await f.api(route)).status, 404);
  await enable(f, 'usage-stats');
  assert.deepEqual((await f.api(route)).body, { data: {} });
  assert.equal((await f.api(route, { method: 'PUT', body: { data: { trend: [1, 2, 3] } } })).status, 200);
  assert.deepEqual((await f.api(route)).body, { data: { trend: [1, 2, 3] } });
  const stat = await fs.stat(path.join(f.dataDir, 'plugin-data', 'usage-stats.json'));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal((await f.api(route, { method: 'PUT', body: { data: [1] } })).status, 400);
  assert.equal((await f.api(route, { method: 'PUT', body: { data: { big: 'x'.repeat(256 * 1024) } } })).status, 413);
  assert.equal((await f.api(route, { method: 'PUT', body: { data: {} }, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  await enable(f, 'xiaoyun-pet');
  assert.deepEqual((await f.api('/api/plugins/xiaoyun-pet/storage')).body, { data: {} });
  // Without the storage permission there is no storage at all.
  assert.equal((await install(f, { bundle: bundle({ id: 'stateless' }) })).status, 200);
  await enable(f, 'stateless');
  assert.equal((await f.api('/api/plugins/stateless/storage')).status, 403);
});

test('local bundles install, update with consent and uninstall cleanly', async t => {
  const f = await fixture(t);
  await f.login();
  const first = await install(f, { bundle: bundle({ id: 'hello', permissions: ['storage'] }) });
  assert.equal(first.status, 200);
  assert.equal(first.body.installed, 'hello');
  let hello = first.body.plugins.find(p => p.id === 'hello');
  assert.deepEqual([hello.source, hello.enabled], ['local', false]);
  const dir = path.join(f.dataDir, 'plugins', 'hello');
  assert.equal((await fs.stat(path.join(dir, 'main.js'))).mode & 0o777, 0o600);
  await enable(f, 'hello');
  await f.api('/api/plugins/hello/storage', { method: 'PUT', body: { data: { n: 1 } } });

  // An update that asks for nothing new keeps running; one that asks for more waits for consent.
  hello = (await install(f, { bundle: bundle({ id: 'hello', version: '1.1.0', permissions: ['storage'] }) })).body.plugins.find(p => p.id === 'hello');
  assert.deepEqual([hello.version, hello.active], ['1.1.0', true]);
  hello = (await install(f, { bundle: bundle({ id: 'hello', version: '1.2.0', permissions: ['storage', 'ui.toast'] }) })).body.plugins.find(p => p.id === 'hello');
  assert.deepEqual([hello.needsConsent, hello.active], [true, false]);
  assert.equal((await f.raw('/plugin-frame/hello/panel', { headers: FRAME })).status, 404);
  assert.equal((await enable(f, 'hello')).active, true);
  assert.deepEqual((await f.api('/api/plugins/hello/storage')).body, { data: { n: 1 } });

  assert.equal((await install(f, { bundle: bundle({ id: 'usage-stats' }) })).status, 409);
  assert.equal((await install(f, { bundle: bundle({ id: 'future', engines: { workbench: '>=99.0.0' } }) })).status, 409);
  assert.equal((await install(f, { bundle: { ...bundle(), files: [{ path: '../x.js', encoding: 'utf8', data: '' }] } })).status, 400);
  const skins = (await install(f, { bundle: skinBundle() })).body.themes;
  assert.deepEqual(skins.map(s => [s.id, s.theme.scheme]), [['my-skin', 'dark']]);

  assert.equal((await f.api('/api/plugins/hello/uninstall', { method: 'POST', body: {} })).status, 200);
  assert.equal(await exists(dir), false);
  assert.equal(await exists(path.join(f.dataDir, 'plugin-data', 'hello.json')), false);
  assert.equal((await f.api('/api/plugins/usage-stats/uninstall', { method: 'POST', body: {} })).status, 400);
  assert.deepEqual((await fs.readdir(path.join(f.dataDir, 'plugins'))).sort(), ['my-skin']);
});

test('workshop installs verify sha256, refuse redirects and must match the catalog', async t => {
  const remote = serializeBundle(bundle({ id: 'remote', permissions: ['storage'] }));
  const greedy = serializeBundle(bundle({ id: 'greedy', permissions: ['composer.insert', 'storage'] }));
  const entry = (id, text, extra = {}) => ({ id, type: 'plugin', name: id, version: '1.0.0', permissions: ['storage'], surfaces: ['panel'], path: `packages/${id}-1.0.0.json`, sha256: sha256(text), size: Buffer.byteLength(text), ...extra });
  const catalog = items => JSON.stringify({ schema: 1, name: 'Test workshop', updatedAt: '2026-10-19T00:00:00Z', items });
  const files = new Map([
    ['registry.json', catalog([
      entry('remote', remote), entry('tampered', remote), entry('greedy', greedy), entry('moved', remote),
      { id: 'usage-stats', type: 'plugin', name: '用量统计', version: '1.0.0', bundled: true, official: true },
    ])],
    ['packages/remote-1.0.0.json', remote],
    ['packages/tampered-1.0.0.json', remote.replace('hello from a plugin', 'something else')],
    ['packages/greedy-1.0.0.json', greedy],
  ]);
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), redirect: options.redirect });
    const name = String(url).startsWith(WORKSHOP) ? String(url).slice(WORKSHOP.length) : null;
    if (name === 'packages/moved-1.0.0.json') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/x.json' } });
    return files.has(name) ? new Response(files.get(name), { status: 200 }) : new Response('missing', { status: 404 });
  };
  const f = await fixture(t, { fetchImpl });
  await f.login();
  const listed = await f.api('/api/workshop');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map(i => i.id), ['remote', 'tampered', 'greedy', 'moved', 'usage-stats']);
  assert.equal(listed.body.items.find(i => i.id === 'usage-stats').installed, true);
  // Only the project's own catalog can hand out the 官方 badge.
  assert.deepEqual([listed.body.project, listed.body.items.find(i => i.id === 'usage-stats').official], [false, false]);
  const project = await fixture(t, { workshopUrl: DEFAULT_WORKSHOP, fetchImpl: async url => String(url) === `${DEFAULT_WORKSHOP}registry.json` ? new Response(files.get('registry.json'), { status: 200 }) : new Response('missing', { status: 404 }) });
  await project.login();
  const projectList = (await project.api('/api/workshop')).body;
  assert.deepEqual([projectList.project, projectList.items.find(i => i.id === 'usage-stats').official, projectList.items.find(i => i.id === 'remote').official], [true, true, false]);
  const fromWorkshop = id => install(f, { workshopId: id });
  const ok = await fromWorkshop('remote');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.plugins.find(p => p.id === 'remote').source, 'workshop');
  assert.match((await fromWorkshop('tampered')).body.error, /sha256/);
  assert.match((await fromWorkshop('greedy')).body.error, /不一致/);
  assert.match((await fromWorkshop('moved')).body.error, /重定向/);
  assert.equal((await fromWorkshop('usage-stats')).status, 400);
  assert.equal((await fromWorkshop('missing')).status, 404);
  assert.equal((await fromWorkshop('../escape')).status, 400);
  assert.ok(requests.every(r => r.redirect === 'manual' && r.url.startsWith(WORKSHOP)));
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'plugins')), ['remote']);

  // A newer catalog entry offers an update once the cached catalog is refreshed.
  const next = serializeBundle(bundle({ id: 'remote', version: '1.1.0', permissions: ['storage'] }));
  files.set('registry.json', catalog([entry('remote', next, { version: '1.1.0', path: 'packages/remote-1.1.0.json' })]));
  files.set('packages/remote-1.1.0.json', next);
  assert.equal((await f.api('/api/workshop')).body.items.length, 5);
  const refreshed = (await f.api('/api/workshop?refresh=1')).body.items[0];
  assert.deepEqual([refreshed.updatable, refreshed.installedVersion], [true, '1.0.0']);
  assert.equal((await fromWorkshop('remote')).body.plugins.find(p => p.id === 'remote').version, '1.1.0');
});

test('an unreachable or disabled workshop leaves the rest of the workbench working', async t => {
  const unreachable = await fixture(t);
  await unreachable.login();
  const failed = await unreachable.api('/api/workshop');
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /无法连接创意工坊/);
  assert.equal((await unreachable.api('/api/plugins')).status, 200);
  for (const workshopUrl of ['off', 'http://insecure.invalid/workshop/']) {
    const f = await fixture(t, { workshopUrl });
    await f.login();
    assert.equal((await f.api('/api/plugins')).body.workshop.enabled, false);
    assert.equal((await f.api('/api/workshop')).status, 404);
  }
});

test('safe mode loads no plugin code', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-ops-workbench-safe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const normal = await fixture(t, { dir });
  await normal.login();
  await enable(normal, 'usage-stats');
  assert.equal((await normal.raw('/plugin-frame/usage-stats/panel', { headers: FRAME })).status, 200);
  await normal.close();

  const safe = await fixture(t, { dir, safeMode: true });
  await safe.login();
  const list = (await safe.api('/api/plugins')).body;
  const stats = list.plugins.find(p => p.id === 'usage-stats');
  assert.deepEqual([list.safeMode, stats.enabled, stats.active], [true, true, false]);
  assert.equal((await safe.api('/api/bootstrap')).body.config.plugins.safeMode, true);
  assert.equal((await safe.raw('/plugin-frame/usage-stats/panel', { headers: FRAME })).status, 404);
  assert.equal((await safe.api('/api/plugins/usage-stats/storage')).status, 404);
  const pet = list.plugins.find(p => p.id === 'xiaoyun-pet');
  assert.equal((await safe.api('/api/plugins/xiaoyun-pet/enable', { method: 'POST', body: { enabled: true, granted: pet.permissions } })).status, 409);
});

test('/api/stats exposes session summaries and counters, never content', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/stats')).status, 401);
  await f.login();
  assert.equal((await f.api('/api/sessions', { method: 'POST', body: { permissionMode: 'default' } })).status, 201);
  const { sessions } = (await f.api('/api/stats')).body;
  assert.equal(sessions.length, 1);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['archived', 'createdAt', 'effort', 'id', 'metrics', 'model', 'permissionMode', 'status', 'title', 'updatedAt']);
  assert.ok(Object.values(sessions[0].metrics).every(v => v === null || typeof v === 'number'));
});
