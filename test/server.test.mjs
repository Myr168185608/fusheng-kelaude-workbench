import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkbench } from '../server.mjs';
import { hashPassword } from '../lib/auth.mjs';

const ORIGIN = 'https://claude.test.invalid';
const PASSWORD = 'test-only-password-do-not-deploy';
const record = await hashPassword(PASSWORD);
const CLAUDE_SESSION = 'e5b5fbf7-21fc-4d96-b643-f0d99cc32a78';

function fakeRunner() {
  const calls = [];
  function factory(options) {
    let finish, finished = false;
    const permissions = new Set();
    const call = { options, stops: 0, approvals: [], steers: [], steerReply: null };
    const done = new Promise(resolve => { finish = resolve; });
    call.emit = event => {
      if (event.type === 'permission') permissions.add(event.id);
      if (event.type === 'permission_cancelled') permissions.delete(event.id);
      options.onEvent(event);
    };
    call.finish = async (result = { code: 0, stopped: false }) => {
      if (finished) return;
      finished = true;
      call.emit({ type: 'done' });
      await options.onExit(result);
      finish(result);
    };
    call.handle = {
      done,
      stop() { call.stops++; void call.finish({ code: null, stopped: true }); return true; },
      steer(text) {
        if (call.steerReply) return call.steerReply;
        const id = randomUUID(); call.steers.push({ id, text }); return { ok: true, id };
      },
      respondPermission(id, allow) {
        if (!permissions.delete(id)) return false;
        call.approvals.push({ id, allow });
        return true;
      },
    };
    calls.push(call);
    return call.handle;
  }
  return { calls, factory };
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-ops-workbench-server-'));
  const fake = fakeRunner();
  const monitor = {
    async sample(activeRuns) { return { activeRuns, cpuPercent: 3 }; },
    async auth() { return { loggedIn: true, subscriptionType: 'pro' }; },
  };
  const usageSnapshot = { fiveHour: { utilization: 2, resetsAt: '2026-10-18T00:00:00Z' }, sevenDay: { utilization: 5, resetsAt: '2026-10-22T00:00:00Z' }, scopes: [], source: 'test', updatedAt: '2026-10-18T00:00:00Z', stale: false };
  const usageMonitor = { read: () => usageSnapshot, refresh: async () => usageSnapshot, observe: () => {}, close: async () => {} };
  const config = { dataDir: path.join(dir, 'data'), workspaceRoot: path.join(dir, 'workspaces'),
    origin: ORIGIN, passwordRecord: record, monitor, usageMonitor, runFactory: fake.factory };
  let wb, server, base, cookie, csrf;
  async function start() {
    wb = await createWorkbench(config);
    server = await new Promise(resolve => { const s = wb.app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (!server) return;
    await wb.close();
    await new Promise(resolve => server.close(resolve));
    server = undefined;
  }
  async function request(route, { method = 'GET', body, authenticated = true,
    origin = ORIGIN, csrfToken = csrf, headers = {} } = {}) {
    const h = { ...headers };
    if (origin !== null) h.Origin = origin;
    if (authenticated && cookie) h.Cookie = cookie;
    if (csrfToken !== null && csrfToken) h['X-CSRF-Token'] = csrfToken;
    if (body !== undefined) h['Content-Type'] ||= 'application/json';
    const res = await fetch(base + route, { method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
  async function login() {
    const res = await request('/api/login', { method: 'POST', body: { password: PASSWORD }, authenticated: false });
    assert.equal(res.status, 200);
    cookie = res.headers.get('set-cookie').split(';')[0];
    csrf = res.body.csrfToken;
    return res;
  }
  async function create(body = {}) {
    const res = await request('/api/sessions', { method: 'POST', body: {permissionMode:'default',...body} });
    assert.equal(res.status, 201);
    return res.body;
  }
  await start();
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { request, login, create, fake, config, start, stop, get wb() { return wb; }, get base() { return base; }, get cookie() { return cookie; } };
}

test('unauthenticated data is denied and login creates a secure revocable cookie', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/healthz')).status, 200);
  assert.deepEqual((await f.request('/api/auth')).body, { authenticated: false });
  assert.equal((await f.request('/api/bootstrap')).status, 401);
  const login = await f.login();
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict;/);
  assert.match(login.headers.get('set-cookie'), /; Secure$/);
  const bootstrap = await f.request('/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.account.loggedIn, true);
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/api/logout', { method: 'POST', body: {} })).status, 204);
  assert.equal((await f.request('/api/bootstrap')).status, 401);
});

test('Origin, JSON content type and CSRF are checked before any mutation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { password: PASSWORD }, origin: null })).status, 403);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { password: PASSWORD }, origin: 'https://evil.invalid' })).status, 403);
  await f.login();
  assert.equal((await f.request('/api/sessions', { method: 'POST', body: {}, csrfToken: null })).status, 403);
  assert.equal((await f.request('/api/sessions', { method: 'POST', body: {}, csrfToken: 'wrong' })).status, 403);
  assert.equal((await f.request('/api/sessions', { method: 'POST', body: {}, origin: null })).status, 403);
  assert.equal((await f.request('/api/sessions', { method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/sessions', { origin: 'https://evil.invalid' })).status, 403);
  assert.deepEqual((await f.request('/api/sessions')).body, []);
  assert.equal(f.fake.calls.length, 0);
});

test('a single source is rate limited after eight failed logins', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await f.request('/api/login', {
    method: 'POST', body: { password: 'wrong' }, authenticated: false,
  })).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { password: PASSWORD }, authenticated: false })).status, 429);
});

test('parallel runs are capped, one per session, with slots reserved before asynchronous persistence', async t => {
  const f = await fixture(t); await f.login();
  const sessions = [await f.create(), await f.create(), await f.create(), await f.create()];
  const results = await Promise.all(sessions.map((s, i) => f.request(`/api/sessions/${s.id}/messages`, {
    method: 'POST', body: { text: `任务${i}`, requestId: `request-${i}` },
  })));
  assert.deepEqual(results.map(r => r.status).sort(), [202, 202, 202, 409]);
  assert.equal(f.fake.calls.length, 3); assert.equal(f.wb.runs.size, 3);
  assert.match(results.find(r => r.status === 409).body.error, /3 个任务在并行运行/);
  const index = results.findIndex(r => r.status === 202), first = sessions[index], waiting = sessions[results.findIndex(r => r.status === 409)];
  // A network retry is accepted without spawning again; a second turn in a running session is refused.
  assert.equal((await f.request(`/api/sessions/${first.id}/messages`, {
    method: 'POST', body: { text: '网络重试', requestId: `request-${index}` },
  })).status, 202);
  assert.equal((await f.request(`/api/sessions/${first.id}/messages`, { method: 'POST', body: { text: '插队', requestId: 'other' } })).status, 409);
  assert.equal(f.fake.calls.length, 3);
  assert.equal((await f.request(`/api/sessions/${first.id}`, { method: 'PATCH', body: { model: 'opus' } })).status, 409);
  assert.equal((await f.request(`/api/sessions/${waiting.id}`, { method: 'PATCH', body: { model: 'opus' } })).status, 200);
  // A finished run frees its slot for the session that had to wait.
  await f.fake.calls.find(c => c.options.cwd.endsWith(first.id)).finish();
  assert.equal((await f.request(`/api/sessions/${waiting.id}/messages`, { method: 'POST', body: { text: '接上空位' } })).status, 202);
  assert.equal(f.fake.calls.length, 4); assert.equal(f.wb.runs.size, 3);
  for (const call of f.fake.calls) await call.finish();
  assert.equal(f.wb.runs.size, 0);
});

test('a running chat or terminal holds back only its own session', async t => {
  const f = await fixture(t); await f.login(); const a = await f.create(), b = await f.create(), c = await f.create();
  assert.equal((await f.request(`/api/sessions/${a.id}/messages`, { method: 'POST', body: { text: 'A 的任务' } })).status, 202);
  assert.equal((await f.request(`/api/sessions/${a.id}/file`, { method: 'PUT', body: { path: 'a.txt', text: 'a', hash: null } })).status, 409);
  assert.equal((await f.request(`/api/sessions/${b.id}/file`, { method: 'PUT', body: { path: 'b.txt', text: 'b', hash: null } })).status, 200);
  assert.equal((await f.request(`/api/sessions/${b.id}`, { method: 'PATCH', body: { effort: 'high' } })).status, 200);
  const term = await f.request('/api/terminals', { method: 'POST', body: { sessionId: b.id, kind: 'shell' } });
  assert.equal(term.status, 201);
  assert.equal((await f.request(`/api/sessions/${b.id}/messages`, { method: 'POST', body: { text: '被自己的终端挡住' } })).status, 409);
  assert.equal((await f.request(`/api/sessions/${c.id}/messages`, { method: 'POST', body: { text: 'C 的任务' } })).status, 202);
  assert.equal(f.wb.runs.size, 2);
  assert.equal((await f.request('/api/terminals/' + term.body.id + '/stop', { method: 'POST', body: {} })).status, 200);
  await f.wb.terminals.get(term.body.id).done;
  for (const call of f.fake.calls) await call.finish();
});

test('approval is bound to an existing request and is processed at most once', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '检查服务' } });
  const call = f.fake.calls[0];
  call.emit({ type: 'permission', id: 'approval-1', toolName: 'Bash', input: { command: 'true' } });
  assert.equal((await f.request(`/api/sessions/${s.id}/permissions/missing`, { method: 'POST', body: { allow: true } })).status, 409);
  assert.equal((await f.request(`/api/sessions/${s.id}/permissions/approval-1`, { method: 'POST', body: { allow: 'true' } })).status, 400);
  const results = await Promise.all([true, false].map(allow => f.request(`/api/sessions/${s.id}/permissions/approval-1`, { method: 'POST', body: { allow } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(call.approvals.length, 1);
  assert.equal((await f.request(`/api/sessions/${s.id}`)).body.permissions.length, 0);
});

test('CLI cancellation removes the revoked approval from the public state', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '检查服务' } });
  const call = f.fake.calls[0];
  call.emit({ type: 'permission', id: 'revoked-1', toolName: 'Bash', input: { command: 'true' } });
  call.emit({ type: 'permission_cancelled', id: 'revoked-1' });
  const current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.deepEqual(current.permissions, []);
  assert.equal(current.status, 'running');
  assert.equal((await f.request(`/api/sessions/${s.id}/permissions/revoked-1`, { method: 'POST', body: { allow: true } })).status, 409);
  assert.deepEqual(call.approvals, []);
});

