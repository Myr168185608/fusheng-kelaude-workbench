import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marked } from 'marked';

// healMarkdown runs in the page (public/app.js); load it with the marked options the page uses.
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function healMarkdown('), end = app.indexOf('\n}\n', start) + 2;
const options = new Function(`return ${app.match(/const markdownOptions = (\{[^;]*\});/)[1]}`)();
globalThis.marked = marked; globalThis.markdownOptions = options;
const healMarkdown = new Function(`${app.slice(start, end)}; return healMarkdown;`)();
const visible = md => marked.parse(md, options).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, '');

test('healMarkdown closes unfinished syntax and holds back what has no final form yet', () => {
  const cases = [
    ['Hello **wor', 'Hello **wor**'], ['Use `npm', 'Use `npm`'], ['see [docs](https://exa', 'see docs'], ['- ', ''], ['Item:\n1', 'Item:\n'],
    ['```js\nconst a', '```js\nconst a'], ['```js\ncode\n``', '```js\ncode\n'], ['2 * 3 = 6', '2 * 3 = 6'], ['**bold*', '**bold**'], ['Hello **', 'Hello '],
    ['**b ~~d', '**b ~~d~~**'], ['看数据：**渲', '看数据：**渲**'], ['」*强调', '」*强调*'], ['a*b', 'a*b'], ['a_b_c', 'a_b_c'], ['_em', '_em_'],
    ['| 指标 | 之前 |', ''], ['Text\n| a | b |\n|---|', 'Text\n'], ['| a | b |\n|---|-', '| a | b |\n|---|-'], ['| a | b |\n|---|---|\n| 1', '| a | b |\n|---|---|\n| 1'],
    ['- [x]', ''], ['or ![', 'or '], ['见 <https://exa', '见 '], ['Use `arr[0', 'Use `arr[0`'], ['``a`b`', '``a`b``'], ['**`ser', '**`ser`**'],
  ];
  for (const [input, expected] of cases) assert.equal(healMarkdown(input), expected, JSON.stringify(input));
});

test('every streamed prefix of a reply only adds visible text', () => {
  const reply = [
    '## 修复方案', '', '我检查了 `server.mjs` 和 **lib/live.mjs**，问题出在 *批量合并* 的时序上，~~旧方案~~已移除。', '',
    '1. 先读取配置', '2. 然后修改 `lib/state.mjs:48`', '   - 嵌套项 **A**', '   - 嵌套项 B', '10. 最后运行测试', '',
    '> 注意：不要直接重启服务。', '> 需要先备份。', '', '| 文件 | 改动 | 说明 |', '|---|:---:|---:|', '| `app.js` | +120 | **渲染** |', '| styles.css | -40 | 样式 |', '',
    '```js', 'function hello(name) {', '  return `hi ${name}`;', '}', '```', '',
    'English with a [link](https://example.com/docs?a=1), an image ![x](y.png), <kbd>Ctrl</kbd> and ``a`b`` code.', '',
    '见 <https://example.com>，CJK「引号」*强调*结束，a_b_c 与 __strong__、_em_，2 * 3 = 6。', '',
    '- [ ] 待办', '- [x] 已完成', '', 'Title', '=====', '', '***', '', '最后一段', '第二行。',
  ].join('\n');
  let shown = '';
  for (let n = 1; n <= reply.length; n++) {
    const now = visible(n === reply.length ? reply : healMarkdown(reply.slice(0, n)));
    assert.ok(now.startsWith(shown), `after ${JSON.stringify(reply.slice(Math.max(0, n - 30), n))}: ${JSON.stringify(shown.slice(-20))} -> ${JSON.stringify(now.slice(-20))}`);
    shown = now;
  }
});
