// Workbench skins: built-in palettes plus the runtime that applies a skin to the page, the terminal and the editor.
// Pure data at module level so the server can import the token names to validate community skins.

export const CORE_TOKENS = ['bg', 'bg-2', 'surface', 'surface-2', 'sunken', 'line', 'line-2', 'ink', 'ink-2', 'ink-3', 'ink-4', 'ink-5', 'brand', 'brand-2', 'brand-3', 'brand-4', 'brand-soft', 'brand-tint', 'brand-line', 'on-brand', 'amber', 'amber-2', 'amber-soft', 'amber-line', 'red', 'red-soft', 'red-line', 'blue', 'blue-soft', 'ok', 'side-0', 'side', 'side-2', 'side-3', 'side-line', 'side-ink', 'side-ink-2', 'side-ink-3', 'side-accent', 'side-ok', 'side-warn', 'side-bad', 'code-bg', 'code-ink', 'code-line', 'code-accent', 'code-muted', 'term-bg', 'term-bar', 'term-ink', 'term-ink-2', 'term-ink-3', 'term-accent', 'term-bad', 'term-warn', 'shadow', 'modified'];
// Defined in styles.css from the core palette; a skin may still override any of them.
export const DERIVED_TOKENS = ['focus', 'focus-line', 'selection', 'track', 'grid', 'scroll', 'bubble', 'bubble-2', 'bubble-line', 'glass', 'backdrop', 'think-bg', 'think-line', 'think-ink', 'think-accent', 'diff-add', 'diff-add-ink', 'diff-del', 'diff-del-ink', 'grad-ok', 'grad-warn', 'grad-danger', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'sh-1', 'sh-2', 'sh-3'];
export const TOKENS = [...CORE_TOKENS, ...DERIVED_TOKENS];
export const TERMINAL_KEYS = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
export const EDITOR_KEYS = ['background', 'foreground', 'lineHighlight', 'lineNumber', 'lineNumberActive', 'selection', 'inactiveSelection', 'cursor', 'indentGuide', 'comment', 'keyword', 'string', 'number', 'type', 'diffAdd', 'diffAddBg', 'diffDel', 'diffHunk', 'diffMeta'];
// Tokens a plugin frame receives as --wb-* variables.
export const PLUGIN_TOKENS = ['bg', 'bg-2', 'surface', 'surface-2', 'sunken', 'line', 'line-2', 'ink', 'ink-2', 'ink-3', 'ink-4', 'ink-5', 'brand', 'brand-2', 'brand-3', 'brand-4', 'brand-soft', 'brand-tint', 'brand-line', 'on-brand', 'amber', 'amber-2', 'amber-soft', 'red', 'red-soft', 'blue', 'blue-soft', 'ok', 'focus', 'selection', 'track', 'grid', 'shadow', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'grad-ok', 'grad-warn', 'grad-danger', 'side', 'side-ink', 'side-accent', 'code-bg', 'code-ink', 'code-accent', 'sh-1', 'sh-2'];

const pairs = text => Object.fromEntries(text.trim().split(/\s+(?=[a-zA-Z0-9-]+:)/).map(pair => { const i = pair.indexOf(':'); return [pair.slice(0, i), pair.slice(i + 1).trim()]; }));
const skin = (id, name, scheme, description, tokens, terminal, editor = '') => ({ id, name, scheme, description, source: 'builtin', tokens: pairs(tokens), terminal: pairs(terminal), editor: editor ? pairs(editor) : {} });