test('stopping an active run calls its handle and clears pending approvals', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '检查服务' } });
  const call = f.fake.calls[0];
  call.emit({ type: 'permission', id: 'stop-1', toolName: 'Bash', input: { command: 'true' } });
  assert.equal((await f.request(`/api/sessions/${s.id}/stop`, { method: 'POST', body: {} })).status, 200);
  await call.handle.done;
  assert.equal(call.stops, 1);
  assert.equal(f.wb.runs.size, 0);
  const current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.status, 'idle'); assert.deepEqual(current.permissions, []);
});

test('guidance joins the running turn once, follows its delivery and is refused when no turn can take it', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  const steer = body => f.request(`/api/sessions/${s.id}/steer`, { method: 'POST', body });
  const view = async () => (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal((await steer({ text: '改用 pnpm' })).status, 409);
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '安装依赖' } });
  const call = f.fake.calls[0];
  assert.equal((await steer({ text: '  ' })).status, 400);
  assert.equal((await steer({ text: ' 改用 pnpm ', requestId: 'steer-1' })).status, 202);
  assert.equal((await steer({ text: '改用 pnpm', requestId: 'steer-1' })).status, 202);
  assert.deepEqual(call.steers.map(x => x.text), ['改用 pnpm']);
  let current = await view();
  assert.equal(current.status, 'running');
  assert.deepEqual(current.messages.filter(m => m.role === 'user').map(m => [m.text, m.steer]), [['安装依赖', undefined], ['改用 pnpm', 'queued']]);
  assert.equal(current.messages.at(-1).id, call.steers[0].id);
  assert.equal(current.metrics.turns, 1); assert.equal(current.metrics.userMessages, 2);
  call.emit({ type: 'steer', id: call.steers[0].id, state: 'delivered' });
  assert.equal((await steer({ text: '顺便跑测试' })).status, 202);
  call.steerReply = { ok: false, reason: 'ending' };
  const late = await steer({ text: '再加文档' });
  assert.equal(late.status, 409); assert.match(late.body.error, /收尾/);
  await call.finish();
  current = await view();
  assert.equal(current.status, 'idle');
  assert.deepEqual(current.messages.filter(m => m.steer).map(m => [m.text, m.steer]), [['改用 pnpm', 'delivered'], ['顺便跑测试', 'dropped']]);
  assert.equal((await steer({ text: '再加文档' })).status, 409);
});

