// Plugins, skins and the workshop. A plugin is a folder (manifest.json + static files) that runs in a sandboxed,
// opaque-origin iframe and talks to the page only through the permissioned bridge in public/plugin-host.js.
// Only bundled, explicitly granted backends use the separate generic server-plugin host.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKENS, TERMINAL_KEYS, EDITOR_KEYS, THEMES } from '../public/themes.js';

export const SDK_VERSION = 1;
export const BUNDLE_FORMAT = 'cloud-ops-workbench-plugin';
export const DEFAULT_WORKSHOP = 'https://raw.githubusercontent.com/qiuxinyuan321/fusheng-kelaude-workbench/main/workshop/';
export const LIMITS = { bundleBytes: 2 * 1024 * 1024, files: 64, storageBytes: 256 * 1024, registryBytes: 512 * 1024, packageBytes: 3 * 1024 * 1024, installed: 64 };
// What a plugin may ask for. Plugins never see conversation text, files, terminal output or credentials,
// and cannot run commands or reach the network.
export const PERMISSIONS = {
  backend: { label: '服务端扩展', description: '运行随工作台安装的可信后端模块；可管理该插件的账号配置或启动恢复任务。后端拥有服务账号权限，停用后不再调度。', risk: 'high' },
  activity: { label: '运行动态', description: '会话开始思考、调用工具、等待确认、完成或出错的时刻（不含任何内容）', risk: 'low' },
  'sessions.read': { label: '会话概览', description: '会话标题（默认取第一条消息的前 32 个字）、状态、模型与 Token/费用统计，读不到对话记录', risk: 'medium' },
  'usage.read': { label: '官方额度', description: '5 小时与每周额度的使用比例和重置时间', risk: 'low' },
  'system.read': { label: '服务器指标', description: 'CPU、内存、磁盘、负载与运行时长', risk: 'low' },
  storage: { label: '插件存储', description: '在服务器上保存最多 256 KB 的插件自有数据', risk: 'low' },
  'ui.toast': { label: '提示消息', description: '在页面角落显示简短提示', risk: 'low' },
  'ui.statusbar': { label: '状态栏', description: '在底部状态栏显示一小段文字', risk: 'low' },
  'composer.insert': { label: '插入输入框', description: '向消息输入框插入文本，由你检查后手动发送', risk: 'medium' },
};
export const SURFACES = ['panel', 'widget', 'overlay', 'background'];
export const SLOTS = ['sidebar', 'composer'];
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const FILE_PATH = /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
const HEX = /^#[0-9a-f]{6}$/i;
const HEX_ALPHA = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const SHA256 = /^[a-f0-9]{64}$/;
export const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
const TEXT_FILES = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md']);
const RESERVED_THEMES = new Set([...THEMES.map(t => t.id), 'auto']);
const ANCHORS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const COMMAND_ICONS = /^[a-z][a-z-]{0,23}$/;
// Control, zero-width and bidi-override characters would let a name impersonate another or reorder text.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const OFFLINE = '无法连接创意工坊（服务器可能无法访问 GitHub）。你仍然可以在「开发」页导入插件包。';

export class PluginError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new PluginError(status, message); };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') { if (required) fail(400, `缺少 ${field}。`); return ''; }
  if (typeof value !== 'string') fail(400, `${field} 必须是文本。`);
  const clean = value.replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!clean && required) fail(400, `缺少 ${field}。`);
  if ([...clean].length > max) fail(400, `${field} 不能超过 ${max} 个字符。`);
  return clean;
}
function glyph(value, fallback) {
  if (value === undefined || value === null || value === '') return [...fallback][0] || '?';
  if (typeof value !== 'string') fail(400, 'icon 必须是一个表情或 1–2 个字符。');
  const clean = value.replace(CONTROL, '').replace(INVISIBLE, '').trim();
  const count = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(clean)].length;
  if (!clean || count > 2 || clean.length > 16) fail(400, 'icon 必须是一个表情或 1–2 个字符。');
  return clean;
}
function filePath(value, field, { ext = null } = {}) {
  if (typeof value !== 'string' || value.length > 160 || !FILE_PATH.test(value) || value.split('/').length > 8) fail(400, `${field} 路径无效：只能使用字母、数字、. _ - 和 /，不能包含 ..（最长 160 个字符）。`);
  const extension = path.extname(value).toLowerCase();
  if (!MIME[extension] || (ext && !ext.includes(extension))) fail(400, `${field}「${value}」的文件类型不受支持。`);
  return value;
}
function integer(value, min, max, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) fail(400, `${field} 必须是 ${min}–${max} 之间的整数。`);
  return value;
}
function permissionList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) fail(400, 'permissions 必须是数组。');
  return [...new Set(value.map(p => typeof p === 'string' && Object.hasOwn(PERMISSIONS, p) ? p : fail(400, `未知权限：${String(p).slice(0, 40)}`)))].sort();
}
function tagList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 6) fail(400, 'tags 最多 6 个。');
  return [...new Set(value.map(t => text(t, '标签', 12, { required: true })))];
}