export const THEMES = [
  skin('spruce', '云杉', 'light', '默认 · 松针绿配暖白纸面，安静耐看',
    'bg:#f6f5f0 bg-2:#efeee7 surface:#fffefb surface-2:#fafaf6 sunken:#f1f2ec line:#e4e5dd line-2:#d7dad0 ink:#1c2a26 ink-2:#3b4943 ink-3:#5b6861 ink-4:#858f88 ink-5:#aab1ab brand:#2f6a52 brand-2:#255845 brand-3:#1b4234 brand-4:#82b897 brand-soft:#e3eee6 brand-tint:#f0f6f1 brand-line:#c6dbcd on-brand:#ffffff amber:#9a6214 amber-2:#c98a2e amber-soft:#fbf2df amber-line:#ebd4a4 red:#ad4537 red-soft:#fbebe7 red-line:#efcbc2 blue:#2e6482 blue-soft:#e8f1f6 ok:#5fb184 side-0:#0b1c1d side:#14282a side-2:#1a3234 side-3:#23403f side-line:#0b1a1b side-ink:#dde8e1 side-ink-2:#a3b8ad side-ink-3:#71897d side-accent:#a9cdb2 side-ok:#7bc493 side-warn:#e3b25a side-bad:#de7a68 code-bg:#16241f code-ink:#d5e3d1 code-line:#23362e code-accent:#83c79a code-muted:#86a58f term-bg:#14231f term-bar:#1a2d27 term-ink:#d6e8cf term-ink-2:#c3d6bc term-ink-3:#7f9d89 term-accent:#7fbf95 term-bad:#e0907d term-warn:#e7cd8f shadow:#1a2b24 modified:#c97f45',
    'background:#14231f foreground:#dbe7d6 cursor:#a9d4b4 selectionBackground:#8db27844 black:#24362f red:#e0907d green:#9fd1a4 yellow:#e2c98e blue:#8fb6c4 magenta:#c4a8c6 cyan:#94c9b6 white:#e6eee2 brightBlack:#5d7568'),
  skin('ink-night', '墨夜', 'dark', '深色 · 墨绿夜色，适合长时间值守',
    'bg:#0f1513 bg-2:#0b100e surface:#151d1a surface-2:#121916 sunken:#0c110f line:#222c28 line-2:#2d3933 ink:#e3ebe6 ink-2:#c2cdc7 ink-3:#97a49d ink-4:#6f7d76 ink-5:#526058 brand:#62c99b brand-2:#3f9e75 brand-3:#a8e5c8 brand-4:#4a8f6f brand-soft:#183026 brand-tint:#13231d brand-line:#2a4d3e on-brand:#04130c amber:#e2b467 amber-2:#d39b40 amber-soft:#29231a amber-line:#4b3e24 red:#ee8c7c red-soft:#2d1b18 red-line:#582f28 blue:#83b8d9 blue-soft:#15232c ok:#5fc597 side-0:#060908 side:#0a0f0d side-2:#101815 side-3:#17221e side-line:#040706 side-ink:#dbe6df side-ink-2:#9db2a6 side-ink-3:#65786d side-accent:#8ed3b0 side-ok:#6fd19c side-warn:#e8bb62 side-bad:#ee8c7c code-bg:#0a0f0d code-ink:#d3e2d8 code-line:#1c2723 code-accent:#7fd3a2 code-muted:#6e8a7b term-bg:#090d0c term-bar:#0f1613 term-ink:#d4e5d8 term-ink-2:#b4c8b9 term-ink-3:#6b8578 term-accent:#6fd19c term-bad:#ee8c7c term-warn:#e8c77d shadow:#000000 modified:#e0995b',
    'background:#090d0c foreground:#d4e5d8 cursor:#6fd19c selectionBackground:#6fd19c40 black:#1a2420 red:#ee8c7c green:#7fd3a2 yellow:#e8c77d blue:#83b8d9 magenta:#c9a6d6 cyan:#7fcfc4 white:#e3ebe6 brightBlack:#55675e',
    'keyword:#7fd3a2 string:#e2b467 number:#83b8d9 type:#a8e5c8'),
  skin('rice-paper', '宣纸', 'light', '浅色 · 米黄宣纸配黛青，温润护眼',
    'bg:#f3ecdd bg-2:#ebe2cf surface:#fbf7ee surface-2:#f7f1e5 sunken:#eee6d5 line:#e3d9c4 line-2:#d6c9af ink:#2c261f ink-2:#4a4136 ink-3:#6b6052 ink-4:#918571 ink-5:#b4a891 brand:#2f5d62 brand-2:#264e52 brand-3:#1b3a3d brand-4:#82a8a4 brand-soft:#e1e6dc brand-tint:#f0efe5 brand-line:#c2cfc5 on-brand:#fbf7ee amber:#8c5913 amber-2:#bd8834 amber-soft:#f6e9cb amber-line:#e3c991 red:#a33b2b red-soft:#f6e4da red-line:#e8c3b4 blue:#3c5d78 blue-soft:#e6eae4 ok:#5c9a6e side-0:#18120e side:#2a221b side-2:#332a21 side-3:#3e3328 side-line:#16110d side-ink:#efe4d1 side-ink-2:#c1b198 side-ink-3:#8b7b64 side-accent:#dcbc8b side-ok:#a3c98f side-warn:#e7b65e side-bad:#e38c74 code-bg:#29231d code-ink:#ece1cb code-line:#3a3229 code-accent:#dcb36c code-muted:#a39177 term-bg:#221d18 term-bar:#2a241e term-ink:#ede1c9 term-ink-2:#d3c5aa term-ink-3:#9b8b71 term-accent:#dcb36c term-bad:#e38c74 term-warn:#e7c47c shadow:#3a2a1a modified:#b8692e',
    'background:#221d18 foreground:#ede1c9 cursor:#dcb36c selectionBackground:#dcb36c40 black:#3a3229 red:#e38c74 green:#a9c98f yellow:#e7c47c blue:#8fb0c7 magenta:#c9a0b4 cyan:#95c2b4 white:#efe4d1 brightBlack:#7a6b57',
    'keyword:#2f5d62 string:#8c5913 number:#a33b2b type:#3c5d78 comment:#9b8f7a'),
  skin('celadon', '青瓷', 'light', '浅色 · 雨过天青的釉色，清透冷静',
    'bg:#edf3f0 bg-2:#e3ebe7 surface:#f9fbfa surface-2:#f3f7f5 sunken:#e7eeea line:#d8e2dd line-2:#c7d5ce ink:#1c2b2a ink-2:#384947 ink-3:#566765 ink-4:#7f8f8c ink-5:#a8b5b2 brand:#2b7a73 brand-2:#22645e brand-3:#174744 brand-4:#7db8af brand-soft:#dbebe7 brand-tint:#ecf5f2 brand-line:#b7d7d0 on-brand:#f5fbf9 amber:#92611a amber-2:#c3913c amber-soft:#f8efdb amber-line:#e6d1a2 red:#ad4944 red-soft:#f8e7e5 red-line:#ebc7c3 blue:#2e6a8b blue-soft:#e2eef3 ok:#4ea88b side-0:#0b1c1b side:#163030 side-2:#1c3a39 side-3:#254747 side-line:#0c1e1d side-ink:#dbebe7 side-ink-2:#9ebcb5 side-ink-3:#6a8a84 side-accent:#9ed4c7 side-ok:#73c9a7 side-warn:#e2b55d side-bad:#e07f71 code-bg:#132625 code-ink:#d2e6e0 code-line:#203836 code-accent:#7ed0bc code-muted:#7ea29a term-bg:#112220 term-bar:#172b28 term-ink:#d3e8e1 term-ink-2:#bbd5ce term-ink-3:#799b93 term-accent:#73c9a7 term-bad:#e38f7e term-warn:#e5cb89 shadow:#132a28 modified:#c97f45',
    'background:#112220 foreground:#d3e8e1 cursor:#73c9a7 selectionBackground:#73c9a740 black:#1f3533 red:#e38f7e green:#86d1b0 yellow:#e5cb89 blue:#8ab9d4 magenta:#c3a8cc cyan:#7fd0bf white:#e2efeb brightBlack:#5b7b75',
    'keyword:#22645e string:#8c5a14 number:#ad4944 type:#2e6a8b'),
  skin('sakura', '樱', 'light', '浅色 · 樱花粉与梅紫，柔和明亮',
    'bg:#fbf3f4 bg-2:#f4e8ea surface:#fffbfb surface-2:#fdf6f7 sunken:#f7ebed line:#eedee1 line-2:#e3cdd2 ink:#2e2228 ink-2:#4b3c43 ink-3:#6c5a62 ink-4:#958288 ink-5:#bba8ae brand:#b4517a brand-2:#9b4066 brand-3:#742f4c brand-4:#df99b5 brand-soft:#f8e2ea brand-tint:#fcf0f4 brand-line:#ecc5d3 on-brand:#fff8fa amber:#94601a amber-2:#cb8e3a amber-soft:#fbf0de amber-line:#ebd1a3 red:#b13d3d red-soft:#fbe5e3 red-line:#efc5c0 blue:#4a6995 blue-soft:#ebeff7 ok:#59a881 side-0:#1b1118 side:#2b1c26 side-2:#35232f side-3:#422c3a side-line:#190f16 side-ink:#f4e3eb side-ink-2:#c8a8b7 side-ink-3:#927482 side-accent:#f1b2ca side-ok:#8ed0ac side-warn:#edbb6a side-bad:#ee8e8e code-bg:#2a1c24 code-ink:#f0dfe7 code-line:#3a2933 code-accent:#f1a5c3 code-muted:#af8f9e term-bg:#24191f term-bar:#2d1f28 term-ink:#f1e1e9 term-ink-2:#dbc5d0 term-ink-3:#a38795 term-accent:#f1a5c3 term-bad:#ef948e term-warn:#eece8e shadow:#3a2230 modified:#cf7749',
    'background:#24191f foreground:#f1e1e9 cursor:#f1a5c3 selectionBackground:#f1a5c340 black:#3a2932 red:#ef948e green:#9bd1b0 yellow:#eece8e blue:#a3b5e0 magenta:#f1a5c3 cyan:#9fd0d0 white:#f4e7ed brightBlack:#7d6270',
    'keyword:#9b4066 string:#3f7d5e number:#94601a type:#4a6995'),
  skin('aurora', '极光', 'dark', '深色 · 极地夜空里流动的青紫光带',
    'bg:#0c111e bg-2:#090d18 surface:#121929 surface-2:#101625 sunken:#0a0f1b line:#212b40 line-2:#2b374e ink:#e5ebf6 ink-2:#c3cddf ink-3:#97a3ba ink-4:#6e7a92 ink-5:#505b72 brand:#5de0b4 brand-2:#3cbd93 brand-3:#a8f2d7 brand-4:#7c8cff brand-soft:#132f2c brand-tint:#102225 brand-line:#225049 on-brand:#03130e amber:#f2c46d amber-2:#dfa84a amber-soft:#2b2518 amber-line:#4e4124 red:#ff8fa3 red-soft:#301829 red-line:#592a42 blue:#8fb8ff blue-soft:#16213c ok:#5de0b4 side-0:#04070e side:#090e1a side-2:#0f1628 side-3:#172036 side-line:#050911 side-ink:#dee6f4 side-ink-2:#9daac5 side-ink-3:#65708b side-accent:#b39bff side-ok:#5de0b4 side-warn:#f2c46d side-bad:#ff8fa3 code-bg:#090e1a code-ink:#d7e1f1 code-line:#1b253e code-accent:#9c8bff code-muted:#6e7e9e term-bg:#070b16 term-bar:#0d1323 term-ink:#d7e1f1 term-ink-2:#b4c1d7 term-ink-3:#6b7995 term-accent:#5de0b4 term-bad:#ff8fa3 term-warn:#f2c46d shadow:#000000 modified:#f0a35e grad-ok:linear-gradient(90deg,#9c8bff,#5de0b4)',
    'background:#070b16 foreground:#d7e1f1 cursor:#5de0b4 selectionBackground:#9c8bff44 black:#161e33 red:#ff8fa3 green:#5de0b4 yellow:#f2c46d blue:#8fb8ff magenta:#b39bff cyan:#6fe3e8 white:#e5ebf6 brightBlack:#56627e',
    'keyword:#b39bff string:#5de0b4 number:#f2c46d type:#8fb8ff'),
  skin('neon', '赛博', 'dark', '深色 · 霓虹洋红与电光青，高能夜场',
    'bg:#0b0a12 bg-2:#08070e surface:#13111d surface-2:#100e19 sunken:#0a0911 line:#251f37 line-2:#302947 ink:#f0ecff ink-2:#cec6ea ink-3:#a198c2 ink-4:#766c97 ink-5:#554c73 brand:#ff4fd8 brand-2:#df3abd brand-3:#ffb3ee brand-4:#3be8ff brand-soft:#2d1330 brand-tint:#1e0f23 brand-line:#592154 on-brand:#15020e amber:#ffd25a amber-2:#f2b632 amber-soft:#2a2312 amber-line:#53441b red:#ff5f7a red-soft:#31111c red-line:#601f39 blue:#3be8ff blue-soft:#0e2530 ok:#39f5a5 side-0:#040307 side:#08070e side-2:#100e1a side-3:#191527 side-line:#050409 side-ink:#ece6ff side-ink-2:#a69ccb side-ink-3:#6b628f side-accent:#3be8ff side-ok:#39f5a5 side-warn:#ffd25a side-bad:#ff5f7a code-bg:#07060c code-ink:#e6e0ff code-line:#1c1730 code-accent:#3be8ff code-muted:#7a70a3 term-bg:#06050b term-bar:#0d0b16 term-ink:#e6e0ff term-ink-2:#c3b9e8 term-ink-3:#7a70a3 term-accent:#39f5a5 term-bad:#ff5f7a term-warn:#ffd25a shadow:#000000 modified:#ff9f43 grad-ok:linear-gradient(90deg,#3be8ff,#ff4fd8)',
    'background:#06050b foreground:#e6e0ff cursor:#ff4fd8 selectionBackground:#ff4fd840 black:#1a1628 red:#ff5f7a green:#39f5a5 yellow:#ffd25a blue:#6f8cff magenta:#ff4fd8 cyan:#3be8ff white:#f0ecff brightBlack:#5e5680',
    'keyword:#ff4fd8 string:#39f5a5 number:#ffd25a type:#3be8ff'),
  skin('phosphor', '磷光', 'dark', '深色 · 复古 CRT 终端的磷光绿',
    'bg:#070b07 bg-2:#050805 surface:#0c120c surface-2:#0a0f0a sunken:#060906 line:#1a261a line-2:#243424 ink:#c6f5c6 ink-2:#a4d9a4 ink-3:#7eb27e ink-4:#5b875b ink-5:#426342 brand:#4dff88 brand-2:#2ed66a brand-3:#b8ffd0 brand-4:#2a9a52 brand-soft:#0f2a17 brand-tint:#0b1d10 brand-line:#1d4a2b on-brand:#021006 amber:#ffc252 amber-2:#f0a830 amber-soft:#241c0c amber-line:#4a3714 red:#ff6b5a red-soft:#2a0f0c red-line:#552019 blue:#6fd3ff blue-soft:#0c1e26 ok:#4dff88 side-0:#020302 side:#040704 side-2:#0a100a side-3:#111a11 side-line:#020302 side-ink:#c6f5c6 side-ink-2:#85b885 side-ink-3:#4f754f side-accent:#4dff88 side-ok:#4dff88 side-warn:#ffc252 side-bad:#ff6b5a code-bg:#040704 code-ink:#b9f0b9 code-line:#142014 code-accent:#4dff88 code-muted:#5f8f5f term-bg:#030603 term-bar:#081008 term-ink:#b9f0b9 term-ink-2:#95d095 term-ink-3:#578457 term-accent:#4dff88 term-bad:#ff6b5a term-warn:#ffc252 shadow:#000000 modified:#ffb347',
    'background:#030603 foreground:#b9f0b9 cursor:#4dff88 selectionBackground:#4dff8840 black:#0f1a0f red:#ff6b5a green:#4dff88 yellow:#ffc252 blue:#6fd3ff magenta:#d78bff cyan:#5ff5d8 white:#c6f5c6 brightBlack:#3f5f3f',
    'keyword:#4dff88 string:#b8ffd0 number:#ffc252 type:#6fd3ff comment:#4f754f'),
  skin('high-contrast', '高对比', 'light', '无障碍 · 纯黑白与强蓝，清晰优先',
    'bg:#ffffff bg-2:#f0f0f0 surface:#ffffff surface-2:#f7f7f7 sunken:#eeeeee line:#767676 line-2:#4d4d4d ink:#000000 ink-2:#141414 ink-3:#2b2b2b ink-4:#474747 ink-5:#666666 brand:#0039b3 brand-2:#002f94 brand-3:#001f63 brand-4:#5b86e5 brand-soft:#dce6fb brand-tint:#eef3fd brand-line:#6f8fd9 on-brand:#ffffff amber:#6b4100 amber-2:#9a5c00 amber-soft:#fff0d1 amber-line:#b98a33 red:#a3001c red-soft:#ffe3e8 red-line:#d0687a blue:#0039b3 blue-soft:#dce6fb ok:#007a45 side-0:#000000 side:#000000 side-2:#161616 side-3:#2a2a2a side-line:#5c5c5c side-ink:#ffffff side-ink-2:#e6e6e6 side-ink-3:#bdbdbd side-accent:#ffd400 side-ok:#3ddc84 side-warn:#ffd400 side-bad:#ff7a7a code-bg:#000000 code-ink:#ffffff code-line:#5c5c5c code-accent:#ffd400 code-muted:#cccccc term-bg:#000000 term-bar:#161616 term-ink:#ffffff term-ink-2:#ededed term-ink-3:#bdbdbd term-accent:#3ddc84 term-bad:#ff7a7a term-warn:#ffd400 shadow:#000000 modified:#a34a00 focus:#0039b3 focus-line:#0039b3 selection:#b9cdfa',
    'background:#000000 foreground:#ffffff cursor:#ffd400 selectionBackground:#ffd40055 black:#000000 red:#ff7a7a green:#3ddc84 yellow:#ffd400 blue:#7aa7ff magenta:#ff8cf0 cyan:#5ff0ff white:#ffffff brightBlack:#a0a0a0',
    'keyword:#0039b3 string:#006b3c number:#a3001c type:#5a00b3 comment:#474747'),
];
export const DEFAULT_THEME = 'spruce';
// "Follow system" pairs a light and a dark skin.
export const AUTO_THEMES = { light: 'spruce', dark: 'ink-night' };
export const PREF_KEY = 'cloud-ops-workbench-theme-pref';
export const CACHE_KEY = 'cloud-ops-workbench-theme';

