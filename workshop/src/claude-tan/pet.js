// Claude 娘 · an illustrated chibi Claude who lives in a corner of the workbench. She reacts to run milestones (never
// their content), frets a little when the five-hour quota runs low, and remembers how often you patted her head.
// The art is a set of aligned frames: one full image per pose, plus small feathered patches (blink, mouth, expressions,
// a second waving hand) laid over the pose they were cut from, so swapping them never flickers the rest of her.
(() => {
  'use strict';
  const wb = window.workbench, { h } = wb;
  const SCRIPT = document.currentScript?.src || location.href;
  const sprite = name => new URL(`sprites/${name}.webp`, SCRIPT).href;
  const KEY = 'pet', MINUTE = 60000, SLEEP_AFTER = 10 * MINUTE;
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const between = (min, max) => min + Math.random() * (max - min);

  // Sprite sheet: 256×384 frames; patches are [pose they belong to, x, y, width, height] in frame pixels.
  const FRAME = [256, 384];
  const POSES = ['idle', 'wave', 'thinking', 'working', 'approval', 'cheer', 'sleep'];
  const PATCHES = {
    blink: ['idle', 81, 84, 101, 58], talk: ['idle', 123, 134, 22, 44], happy: ['idle', 77, 69, 105, 111], petted: ['idle', 80, 84, 102, 95],
    worried: ['idle', 82, 70, 95, 109], sad: ['idle', 80, 69, 120, 111], look: ['idle', 89, 104, 87, 76],
    'thinking-blink': ['thinking', 82, 79, 101, 64], 'working-blink': ['working', 81, 91, 101, 89], 'approval-blink': ['approval', 89, 77, 94, 65],
    wave2: ['wave', 32, 132, 86, 81],
    'thinking-talk': ['thinking', 108, 122, 40, 30], 'working-talk': ['working', 108, 122, 40, 31], 'approval-talk': ['approval', 108, 122, 43, 30],
  };
  const BLINKS = { idle: 'blink', thinking: 'thinking-blink', working: 'working-blink', approval: 'approval-blink' };
  const TALKS = { idle: 'talk', thinking: 'thinking-talk', working: 'working-talk', approval: 'approval-talk' };
  // Which pose and face each mood wears.
  const LOOKS = { idle: ['idle'], thinking: ['thinking'], working: ['working'], approval: ['approval'], done: ['cheer'], error: ['idle', 'sad'], worried: ['idle', 'worried'], sleep: ['sleep'] };

  const TOOLS = { Bash: '敲命令', Read: '读文件', Edit: '改代码', MultiEdit: '改代码', Write: '写文件', Grep: '翻代码', Glob: '找文件', WebFetch: '查资料', WebSearch: '上网搜', TodoWrite: '列计划', Task: '叫帮手', Agent: '叫帮手', Skill: '翻技能书', NotebookEdit: '改笔记本' };
  const LINES = {
    hello: ['你好，我是 Claude～请多指教', '初次见面！有什么我能帮忙的？'],
    back: ['欢迎回来～', '你来啦！今天也一起加油'],
    start: ['好，让我仔细想想…', '收到！先理一理思路', '开始干活啦～'],
    tool: name => TOOLS[name] ? [`正在${TOOLS[name]}…`, `${TOOLS[name]}中，马上就好`] : [`正在用 ${name.slice(0, 16)}…`],
    approval: ['这一步要你点头才行哦', '我不想擅自做主～请确认一下', '需要你批准一下这一步'],
    stop: ['好的，我停下来了', '收到，先停在这里'],
    done: ['完成啦！要检查一下吗？', '搞定～有问题随时叫我', '做完了！辛苦啦'],
    error: ['唔…出错了，看看日志？', '这次没成功，换个思路再试', '抱歉，好像哪里不对劲'],
    pet: ['诶嘿嘿～', '摸头…好舒服', '再、再摸一下也可以哦', '呀，好痒'],
    fond: ['能和你一起工作真开心', '最喜欢你啦！', '我会一直在这里帮你的'],
    cheer: ['你可以的！我陪着你', '一步一步来，不着急', '加油加油～', '累了就歇会儿，我等你'],
    wake: ['唔…我没睡着，只是在思考！', '啊，刚刚走神了～'],
    limited: '额度用完啦…一起喝杯茶等等吧',
    quota: percent => `5 小时额度已用 ${percent}%，歇一会儿？`,
  };
  const BONDS = [[100, '挚友'], [60, '默契'], [30, '信赖'], [10, '熟悉'], [0, '初识']];
  function chatter() {
    const hour = new Date().getHours();
    const now = hour < 5 ? ['夜深了，早点睡哦', '熬夜对身体不好的…'] : hour < 11 ? ['早上好！今天想做点什么？', '先喝杯水再开工吧'] : hour < 14 ? ['午饭吃了吗？', '午休一下效率更高哦'] : hour < 18 ? ['伸个懒腰吧～', '下午也一起加油'] : ['晚上好，别太累哦', '今天辛苦啦'];
    return pick([...now, '我在这儿陪着你', '不确定的地方我会直说的', '改完记得跑测试哦', '点点我？']);
  }

  // Effects drawn over the art; CSS places them per state.
  const FX = `
<svg class="ct-fx" viewBox="0 0 256 384" aria-hidden="true">
  <g class="ct-glint-at"><path class="ct-glint" d="M0,-12 Q1.5,-1.5 12,0 Q1.5,1.5 0,12 Q-1.5,1.5 -12,0 Q-1.5,-1.5 0,-12 Z"/></g>
  <g class="ct-think"><circle cx="48" cy="36" r="5"/><circle cx="31" cy="21" r="7.5"/><circle cx="13" cy="4" r="10"/></g>
  <text class="ct-question" x="206" y="40">?</text>
  <g class="ct-zzz"><text x="196" y="52">z</text><text x="212" y="34">Z</text><text x="230" y="14">Z</text></g>
  <g class="ct-gloom"><path d="M98,64 v20"/><path d="M108,62 v26"/><path d="M118,64 v20"/></g>
  <g class="ct-code"><text x="150" y="150">&lt;/&gt;</text><text x="176" y="150">{ }</text><text x="160" y="150">✻</text></g>
  <g class="ct-sparkles"><path d="M22,86 Q22,98 34,98 Q22,98 22,110 Q22,98 10,98 Q22,98 22,86 Z"/><path d="M236,78 Q236,88 246,88 Q236,88 236,98 Q236,88 226,88 Q236,88 236,78 Z"/><path d="M36,20 Q36,28 44,28 Q36,28 36,36 Q36,28 28,28 Q36,28 36,20 Z"/><path d="M226,160 Q226,168 234,168 Q226,168 226,176 Q226,168 218,168 Q226,168 226,160 Z"/></g>
</svg>`;

  wb.ready().then(() => {
    const percent = (value, total) => `${(value / total * 100).toFixed(3)}%`;
    const img = (name, cls, style) => h('img', { class: cls, src: sprite(name), alt: '', draggable: 'false', decoding: 'async', style });
    const poses = Object.fromEntries(POSES.map(name => [name, img(name, 'ct-pose')]));
    const patches = Object.fromEntries(Object.entries(PATCHES).map(([name, [, x, y, w, hgt]]) => [name, img(name, `ct-patch ct-patch-${name}`, { left: percent(x, FRAME[0]), top: percent(y, FRAME[1]), width: percent(w, FRAME[0]), height: percent(hgt, FRAME[1]) })]));
    const fx = document.createElement('template');
    fx.innerHTML = FX.trim();
    const text = h('span');
    const bubble = h('div', { class: 'ct-bubble', role: 'status', 'aria-live': 'polite' }, text);
    const art = h('div', { class: 'ct-art' }, ...Object.values(poses), ...Object.values(patches));
    const figure = h('div', { class: 'ct-figure' }, h('div', { class: 'ct-tilt' }, h('div', { class: 'ct-sway' }, art, fx.content)));
    const body = h('button', { class: 'ct-body', type: 'button', 'aria-label': '摸摸 Claude 娘的头' }, h('span', { class: 'ct-shadow' }), figure);
    const badge = h('span', { class: 'ct-badge', 'aria-hidden': 'true' });
    const root = h('div', { class: 'ct', dataset: { state: 'idle', pose: 'idle' } }, bubble, body, badge);
    document.body.append(root);

    const memory = { affection: 0, pets: 0, firstMet: null };
    let mood = 'idle', busy = false, moodTimer = 0, bubbleTimer = 0, saveTimer = 0, fadeTimer = 0;
    let lastInteraction = Date.now(), lastSaid = Date.now(), lastToolLine = 0, nextChatter = 4 + Math.random() * 4, quotaWarned = false, limitWarned = false;
    // Short-lived overrides that sit on top of the mood: [pose, face] and when they end.
    let override = null, overrideTimer = 0, pose = 'idle', face = null, transient = null;

    // Pose frames crossfade: the new one fades in above the old, which then drops away, so she never turns see-through.
    function showPose(next) {
      if (next === pose) return;
      const prev = poses[pose];
      for (const el of Object.values(poses)) el.classList.remove('prev');
      prev.classList.remove('on'); prev.classList.add('prev');
      poses[next].classList.add('on');
      pose = next; root.dataset.pose = next;
      clearTimeout(fadeTimer); fadeTimer = setTimeout(() => prev.classList.remove('prev'), 240);
    }
    function showFace(next) {
      if (next === face) return;
      if (face) patches[face].classList.remove('on');
      face = next && PATCHES[next][0] === pose ? next : null;
      if (face) { if (transient) flash(transient, false); patches[face].classList.add('on'); }
    }
    // A transient frame (blink, mouth, second wave hand) only shows when its pose is up and no expression covers it.
    function flash(name, on) {
      if (!on) { patches[name].classList.remove('on'); if (transient === name) transient = null; return true; }
      if (PATCHES[name][0] !== pose || face) return false;
      if (transient && transient !== name) patches[transient].classList.remove('on');
      transient = name; patches[name].classList.add('on');
      return true;
    }
    function render() {
      const [nextPose, nextFace = null] = override || LOOKS[mood] || LOOKS.idle;
      if (transient && PATCHES[transient][0] !== nextPose) flash(transient, false);
      showPose(nextPose); showFace(nextFace);
    }
    function overrideFor(look, ms) {
      override = look; clearTimeout(overrideTimer);
      overrideTimer = setTimeout(() => { override = null; render(); }, ms);
      render();
    }

    // How long each mood lasts before settling, and what it settles into.
    const HOLD = { thinking: 3 * MINUTE, working: 5000, approval: 10 * MINUTE, done: 5200, error: 7000, worried: 8000 };
    function setMood(next) {
      clearTimeout(moodTimer);
      mood = next; root.dataset.state = next;
      if (HOLD[next]) moodTimer = setTimeout(() => setMood(next === 'working' || (next === 'worried' && busy) ? 'thinking' : 'idle'), HOLD[next]);
      render();
    }

    // Her mouth moves while a line is on screen, in whichever pose she is in that has a mouth frame.
    let talkTimer = 0, mouth = null;
    function talk(ms) {
      clearInterval(talkTimer);
      const until = Date.now() + ms;
      talkTimer = setInterval(() => {
        const speaking = Date.now() < until;
        if (mouth || !speaking) { if (mouth) flash(mouth, false); mouth = null; if (!speaking) clearInterval(talkTimer); return; }
        const name = TALKS[pose];
        if (name && flash(name, true)) mouth = name;
      }, 140);
    }
    function say(line, ms = 4200) {
      text.textContent = line; bubble.classList.add('show'); lastSaid = Date.now();
      clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
      talk(Math.min(2600, Math.max(700, line.length * 110)));
    }
    let waveTimer = 0;
    function wave(ms = 2600) {
      overrideFor(['wave'], ms);
      clearInterval(waveTimer);
      let up = false;
      const until = Date.now() + ms - 200;
      waveTimer = setInterval(() => {
        if (Date.now() >= until) { clearInterval(waveTimer); flash('wave2', false); return; }
        up = !up; flash('wave2', up);
      }, 230);
    }
    function hearts(count) {
      for (let i = 0; i < count; i++) {
        const heart = h('span', { class: 'ct-heart', style: { left: `${30 + Math.random() * 40}%`, animationDelay: `${i * 120}ms` } }, '♥');
        heart.addEventListener('animationend', () => heart.remove());
        root.append(heart);
      }
    }
    const ONCE = { squish: 500, hop: 1400, shake: 500 }, onceTimers = {};
    function bounce(cls) {
      root.classList.remove(cls); void root.offsetWidth; root.classList.add(cls);
      clearTimeout(onceTimers[cls]); onceTimers[cls] = setTimeout(() => root.classList.remove(cls), ONCE[cls]);
    }
    function updateBadge() {
      badge.textContent = `♥ ${memory.affection}`;
      const days = memory.firstMet ? Math.max(1, Math.ceil((Date.now() - Date.parse(memory.firstMet)) / (24 * 60 * MINUTE))) : 1;
      const bond = BONDS.find(([min]) => memory.affection >= min)[1];
      body.title = `Claude 娘 · 好感 ${memory.affection}（${bond}）· 认识第 ${days} 天`;
    }
    const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { wb.storage.set(KEY, memory).catch(() => {}); }, 1200); };

    function pet() {
      const wasAsleep = mood === 'sleep';
      lastInteraction = Date.now();
      if (wasAsleep) setMood(busy ? 'thinking' : 'idle');
      memory.affection++; memory.pets++; save(); updateBadge();
      const milestone = memory.affection % 10 === 0;
      bounce('squish'); root.classList.add('petted');
      overrideFor(['idle', milestone ? 'happy' : 'petted'], 1500);
      setTimeout(() => root.classList.remove('petted'), 1500);
      hearts(milestone ? 5 : 2);
      say(wasAsleep ? pick(LINES.wake) : milestone ? `好感已经 ${memory.affection} 啦！` : pick(memory.affection >= 30 && Math.random() < 0.5 ? LINES.fond : LINES.pet), 3000);
    }
    function cheer() {
      lastInteraction = Date.now();
      overrideFor(['cheer'], 2600); bounce('hop'); hearts(3); say(pick(LINES.cheer));
    }
    body.addEventListener('click', pet);
    wb.on('command', command => { if (command?.id === 'pet') pet(); else if (command?.id === 'cheer') cheer(); });
    wb.on('visibility', state => root.classList.toggle('paused', state?.visible === false));
    const visible = () => wb.info?.visible !== false;

    // Blinks every few seconds (sometimes twice); now and then glances aside while idle.
    (function blinkLoop() {
      setTimeout(() => {
        const name = BLINKS[pose];
        if (visible() && name && flash(name, true)) {
          setTimeout(() => flash(name, false), 120);
          if (Math.random() < 0.2) setTimeout(() => { if (flash(name, true)) setTimeout(() => flash(name, false), 110); }, 280);
        }
        blinkLoop();
      }, between(2200, 5600));
    })();
    (function lookLoop() {
      setTimeout(() => {
        if (visible() && mood === 'idle' && !override && !transient) overrideFor(['idle', 'look'], between(1200, 2200));
        lookLoop();
      }, between(18000, 40000));
    })();

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
        case 'done': busy = false; setMood('done'); bounce('hop'); say(pick(LINES.done)); hearts(3); break;
        case 'error': busy = false; setMood('error'); bounce('shake'); say(pick(LINES.error), 6000); break;
      }
    });
    function checkQuota(usage) {
      if (usage?.rateLimited) { if (!limitWarned) { limitWarned = true; setMood('worried'); say(LINES.limited, 7000); } return; }
      limitWarned = false;
      const used = usage?.fiveHour?.utilization;
      if (!finite(used)) return;
      if (used >= 80 && !quotaWarned) { quotaWarned = true; setMood('worried'); say(LINES.quota(Math.round(used)), 8000); }
      else if (used < 70) quotaWarned = false;
    }
    wb.on('usage', checkQuota);

    // Dozes off after ten quiet minutes; chats now and then while you are around.
    setInterval(() => {
      if (mood === 'idle' && !busy && Date.now() - lastInteraction > SLEEP_AFTER) setMood('sleep');
      if (visible() && mood === 'idle' && !override && Date.now() - lastSaid > nextChatter * MINUTE) { nextChatter = 4 + Math.random() * 4; say(chatter()); }
    }, 30000);

    poses.idle.classList.add('on');
    wb.storage.get(KEY).then(saved => {
      const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
      if (saved && typeof saved === 'object') Object.assign(memory, { affection: count(saved.affection), pets: count(saved.pets), firstMet: typeof saved.firstMet === 'string' && Number.isFinite(Date.parse(saved.firstMet)) ? saved.firstMet : null });
      const first = !memory.firstMet;
      if (first) { memory.firstMet = new Date().toISOString(); save(); }
      updateBadge();
      setTimeout(() => { wave(); say(pick(first ? LINES.hello : LINES.back)); }, 700);
    }).catch(() => { updateBadge(); });
    wb.usage.get().then(checkQuota, () => {});
  });
})();