export function parseVersion(value) { const m = typeof value === 'string' ? VERSION.exec(value) : null; return m ? m.slice(1).map(Number) : null; }
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b); if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export const minVersionOf = manifest => manifest.engines?.workbench ? manifest.engines.workbench.slice(2) : null;

/* ---------- Skins ---------- */
const THEME_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'var', 'calc', 'min', 'max', 'clamp']);
// Colors and gradients only: no url(), strings, escapes, semicolons or braces, so a value cannot load anything or leave its declaration.
function themeValue(name, value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || !/^[A-Za-z0-9#%(),.\s+\-/*]+$/.test(value) || value.includes('/*') || value.includes('*/')) fail(400, `皮肤变量 --${name} 的值无效：只能使用颜色、渐变和 var()/calc() 等函数。`);
  let depth = 0;
  for (const ch of value) { if (ch === '(') depth++; else if (ch === ')' && --depth < 0) break; }
  if (depth !== 0) fail(400, `皮肤变量 --${name} 的括号不匹配。`);
  for (const [, fn] of value.matchAll(/([A-Za-z-]*)\s*\(/g)) if (!THEME_FUNCTIONS.has(fn.toLowerCase())) fail(400, `皮肤变量 --${name} 使用了不允许的函数 ${fn || '('}()。`);
  for (const match of value.matchAll(/var\(\s*([^,)\s]*)/gi)) if (!match[1].startsWith('--') || !TOKENS.includes(match[1].slice(2))) fail(400, `皮肤变量 --${name} 只能引用工作台的颜色变量。`);
  return value.trim().replace(/\s+/g, ' ');
}
function hexMap(value, keys, field) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) fail(400, `${field} 必须是对象。`);
  const out = {};
  for (const [key, color] of Object.entries(value)) {
    if (!keys.includes(key)) fail(400, `${field} 中有未知字段：${key.slice(0, 40)}`);
    if (typeof color !== 'string' || !HEX_ALPHA.test(color)) fail(400, `${field}.${key} 必须是 #rrggbb 或 #rrggbbaa。`);
    out[key] = color.toLowerCase();
  }
  return out;
}
export function validateTheme(raw) {
  if (!isObject(raw)) fail(400, '皮肤清单需要 theme 对象。');
  if (!['light', 'dark'].includes(raw.scheme)) fail(400, 'theme.scheme 只能是 light 或 dark。');
  if (!isObject(raw.tokens)) fail(400, 'theme.tokens 必须是对象。');
  const entries = Object.entries(raw.tokens);
  if (entries.length < 8) fail(400, '皮肤至少需要定义 8 个颜色变量（建议定义全部核心变量）。');
  const tokens = {};
  for (const [key, value] of entries) {
    const name = key.startsWith('--') ? key.slice(2) : key;
    if (!TOKENS.includes(name)) fail(400, `未知皮肤变量：${key.slice(0, 40)}`);
    tokens[name] = themeValue(name, value);
  }
  for (const key of Object.keys(raw)) if (!['scheme', 'tokens', 'terminal', 'editor'].includes(key)) fail(400, `theme 中有未知字段：${key.slice(0, 40)}`);
  return { scheme: raw.scheme, tokens, terminal: hexMap(raw.terminal, TERMINAL_KEYS, 'theme.terminal'), editor: hexMap(raw.editor, EDITOR_KEYS, 'theme.editor') };
}

