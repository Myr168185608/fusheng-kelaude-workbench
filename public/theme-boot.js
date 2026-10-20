// Runs before the stylesheet paints: replays the last applied skin so dark skins never flash white.
// ?safe skips it, together with every plugin.
(function () {
  try {
    if (/[?&]safe(?:[=&]|$)/.test(location.search)) return;
    var cache = JSON.parse(localStorage.getItem('cloud-ops-workbench-theme') || 'null');
    if (!cache || cache.v !== 1) return;
    var theme = cache.mode === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? cache.dark : cache.light;
    if (!theme || !theme.tokens) return;
    var root = document.documentElement, scheme = theme.scheme === 'dark' ? 'dark' : 'light';
    for (var name in theme.tokens) if (/^[a-z0-9-]{1,24}$/.test(name)) root.style.setProperty('--' + name, String(theme.tokens[name]));
    root.style.colorScheme = scheme;
    root.setAttribute('data-theme', String(theme.id || ''));
    root.setAttribute('data-scheme', scheme);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', scheme);
    var color = document.querySelector('meta[name="theme-color"]');
    if (color && /^#[0-9a-f]{6}$/i.test(theme.themeColor || '')) color.setAttribute('content', theme.themeColor);
  } catch (error) { /* A broken cache only costs the default palette for one paint. */ }
})();
