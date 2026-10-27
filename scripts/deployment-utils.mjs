import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function parseEnv(text) {
  const values = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) throw new Error(`配置第 ${index + 1} 行无效；请使用 KEY=VALUE。`);
    let value = match[2].trim();
    if (/^["']/.test(value)) {
      if (value.at(-1) !== value[0]) throw new Error(`配置第 ${index + 1} 行的引号不匹配。`);
      if (value[0] === '"') {
        try { value = JSON.parse(value); }
        catch { throw new Error(`配置第 ${index + 1} 行的双引号值不是有效字符串。`); }
      } else value = value.slice(1, -1);
    }
    if (Object.hasOwn(values, match[1])) throw new Error(`配置变量重复：${match[1]}`);
    values[match[1]] = value;
  }
  return values;
}

export function validateConfig(config) {
  for (const value of Object.values(config)) if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('配置值不能包含换行或控制字符。');
  const port = Number(config.PORT || 17880);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须是 1024 至 65535 的整数。');
  if ((config.WORKBENCH_HOST || '127.0.0.1') !== '127.0.0.1') throw new Error('自动部署仅支持 WORKBENCH_HOST=127.0.0.1。');
  let origin;
  try { origin = new URL(config.WORKBENCH_ORIGIN || `http://127.0.0.1:${port}`); }
  catch { throw new Error('WORKBENCH_ORIGIN 必须是有效的 HTTP(S) 来源。'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.origin !== config.WORKBENCH_ORIGIN) {
    throw new Error('WORKBENCH_ORIGIN 仅包含协议、主机和可选端口，不包含路径或结尾斜杠。');
  }
  if (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('外部访问来源必须使用 HTTPS；本机可用 HTTP。');
  return {port, origin: origin.origin};
}

export function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Refuse symlinks before writes: an existing target must never redirect a write
// into an unrelated data directory or credential file.
export async function assertNoSymlink(file) {
  for (let part = path.resolve(file);; part = path.dirname(part)) {
    try { if ((await fs.lstat(part)).isSymbolicLink()) throw new Error(`部署写入路径不能包含符号链接：${part}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (part === path.dirname(part)) break;
  }
}

export async function writeNew(file, text, mode = 0o600) {
  await assertNoSymlink(file);
  await fs.writeFile(file, text, {flag: 'wx', mode});
}

export function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} 执行失败（${signal || code}）。`)));
  });
}

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const systemdQuote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
// Path settings such as WorkingDirectory= take the rest of the line literally: older systemd (247, Debian 11)
// rejects a quoted value, so only specifiers are escaped and characters that cannot be written are refused.
export function systemdPath(value) {
  const text = String(value);
  if (!path.isAbsolute(text) || /[\x00-\x1f\x7f"'\\]/.test(text) || text !== text.trim()) throw new Error(`systemd 路径不能包含引号、反斜杠、控制字符或首尾空白：${text}`);
  return text.replaceAll('%', '%%');
}

export function deploymentEnvironment(config) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WORKBENCH_') && !['PORT', 'CLAUDE_BINARY'].includes(key)));
  return {...inherited, ...config};
}
