import test from 'node:test';
import assert from 'node:assert/strict';
import { newSession, applyEvent } from '../lib/state.mjs';
import { LiveFeed, compactOps } from '../lib/live.mjs';

function harness() {
  const frames = [];
  const feed = new LiveFeed({ broadcast: frame => frames.push(structuredClone(frame)), delayMs: 5 });
  const session = newSession();
  const run = { messageId: 'fallback', usageBase: { ...session.metrics } };
  const apply = event => { const before = feed.before(session, event, run); applyEvent(session, event, run); return feed.after(session, event, run, before); };
  return { frames, feed, session, run, apply };
}

// The browser's patch reducer, reduced to what these tests need.
function replay(frames) {
  const messages = new Map(), tools = new Map(); let metrics = null;
  for (const frame of frames) for (const op of frame.ops) {
    if (op.op === 'message') messages.set(op.id, { ...(messages.get(op.id) || { text: '', thinking: '' }), ...op.meta });
    else if (op.op === 'append') { const m = messages.get(op.id); m[op.field] = (m[op.field] || '') + op.value; }
    else if (op.op === 'set') messages.get(op.id)[op.field] = op.value;
    else if (op.op === 'tool') tools.set(op.tool.id, op.tool);
    else if (op.op === 'metrics') metrics = op.metrics;
  }
  return { messages, tools, metrics };
}

test('streamed thinking and text become ordered append patches that rebuild the stored message', () => {
  const { frames, feed, session, apply } = harness();
  for (const event of [
    { type: 'thinking_start', messageId: 'msg_1' },
    { type: 'thinking_delta', text: '先', messageId: 'msg_1' },
    { type: 'thinking_progress', estimatedTokens: 4, messageId: 'msg_1' },
    { type: 'thinking_delta', text: '想想', messageId: 'msg_1' },
    { type: 'thinking_stop', messageId: 'msg_1' },
    { type: 'text_delta', text: '你好', messageId: 'msg_1' },
    { type: 'text_delta', text: '，世界', messageId: 'msg_1' },
    { type: 'message', role: 'assistant', text: '你好，世界', id: 'msg_1' },
  ]) assert.equal(apply(event), true, event.type);
  feed.flush(session.id);
  assert.equal(frames.length, 1);
  const [frame] = frames;
  assert.equal(frame.type, 'session-patch'); assert.equal(frame.sessionId, session.id);
  assert.equal(frame.seq, 1); assert.equal(frame.epoch, feed.epoch); assert(Date.parse(frame.now));
  assert.deepEqual(frame.ops.map(op => op.op), ['message', 'append', 'append'], 'appends merge and the newest meta keeps the creation slot');
  assert.deepEqual(frame.ops.slice(1).map(op => [op.field, op.value]), [['thinking', '先想想'], ['text', '你好，世界']]);
  const meta = frame.ops[0].meta;
  assert.equal(meta.role, 'assistant'); assert.equal(meta.thinkingTokens, 4);
  assert(meta.thinkingStartedAt && meta.thinkingEndedAt && meta.createdAt);
  const rebuilt = replay(frames).messages.get('msg_1'), stored = session.messages.find(m => m.id === 'msg_1');
  assert.equal(rebuilt.text, stored.text); assert.equal(rebuilt.thinking, stored.thinking);
  assert.equal(rebuilt.thinkingEndedAt, stored.thinkingEndedAt);
});

test('a final text that differs from the stream replaces it, while an identical one sends nothing', () => {
  const { frames, feed, session, apply } = harness();
  apply({ type: 'text_delta', text: '草稿', messageId: 'msg_1' });
  feed.flush(session.id);
  apply({ type: 'message', role: 'assistant', text: '草稿', id: 'msg_1' });
  feed.flush(session.id);
  assert.equal(frames.length, 1, 'no patch is queued when nothing changed');
  apply({ type: 'message', role: 'assistant', text: '定稿', id: 'msg_1' });
  feed.flush(session.id);
  assert.deepEqual(frames[1].ops, [{ op: 'set', id: 'msg_1', field: 'text', value: '定稿' }]);
  assert.equal(frames[1].seq, 2);
});

test('redacted thinking keeps streamed text and a later block is separated once', () => {
  const { frames, feed, session, apply } = harness();
  apply({ type: 'thinking_start', messageId: 'msg_1' });
  apply({ type: 'thinking_delta', text: '第一段思考', messageId: 'msg_1' });
  apply({ type: 'thinking_stop', messageId: 'msg_1' });
  apply({ type: 'thinking_start', messageId: 'msg_1' });
  apply({ type: 'thinking', text: '', redacted: true, id: 'msg_1' });
  apply({ type: 'thinking_stop', messageId: 'msg_1' });
  const message = session.messages.find(m => m.id === 'msg_1');
  assert.equal(message.thinking, '第一段思考'); assert.equal(message.thinkingRedacted, true);
  apply({ type: 'thinking_start', messageId: 'msg_1' });
  apply({ type: 'thinking_delta', text: '第二段', messageId: 'msg_1' });
  apply({ type: 'thinking_delta', text: '思考', messageId: 'msg_1' });
  assert.equal(message.thinking, '第一段思考\n\n第二段思考');
  assert.equal(message.thinkingEndedAt, undefined, 'a new block reopens the thinking phase');
  feed.flush(session.id);
  assert.equal(replay(frames).messages.get('msg_1').thinking, message.thinking);
});

