(() => {
  'use strict';
  const wb = window.workbench, { h } = wb;
  const strategies = [['sticky', '保持当前账号，额度不足时切换'], ['round-robin', '每轮轮询可用账号'], ['quota', '优先使用余量最多的账号']];
  let state = null, sessions = [], busy = false, dirty = false, refreshPending = false, loading = false, revision = 0;
  const root = h('main', { class: 'ap-panel' });
  const notice = h('p', { class: 'ap-notice', role: 'status', 'aria-live': 'polite', hidden: true });
  const content = h('div', { class: 'ap-content' });
  // Session events can arrive while a name or policy is being edited. Keep those
  // drafts in their existing DOM until an explicit operation succeeds.
  const rememberDraft = event => { if (event.target.matches('input,select,textarea')) dirty = true; };
  content.addEventListener('input', rememberDraft);
  content.addEventListener('change', rememberDraft);
  const login = h('section', { class: 'ap-card', hidden: true });
  const show = message => { notice.textContent = message; notice.hidden = !message; };
  const button = (text, action, options = {}) => h('button', { type: 'button', class: 'wb-btn', disabled: busy, onclick: action, ...options }, text);
  const percent = window => Number.isFinite(window?.utilization) ? `${Math.round(window.utilization)}%` : '未知';
  const selector = (options, value, label) => {
    const select = h('select', { class: 'ap-input', 'aria-label': label, disabled: busy }, options.map(([key, text]) => h('option', { value: key }, text)));
    select.value = value;
    return select;
  };

  async function act(method, params = {}) {
    if (busy) return;
    busy = true; revision++; show(''); root.setAttribute('aria-busy', 'true');
    const controls = [...root.querySelectorAll('button,input,select')].map(element => [element, element.disabled]);
    for (const [element] of controls) element.disabled = true;
    let succeeded = false;
    try { state = await wb.backend.call(method, params); dirty = false; succeeded = true; }
    catch (error) { show(error.message || '操作未完成，请重试。'); }
    finally {
      busy = false; root.removeAttribute('aria-busy');
      for (const [element, disabled] of controls) element.disabled = disabled;
      if (succeeded) { render(); if (refreshPending) void load(); }
    }
  }

  async function load() {
    if (busy || dirty) { refreshPending = true; return; }
    if (loading) { refreshPending = true; return; }
    loading = true; refreshPending = false;
    const requestRevision = revision;
    try {
      const result = await Promise.all([wb.backend.call('list'), wb.sessions.list()]);
      if (dirty || busy || revision !== requestRevision) { refreshPending = true; return; }
      [state, sessions] = result;
      refreshPending = false; render();
    } catch (error) { show(error.message || '无法读取插件状态。'); }
    finally { loading = false; if (refreshPending && !dirty && !busy) void load(); }
  }

  async function showLogin(account) {
    try {
      const result = await wb.backend.call('loginCommand', { id: account.id });
      const command = h('textarea', { class: 'ap-command', readOnly: true, rows: 5, 'aria-label': '官方登录命令' });
      command.value = result.command;
      login.replaceChildren(h('h2', null, `${account.label} · 官方登录`), h('p', null, result.note),
        command, h('div', { class: 'ap-actions' },
          button('选中命令', () => { command.focus(); command.select(); }),
          button('登录完成，刷新状态', () => act('refresh', { id: account.id })),
          button('收起', () => { login.hidden = true; })),
        h('p', { class: 'ap-muted' }, '使用你已有的官方账号登录。每个额外账号使用自己的配置目录；请勿向工作台粘贴密码、Token 或授权码。'));
      login.hidden = false;
      command.focus(); command.select();
    } catch (error) { show(error.message); }
  }

  function accountCard(account) {
    const loggedIn = account.auth.loggedIn;
    const title = h('input', { class: 'ap-input ap-name', value: account.label, maxLength: 60, disabled: busy, 'aria-label': '账号名称' });
    const quota = account.usage;
    const status = loggedIn === true ? '已登录' : loggedIn === false ? '未登录' : '待确认';
    return h('article', { class: 'ap-card' },
      h('div', { class: 'ap-account-head' }, title,
        h('span', { class: `wb-tag ${loggedIn === true ? 'ok' : ''}` }, status),
        account.isDefault ? h('span', { class: 'wb-tag' }, '默认') : null,
        !account.enabled ? h('span', { class: 'wb-tag' }, '已停用') : null),
      h('p', { class: 'ap-muted' }, [account.auth.emailMask, account.auth.subscriptionType,
        account.primary ? '工作台原有官方配置' : '独立官方配置'].filter(Boolean).join(' · ')),
      h('div', { class: 'ap-quota' }, h('span', null, '5 小时 ', h('strong', null, percent(quota.fiveHour))), h('span', null, '每周 ', h('strong', null, percent(quota.sevenDay)))),
      quota.rateLimited ? h('p', { class: 'ap-notice' }, quota.cooldownUntil ? `官方额度暂不可用，预计 ${new Date(quota.cooldownUntil).toLocaleString()} 恢复` : '官方额度暂不可用，请刷新后重试') : null,
      h('div', { class: 'ap-actions' },
        button('保存名称', () => act('update', { id: account.id, label: title.value })),
        button('登录说明', () => showLogin(account), { disabled: busy || !account.enabled }),
        button('刷新', () => act('refresh', { id: account.id })),
        !account.isDefault ? button('设为默认', () => act('update', { id: account.id, isDefault: true, enabled: true })) : null,
        !account.isDefault ? button(account.enabled ? '停用' : '启用', () => act('update', { id: account.id, enabled: !account.enabled })) : null));
  }

  function render() {
    if (!state) return;
    const strategy = selector(strategies, state.settings.strategy, '账号选择策略');
    const threshold = selector([90, 95, 98, 100].map(value => [String(value), `${value}%`]), String(state.settings.switchAt), '额度切换阈值');
    const name = h('input', { class: 'ap-input', placeholder: '新账号名称', maxLength: 60, disabled: busy, 'aria-label': '新账号名称' });
    const activeSessions = sessions.filter(session => !session.archived);
    const selectedSession = selector(activeSessions.map(session => [session.id, session.title || '新的对话']), activeSessions[0]?.id || '', '选择会话');
    const selectedAccount = selector([['', '自动选择（跟随全局策略）'], ...state.accounts.filter(account => account.enabled).map(account => [account.id, account.label])], '', '会话绑定账号');
    const syncBinding = () => {
      const binding = state.bindings[selectedSession.value];
      selectedAccount.value = binding?.pinned ? binding.accountId : '';
    };
    selectedSession.addEventListener('change', syncBinding); syncBinding();
    content.replaceChildren(
      h('section', { class: 'ap-card' }, h('h2', null, '选择策略'),
        h('div', { class: 'ap-fields' }, h('label', null, '每轮开始时', strategy), h('label', null, '自动选择上限', threshold),
          button('保存策略', () => act('settings', { strategy: strategy.value, switchAt: Number(threshold.value) }))),
        h('p', { class: 'ap-muted' }, '只在新一轮开始前选择账号，运行中的任务不会被切走。未知额度保持“未知”；达到官方限制的账号会暂时跳过。手动绑定的会话保持指定账号。')),
      h('section', { class: 'ap-card' }, h('div', { class: 'ap-account-head' }, h('h2', null, '账号配置'), button(busy ? '处理中…' : '刷新全部状态', () => act('refresh'))),
        h('div', { class: 'ap-fields' }, name, button('添加账号配置', () => act('create', { label: name.value }), { disabled: busy || state.accounts.length >= 10 })),
        h('p', { class: 'ap-muted' }, '最多 10 个配置。添加配置后，按“登录说明”完成官方登录；不会自动注册账号。')),
      h('div', { class: 'ap-grid' }, state.accounts.map(accountCard)),
      h('section', { class: 'ap-card' }, h('h2', null, '会话绑定'),
        activeSessions.length ? h('div', { class: 'ap-fields' }, selectedSession, selectedAccount,
          button('保存绑定', () => act('bind', { sessionId: selectedSession.value, accountId: selectedAccount.value || null }))) : h('p', { class: 'ap-muted' }, '先在工作台创建一个会话。'),
        h('p', { class: 'ap-muted' }, '切换账号时仅接续当前会话的官方记录，工作区保持原位置。已经使用独立账号的会话需要保持此插件启用，或先切回默认账号。')));
  }

  // The background surface keeps the sidebar entry and the composer's account picker current.
  // Picking an account for an open conversation binds it now; for a new conversation the page
  // keeps the choice and sends it with the first message.
  function startBackground() {
    const AUTO = 'auto';
    let snapshot = null, loading = false, again = false, timer = null;
    const named = id => snapshot?.accounts.find(account => account.id === id)?.label || '已移除的账号';
    const quota = account => [account.usage?.fiveHour, account.usage?.sevenDay].some(window => Number.isFinite(window?.utilization))
      ? ` · 5 小时 ${percent(account.usage.fiveHour)} · 每周 ${percent(account.usage.sevenDay)}` : '';
    function publish() {
      const accounts = snapshot.accounts, loggedIn = accounts.filter(account => account.enabled && account.auth.loggedIn === true).length;
      wb.ui.setSidebar({ subtitle: `${loggedIn} 个已登录 · ${accounts.length} 个账号`, tone: loggedIn ? '' : 'warn' }).catch(() => {});
      const strategy = strategies.find(([key]) => key === snapshot.settings.strategy)?.[1] || '';
      const options = [{ value: AUTO, label: '自动选择', detail: `跟随全局策略：${strategy}` },
        ...accounts.map(account => ({ value: account.id, label: account.label,
          detail: `${!account.enabled ? '已停用' : account.auth.loggedIn === true ? '已登录' : account.auth.loggedIn === false ? '未登录' : '登录状态待确认'}${quota(account)}`,
          disabled: !account.enabled || account.auth.loggedIn === false }))];
      // Unpinned conversations show which account they used last; the picker still means "automatic".
      const values = Object.fromEntries(Object.entries(snapshot.bindings).slice(-1000).map(([sessionId, binding]) =>
        [sessionId, binding.pinned ? binding.accountId : { value: AUTO, label: `自动 · ${named(binding.accountId)}` }]));
      wb.composer.setPicker({ options, value: AUTO, values, title: '本会话使用的官方账号' }).catch(() => {});
    }
    async function refresh() {
      if (loading) { again = true; return; }
      loading = true; again = false;
      try { snapshot = await wb.backend.call('list'); publish(); } catch {}
      finally { loading = false; if (again) void refresh(); }
    }
    // Session events stream during a turn, so collect them into at most one read per second.
    const soon = () => { timer ??= setTimeout(() => { timer = null; void refresh(); }, 1000); };
    wb.on('composer:change', async ({ sessionId, value, requestId }) => {
      let result = { ok: true };
      if (sessionId) {
        try { snapshot = await wb.backend.call('bind', { sessionId, accountId: value === AUTO ? null : value }); }
        catch (error) { result = { ok: false, message: error.message || '切换账号没有完成。' }; }
      }
      await wb.composer.reply(requestId, result).catch(() => {});
      if (snapshot) publish();
    });
    // Bindings move when a turn starts; the backend announces its own changes as runtime events.
    wb.on('runtime', soon);
    wb.on('session', soon);
    refresh();
    setInterval(refresh, 60000);
  }

  function startPanel() {
    root.append(h('header', null, h('span', { class: 'wb-eyebrow' }, 'Optional plugin'), h('h1', null, '多账号轮询'),
      h('p', null, '由你选择账号与策略，官方 CLI 负责登录和执行。账号配置与会话绑定只保存在当前服务器。')),
    notice, content, login);
    document.body.append(root);
    load();
    wb.on('visibility', ({ visible }) => { if (visible) load(); });
    wb.on('session', load);
    wb.on('runtime', load);
  }

  wb.ready().then(info => (info.surface === 'background' ? startBackground : startPanel)());
})();
