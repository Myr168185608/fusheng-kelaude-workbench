// 番茄专注 · A Pomodoro timer. The background frame owns the clock: it keeps the status bar ticking, ends each
// phase and shows the reminder. The panel draws the same state and changes it through plugin storage, so the
// two frames stay in step without talking to each other directly.
(() => {
  'use strict';
  const wb = window.workbench, { h, svg } = wb;
  const MINUTE = 60000;
  const OPTIONS = { focus: [25, 45, 50], short: [5, 10], long: [15, 20, 30] };
  const DEFAULTS = { focus: 25, short: 5, long: 15, every: 4 };
  const PHASES = { focus: { label: '专注', icon: '🍅' }, short: { label: '短休息', icon: '☕' }, long: { label: '长休息', icon: '🌿' } };
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = n => String(n).padStart(2, '0');
  const clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
  const dayKey = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const daysBack = count => Array.from({ length: count }, (_, i) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - (count - 1 - i)); return d; });

  /* ---------- Shared state: { phase, status: idle|running|paused, endsAt, remaining, round } ---------- */
  const lengthOf = (phase, settings) => settings[phase] * MINUTE;
  const fresh = settings => ({ phase: 'focus', status: 'idle', endsAt: null, remaining: lengthOf('focus', settings), round: 0 });
  const timeLeft = (state, now = Date.now()) => state.status === 'running' ? Math.max(0, state.endsAt - now) : state.remaining;
  function readSettings(raw) {
    const out = { ...DEFAULTS };
    if (raw && typeof raw === 'object') for (const key of Object.keys(OPTIONS)) if (OPTIONS[key].includes(raw[key])) out[key] = raw[key];
    return out;
  }
  function readState(raw, settings) {
    if (!raw || typeof raw !== 'object' || !PHASES[raw.phase] || !['idle', 'running', 'paused'].includes(raw.status)) return fresh(settings);
    const state = {
      phase: raw.phase, status: raw.status, endsAt: Number.isFinite(raw.endsAt) ? raw.endsAt : null,
      remaining: Number.isFinite(raw.remaining) ? Math.max(0, raw.remaining) : lengthOf(raw.phase, settings), round: Number.isInteger(raw.round) ? raw.round : 0,
    };
    return state.status === 'running' && !state.endsAt ? fresh(settings) : state;
  }
  function readLog(raw) {
    const out = {};
    if (raw && typeof raw === 'object') for (const [key, value] of Object.entries(raw)) if (/^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isInteger(value) && value > 0) out[key] = value;
    return out;
  }
  // Ends the current phase. A finished focus counts toward today and its break starts right away;
  // after a break the timer waits for you to start the next tomato.
  function advance(state, settings, now, finished) {
    if (state.phase !== 'focus') return { state: { ...fresh(settings), round: state.round }, counted: false };
    const round = finished ? state.round + 1 : state.round, phase = finished && round % settings.every === 0 ? 'long' : 'short';
    return { state: { phase, status: finished ? 'running' : 'idle', endsAt: finished ? now + lengthOf(phase, settings) : null, remaining: lengthOf(phase, settings), round }, counted: finished };
  }
  const ACTIONS = {
    toggle: (state, settings, now) => state.status === 'running'
      ? { ...state, status: 'paused', endsAt: null, remaining: timeLeft(state, now) }
      : { ...state, status: 'running', endsAt: now + timeLeft(state, now) },
    reset: (state, settings) => ({ ...state, status: 'idle', endsAt: null, remaining: lengthOf(state.phase, settings) }),
    // Skipping moves on without counting the tomato.
    skip: (state, settings, now) => advance(state, settings, now, false).state,
  };
  async function load() {
    const [rawSettings, rawState, rawLog] = await Promise.all(['settings', 'state', 'log'].map(key => wb.storage.get(key).catch(() => null)));
    const settings = readSettings(rawSettings);
    return { settings, state: readState(rawState, settings), log: readLog(rawLog) };
  }

  /* ---------- Background: the clock, the status bar and the reminders ---------- */
  async function background() {
    let { settings, state, log } = await load(), shown = '';
    const saveState = () => wb.storage.set('state', state).catch(() => {});
    function status() {
      const today = log[dayKey()] || 0, phase = PHASES[state.phase];
      let next = null;
      // The workbench already puts the plugin icon (🍅) in front of the text.
      if (state.status === 'running') next = { text: state.phase === 'focus' ? clock(timeLeft(state)) : `${phase.icon} ${clock(timeLeft(state))}`, title: `${phase.label}中 · 点击打开番茄专注` };
      else if (state.status === 'paused') next = { text: `⏸ ${clock(state.remaining)}`, title: `${phase.label}已暂停 · 点击打开番茄专注` };
      else if (today) next = { text: `今日 ×${today}`, title: `今天完成了 ${today} 个番茄` };
      const key = JSON.stringify(next);
      if (key !== shown) { shown = key; wb.ui.setStatus(next).catch(() => {}); }
    }
    function tick() {
      const now = Date.now();
      if (state.status === 'running' && now >= state.endsAt) {
        const finishedFocus = state.phase === 'focus', late = now - state.endsAt > MINUTE;
        const result = advance(state, settings, now, true);
        // A timer that ran out while no workbench page was open still counts, but its break is not started late.
        state = late && finishedFocus ? { ...fresh(settings), round: result.state.round } : result.state;
        if (result.counted) {
          const key = dayKey();
          log = Object.fromEntries(Object.entries({ ...log, [key]: (log[key] || 0) + 1 }).sort().slice(-60));
          wb.storage.set('log', log).catch(() => {});
        }
        saveState();
        if (!late) wb.ui.toast(finishedFocus ? `专注完成，今天第 ${log[dayKey()]} 个番茄 🍅 休息 ${settings[state.phase]} 分钟吧。` : '休息结束，准备好了就开始下一个番茄。').catch(() => {});
      }
      status();
    }
    wb.on('command', ({ id }) => {
      if (id !== 'toggle') return;
      state = ACTIONS.toggle(state, settings, Date.now());
      saveState(); status();
      wb.ui.toast(state.status === 'running' ? `开始${PHASES[state.phase].label}，${clock(timeLeft(state))} 后提醒你。` : '已暂停，再次运行命令即可继续。').catch(() => {});
    });
    wb.on('statusbar:click', () => wb.ui.openPanel().catch(() => {}));
    wb.on('storage:change', ({ key, value }) => {
      if (key === 'settings') settings = readSettings(value);
      else if (key === 'state') state = readState(value, settings);
      else if (key === 'log') log = readLog(value);
      status();
    });
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- Panel ---------- */
  let tip = null;
  function showTip(box, title, value) {
    if (!tip) { tip = h('div', { class: 'ft-tip', role: 'tooltip' }); document.body.append(tip); }
    tip.replaceChildren(h('small', null, title), h('strong', null, value));
    tip.hidden = false;
    const x = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2));
    tip.style.transform = `translate(${Math.round(x)}px,${Math.round(Math.max(8, box.top - tip.offsetHeight - 8))}px)`;
  }
  const hideTip = () => { if (tip) tip.hidden = true; };
  // Completed tomatoes per day: one series, so one color; only the best day and today carry a number.
  function historyChart(log, width) {
    const days = daysBack(14).map(date => ({ date, value: log[dayKey(date)] || 0 }));
    const H = 176, top = 20, bottom = 26, left = 28, right = 4, plotW = Math.max(220, width - left - right), plotH = H - top - bottom;
    const peak = Math.max(...days.map(d => d.value)), step = peak <= 4 ? 1 : peak <= 10 ? 2 : 5, max = Math.max(4, Math.ceil(peak / step) * step);
    const y = v => top + plotH * (1 - v / max), band = plotW / days.length, barW = Math.min(26, band * 0.56), crisp = v => Math.round(v) + 0.5;
    const root = svg('svg', { class: 'ft-chart', width: left + plotW + right, height: H, role: 'group', 'aria-label': '近 14 天每天完成的番茄数' });
    for (let v = 0; v <= max; v += step) root.append(svg('line', { class: v ? 'grid' : 'base', x1: left, x2: left + plotW, y1: crisp(y(v)), y2: crisp(y(v)) }), svg('text', { class: 'tick', x: left - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, String(v)));
    const last = days.length - 1, best = days.findIndex(d => d.value === peak && peak > 0);
    days.forEach((day, i) => {
      const cx = left + band * i + band / 2, x = cx - barW / 2, label = `${day.date.getMonth() + 1}月${day.date.getDate()}日 周${WEEKDAYS[day.date.getDay()]}`;
      if ((last - i) % 2 === 0) root.append(svg('text', { class: `tick${i === last ? ' strong' : ''}`, x: cx, y: H - 8, 'text-anchor': 'middle' }, i === last ? '今天' : `${day.date.getMonth() + 1}/${day.date.getDate()}`));
      const r = Math.min(4, barW / 2), top0 = y(day.value), base = y(0);
      const mark = day.value
        ? svg('path', { class: 'bar', d: `M${x},${base}V${top0 + r}Q${x},${top0} ${x + r},${top0}H${x + barW - r}Q${x + barW},${top0} ${x + barW},${top0 + r}V${base}Z` })
        : svg('rect', { class: 'stub', x, y: base - 2, width: barW, height: 2, rx: 1 });
      root.append(mark);
      if (day.value && (i === last || (i === best && last - i > 1))) root.append(svg('text', { class: 'value', x: cx, y: top0 - 6, 'text-anchor': 'middle' }, String(day.value)));
      const hit = svg('rect', { class: 'hit', x: left + band * i, y: top, width: band, height: plotH, tabindex: 0, 'aria-label': `${label}：${day.value} 个番茄` });
      const enter = () => { root.classList.add('hovering'); mark.classList.add('active'); showTip(mark.getBoundingClientRect(), label, `${day.value} 个番茄`); };
      const leave = () => { root.classList.remove('hovering'); mark.classList.remove('active'); hideTip(); };
      hit.addEventListener('pointerenter', enter); hit.addEventListener('pointerleave', leave); hit.addEventListener('focus', enter); hit.addEventListener('blur', leave);
      root.append(hit);
    });
    return root;
  }

  async function panel() {
    let { settings, state, log } = await load();
    const R = 92, C = 2 * Math.PI * R;
    const arc = svg('circle', { class: 'ft-arc', cx: 110, cy: 110, r: R, 'stroke-dasharray': C.toFixed(2), transform: 'rotate(-90 110 110)' });
    const time = h('strong', { class: 'ft-time' }), phaseLabel = h('span', { class: 'ft-phase' });
    const primary = h('button', { class: 'wb-btn primary', type: 'button', onclick: () => apply('toggle') });
    const skip = h('button', { class: 'wb-btn', type: 'button', onclick: () => apply('skip') }, '跳过');
    const reset = h('button', { class: 'wb-btn ghost', type: 'button', onclick: () => apply('reset') }, '重置');
    const hint = h('p', { class: 'ft-hint' });
    const todayCount = h('strong', { class: 'ft-count' }), todayNote = h('small'), dots = h('div', { class: 'ft-dots', 'aria-hidden': 'true' });
    const weekNote = h('p', { class: 'ft-week' });
    const segments = {};
    const settingRow = (key, label) => {
      const group = h('div', { class: 'wb-segment', role: 'group', 'aria-label': label }, OPTIONS[key].map(value => h('button', { type: 'button', 'aria-pressed': 'false', dataset: { value }, onclick: () => choose(key, value) }, `${value} 分钟`)));
      segments[key] = group;
      return h('div', { class: 'ft-setting' }, h('span', null, label), group);
    };
    const chartBox = h('div', { class: 'ft-chart-box' });
    document.body.append(h('div', { class: 'ft' },
      h('header', { class: 'ft-head' }, h('span', { class: 'wb-eyebrow' }, 'Focus'), h('h1', null, '番茄专注'), h('p', { class: 'wb-muted' }, '专注一段，休息一下；每完成 4 个番茄来一次长休息。计时在后台进行，切到别的页面也不会停。')),
      h('div', { class: 'ft-main' },
        h('section', { class: 'wb-card ft-timer', 'aria-label': '计时器' },
          h('div', { class: 'ft-dial' }, svg('svg', { class: 'ft-ring', viewBox: '0 0 220 220', 'aria-hidden': 'true' }, svg('circle', { class: 'ft-track', cx: 110, cy: 110, r: R }), arc),
            h('div', { class: 'ft-readout', role: 'timer', 'aria-live': 'off' }, phaseLabel, time)),
          h('div', { class: 'ft-controls' }, primary, skip, reset), hint),
        h('div', { class: 'ft-side' },
          h('section', { class: 'wb-card ft-today', 'aria-label': '今天' }, h('span', { class: 'ft-label' }, '今天'), h('div', { class: 'ft-today-row' }, todayCount, todayNote), dots, weekNote),
          h('section', { class: 'wb-card ft-settings', 'aria-label': '时长设置' }, h('span', { class: 'ft-label' }, '时长'), settingRow('focus', '专注'), settingRow('short', '短休息'), settingRow('long', '长休息')))),
      h('section', { class: 'wb-card ft-history', 'aria-label': '专注记录' }, h('div', { class: 'ft-history-head' }, h('h3', null, '近 14 天'), h('small', { class: 'wb-faint' }, '每天完成的番茄数 · 跳过的不计入')), chartBox)));

    function apply(name) { state = ACTIONS[name](state, settings, Date.now()); wb.storage.set('state', state).catch(() => {}); render(); }
    function choose(key, value) {
      settings = { ...settings, [key]: value };
      wb.storage.set('settings', settings).catch(() => {});
      if (state.status === 'idle' && state.phase === key) apply('reset'); else render();
    }
    function renderTimer() {
      const phase = PHASES[state.phase], left = timeLeft(state), total = lengthOf(state.phase, settings), share = Math.max(0, Math.min(1, left / total));
      arc.setAttribute('stroke-dashoffset', (C * (1 - share)).toFixed(2));
      arc.classList.toggle('empty', share < 0.004);
      document.documentElement.dataset.phase = state.phase === 'focus' ? 'focus' : 'break';
      time.textContent = clock(left);
      phaseLabel.textContent = state.status === 'running' ? `${phase.icon} ${phase.label}中` : state.status === 'paused' ? `⏸ ${phase.label}已暂停` : `${phase.icon} 准备${phase.label}`;
      primary.textContent = state.status === 'running' ? '暂停' : state.status === 'paused' ? '继续' : `开始${phase.label}`;
      const untilLong = settings.every - (state.round % settings.every);
      hint.textContent = state.phase === 'focus' ? `再完成 ${untilLong} 个番茄就是一次 ${settings.long} 分钟的长休息 · 空格键开始或暂停` : `休息好了可以「跳过」直接进入下一个番茄 · 空格键开始或暂停`;
    }
    function render() {
      renderTimer();
      const today = log[dayKey()] || 0, week = daysBack(7).reduce((sum, d) => sum + (log[dayKey(d)] || 0), 0);
      todayCount.textContent = String(today);
      todayNote.textContent = today ? `个番茄 · 约 ${Math.round(today * settings.focus / 6) / 10} 小时专注` : '个番茄 · 开始今天的第一个吧';
      dots.replaceChildren(...Array.from({ length: Math.max(8, today) }, (_, i) => h('i', { class: i < today ? 'done' : '' })));
      weekNote.textContent = `近 7 天共 ${week} 个`;
      for (const [key, group] of Object.entries(segments)) for (const button of group.children) button.setAttribute('aria-pressed', String(Number(button.dataset.value) === settings[key]));
      chartBox.replaceChildren(historyChart(log, chartBox.clientWidth || 640));
    }
    wb.on('storage:change', ({ key, value }) => {
      if (key === 'settings') settings = readSettings(value);
      else if (key === 'state') state = readState(value, settings);
      else if (key === 'log') log = readLog(value);
      render();
    });
    wb.on('visibility', ({ visible }) => { if (visible) render(); });
    document.addEventListener('keydown', event => {
      if (event.code !== 'Space' || event.repeat || event.target.closest('button, [tabindex]')) return;
      event.preventDefault(); apply('toggle');
    });
    let width = 0;
    new ResizeObserver(() => { const next = Math.floor(chartBox.clientWidth); if (next !== width) { width = next; render(); } }).observe(chartBox);
    setInterval(() => { if (wb.info.visible) renderTimer(); }, 1000);
    render();
  }

  wb.ready().then(info => ({ background, panel })[info.surface]?.());
})();