test('moving old history out never starts a turn at guidance sent during it', async t => {
  const { newSession, Store } = await import('../lib/state.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workbench-steer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Store(dir), t0 = Date.parse('2026-10-27T00:00:00.000Z'), at = i => new Date(t0 + i * 1000).toISOString();
  const trimmed = newSession();
  trimmed.messages = [{ id: 'a', role: 'user', text: '第 1 轮', createdAt: at(0) }, { id: 'a1', role: 'assistant', text: '好', createdAt: at(1) },
    { id: 'b', role: 'user', text: '第 2 轮', createdAt: at(2) }, { id: 'b1', role: 'user', text: '引导', steer: 'delivered', createdAt: at(3) },
    { id: 'b2', role: 'assistant', text: '好', createdAt: at(4) }, { id: 'c', role: 'user', text: '第 3 轮', createdAt: at(5) }];
  // The cut falls on the guidance inside turn 2: the window moves to the next turn rather than split turn 2.
  await store.trimHistory(trimmed, { maxMessages: 4, keepMessages: 3 });
  assert.deepEqual(trimmed.messages.map(m => m.id), ['c']);
  assert.equal(trimmed.history.turns, 2);
});

test('stop requested while the initial save is pending must prevent a later live run', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  const save = f.wb.store.save.bind(f.wb.store);
  let release, signalEntered;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { signalEntered = resolve; });
  let first = true;
  f.wb.store.save = async value => {
    if (first && value.id === s.id && value.status === 'running') {
      first = false; signalEntered(); await blocked;
    }
    return save(value);
  };
  const submitting = f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '可取消的任务' } });
  await entered;
  assert.equal((await f.request(`/api/sessions/${s.id}/stop`, { method: 'POST', body: {} })).status, 200);
  release(); await submitting;
  assert(f.fake.calls.length === 0 || f.fake.calls.every(call => call.stops > 0), 'CLI must not remain active after an acknowledged stop');
});

test('session identity and cumulative result snapshots survive service restart without double counting', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '第一轮' } });
  f.fake.calls[0].emit({ type: 'session', sessionId: CLAUDE_SESSION });
  f.fake.calls[0].emit({ type: 'usage', scope: 'session', final: true, inputTokens: 100, outputTokens: 20, costUsd: 1, durationMs: 1000, apiDurationMs: 600 });
  await f.fake.calls[0].finish();
  await f.stop(); await f.start();
  assert.equal((await f.request('/api/auth')).body.authenticated, true);
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '恢复后第二轮' } });
  assert.equal(f.fake.calls[1].options.sessionId, CLAUDE_SESSION);
  for (let i = 0; i < 2; i++) f.fake.calls[1].emit({ type: 'usage', scope: 'session', final: true, inputTokens: 150, outputTokens: 30, costUsd: 1.4, durationMs: 2000, apiDurationMs: 800 });
  await f.fake.calls[1].finish();
  const current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.metrics.inputTokens, 150); assert.equal(current.metrics.outputTokens, 30);
  assert.equal(current.metrics.costUsd, 1.4); assert.equal(current.metrics.apiDurationMs, 1400);
  assert.equal(current.metrics.userMessages, 2); assert.equal(current.metrics.turns, 2);
  assert.equal('claudeSessionId' in current, false);
});

test('context-only streaming snapshots must not replace the persisted cumulative ledger', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '第一轮' } });
  f.fake.calls[0].emit({ type: 'usage', scope: 'session', final: true, inputTokens: 100, outputTokens: 20, costUsd: 1 });
  await f.fake.calls[0].finish();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '第二轮' } });
  f.fake.calls[1].emit({ type: 'usage', scope: 'response', final: false, inputTokens: 250, outputTokens: 50, contextTokens: 300 });
  const current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.metrics.contextTokens, 300);
  assert.equal(current.metrics.inputTokens, 100);
  assert.equal(current.metrics.outputTokens, 20);
});

test('legacy per-turn token accounting still respects cumulative costScope', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '第一轮' } });
  f.fake.calls[0].emit({ type: 'usage', scope: 'turn', costScope: 'session', final: true, inputTokens: 100, outputTokens: 20, costUsd: 1 });
  await f.fake.calls[0].finish();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '第二轮' } });
  f.fake.calls[1].emit({ type: 'usage', scope: 'turn', costScope: 'session', final: true, inputTokens: 50, outputTokens: 10, costUsd: 1.4 });
  await f.fake.calls[1].finish();
  const current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.metrics.inputTokens, 150);
  assert.equal(current.metrics.costUsd, 1.4);
});