test('reply text and the end of a run close any thinking phase that never reported a stop', () => {
  const { session, apply } = harness();
  apply({ type: 'thinking_delta', text: '思考', messageId: 'msg_1' });
  const first = session.messages.find(m => m.id === 'msg_1');
  assert(first.thinkingStartedAt); assert.equal(first.thinkingEndedAt, undefined);
  apply({ type: 'text_delta', text: '答案', messageId: 'msg_1' });
  assert(first.thinkingEndedAt);
  apply({ type: 'thinking_progress', estimatedTokens: 12, messageId: 'msg_2' });
  const second = session.messages.find(m => m.id === 'msg_2');
  assert.equal(second.thinkingTokens, 12); assert.equal(second.thinkingEndedAt, undefined);
  apply({ type: 'thinking_progress', estimatedTokens: 7, messageId: 'msg_2' });
  assert.equal(second.thinkingTokens, 12, 'the running estimate never moves backwards');
  apply({ type: 'done' });
  assert(second.thinkingEndedAt);
  assert.equal(session.events.some(e => e.type.startsWith('thinking')), false, 'thinking traffic stays out of the audit log');
});

test('tools and usage are patched, while status, permission and task changes need a snapshot', () => {
  const { frames, feed, session, apply } = harness();
  const output = '输出'.repeat(4000);
  assert.equal(apply({ type: 'tool', id: 'toolu_1', name: 'Bash', input: { command: 'ls' }, status: 'running' }), true);
  assert.equal(apply({ type: 'tool', id: 'toolu_1', name: 'Bash', input: { command: 'ls' }, status: 'completed', output }), true);
  assert.equal(apply({ type: 'usage', scope: 'response', final: false, contextTokens: 1200 }), true);
  for (const event of [{ type: 'permission', id: 'p1', toolName: 'Bash', input: {} }, { type: 'task', id: 'task-1', status: 'running' },
    { type: 'error', message: '失败' }, { type: 'done' }, { type: 'session', sessionId: 'x' }, { type: 'quota' }]) {
    assert.equal(apply(event), false, event.type);
  }
  feed.flush(session.id);
  const { tools, metrics } = replay(frames);
  assert.equal(frames[0].ops.filter(op => op.op === 'tool').length, 1, 'only the newest tool record is sent');
  const tool = tools.get('toolu_1');
  assert.equal(tool.status, 'completed'); assert.equal(tool.output.length, 4000); assert.equal(tool.outputTruncated, true);
  assert.equal(metrics.contextTokens, 1200);
});

test('a snapshot flushes pending patches first and reports the sequence it already contains', async () => {
  const { frames, feed, session, apply } = harness();
  assert.deepEqual({ ...feed.info(session.id), now: undefined }, { epoch: feed.epoch, seq: 0, now: undefined });
  apply({ type: 'text_delta', text: '一', messageId: 'msg_1' });
  assert.equal(frames.length, 0, 'patches are batched');
  const info = feed.info(session.id);
  assert.equal(frames.length, 1); assert.equal(info.seq, 1); assert.equal(frames[0].seq, 1);
  apply({ type: 'text_delta', text: '二', messageId: 'msg_1' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(frames.length, 2); assert.equal(frames[1].seq, 2);
  assert.equal(feed.info('other-session').seq, 0);
  apply({ type: 'text_delta', text: '三', messageId: 'msg_1' });
  feed.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(frames.length, 2, 'closing drops queued patches without broadcasting');
  apply({ type: 'text_delta', text: '四', messageId: 'msg_1' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(frames.length, 2, 'a closed feed ignores late run events');
  assert.notEqual(new LiveFeed({ broadcast() {} }).epoch, feed.epoch);
});

test('compaction keeps creation order and the newest copy of each full record', () => {
  const ops = compactOps([
    { op: 'message', id: 'a', meta: { role: 'assistant', thinkingTokens: 1 } },
    { op: 'append', id: 'a', field: 'text', value: 'x' },
    { op: 'append', id: 'a', field: 'text', value: 'y' },
    { op: 'append', id: 'a', field: 'thinking', value: 'z' },
    { op: 'append', id: 'a', field: 'text', value: 'w' },
    { op: 'metrics', metrics: { turns: 1 } },
    { op: 'message', id: 'a', meta: { role: 'assistant', thinkingTokens: 5 } },
    { op: 'tool', tool: { id: 't', status: 'running' } },
    { op: 'tool', tool: { id: 't', status: 'completed' } },
    { op: 'metrics', metrics: { turns: 2 } },
  ]);
  assert.deepEqual(ops, [
    { op: 'message', id: 'a', meta: { role: 'assistant', thinkingTokens: 5 } },
    { op: 'append', id: 'a', field: 'text', value: 'xy' },
    { op: 'append', id: 'a', field: 'thinking', value: 'z' },
    { op: 'append', id: 'a', field: 'text', value: 'w' },
    { op: 'metrics', metrics: { turns: 2 } },
    { op: 'tool', tool: { id: 't', status: 'completed' } },
  ]);
});
