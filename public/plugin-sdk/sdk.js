/* 浮生氪劳德工作台 · 插件 SDK v1
 * Loaded into every plugin frame before the plugin's own script. Exposes window.workbench.
 * The frame is sandboxed (opaque origin, no cookies, no network): everything goes through a private
 * MessageChannel that the workbench page hands over once, and every call is checked against the
 * permissions the user granted. Docs: https://github.com/qiuxinyuan321/fusheng-kelaude-workbench/blob/main/docs/PLUGINS.md
 */
(function () {
  'use strict';
  if (window.workbench) return;
  var listeners = new Map(), pending = new Map(), queue = [], nextId = 1, port = null, info = null, readyResolve;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });
  var root = document.documentElement;

  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    var tokens = theme.tokens || {};
    for (var name in tokens) if (/^[a-z0-9-]{1,24}$/.test(name) && typeof tokens[name] === 'string') root.style.setProperty('--wb-' + name, tokens[name]);
    var scheme = theme.scheme === 'dark' ? 'dark' : 'light';
    root.style.colorScheme = scheme; root.dataset.scheme = scheme; root.dataset.theme = String(theme.id || '');
  }
  function emit(event, data) {
    var set = listeners.get(event); if (!set) return;
    set.forEach(function (fn) { try { fn(data); } catch (error) { console.error('[workbench] ' + event + ' listener failed', error); } });
  }
  function send(message) { if (port) port.postMessage(message); else queue.push(message); }
  function onMessage(event) {
    var data = event.data || {};
    if (typeof data.id === 'number' && pending.has(data.id)) {
      var waiter = pending.get(data.id); pending.delete(data.id);
      if (data.error) waiter.reject(Object.assign(new Error(String(data.error.message || '调用失败')), { code: data.error.code || null })); else waiter.resolve(data.result);
      return;
    }
    if (typeof data.event !== 'string') return;
    if (data.event === 'theme') { info.theme = data.data; applyTheme(data.data); }
    if (data.event === 'visibility' && info) info.visible = Boolean(data.data && data.data.visible);
    emit(data.event, data.data);
  }
  window.addEventListener('message', function (event) {
    // Only the workbench page (our parent) can hand over the channel, and only once per document.
    if (port || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'workbench:init' || data.protocol !== 1 || !event.ports || !event.ports[0]) return;
    port = event.ports[0]; port.onmessage = onMessage;
    info = { plugin: data.plugin, surface: data.surface, permissions: data.permissions || [], theme: data.theme, locale: data.locale || 'zh-CN', visible: data.visible !== false, workbench: data.workbench || {} };
    root.dataset.surface = String(data.surface || '');
    applyTheme(data.theme);
    queue.splice(0).forEach(function (message) { port.postMessage(message); });
    readyResolve(info);
  });

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      send({ id: id, method: String(method), params: params === undefined ? null : params });
    });
  }
  function on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('workbench.on 需要一个回调函数');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return function () { off(event, fn); };
  }
  function off(event, fn) { var set = listeners.get(event); if (set) set.delete(fn); }

  // A tiny element helper so plugins can build UI without innerHTML: h('div', { class: 'wb-card' }, 'text', child).
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) for (var key in props) {
      var value = props[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'text') el.textContent = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  var svgNs = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var el = document.createElementNS(svgNs, tag);
    if (attrs) for (var key in attrs) if (attrs[key] !== null && attrs[key] !== undefined) el.setAttribute(key, attrs[key]);
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.append(arguments[i]);
    return el;
  }

  var finite = function (v) { return typeof v === 'number' && isFinite(v); };
  var nf = new Intl.NumberFormat('zh-CN');
  var format = {
    number: function (v) { return finite(v) ? nf.format(v) : '—'; },
    compact: function (v) { return !finite(v) ? '—' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(Math.abs(v) >= 1e7 ? 1 : 2) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + 'k' : String(Math.round(v)); },
    percent: function (v, digits) { return finite(v) ? v.toFixed(digits === undefined ? 0 : digits) + '%' : '—'; },
    money: function (v) { return finite(v) ? '$' + v.toFixed(Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 2 : 3) : '—'; },
    bytes: function (v) { return !finite(v) ? '—' : v >= 1073741824 ? (v / 1073741824).toFixed(1) + ' GB' : v >= 1048576 ? (v / 1048576).toFixed(1) + ' MB' : v >= 1024 ? Math.round(v / 1024) + ' KB' : v + ' B'; },
    duration: function (ms) { if (!finite(ms)) return '—'; var s = Math.max(0, Math.floor(ms / 1000)); if (s < 60) return s + ' 秒'; if (s < 3600) return Math.floor(s / 60) + ' 分钟'; if (s < 86400) return Math.floor(s / 3600) + ' 小时 ' + Math.floor(s % 3600 / 60) + ' 分'; return Math.floor(s / 86400) + ' 天 ' + Math.floor(s % 86400 / 3600) + ' 小时'; },
    time: function (value, zone) { var t = new Date(value); return isNaN(t) ? '' : t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: zone || 'Asia/Shanghai' }); },
    relative: function (value) { var t = new Date(value).getTime(); if (!isFinite(t)) return ''; var d = Date.now() - t; if (d < 60000) return '刚刚'; if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'; if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前'; return Math.floor(d / 86400000) + ' 天前'; },
  };

  var api = {
    version: 1,
    get info() { return info; },
    ready: function (fn) { return readyPromise.then(function (value) { if (typeof fn === 'function') fn(value); return value; }); },
    on: on, off: off, call: call, h: h, svg: svg, format: format,
    can: function (permission) { return Boolean(info && info.permissions.indexOf(permission) >= 0); },
    ui: {
      toast: function (text) { return call('ui.toast', { text: String(text) }); },
      setStatus: function (status) { return call('ui.setStatus', status === null || status === undefined ? null : typeof status === 'object' ? status : { text: String(status) }); },
      setSidebar: function (state) { return call('ui.setSidebar', state === null || state === undefined ? null : typeof state === 'object' ? state : { subtitle: String(state) }); },
      openPanel: function () { return call('ui.openPanel'); },
      resize: function (size) { return call('ui.resize', size); },
      hide: function () { return call('ui.hide'); },
    },
    storage: {
      get: function (key) { return call('storage.get', { key: key }); },
      set: function (key, value) { return call('storage.set', { key: key, value: value }); },
      remove: function (key) { return call('storage.remove', { key: key }); },
      keys: function () { return call('storage.keys'); },
    },
    backend: { call: function (method, params) { return call('backend.call', { method: method, params: params || {} }); } },
    usage: { get: function () { return call('usage.get'); } },
    system: { get: function () { return call('system.get'); } },
    sessions: {
      list: function () { return call('sessions.list'); },
      get: function (id) { return call('sessions.get', { id: id }); },
      active: function () { return call('sessions.active'); },
      open: function (id) { return call('sessions.open', { id: id }); },
    },
    composer: {
      insert: function (text) { return call('composer.insert', { text: String(text) }); },
      setPicker: function (picker) { return call('composer.setPicker', picker === undefined ? null : picker); },
      reply: function (requestId, result) { return call('composer.reply', Object.assign({}, result || {}, { requestId: String(requestId) })); },
    },
    theme: {
      get: function () { return info ? info.theme : null; },
      token: function (name) { return getComputedStyle(root).getPropertyValue('--wb-' + name).trim(); },
    },
  };
  window.workbench = Object.freeze(api);
})();