test('a rejected PATCH leaves all session fields unchanged', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create({ title: '原始标题' });
  const rejected = await f.request(`/api/sessions/${s.id}`, { method: 'PATCH', body: { title: '不应提交', archived: true, model: 'invalid' } });
  assert.equal(rejected.status, 400);
  const current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.title, '原始标题'); assert.equal(current.archived, false);
});

test('shutdown cancels a run whose initial save has not returned', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  const save = f.wb.store.save.bind(f.wb.store);
  let release, signalEntered, first = true;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { signalEntered = resolve; });
  f.wb.store.save = async value => {
    if (first && value.id === s.id && value.status === 'running') {
      first = false; signalEntered(); await blocked;
    }
    return save(value);
  };
  const submitting = f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '关闭期间的任务' } });
  await entered;
  const closing = f.wb.close();
  release(); await submitting; await closing;
  assert(f.fake.calls.length === 0 || f.fake.calls.every(call => call.stops > 0), 'service shutdown must not leave a newly started child');
  assert.equal((await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '关闭后的任务' } })).status, 503);
});

test('persisted interrupted sessions recover as errors and discard stale approvals', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  const stored = f.wb.store.get(s.id);
  stored.status = 'awaiting_approval';
  stored.claudeSessionId = CLAUDE_SESSION;
  stored.permissions = [{ id: 'old-approval', toolName: 'Bash', input: { command: 'true' } }];
  stored.metrics.inputTokens = 42;
  await f.wb.store.save(stored);
  await f.stop(); await f.start();
  const current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.status, 'error'); assert.deepEqual(current.permissions, []);
  assert.equal(current.metrics.inputTokens, 42);
  assert(current.events.some(event => event.type === 'interrupted'));
  assert.equal((await f.request(`/api/sessions/${s.id}/permissions/old-approval`, { method: 'POST', body: { allow: true } })).status, 409);
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '重新开始' } });
  assert.equal(f.fake.calls[0].options.sessionId, CLAUDE_SESSION);
});

test('timeout and CLI errors remain errors after the stop/exit sequence', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '会超时的任务' } });
  f.fake.calls[0].emit({ type: 'error', message: '执行超时' });
  await f.fake.calls[0].finish({ code: null, stopped: true, timedOut: true });
  const current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.status, 'error'); assert.equal(current.lastError, '执行超时');
  assert.equal(f.wb.runs.size, 0);
});

test('a CLI the host ended after a successful result leaves the session idle, other non-zero exits do not', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '普通任务' } });
  await f.fake.calls[0].finish({ code: 143, stopped: false, endedAfterResult: true });
  let current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.status, 'idle'); assert.equal(current.lastError, null);
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '再来一次' } });
  await f.fake.calls[1].finish({ code: 143, stopped: false });
  current = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(current.status, 'error'); assert.equal(current.lastError, 'Claude Code 进程已退出，请查看本轮记录后重试。');
});

test('model lists come from the CLI; Fable and pinned versions are selectable and recorded',async t=>{
 const f=await fixture(t);await f.login();
 assert.deepEqual((await f.request('/api/bootstrap')).body.config.models.map(m=>m.value),['opus','sonnet','fable','haiku']);
 assert.equal((await f.request('/api/sessions',{method:'POST',body:{model:'claude-opus 4'}})).status,400);
 const s=await f.create({model:'fable'});assert.equal(s.model,'fable');
 await f.request(`/api/sessions/${s.id}/messages`,{method:'POST',body:{text:'hello'}});assert.equal(f.fake.calls[0].options.model,'fable');
 f.fake.calls[0].emit({type:'capabilities',version:'2.9.0',models:[{value:'fable',displayName:'Fable',resolvedModel:'claude-fable-5-1'},{value:'claude-opus-4-6',displayName:'Opus 4.6',resolvedModel:'claude-opus-4-6'}]});
 f.fake.calls[0].emit({type:'message',role:'assistant',id:'a1',text:'hi',model:'claude-fable-5-1'});await f.fake.calls[0].finish();
 const current=(await f.request(`/api/sessions/${s.id}`)).body;
 assert.equal(current.messages.find(m=>m.role==='user').model,'fable');
 assert.equal(current.messages.find(m=>m.role==='assistant').model,'claude-fable-5-1');
 assert.deepEqual((await f.request('/api/bootstrap')).body.config.models.map(m=>m.value),['fable','claude-opus-4-6']);
 assert.equal((await f.request(`/api/sessions/${s.id}`,{method:'PATCH',body:{model:'claude-opus-4-6'}})).body.model,'claude-opus-4-6');
 await f.request(`/api/sessions/${s.id}/messages`,{method:'POST',body:{text:'again'}});
 assert.equal((await f.request(`/api/sessions/${s.id}`)).body.messages.filter(m=>m.role==='user').at(-1).resolvedModel,'claude-opus-4-6');
 await f.fake.calls[1].finish();
});

test('effort persists, validates atomically and reaches the official CLI adapter',async t=>{
 const f=await fixture(t);await f.login();const s=await f.create({model:'haiku',effort:'high'});
 assert.equal(s.effort,'high');const bootstrap=await f.request('/api/bootstrap');assert(bootstrap.body.config.effortLevels.includes('xhigh'));assert.equal(bootstrap.body.usage.fiveHour.utilization,2);
 assert.equal((await f.request(`/api/sessions/${s.id}`,{method:'PATCH',body:{title:'bad update',effort:'injected'}})).status,400);
 assert.notEqual((await f.request(`/api/sessions/${s.id}`)).body.title,'bad update');
 await f.request(`/api/sessions/${s.id}/messages`,{method:'POST',body:{text:'hello'}});assert.equal(f.fake.calls[0].options.effort,'high');assert.equal(f.fake.calls[0].options.model,'haiku');await f.fake.calls[0].finish();
});

