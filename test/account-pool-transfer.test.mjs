import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { transferConversation } from '../plugins/account-pool/transfer.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'claude-transfer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source'), targetDir = path.join(root, 'target'), cwd = path.join(root, 'work space', '中文');
  const sessionId = randomUUID(), otherSession = randomUUID();
  const project = path.join('projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = path.join(project, `${sessionId}.jsonl`);
  await fs.mkdir(path.join(sourceDir, project), { recursive: true });
  await fs.mkdir(targetDir);
  await fs.writeFile(path.join(sourceDir, transcript), '{"sessionId":"' + sessionId + '","text":"最新对话"}\n');
  const options = { sessionId, sourceDir, targetDir, cwd };
  return { ...options, root, project, transcript, otherSession, options };
}

async function write(root, relative, value) {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), value);
}

test('copies only selected conversation, subagent and rewind records, preserving UUID and workspace', async t => {
  const f = await fixture(t);
  const subagent = path.join(f.project, f.sessionId, 'subagents', 'agent-one.jsonl');
  const history = path.join('file-history', f.sessionId, 'source-file@v1');
  await write(f.sourceDir, subagent, '{"assistant":"子代理记录"}\n');
  await write(f.sourceDir, history, 'rewind-source');
  await write(f.sourceDir, path.join(f.project, `${f.otherSession}.jsonl`), 'unrelated transcript');
  await write(f.sourceDir, path.join('file-history', f.otherSession, 'private.txt'), 'unrelated history');
  for (const name of ['.credentials.json', '.claude.json', 'settings.json', 'cache.json', 'sessions/active.pid']) {
    await write(f.sourceDir, name, `private-${name}`);
  }
  await write(f.targetDir, '.credentials.json', 'existing-target-credentials');
  await write(f.cwd, 'working-file.txt', 'workspace-stays-in-place');
  await transferConversation(f.options);
  for (const relative of [f.transcript, subagent, history]) {
    assert.equal(await fs.readFile(path.join(f.targetDir, relative), 'utf8'), await fs.readFile(path.join(f.sourceDir, relative), 'utf8'));
    assert.equal((await fs.stat(path.join(f.targetDir, relative))).mode & 0o777, 0o600);
  }
  assert.equal(await fs.readFile(path.join(f.targetDir, '.credentials.json'), 'utf8'), 'existing-target-credentials');
  for (const relative of ['.claude.json', 'settings.json', 'cache.json', 'sessions', path.join(f.project, `${f.otherSession}.jsonl`), path.join('file-history', f.otherSession)]) {
    await assert.rejects(fs.lstat(path.join(f.targetDir, relative)), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(path.join(f.cwd, 'working-file.txt'), 'utf8'), 'workspace-stays-in-place');
});

test('explicit latest account wins over stale target mtimes and switching back copies its updated transcript', async t => {
  const f = await fixture(t);
  await write(f.targetDir, f.transcript, 'stale-target');
  await fs.utimes(path.join(f.targetDir, f.transcript), new Date('2040-01-01'), new Date('2040-01-01'));
  const original = await fs.readFile(path.join(f.sourceDir, f.transcript), 'utf8');
  await transferConversation(f.options);
  assert.equal(await fs.readFile(path.join(f.targetDir, f.transcript), 'utf8'), original);
  await fs.appendFile(path.join(f.targetDir, f.transcript), '{"text":"第二账号新增回答"}\n');
  await transferConversation({ ...f.options, sourceDir: f.targetDir, targetDir: f.sourceDir });
  assert.match(await fs.readFile(path.join(f.sourceDir, f.transcript), 'utf8'), /第二账号新增回答/);
});

test('missing optional records are allowed, missing required transcripts return a controlled conflict', async t => {
  const f = await fixture(t);
  await transferConversation(f.options);
  await fs.rm(path.join(f.sourceDir, f.project), { recursive: true });
  await assert.rejects(transferConversation(f.options), { status: 409, statusCode: 409 });
  assert.match(await fs.readFile(path.join(f.targetDir, f.transcript), 'utf8'), /最新对话/);
});

test('invalid UUIDs and nonabsolute paths are rejected without creating directories', async t => {
  const f = await fixture(t);
  for (const patch of [{ sessionId: '../secret' }, { sessionId: undefined }, { sourceDir: 'relative' }, { targetDir: '../target' }, { cwd: '.' }]) {
    await assert.rejects(transferConversation({ ...f.options, ...patch }), { status: 409 });
  }
  assert.deepEqual(await fs.readdir(f.targetDir), []);
});

test('source transcript symlinks and hardlinks are rejected before optional data reaches target', async t => {
  for (const type of ['symbolic', 'hard']) {
    const f = await fixture(t);
    await write(f.sourceDir, path.join(f.project, f.sessionId, 'subagents', 'agent.jsonl'), 'otherwise-valid');
    const transcript = path.join(f.sourceDir, f.transcript), outside = path.join(f.root, 'outside-secret');
    await fs.writeFile(outside, 'must-not-copy');
    await fs.rm(transcript);
    if (type === 'symbolic') await fs.symlink(outside, transcript); else await fs.link(outside, transcript);
    await assert.rejects(transferConversation(f.options), { status: 409 });
    assert.deepEqual(await fs.readdir(f.targetDir), []);
  }
});

test('source parent and nested record symlinks cannot escape to other account data', async t => {
  const f = await fixture(t);
  const relative = path.join(f.project, f.sessionId, 'subagents');
  await fs.mkdir(path.join(f.sourceDir, f.project, f.sessionId));
  await fs.symlink(f.targetDir, path.join(f.sourceDir, relative));
  await assert.rejects(transferConversation(f.options), { status: 409 });
  assert.deepEqual(await fs.readdir(f.targetDir), []);
  await fs.rm(path.join(f.sourceDir, f.project, f.sessionId), { recursive: true });
  const realProjects = path.join(f.root, 'real-projects');
  await fs.rename(path.join(f.sourceDir, 'projects'), realProjects);
  await fs.symlink(realProjects, path.join(f.sourceDir, 'projects'));
  await assert.rejects(transferConversation(f.options), { status: 409 });
});

test('preflight rejects a later invalid optional record without partially copying earlier valid records', async t => {
  const f = await fixture(t);
  await write(f.sourceDir, path.join(f.project, f.sessionId, 'subagents', 'agent.jsonl'), 'valid-first');
  const secret = path.join(f.root, 'secret'), invalid = path.join(f.sourceDir, 'file-history', f.sessionId, 'later');
  await fs.writeFile(secret, 'private');
  await fs.mkdir(path.dirname(invalid), { recursive: true });
  await fs.link(secret, invalid);
  await assert.rejects(transferConversation(f.options), { status: 409 });
  assert.deepEqual(await fs.readdir(f.targetDir), []);
});

test('target links are rejected without modifying their referents or source files', async t => {
  for (const type of ['symbolic', 'hard', 'parent']) {
    const f = await fixture(t);
    const outside = path.join(f.root, 'outside');
    if (type === 'parent') {
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(f.targetDir, 'projects'));
    } else {
      await fs.writeFile(outside, 'unchanged-secret');
      await fs.mkdir(path.join(f.targetDir, f.project), { recursive: true });
      if (type === 'symbolic') await fs.symlink(outside, path.join(f.targetDir, f.transcript));
      else await fs.link(outside, path.join(f.targetDir, f.transcript));
    }
    await assert.rejects(transferConversation(f.options), { status: 409 });
    if (type !== 'parent') assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged-secret');
    else assert.deepEqual(await fs.readdir(outside), []);
    assert.match(await fs.readFile(path.join(f.sourceDir, f.transcript), 'utf8'), /最新对话/);
  }
});

test('oversized transcript is refused before destination writes', async t => {
  const f = await fixture(t);
  await fs.truncate(path.join(f.sourceDir, f.transcript), 128 * 1024 * 1024 + 1);
  await assert.rejects(transferConversation(f.options), { status: 409 });
  assert.deepEqual(await fs.readdir(f.targetDir), []);
});

test('same normalized account directory needs no copying', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.sourceDir, f.transcript), 'utf8');
  await transferConversation({ ...f.options, targetDir: path.join(f.sourceDir, 'unused', '..') });
  assert.equal(await fs.readFile(path.join(f.sourceDir, f.transcript), 'utf8'), before);
});
