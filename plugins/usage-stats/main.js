// 用量统计 · 浮生氪劳德工作台的内置插件，也是一份完整的插件示例。
// One script serves three surfaces: the panel draws the dashboard, the monitor widget a compact summary, and the
// background frame keeps the status-bar figure and a 24-hour quota history current. Every number is computed
// here from what the workbench hands over; nothing leaves your server.
(() => {
  'use strict';
  const wb = window.workbench, { h, svg, format } = wb;
  const DAYS = 14, MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  const TREND_KEY = 'trend', TREND_LIMIT = 288, TREND_GAP = 5 * MINUTE, TREND_BREAK = 2 * HOUR;

  /* ---------- Numbers ---------- */
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const num = value => finite(value) ? value : 0;
  const costOf = m => num(m?.costUsd);
  const tokensOf = m => num(m?.inputTokens) + num(m?.outputTokens);
  const cacheOf = m => num(m?.cacheReadTokens) + num(m?.cacheWriteTokens);
  const money = v => !finite(v) ? '—' : v === 0 ? '$0' : v < 0.01 ? '<$0.01' : `$${v.toLocaleString('en-US', { minimumFractionDigits: v >= 100 ? 0 : 2, maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
  const moneyTick = v => `$${v >= 10 || Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : String(+v.toFixed(4))}`;
  const countTick = v => v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(Math.round(v));
  const percent = v => finite(v) ? `${Math.round(v)}%` : '—';
  const MEASURES = {
    cost: { key: 'cost', label: '费用', of: costOf, text: money, tick: moneyTick },
    tokens: { key: 'tokens', label: 'Token', of: tokensOf, text: v => format.compact(v), tick: countTick },
  };
  const pad = n => String(n).padStart(2, '0');
  const dayKey = time => { const d = new Date(time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayLabel = date => `${date.getMonth() + 1}月${date.getDate()}日 周${'日一二三四五六'[date.getDay()]}`;
  const clock = time => { const d = new Date(time); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const FAMILIES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
  const modelName = id => { const m = /opus|sonnet|haiku|fable/i.exec(id || ''); return m ? FAMILIES[m[0].toLowerCase()] : id ? String(id).slice(0, 24) : '默认模型'; };
  function until(iso, verb) {
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms < MINUTE) return `即将${verb}`;
    const minutes = Math.floor(ms / MINUTE), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return days ? `${days} 天 ${hours % 24} 小时后${verb}` : hours ? `${hours} 小时 ${minutes % 60} 分后${verb}` : `${minutes} 分钟后${verb}`;
  }
  function change(now, before) {
    if (!(before > 0)) return null;
    const pct = (now - before) / before * 100, size = Math.abs(pct);
    return `${pct >= 0.5 ? '↑' : pct <= -0.5 ? '↓' : '→'} ${size >= 10 ? Math.round(size) : size.toFixed(1)}%`;
  }
  // Clean axis steps: 1, 2 or 5 times a power of ten, so every tick label is exact.
  function niceScale(max, count = 4) {
    if (!(max > 0)) return { max: 1, step: 0.2 };
    const raw = max / count, magnitude = 10 ** Math.floor(Math.log10(raw)), n = raw / magnitude;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude;
    return { max: Math.ceil(max / step - 1e-9) * step, step };
  }

  /* ---------- Data ---------- */
  // The workbench keeps running totals per session, not per day, so a session counts toward the day it was last active.
  function summarize(sessions) {
    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - i);
      days.push({ key: dayKey(date), date, cost: 0, tokens: 0, cache: 0, sessions: 0 });
    }
    const byKey = new Map(days.map(day => [day.key, day])), weekStart = days[DAYS - 7].date.getTime();
    const week = { cost: 0, tokens: 0, cache: 0, sessions: 0, toolCalls: 0, turns: 0 }, before = { cost: 0, tokens: 0 };
    const models = new Map(), recent = [];
    for (const session of sessions || []) {
      const at = Date.parse(session.updatedAt || session.createdAt), day = Number.isFinite(at) ? byKey.get(dayKey(at)) : null;
      if (!day) continue;
      const m = session.metrics || {}, cost = costOf(m), tokens = tokensOf(m);
      day.cost += cost; day.tokens += tokens; day.cache += cacheOf(m); day.sessions++;
      const name = modelName(session.model), model = models.get(name) || { name, cost: 0, tokens: 0, sessions: 0 };
      model.cost += cost; model.tokens += tokens; model.sessions++; models.set(name, model);
      recent.push(session);
      if (at >= weekStart) { week.cost += cost; week.tokens += tokens; week.cache += cacheOf(m); week.sessions++; week.toolCalls += num(m.toolCalls); week.turns += num(m.turns); }
      else { before.cost += cost; before.tokens += tokens; }
    }
    return { days, today: days[DAYS - 1], week, before, models: [...models.values()], recent };
  }
  // Quota history: [time, five-hour %, weekly %], one point per fresh reading at least five minutes apart.
  function addPoint(trend, usage) {
    const at = Date.parse(usage?.updatedAt), h5 = usage?.fiveHour?.utilization, d7 = usage?.sevenDay?.utilization;
    if (!usage || usage.stale || !Number.isFinite(at) || (!finite(h5) && !finite(d7))) return null;
    const list = (Array.isArray(trend) ? trend : []).filter(p => Array.isArray(p) && finite(p[0]) && Date.now() - p[0] < DAY);
    if (list.length && at - list[list.length - 1][0] < TREND_GAP) return null;
    const round = v => finite(v) ? Math.round(v * 10) / 10 : null;
    return [...list, [at, round(h5), round(d7)]].slice(-TREND_LIMIT);
  }
  const recentPoints = trend => (Array.isArray(trend) ? trend : []).filter(p => Array.isArray(p) && finite(p[0]) && Date.now() - p[0] < DAY).sort((a, b) => a[0] - b[0]);

  /* ---------- Small pieces ---------- */
  const empty = (title, text) => h('div', { class: 'wb-empty' }, h('strong', null, title), h('span', null, text));
  const skeleton = height => h('div', { class: 'wb-skeleton', style: { height: `${height}px` } });
  // A quota meter: the fill carries severity, and the state is also written out so it never rests on color alone.
  function meter(label, window, usage) {
    const value = window?.utilization, level = !finite(value) ? '' : value >= 85 ? 'bad' : value >= 60 ? 'warn' : 'ok';
    const state = level === 'bad' ? h('span', { class: 'wb-tag bad' }, '⚠ 接近上限') : level === 'warn' ? h('span', { class: 'wb-tag warn' }, '用量偏高') : null;
    const foot = window?.resetsAt ? until(window.resetsAt, '重置') : finite(value) ? '重置时间未知' : usage?.unavailableReason || '暂时没有额度数据';
    return h('div', { class: 'us-meter-card' },
      h('div', { class: 'us-meter-top' }, h('span', { class: 'us-label' }, label), state),
      h('strong', { class: 'us-meter-value' }, percent(value)),
      h('div', { class: `us-meter ${level}`, role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': finite(value) ? Math.round(value) : null },
        h('span', { style: { width: `${finite(value) ? Math.min(100, Math.max(0, value)) : 0}%` } })),
      h('small', { class: 'us-meter-foot', title: foot, dataset: window?.resetsAt ? { until: window.resetsAt } : null }, foot));
  }
  function statTile({ label, value, delta, note, spark }) {
    return h('div', { class: 'us-stat' },
      h('span', { class: 'us-label' }, label),
      h('div', { class: 'us-stat-main' }, h('strong', { class: 'us-stat-value' }, value), spark || null),
      h('small', { class: 'us-stat-note' }, delta ? h('span', { class: 'us-delta' }, delta) : null, note || null));
  }
  // A trend line in the de-emphasis gray with the current day in the accent.
  function sparkline(values, label) {
    const width = 92, height = 34, inset = 6, max = Math.max(...values, 0) || 1, last = values.length - 1;
    const x = i => inset + (width - 2 * inset) * i / Math.max(1, last), y = v => height - inset - (height - 2 * inset) * v / max;
    return svg('svg', { class: 'us-spark', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label },
      svg('title', null, label),
      svg('path', { class: 'spark-line', d: values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('') }),
      svg('circle', { class: 'spark-dot', cx: x(last), cy: y(values[last]), r: 4 }));
  }
  const tickCountdowns = () => document.querySelectorAll('[data-until]').forEach(el => { el.textContent = until(el.dataset.until, '重置'); });

  /* ---------- Tooltip: values lead, labels follow ---------- */
  let tip = null;
  function showTip(box, title, rows) {
    if (!tip) { tip = h('div', { class: 'us-tip', role: 'tooltip' }); document.body.append(tip); }
    tip.replaceChildren(h('small', null, title), ...rows.map(row => h('div', { class: 'us-tip-row' }, row.key ? h('i', { class: `us-key ${row.key}` }) : null, h('strong', null, row.value), h('span', null, row.label))));
    tip.hidden = false;
    const width = tip.offsetWidth, height = tip.offsetHeight;
    const x = Math.min(innerWidth - width - 8, Math.max(8, box.left + box.width / 2 - width / 2));
    const y = box.top - height - 10 >= 8 ? box.top - height - 10 : Math.min(innerHeight - height - 8, box.bottom + 10);
    tip.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }
  const hideTip = () => { if (tip) tip.hidden = true; };

  /* ---------- Charts: drawn at the real pixel width so hairlines stay crisp ---------- */
  const crisp = v => Math.round(v) + 0.5;
  // Rounded at the data end, square at the baseline.
  const barPath = (x, y, w, height, r = 4) => { r = Math.min(r, w / 2, height); return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + height}Z`; };
  function columnChart(days, measure, width) {
    const H = 220, top = 24, bottom = 28, left = 52, right = 8, plotW = Math.max(160, width - left - right), plotH = H - top - bottom;
    const values = days.map(day => day[measure.key]), scale = niceScale(Math.max(...values));
    const band = plotW / days.length, barW = Math.max(4, Math.min(24, band * 0.58)), y = v => top + plotH * (1 - v / scale.max);
    const root = svg('svg', { class: 'us-chart', width: left + plotW + right, height: H, role: 'group', 'aria-label': `近 14 天每日${measure.label}` });
    for (let i = 0, n = Math.round(scale.max / scale.step); i <= n; i++) {
      const v = i * scale.step;
      root.append(svg('line', { class: i ? 'grid' : 'base', x1: left, x2: left + plotW, y1: crisp(y(v)), y2: crisp(y(v)) }), svg('text', { class: 'tick', x: left - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, measure.tick(v)));
    }
    const peak = values.indexOf(Math.max(...values)), last = days.length - 1, labelEvery = Math.max(1, Math.ceil(40 / band));
    const labelled = new Set([peak, ...(values[last] > 0 && Math.abs(last - peak) > 1 ? [last] : [])]);
    days.forEach((day, i) => {
      const cx = left + band * i + band / 2, value = values[i], x = cx - barW / 2;
      if ((last - i) % labelEvery === 0) root.append(svg('text', { class: `tick${i === last ? ' strong' : ''}`, x: cx, y: H - 8, 'text-anchor': 'middle' }, i === last ? '今天' : `${day.date.getMonth() + 1}/${day.date.getDate()}`));
      const mark = value > 0 ? svg('path', { class: 'bar', d: barPath(x, y(value), barW, Math.max(1, top + plotH - y(value))) }) : svg('rect', { class: 'stub', x, y: top + plotH - 2, width: barW, height: 2, rx: 1 });
      root.append(mark);
      if (value > 0 && labelled.has(i)) root.append(svg('text', { class: 'value', x: cx, y: y(value) - 7, 'text-anchor': 'middle' }, measure.text(value)));
      const other = measure.key === 'cost' ? MEASURES.tokens : MEASURES.cost;
      const hit = svg('rect', { class: 'hit', x: left + band * i, y: top, width: band, height: plotH, tabindex: 0, 'aria-label': `${dayLabel(day.date)}：${measure.label} ${measure.text(value)}，${other.label} ${other.text(day[other.key])}，${day.sessions} 个会话` });
      const enter = () => { root.classList.add('hovering'); mark.classList.add('active'); showTip(mark.getBoundingClientRect(), dayLabel(day.date), [{ value: measure.text(value), label: measure.label }, { value: other.text(day[other.key]), label: other.label }, { value: String(day.sessions), label: '个会话' }]); };
      const leave = () => { root.classList.remove('hovering'); mark.classList.remove('active'); hideTip(); };
      hit.addEventListener('pointerenter', enter); hit.addEventListener('pointerleave', leave); hit.addEventListener('focus', enter); hit.addEventListener('blur', leave);
      root.append(hit);
    });
    return root;
  }
  const SERIES = [{ index: 1, name: '5 小时额度', short: '5 小时', cls: 'primary' }, { index: 2, name: '每周额度', short: '每周', cls: 'context' }];
  // The five-hour window is the one to watch, so it carries the accent; the weekly window is context in gray.
  function lineChart(points, width) {
    const H = 200, top = 14, bottom = 28, left = 40, right = 78, plotW = Math.max(160, width - left - right), plotH = H - top - bottom;
    const end = Date.now(), start = end - DAY;
    const x = t => left + plotW * Math.min(1, Math.max(0, (t - start) / DAY)), y = v => top + plotH * (1 - Math.min(100, Math.max(0, v)) / 100);
    const root = svg('svg', { class: 'us-chart', width: left + plotW + right, height: H, role: 'group', 'aria-label': '近 24 小时额度走势' });
    for (const v of [0, 25, 50, 75, 100]) root.append(svg('line', { class: v ? 'grid' : 'base', x1: left, x2: left + plotW, y1: crisp(y(v)), y2: crisp(y(v)) }), svg('text', { class: 'tick', x: left - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, `${v}%`));
    for (const hours of plotW < 360 ? [24, 12, 0] : [24, 18, 12, 6, 0]) root.append(svg('text', { class: `tick${hours ? '' : ' strong'}`, x: x(end - hours * HOUR), y: H - 8, 'text-anchor': hours === 24 ? 'start' : hours ? 'middle' : 'end' }, hours ? `${hours} 小时前` : '现在'));
    const ends = [];
    for (const series of [...SERIES].reverse()) {
      // Readings more than two hours apart are not joined: nothing was recorded in between.
      const runs = [];
      let previous = null;
      for (const point of points) {
        const v = point[series.index];
        if (!finite(v)) { previous = null; continue; }
        if (!previous || point[0] - previous[0] > TREND_BREAK) runs.push([]);
        runs[runs.length - 1].push([x(point[0]), y(v)]);
        previous = point;
      }
      if (!runs.length) continue;
      const line = runs.map(run => run.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('')).join('');
      if (series.cls === 'primary') root.append(svg('path', { class: 'area', d: runs.filter(run => run.length > 1).map(run => `M${run[0][0].toFixed(1)},${top + plotH}${run.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('')}L${run[run.length - 1][0].toFixed(1)},${top + plotH}Z`).join('') }));
      root.append(svg('path', { class: `line ${series.cls}`, d: line }));
      const tail = runs[runs.length - 1][runs[runs.length - 1].length - 1], value = [...points].reverse().find(p => finite(p[series.index]))[series.index];
      ends.push({ series, x: tail[0], y: tail[1], value });
    }
    for (const e of ends) root.append(svg('circle', { class: `dot ${e.series.cls}`, cx: e.x, cy: e.y, r: 4 }));
    // Direct labels at the line ends, unless the two ends sit too close to tell apart; the legend covers that case.
    if (ends.length < 2 || Math.abs(ends[0].y - ends[1].y) >= 14) for (const e of ends) root.append(svg('text', { class: 'end', x: e.x + 9, y: e.y + 4 }, `${e.series.short} ${percent(e.value)}`));
    const cross = svg('line', { class: 'cross', y1: top, y2: top + plotH, visibility: 'hidden' });
    const marks = SERIES.map(series => svg('circle', { class: `dot ${series.cls}`, r: 4, visibility: 'hidden' }));
    const hit = svg('rect', { class: 'hit', x: left, y: top, width: plotW, height: plotH, tabindex: 0, 'aria-label': '额度走势：用左右方向键逐个查看记录点' });
    let index = -1;
    const show = i => {
      index = Math.max(0, Math.min(points.length - 1, i));
      const point = points[index], px = x(point[0]), box = root.getBoundingClientRect();
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      SERIES.forEach((series, k) => { const v = point[series.index]; marks[k].setAttribute('visibility', finite(v) ? 'visible' : 'hidden'); if (finite(v)) { marks[k].setAttribute('cx', px); marks[k].setAttribute('cy', y(v)); } });
      showTip({ left: box.left + px, width: 0, top: box.top + top, bottom: box.top + top }, `${clock(point[0])} 的记录`, SERIES.map(series => ({ value: percent(point[series.index]), label: series.name, key: series.cls })));
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); marks.forEach(mark => mark.setAttribute('visibility', 'hidden')); hideTip(); };
    hit.addEventListener('pointermove', event => {
      const t = start + (event.clientX - root.getBoundingClientRect().left - left) / plotW * DAY;
      let best = 0;
      points.forEach((point, i) => { if (Math.abs(point[0] - t) < Math.abs(points[best][0] - t)) best = i; });
      show(best);
    });
    hit.addEventListener('pointerleave', hide); hit.addEventListener('blur', hide);
    hit.addEventListener('focus', () => show(points.length - 1));
    hit.addEventListener('keydown', event => {
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: points.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault(); show(target);
    });
    root.append(cross, ...marks, hit);
    return root;
  }
  const legend = () => h('div', { class: 'wb-legend us-legend' }, SERIES.map(series => h('span', null, h('i', { class: `us-key ${series.cls}` }), series.name)));
  function table(head, rows) {
    return h('div', { class: 'us-table-wrap' }, h('table', { class: 'us-table' },
      h('thead', null, h('tr', null, head.map(cell => h('th', null, cell)))),
      h('tbody', null, rows.map(row => h('tr', null, row.map(cell => h('td', null, cell)))))));
  }

  /* ---------- Panel ---------- */
  function startPanel() {
    const state = { measure: 'cost', summary: null, usage: null, trend: [], loadedAt: 0, tables: new Set(), dirty: false };
    const updated = h('span', { class: 'us-updated' });
    const refresh = h('button', { class: 'wb-btn small', type: 'button', onclick: () => load() }, '刷新');
    const notice = h('div', { class: 'us-notice', role: 'status', hidden: true });
    const quota = h('section', { class: 'us-quota us-live', 'aria-label': '官方额度' }, skeleton(118), skeleton(118));
    const kpis = h('section', { class: 'us-kpis us-live', 'aria-label': '用量概览' }, [1, 2, 3, 4].map(() => skeleton(96)));
    const measureButtons = Object.values(MEASURES).map(measure => h('button', { type: 'button', 'aria-pressed': String(measure.key === state.measure), onclick: () => setMeasure(measure.key) }, measure.label));
    function card(id, title, subtitle, withTable) {
      const titleEl = h('h2', null, title), body = h('div', { class: 'us-card-body us-live' }, skeleton(180));
      const toggle = withTable ? h('button', { class: 'wb-btn ghost small', type: 'button', 'aria-pressed': 'false', title: '在图表与数据表之间切换' }, '表格') : null;
      toggle?.addEventListener('click', () => {
        const on = !state.tables.has(id);
        if (on) state.tables.add(id); else state.tables.delete(id);
        toggle.setAttribute('aria-pressed', String(on)); toggle.textContent = on ? '图表' : '表格';
        render[id]();
      });
      const el = h('section', { class: 'wb-card us-card', dataset: { card: id } }, h('div', { class: 'us-card-head' }, h('div', null, titleEl, h('p', null, subtitle)), toggle), body);
      return { el, body, titleEl, width: 0 };
    }
    const cards = {
      daily: card('daily', '每日费用', '近 14 天 · 按会话最后活跃日归集', true),
      models: card('models', '模型分布', '近 14 天 · 按模型合计'),
      trend: card('trend', '额度走势', '近 24 小时 · 后台约每 5 分钟记录一次', true),
      top: card('top', '消耗最多的会话', '近 14 天 · 点击打开对话'),
    };
    const root = h('main', { class: 'us-panel' },
      h('header', { class: 'us-head' },
        h('div', null, h('span', { class: 'wb-eyebrow' }, 'Usage insights'), h('h1', null, '用量统计'), h('p', null, '额度来自官方 CLI，Token 与费用来自本机会话统计；费用是 API 等价估算，不是账单。')),
        h('div', { class: 'us-head-side' }, updated, refresh)),
      notice, quota, kpis,
      h('div', { class: 'us-filters' }, h('div', { class: 'wb-segment', role: 'group', 'aria-label': '统计口径' }, measureButtons), h('span', null, '下方图表按此口径统计')),
      h('div', { class: 'us-row' }, cards.daily.el, cards.models.el),
      h('div', { class: 'us-row' }, cards.trend.el, cards.top.el),
      h('p', { class: 'us-foot' }, '这些数字只在你的浏览器里汇总，不会离开这台服务器。'));
    document.body.append(root);

    const render = {
      quota() {
        const u = state.usage;
        quota.replaceChildren(meter('5 小时额度', u?.fiveHour, u), meter('每周额度', u?.sevenDay, u));
        notice.hidden = !u?.rateLimited;
        if (u?.rateLimited) notice.replaceChildren(h('strong', null, '⛔ 已触发官方限流'), h('span', null, u.cooldownUntil ? `预计${until(u.cooldownUntil, '恢复')}。` : '请稍后再试。'));
      },
      kpis() {
        const s = state.summary, spark = s.days.slice(-12).map(day => day.cost);
        const costChange = change(s.week.cost, s.before.cost), tokenChange = change(s.week.tokens, s.before.tokens);
        kpis.replaceChildren(
          statTile({ label: '今日费用（估算）', value: money(s.today.cost), note: `${s.today.sessions} 个会话`, spark: sparkline(spark, `近 12 天每日费用：${spark.map(money).join('、')}`) }),
          statTile({ label: '近 7 天费用', value: money(s.week.cost), delta: costChange, note: costChange ? '较前 7 天' : '前 7 天没有可比数据' }),
          statTile({ label: '近 7 天 Token', value: format.compact(s.week.tokens), delta: tokenChange, note: `${tokenChange ? '较前 7 天 · ' : ''}缓存读写 ${format.compact(s.week.cache)}` }),
          statTile({ label: '近 7 天工具调用', value: format.number(s.week.toolCalls), note: `${s.week.sessions} 个会话 · ${format.number(s.week.turns)} 轮对话` }));
      },
      daily() {
        const { body, titleEl } = cards.daily, measure = MEASURES[state.measure], days = state.summary.days;
        titleEl.textContent = `每日${measure.label}`;
        if (!days.some(day => day[measure.key] > 0)) return body.replaceChildren(empty('近 14 天还没有用量', '开始对话后，这里会按天汇总。'));
        body.replaceChildren(state.tables.has('daily')
          ? table(['日期', '费用', 'Token', '缓存读写', '会话'], [...days].reverse().map(day => [dayLabel(day.date), money(day.cost), format.number(day.tokens), format.number(day.cache), String(day.sessions)]))
          : columnChart(days, measure, cards.daily.width));
      },
      models() {
        const measure = MEASURES[state.measure], list = state.summary.models.filter(m => m[measure.key] > 0).sort((a, b) => b[measure.key] - a[measure.key]);
        if (!list.length) return cards.models.body.replaceChildren(empty('暂无数据', '有用量的会话会按模型汇总在这里。'));
        // Past five rows the tail folds into "其他" rather than growing the list.
        const rows = list.length > 5 ? [...list.slice(0, 4), list.slice(4).reduce((sum, m) => ({ name: '其他', cost: sum.cost + m.cost, tokens: sum.tokens + m.tokens, sessions: sum.sessions + m.sessions }), { name: '其他', cost: 0, tokens: 0, sessions: 0 })] : list;
        const total = list.reduce((sum, m) => sum + m[measure.key], 0), max = Math.max(...rows.map(m => m[measure.key]));
        cards.models.body.replaceChildren(h('ul', { class: 'us-bars' }, rows.map(m => h('li', null,
          h('div', { class: 'us-bar-head' }, h('strong', null, m.name), h('span', { class: 'us-bar-value' }, measure.text(m[measure.key])), h('span', { class: 'us-bar-share' }, `${Math.round(m[measure.key] / total * 100)}%`)),
          h('div', { class: 'us-bar-track' }, h('span', { style: { width: `${Math.max(1.5, m[measure.key] / max * 100)}%` } })),
          h('small', null, `${m.sessions} 个会话`)))));
      },
      trend() {
        const { body } = cards.trend, points = recentPoints(state.trend);
        if (points.length < 2) return body.replaceChildren(empty('走势正在积累', '后台约每 5 分钟记录一次额度。工作台开着一段时间后，这里会画出 24 小时走势。'));
        if (state.tables.has('trend')) {
          // One row per hour: the last reading taken in that hour.
          const hours = new Map();
          for (const point of points) hours.set(new Date(point[0]).setMinutes(0, 0, 0), point);
          return body.replaceChildren(table(['时间', '5 小时额度', '每周额度'], [...hours.values()].reverse().map(point => [clock(point[0]), percent(point[1]), percent(point[2])])));
        }
        body.replaceChildren(legend(), lineChart(points, cards.trend.width));
      },
      top() {
        const measure = MEASURES[state.measure], list = state.summary.recent.filter(s => measure.of(s.metrics) > 0).sort((a, b) => measure.of(b.metrics) - measure.of(a.metrics)).slice(0, 6);
        if (!list.length) return cards.top.body.replaceChildren(empty('暂无数据', '有用量的会话会按消耗排在这里。'));
        cards.top.body.replaceChildren(h('ol', { class: 'us-top' }, list.map((s, i) => {
          const parts = [h('span', { class: 'us-rank' }, String(i + 1)), h('span', { class: 'us-top-main' }, h('strong', null, s.title || '未命名会话'), h('small', null, `${modelName(s.model)} · ${format.relative(s.updatedAt)}${s.archived ? ' · 已归档' : ''}`)), h('span', { class: 'us-top-value' }, measure.text(measure.of(s.metrics)))];
          return h('li', null, s.archived ? h('div', { class: 'us-top-item' }, parts) : h('button', { class: 'us-top-item', type: 'button', title: '在对话中打开', onclick: () => wb.sessions.open(s.id).catch(error => showNotice(error.message)) }, parts));
        })));
      },
    };
    const renderAll = () => { for (const name of Object.keys(render)) render[name](); };
    function setMeasure(key) {
      state.measure = key;
      measureButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(Object.keys(MEASURES)[i] === key)));
      if (state.summary) { render.daily(); render.models(); render.top(); }
    }
    function showNotice(text) { notice.replaceChildren(h('span', null, text)); notice.hidden = false; }
    async function load() {
      root.classList.add('refreshing'); refresh.disabled = true; state.dirty = false;
      try {
        const [sessions, usage, trend] = await Promise.all([wb.sessions.list(), wb.usage.get(), wb.storage.get(TREND_KEY).catch(() => null)]);
        Object.assign(state, { summary: summarize(sessions), usage, trend: Array.isArray(trend) ? trend : [], loadedAt: Date.now() });
        renderAll();
        updated.textContent = `更新于 ${clock(state.loadedAt)}`;
      } catch (error) { showNotice(`数据暂时没有加载：${error.message}`); }
      finally { root.classList.remove('refreshing'); refresh.disabled = false; }
    }
    // Hidden panels only remember that something changed and catch up when shown again.
    let timer = null;
    const soon = delay => { if (!wb.info.visible) { state.dirty = true; return; } clearTimeout(timer); timer = setTimeout(load, delay); };
    wb.on('session', () => soon(1500));
    wb.on('metrics', () => soon(4000));
    wb.on('usage', usage => { state.usage = usage; render.quota(); });
    wb.on('storage:change', ({ key, value }) => { if (key === TREND_KEY) { state.trend = Array.isArray(value) ? value : []; if (state.summary) render.trend(); } });
    wb.on('visibility', ({ visible }) => { if (visible && (state.dirty || Date.now() - state.loadedAt > 60000)) load(); });
    setInterval(() => { if (wb.info.visible) tickCountdowns(); }, 30000);
    const resize = new ResizeObserver(entries => {
      for (const entry of entries) {
        const id = entry.target.dataset.card, width = Math.floor(entry.contentRect.width);
        if (cards[id].width === width) continue;
        cards[id].width = width;
        if (state.summary && (id === 'daily' || id === 'trend')) render[id]();
      }
    });
    for (const id of ['daily', 'trend']) resize.observe(cards[id].el);
    load();
  }

  /* ---------- Monitor widget ---------- */
  function startWidget() {
    let usage = null, summary = null, height = 0;
    const grid = h('div', { class: 'us-widget-grid' }, [1, 2, 3, 4].map(() => skeleton(92)));
    const root = h('div', { class: 'us-widget' }, grid, h('div', { class: 'us-widget-foot' },
      h('span', null, '费用为 API 等价估算 · 会话按最后活跃日归集'),
      h('button', { class: 'wb-btn small', type: 'button', onclick: () => wb.ui.openPanel().catch(() => {}) }, '查看详情 →')));
    document.body.append(root);
    // The card grows or shrinks to fit what was drawn.
    const fit = () => requestAnimationFrame(() => {
      const next = Math.ceil(root.getBoundingClientRect().height) + 6;
      if (Math.abs(next - height) > 2) { height = next; wb.ui.resize({ height }).catch(() => {}); }
    });
    function render() {
      const spark = summary ? summary.days.slice(-12).map(day => day.cost) : [];
      grid.replaceChildren(
        meter('5 小时额度', usage?.fiveHour, usage),
        meter('每周额度', usage?.sevenDay, usage),
        statTile({ label: '今日费用（估算）', value: summary ? money(summary.today.cost) : '—', note: summary ? `${summary.today.sessions} 个会话` : '', spark: summary ? sparkline(spark, `近 12 天每日费用：${spark.map(money).join('、')}`) : null }),
        statTile({ label: '近 7 天', value: summary ? money(summary.week.cost) : '—', note: summary ? `${format.compact(summary.week.tokens)} Token · ${summary.week.sessions} 个会话` : '' }));
      fit();
    }
    async function load() {
      try { [summary, usage] = await Promise.all([wb.sessions.list().then(summarize), wb.usage.get()]); render(); }
      catch (error) { grid.replaceChildren(empty('数据暂时没有加载', error.message)); fit(); }
    }
    let timer = null, dirty = false;
    const soon = delay => { if (!wb.info.visible) { dirty = true; return; } clearTimeout(timer); timer = setTimeout(load, delay); };
    wb.on('session', () => soon(2000));
    wb.on('metrics', () => soon(5000));
    wb.on('usage', next => { usage = next; if (summary) render(); });
    wb.on('visibility', ({ visible }) => { if (visible && dirty) { dirty = false; load(); } });
    setInterval(() => { if (wb.info.visible) tickCountdowns(); }, 30000);
    new ResizeObserver(fit).observe(document.documentElement);
    load();
  }

  /* ---------- Background: status bar and quota history ---------- */
  function startBackground() {
    let trend = null, queue = Promise.resolve(), statusTimer = null;
    const record = usage => {
      queue = queue.then(async () => {
        trend ??= await wb.storage.get(TREND_KEY).catch(() => null) || [];
        const next = addPoint(trend, usage);
        if (next) { trend = next; await wb.storage.set(TREND_KEY, next); }
      }).catch(() => {});
    };
    async function status() {
      try {
        const today = summarize(await wb.sessions.list()).today;
        await wb.ui.setStatus({ text: `≈${money(today.cost)} 今日`, title: `今日 ${today.sessions} 个会话、${format.compact(today.tokens)} Token；费用是 API 等价估算，不是账单。点击打开用量统计` });
      } catch {}
    }
    const soon = () => { clearTimeout(statusTimer); statusTimer = setTimeout(status, 3000); };
    wb.on('usage', record);
    wb.on('session', soon);
    wb.on('metrics', soon);
    wb.on('statusbar:click', () => { wb.ui.openPanel().catch(() => {}); });
    wb.usage.get().then(record, () => {});
    status();
    setInterval(() => { wb.usage.get().then(record, () => {}); }, TREND_GAP);
    // Also catches the date rolling over at midnight.
    setInterval(status, 60000);
  }

  wb.ready().then(info => ({ panel: startPanel, widget: startWidget, background: startBackground })[info.surface]?.());
})();