test('workspace routes protect secrets, block escape, require hashes and refuse edits while a task runs',async t=>{
 const f=await fixture(t);await f.login();const s=await f.create();const route=`/api/sessions/${s.id}`;
 assert.equal((await f.request(route+'/file',{method:'PUT',body:{path:'hello.txt',text:'你好',hash:null}})).status,200);
 const file=await f.request(route+'/file?path=hello.txt');assert.equal(file.body.text,'你好');assert.equal(file.body.hash.length,64);
 assert.equal((await f.request(route+'/file',{method:'PUT',body:{path:'hello.txt',text:'new',hash:'0'.repeat(64)}})).status,409);
 assert.equal((await f.request(route+'/file',{method:'PUT',body:{path:'hello.txt',text:'updated',hash:file.body.hash}})).status,200);
 assert.equal((await f.request(route+'/file?path=../outside')).status,400);
 assert.equal((await f.request(route+'/file',{method:'PUT',body:{path:'.env',text:'secret',hash:null}})).status,403);
 const uploaded=await f.request(route+'/upload',{method:'POST',body:{path:'upload.txt',base64:Buffer.from('upload').toString('base64')}});assert.equal(uploaded.status,201);
 assert((await f.request(route+'/files')).body.entries.some(x=>x.name==='upload.txt'));
 await f.request(route+'/messages',{method:'POST',body:{text:'task'}});assert.equal((await f.request(route+'/file',{method:'PUT',body:{path:'new.txt',text:'x',hash:null}})).status,409);await f.fake.calls[0].finish();
});

test('AskUserQuestion accepts only answers and never rewritten tool input',async t=>{
 const f=await fixture(t);await f.login();const s=await f.create();const route=`/api/sessions/${s.id}`;
 await f.request(route+'/messages',{method:'POST',body:{text:'ask'}});const call=f.fake.calls[0];let actual;
 call.handle.respondPermission=(id,allow,input)=>{actual={id,allow,input};return true;};
 call.emit({type:'permission',id:'question',toolName:'AskUserQuestion',input:{questions:[{question:'选择环境',options:[{label:'测试'}]}]}});
 assert.equal((await f.request(route+'/permissions/question',{method:'POST',body:{allow:true}})).status,400);
 assert.equal((await f.request(route+'/permissions/question',{method:'POST',body:{allow:true,answers:{'选择环境':'测试'},updatedInput:{command:'unsafe'}}})).status,200);
 assert.equal(actual.input.answers['选择环境'],'测试');assert.equal(actual.input.command,undefined);assert.equal(actual.input.questions,undefined);await call.finish();
});

test('terminal creation is authenticated and mutually exclusive with a running chat',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/terminals')).status,401);await f.login();const s=await f.create();
 assert.equal((await f.request('/api/terminals',{method:'POST',body:{sessionId:s.id,kind:'shell'},csrfToken:null})).status,403);
 await f.request(`/api/sessions/${s.id}/messages`,{method:'POST',body:{text:'task'}});
 assert.equal((await f.request('/api/terminals',{method:'POST',body:{sessionId:s.id,kind:'shell'}})).status,409);await f.fake.calls[0].finish();
 const made=await f.request('/api/terminals',{method:'POST',body:{sessionId:s.id,kind:'shell'}});assert.equal(made.status,201);
 assert.equal((await f.request(`/api/sessions/${s.id}/messages`,{method:'POST',body:{text:'conflict'}})).status,409);
 assert.equal((await f.request('/api/terminals/'+made.body.id+'/stop',{method:'POST',body:{}})).status,200);
 await f.wb.terminals.get(made.body.id).done;
});

test('an in-flight file save reserves the task slot before its async disk write',async t=>{
 const {Workspace}=await import('../lib/workspace.mjs');const original=Workspace.prototype.write;
 const f=await fixture(t);await f.login();const s=await f.create();let entered,release;
 const observed=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 Workspace.prototype.write=async function(...args){entered();await gate;return original.apply(this,args);};
 t.after(()=>{Workspace.prototype.write=original;release();});
 const saving=f.request(`/api/sessions/${s.id}/file`,{method:'PUT',body:{path:'reservation.txt',text:'save',hash:null}});await observed;
 assert.equal((await f.request(`/api/sessions/${s.id}/messages`,{method:'POST',body:{text:'must wait'}})).status,409);
 assert.equal((await f.request('/api/terminals',{method:'POST',body:{sessionId:s.id,kind:'shell'}})).status,409);
 release();assert.equal((await saving).status,200);Workspace.prototype.write=original;
});


test('new sessions default to automatic tool approval and explicit manual or plan modes remain available', async t => {
 const f=await fixture(t);await f.login();
 const created=await f.request('/api/sessions',{method:'POST',body:{title:'自动同意'}});
 assert.equal(created.status,201);assert.equal(created.body.permissionMode,'bypassPermissions');
 await f.request(`/api/sessions/${created.body.id}/messages`,{method:'POST',body:{text:'自动执行'}});
 assert.equal(f.fake.calls[0].options.permissionMode,'bypassPermissions');
 await f.fake.calls[0].finish();
 for(const mode of ['default','plan','bypassPermissions']) {
  const result=await f.request(`/api/sessions/${created.body.id}`,{method:'PATCH',body:{permissionMode:mode}});
  assert.equal(result.status,200);assert.equal(result.body.permissionMode,mode);
 }
 await f.stop();await f.start();await f.login();
 assert.equal((await f.request(`/api/sessions/${created.body.id}`)).body.permissionMode,'bypassPermissions');
});

