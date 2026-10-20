// 小云 · a small cloud that lives in a corner of the workbench. It reacts to run milestones (never their content),
// frets a little when the five-hour quota runs low, and remembers how often you petted it.
(() => {
  'use strict';
  const wb = window.workbench, { h } = wb;
  const KEY = 'pet', MINUTE = 60000, SLEEP_AFTER = 10 * MINUTE;
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const TOOLS = { Bash: '跑命令', Read: '读文件', Edit: '改文件', MultiEdit: '改文件', Write: '写文件', Grep: '搜内容', Glob: '找文件', WebFetch: '查网页', WebSearch: '上网搜', TodoWrite: '列计划', Task: '派小助手', NotebookEdit: '改笔记' };
  const LINES = {
    hello: ['你好呀，我是小云～', '初次见面，请多关照！'],
    start: ['开始思考啦～', '让我想想…', '收到，马上开工！'],
    tool: name => TOOLS[name] ? [`正在${TOOLS[name]}…`, `${TOOLS[name]}中，稍等哦`] : [`正在用 ${name.slice(0, 16)}…`],
    approval: ['这一步需要你确认哦', '等你点头再继续～', '要批准这一步吗？'],
    stop: ['好的，停下来啦', '收到，已经停了'],
    done: ['完成啦！', '搞定～夸夸我', '任务完成，辛苦啦'],
    error: ['出错了…看看日志？', '呜，好像没成功', '别灰心，再试一次？'],
    pet: ['嘿嘿～', '好舒服～', '再摸一下！', '好痒呀'],
    fond: ['最喜欢你啦', '我们是好朋友了吧', '会一直陪着你哦'],
    wake: ['唔…我醒啦', '刚才打了个盹～'],
    limited: '额度用完啦，一起休息一下吧',
    quota: percent => `5 小时额度已用 ${percent}%，歇一会儿？`,
  };
  function chatter() {
    const hour = new Date().getHours();
    const now = hour < 5 ? ['夜深了，早点休息～', '还在忙吗？注意身体'] : hour < 11 ? ['早上好，今天也一起加油', '先喝杯水再开工吧'] : hour < 14 ? ['午饭吃了吗？', '中午记得休息一下'] : hour < 18 ? ['伸个懒腰吧～', '下午也要元气满满'] : ['晚上好，别熬太晚哦', '今天辛苦啦'];
    return pick([...now, '我在这儿陪着你', '服务器今天也很稳～', '点点我？']);
  }

  // Static artwork; every part a state needs is drawn once and switched on by CSS.
  const ART = `
<svg class="pet-art" viewBox="0 0 124 108" aria-hidden="true">
  <defs>
    <linearGradient id="pet-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dae6f5"/></linearGradient>
    <linearGradient id="pet-fill-gray" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1f3f6"/><stop offset="1" stop-color="#c3ccd8"/></linearGradient>
  </defs>
  <ellipse class="pet-shadow" cx="62" cy="100" rx="33" ry="4.5"/>
  <g class="pet-float">
    <g class="pet-squash">
      <path class="pet-cloud" d="M33,86 C17,86 8,74 10,61 C12,49 23,43 33,45 C36,29 49,19 64,20 C79,21 89,31 92,43 C105,40 117,50 115,64 C114,77 103,86 91,86 Z"/>
      <path class="pet-shine" d="M42,41 C45,34 51,29 58,27.5"/>
      <g class="opt on-idle on-thinking on-working on-approval on-error on-worried off-petted pet-eyes">
        <g class="pet-eye"><ellipse cx="50" cy="61" rx="4.4" ry="5.4"/><circle class="pet-glint" cx="51.7" cy="58.7" r="1.5"/></g>
        <g class="pet-eye"><ellipse cx="76" cy="61" rx="4.4" ry="5.4"/><circle class="pet-glint" cx="77.7" cy="58.7" r="1.5"/></g>
      </g>
      <g class="opt on-done on-petted pet-lines"><path d="M45.5,62.5 Q50,56 54.5,62.5"/><path d="M71.5,62.5 Q76,56 80.5,62.5"/></g>
      <g class="opt on-sleep pet-lines"><path d="M45.5,60.5 Q50,64.5 54.5,60.5"/><path d="M71.5,60.5 Q76,64.5 80.5,60.5"/></g>
      <g class="opt on-error on-worried pet-lines pet-brows"><path d="M44.5,53.5 L53.5,51"/><path d="M81.5,53.5 L72.5,51"/></g>
      <ellipse class="pet-blush" cx="41" cy="70" rx="5.6" ry="3.2"/>
      <ellipse class="pet-blush" cx="85" cy="70" rx="5.6" ry="3.2"/>
      <path class="opt on-idle on-thinking off-petted pet-lines" d="M58.5,69.5 Q63,74 67.5,69.5"/>
      <path class="opt on-done on-petted pet-grin" d="M56.5,68.5 Q63,78 69.5,68.5 Z"/>
      <ellipse class="opt on-working on-approval off-petted pet-mouth" cx="63" cy="71" rx="2.8" ry="3.3"/>
      <path class="opt on-error off-petted pet-lines" d="M58.5,73 Q63,68.5 67.5,73"/>
      <path class="opt on-worried off-petted pet-lines" d="M59,71.5 Q63,69.5 67,71.5"/>
      <ellipse class="opt on-sleep pet-mouth" cx="63" cy="71" rx="1.8" ry="1.4"/>
    </g>
    <g class="opt on-thinking pet-think"><circle cx="96" cy="29" r="2.3"/><circle cx="103" cy="20.5" r="3.1"/><circle cx="111.5" cy="10.5" r="4"/></g>
    <g class="opt on-working pet-gear"><circle cx="104" cy="22" r="6.5" fill="none" stroke-width="3.4" stroke-dasharray="2.6 2.5"/><circle cx="104" cy="22" r="2.4"/></g>
    <text class="opt on-approval pet-question" x="99" y="31">?</text>
    <g class="opt on-sleep pet-zzz"><text x="94" y="33">z</text><text x="102" y="23">Z</text><text x="111" y="12">Z</text></g>
    <path class="opt on-worried on-working pet-sweat" d="M95,37 C95,37 90.5,43.5 90.5,46.5 A4.5,4.5 0 0 0 99.5,46.5 C99.5,43.5 95,37 95,37 Z"/>
    <g class="opt on-error pet-rain"><path d="M45,90 l-2,6"/><path d="M62,91 l-2,6"/><path d="M79,90 l-2,6"/></g>
    <g class="opt on-done on-petted pet-sparkles"><path d="M14,32 Q14,38 20,38 Q14,38 14,44 Q14,38 8,38 Q14,38 14,32 Z"/><path d="M111,48 Q111,52.5 115.5,52.5 Q111,52.5 111,57 Q111,52.5 106.5,52.5 Q111,52.5 111,48 Z"/><path d="M24,14 Q24,17.5 27.5,17.5 Q24,17.5 24,21 Q24,17.5 20.5,17.5 Q24,17.5 24,14 Z"/></g>
  </g>
</svg>`;

  wb.ready().then(() => {
    const art = document.createElement('template');
    art.innerHTML = ART.trim();
    const text = h('span');
    const bubble = h('div', { class: 'pet-bubble', role: 'status', 'aria-live': 'polite' }, text);
    const body = h('button', { class: 'pet-body', type: 'button', 'aria-label': '摸摸小云' }, art.content);
    const badge = h('span', { class: 'pet-badge', 'aria-hidden': 'true' });
    const root = h('div', { class: 'pet', dataset: { state: 'idle' } }, bubble, body, badge);
    document.body.append(root);

    const memory = { affection: 0, pets: 0, firstMet: null };
    let mood = 'idle', busy = false, moodTimer = 0, bubbleTimer = 0, pettedTimer = 0, saveTimer = 0;
    let lastInteraction = Date.now(), lastSaid = Date.now(), lastToolLine = 0, nextChatter = 4 + Math.random() * 4, quotaWarned = false, limitWarned = false;

    // How long each mood lasts before settling, and what it settles into.
    const HOLD = { thinking: 3 * MINUTE, working: 5000, approval: 10 * MINUTE, done: 5200, error: 7000, worried: 8000 };
    function setMood(next) {
      clearTimeout(moodTimer);
      mood = next; root.dataset.state = next;
      if (HOLD[next]) moodTimer = setTimeout(() => setMood(next === 'working' || (next === 'worried' && busy) ? 'thinking' : 'idle'), HOLD[next]);
    }
    function say(line, ms = 4200) {
      text.textContent = line; bubble.classList.add('show'); lastSaid = Date.now();
      clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
    }
    function hearts(count) {
      for (let i = 0; i < count; i++) {
        const heart = h('span', { class: 'pet-heart', style: { left: `${38 + Math.random() * 60}%`, animationDelay: `${i * 120}ms` } }, '♥');
        heart.addEventListener('animationend', () => heart.remove());
        root.append(heart);
      }
    }
    function updateBadge() {
      badge.textContent = `♥ ${memory.affection}`;
      const days = memory.firstMet ? Math.max(1, Math.ceil((Date.now() - Date.parse(memory.firstMet)) / (24 * 60 * MINUTE))) : 1;
      body.title = `小云 · 好感 ${memory.affection} · 认识第 ${days} 天`;
    }
    const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { wb.storage.set(KEY, memory).catch(() => {}); }, 1200); };

    function pet() {
      const wasAsleep = mood === 'sleep';
      lastInteraction = Date.now();
      if (wasAsleep) setMood(busy ? 'thinking' : 'idle');
      memory.affection++; memory.pets++; save(); updateBadge();
      root.classList.remove('squish'); void root.offsetWidth; root.classList.add('squish');
      root.classList.add('petted'); clearTimeout(pettedTimer); pettedTimer = setTimeout(() => root.classList.remove('petted'), 1400);
      const milestone = memory.affection % 10 === 0;
      hearts(milestone ? 5 : 2);
      say(wasAsleep ? pick(LINES.wake) : milestone ? `好感已经 ${memory.affection} 啦！` : pick(memory.affection >= 30 && Math.random() < 0.5 ? LINES.fond : LINES.pet), 3000);
    }
    body.addEventListener('click', pet);
    wb.on('command', command => { if (command?.id === 'pet') pet(); });

    // Milestones carry a kind and, for tools, the tool name; never what the run is doing.
    wb.on('activity', event => {
      lastInteraction = Date.now();
      switch (event?.kind) {
        case 'start': busy = true; setMood('thinking'); say(pick(LINES.start)); break;
        case 'tool':
          busy = true; setMood('working');
          if (event.tool && Date.now() - lastToolLine > 8000) { lastToolLine = Date.now(); say(pick(LINES.tool(String(event.tool))), 3000); }
          break;
        case 'approval': setMood('approval'); say(pick(LINES.approval), 8000); break;
        case 'stop': busy = false; setMood('idle'); say(pick(LINES.stop)); break;
        case 'done': busy = false; setMood('done'); say(pick(LINES.done)); hearts(3); break;
        case 'error': busy = false; setMood('error'); say(pick(LINES.error), 6000); break;
      }
    });
    function checkQuota(usage) {
      if (usage?.rateLimited) { if (!limitWarned) { limitWarned = true; setMood('worried'); say(LINES.limited, 7000); } return; }
      limitWarned = false;
      const percent = usage?.fiveHour?.utilization;
      if (!finite(percent)) return;
      if (percent >= 80 && !quotaWarned) { quotaWarned = true; setMood('worried'); say(LINES.quota(Math.round(percent)), 8000); }
      else if (percent < 70) quotaWarned = false;
    }
    wb.on('usage', checkQuota);

    // Dozes off after ten quiet minutes; chats now and then while you are around.
    setInterval(() => {
      if (mood === 'idle' && !busy && Date.now() - lastInteraction > SLEEP_AFTER) setMood('sleep');
      if (wb.info.visible && mood === 'idle' && Date.now() - lastSaid > nextChatter * MINUTE) { nextChatter = 4 + Math.random() * 4; say(chatter()); }
    }, 30000);

    wb.storage.get(KEY).then(saved => {
      const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
      if (saved && typeof saved === 'object') Object.assign(memory, { affection: count(saved.affection), pets: count(saved.pets), firstMet: typeof saved.firstMet === 'string' && Number.isFinite(Date.parse(saved.firstMet)) ? saved.firstMet : null });
      const first = !memory.firstMet;
      if (first) { memory.firstMet = new Date().toISOString(); save(); }
      updateBadge();
      setTimeout(() => say(first ? pick(LINES.hello) : chatter()), 700);
    }).catch(() => { updateBadge(); });
    wb.usage.get().then(checkQuota, () => {});
  });
})();
