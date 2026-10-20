(() => {
  'use strict';
  const wb = window.workbench, { h } = wb;
  const labels = { running: '执行中', resuming: '正在恢复', awaiting_user: '等待用户处理', interrupted: '执行中断', failed: '本轮未完成', completed: '已完成', stopped: '已手动停止', cancelled: '已取消恢复' };
  const reasons = { restart: '服务重启后检测到中断', quota: '额度拒绝，请先检查账号可用性', process_error: '进程异常退出', start_failed: '上次恢复未能启动', user_stop: '你已停止这项任务', user_cancel: '不再恢复这项任务', approval: '请回到原对话处理审批或问题' };
  const date = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  wb.ready().then(() => {
    let state = null, busy = false, settingsDirty = false, loading = false, refreshPending = false, revision = 0;
    const notice = h('p', { class: 'tr-notice', role: 'status', hidden: true });
    const count = h('span', { class: 'tr-count' }, '读取检查点…');
    const list = h('div', { class: 'tr-list' });
    const toggle = h('input', { type: 'checkbox', 'aria-label': '开启自动恢复' });
    const attempts = h('select', { 'aria-label': '最多自动恢复次数' }, [1, 2, 3, 4, 5].map(n => h('option', { value: n }, `${n} 次`)));
    const delay = h('select', { 'aria-label': '首次重试间隔' }, [[30_000, '30 秒'], [60_000, '1 分钟'], [120_000, '2 分钟'], [300_000, '5 分钟']].map(([value, name]) => h('option', { value }, name)));
    const refresh = h('button', { type: 'button', class: 'wb-btn', onclick: load }, '刷新');
    const save = h('button', { type: 'button', class: 'wb-btn primary', onclick: () => action('settings.update', { autoResume: toggle.checked, maxAttempts: Number(attempts.value), retryDelayMs: Number(delay.value) }) }, '保存设置');
    for (const control of [toggle, attempts, delay]) control.addEventListener('change', () => { settingsDirty = true; save.textContent = '保存更改'; });
    document.body.append(h('main', { class: 'tr-root' },
      h('header', { class: 'tr-header' }, h('div', null, h('span', { class: 'tr-eyebrow' }, 'CONTINUE YOUR WORK'), h('h1', null, '任务断点续跑'), h('p', { class: 'tr-intro' }, '回到原来的会话和工作区，继续尚未完成的步骤。')), refresh),
      h('section', { class: 'tr-settings' }, h('div', { class: 'tr-switch-row' }, h('label', { class: 'tr-switch' }, toggle, h('span', null, '自动恢复中断任务')), h('span', { class: 'tr-default' }, '默认关闭')),
        h('p', { class: 'tr-muted' }, '开启后会自动继续符合条件的任务。遇到等待审批、手动停止或额度拒绝时，留给你处理。每次失败后延长等待，达到次数上限后停止。'),
        h('div', { class: 'tr-controls' }, h('label', null, '每项任务最多', attempts), h('label', null, '首次等待', delay), save)),
      notice, h('div', { class: 'tr-list-heading' }, h('h2', null, '任务检查点'), count), list,
      h('footer', { class: 'tr-foot' }, '检查点保存执行状态和最后工具摘要；恢复使用官方会话历史，并先检查当前文件和操作结果。它无法还原已退出的进程，也不保证外部操作只执行一次。')));

    function show(message) { notice.textContent = message; notice.hidden = !message; }
    function render() {
      const tasks = state.tasks || [], recoverable = tasks.filter(task => task.resumable);
      // Live checkpoint refreshes must not overwrite an unsubmitted settings draft.
      if (!settingsDirty) {
        toggle.checked = state.settings.autoResume; attempts.value = String(state.settings.maxAttempts);
        if (![...delay.options].some(option => Number(option.value) === state.settings.retryDelayMs)) delay.append(h('option', { value: state.settings.retryDelayMs }, `${state.settings.retryDelayMs / 1000} 秒`));
        delay.value = String(state.settings.retryDelayMs); save.textContent = '保存设置';
      }
      count.textContent = `${recoverable.length} 项可恢复 · ${tasks.length} 项记录`;
      show(state.persistenceError || '');
      list.replaceChildren(...(tasks.length ? tasks.map(task => {
        const pending = task.automatic && task.nextAttemptAt;
        const badge = h('span', { class: `tr-badge ${task.resumable ? 'warn' : task.state === 'completed' ? 'ok' : ''}` }, labels[task.state] || task.state);
        const actions = h('div', { class: 'tr-actions' }, h('button', { type: 'button', class: 'wb-btn', onclick: () => wb.sessions.open(task.sessionId).catch(error => show(error.message)) }, '打开会话'));
        if (task.resumable) actions.prepend(h('button', { type: 'button', class: 'wb-btn primary', disabled: busy, onclick: () => action('resume', { sessionId: task.sessionId }) }, '从检查点继续'));
        if (['interrupted', 'failed'].includes(task.state)) actions.append(h('button', { type: 'button', class: 'wb-btn', disabled: busy, onclick: () => action('cancel', { sessionId: task.sessionId }) }, '取消恢复'));
        return h('article', { class: 'tr-task' }, h('div', { class: 'tr-task-top' }, h('h3', null, task.title || '未命名任务'), badge),
          h('p', { class: 'tr-muted' }, reasons[task.reason] || (task.state === 'completed' ? '本轮正常结束' : '保留原会话和工作区中的执行进度')),
          h('dl', { class: 'tr-meta' }, h('div', null, h('dt', null, '最近检查点'), h('dd', null, date(task.updatedAt))),
            h('div', null, h('dt', null, '最后工具'), h('dd', null, task.lastTool ? `${task.lastTool.name || '工具'} · ${task.lastTool.status || '已记录'}` : '尚无工具记录')),
            h('div', null, h('dt', null, '自动恢复'), h('dd', null, `${task.autoAttempts} / ${state.settings.maxAttempts} 次`))),
          pending ? h('p', { class: 'tr-queue' }, `已排队，最早 ${date(task.nextAttemptAt)} 尝试；其他任务执行时会等待。`) : null,
          task.retryExhausted && task.resumable ? h('p', { class: 'tr-queue' }, '已达到自动恢复上限，检查原对话后可手动继续。') : null,
          !task.claudeSessionId && ['interrupted', 'failed'].includes(task.state) ? h('p', { class: 'tr-queue' }, '尚未获得官方会话记录，无法恢复；请打开原对话检查。') : null,
          actions);
      }) : [h('div', { class: 'tr-empty' }, h('span', { class: 'tr-empty-icon', 'aria-hidden': true }, '↻'), h('h3', null, '还没有任务检查点'), h('p', null, '启用插件后开始的新一轮任务会自动记录进度。'))]));
    }
    async function load() {
      if (busy || loading) { refreshPending = true; return; }
      loading = true; refreshPending = false;
      const requestRevision = revision;
      refresh.disabled = true;
      try { const next = await wb.backend.call('list', {}); if (revision === requestRevision && !busy) { state = next; render(); } } catch (error) { show(error.message); }
      finally { loading = false; refresh.disabled = false; if (refreshPending && !busy) void load(); }
    }
    async function action(method, params) {
      if (busy) return; busy = true; revision++; save.disabled = true;
      for (const control of [toggle, attempts, delay]) control.disabled = true;
      try { await wb.backend.call(method, params); if (method === 'settings.update') settingsDirty = false; busy = false; await load(); }
      catch (error) { show(error.message); }
      finally { busy = false; save.disabled = false; for (const control of [toggle, attempts, delay]) control.disabled = false; if (refreshPending) void load(); }
    }
    wb.on('session', () => { if (wb.info.visible) void load(); });
    wb.on('visibility', ({ visible }) => { if (visible) void load(); });
    setInterval(() => { if (wb.info.visible) void load(); }, 10_000);
    void load();
  });
})();