test('the live view drops the audit log and caps tool text while full records stay reachable', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '读取大文件' } });
  const output = '日志'.repeat(5000), content = 'x'.repeat(30000);
  f.fake.calls[0].emit({ type: 'tool', id: 'toolu_big', name: 'Write', input: { file_path: '/tmp/a.txt', content }, status: 'running' });
  f.fake.calls[0].emit({ type: 'tool', id: 'toolu_big', name: 'Write', input: { file_path: '/tmp/a.txt', content }, status: 'completed', output });
  f.fake.calls[0].emit({ type: 'thinking_progress', estimated: true, estimatedTokens: 10 });
  await f.fake.calls[0].finish();
  const full = (await f.request(`/api/sessions/${s.id}`)).body;
  assert(Array.isArray(full.events));
  const toolEvents = full.events.filter(e => e.type === 'tool');
  assert.deepEqual(toolEvents.map(e => e.status), ['running', 'completed']);
  assert(toolEvents.every(e => !('input' in e) && !('output' in e)), 'tool payloads are not duplicated in the event log');
  assert.equal(full.events.some(e => e.type === 'thinking_progress'), false);
  const live = (await f.request(`/api/sessions/${s.id}?view=live`)).body;
  assert.equal('events' in live, false);
  assert.equal('claudeSessionId' in live, false);
  const tool = live.tools.find(x => x.id === 'toolu_big');
  assert.equal(tool.output.length, 4000); assert.equal(tool.outputTruncated, true); assert.equal(tool.outputLength, output.length);
  assert.equal(tool.input.content.length, 20000); assert.equal(tool.inputTruncated, true); assert.equal(tool.input.file_path, '/tmp/a.txt');
  const record = await f.request(`/api/sessions/${s.id}/tools/toolu_big`);
  assert.equal(record.status, 200); assert.equal(record.body.output, output); assert.equal(record.body.input.content, content);
  assert.equal((await f.request(`/api/sessions/${s.id}/tools/missing`)).status, 404);
  assert.equal((await f.request(`/api/sessions/${s.id}/tools/toolu_big`, { authenticated: false })).status, 401);
});

test('session-updated events carry the list summary for status badges', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create({ title: '状态同步' });
  const controller = new AbortController();
  const response = await fetch(`${f.base}/api/events`, { headers: { Cookie: f.cookie }, signal: controller.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const next = async predicate => {
    for (;;) {
      const frames = buffer.split('\n\n'); buffer = frames.pop();
      for (const frame of frames) { const line = frame.split('\n').find(l => l.startsWith('data: ')); if (!line) continue; const data = JSON.parse(line.slice(6)); if (predicate(data)) return data; }
      const { value, done } = await reader.read(); if (done) throw new Error('stream ended'); buffer += decoder.decode(value, { stream: true });
    }
  };
  t.after(() => controller.abort());
  await next(data => data.type === 'connected');
  await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '开始' } });
  const running = await next(data => data.type === 'session-updated' && data.summary?.status === 'running');
  assert.equal(running.sessionId, s.id); assert.equal(running.summary.title, '状态同步');
  assert.equal('messages' in running.summary, false);
  // The list is ordered by activeAt, the last message the user sent, so streamed saves don't reorder it.
  const sent = (await f.request(`/api/sessions/${s.id}`)).body.messages.findLast(m => m.role === 'user').createdAt;
  assert.equal(running.summary.activeAt, sent);
  await f.fake.calls[0].finish();
  const idle = await next(data => data.type === 'session-updated' && data.summary?.status === 'idle');
  assert.equal(idle.summary.id, s.id); assert.equal(idle.summary.activeAt, sent);
});

// Keeps every frame: a match never discards the frames that arrived with it.
function sseReader(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder(), queue = [];
  let buffer = '', pending = null;
  async function pull(timeoutMs) {
    pending ||= reader.read();
    const result = await (timeoutMs === undefined ? pending : Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))]));
    if (!result) return;
    pending = null;
    if (result.done) throw new Error('stream ended');
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split('\n\n'); buffer = frames.pop();
    for (const frame of frames) { const line = frame.split('\n').find(l => l.startsWith('data: ')); if (line) queue.push(JSON.parse(line.slice(6))); }
  }
  return {
    async next(predicate) { for (;;) { const index = queue.findIndex(predicate); if (index >= 0) return queue.splice(index, 1)[0]; await pull(); } },
    async drain(ms) { const end = Date.now() + ms; while (Date.now() < end) await pull(Math.max(1, end - Date.now())); return queue.splice(0); },
    clear() { queue.length = 0; },
  };
}

