// Creates a starter plugin (or skin) in the workbench plugin directory, ready to enable from the workshop page.
//   npm run plugin:new -- my-plugin               a plugin with a panel, a dashboard widget and a command
//   npm run plugin:new -- my-skin --theme         a skin, starting from the default palette
//   npm run plugin:new -- my-plugin --dir ./src   somewhere else (the folder name must stay equal to the id)
// The plugin directory is <WORKBENCH_DATA>/plugins, or data/plugins next to this repository.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../lib/plugins.mjs';
import { THEMES, DEFAULT_THEME } from '../public/themes.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cwd = process.env.INIT_CWD || process.cwd();
const DOCS = 'https://github.com/qiuxinyuan321/cloud-ops-workbench/blob/main/docs/PLUGINS.md';
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

function parseArgs(argv) {
  const out = { id: null, theme: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--theme') out.theme = true;
    else if (arg === '--dir') out.dir = argv[++i] ?? '';
    else if (arg.startsWith('--dir=')) out.dir = arg.slice(6);
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else if (out.id) throw new Error('一次只能创建一个插件。');
    else out.id = arg;
  }
  if (!out.id) throw new Error('用法：npm run plugin:new -- <id> [--theme] [--dir 目录]\n例如：npm run plugin:new -- my-plugin');
  if (out.dir === '') throw new Error('--dir 需要一个目录。');
  return out;
}
const title = id => id.split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ').slice(0, 24);

function pluginFiles(id) {
  const name = title(id);
  const manifest = {
    id, name, version: '0.1.0', description: '我的第一个工作台插件。', author: '', license: 'MIT', engines: { workbench: `>=${version}` },
    icon: '🧩', tags: [], permissions: ['storage', 'ui.toast'], main: 'main.js', style: 'style.css',
    contributes: {
      panel: { title: name },
      widget: { title: name, height: 168 },
      commands: [{ id: 'hello', title: '打个招呼', subtitle: name, icon: 'sparkles' }],
    },
  };
  const main = `// ${name} · 由 npm run plugin:new 生成。完整文档：${DOCS}
// 插件运行在沙箱 iframe 里：没有网络、没有 Cookie，只能通过 window.workbench 调用你在 manifest.json 里申请的能力。
(() => {
  const wb = window.workbench, { h } = wb;

  // manifest.json 里声明的每个界面（这里是 panel 和 widget）都会各自加载一次这个脚本。
  async function main(info) {
    let count = (await wb.storage.get('count')) || 0;
    const value = h('strong', { class: 'demo-count' }, String(count));
    const render = () => { value.textContent = String(count); };
    const bump = () => { count += 1; render(); wb.storage.set('count', count); };

    const panel = info.surface === 'panel';
    document.body.append(h('div', { class: panel ? 'demo demo-panel' : 'demo' },
      panel ? h('span', { class: 'wb-eyebrow' }, 'Hello') : null,
      h(panel ? 'h1' : 'h3', null, \`你好，这里是「\${info.plugin.name}」\`),
      h('p', { class: 'wb-muted' }, \`当前界面：\${info.surface}。改完代码后，在「创意工坊 → 已安装」里点「重新加载」。\`),
      h('div', { class: 'wb-row' }, value, h('span', { class: 'wb-faint' }, '次点击 · 保存在插件存储里，所有界面同步')),
      h('div', { class: 'wb-row' },
        h('button', { class: 'wb-btn primary', type: 'button', onclick: bump }, '点我 +1'),
        h('button', { class: 'wb-btn', type: 'button', onclick: () => wb.ui.toast('来自插件的问候 👋').catch(() => {}) }, '弹个提示'))));

    // 另一个界面改了数据时同步过来。
    wb.on('storage:change', ({ key, value: next }) => { if (key === 'count') { count = next || 0; render(); } });
    // 命令面板（Ctrl/⌘ + K）里的「打个招呼」会发给这个插件的每个界面。
    wb.on('command', ({ id }) => { if (id === 'hello') wb.ui.toast('你好！命令收到了。').catch(() => {}); });
  }

  wb.ready().then(main);
})();
`;
  const style = `/* ${name} · 颜色全部用 --wb-* 变量，换皮肤时自动跟随。可用的组件类见文档里的「样式」一节。 */
.demo{display:flex;flex-direction:column;gap:10px}
.demo-panel{max-width:720px;margin:0 auto}
.demo-panel h1{margin:4px 0 2px}
.demo-count{font-size:28px;font-weight:680;letter-spacing:-.4px;color:var(--wb-brand);font-variant-numeric:tabular-nums}
`;
  const readme = `# ${name}

由 \`npm run plugin:new\` 生成的工作台插件。

- \`manifest.json\`：名称、版本、权限和界面（panel / widget / overlay / background）
- \`main.js\`：插件脚本，运行在隔离的沙箱 iframe 中
- \`style.css\`：样式，可直接使用 \`--wb-*\` 皮肤变量和 \`wb-card\`、\`wb-btn\` 等组件类

开发：在工作台的「创意工坊 → 开发」里点「重新扫描插件目录」，然后在「已安装」中启用。

分享：\`npm run plugin:pack -- ${id}\` 会生成一个 \`.json\` 插件包，可以在「开发」页导入，或提交到仓库的 \`workshop/\` 目录上架创意工坊。

文档：${DOCS}
`;
  return { manifest, files: { 'main.js': main, 'style.css': style, 'README.md': readme } };
}

function themeFiles(id) {
  const base = THEMES.find(theme => theme.id === DEFAULT_THEME);
  const manifest = {
    id, type: 'theme', name: title(id), version: '0.1.0', description: `基于默认皮肤「${base.name}」，改改颜色就是你的皮肤。`, author: '', license: 'MIT',
    engines: { workbench: `>=${version}` }, tags: [], theme: { scheme: base.scheme, tokens: base.tokens, terminal: base.terminal, editor: base.editor },
  };
  return { manifest, files: {} };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const { manifest, files } = args.theme ? themeFiles(args.id) : pluginFiles(args.id);
  validateManifest(manifest);
  const base = args.dir ? path.resolve(cwd, args.dir) : path.join(process.env.WORKBENCH_DATA || path.join(root, 'data'), 'plugins');
  const target = path.join(base, args.id);
  if (await fs.lstat(target).then(() => true, () => false)) throw new Error(`${target} 已存在，换一个 id 或先移走它。`);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(target, file), content, { flag: 'wx' });
  const kind = args.theme ? '皮肤' : '插件';
  console.log(`已创建${kind}「${manifest.name}」：${target}`);
  console.log(args.theme
    ? '  manifest.json  皮肤清单：theme.tokens 是界面颜色，terminal / editor 是终端和编辑器配色'
    : '  manifest.json  清单：名称、权限和界面\n  main.js        插件脚本（运行在沙箱 iframe 里）\n  style.css      样式（可直接使用 --wb-* 皮肤变量）');
  console.log(args.dir
    ? `\n下一步：开发时把它放进工作台的插件目录（${path.join(process.env.WORKBENCH_DATA || path.join(root, 'data'), 'plugins')}），或用 npm run plugin:pack 打包后导入。`
    : `\n下一步：打开工作台 → 创意工坊 → 开发，点「重新扫描插件目录」，${args.theme ? '然后在「皮肤」页选择它' : '然后在「已安装」中启用它'}。`);
  console.log(`文档：${DOCS}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
