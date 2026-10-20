// Runs plugins inside sandboxed iframes (opaque origin: no cookies, no access to this page) and answers their
// bridge calls. Every frame gets its own MessageChannel; a call is honored only when the plugin was granted the
// matching permission. Plugins never receive conversation text, files, terminal output or credentials.
import { pluginTokens } from './themes.js';

const $ = (selector, root = document) => root.querySelector(selector);
const SURFACE_LABELS = { panel: '面板', widget: '小组件', overlay: '悬浮窗', background: '后台' };
// Broadcast events and the permission needed to receive them; theme, visibility and command always reach the plugin.
const EVENT_PERMISSIONS = { activity: 'activity', session: 'sessions.read', 'session:active': 'sessions.read', metrics: 'sessions.read', usage: 'usage.read', system: 'system.read' };
const METRIC_KEYS = ['turns', 'toolCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'durationMs', 'apiDurationMs', 'contextTokens', 'contextWindow'];
const RATE_PER_SECOND = 50, PARAMS_LIMIT = 64 * 1024, STORAGE_LIMIT = 256 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
const local = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch {} } };
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const plain = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const clip = (text, max) => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text; };
const fail = (message, code = 'invalid') => { throw Object.assign(new Error(message), { code }); };
const oneLine = value => value.replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
function cleanText(value, field) {
  if (typeof value !== 'string') fail(`${field} 必须是文本。`);
  const text = oneLine(value);
  if (!text) fail(`${field} 不能为空。`);
  return text;
}
function storageKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) fail('存储键只能使用字母、数字和 _ . : -，最长 64 个字符。');
  return key;
}
const metricsOf = metrics => Object.fromEntries(METRIC_KEYS.map(key => [key, number(metrics?.[key])]));
const summaryOf = s => ({ id: String(s.id), title: typeof s.title === 'string' ? s.title : '', model: typeof s.model === 'string' ? s.model : null, status: typeof s.status === 'string' ? s.status : 'idle', archived: Boolean(s.archived), createdAt: s.createdAt || null, updatedAt: s.updatedAt || null });