test('streaming changes arrive as ordered SSE patches that line up with live snapshots', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create({ title: '实时推送' });
  const controller = new AbortController();
  const response = await fetch(`${f.base}/api/events?patches=1`, { headers: { Cookie: f.cookie }, signal: controller.signal });
  t.after(() => controller.abort());
  const sse = sseReader(response);
  await sse.next(data => data.type === 'connected');
  const started = await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '开始' } });
  assert.equal(started.status, 202);
  assert.equal(typeof started.body.live.epoch, 'string'); assert.equal(started.body.live.seq, 0);
  const call = f.fake.calls[0];
  call.emit({ type: 'thinking_start', messageId: 'msg_1' });
  call.emit({ type: 'thinking_delta', text: '想一想', messageId: 'msg_1' });
  call.emit({ type: 'thinking_stop', messageId: 'msg_1' });
  call.emit({ type: 'text_delta', text: '你好', messageId: 'msg_1' });
  call.emit({ type: 'text_delta', text: '，世界', messageId: 'msg_1' });
  const first = await sse.next(data => data.type === 'session-patch');
  sse.clear();
  assert.equal(first.sessionId, s.id); assert.equal(first.seq, 1); assert.equal(first.epoch, started.body.live.epoch);
  assert.deepEqual(first.ops.filter(op => op.op === 'append').map(op => [op.field, op.value]), [['thinking', '想一想'], ['text', '你好，世界']]);
  const meta = first.ops.find(op => op.op === 'message').meta;
  assert(meta.thinkingStartedAt && meta.thinkingEndedAt);

  call.emit({ type: 'tool', id: 'toolu_1', name: 'Bash', input: { command: 'ls' }, status: 'running' });
  call.emit({ type: 'text_delta', text: '!', messageId: 'msg_1' });
  const live = (await f.request(`/api/sessions/${s.id}?view=live`)).body;
  assert.equal(live.live.epoch, first.epoch);
  assert.equal(live.live.seq, 2, 'a snapshot flushes pending patches before reporting its position');
  assert.equal(live.messages.find(m => m.id === 'msg_1').text, '你好，世界!');
  assert.equal(live.tools.find(tool => tool.id === 'toolu_1').status, 'running');
  const second = await sse.next(data => data.type === 'session-patch');
  assert.equal(second.seq, 2);
  assert(second.ops.some(op => op.op === 'tool' && op.tool.id === 'toolu_1'));
  const quiet = await sse.drain(450);
  assert.equal(quiet.some(data => data.type === 'session-updated' && data.sessionId === s.id), false,
    'patched events no longer schedule snapshot refetches');

  call.emit({ type: 'permission', id: 'perm-1', toolName: 'Bash', input: { command: 'rm -rf build' } });
  const waiting = await sse.next(data => data.type === 'session-updated' && data.summary?.status === 'awaiting_approval');
  assert.equal(waiting.sessionId, s.id);
  await call.finish();
  await sse.next(data => data.type === 'session-updated' && data.summary?.status === 'idle');
  const full = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(full.live.epoch, first.epoch);
  assert(full.live.seq >= 2);
  assert.equal(full.events.some(e => e.type.startsWith('thinking')), false);
});

test('answers to a page\'s own requests carry the change revision, and quiet CLI events ask for no refetch', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create({ title: '修订号' });
  const controller = new AbortController();
  const response = await fetch(`${f.base}/api/events?patches=1`, { headers: { Cookie: f.cookie }, signal: controller.signal });
  t.after(() => controller.abort());
  const sse = sseReader(response);
  await sse.next(data => data.type === 'connected');
  const started = await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '开始' } });
  assert.equal(started.status, 202);
  assert.equal('events' in started.body, false, 'mutation answers use the live view');
  assert.equal(started.body.messages.at(-1).text, '开始');
  const running = await sse.next(data => data.type === 'session-updated' && data.summary?.status === 'running');
  assert.equal(running.epoch, started.body.live.epoch);
  assert(Number.isInteger(running.rev) && started.body.live.rev >= running.rev, 'the answer already contains the announced change');
  const call = f.fake.calls[0];
  for (const event of [{ type: 'session', sessionId: CLAUDE_SESSION }, { type: 'rate_limit', status: 'allowed', rateLimited: false, windows: {} },
    { type: 'quota', source: 'official-cli-usage', fiveHour: { utilization: 3 } }]) call.emit(event);
  call.emit({ type: 'task', id: 'task-1', status: 'running', description: '子代理' });
  const patch = await sse.next(data => data.type === 'session-patch');
  assert.deepEqual(patch.ops.map(op => [op.op, op.task?.status]), [['task', 'running']]);
  const capabilities = { type: 'capabilities', commands: [{ name: 'compact' }], models: [], agents: [], version: '2.1.300' };
  call.emit(capabilities);
  const changed = await sse.next(data => data.type === 'session-updated' && data.sessionId === s.id);
  assert(changed.rev > running.rev);
  sse.clear(); call.emit({ ...capabilities });
  const quiet = await sse.drain(450);
  assert.equal(quiet.some(data => data.type === 'session-updated' && data.sessionId === s.id), false,
    'session ids, quota reports, allowed rate limits and unchanged capabilities need no snapshot');
  const live = (await f.request(`/api/sessions/${s.id}?view=live`)).body;
  assert.equal(live.live.rev, changed.rev); assert.equal(live.tasks[0].status, 'running');
  const stopped = await f.request(`/api/sessions/${s.id}/stop`, { method: 'POST', body: {} });
  const stopping = await sse.next(data => data.type === 'session-updated' && data.sessionId === s.id);
  assert(stopped.body.live.rev >= stopping.rev && stopping.rev > changed.rev);
  assert(Array.isArray((await f.request(`/api/sessions/${s.id}`)).body.events), 'the full view keeps the audit log');
});

test('pages opened before live patches keep getting debounced session-updated while a reply streams', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.login(); const s = await f.create({ title: '旧页面' });
  const controller = new AbortController(); t.after(() => controller.abort());
  const open = async path => { const sse = sseReader(await fetch(`${f.base}${path}`, { headers: { Cookie: f.cookie }, signal: controller.signal })); await sse.next(data => data.type === 'connected'); return sse; };
  const legacy = await open('/api/events'), patched = await open('/api/events?patches=1');
  assert.equal((await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '开始' } })).status, 202);
  const started = data => data.type === 'session-updated' && data.summary?.status === 'running';
  await Promise.all([legacy.next(started), patched.next(started)]);
  const call = f.fake.calls[0];
  call.emit({ type: 'text_delta', text: '你好', messageId: 'msg_1' });
  call.emit({ type: 'text_delta', text: '，世界', messageId: 'msg_1' });
  const update = await legacy.next(data => data.type === 'session-updated');
  assert.equal(update.sessionId, s.id); assert.equal(update.summary.status, 'running');
  await patched.next(data => data.type === 'session-patch');
  const [legacyRest, patchedRest] = await Promise.all([legacy.drain(450), patched.drain(450)]);
  assert.equal(legacyRest.some(data => data.type === 'session-patch'), false, 'old pages do not understand patches');
  assert.equal(legacyRest.some(data => data.type === 'session-updated'), false, 'deltas within 350ms share one refetch hint');
  assert.equal(patchedRest.some(data => data.type === 'session-updated'), false, 'patching pages get no refetch hints for streamed text');
  await call.finish();
});

