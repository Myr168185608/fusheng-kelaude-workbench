// 运维脉搏 · a monitor-page card: live CPU and memory traces, load, disk and uptime, clocks for the time zones
// you work across, and read-only check-up prompts that drop into the message box for you to review and send.
(() => {
  'use strict';
  const wb = window.workbench, { h, svg, format } = wb;
  const MINUTE = 60000, SPAN = 30 * MINUTE, GAP = 45000, SAVE_EVERY = 2 * MINUTE;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const round = value => finite(value) ? Math.round(value * 10) / 10 : null;
  const pad = n => String(n).padStart(2, '0');
  const ZONES = { 'Asia/Shanghai': '北京', 'Asia/Hong_Kong': '香港', 'Asia/Taipei': '台北', 'Asia/Tokyo': '东京', 'Asia/Seoul': '首尔', 'Asia/Singapore': '新加坡', 'Europe/London': '伦敦', 'Europe/Berlin': '柏林', 'Europe/Paris': '巴黎', 'America/New_York': '纽约', 'America/Los_Angeles': '洛杉矶', 'Australia/Sydney': '悉尼' };
  const CYCLE = ['Asia/Shanghai', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney'];
  const PROMPTS = [
    { icon: '💽', title: '磁盘体检', desc: '分区使用率与大目录', text: '帮我检查这台服务器的磁盘占用：列出各分区的使用率，找出 /var、/home、/opt 下占用最大的目录和文件，并给出可以安全清理的建议。先只读检查，不要删除任何东西。' },
    { icon: '🧯', title: '失败的服务', desc: 'systemd 失败与反复重启', text: '列出这台服务器上 systemd 中失败或反复重启的服务，查看它们最近的日志，分析原因并给出修复建议。先只读检查，不要改动配置。' },
    { icon: '🧠', title: '资源大户', desc: '内存与 CPU 占用前十', text: '找出当前占用内存和 CPU 最多的 10 个进程，判断是否有异常（内存泄漏、僵尸进程、异常的高负载），并给出处理建议。先只读检查。' },
    { icon: '🛡️', title: '安全巡检', desc: '登录记录、端口与更新', text: '对这台服务器做一次只读的安全巡检：最近的登录与失败登录记录、正在监听的端口与对应进程、待安装的安全更新，并按风险高低给出建议。不要改动任何东西。' },
    { icon: '🌐', title: '网络连通', desc: 'DNS、延迟与连接数', text: '检查这台服务器的网络状况：DNS 解析是否正常、到常用公网地址的连通性与延迟、当前的连接数统计，并指出异常。只读检查。' },
  ];
  const METRICS = [
    { index: 1, label: 'CPU', warn: 70, bad: 90, badText: '⚠ 繁忙' },
    { index: 2, label: '内存', warn: 75, bad: 90, badText: '⚠ 紧张' },
  ];
  const DISK = { warn: 80, bad: 90, badText: '⚠ 将满' };
  const level = (value, limits) => !finite(value) ? '' : value >= limits.bad ? 'bad' : value >= limits.warn ? 'warn' : 'ok';
  function chip(value, limits) {
    const state = level(value, limits);
    return state === 'bad' ? h('span', { class: 'wb-tag bad' }, limits.badText) : state === 'warn' ? h('span', { class: 'wb-tag warn' }, '偏高') : null;
  }
  const zoneName = zone => ZONES[zone] || (/^(Etc\/)?(UTC|GMT|UCT|Universal|Zulu)$/.test(zone) ? 'UTC' : zone.split('/').pop().replace(/_/g, ' '));
  function offset(zone, date) {
    try {
      const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(date).find(p => p.type === 'timeZoneName');
      return `UTC${part ? part.value.replace('GMT', '') : ''}`;
    } catch { return ''; }
  }

  /* ---------- Tooltip ---------- */
  let tip = null;
  function showTip(x, y, title, value) {
    if (!tip) { tip = h('div', { class: 'op-tip', role: 'tooltip' }); document.body.append(tip); }
    tip.replaceChildren(h('strong', null, value), h('span', null, title));
    tip.hidden = false;
    const width = tip.offsetWidth, height = tip.offsetHeight;
    tip.style.transform = `translate(${Math.round(Math.min(innerWidth - width - 6, Math.max(6, x - width / 2)))}px,${Math.round(Math.max(4, y - height - 10))}px)`;
  }
  const hideTip = () => { if (tip) tip.hidden = true; };

  // The trace is gray on a fixed 0–100% scale; only the newest reading is colored, and it turns amber or red
  // together with a text chip in the row above, so the state never rests on color alone.
  function trace(samples, metric, width) {
    const H = 44, top = 4, bottom = 3, right = 8, end = Date.now(), start = end - SPAN, base = H - bottom;
    const x = t => (width - right) * Math.min(1, Math.max(0, (t - start) / SPAN));
    const y = v => top + (base - top) * (1 - Math.min(100, Math.max(0, v)) / 100);
    const points = samples.filter(s => finite(s[metric.index]));
    const root = svg('svg', { class: 'op-trace', width, height: H, role: 'img', 'aria-label': `${metric.label}近 30 分钟走势（0–100%）` });
    root.append(svg('line', { class: 'grid', x1: 0, x2: width - right, y1: top + 0.5, y2: top + 0.5 }), svg('line', { class: 'base', x1: 0, x2: width - right, y1: base + 0.5, y2: base + 0.5 }));
    const runs = [];
    points.forEach((p, i) => { if (i && p[0] - points[i - 1][0] <= GAP) runs[runs.length - 1].push(p); else runs.push([p]); });
    for (const run of runs) {
      const line = run.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[metric.index]).toFixed(1)}`).join('');
      if (run.length > 1) root.append(svg('path', { class: 'area', d: `${line}L${x(run[run.length - 1][0]).toFixed(1)},${base}L${x(run[0][0]).toFixed(1)},${base}Z` }));
      root.append(svg('path', { class: 'line', d: run.length > 1 ? line : `${line}h0.01` }));
    }
    const last = points[points.length - 1];
    if (last) {
      const state = level(last[metric.index], metric), cx = x(last[0]), cy = y(last[metric.index]);
      root.append(svg('circle', { class: `halo ${state}`, cx, cy, r: 4 }), svg('circle', { class: `dot ${state}`, cx, cy, r: 4 }));
    }
    if (points.length < 2) return root;
    const cross = svg('line', { class: 'cross', y1: top, y2: base, visibility: 'hidden' }), mark = svg('circle', { class: 'dot hover', r: 4, visibility: 'hidden' });
    const hit = svg('rect', { class: 'hit', x: 0, y: 0, width, height: H, tabindex: 0, 'aria-label': `${metric.label}走势：用左右方向键逐个查看采样` });
    let index = points.length - 1;
    const show = i => {
      index = Math.max(0, Math.min(points.length - 1, i));
      const p = points[index], px = x(p[0]), py = y(p[metric.index]), box = root.getBoundingClientRect(), t = new Date(p[0]);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      mark.setAttribute('cx', px); mark.setAttribute('cy', py); mark.setAttribute('visibility', 'visible');
      showTip(box.left + px, box.top + py, `${metric.label} · ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`, `${Math.round(p[metric.index])}%`);
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); mark.setAttribute('visibility', 'hidden'); hideTip(); };
    hit.addEventListener('pointermove', event => {
      const t = start + (event.clientX - root.getBoundingClientRect().left) / (width - right) * SPAN;
      let best = 0;
      points.forEach((p, i) => { if (Math.abs(p[0] - t) < Math.abs(points[best][0] - t)) best = i; });
      show(best);
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    hit.addEventListener('focus', () => show(points.length - 1));
    hit.addEventListener('keydown', event => {
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: points.length - 1 }[event.key];
      if (target !== undefined) { event.preventDefault(); show(target); }
    });
    root.append(cross, mark, hit);
    return root;
  }

  wb.ready().then(() => {
    let samples = [], system = null, zone = null, dirty = false, height = 0;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const localIsUtc = zoneName(local) === 'UTC';
    const third = () => zone || (local === 'Asia/Shanghai' ? 'America/Los_Angeles' : 'Asia/Shanghai');

    const metricViews = METRICS.map(metric => {
      const value = h('strong', { class: 'op-value' }, '—'), state = h('span', { class: 'op-state' }), note = h('small', { class: 'op-note' }), chart = h('div', { class: 'op-chart' });
      const el = h('div', { class: 'op-metric' }, h('div', { class: 'op-metric-head' }, h('span', { class: 'op-label' }, metric.label), value, state, note), chart);
      return { metric, el, value, state, note, chart, width: 0 };
    });
    const facts = h('dl', { class: 'op-facts' });
    const clocks = h('div', { class: 'op-clocks', role: 'group', 'aria-label': '时钟' });
    const quick = h('div', { class: 'op-quick' },
      h('div', { class: 'op-quick-head' }, h('h3', null, '运维速查'), h('small', null, '填入输入框，确认后再发送')),
      h('div', { class: 'op-prompts' }, PROMPTS.map(prompt => h('button', { class: 'op-prompt', type: 'button', title: prompt.text, onclick: () => wb.composer.insert(prompt.text).catch(() => {}) },
        h('span', { class: 'op-prompt-icon', 'aria-hidden': 'true' }, prompt.icon),
        h('span', { class: 'op-prompt-text' }, h('strong', null, prompt.title), h('small', null, prompt.desc))))));
    const root = h('div', { class: 'op' },
      h('section', { class: 'op-vitals', 'aria-label': '服务器脉搏' }, metricViews.map(view => view.el), h('small', { class: 'op-caption' }, '近 30 分钟 · 每 15 秒采样'), facts),
      clocks, quick);
    document.body.append(root);

    const fit = () => requestAnimationFrame(() => {
      const next = Math.ceil(root.getBoundingClientRect().height) + 4;
      if (Math.abs(next - height) > 2) { height = next; wb.ui.resize({ height }).catch(() => {}); }
    });
    function renderVitals() {
      const latest = samples[samples.length - 1];
      for (const view of metricViews) {
        const value = latest ? latest[view.metric.index] : null;
        view.value.textContent = finite(value) ? `${Math.round(value)}%` : '—';
        view.state.replaceChildren(chip(value, view.metric) || '');
        view.chart.replaceChildren(trace(samples, view.metric, view.width || view.chart.clientWidth || 280));
      }
      metricViews[0].note.textContent = system?.activeRuns ? `${system.activeRuns} 个任务运行中` : '';
      const memory = system?.memory;
      metricViews[1].note.textContent = memory && finite(memory.availableBytes) ? `可用 ${format.bytes(memory.availableBytes)} / ${format.bytes(memory.totalBytes)}` : '';
      const load = Array.isArray(system?.load) ? system.load.filter(finite) : [], disk = system?.disk || {};
      const fact = (label, value, extra) => h('div', null, h('dt', null, label), h('dd', null, h('span', null, value), extra || null));
      facts.replaceChildren(
        fact('负载 1/5/15', load.length ? load.map(v => v.toFixed(2)).join(' · ') : '—'),
        fact('磁盘', finite(disk.percent) ? `${Math.round(disk.percent)}% · 余 ${format.bytes(disk.availableBytes)}` : '—', chip(disk.percent, DISK)),
        fact('已运行', finite(system?.uptimeSeconds) ? format.duration(system.uptimeSeconds * 1000) : '—'));
      fit();
    }
    function renderClocks() {
      const now = new Date(), zones = [local, ...(localIsUtc ? [] : ['UTC']), third()];
      clocks.replaceChildren(...zones.map((tz, i) => {
        let time = '--:--', date = '';
        try {
          time = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
          const part = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(now).map(p => [p.type, p.value]));
          date = `${part.month}月${part.day}日 ${part.weekday}`;
        } catch {}
        const switcher = i === zones.length - 1, label = i === 0 ? `本地 · ${zoneName(tz)}` : zoneName(tz);
        const inner = [
          h('span', { class: 'op-clock-label' }, label, switcher ? h('span', { class: 'op-clock-switch', 'aria-hidden': 'true' }, '⇄') : null),
          h('strong', { class: 'op-clock-time' }, time),
          h('small', null, `${date} · ${offset(tz, now)}`),
        ];
        return switcher
          ? h('button', { class: 'op-clock', type: 'button', title: '点击切换时区', 'aria-label': `${label} ${time}，点击切换时区`, onclick: nextZone }, inner)
          : h('div', { class: 'op-clock' }, inner);
      }));
    }
    function nextZone() {
      const options = CYCLE.filter(tz => tz !== local);
      zone = options[(options.indexOf(third()) + 1) % options.length];
      renderClocks();
      clocks.lastElementChild?.focus();
      wb.storage.set('zone', zone).catch(() => {});
    }
    function addSample(next) {
      if (next) {
        system = next;
        const at = Date.parse(next.sampledAt);
        if (Number.isFinite(at) && !(samples.length && at <= samples[samples.length - 1][0])) {
          samples = [...samples.filter(s => at - s[0] < SPAN), [at, round(next.cpuPercent), round(next.memory?.percent)]];
          dirty = true;
        }
      }
      renderVitals();
    }
    const save = () => { if (dirty) { dirty = false; wb.storage.set('samples', samples).catch(() => { dirty = true; }); } };

    wb.on('system', addSample);
    wb.on('visibility', ({ visible }) => { if (visible) { renderVitals(); renderClocks(); } else save(); });
    const resize = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const view = metricViews.find(v => v.chart === entry.target), width = Math.floor(entry.contentRect.width);
        if (view && view.width !== width) { view.width = width; changed = true; }
      }
      if (changed) renderVitals();
    });
    for (const view of metricViews) resize.observe(view.chart);
    // The clocks show minutes, so redraw just after each minute turns over.
    const tick = () => { if (wb.info.visible) renderClocks(); setTimeout(tick, MINUTE - Date.now() % MINUTE + 40); };
    setTimeout(tick, MINUTE - Date.now() % MINUTE + 40);
    setInterval(save, SAVE_EVERY);

    Promise.all([wb.storage.get('samples').catch(() => null), wb.storage.get('zone').catch(() => null)]).then(([saved, savedZone]) => {
      if (typeof savedZone === 'string' && CYCLE.includes(savedZone) && savedZone !== local) zone = savedZone;
      if (Array.isArray(saved)) samples = saved.filter(s => Array.isArray(s) && finite(s[0]) && Date.now() - s[0] < SPAN).sort((a, b) => a[0] - b[0]);
      renderClocks();
      return wb.system.get();
    }).then(addSample, () => renderVitals());
  });
})();
