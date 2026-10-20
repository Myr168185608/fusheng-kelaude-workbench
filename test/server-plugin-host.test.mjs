import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ServerPluginHost} from '../lib/server-plugins.mjs';

const sessionId = 'f22ada57-2b92-449b-bca5-0c9dd20ad603';
const officialId = '4b71cf50-667f-4a65-bc78-86f6ea666bf5';
const session = () => ({id: sessionId, claudeSessionId: officialId, status: 'running', permissions: []});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-host-'));
  const enabled = new Set();
  const manager = {plugins: new Map(), isActive: id => enabled.has(id)};
  const context = {isClosing: () => false};
  const host = new ServerPluginHost({manager, dataDir: dir, context});
  await host.init();
  t.after(async () => { await host.close().catch(() => {}); await fs.rm(dir, {recursive: true, force: true}); });
  const add = (id, instance) => { enabled.add(id); host.active.set(id, instance); };
  return {host, dir, manager, context, enabled, add};
}

test('a beforeRun that fails after mutation receives preflight cleanup', async t => {
  const f = await fixture(t);
  let changed = false, cleaned = false;
  f.add('partial-write', {
    async beforeRun() { changed = true; throw Object.assign(new Error('disk full'), {code: 'ENOSPC'}); },
    async onExit({result}) { assert.equal(result.preflightFailed, true); cleaned = true; changed = false; },
  });
  const s = session(), run = {messageId: 'preflight'};
  await assert.rejects(f.host.prepare({session: s, cwd: f.dir, request: {}, run}), /disk full/);
  assert.equal(changed, true);
  await f.host.exit({session: s, run, result: {preflightFailed: true}});
  assert.equal(cleaned, true);
  assert.equal(changed, false);
});

test('an established context owner remains guarded when a later hook fails, including after restart', async t => {
  const f = await fixture(t);
  f.add('account-context', {beforeRun: async () => ({runnerOptions: {configDir: path.join(f.dir, 'account-config')}, ownsContext: true})});
  f.add('later-failure', {beforeRun: async () => { throw new Error('checkpoint unavailable'); }});
  const s = session(), run = {messageId: 'ownership'};
  await assert.rejects(f.host.prepare({session: s, cwd: f.dir, request: {}, run}), /checkpoint unavailable/);
  await f.host.exit({session: s, run, result: {preflightFailed: true}});
  f.enabled.delete('account-context');
  assert.throws(() => f.host.assertContext(s), error => error.status === 409);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dir, 'server-plugin-data/session-contexts.json'), 'utf8'));
  assert(persisted[sessionId].includes('account-context'));
  const restarted = new ServerPluginHost({manager: f.manager, dataDir: f.dir, context: f.context});
  await restarted.init();
  assert.throws(() => restarted.assertContext(s), error => error.status === 409);
  await restarted.close();
});

test('malformed ownership entries fail closed instead of silently reverting to the base account', async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, 'server-plugin-data/session-contexts.json');
  for (const invalid of [
    {[sessionId]: 'account-pool'},
    {[sessionId]: ['../not-a-plugin']},
    {'not-a-session': ['account-pool']},
  ]) {
    await fs.writeFile(file, JSON.stringify(invalid));
    const restarted = new ServerPluginHost({manager: f.manager, dataDir: f.dir, context: f.context});
    await assert.rejects(restarted.init(), error => error.status === 500 && /归属记录损坏/.test(error.message));
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), invalid, 'corrupt ownership evidence is preserved for repair');
  }
});

test('queued permission, tool and done events retain their event-time session state', async t => {
  const f = await fixture(t), observed = [];
  const plugin = {async onEvent({session, event}) {
    observed.push({event: event.type, status: session.status, permissions: session.permissions.map(p => p.id), claudeSessionId: session.claudeSessionId});
  }};
  f.add('event-observer', plugin);
  const s = session(), run = {pluginEntries: [['event-observer', plugin]]};
  s.status = 'awaiting_approval'; s.permissions.push({id: 'permission-one'});
  f.host.event({session: s, run, event: {type: 'permission'}});
  s.status = 'running'; s.permissions.splice(0);
  f.host.event({session: s, run, event: {type: 'tool'}});
  s.status = 'idle';
  f.host.event({session: s, run, event: {type: 'done'}});
  await f.host.exit({session: s, run, result: {code: 0}});
  assert.deepEqual(observed, [
    {event: 'permission', status: 'awaiting_approval', permissions: ['permission-one'], claudeSessionId: officialId},
    {event: 'tool', status: 'running', permissions: [], claudeSessionId: officialId},
    {event: 'done', status: 'idle', permissions: [], claudeSessionId: officialId},
  ]);
});

test('one failing stop or close hook cannot prevent cleanup of other plugins', async t => {
  const f = await fixture(t);
  t.mock.method(console, 'error', () => {});
  const calls = [];
  f.add('broken-cleanup', {
    async onStop() { calls.push('broken-stop'); throw new Error('persistence failed'); },
    async close() { calls.push('broken-close'); throw new Error('cleanup failed'); },
  });
  f.add('working-cleanup', {
    async onStop() { calls.push('working-stop'); },
    async close() { calls.push('working-close'); },
  });
  await assert.doesNotReject(f.host.stop({session: session(), run: {}, reason: 'user'}));
  assert.deepEqual(calls, ['broken-stop', 'working-stop']);
  await assert.doesNotReject(f.host.close());
  assert.deepEqual(calls, ['broken-stop', 'working-stop', 'broken-close', 'working-close']);
  assert.equal(f.host.active.size, 0);
});
