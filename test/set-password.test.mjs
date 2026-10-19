import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from '../lib/auth.mjs';
import { createWorkbench } from '../server.mjs';

const script = fileURLToPath(new URL('../scripts/set-password.mjs', import.meta.url));
const { WORKBENCH_AUTH_FILE, WORKBENCH_DATA, ...baseEnv } = process.env;

function setPassword(dataDir, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...baseEnv, WORKBENCH_DATA: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}
async function dataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stores only a verifiable scrypt hash, owner-only, and signs out existing browser sessions', async t => {
  const dir = await dataDir(t);
  await writeFile(join(dir, 'web-sessions.json'), '[]');
  const result = await setPassword(dir, 'correct horse battery staple\n');
  assert.equal(result.code, 0, result.err);
  const raw = await readFile(join(dir, 'auth.json'), 'utf8');
  assert(!raw.includes('correct horse'), 'the plain password is never written');
  const record = JSON.parse(raw);
  assert.equal(await verifyPassword('correct horse battery staple', record), true);
  assert.equal(await verifyPassword('correct horse battery stapl', record), false);
  assert.equal((await stat(join(dir, 'auth.json'))).mode & 0o777, 0o600);
  await assert.rejects(access(join(dir, 'web-sessions.json')), { code: 'ENOENT' });
});

test('rejects short passwords without touching the existing credential', async t => {
  const dir = await dataDir(t);
  const previous = JSON.stringify({ salt: 'a', hash: 'b' });
  await writeFile(join(dir, 'auth.json'), previous);
  const result = await setPassword(dir, 'too-short');
  assert.equal(result.code, 1);
  assert.match(result.err, /至少需要 12/);
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), previous);
});

test('rotating the password keeps the configured display name', async t => {
  const dir = await dataDir(t);
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ userName: 'ops', salt: 'a', hash: 'b' }));
  assert.equal((await setPassword(dir, 'a much longer passphrase')).code, 0);
  assert.equal(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).userName, 'ops');
});

test('a fresh install without a credential explains how to create one', async t => {
  const dir = await dataDir(t);
  // An inherited WORKBENCH_AUTH_FILE (e.g. when tests run inside a deployed workbench) would point elsewhere.
  const inherited = process.env.WORKBENCH_AUTH_FILE; delete process.env.WORKBENCH_AUTH_FILE;
  t.after(() => { if (inherited !== undefined) process.env.WORKBENCH_AUTH_FILE = inherited; });
  await assert.rejects(createWorkbench({ dataDir: dir }), /npm run set-password/);
});