export function createPluginHost(ctx) {
  const mounted = new Map(), stores = new Map();
  let data = null, monitorShown = false, stats = null, statsAt = 0, statsRequest = null, metricsTimer = null;

  const themePayload = () => { const theme = ctx.theme(); return { id: theme?.id || 'spruce', name: theme?.name || '', scheme: theme?.scheme === 'dark' ? 'dark' : 'light', tokens: pluginTokens() }; };
  const usagePayload = () => {
    const u = ctx.usage() || {}, meter = w => ({ utilization: number(w?.utilization), resetsAt: typeof w?.resetsAt === 'string' ? w.resetsAt : null });
    return { fiveHour: meter(u.fiveHour), sevenDay: meter(u.sevenDay), rateLimited: u.rateLimited === true, cooldownUntil: typeof u.cooldownUntil === 'string' ? u.cooldownUntil : null, updatedAt: u.updatedAt || null, stale: u.stale !== false, unavailableReason: typeof u.unavailableReason === 'string' ? u.unavailableReason.slice(0, 200) : null };
  };
  const systemPayload = () => { const s = ctx.system(); return s ? plain({ cpuPercent: s.cpuPercent, memory: s.memory, swap: s.swap, disk: s.disk, load: s.load, uptimeSeconds: s.uptimeSeconds, activeRuns: s.activeRuns, sampledAt: s.sampledAt }) : null; };
  const activePayload = () => { const s = ctx.activeSession(); return s?.id ? { ...summaryOf(s), metrics: metricsOf(s.metrics) } : null; };
  async function sessionStats() {
    if (stats && Date.now() - statsAt < 5000) return stats;
    statsRequest ||= ctx.api('/api/stats').then(result => {
      stats = (Array.isArray(result.sessions) ? result.sessions : []).map(s => ({ ...summaryOf(s), metrics: metricsOf(s.metrics) })); statsAt = Date.now(); return stats;
    }).finally(() => { statsRequest = null; });
    return statsRequest;
  }

  /* ---------- Frames and the bridge ---------- */
  function post(frame, message) { if (frame.port) frame.port.postMessage(message); }
  function frameVisible(frame) {
    if (document.hidden) return false;
    if (frame.surface === 'panel') return ctx.currentView() === `plugin:${frame.entry.plugin.id}`;
    if (frame.surface === 'widget') return monitorShown;
    return frame.surface === 'overlay' && !frame.entry.overlayHidden;
  }
  function refreshVisibility() {
    for (const entry of mounted.values()) for (const frame of entry.frames.values()) {
      const visible = frameVisible(frame);
      if (visible !== frame.visible) { frame.visible = visible; post(frame, { event: 'visibility', data: { visible } }); }
    }
  }
  // The channel is handed over once, to the first document the frame loads. A frame that navigates itself
  // (the server refuses that request anyway) keeps no channel.
  function connect(frame) {
    if (frame.loaded) { frame.port?.close(); frame.port = null; return; }
    frame.loaded = true;
    const channel = new MessageChannel(), { plugin } = frame.entry;
    frame.port = channel.port1;
    channel.port1.onmessage = event => { handle(frame, event.data); };
    try {
      frame.iframe.contentWindow?.postMessage({
        type: 'workbench:init', protocol: 1, plugin: { id: plugin.id, name: plugin.name, version: plugin.version, icon: plugin.icon, accent: plugin.accent },
        surface: frame.surface, permissions: [...plugin.permissions], theme: themePayload(), locale: 'zh-CN', visible: frame.visible, workbench: { version: ctx.version(), sdk: 1 },
      }, '*', [channel.port2]);
    } catch {}
    for (const message of frame.backlog.splice(0)) channel.port1.postMessage(message);
  }
  function ensureFrame(entry, surface) {
    const existing = entry.frames.get(surface); if (existing) return existing;
    const { plugin } = entry, iframe = document.createElement('iframe');
    iframe.className = `plugin-frame plugin-frame-${surface}`;
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.title = `${plugin.name} · ${SURFACE_LABELS[surface]}`;
    if (surface === 'widget') iframe.style.height = `${plugin.contributes.widget.height}px`;
    if (surface === 'background') { iframe.tabIndex = -1; iframe.setAttribute('aria-hidden', 'true'); }
    const frame = { entry, surface, iframe, port: null, loaded: false, visible: false, windowStart: 0, calls: 0, backlog: [] };
    iframe.addEventListener('load', () => connect(frame));
    entry.frames.set(surface, frame);
    frame.visible = frameVisible(frame);
    iframe.src = `/plugin-frame/${encodeURIComponent(plugin.id)}/${surface}?scheme=${themePayload().scheme}`;
    if (surface === 'panel') entry.view.append(iframe);
    else if (surface === 'widget') $('.plugin-widget-body', entry.widget).append(iframe);
    else if (surface === 'overlay') entry.overlay.prepend(iframe);
    else backgroundHost().append(iframe);
    return frame;
  }
  function dropFrame(entry, surface) { const frame = entry.frames.get(surface); if (!frame) return; frame.port?.close(); frame.port = null; frame.iframe.remove(); entry.frames.delete(surface); }
  function backgroundHost() {
    let host = $('#plugin-background');
    if (!host) { host = document.createElement('div'); host.id = 'plugin-background'; host.hidden = true; document.body.append(host); }
    return host;
  }
  function throttle(entry, key, ms) { const now = Date.now(); if (now - (entry.last[key] || 0) < ms) fail('操作过于频繁，请稍后再试。', 'rate'); entry.last[key] = now; }

  const METHODS = {
    'workbench.info': { run: () => ({ version: ctx.version(), sdk: 1, locale: 'zh-CN' }) },
    'theme.get': { run: () => themePayload() },
    'ui.toast': { permission: 'ui.toast', run(frame, params) {
      const text = clip(cleanText(params?.text, '提示内容'), 200);
      throttle(frame.entry, 'toast', 2000); ctx.toast(`「${frame.entry.plugin.name}」${text}`);
      return true;
    } },
    'ui.setStatus': { permission: 'ui.statusbar', run(frame, params) { setStatus(frame.entry, params); return true; } },
    'ui.openPanel': { run(frame) { if (!frame.entry.plugin.contributes.panel) fail('这个插件没有面板。'); throttle(frame.entry, 'panel', 2000); openPanel(frame.entry.plugin.id); return true; } },
    'ui.resize': { run(frame, params) { return resize(frame, params); } },
    'ui.hide': { run(frame) { if (frame.surface !== 'overlay') fail('只有悬浮窗可以隐藏自己。'); setOverlayHidden(frame.entry, true); return true; } },
    'storage.get': { permission: 'storage', async run(frame, params) { const key = storageKey(params?.key), store = await loadStore(frame.entry.plugin.id); return Object.hasOwn(store.data, key) ? store.data[key] : null; } },
    'storage.keys': { permission: 'storage', async run(frame) { return Object.keys((await loadStore(frame.entry.plugin.id)).data); } },
    'storage.set': { permission: 'storage', async run(frame, params) {
      const key = storageKey(params?.key), id = frame.entry.plugin.id, store = await loadStore(id);
      let text;
      try { text = JSON.stringify(params?.value); } catch { fail('值必须可以转换为 JSON。'); }
      if (text === undefined) fail('值不能是 undefined；删除请使用 storage.remove。');
      const next = { ...store.data, [key]: JSON.parse(text) };
      if (new Blob([JSON.stringify(next)]).size > STORAGE_LIMIT) fail('插件数据超过 256 KB 上限。', 'quota');
      store.data = next; saveStore(id, store); postPlugin(frame.entry, 'storage:change', { key, value: next[key] }, frame);
      return true;
    } },
    'storage.remove': { permission: 'storage', async run(frame, params) {
      const key = storageKey(params?.key), id = frame.entry.plugin.id, store = await loadStore(id);
      if (!Object.hasOwn(store.data, key)) return false;
      const next = { ...store.data }; delete next[key];
      store.data = next; saveStore(id, store); postPlugin(frame.entry, 'storage:change', { key, value: null }, frame);
      return true;
    } },
    'usage.get': { permission: 'usage.read', run: () => usagePayload() },
    'system.get': { permission: 'system.read', run: () => systemPayload() },
    'sessions.list': { permission: 'sessions.read', run: () => sessionStats() },
    'sessions.get': { permission: 'sessions.read', async run(frame, params) { const id = typeof params?.id === 'string' ? params.id : fail('需要会话 id。'); return (await sessionStats()).find(s => s.id === id) || null; } },
    'sessions.active': { permission: 'sessions.read', run: () => activePayload() },
    'sessions.open': { permission: 'sessions.read', run(frame, params) {
      if (typeof params?.id !== 'string') fail('需要会话 id。');
      throttle(frame.entry, 'open', 1000);
      if (!ctx.openSession(params.id)) fail('会话不存在或已归档。', 'not_found');
      return true;
    } },
    'composer.insert': { permission: 'composer.insert', run(frame, params) {
      const text = params?.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 30000) fail('插入的文本需为 1–30000 个字符。');
      throttle(frame.entry, 'insert', 1000);
      ctx.insertText(text.replace(BIDI, ''));
      ctx.toast(`插件「${frame.entry.plugin.name}」插入了文本，请检查后再发送。`);
      return true;
    } },
  };
  async function handle(frame, message) {
    if (!message || typeof message !== 'object' || !Number.isInteger(message.id) || message.id < 1 || typeof message.method !== 'string') return;
    const reply = payload => {
      try { frame.port?.postMessage({ id: message.id, ...payload }); }
      catch { frame.port?.postMessage({ id: message.id, error: { message: '返回值无法传递。', code: 'failed' } }); }
    };
    const now = performance.now();
    if (now - frame.windowStart > 1000) { frame.windowStart = now; frame.calls = 0; }
    if (++frame.calls > RATE_PER_SECOND) return reply({ error: { message: '调用过于频繁，请稍后再试。', code: 'rate' } });
    const entry = frame.entry, method = Object.hasOwn(METHODS, message.method) ? METHODS[message.method] : null;
    if (mounted.get(entry.plugin.id) !== entry || entry.frames.get(frame.surface) !== frame) return reply({ error: { message: '插件已停用。', code: 'unavailable' } });
    if (!method) return reply({ error: { message: `未知方法：${message.method.slice(0, 40)}`, code: 'unknown' } });
    if (method.permission && !entry.plugin.permissions.includes(method.permission)) return reply({ error: { message: `插件没有申请「${data?.permissions?.[method.permission]?.label || method.permission}」权限。`, code: 'permission' } });
    let size;
    try { size = JSON.stringify(message.params ?? null).length; } catch { return reply({ error: { message: '参数无法转换为 JSON。', code: 'invalid' } }); }
    if (size > PARAMS_LIMIT) return reply({ error: { message: '参数过大（上限 64 KB）。', code: 'invalid' } });
    try { reply({ result: plain(await method.run(frame, message.params ?? null)) }); }
    catch (error) {
      reply({ error: { message: error?.code ? error.message : '调用没有完成。', code: error?.code || 'failed' } });
      if (!error?.code) console.warn(`[plugin ${entry.plugin.id}] ${message.method}:`, error);
    }
  }
  function postPlugin(entry, event, payload, except = null) { for (const frame of entry.frames.values()) if (frame !== except) post(frame, { event, data: payload }); }
  function emit(event, payload) {
    const permission = EVENT_PERMISSIONS[event]; if (!permission) return;
    const message = { event, data: plain(payload) };
    for (const entry of mounted.values()) if (entry.plugin.permissions.includes(permission)) for (const frame of entry.frames.values()) post(frame, message);
  }

  /* ---------- Storage: cached per plugin, saved shortly after each change ---------- */
  function loadStore(id) {
    let store = stores.get(id);
    if (!store) {
      store = { data: {}, timer: null, ready: null };
      store.ready = ctx.api(`/api/plugins/${encodeURIComponent(id)}/storage`).then(result => {
        store.data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {}; return store;
      }, error => { stores.delete(id); fail(`插件数据暂时无法读取：${error.message}`, 'unavailable'); });
      stores.set(id, store);
    }
    return store.ready;
  }
  function writeStore(id, store, leaving = false) {
    clearTimeout(store.timer); store.timer = null;
    const body = { data: store.data };
    // keepalive lets the last save survive closing the tab; browsers cap such requests at 64 KB.
    const keepalive = leaving && JSON.stringify(body).length < 60000;
    return ctx.api(`/api/plugins/${encodeURIComponent(id)}/storage`, { method: 'PUT', body, keepalive }).catch(error => console.warn(`插件「${id}」的数据没有保存：${error.message}`));
  }
  function saveStore(id, store) { clearTimeout(store.timer); store.timer = setTimeout(() => writeStore(id, store), 400); }
  function flushStores() { for (const [id, store] of stores) if (store.timer) writeStore(id, store, true); }
  window.addEventListener('pagehide', flushStores);

  /* ---------- Surfaces ---------- */
  function glyph(plugin) {
    const mark = document.createElement('span'); mark.className = 'plugin-glyph'; mark.textContent = plugin.icon;
    mark.style.setProperty('--plugin-accent', plugin.accent || 'var(--brand)');
    return mark;
  }
  function setStatus(entry, params) {
    if (params === null) { entry.status?.remove(); entry.status = null; return; }
    if (!params || typeof params !== 'object') fail('状态需要 { text } 对象。');
    const text = clip(cleanText(params.text, '状态文字'), 48), tone = ['ok', 'warn', 'bad'].includes(params.tone) ? params.tone : '';
    if (!entry.status) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'plugin-status'; button.dataset.plugin = entry.plugin.id;
      const label = document.createElement('span'); label.className = 'plugin-status-text';
      button.append(glyph(entry.plugin), label); button.addEventListener('click', () => postPlugin(entry, 'statusbar:click', {}));
      // Keep the plugin list's order rather than whichever frame happened to report first, so items don't swap on reload.
      const order = id => data?.plugins.findIndex(p => p.id === id) ?? -1;
      const next = [...$('#plugin-status').children].find(el => order(el.dataset.plugin) > order(entry.plugin.id));
      $('#plugin-status').insertBefore(button, next || null); entry.status = button;
    }
    $('.plugin-status-text', entry.status).textContent = text;
    const title = typeof params.title === 'string' ? oneLine(params.title) : '';
    entry.status.title = `${entry.plugin.name}${title ? ` · ${clip(title, 120)}` : ''}`;
    entry.status.dataset.tone = tone;
  }
  function resize(frame, params) {
    const clamp = (value, min, max, fallback) => { const n = number(value); return n === null ? fallback : Math.round(Math.min(max, Math.max(min, n))); };
    if (frame.surface === 'widget') { const height = clamp(params?.height, 80, 640, frame.iframe.offsetHeight || 220); frame.iframe.style.height = `${height}px`; return { height }; }
    if (frame.surface === 'overlay') {
      const box = frame.entry.overlay, width = clamp(params?.width, 48, 420, box.offsetWidth), height = clamp(params?.height, 48, 420, box.offsetHeight);
      box.style.width = `${width}px`; box.style.height = `${height}px`; placeOverlay(frame.entry);
      return { width, height };
    }
    fail('只有小组件和悬浮窗可以调整大小。');
  }
  function openPanel(id) { ctx.switchView(`plugin:${id}`); }
  const overlayKey = id => `cloud-ops-workbench-overlay:${id}`;
  // Overlay positions are offsets from the anchored corner, kept inside the window.
  function placeOverlay(entry, save = false) {
    const box = entry.overlay, anchor = entry.plugin.contributes.overlay.anchor, width = box.offsetWidth || 160, height = box.offsetHeight || 160;
    entry.position = { x: Math.round(Math.max(0, Math.min(innerWidth - width, entry.position.x))), y: Math.round(Math.max(0, Math.min(innerHeight - height, entry.position.y))) };
    box.style.left = box.style.right = box.style.top = box.style.bottom = '';
    box.style[anchor.endsWith('right') ? 'right' : 'left'] = `${entry.position.x}px`;
    box.style[anchor.startsWith('bottom') ? 'bottom' : 'top'] = `${entry.position.y}px`;
    if (save) local.set(overlayKey(entry.plugin.id), JSON.stringify({ ...entry.position, hidden: entry.overlayHidden }));
  }
  function setOverlayHidden(entry, hidden) {
    if (!entry.overlay) return;
    entry.overlayHidden = hidden; entry.overlay.hidden = hidden;
    if (hidden) dropFrame(entry, 'overlay'); else ensureFrame(entry, 'overlay');
    placeOverlay(entry, true); refreshVisibility(); ctx.onChange?.();
  }
  function createOverlay(entry) {
    const { plugin } = entry, spec = plugin.contributes.overlay, right = spec.anchor.endsWith('right'), bottom = spec.anchor.startsWith('bottom');
    let saved = null; try { saved = JSON.parse(local.get(overlayKey(plugin.id)) || 'null'); } catch {}
    // On phones the message box fills the bottom of the screen, so overlays start above it.
    entry.position = { x: number(saved?.x) ?? 24, y: number(saved?.y) ?? (bottom ? (innerWidth <= 680 ? 156 : 52) : 72) };
    entry.overlayHidden = saved?.hidden === true;
    const box = document.createElement('div'); box.className = 'plugin-overlay'; box.dataset.plugin = plugin.id; box.dataset.anchor = spec.anchor; box.hidden = entry.overlayHidden;
    box.style.width = `${spec.width}px`; box.style.height = `${spec.height}px`;
    const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'plugin-overlay-grip'; grip.title = '拖动以移动 · 方向键微调'; grip.setAttribute('aria-label', `移动「${plugin.name}」`); grip.innerHTML = ctx.icon('grip');
    const close = document.createElement('button'); close.type = 'button'; close.className = 'plugin-overlay-close'; close.title = '隐藏'; close.setAttribute('aria-label', `隐藏「${plugin.name}」`); close.innerHTML = ctx.icon('close');
    close.addEventListener('click', () => { setOverlayHidden(entry, true); ctx.toast(`已隐藏「${plugin.name}」，可在命令面板（⌘ / Ctrl K）中重新显示。`); });
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); grip.setPointerCapture(event.pointerId); box.classList.add('dragging');
      const start = { x: event.clientX, y: event.clientY, left: entry.position.x, top: entry.position.y };
      const drag = e => { const dx = e.clientX - start.x, dy = e.clientY - start.y; entry.position = { x: start.left + (right ? -dx : dx), y: start.top + (bottom ? -dy : dy) }; placeOverlay(entry); };
      const done = () => { grip.removeEventListener('pointermove', drag); grip.removeEventListener('pointerup', done); grip.removeEventListener('pointercancel', done); box.classList.remove('dragging'); placeOverlay(entry, true); };
      grip.addEventListener('pointermove', drag); grip.addEventListener('pointerup', done); grip.addEventListener('pointercancel', done);
    });
    grip.addEventListener('keydown', event => {
      const step = event.shiftKey ? 40 : 10;
      const delta = { ArrowLeft: [right ? step : -step, 0], ArrowRight: [right ? -step : step, 0], ArrowUp: [0, bottom ? step : -step], ArrowDown: [0, bottom ? -step : step] }[event.key];
      if (!delta) return;
      event.preventDefault(); entry.position = { x: entry.position.x + delta[0], y: entry.position.y + delta[1] }; placeOverlay(entry, true);
    });
    box.append(grip, close); $('#plugin-overlays').append(box); entry.overlay = box;
    if (!entry.overlayHidden) ensureFrame(entry, 'overlay');
    placeOverlay(entry);
  }
  function createPanel(entry) {
    const { plugin } = entry, title = plugin.contributes.panel.title || plugin.name;
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'view-tab plugin-tab'; tab.dataset.tab = `plugin:${plugin.id}`; tab.title = `${title} · ${plugin.name}`;
    const label = document.createElement('span'); label.className = 'plugin-tab-label'; label.textContent = title;
    tab.append(glyph(plugin), label); $('.view-tabs').append(tab);
    const view = document.createElement('section'); view.className = 'plugin-view'; view.dataset.pluginView = plugin.id; view.hidden = true; view.setAttribute('aria-label', title);
    $('.conversation-pane').append(view);
    entry.tab = tab; entry.view = view;
  }
  function createWidget(entry) {
    const { plugin } = entry, spec = plugin.contributes.widget;
    const card = document.createElement('article'); card.className = `monitor-card plugin-widget${spec.size === 'wide' ? ' wide' : ''}`; card.dataset.plugin = plugin.id;
    const heading = document.createElement('div'); heading.className = 'card-heading';
    const titles = document.createElement('div');
    const kicker = document.createElement('span'); kicker.className = 'card-kicker'; kicker.textContent = 'PLUGIN';
    const h3 = document.createElement('h3'); h3.textContent = spec.title || plugin.name;
    titles.append(kicker, h3); heading.append(titles, glyph(plugin));
    const body = document.createElement('div'); body.className = 'plugin-widget-body';
    card.append(heading, body); $('#plugin-widgets').append(card); entry.widget = card;
    if (monitorShown) ensureFrame(entry, 'widget');
  }
  function mount(plugin, signature) {
    const entry = { plugin, signature, frames: new Map(), status: null, last: {} }, c = plugin.contributes;
    mounted.set(plugin.id, entry);
    if (c.panel) createPanel(entry);
    if (c.widget) createWidget(entry);
    if (c.overlay) createOverlay(entry);
    if (c.background) ensureFrame(entry, 'background');
  }
  function unmount(id, { keepView = false } = {}) {
    const entry = mounted.get(id); if (!entry) return;
    for (const surface of [...entry.frames.keys()]) dropFrame(entry, surface);
    for (const el of [entry.tab, entry.view, entry.widget, entry.overlay, entry.status]) el?.remove();
    mounted.delete(id);
    const store = stores.get(id); if (store?.timer) writeStore(id, store); stores.delete(id);
    if (!keepView && ctx.currentView() === `plugin:${id}`) ctx.switchView('chat');
  }
  function settle() {
    $('#plugin-widgets').hidden = ![...mounted.values()].some(entry => entry.widget);
    const view = ctx.currentView();
    if (view.startsWith('plugin:')) ctx.switchView(mounted.get(view.slice(7))?.view ? view : 'chat');
    refreshVisibility(); ctx.onChange?.();
  }
  function sync() {
    const active = ctx.safe || !data || data.safeMode ? [] : data.plugins.filter(p => p.active);
    for (const id of [...mounted.keys()]) if (!active.some(p => p.id === id)) unmount(id, { keepView: true });
    for (const plugin of active) {
      const signature = JSON.stringify([plugin.version, plugin.permissions, plugin.contributes, plugin.installedAt, plugin.source]);
      const current = mounted.get(plugin.id);
      if (current?.signature === signature) { current.plugin = plugin; continue; }
      if (current) unmount(plugin.id, { keepView: true });
      mount(plugin, signature);
    }
    settle();
  }
  function runCommand(entry, command) {
    if (command.action === 'open-panel') { openPanel(entry.plugin.id); return; }
    const message = { event: 'command', data: { id: command.id } }, c = entry.plugin.contributes;
    // A command for a plugin whose frames are not loaded yet opens its surface; the event waits for the handshake.
    if (!entry.frames.size) {
      if (c.panel) openPanel(entry.plugin.id);
      else if (c.overlay) setOverlayHidden(entry, false);
      else if (c.widget) ctx.switchView('monitor');
    }
    for (const frame of entry.frames.values()) { if (frame.port) frame.port.postMessage(message); else frame.backlog.push(message); }
  }
  document.addEventListener('visibilitychange', refreshVisibility);
  window.addEventListener('resize', () => { for (const entry of mounted.values()) if (entry.overlay && !entry.overlayHidden) placeOverlay(entry); }, { passive: true });

  return {
    get data() { return data; },
    get mounted() { return [...mounted.values()].map(entry => entry.plugin); },
    async load() { return this.apply(await ctx.api('/api/plugins')); },
    apply(next) { data = next; ctx.onCatalog?.(data); sync(); return data; },
    reload(id) {
      const entry = mounted.get(id); if (!entry) return false;
      unmount(id, { keepView: true }); mount(entry.plugin, entry.signature); settle();
      return true;
    },
    // Saves pending plugin data now, e.g. before logging out.
    flush() { return Promise.all([...stores].filter(([, store]) => store.timer).map(([id, store]) => writeStore(id, store))); },
    unload() { flushStores(); for (const id of [...mounted.keys()]) unmount(id); data = null; stats = null; ctx.onChange?.(); },
    hasView(view) { return typeof view === 'string' && view.startsWith('plugin:') && Boolean(mounted.get(view.slice(7))?.view); },
    setView(view) {
      for (const entry of mounted.values()) {
        if (!entry.view) continue;
        const selected = view === `plugin:${entry.plugin.id}`;
        entry.view.hidden = !selected;
        if (selected) ensureFrame(entry, 'panel');
      }
      refreshVisibility();
    },
    setMonitorVisible(shown) { monitorShown = shown; if (shown) for (const entry of mounted.values()) if (entry.widget) ensureFrame(entry, 'widget'); refreshVisibility(); },
    themeChanged() { const message = { event: 'theme', data: themePayload() }; for (const entry of mounted.values()) for (const frame of entry.frames.values()) post(frame, message); },
    // Hooks the page calls as things happen; each reaches only plugins holding the matching permission.
    usage() { emit('usage', usagePayload()); },
    system() { emit('system', systemPayload()); },
    session(summary) { if (summary?.id) { stats = null; emit('session', summaryOf(summary)); } },
    activeChanged() { emit('session:active', activePayload()); },
    metrics() {
      if (metricsTimer) return;
      metricsTimer = setTimeout(() => { metricsTimer = null; const active = activePayload(); if (active) emit('metrics', { sessionId: active.id, metrics: active.metrics }); }, 800);
    },
    activity(event) { emit('activity', { ...event, at: new Date().toISOString() }); },
    commands() {
      const list = [];
      for (const entry of mounted.values()) {
        const { plugin } = entry, c = plugin.contributes;
        for (const command of c.commands) list.push({ id: `plugin:${plugin.id}:${command.id}`, title: command.title, subtitle: command.subtitle || `${plugin.name} · 插件命令`, icon: command.icon || 'puzzle', run: () => runCommand(entry, command) });
        if (c.panel && !c.commands.some(command => command.action === 'open-panel')) list.push({ id: `plugin:${plugin.id}:open`, title: `打开「${c.panel.title || plugin.name}」`, subtitle: `${plugin.name} · 插件面板`, icon: 'puzzle', run: () => openPanel(plugin.id) });
        if (c.overlay) list.push({ id: `plugin:${plugin.id}:overlay`, title: `${entry.overlayHidden ? '显示' : '隐藏'}「${plugin.name}」`, subtitle: '悬浮窗插件', icon: 'puzzle', run: () => setOverlayHidden(entry, !entry.overlayHidden) });
      }
      return list;
    },
  };
}