/* ---------- Manifests and bundles ---------- */
function contributions(raw) {
  const none = '插件需要在 contributes 中声明至少一个界面：panel、widget、overlay 或 background。';
  if (!isObject(raw)) fail(400, none);
  for (const key of Object.keys(raw)) if (![...SURFACES, ...SLOTS, 'commands'].includes(key)) fail(400, `contributes 中有未知字段：${key.slice(0, 40)}`);
  const section = (key, value) => value === true ? {} : isObject(value) ? value : fail(400, `contributes.${key} 必须是对象。`);
  const out = {};
  if (raw.panel !== undefined && raw.panel !== null) { const p = section('panel', raw.panel); out.panel = { title: text(p.title, 'contributes.panel.title', 16) }; }
  if (raw.widget !== undefined && raw.widget !== null) {
    const w = section('widget', raw.widget);
    if (w.size !== undefined && !['normal', 'wide'].includes(w.size)) fail(400, 'contributes.widget.size 只能是 normal 或 wide。');
    out.widget = { title: text(w.title, 'contributes.widget.title', 24), height: integer(w.height, 80, 640, 220, 'contributes.widget.height'), size: w.size || 'normal' };
  }
  if (raw.overlay !== undefined && raw.overlay !== null) {
    const o = section('overlay', raw.overlay);
    if (o.anchor !== undefined && !ANCHORS.includes(o.anchor)) fail(400, `contributes.overlay.anchor 只能是 ${ANCHORS.join('、')}。`);
    out.overlay = { title: text(o.title, 'contributes.overlay.title', 16), width: integer(o.width, 48, 420, 160, 'contributes.overlay.width'), height: integer(o.height, 48, 420, 160, 'contributes.overlay.height'), anchor: o.anchor || 'bottom-right' };
  }
  if (raw.background !== undefined && raw.background !== null) { section('background', raw.background); out.background = {}; }
  if (!SURFACES.some(s => out[s])) fail(400, none);
  const slotIcon = (value, field) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !COMMAND_ICONS.test(value)) fail(400, `${field} 必须是工作台图标名，例如 layers。`);
    return value;
  };
  // Slots are fixed places in the workbench's own chrome. They have no frame of their own: the sidebar
  // entry opens the panel, and the composer picker is fed by the always-running background surface.
  if (raw.sidebar !== undefined && raw.sidebar !== null) {
    const s = section('sidebar', raw.sidebar);
    if (!out.panel) fail(400, 'contributes.sidebar 需要插件同时声明 panel，点击入口会打开面板。');
    out.sidebar = { title: text(s.title, 'contributes.sidebar.title', 12, { required: true }), subtitle: text(s.subtitle, 'contributes.sidebar.subtitle', 32), icon: slotIcon(s.icon, 'contributes.sidebar.icon') };
  }
  if (raw.composer !== undefined && raw.composer !== null) {
    const c = section('composer', raw.composer);
    if (!out.background) fail(400, 'contributes.composer 需要插件同时声明 background，由后台界面提供选项。');
    out.composer = { title: text(c.title, 'contributes.composer.title', 12, { required: true }), icon: slotIcon(c.icon, 'contributes.composer.icon') };
  }
  out.commands = [];
  if (raw.commands !== undefined && raw.commands !== null) {
    if (!Array.isArray(raw.commands) || raw.commands.length > 12) fail(400, 'contributes.commands 必须是数组，最多 12 条。');
    for (const c of raw.commands) {
      if (!isObject(c) || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(c.id) || out.commands.some(x => x.id === c.id)) fail(400, '命令 id 无效或重复（小写字母、数字和连字符，最长 32 个字符）。');
      if (c.action !== undefined && c.action !== null && c.action !== 'open-panel') fail(400, '命令的 action 只能是 open-panel。');
      if (c.action === 'open-panel' && !out.panel) fail(400, 'open-panel 命令需要插件声明 panel 界面。');
      if (c.icon !== undefined && c.icon !== null && (typeof c.icon !== 'string' || !COMMAND_ICONS.test(c.icon))) fail(400, '命令 icon 必须是工作台图标名，例如 activity。');
      out.commands.push({ id: c.id, title: text(c.title, '命令标题', 24, { required: true }), subtitle: text(c.subtitle, '命令说明', 48), icon: c.icon || null, action: c.action || null });
    }
  }
  return out;
}
// Returns a normalized manifest; normalizing it again yields the same object.
export function validateManifest(raw) {
  if (!isObject(raw)) fail(400, 'manifest.json 必须是 JSON 对象。');
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) fail(400, '插件 id 只能使用小写字母、数字和连字符（2–40 个字符），并以字母或数字开头。');
  const type = raw.type ?? 'plugin';
  if (!['plugin', 'theme'].includes(type)) fail(400, 'type 只能是 plugin 或 theme。');
  if (!parseVersion(raw.version)) fail(400, 'version 必须是 x.y.z 形式的版本号。');
  let engines = {};
  if (raw.engines !== undefined && raw.engines !== null) {
    if (!isObject(raw.engines)) fail(400, 'engines 必须是对象。');
    const wanted = raw.engines.workbench;
    if (wanted !== undefined && wanted !== null) {
      const m = typeof wanted === 'string' ? /^>=\s*(\d{1,4}\.\d{1,4}\.\d{1,4})$/.exec(wanted.trim()) : null;
      if (!m) fail(400, 'engines.workbench 需写成 ">=1.1.0" 的形式。');
      engines = { workbench: `>=${m[1]}` };
    }
  }
  const name = text(raw.name, 'name', 24, { required: true });
  if (raw.accent !== undefined && raw.accent !== null && (typeof raw.accent !== 'string' || !HEX.test(raw.accent))) fail(400, 'accent 必须是 #rrggbb 颜色。');
  const manifest = {
    id: raw.id, type, name, version: raw.version,
    description: text(raw.description, 'description', 160), author: text(raw.author, 'author', 40), license: text(raw.license, 'license', 24),
    engines, icon: glyph(raw.icon, name), accent: raw.accent ? raw.accent.toLowerCase() : null, tags: tagList(raw.tags), permissions: permissionList(raw.permissions),
  };
  if (type === 'theme') {
    if (manifest.permissions.length) fail(400, '皮肤不能申请权限。');
    for (const key of ['main', 'style', 'contributes', 'backend']) if (raw[key] !== undefined && raw[key] !== null) fail(400, `皮肤清单不能包含 ${key}。`);
    if (RESERVED_THEMES.has(raw.id)) fail(400, `皮肤 id「${raw.id}」与内置皮肤重名。`);
    return { ...manifest, theme: validateTheme(raw.theme) };
  }
  if (raw.theme !== undefined && raw.theme !== null) fail(400, '只有 type 为 theme 的清单可以包含 theme。');
  const backend = raw.backend == null ? null : filePath(raw.backend, 'backend', { ext: ['.mjs'] });
  if (Boolean(backend) !== manifest.permissions.includes('backend')) fail(400, '服务端插件必须同时声明 backend 入口和 backend 权限。');
  return {
    ...manifest,
    ...(backend ? { backend } : {}),
    main: filePath(raw.main, 'main', { ext: ['.js', '.mjs'] }),
    style: raw.style === undefined || raw.style === null ? null : filePath(raw.style, 'style', { ext: ['.css'] }),
    contributes: contributions(raw.contributes),
  };
}
export function validateBundle(bundle) {
  if (!isObject(bundle)) fail(400, '插件包格式不正确。');
  if (bundle.format !== BUNDLE_FORMAT) fail(400, '这不是浮生氪劳德工作台的插件包。');
  if (bundle.formatVersion !== 1) fail(400, '插件包版本过新，请先升级工作台。');
  const manifest = validateManifest(bundle.manifest);
  if (manifest.backend) fail(403, '服务端插件不能通过网页导入；请由管理员随工作台源码安装。');
  if (!Array.isArray(bundle.files)) fail(400, '插件包缺少 files。');
  if (bundle.files.length > LIMITS.files) fail(413, `插件包最多包含 ${LIMITS.files} 个文件。`);
  if (manifest.type === 'theme' && bundle.files.length) fail(400, '皮肤包只包含清单，不能附带文件。');
  const files = [], seen = new Set();
  let total = 0;
  for (const file of bundle.files) {
    if (!isObject(file)) fail(400, '插件包中的文件条目无效。');
    const name = filePath(file.path, '文件');
    const lower = name.toLowerCase();
    if (lower === 'manifest.json') fail(400, '插件包的 files 不能包含 manifest.json。');
    if (seen.has(lower)) fail(400, `插件包中有重复文件：${name}`);
    seen.add(lower);
    if (!['utf8', 'base64'].includes(file.encoding) || typeof file.data !== 'string') fail(400, `文件 ${name} 的编码无效。`);
    if (file.encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) fail(400, `文件 ${name} 的 base64 内容无效。`);
    const buffer = Buffer.from(file.data, file.encoding);
    total += buffer.length;
    if (total > LIMITS.bundleBytes) fail(413, '插件包解压后超过 2 MB。');
    files.push({ path: name, buffer });
  }
  // A file may not double as a directory of another file ("a.js" and "a.js/b.js").
  for (const lower of seen) { const parts = lower.split('/'); for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) fail(400, `插件包中的路径互相冲突：${lower}`); }
  for (const [field, value] of [['main', manifest.main], ['style', manifest.style]]) if (value && !files.some(f => f.path === value)) fail(400, `插件包缺少 ${field} 指向的文件 ${value}。`);
  return { manifest, files };
}
// Deterministic: the same folder always packs to the same bytes, so a registry sha256 can be reproduced.
export async function packPlugin(dir) {
  let raw;
  try { raw = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')); }
  catch (error) { fail(400, error.code === 'ENOENT' ? `${dir} 中没有 manifest.json。` : 'manifest.json 不是有效的 JSON。'); }
  const manifest = validateManifest(raw), files = [];
  if (manifest.type === 'plugin') {
    const walk = async rel => {
      for (const entry of (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (!rel && entry.name === 'manifest.json') continue;
        if (entry.isDirectory()) { await walk(child); continue; }
        if (!entry.isFile()) fail(400, `不支持的文件：${child}`);
        filePath(child, '文件');
        const buffer = await fs.readFile(path.join(dir, child));
        const utf8 = TEXT_FILES.has(path.extname(child).toLowerCase()) && Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);
        files.push({ path: child, encoding: utf8 ? 'utf8' : 'base64', data: buffer.toString(utf8 ? 'utf8' : 'base64') });
      }
    };
    await walk('');
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bundle = { format: BUNDLE_FORMAT, formatVersion: 1, manifest, files };
  validateBundle(bundle);
  return bundle;
}
export const serializeBundle = bundle => `${JSON.stringify(bundle, null, 1)}\n`;

/* ---------- Workshop registry ---------- */
// Unset or empty means the project's own catalog; "off" turns the workshop off.
export function normalizeWorkshopUrl(value) {
  const raw = String(value ?? '').trim() || DEFAULT_WORKSHOP;
  if (raw === 'off') return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = ''; url.hash = '';
  return url.href;
}
function registryItem(item) {
  if (!isObject(item) || typeof item.id !== 'string' || !ID.test(item.id)) fail(400, 'id');
  if (!['plugin', 'theme'].includes(item.type) || !parseVersion(item.version)) fail(400, 'type/version');
  const name = text(item.name, 'name', 24, { required: true });
  const out = {
    id: item.id, type: item.type, name, version: item.version, description: text(item.description, 'description', 160), author: text(item.author, 'author', 40),
    tags: tagList(item.tags), permissions: permissionList(item.permissions), icon: glyph(item.icon, name), accent: typeof item.accent === 'string' && HEX.test(item.accent) ? item.accent.toLowerCase() : null,
    surfaces: Array.isArray(item.surfaces) ? [...SURFACES, ...SLOTS].filter(s => item.surfaces.includes(s)) : [], official: item.official === true, bundled: item.bundled === true,
    minVersion: item.minVersion === undefined || item.minVersion === null ? null : parseVersion(item.minVersion) ? item.minVersion : fail(400, 'minVersion'),
  };
  if (item.type === 'theme') {
    if (out.permissions.length || !isObject(item.preview) || !['light', 'dark'].includes(item.preview.scheme)) fail(400, 'preview');
    const swatches = Array.isArray(item.preview.swatches) ? item.preview.swatches.filter(c => typeof c === 'string' && HEX.test(c)).slice(0, 6).map(c => c.toLowerCase()) : [];
    out.preview = { scheme: item.preview.scheme, swatches };
  }
  if (!out.bundled) {
    if (typeof item.path !== 'string' || item.path !== `packages/${item.id}-${item.version}.json`) fail(400, 'path');
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) fail(400, 'sha256');
    if (!Number.isInteger(item.size) || item.size <= 0 || item.size > LIMITS.packageBytes) fail(400, 'size');
    Object.assign(out, { path: item.path, sha256: item.sha256, size: item.size });
  }
  return out;
}
export function parseRegistry(raw) {
  if (!isObject(raw) || raw.schema !== 1 || !Array.isArray(raw.items)) fail(502, '创意工坊目录的格式不受支持，请升级工作台。');
  const items = [];
  let skipped = 0;
  for (const item of raw.items.slice(0, 500)) {
    try { const parsed = registryItem(item); if (!items.some(x => x.id === parsed.id)) items.push(parsed); else skipped++; }
    catch { skipped++; }
  }
  let name = '';
  try { name = text(raw.name, 'name', 40); } catch {}
  const updated = typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? new Date(raw.updatedAt).toISOString() : null;
  return { name: name || '创意工坊', updatedAt: updated, items, skipped };
}

/* ---------- Manager ---------- */
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.error(`Ignoring unreadable ${path.basename(file)}`); return fallback; }
}
async function writeAtomic(file, text) {
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class PluginManager {
  constructor({ dataDir, builtinDir = null, workbenchVersion, origin, safeMode = false, workshopUrl, fetchImpl = globalThis.fetch }) {
    this.installDir = path.join(dataDir, 'plugins');
    this.storageDir = path.join(dataDir, 'plugin-data');
    this.stateFile = path.join(dataDir, 'plugin-state.json');
    this.builtinDir = builtinDir;
    this.version = workbenchVersion;
    this.origin = origin;
    this.safeMode = Boolean(safeMode);
    this.workshopUrl = normalizeWorkshopUrl(workshopUrl);
    if (!this.workshopUrl && String(workshopUrl).trim() !== 'off') console.warn('WORKBENCH_WORKSHOP_URL 不是有效的 https:// 地址，创意工坊已关闭。');
    this.fetch = fetchImpl;
    // Asset URLs carry an HMAC instead of the login cookie, which an opaque-origin frame never sends.
    this.secret = randomBytes(32);
    this.plugins = new Map();
    this.errors = [];
    this.state = { plugins: {} };
    this.queue = Promise.resolve();
    this.registryCache = null;
    this.registryRequest = null;
  }
  async init() {
    await fs.mkdir(this.installDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(this.installDir)) if (/^\.(install|old)-/.test(entry)) await fs.rm(path.join(this.installDir, entry), { recursive: true, force: true });
    const state = await readJson(this.stateFile, null);
    this.state = { plugins: {} };
    if (isObject(state?.plugins)) for (const [id, record] of Object.entries(state.plugins)) if (ID.test(id) && isObject(record)) this.state.plugins[id] = record;
    await this.scan();
  }
  // Every change to plugin files or state runs one at a time.
  lock(task) { const run = this.queue.then(task, task); this.queue = run.catch(() => {}); return run; }
  async saveState() { await writeAtomic(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`); }
  async scan() {
    const plugins = new Map(), errors = [];
    const load = async (base, builtin) => {
      let entries;
      try { entries = await fs.readdir(base, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') errors.push({ dir: base, error: '无法读取插件目录。' }); return; }
      for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
        if (entry.name.startsWith('.')) continue;
        try {
          const dir = await fs.realpath(path.join(base, entry.name));
          if (!(await fs.stat(dir)).isDirectory()) continue;
          let raw;
          try { raw = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')); }
          catch (error) { fail(400, error.code === 'ENOENT' ? '缺少 manifest.json。' : 'manifest.json 不是有效的 JSON。'); }
          const manifest = validateManifest(raw);
          if (manifest.backend && !builtin) fail(403, '服务端插件只能由管理员放入工作台内置插件目录。');
          if (manifest.id !== entry.name) fail(400, `目录名需要与插件 id「${manifest.id}」一致。`);
          if (plugins.has(manifest.id)) fail(409, `「${manifest.id}」与内置插件重名，已忽略。`);
          for (const file of [manifest.main, manifest.style].filter(Boolean)) {
            const real = await fs.realpath(path.join(dir, file)).catch(() => fail(400, `找不到 ${file}。`));
            if (!real.startsWith(dir + path.sep)) fail(400, `${file} 指向了插件目录之外。`);
          }
          const recorded = this.state.plugins[manifest.id]?.source;
          plugins.set(manifest.id, { id: manifest.id, manifest, dir, source: builtin ? 'builtin' : ['workshop', 'local'].includes(recorded) ? recorded : 'dev' });
        } catch (error) {
          errors.push({ dir: entry.name, builtin, error: error instanceof PluginError ? error.message : '无法读取这个插件目录。' });
        }
      }
    };
    if (this.builtinDir) await load(this.builtinDir, true);
    await load(this.installDir, false);
    this.plugins = plugins;
    this.errors = errors;
    return this.list();
  }
  describe(plugin) {
    const m = plugin.manifest, record = this.state.plugins[plugin.id] || {};
    const granted = Array.isArray(record.granted) ? record.granted.filter(p => Object.hasOwn(PERMISSIONS, p)) : [];
    const consented = m.permissions.every(p => granted.includes(p));
    const minVersion = minVersionOf(m), compatible = !minVersion || compareVersions(this.version, minVersion) >= 0;
    const enabled = m.type === 'plugin' && record.enabled === true;
    return {
      id: m.id, type: m.type, name: m.name, version: m.version, description: m.description, author: m.author, license: m.license,
      icon: m.icon, accent: m.accent, tags: m.tags, permissions: m.permissions, minVersion, compatible, source: plugin.source,
      enabled, granted, needsConsent: enabled && !consented, active: m.type === 'plugin' && !this.safeMode && enabled && consented && compatible,
      ...(m.backend ? { backend: true } : {}),
      surfaces: m.type === 'plugin' ? [...SURFACES, ...SLOTS].filter(s => m.contributes[s]) : [], contributes: m.contributes || null,
      installedAt: record.installedAt || null, sha256: record.sha256 || null, ...(m.type === 'theme' ? { theme: m.theme } : {}),
    };
  }
  isActive(id) { const plugin = this.plugins.get(id); return Boolean(plugin && this.describe(plugin).active); }
  list() {
    const all = [...this.plugins.values()].map(p => this.describe(p));
    return {
      safeMode: this.safeMode, sdkVersion: SDK_VERSION, workbenchVersion: this.version, workshop: { enabled: Boolean(this.workshopUrl), url: this.workshopUrl },
      devDir: this.installDir, permissions: PERMISSIONS, plugins: all.filter(p => p.type === 'plugin'), themes: all.filter(p => p.type === 'theme'), errors: this.errors,
    };
  }
  setEnabled(id, enabled, granted) {
    return this.lock(async () => {
      const plugin = this.plugins.get(id);
      if (!plugin) fail(404, '插件不存在。');
      if (plugin.manifest.type !== 'plugin') fail(400, '皮肤无需启用，安装后即可在「皮肤」页选择。');
      if (typeof enabled !== 'boolean') fail(400, '参数不正确。');
      const record = { ...this.state.plugins[id] };
      if (enabled) {
        if (this.safeMode) fail(409, '工作台正处于安全模式，暂时不能启用插件。');
        const info = this.describe(plugin);
        if (!info.compatible) fail(409, `这个插件需要工作台 ${info.minVersion} 或更新版本。`);
        if (!Array.isArray(granted) || !plugin.manifest.permissions.every(p => granted.includes(p))) fail(400, '请先确认插件申请的全部权限。');
        record.granted = [...plugin.manifest.permissions];
      }
      record.enabled = enabled;
      this.state.plugins[id] = record;
      await this.saveState();
      return this.list();
    });
  }
  install(input, { source = 'local', expect = null } = {}) {
    return this.lock(async () => {
      const { manifest, files } = validateBundle(input);
      if (expect && (manifest.id !== expect.id || manifest.version !== expect.version || manifest.type !== expect.type || !sameSet(manifest.permissions, expect.permissions))) fail(502, '插件包与创意工坊目录中的信息不一致，已拒绝安装。');
      const existing = this.plugins.get(manifest.id), target = path.join(this.installDir, manifest.id);
      if (existing?.source === 'builtin') fail(409, `「${manifest.name}」是工作台内置的插件，无需安装。`);
      const recorded = this.state.plugins[manifest.id]?.source;
      const occupied = await fs.lstat(target).then(() => true, () => false);
      if (existing?.source === 'dev' || (occupied && !['workshop', 'local'].includes(recorded))) fail(409, `插件目录中已有开发中的「${manifest.id}」，请先移走 ${target}。`);
      if (!existing && this.plugins.size >= LIMITS.installed) fail(409, `最多安装 ${LIMITS.installed} 个插件和皮肤，请先卸载一些。`);
      const minVersion = minVersionOf(manifest);
      if (minVersion && compareVersions(this.version, minVersion) < 0) fail(409, `需要工作台 ${minVersion} 或更新版本，请先升级工作台。`);
      const temp = path.join(this.installDir, `.install-${manifest.id}-${randomBytes(6).toString('hex')}`);
      try {
        await fs.mkdir(temp, { mode: 0o700 });
        for (const file of files) {
          const dest = path.join(temp, ...file.path.split('/'));
          await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
          await fs.writeFile(dest, file.buffer, { mode: 0o600, flag: 'wx' });
        }
        await fs.writeFile(path.join(temp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        let old = null;
        if (occupied) { old = path.join(this.installDir, `.old-${manifest.id}-${randomBytes(6).toString('hex')}`); await fs.rename(target, old); }
        try { await fs.rename(temp, target); }
        catch (error) { if (old) await fs.rename(old, target).catch(() => {}); throw error; }
        if (old) await fs.rm(old, { recursive: true, force: true });
      } catch (error) {
        await fs.rm(temp, { recursive: true, force: true });
        if (error instanceof PluginError) throw error;
        fail(500, '插件文件写入失败，请检查数据目录的磁盘空间与权限。');
      }
      // An update keeps running only if it asks for nothing new; otherwise it waits for consent again.
      const previous = this.state.plugins[manifest.id] || {};
      this.state.plugins[manifest.id] = { enabled: previous.enabled === true, granted: Array.isArray(previous.granted) ? previous.granted : [], source, installedAt: new Date().toISOString(), version: manifest.version, sha256: sha256(serializeBundle(input)) };
      await this.saveState();
      await this.scan();
      return { ...this.list(), installed: manifest.id };
    });
  }
  uninstall(id) {
    return this.lock(async () => {
      const plugin = this.plugins.get(id);
      if (!plugin) fail(404, '插件不存在。');
      if (plugin.source === 'builtin') fail(400, '内置插件不能卸载，可以停用。');
      if (plugin.source === 'dev') fail(400, `开发中的插件请直接删除它的目录：${path.join(this.installDir, id)}`);
      const trash = path.join(this.installDir, `.old-${id}-${randomBytes(6).toString('hex')}`);
      await fs.rename(path.join(this.installDir, id), trash);
      await fs.rm(trash, { recursive: true, force: true });
      await fs.rm(path.join(this.storageDir, `${id}.json`), { force: true });
      delete this.state.plugins[id];
      await this.saveState();
      return this.scan();
    });
  }
  storagePlugin(id) {
    const plugin = this.plugins.get(id);
    if (!plugin || !this.describe(plugin).active) fail(404, '插件未启用。');
    if (!plugin.manifest.permissions.includes('storage')) fail(403, '这个插件没有申请存储权限。');
    return plugin;
  }
  async readStorage(id) {
    this.storagePlugin(id);
    const data = await readJson(path.join(this.storageDir, `${id}.json`), {});
    return isObject(data) ? data : {};
  }
  writeStorage(id, data) {
    this.storagePlugin(id);
    if (!isObject(data)) fail(400, '插件数据必须是 JSON 对象。');
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > LIMITS.storageBytes) fail(413, '插件数据超过 256 KB 上限。');
    return this.lock(() => writeAtomic(path.join(this.storageDir, `${id}.json`), serialized));
  }
  assetToken(id) { return createHmac('sha256', this.secret).update(`asset:${id}`).digest('base64url').slice(0, 24); }
  validAssetToken(id, token) {
    const expected = Buffer.from(this.assetToken(id)), actual = Buffer.from(String(token ?? ''));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  // The document a plugin runs in: the SDK, then the plugin's own script, under a CSP that only reaches these files.
  frame(id, surface, { scheme } = {}) {
    const plugin = this.plugins.get(id);
    if (this.safeMode || !plugin || !this.describe(plugin).active || !SURFACES.includes(surface) || !plugin.manifest.contributes[surface]) return null;
    const m = plugin.manifest, assets = `${this.origin}/plugin-assets/${id}/${this.assetToken(id)}/`, sdk = `${this.origin}/plugin-sdk/`;
    const colorScheme = scheme === 'dark' ? 'dark' : 'light';
    const csp = [
      "default-src 'none'", `script-src ${sdk} ${assets}`, `style-src ${sdk} ${assets} 'unsafe-inline'`, `img-src ${assets} data: blob:`, `font-src ${assets} data:`,
      `connect-src ${assets}`, `media-src ${assets} data: blob:`, "frame-src 'none'", "worker-src 'none'", "child-src 'none'", "object-src 'none'", "manifest-src 'none'",
      "base-uri 'none'", "form-action 'none'", `frame-ancestors ${this.origin}`, 'sandbox allow-scripts',
    ].join('; ');
    const html = `<!doctype html>
<html lang="zh-CN" data-surface="${surface}" style="color-scheme:${colorScheme}">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="${colorScheme}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(m.name)}</title>
<link rel="stylesheet" href="${sdk}base.css">
${m.style ? `<link rel="stylesheet" href="${assets}${encodeURI(m.style)}">\n` : ''}<script src="${sdk}sdk.js"></script>
</head>
<body>
<script${m.main.endsWith('.mjs') ? ' type="module"' : ''} src="${assets}${encodeURI(m.main)}"></script>
</body>
</html>
`;
    return { html, csp };
  }
  async asset(id, token, segments) {
    const plugin = this.plugins.get(id);
    if (this.safeMode || !plugin || !this.describe(plugin).active || !this.validAssetToken(id, token)) return null;
    const rel = Array.isArray(segments) ? segments.join('/') : String(segments ?? '');
    if (rel.length > 160 || !FILE_PATH.test(rel) || rel.split('/').length > 8) return null;
    const type = MIME[path.extname(rel).toLowerCase()];
    if (!type) return null;
    try {
      const real = await fs.realpath(path.join(plugin.dir, ...rel.split('/')));
      if (!real.startsWith(plugin.dir + path.sep) || !(await fs.stat(real)).isFile()) return null;
      return { file: real, type };
    } catch { return null; }
  }
  async download(url, limit) {
    let response;
    try { response = await this.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } }); }
    catch { fail(502, OFFLINE); }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) fail(502, '创意工坊返回了重定向，已拒绝。');
    if (!response.ok) fail(502, response.status === 404 ? '创意工坊中找不到这个文件。' : `创意工坊暂时不可用（HTTP ${response.status}）。`);
    if (Number(response.headers.get('content-length')) > limit) fail(502, '创意工坊返回的内容过大，已拒绝。');
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) { await response.body.cancel?.().catch(() => {}); fail(502, '创意工坊返回的内容过大，已拒绝。'); }
        chunks.push(chunk);
      }
    } catch (error) { if (error instanceof PluginError) throw error; fail(502, OFFLINE); }
    return Buffer.concat(chunks.map(c => Buffer.from(c)));
  }
  annotate(data) {
    // Only the project's own catalog may mark entries official; a mirror or third-party catalog cannot borrow the badge.
    const project = this.workshopUrl === DEFAULT_WORKSHOP;
    return {
      ...data, workbenchVersion: this.version, project,
      items: data.items.map(item => {
        const local = this.plugins.get(item.id);
        return {
          ...item, official: item.official && project, installed: Boolean(local), installedVersion: local?.manifest.version || null, installedSource: local?.source || null,
          compatible: !item.minVersion || compareVersions(this.version, item.minVersion) >= 0,
          updatable: Boolean(local && ['workshop', 'local'].includes(local.source) && local.manifest.type === item.type && compareVersions(item.version, local.manifest.version) > 0),
          reserved: !item.bundled && ['builtin', 'dev'].includes(local?.source),
        };
      }),
    };
  }
  async registry({ refresh = false } = {}) {
    if (!this.workshopUrl) fail(404, '创意工坊已在服务器配置中关闭（WORKBENCH_WORKSHOP_URL=off）。');
    if (!refresh && this.registryCache && Date.now() - this.registryCache.at < 10 * 60 * 1000) return this.annotate(this.registryCache.data);
    this.registryRequest ||= (async () => {
      try {
        const bytes = await this.download(new URL('registry.json', this.workshopUrl).href, LIMITS.registryBytes);
        let raw;
        try { raw = JSON.parse(bytes.toString('utf8')); } catch { fail(502, '创意工坊目录不是有效的 JSON。'); }
        const data = parseRegistry(raw);
        this.registryCache = { at: Date.now(), data };
        return data;
      } finally { this.registryRequest = null; }
    })();
    return this.annotate(await this.registryRequest);
  }
  async installFromWorkshop(id) {
    if (typeof id !== 'string' || !ID.test(id)) fail(400, '条目 id 无效。');
    const item = (await this.registry()).items.find(x => x.id === id);
    if (!item) fail(404, '创意工坊中没有这个条目。');
    if (item.bundled) fail(400, '这是工作台内置的插件，无需安装，在「已安装」中启用即可。');
    if (!item.compatible) fail(409, `需要工作台 ${item.minVersion} 或更新版本，请先升级工作台。`);
    const url = new URL(item.path, this.workshopUrl).href;
    if (!url.startsWith(this.workshopUrl)) fail(502, '条目地址无效。');
    const bytes = await this.download(url, LIMITS.packageBytes);
    if (sha256(bytes) !== item.sha256) fail(502, '下载的插件包校验失败（sha256 不一致），已拒绝安装。');
    let bundle;
    try { bundle = JSON.parse(bytes.toString('utf8')); } catch { fail(502, '插件包不是有效的 JSON。'); }
    return this.install(bundle, { source: 'workshop', expect: item });
  }
}