test('long sessions move older turns to a history file instead of refusing new messages', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  const tick = () => new Promise(resolve => setTimeout(resolve, 3));
  for (let turn = 0; turn < 3; turn++) {
    assert.equal((await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: `第 ${turn + 1} 轮` } })).status, 202);
    await tick();
    const call = f.fake.calls[turn];
    for (let i = 0; i < 200; i++) call.emit({ type: 'message', id: `m${turn}-${i}`, text: i % 2 ? `回复 ${i}` : '' });
    for (let i = 0; i < 50; i++) call.emit({ type: 'tool', id: `t${turn}-${i}`, name: 'Bash', status: 'completed', output: 'ok' });
    await call.finish(); await tick();
  }
  assert.equal((await f.request(`/api/sessions/${s.id}`)).body.messages.length, 603);
  // A start that fails after the move keeps the moved records out of the live window.
  const auth = f.config.monitor.auth; f.config.monitor.auth = async () => ({ loggedIn: false });
  assert.equal((await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '未登录时发送' } })).status, 409);
  f.config.monitor.auth = auth;
  const failed = (await f.request(`/api/sessions/${s.id}`)).body;
  assert.equal(failed.messages.length, 201); assert.equal(failed.history.messages, 402); assert.equal(failed.metrics.userMessages, 3);
  const sent = await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: '第 4 轮' } });
  assert.equal(sent.status, 202, 'no length cap');
  f.fake.calls[3].emit({ type: 'tool', id: 't3-0', name: 'Bash', status: 'completed', output: 'ok' });
  await f.fake.calls[3].finish();
  const live = (await f.request(`/api/sessions/${s.id}?view=live`)).body;
  // The window starts at the first user message that still keeps the newest 300 records: turns 3 and 4 stay.
  assert.deepEqual(live.messages.filter(m => m.role === 'user').map(m => m.text), ['第 3 轮', '第 4 轮']);
  assert.equal(live.messages.length, 202); assert.equal(live.tools.length, 51);
  const { until, ...moved } = live.history;
  assert.deepEqual(moved, { messages: 402, tools: 100, turns: 2, replies: 200, assistantMessages: 400 });
  assert.equal(until, live.messages[0].createdAt);
  assert.equal(live.metrics.toolCalls, 151); assert.equal(live.metrics.userMessages, 4);
  const file = path.join(f.config.dataDir, 'sessions', `${s.id}.history.jsonl`);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(file, 'utf8')).trim().split('\n').length, 502);
  await f.stop(); await f.start();
  assert.equal((await f.request(`/api/sessions/${s.id}`)).body.messages.length, 202, 'the history file is not loaded as a session');
  assert.deepEqual((await f.request('/api/sessions')).body.map(x => x.id), [s.id]);
  const exported = (await f.request(`/api/sessions/${s.id}/export`)).body;
  assert.equal(exported.messages.length, 604); assert.equal(exported.tools.length, 151);
  assert.equal(new Set(exported.messages.map(m => m.id)).size, 604);
  assert.deepEqual(exported.messages.filter(m => m.role === 'user').map(m => m.text), ['第 1 轮', '第 2 轮', '第 3 轮', '第 4 轮']);
  assert.equal(exported.tools[0].id, 't0-0'); assert.equal(exported.tools.at(-1).id, 't3-0');
  assert.equal('kind' in exported.messages[0], false);
});

test('a turn with more records than the page keeps stays whole when older turns move out', async t => {
  const f = await fixture(t); await f.login(); const s = await f.create();
  const tick = () => new Promise(resolve => setTimeout(resolve, 3));
  const turn = async (n, replies, tools) => {
    assert.equal((await f.request(`/api/sessions/${s.id}/messages`, { method: 'POST', body: { text: `第 ${n} 轮` } })).status, 202);
    await tick();
    const call = f.fake.calls.at(-1);
    for (let i = 0; i < replies; i++) call.emit({ type: 'message', id: `m${n}-${i}`, text: `回复 ${i}` });
    for (let i = 0; i < tools; i++) call.emit({ type: 'tool', id: `t${n}-${i}`, name: 'Bash', status: 'completed', output: 'ok' });
    await call.finish(); await tick();
  };
  const live = async () => (await f.request(`/api/sessions/${s.id}?view=live`)).body;
  // One turn past the limit has nothing older to move: it stays on the page in full.
  await turn(1, 650, 0); await turn(2, 400, 350);
  let view = await live();
  assert.equal(view.history, undefined); assert.equal(view.messages.length, 1052);
  // The cut for both messages and tools now falls inside turn 2, the newest one: only turn 1 moves.
  await turn(3, 1, 0);
  view = await live();
  assert.deepEqual(view.messages.filter(m => m.role === 'user').map(m => m.text), ['第 2 轮', '第 3 轮']);
  assert.equal(view.messages[0].text, '第 2 轮'); assert.equal(view.messages.length, 403); assert.equal(view.tools.length, 350);
  const { until, ...moved } = view.history;
  assert.deepEqual(moved, { messages: 651, tools: 0, turns: 1, replies: 650, assistantMessages: 650 });
  assert.equal(until, view.messages[0].createdAt);
  const exported = (await f.request(`/api/sessions/${s.id}/export`)).body;
  assert.equal(exported.messages.length, 1054); assert.equal(exported.tools.length, 350);
});
