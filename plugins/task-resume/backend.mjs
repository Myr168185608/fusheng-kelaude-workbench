import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const STATES = new Set(['running', 'resuming', 'awaiting_user', 'interrupted', 'failed', 'completed', 'stopped', 'cancelled']);
const RESUMABLE = new Set(['interrupted', 'failed']);
const DEFAULTS = { autoResume: false, maxAttempts: 2, retryDelayMs: 30_000 };
const fail = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const clean = (value, max = 100) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export const resumePrompt = '继续本会话中尚未完成的任务。上一轮执行已中断，请先核对对话记录、工作区文件和外部操作的实际状态，区分已经完成、尚未完成和结果不确定的步骤。不要直接重放历史工具调用，不要重复已经完成的修改、发送、支付、部署或其他有副作用的操作；结果不确定时先检查，无法确认时向用户询问。保持原任务范围和权限，只继续未完成部分。';

/** A checkpoint contains identifiers and progress metadata, never tool inputs/outputs,
 * credentials or a duplicate transcript. Only the host can start an official --resume turn.
 */
export async function createTaskResume({ dataDir, listSessions = () => [], getSession, startTurn,
  isBusy = () => false, isActive = () => true, now = Date.now } = {}) {
  if (!path.isAbsolute(dataDir || '') || typeof getSession !== 'function' || typeof startTurn !== 'function') {
    throw new TypeError('Task resume requires an absolute private directory and session/start callbacks');
  }
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw fail(500, '任务恢复目录必须是独立真实目录。');
  const filename = path.join(dataDir, 'checkpoints.json');
  let settings = { ...DEFAULTS }, closed = false, timer = null, writes = Promise.resolve(), lastWriteError = null;
  const records = new Map(), launches = new Set(), priorRuns = new Map();
  const timestamp = () => new Date(now()).toISOString();
  const active = () => !closed && isActive() === true;
  const validSettings = value => value && typeof value.autoResume === 'boolean'
    && integer(value.maxAttempts, 1, 5) && integer(value.retryDelayMs, 1000, 300_000);
  try {
    const st = await fs.lstat(filename);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 2 * 1024 * 1024) throw Error('unsafe checkpoint file');
    const value = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (value.version !== 1 || !validSettings(value.settings) || !Array.isArray(value.tasks) || value.tasks.length > 500) throw Error('invalid checkpoint format');
    settings = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, value.settings[key]]));
    for (const entry of value.tasks) {
      if (!UUID.test(entry?.sessionId) || records.has(entry.sessionId) || !STATES.has(entry.state)
        || !integer(entry.autoAttempts, 0, 5) || (entry.claudeSessionId !== null && !UUID.test(entry.claudeSessionId))) throw Error('invalid checkpoint');
      const record = { sessionId: entry.sessionId, title: clean(entry.title), claudeSessionId: entry.claudeSessionId,
        state: entry.state, runId: clean(entry.runId), reason: clean(entry.reason), autoAttempts: entry.autoAttempts,
        createdAt: clean(entry.createdAt), updatedAt: clean(entry.updatedAt), nextAttemptAt: null,
        lastTool: entry.lastTool ? { name: clean(entry.lastTool.name, 80), status: clean(entry.lastTool.status, 40), at: clean(entry.lastTool.at) } : null };
      if (['running', 'resuming'].includes(record.state)) { record.state = 'interrupted'; record.reason = 'restart'; record.updatedAt = timestamp(); }
      records.set(record.sessionId, record);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail(500, '任务检查点无法读取，已保留原文件；请先检查数据后再启用插件。');
  }

  function persist() {
    const snapshot = JSON.stringify({ version: 1, settings, tasks: [...records.values()] });
    const next = writes.catch(() => {}).then(async () => {
      const tmp = path.join(dataDir, `.checkpoints-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(tmp, 'wx', 0o600);
        try { await handle.writeFile(snapshot); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(tmp, filename);
        lastWriteError = null;
      } finally { await fs.rm(tmp, { force: true }); }
    });
    writes = next.catch(error => { lastWriteError = error; });
    return next;
  }
  function automatic(record) {
    return settings.autoResume && RESUMABLE.has(record.state) && Boolean(record.claudeSessionId)
      && record.reason !== 'quota' && record.autoAttempts < settings.maxAttempts;
  }
  function retryAt(record) { return now() + Math.min(300_000, settings.retryDelayMs * 2 ** record.autoAttempts); }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!active() || !settings.autoResume) return;
    const eligible = [...records.values()].filter(automatic);
    for (const record of eligible) record.nextAttemptAt ??= retryAt(record);
    if (!eligible.length) return;
    const at = Math.min(...eligible.map(record => record.nextAttemptAt));
    timer = setTimeout(() => { void tick().catch(() => {}); }, Math.max(1, at - now()));
    timer.unref?.();
  }
  async function tick() {
    timer = null;
    if (!active()) return;
    const record = [...records.values()].filter(automatic).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .find(item => item.nextAttemptAt <= now());
    if (!record) return schedule();
    if (await isBusy()) { record.nextAttemptAt = now() + 5000; return schedule(); }
    try { await resume(record.sessionId, true); } catch { /* The checkpoint exposes the failure; no unbounded retry. */ }
    schedule();
  }
  function matching(session, run) {
    const record = records.get(session?.id);
    return record && (!record.runId || !run?.messageId || record.runId === run.messageId) ? record : null;
  }
  function requireActive() { if (!active()) throw fail(409, '任务恢复插件已停用或工作台处于安全模式。'); }
  async function resume(sessionId, auto = false) {
    requireActive();
    const record = records.get(sessionId);
    if (!record || !RESUMABLE.has(record.state)) throw fail(409, '这个任务没有可恢复的检查点。手动停止或等待审批的任务请回到原对话处理。');
    if (launches.size) throw fail(409, '另一项任务正在运行，请稍后恢复。');
    launches.add(sessionId);
    try {
      if (await isBusy()) throw fail(409, '另一项任务正在运行，请稍后恢复。');
      const session = await getSession(sessionId);
      requireActive();
      if (records.get(sessionId) !== record || !RESUMABLE.has(record.state)) throw fail(409, '任务状态已经变化，请刷新后再试。');
      if (!session || session.archived) throw fail(409, '原会话不存在或已归档，请先回到原对话处理。');
      if (session.permissions?.length || ['running', 'awaiting_approval'].includes(session.status)) throw fail(409, '原会话仍在执行或等待用户审批，不能自动重放。');
      if (!record.claudeSessionId || session.claudeSessionId !== record.claudeSessionId) throw fail(409, '官方会话记录不存在或已经变化，无法从检查点恢复；请回到原对话检查。');
      if (auto && !automatic(record)) return;
      if (auto) record.autoAttempts++;
      record.state = 'resuming'; record.reason = auto ? 'auto_resume' : 'manual_resume'; record.nextAttemptAt = null; record.updatedAt = timestamp();
      await persist();
      requireActive();
      const result = await startTurn(session, resumePrompt, { requestId: `resume-${randomUUID()}`, source: 'task-resume', resume: true });
      if (result?.msg || (result?.code && result.code >= 400)) throw fail(result?.code || 503, result?.msg || '恢复任务未能启动。');
      return { started: true, sessionId };
    } catch (error) {
      const current = records.get(sessionId);
      if (record.state === 'resuming' && current && ['running', 'resuming'].includes(current.state)) { current.state = 'failed'; current.reason = 'start_failed'; current.nextAttemptAt = automatic(current) ? retryAt(current) : null; current.updatedAt = timestamp(); await persist(); }
      else if (auto && RESUMABLE.has(record.state)) {
        // Missing sessions/approvals are not temporary transport failures. Stop this queue
        // entry without altering the host conversation or retrying it forever.
        record.nextAttemptAt = null; record.autoAttempts = settings.maxAttempts; await persist();
      }
      throw error;
    } finally { launches.delete(sessionId); schedule(); }
  }

  async function beforeRun({ session, request = {}, run, kind = 'run' } = {}) {
    if (!active() || kind === 'terminal' || !UUID.test(session?.id)) return;
    const previous = records.get(session.id), continuation = request.source === 'task-resume';
    const record = { sessionId: session.id, title: clean(session.title), claudeSessionId: UUID.test(session.claudeSessionId) ? session.claudeSessionId : null,
      state: 'running', runId: clean(run?.messageId || request.runId), reason: '', autoAttempts: continuation ? previous?.autoAttempts || 0 : 0,
      createdAt: continuation && previous ? previous.createdAt : timestamp(), updatedAt: timestamp(), nextAttemptAt: null,
      lastTool: continuation ? previous?.lastTool || null : null };
    if (!records.has(session.id) && records.size >= 500) {
      const oldest = [...records.values()].filter(item => ['completed', 'cancelled', 'stopped'].includes(item.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (oldest) records.delete(oldest.sessionId); else throw fail(409, '检查点已达到 500 个，请先取消或清理旧任务。');
    }
    priorRuns.set(`${session.id}:${record.runId}`, previous ? structuredClone(previous) : null);
    records.set(session.id, record); schedule(); await persist();
  }
  async function onEvent({ session, event = {}, run } = {}) {
    if (closed) return;
    const record = matching(session, run); if (!record || ['stopped', 'cancelled'].includes(record.state)) return;
    let changed = false;
    if (event.type === 'session' && UUID.test(event.sessionId)) { record.claudeSessionId = event.sessionId; changed = true; }
    if (event.type === 'tool') { record.lastTool = { name: clean(event.name, 80), status: clean(event.status, 40), at: timestamp() }; changed = true; }
    if (event.type === 'permission') { record.state = 'awaiting_user'; record.reason = 'approval'; changed = true; }
    else if (record.state === 'awaiting_user' && session.status === 'running' && !session.permissions?.length) { record.state = 'running'; record.reason = ''; changed = true; }
    if (event.type === 'rate_limit' && event.rateLimited) { record.reason = 'quota'; changed = true; }
    if (changed) { record.updatedAt = timestamp(); await persist(); }
  }
  async function onExit({ session, result = {}, run } = {}) {
    if (closed) return;
    const record = matching(session, run); if (!record) return;
    const previousKey = `${session.id}:${record.runId}`;
    if (result.preflightFailed) {
      const previous = priorRuns.get(previousKey);
      if (previous) records.set(session.id, previous); else records.delete(session.id);
      priorRuns.delete(previousKey); await persist(); schedule(); return;
    }
    priorRuns.delete(previousKey);
    if (!['stopped', 'cancelled', 'awaiting_user'].includes(record.state)) {
      if (result.shutdown || (result.stopped && record.reason === 'restart')) { record.state = 'interrupted'; record.reason = 'restart'; }
      else if (result.stopped) { record.state = 'stopped'; record.reason = 'user_stop'; }
      else if (record.reason === 'quota' || result.timedOut || result.stopReason === 'error' || session.status === 'error' || (result.code !== 0 && !result.endedAfterResult)) {
        record.state = 'failed'; record.reason ||= 'process_error';
      } else { record.state = 'completed'; record.reason = ''; }
    }
    if (UUID.test(session.claudeSessionId)) record.claudeSessionId = session.claudeSessionId;
    record.updatedAt = timestamp(); record.nextAttemptAt = automatic(record) ? retryAt(record) : null;
    await persist(); schedule();
  }
  async function onStop({ session, reason = 'user', run } = {}) {
    if (closed) return;
    const record = matching(session, run); if (!record) return;
    const restart = ['restart', 'shutdown'].includes(reason);
    if (!restart || record.state !== 'awaiting_user') { record.state = restart ? 'interrupted' : 'stopped'; record.reason = restart ? 'restart' : 'user_stop'; }
    record.nextAttemptAt = null; record.updatedAt = timestamp(); await persist(); schedule();
  }
  async function list() {
    const tasks = await Promise.all([...records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(async record => {
      const session = await getSession(record.sessionId);
      return { ...record, title: clean(session?.title) || record.title,
        resumable: RESUMABLE.has(record.state) && Boolean(record.claudeSessionId),
        automatic: active() && automatic(record), retryExhausted: record.autoAttempts >= settings.maxAttempts };
    }));
    return { settings: { ...settings }, tasks, active: active(), persistenceError: lastWriteError ? '检查点暂时无法保存，请检查服务器磁盘。' : null };
  }
  async function call(method, params = {}) {
    requireActive();
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail(400, '插件参数无效。');
    if (method === 'list') { await writes; return list(); }
    if (method === 'settings.get') return { ...settings };
    if (method === 'settings.update') {
      if (Object.keys(params).some(key => !Object.hasOwn(DEFAULTS, key)) || !Object.keys(params).length || !validSettings({ ...settings, ...params })) throw fail(400, '自动恢复设置无效：重试 1–5 次，间隔 1–300 秒。');
      const previous = settings; settings = { ...settings, ...params };
      if (!settings.autoResume) for (const record of records.values()) record.nextAttemptAt = null;
      try { await persist(); } catch (error) { settings = previous; throw error; }
      schedule(); return { ...settings };
    }
    if (method === 'resume') return resume(params.sessionId);
    if (method === 'cancel') {
      const record = records.get(params.sessionId); if (!record) throw fail(404, '检查点不存在。');
      if (launches.has(record.sessionId) || ['running', 'resuming', 'awaiting_user'].includes(record.state)) throw fail(409, '当前任务仍在执行或等待审批，请回到原对话处理。');
      record.state = 'cancelled'; record.reason = 'user_cancel'; record.nextAttemptAt = null; record.updatedAt = timestamp();
      await persist(); schedule(); return { cancelled: true, sessionId: record.sessionId };
    }
    throw fail(404, '任务恢复方法不存在。');
  }
  // This read-only host call also lets asynchronous hosts finish loading their session store.
  await listSessions();
  if (records.size) await persist();
  schedule();
  return { call, beforeRun, onEvent, onExit, onStop, async close() { closed = true; clearTimeout(timer); timer = null; await writes; } };
}

export const activate = createTaskResume;
