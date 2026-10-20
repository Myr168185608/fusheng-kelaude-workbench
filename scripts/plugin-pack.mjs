// Packs a plugin or skin folder into one .json bundle: import it on the workshop 「开发」 page, send it to a
// friend, or submit the folder to workshop/src to list it in the workshop.
//   npm run plugin:pack -- my-plugin                 looks in the current directory, then the plugin directory
//   npm run plugin:pack -- ./path/to/folder          any folder with a manifest.json
//   npm run plugin:pack -- my-plugin --out dist/     where to write <id>-<version>.json (default: the current directory)
// Packing is deterministic, so the printed sha256 is reproducible from the same files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { packPlugin, serializeBundle, LIMITS } from '../lib/plugins.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cwd = process.env.INIT_CWD || process.cwd();
const exists = file => fs.stat(file).then(() => true, () => false);

function parseArgs(argv) {
  const out = { target: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') out.out = argv[++i] ?? '';
    else if (arg.startsWith('--out=')) out.out = arg.slice(6);
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else if (out.target) throw new Error('一次只能打包一个插件。');
    else out.target = arg;
  }
  if (!out.target) throw new Error('用法：npm run plugin:pack -- <id 或目录> [--out 输出位置]\n例如：npm run plugin:pack -- my-plugin');
  if (out.out === '') throw new Error('--out 需要一个目录或 .json 文件名。');
  return out;
}
// A bare id is looked up in the current directory, the plugin directory, the built-in plugins and workshop/src.
async function resolveFolder(target) {
  const candidates = /[\\/]/.test(target) || target.startsWith('.') ? [path.resolve(cwd, target)] : [
    path.resolve(cwd, target),
    path.join(process.env.WORKBENCH_DATA || path.join(root, 'data'), 'plugins', target),
    path.join(root, 'plugins', target),
    path.join(root, 'workshop', 'src', target),
  ];
  for (const dir of candidates) if (await exists(path.join(dir, 'manifest.json'))) return dir;
  throw new Error(`找不到插件「${target}」：在这些位置都没有 manifest.json\n  ${[...new Set(candidates)].join('\n  ')}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const dir = await resolveFolder(args.target);
  const bundle = await packPlugin(dir);
  const text = serializeBundle(bundle), bytes = Buffer.from(text);
  if (bytes.length > LIMITS.packageBytes) throw new Error(`插件包有 ${(bytes.length / 1048576).toFixed(1)} MB，超过了 ${LIMITS.packageBytes / 1048576} MB 的上限。`);
  const { id, version, type, name } = bundle.manifest, fileName = `${id}-${version}.json`;
  let out = args.out ? path.resolve(cwd, args.out) : path.join(cwd, fileName);
  if (args.out && !out.endsWith('.json')) out = path.join(out, fileName);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, text);
  console.log(`已打包${type === 'theme' ? '皮肤' : '插件'}「${name}」v${version}（${bundle.files.length} 个文件，${(bytes.length / 1024).toFixed(1)} KB）`);
  console.log(`  来源    ${dir}`);
  console.log(`  插件包  ${out}`);
  console.log(`  sha256  ${createHash('sha256').update(bytes).digest('hex')}`);
  console.log('\n在工作台「创意工坊 → 开发」里点「导入插件包…」即可安装。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