/* ---------- Browser runtime ---------- */
const local = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch {} } };
let probe, canvas;
// Any CSS color (var(), color-mix(), oklch()…) to #rrggbb[aa]: Monaco and xterm only take hex.
export function cssToHex(value, fallback = '#000000') {
  try {
    probe ||= Object.assign(document.createElement('span'), { hidden: true });
    if (!probe.isConnected) document.documentElement.append(probe);
    probe.style.color = ''; probe.style.color = value;
    if (!probe.style.color) return fallback;
    const computed = getComputedStyle(probe).color;
    canvas ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = fallback; ctx.fillStyle = computed; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}${a < 255 ? a.toString(16).padStart(2, '0') : ''}`;
  } catch { return fallback; }
}
const opaque = color => color.slice(0, 7);
export function xtermTheme(theme) {
  const t = theme?.terminal || {}, base = THEMES[0].terminal;
  const accent = opaque(cssToHex('var(--term-accent)', '#7fbf95'));
  return { ...base, background: cssToHex('var(--term-bg)', base.background), foreground: cssToHex('var(--term-ink)', base.foreground), cursor: accent, cursorAccent: cssToHex('var(--term-bg)', base.background), selectionBackground: `${accent}44`, ...t };
}
export function monacoTheme(theme) {
  const e = theme?.editor || {}, dark = theme?.scheme === 'dark';
  const pick = (key, css, fallback) => e[key] || cssToHex(css, fallback);
  const fg = color => opaque(color).slice(1);
  const syntax = ['keyword', 'string', 'number', 'type'].filter(key => e[key]).map(key => ({ token: key, foreground: fg(e[key]) }));
  return {
    base: dark ? 'vs-dark' : 'vs', inherit: true,
    rules: [{ token: 'comment', foreground: fg(pick('comment', 'var(--ink-4)', '#858f88')), fontStyle: 'italic' }, ...syntax, { token: 'diff.add', foreground: fg(pick('diffAdd', 'var(--diff-add-ink)', '#1f6b3d')), background: fg(pick('diffAddBg', 'var(--diff-add)', '#e9f6ec')) }, { token: 'diff.del', foreground: fg(pick('diffDel', 'var(--diff-del-ink)', '#94382c')) }, { token: 'diff.hunk', foreground: fg(pick('diffHunk', 'var(--blue)', '#2e6482')), fontStyle: 'bold' }, { token: 'diff.meta', foreground: fg(pick('diffMeta', 'var(--ink-4)', '#858f88')) }],
    colors: {
      'editor.background': pick('background', 'var(--surface)', '#fffefb'), 'editor.foreground': pick('foreground', 'var(--ink)', '#1c2a26'), 'editorGutter.background': pick('background', 'var(--surface)', '#fffefb'),
      'editor.lineHighlightBackground': pick('lineHighlight', 'color-mix(in srgb,var(--brand-tint) 75%,var(--surface))', '#f2f6f0'), 'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': pick('lineNumber', 'var(--ink-5)', '#b5bdb3'), 'editorLineNumber.activeForeground': pick('lineNumberActive', 'var(--brand)', '#2f6a52'),
      'editor.selectionBackground': pick('selection', 'var(--selection)', '#cfe2d5'), 'editor.inactiveSelectionBackground': pick('inactiveSelection', 'var(--brand-soft)', '#e3ece5'),
      'editorCursor.foreground': pick('cursor', 'var(--brand)', '#2f6a52'), 'editorIndentGuide.background1': pick('indentGuide', 'var(--grid)', '#eef0ea'),
      'editorWidget.background': cssToHex('var(--surface)', '#fffefb'), 'editorWidget.border': cssToHex('var(--line)', '#e4e5dd'), 'scrollbarSlider.background': `${opaque(cssToHex('var(--scroll)', '#d7dad0'))}99`,
    },
  };
}
// Resolved custom properties for plugin frames; values keep working inside a frame because var() is already substituted.
export function pluginTokens() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(PLUGIN_TOKENS.map(name => [name, style.getPropertyValue(`--${name}`).trim()]));
}
export function applyTheme(theme, root = document.documentElement) {
  for (const name of TOKENS) root.style.removeProperty(`--${name}`);
  for (const [name, value] of Object.entries(theme.tokens || {})) if (TOKENS.includes(name)) root.style.setProperty(`--${name}`, value);
  root.style.colorScheme = theme.scheme; root.dataset.theme = theme.id; root.dataset.scheme = theme.scheme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.scheme);
  const themeColor = cssToHex('var(--side)', '#14282a');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', opaque(themeColor));
  return { id: theme.id, scheme: theme.scheme, tokens: theme.tokens || {}, themeColor: opaque(themeColor) };
}
// The preference is per browser; theme-boot.js replays the cached palette before first paint.
export function createThemeController({ onChange, safe = false } = {}) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let extra = [], extrasKnown = false, pref = safe ? DEFAULT_THEME : local.get(PREF_KEY) || DEFAULT_THEME, current = null;
  const all = () => [...THEMES, ...extra];
  const find = id => all().find(theme => theme.id === id);
  function target() { return pref === 'auto' ? find(AUTO_THEMES[media.matches ? 'dark' : 'light']) : find(pref); }
  function apply() {
    let theme = target();
    if (!theme) { if (!extrasKnown) return null; pref = DEFAULT_THEME; local.set(PREF_KEY, ''); theme = find(DEFAULT_THEME); }
    const cached = applyTheme(theme); current = theme;
    if (!safe) {
      const pair = pref === 'auto' ? { light: find(AUTO_THEMES.light), dark: find(AUTO_THEMES.dark) } : null;
      const cacheOf = t => t === theme ? cached : { id: t.id, scheme: t.scheme, tokens: t.tokens, themeColor: null };
      local.set(CACHE_KEY, JSON.stringify(pair ? { v: 1, mode: 'auto', light: cacheOf(pair.light), dark: cacheOf(pair.dark) } : { v: 1, mode: 'fixed', light: cached, dark: cached }));
    }
    onChange?.(theme);
    return theme;
  }
  media.addEventListener?.('change', () => { if (pref === 'auto') apply(); });
  return {
    get current() { return current; }, get pref() { return pref; }, list: all, find,
    setExtra(list) { extra = (list || []).map(t => ({ id: t.id, name: t.name, scheme: t.theme.scheme, description: t.description || '', author: t.author, version: t.version, source: t.source, tokens: t.theme.tokens, terminal: t.theme.terminal, editor: t.theme.editor })); extrasKnown = true; const theme = target(); if (!current || !theme || JSON.stringify(theme) !== JSON.stringify(current)) apply(); },
    set(id) { if (safe) return null; if (id !== 'auto' && !find(id)) return null; pref = id; local.set(PREF_KEY, id === DEFAULT_THEME ? '' : id); return apply(); },
    apply,
  };
}
