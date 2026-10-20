import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTaskResume, resumePrompt } from '../plugins/task-resume/backend.mjs';

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-task-resume-'));
  const session = { id: randomUUID(), title: '恢复任务', status: 'idle', claudeSessionId: randomUUID(), permissions: [], archived: false };
  const calls = [], state = { active: true, busy: false, time: Date.parse('2026-10-21T00:00:00Z') };
  let plugin;
  const config = { dataDir, listSessions: () => [session], getSession: id => id === session.id ? session : null,
    isActive: () => state.active, isBusy: () => state.busy, now: () => state.time,
    startTurn: async (...args) => { calls.push(args); return { code: 202 }; }, ...options };
  plugin = await createTaskResume(config);
  t.after(async () => { await plugin.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const run = { messageId: randomUUID() };
  return { get plugin() { return plugin; }, session, run, calls, state, dataDir, config,
    async begin(request = {}) { session.status = 'running'; await plugin.beforeRun({ session, request, run }); },
    async fail(result = {}) { session.status = 'error'; await plugin.onExit({ session, run, result: { code: 1, ...result } }); },
    async restart() { await plugin.close(); session.status = 'error'; plugin = await createTaskResume(config); return plugin; },
    async task() { return (await plugin.call('list')).tasks[0]; } };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail('asynchronous task did not settle');
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('checkpoint stores identifiers and tool status without copying prompts, inputs, output or credentials', async t => {
  const f = await fixture(t); await f.begin({ text: 'PRIVATE USER PROMPT', password: 'SECRET' });
  await f.plugin.onEvent({ session: f.session, run: f.run, event: { type: 'tool', name: 'Write', status: 'completed', input: { content: 'PRIVATE INPUT' }, output: 'PRIVATE OUTPUT' } });
  await f.fail();
  const raw = await fs.readFile(path.join(f.dataDir, 'checkpoints.json'), 'utf8'), data = JSON.parse(raw);
  assert.equal(data.tasks[0].claudeSessionId, f.session.claudeSessionId);
  assert.equal(data.tasks[0].lastTool.name, 'Write'); assert.equal(data.tasks[0].state, 'failed');
  assert.doesNotMatch(raw, /PRIVATE|SECRET|password|credentials/);
  assert.equal((await fs.stat(path.join(f.dataDir, 'checkpoints.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(f.dataDir)), ['checkpoints.json']);
});

test('restart detects interrupted runs and defaults to manual recovery using the existing official session', async t => {
  const f = await fixture(t); await f.begin(); await f.restart();
  const task = await f.task(); assert.equal(task.state, 'interrupted'); assert.equal(task.resumable, true);
  assert.equal((await f.plugin.call('settings.get')).autoResume, false); assert.equal(f.calls.length, 0);
  await f.plugin.call('resume', { sessionId: f.session.id });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], f.session);
  assert.equal(f.calls[0][1], resumePrompt); assert.equal(f.calls[0][2].resume, true); assert.equal(f.calls[0][2].source, 'task-resume');
  assert.match(resumePrompt, /不要直接重放历史工具调用/);
});

test('checkpoint listing follows the host title assigned after the first turn and later renames', async t => {
  const f = await fixture(t); f.session.title = '新的对话'; await f.begin();
  f.session.title = '检查服务器日志'; assert.equal((await f.task()).title, '检查服务器日志');
  f.session.title = '运维任务：定位连接问题'; assert.equal((await f.task()).title, '运维任务：定位连接问题');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints.json'), 'utf8')).tasks[0].title, '新的对话');
});

test('manual stop and cancel remain nonresumable after restart', async t => {
  const f = await fixture(t); await f.begin();
  await f.plugin.onStop({ session: f.session, run: f.run, reason: 'user' });
  await f.fail({ stopped: true }); await f.restart(); assert.equal((await f.task()).state, 'stopped');
  await assert.rejects(f.plugin.call('resume', { sessionId: f.session.id }), error => error.status === 409);
  await f.begin(); await f.fail(); await f.plugin.call('cancel', { sessionId: f.session.id });
  await f.restart(); assert.equal((await f.task()).state, 'cancelled'); assert.equal(f.calls.length, 0);
});

test('shutdown hooks persist an interrupted checkpoint even when isActive becomes false', async t => {
  const f = await fixture(t); await f.begin(); f.state.active = false;
  await f.plugin.onStop({ session: f.session, run: f.run, reason: 'shutdown' });
  await f.plugin.onExit({ session: f.session, run: f.run, result: { code: null, stopped: true, shutdown: true } });
  f.state.active = true; await f.restart(); assert.equal((await f.task()).state, 'interrupted');
  assert.equal((await f.task()).resumable, true);
});

test('approval and AskUserQuestion checkpoints never auto-resume after a restart', async t => {
  const f = await fixture(t); await f.plugin.call('settings.update', { autoResume: true }); await f.begin();
  f.session.status = 'awaiting_approval'; f.session.permissions = [{ id: 'question' }];
  await f.plugin.onEvent({ session: f.session, run: f.run, event: { type: 'permission', toolName: 'AskUserQuestion', input: { questions: ['private'] } } });
  await f.plugin.onStop({ session: f.session, run: f.run, reason: 'shutdown' }); await f.restart();
  const task = await f.task(); assert.equal(task.state, 'awaiting_user'); assert.equal(task.automatic, false);
  await assert.rejects(f.plugin.call('resume', { sessionId: f.session.id }), error => error.status === 409);
  assert.equal(f.calls.length, 0);
});

test('a later event following an answered approval restores normal checkpoint progress', async t => {
  const f = await fixture(t); await f.begin(); f.session.status = 'awaiting_approval'; f.session.permissions = [{}];
  await f.plugin.onEvent({ session: f.session, run: f.run, event: { type: 'permission' } });
  f.session.status = 'running'; f.session.permissions = [];
  await f.plugin.onEvent({ session: f.session, run: f.run, event: { type: 'tool', name: 'Read', status: 'completed' } });
  await f.fail(); assert.equal((await f.task()).resumable, true);
});

test('a missing or changed official session cannot fall back to replaying the original prompt', async t => {
  const f = await fixture(t); f.session.claudeSessionId = null; await f.begin(); await f.fail();
  await assert.rejects(f.plugin.call('resume', { sessionId: f.session.id }), /官方会话记录/);
  f.session.claudeSessionId = randomUUID(); await f.begin(); await f.fail(); f.session.claudeSessionId = randomUUID();
  await assert.rejects(f.plugin.call('resume', { sessionId: f.session.id }), /官方会话记录/);
  assert.equal(f.calls.length, 0);
});

test('busy, archived, and still-waiting host sessions refuse recovery without starting a process', async t => {
  const f = await fixture(t); await f.begin(); await f.fail();
  f.state.busy = true; await assert.rejects(f.plugin.call('resume', { sessionId: f.session.id }), /另一项任务/); f.state.busy = false;
  f.session.archived = true; await assert.rejects(f.plugin.call('resume', { sessionId: f.session.id }), /归档/); f.session.archived = false;
  f.session.permissions = [{}]; await assert.rejects(f.plugin.call('resume', { sessionId: f.session.id }), /审批/);
  assert.equal(f.calls.length, 0);
});

test('old run events and exit callbacks cannot overwrite a newer checkpoint', async t => {
  const f = await fixture(t); await f.begin();
  const older = f.plugin.onEvent({ session: f.session, run: f.run, event: { type: 'tool', name: 'OldTool', status: 'started' } });
  const newRun = { messageId: randomUUID() };
  const newer = f.plugin.beforeRun({ session: f.session, run: newRun, request: { text: 'new task' } });
  await Promise.all([older, newer]);
  await f.plugin.onExit({ session: f.session, run: f.run, result: { code: 0 } });
  await f.plugin.onEvent({ session: f.session, run: f.run, event: { type: 'tool', name: 'StaleTool', status: 'completed' } });
  assert.equal((await f.task()).runId, newRun.messageId); assert.equal((await f.task()).state, 'running'); assert.equal((await f.task()).lastTool, null);
  await f.restart(); assert.equal((await f.task()).runId, newRun.messageId);
});

test('preflight failures restore the previous checkpoint and terminal starts create none', async t => {
  const f = await fixture(t);
  await f.plugin.beforeRun({ session: f.session, kind: 'terminal', run: f.run }); assert.equal((await f.plugin.call('list')).tasks.length, 0);
  await f.begin(); await f.plugin.onExit({ session: f.session, run: f.run, result: { preflightFailed: true } });
  assert.equal((await f.plugin.call('list')).tasks.length, 0);
  await f.begin(); await f.fail(); const previous = await f.task(), newRun = { messageId: randomUUID() };
  await f.plugin.beforeRun({ session: f.session, run: newRun });
  await f.plugin.onExit({ session: f.session, run: newRun, result: { preflightFailed: true } });
  assert.equal((await f.task()).runId, previous.runId); assert.equal((await f.task()).state, 'failed');
});

test('official quota rejection never enters the automatic recovery queue', async t => {
  const f = await fixture(t); await f.plugin.call('settings.update', { autoResume: true }); await f.begin();
  await f.plugin.onEvent({ session: f.session, run: f.run, event: { type: 'rate_limit', rateLimited: true } });
  f.session.status = 'idle'; await f.plugin.onExit({ session: f.session, run: f.run, result: { code: 0 } });
  const task = await f.task(); assert.equal(task.state, 'failed'); assert.equal(task.reason, 'quota'); assert.equal(task.automatic, false); assert.equal(task.nextAttemptAt, null);
});

test('automatic resume uses a finite retry budget and exponential backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { startTurn: async () => { f.calls.push('attempt'); return { code: 503, msg: 'unavailable' }; } });
  await f.plugin.call('settings.update', { autoResume: true, retryDelayMs: 1000, maxAttempts: 2 }); await f.begin(); await f.fail();
  f.state.time += 999; t.mock.timers.tick(999); assert.equal(f.calls.length, 0);
  f.state.time += 1; t.mock.timers.tick(1); await until(async () => f.calls.length === 1 && (await f.task()).state === 'failed');
  assert.equal((await f.task()).autoAttempts, 1); assert.equal((await f.task()).nextAttemptAt, f.state.time + 2000);
  // Wait for the serialized checkpoint write and scheduler after the launch callback.
  await until(async () => JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints.json'), 'utf8')).tasks[0].state === 'failed');
  await new Promise(resolve => setImmediate(resolve));
  f.state.time += 2000; t.mock.timers.tick(2000); await until(async () => f.calls.length === 2 && (await f.task()).state === 'failed');
  assert.equal((await f.task()).autoAttempts, 2); assert.equal((await f.task()).automatic, false);
  f.state.time += 1_000_000; t.mock.timers.tick(1_000_000); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 2);
});

test('disabling the plugin or entering safe mode prevents queued and manual recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); await f.plugin.call('settings.update', { autoResume: true, retryDelayMs: 1000 }); await f.begin(); await f.fail();
  f.state.active = false; f.state.time += 2000; t.mock.timers.tick(2000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0); await assert.rejects(f.plugin.call('resume', { sessionId: f.session.id }), /停用|安全模式/);
  await f.plugin.close(); f.state.active = true; f.state.time += 5000; t.mock.timers.tick(5000); assert.equal(f.calls.length, 0);
});

test('deactivation during asynchronous session lookup cannot start a recovery', async t => {
  let resolveLookup;
  const f = await fixture(t, { getSession: () => new Promise(resolve => { resolveLookup = resolve; }) });
  await f.begin(); await f.fail(); const resume = f.plugin.call('resume', { sessionId: f.session.id });
  await until(() => resolveLookup); f.state.active = false; resolveLookup(f.session);
  await assert.rejects(resume, /停用|安全模式/); assert.equal(f.calls.length, 0);
});

test('corrupt and linked checkpoint data fail closed and are never overwritten', async t => {
  const f = await fixture(t); await f.plugin.close(); const file = path.join(f.dataDir, 'checkpoints.json');
  await fs.writeFile(file, '{corrupt'); await assert.rejects(createTaskResume(f.config), /无法读取/); assert.equal(await fs.readFile(file, 'utf8'), '{corrupt');
  const target = path.join(f.dataDir, 'external'); await fs.writeFile(target, 'untouched'); await fs.unlink(file); await fs.symlink(target, file);
  await assert.rejects(createTaskResume(f.config), /无法读取/); assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
});

test('settings are validated, persisted and default-off does not become implicit consent', async t => {
  const f = await fixture(t);
  for (const patch of [{ autoResume: 'yes' }, { maxAttempts: 0 }, { maxAttempts: 100 }, { retryDelayMs: -1 }, { arbitrary: true }]) {
    await assert.rejects(f.plugin.call('settings.update', patch), error => error.status === 400);
  }
  assert.equal((await f.plugin.call('settings.get')).autoResume, false);
  await f.plugin.call('settings.update', { autoResume: true, maxAttempts: 3, retryDelayMs: 60_000 }); await f.restart();
  assert.deepEqual(await f.plugin.call('settings.get'), { autoResume: true, maxAttempts: 3, retryDelayMs: 60_000 });
});
