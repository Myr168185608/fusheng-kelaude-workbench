// The generated launcher resolves current once, so an upgrade never moves the
// code directory out from under a running process.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseEnv, validateConfig, deploymentEnvironment} from './deployment-utils.mjs';

try {
  const configFile = process.argv[2];
  if (!configFile || !path.isAbsolute(configFile)) throw new Error('需要绝对路径的 workbench.env。');
  const config = parseEnv(await fs.readFile(configFile, 'utf8'));
  validateConfig(config);
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {cwd: root, env: deploymentEnvironment(config), stdio: 'inherit'});
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
} catch (error) { console.error(error.message); process.exitCode = 1; }
