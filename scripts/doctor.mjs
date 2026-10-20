import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {parseEnv, validateConfig, deploymentEnvironment} from './deployment-utils.mjs';

const exec = promisify(execFile);
const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeFiles = ['marked/lib/marked.umd.js', 'dompurify/dist/purify.min.js', '@xterm/xterm/lib/xterm.js', '@xterm/xterm/css/xterm.css', '@xterm/addon-fit/lib/addon-fit.js', 'express/package.json'];
const editorFiles = ['monaco.js', 'monaco.css', 'editor.worker.js', 'json.worker.js', 'css.worker.js', 'html.worker.js', 'ts.worker.js'];

export async function doctor(options = {}, {run = exec} = {}) {
  const checks = [];
  const add = (id, status, message) => checks.push({id, status, message});
  let root = options.root || sourceRoot;
  let config = {};
  const envFile = options.envFile || (options.target && path.join(path.resolve(options.target), 'workbench.env'));
  try {
    if (options.target) root = await fs.realpath(path.join(path.resolve(options.target), 'current'));
    if (envFile) config = parseEnv(await fs.readFile(envFile, 'utf8'));
    else for (const [key, value] of Object.entries(process.env)) if (key.startsWith('WORKBENCH_') || ['PORT', 'CLAUDE_BINARY'].includes(key)) config[key] = value;
    config = {WORKBENCH_HOST: '127.0.0.1', PORT: '17880', WORKBENCH_ORIGIN: 'http://127.0.0.1:17880', WORKBENCH_DATA: path.join(root, 'data'), CLAUDE_BINARY: 'claude', ...config};
    validateConfig(config);
    add('configuration', 'pass', envFile ? `已读取 ${envFile}` : '已读取当前进程配置；未自动加载 .env。');
  } catch (error) {
    add('configuration', 'fail', error.message);
    return {ok: false, root, checks};
  }
  add('node', Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail', `Node.js ${process.versions.node}；最低 20。`);
  add('platform', process.platform === 'win32' ? 'fail' : 'pass', `运行平台 ${process.platform}；网页终端需要 POSIX PTY。`);
  if (process.getuid?.() === 0) add('service-user', 'warn', '当前用户为 root；正式运行建议切换到专用普通用户。');
  const missingRuntime = [];
  for (const file of runtimeFiles) try { await fs.access(path.join(root, 'node_modules', file), constants.R_OK); } catch { missingRuntime.push(file); }
  add('dependencies', missingRuntime.length ? 'fail' : 'pass', missingRuntime.length ? `缺少依赖文件：${missingRuntime.join(', ')}；运行 npm ci。` : '服务端依赖和浏览器依赖文件齐全。');
  const missingEditor = [];
  for (const file of editorFiles) try { const stat = await fs.stat(path.join(root, 'public/vendor/editor', file)); if (!stat.size) missingEditor.push(file); } catch { missingEditor.push(file); }
  add('editor-build', missingEditor.length ? 'fail' : 'pass', missingEditor.length ? `缺少编辑器构建文件：${missingEditor.join(', ')}；运行 npm run build。` : 'Monaco 与全部 worker 构建文件齐全。');
  try {
    // TerminalManager uses this exact executable; a different python3 on PATH
    // cannot establish that the actual web terminal will start.
    const {stdout} = await run('/usr/bin/python3', ['-c', 'import pty, sys; print(sys.version.split()[0])'], {timeout: 5000});
    add('terminal-python', 'pass', `Python ${stdout.trim()} 可导入 pty。`);
  } catch { add('terminal-python', 'fail', '/usr/bin/python3 不可运行或无法导入 pty，网页终端不可用。'); }
  const data = config.WORKBENCH_DATA;
  try {
    const stat = await fs.stat(data);
    if (!stat.isDirectory()) throw new Error('not a directory');
    await fs.access(data, constants.R_OK | constants.W_OK | constants.X_OK);
    add('data-directory', stat.mode & 0o077 ? 'warn' : 'pass', stat.mode & 0o077 ? '数据目录可读写，但其他用户有访问权限；建议 chmod 700。' : '数据目录可读写，权限仅当前用户。');
  } catch { add('data-directory', 'fail', `数据目录不存在或当前用户不可读写：${data}`); }
  const authFile = config.WORKBENCH_AUTH_FILE || path.join(data, 'auth.json');
  try {
    const auth = JSON.parse(await fs.readFile(authFile, 'utf8'));
    if (!/^[a-f0-9]{48}$/i.test(auth.salt || '') || !/^[a-f0-9]{128}$/i.test(auth.hash || '')) throw new Error('invalid');
    const stat = await fs.stat(authFile);
    add('workbench-password', stat.mode & 0o077 ? 'fail' : 'pass', stat.mode & 0o077 ? '口令哈希文件可被其他用户访问；请 chmod 600。' : '工作台口令哈希有效，文件权限受限。');
  } catch { add('workbench-password', 'fail', '工作台口令文件缺失或格式无效；请以运行账号执行 set-password。'); }
  if (options.skipClaude) add('claude-auth', 'skip', '显式跳过 Claude 检查；此结果不能证明 Claude 任务可执行。');
  else {
    try {
      const environment = deploymentEnvironment(config);
      const {stdout: version} = await run(config.CLAUDE_BINARY, ['--version'], {env: environment, timeout: 15000, maxBuffer: 1024 * 1024});
      add('claude-cli', 'pass', `官方 CLI 可运行：${version.trim().split('\n')[0].slice(0, 160)}`);
      try {
        const {stdout} = await run(config.CLAUDE_BINARY, ['auth', 'status'], {env: environment, timeout: 20000, maxBuffer: 1024 * 1024});
        const auth = JSON.parse(stdout);
        add('claude-auth', auth.loggedIn === true ? 'pass' : 'fail', auth.loggedIn === true ? '当前运行用户的 Claude 登录状态有效。' : '当前运行用户尚未登录 Claude。');
      } catch { add('claude-auth', 'fail', '无法确认 Claude 登录状态；请以同一运行用户执行 claude auth status。'); }
    } catch { add('claude-cli', 'fail', 'Claude CLI 无法运行；检查 CLAUDE_BINARY、PATH 与服务账号。'); }
  }
  if (options.health) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.PORT}/healthz`, {signal: AbortSignal.timeout(5000), redirect: 'error'});
      if (!response.ok || (await response.json()).ok !== true) throw new Error('invalid health response');
      add('http-health', 'pass', '运行中的 /healthz 返回 {"ok":true}。');
      const unauthenticated = await fetch(`http://127.0.0.1:${config.PORT}/api/bootstrap`, {signal: AbortSignal.timeout(5000), redirect: 'error'});
      add('http-auth-boundary', unauthenticated.status === 401 ? 'pass' : 'fail', unauthenticated.status === 401 ? '未登录 API 请求被拒绝。' : `未登录 API 请求意外返回 HTTP ${unauthenticated.status}。`);
    } catch { add('http-health', 'fail', '无法验证运行中的工作台；检查服务状态、监听地址与端口。'); }
  } else add('http-health', 'skip', '未检查运行中的服务；启动后加 --health 验证。');
  if (config.WORKBENCH_ROOT_OPERATIONS === '1') add('root-operations', 'warn', 'Root 运维提示已开启；本检查未验证 sudo 策略。');
  return {ok: !checks.some(check => check.status === 'fail'), root, checks};
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const option = process.argv[i];
      if (['--json', '--health', '--skip-claude', '--help'].includes(option)) options[option.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      else if (['--target', '--env-file'].includes(option)) {
        const value = process.argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${option} 缺少值。`);
        options[option === '--env-file' ? 'envFile' : 'target'] = value;
      } else throw new Error(`未知选项：${option}`);
    }
    if (options.help) console.log('用法：node scripts/doctor.mjs [--target /部署目录 | --env-file /配置文件] [--health] [--json] [--skip-claude]\n只读检查；不会创建文件、重置口令、登录账号或修改服务。');
    else {
      const report = await doctor(options);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else for (const check of report.checks) console.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
