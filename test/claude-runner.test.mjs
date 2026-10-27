import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRun, normalizeResultUsage, normalizeCapabilities, previewToolInput } from '../lib/claude-runner.mjs';
import { newSession, applyEvent } from '../lib/state.mjs';

const SESSION = '767698b8-a7e8-435c-942d-1071d03bd34e';
const fixture = `#!/usr/bin/env node
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const write=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
const mode=process.env.FIXTURE_MODE;
const session='${SESSION}';
const finish=(is_error=false)=>write({type:'result',uuid:'result-1',session_id:session,subtype:is_error?'error_during_execution':'success',is_error,result:is_error?undefined:'完成',errors:is_error?['模型暂时不可用']:undefined,duration_ms:1234,duration_api_ms:900,total_cost_usd:0.15,usage:{input_tokens:2,output_tokens:3},modelUsage:{'claude-sonnet-test':{inputTokens:40,outputTokens:20,cacheReadInputTokens:100,cacheCreationInputTokens:10,contextWindow:200000,costUSD:0.15}}});
// Like the real CLI, the state-driven modes report session state only when the host asks for it,
// and exit 143 on SIGTERM. turnDone records whether input ended only after the whole turn.
const state=(value)=>{ if(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS==='1') write({type:'system',subtype:'session_state_changed',state:value,session_id:session}); };
const said=(uuid,text,extra={})=>write({type:'result',uuid,session_id:session,subtype:'success',is_error:false,result:text,num_turns:1,...extra});
let turnDone=false,prompted=null;
const life=(uuid,value)=>write({type:'command_lifecycle',command_uuid:uuid,state:value,session_id:session});
if(['orphan-resume','bg-states','late-followup','late-question'].includes(mode)) process.on('SIGTERM',()=>process.exit(143));
if(mode==='no-thinking-flag'&&process.argv.includes('--thinking-display')) { process.stderr.write("error: unknown option '--thinking-display'\\n"); process.exit(1); }
else if(mode==='stderr') { process.stderr.write('x'.repeat(12000)+' sk-ant-api03-secret'); process.exitCode=2; }
else if(mode==='hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
else if(mode==='family') {
 const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
 child.stdout.once('data',()=>{writeFileSync(process.env.FIXTURE_RECORD,String(child.pid));write({type:'system',subtype:'init',session_id:session});});
 setInterval(()=>{},1000);
}
else {
 const rl=readline.createInterface({input:process.stdin});
 rl.on('line',line=>{
  const msg=JSON.parse(line);
  if(msg.type==='control_request' && msg.request.subtype==='initialize') {
   if(mode==='init-silent') { write({type:'system',subtype:'init',session_id:session}); return; }
   if(mode==='init-error') { write({type:'control_response',response:{subtype:'error',request_id:msg.request_id,error:'初始化失败'}}); return; }
   write({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:{commands:[{name:'usage',description:'Usage',builtin:true}],models:[{value:'sonnet',displayName:'Sonnet',supportedEffortLevels:['low','medium','high','max']}],agents:[{name:'Explore',description:'Read-only exploration'}],account:{email:'private-account-never-forwarded',token:'private-auth-never-forwarded'}}}});
  } else if(msg.type==='control_request' && msg.request.subtype==='stop_task') {
   writeFileSync(process.env.FIXTURE_RESPONSE,JSON.stringify(msg));
   write({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:{}}});
   if(msg.request.task_id.startsWith('progress-')) write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:msg.request.task_id}}});
   if(msg.request.task_id==='finish-fixture') {
    if(mode==='long-tool') write({type:'user',message:{content:[{type:'tool_result',tool_use_id:'long-tool',content:'完成'}]}});
    if(mode==='long-task') write({type:'system',subtype:'task_notification',task_id:'long-task',status:'completed'});
    finish();
    write({type:'system',subtype:'session_state_changed',state:'idle',session_id:session});
   }
  } else if(msg.type==='user' && ['steer','steer-late'].includes(mode)) {
   // Recorded from the real CLI: every command with a uuid reports queued, started and completed.
   if(!prompted) {
    prompted=msg.uuid; life(msg.uuid,'queued'); life(msg.uuid,'started');
    if(mode==='steer') state('running');
    write({type:'system',subtype:'init',session_id:session,model:'claude-sonnet-test'});
    if(mode==='steer') write({type:'assistant',uuid:'steer-tool',session_id:session,message:{id:'message-s1',content:[{type:'tool_use',id:'steer-tool',name:'Bash',input:{command:'npm install'}}]}});
    else write({type:'assistant',uuid:'steer-first',session_id:session,message:{id:'message-s1',content:[{type:'text',text:'第一版'}]}});
    return;
   }
   writeFileSync(process.env.FIXTURE_RESPONSE,JSON.stringify(msg));
   life(msg.uuid,'queued');
   if(mode==='steer') setTimeout(()=>{
    // Taken at the next tool boundary, inside the same turn.
    write({type:'user',message:{content:[{type:'tool_result',tool_use_id:'steer-tool',content:'ok'}]}});
    life(msg.uuid,'started');
    write({type:'assistant',uuid:'steer-reply',session_id:session,message:{id:'message-s2',content:[{type:'text',text:'已按引导调整'}]}});
    said('result-s','已按引导调整'); life(prompted,'completed'); life(msg.uuid,'completed'); state('idle');
   },50);
   else {
    // Arrived while the reply was written: the reply ends first, then the guidance runs as a follow-up turn.
    // This CLI reports no session state, so only the queued guidance keeps the host's input open.
    said('result-1','第一版'); life(prompted,'completed');
    setTimeout(()=>{
     life(msg.uuid,'started');
     write({type:'assistant',uuid:'steer-second',session_id:session,message:{id:'message-s2',content:[{type:'text',text:'按引导改好'}]}});
     said('result-2','按引导改好'); life(msg.uuid,'completed'); turnDone=true;
    },150);
   }
  } else if(msg.type==='user') {
   writeFileSync(process.env.FIXTURE_RECORD,JSON.stringify({args:process.argv.slice(2),user:msg,env:{ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN:process.env.CLAUDE_CODE_OAUTH_TOKEN,HTTPS_PROXY:process.env.HTTPS_PROXY,NO_PROXY:process.env.NO_PROXY,CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS:process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS}}));
   write({type:'system',subtype:'init',session_id:session,model:'claude-sonnet-test',apiKeySource:'secret-never-forwarded'});
   if(mode==='malformed') { process.stdout.write('not json\\n'); return; }
   if(mode==='long-line') { process.stdout.write('a'.repeat(4096)); return; }
   if(mode==='question') {
    write({type:'control_request',request_id:'question-1',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:'question-tool',input:{metadata:{source:'deployment'},questions:[{question:'选择部署方式？',header:'部署',options:[{label:'容器',description:'Docker'},{label:'原生',description:'Native'}],multiSelect:false}]}}});
    return;
   }
   if(mode==='permission'||mode==='auto-permission'||mode==='cancel'||mode==='exit-plan') {
    const input=mode==='auto-permission'?{command:'printf "Bearer fixture-secret-token"'}:{command:'echo hello'};
    const toolName=mode==='exit-plan'?'ExitPlanMode':'Bash';
    write({type:'assistant',uuid:'tool-message',session_id:session,message:{content:[{type:'tool_use',id:'tool-1',name:toolName,input}]}});
    write({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:toolName,tool_use_id:'tool-1',input}});
    if(mode==='cancel') {
     write({type:'control_cancel_request',request_id:'permission-1'});
     write({type:'tool_progress',tool_use_id:'tool-1',tool_name:'Bash',elapsed_time_seconds:1});
     write({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',is_error:true,content:'Tool request cancelled'}]}});
     finish();
    }
    return;
   }
   if(mode==='unknown-control') { write({type:'control_request',request_id:'unknown-1',request:{subtype:'unknown_operation'}}); return; }
   if(mode==='error') { finish(true); process.exitCode=1; return; }
   if(mode==='linger') { finish(); return; }
   if(mode==='bg-bash') {
    write({type:'system',subtype:'task_started',task_id:'bg-1',task_type:'local_bash',description:'后台命令'});
    finish();
    setTimeout(()=>{
     write({type:'system',subtype:'task_updated',task_id:'bg-1',patch:{status:'completed'}});
     write({type:'system',subtype:'task_notification',task_id:'bg-1',status:'completed'});
     write({type:'result',uuid:'result-2',session_id:session,subtype:'success',is_error:false,result:'后台完成'});
    },400);
    return;
   }
   if(mode==='orphan-resume') {
    // Recorded from the real CLI: resuming after a process that left a background task behind
    // reports that task and an empty zero-turn result before the turn for the new prompt.
    write({type:'system',subtype:'task_notification',task_id:'orphan-1',status:'stopped'});
    state('running');
    said('result-0','',{num_turns:0});
    setTimeout(()=>{
     write({type:'assistant',uuid:'resumed-text',session_id:session,message:{id:'message-r',content:[{type:'text',text:'继续完成'}]}});
     said('result-r','继续完成');
     turnDone=true;
     state('idle');
    },400);
    return;
   }
   if(mode==='bg-states') {
    state('running');
    write({type:'system',subtype:'task_started',task_id:'bg-2',task_type:'local_bash',description:'后台命令'});
    said('result-b1','已在后台运行');
    state('idle');
    setTimeout(()=>{
     write({type:'system',subtype:'task_updated',task_id:'bg-2',patch:{status:'completed'}});
     write({type:'system',subtype:'task_notification',task_id:'bg-2',status:'completed'});
     // A moment later the CLI wakes the model for a follow-up turn about the finished task.
     setTimeout(()=>{
      state('running');
      setTimeout(()=>{ said('result-b2','后台完成'); turnDone=true; state('idle'); },300);
     },50);
    },300);
    return;
   }
   if(mode==='late-followup'||mode==='late-question') {
    state('running');
    said('result-l1','第一轮');
    state('idle');
    return;
   }
   write({type:'system',subtype:'session_state_changed',state:'running',session_id:session});
   if(mode==='long-stream') { write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'开始'}}}); return; }
   if(mode==='long-tool') { write({type:'assistant',message:{content:[{type:'tool_use',id:'long-tool',name:'Bash',input:{command:'long-running-operation'}}]}}); return; }
   if(mode==='long-task') { write({type:'system',subtype:'task_started',task_id:'long-task',task_type:'local_agent',description:'后台任务'}); finish(); return; }
   write({type:'stream_event',event:{type:'message_start',message:{id:'message-1',model:'claude-sonnet-test',usage:{input_tokens:8,output_tokens:0,cache_read_input_tokens:80,cache_creation_input_tokens:5}}}});
   if(mode==='thinking-blocks') {
    write({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}});
    write({type:'system',subtype:'thinking_tokens',estimated_tokens:3,estimated_tokens_delta:3,session_id:session});
    write({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'先看'}}});
    write({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'配置'}}});
    write({type:'system',subtype:'thinking_tokens',estimated_tokens:9,estimated_tokens_delta:6,session_id:session});
    write({type:'system',subtype:'thinking_tokens',estimated_tokens:50,estimated_tokens_delta:41,parent_tool_use_id:'agent-tool',session_id:session});
    write({type:'assistant',uuid:'think-frame',session_id:session,message:{id:'message-1',content:[{type:'thinking',thinking:'先看配置',signature:'signature-never-forwarded'}]}});
    write({type:'stream_event',event:{type:'content_block_stop',index:0}});
    write({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'redacted_thinking',data:'redacted-payload-never-forwarded'}}});
    write({type:'stream_event',event:{type:'content_block_stop',index:1}});
    write({type:'stream_event',event:{type:'content_block_start',index:2,content_block:{type:'thinking',thinking:''}}});
    write({type:'stream_event',event:{type:'content_block_delta',index:2,delta:{type:'thinking_delta',thinking:'再确认'}}});
    write({type:'assistant',uuid:'think-frame-2',session_id:session,message:{id:'message-1',content:[{type:'thinking',thinking:'再确认',signature:'signature-never-forwarded'}]}});
    write({type:'stream_event',event:{type:'content_block_stop',index:2}});
    write({type:'stream_event',event:{type:'content_block_start',index:3,content_block:{type:'text',text:''}}});
    write({type:'stream_event',event:{type:'content_block_delta',index:3,delta:{type:'text_delta',text:'第一段'}}});
    write({type:'assistant',uuid:'text-frame-1',session_id:session,message:{id:'message-1',content:[{type:'text',text:'第一段'}]}});
    write({type:'stream_event',event:{type:'content_block_stop',index:3}});
    write({type:'stream_event',event:{type:'content_block_start',index:4,content_block:{type:'text',text:''}}});
    write({type:'stream_event',event:{type:'content_block_delta',index:4,delta:{type:'text_delta',text:'第二段'}}});
    write({type:'assistant',uuid:'text-frame-2',session_id:session,message:{id:'message-1',content:[{type:'text',text:'第二段'}]}});
    write({type:'stream_event',event:{type:'content_block_stop',index:4}});
    finish();
    setTimeout(()=>write({type:'system',subtype:'session_state_changed',state:'idle',session_id:session}),25);
    return;
   }
   if(mode==='tool-stream') {
    const delta=(partial_json)=>write({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json}}});
    write({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool-w',name:'Write',input:{}}}});
    delta('{"file_path": "/tmp/a'); delta('pp.js", "content": "say \\"file_path\\": \\"no\\" '); delta('x'.repeat(5000));
    setTimeout(()=>{
     delta('y'.repeat(100));
     write({type:'assistant',uuid:'tool-frame',session_id:session,message:{id:'message-1',content:[{type:'tool_use',id:'tool-w',name:'Write',input:{file_path:'/tmp/app.js',content:'done'}}]}});
     write({type:'stream_event',event:{type:'content_block_stop',index:0}});
     write({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-w',content:'ok'}]}});
     finish();
     setTimeout(()=>write({type:'system',subtype:'session_state_changed',state:'idle',session_id:session}),25);
    },320);
    return;
   }
   if(mode==='ide') {
    write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'官方可见思考摘要'}}});
    write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'signature_delta',signature:'signature-never-forwarded'}}});
    write({type:'stream_event',event:{type:'content_block_start',content_block:{type:'redacted_thinking',data:'redacted-payload-never-forwarded'}}});
    write({type:'assistant',uuid:'thinking-1',message:{id:'message-1',content:[{type:'thinking',thinking:'官方可见思考摘要',signature:'signature-never-forwarded'}]}});
    write({type:'assistant',uuid:'usage-command',usage_report:{rate_limits:{limits:[{kind:'session',percent:2,resets_at:'2030-01-01T05:00:00Z'},{kind:'weekly_all',percent:3,resets_at:'2030-01-08T00:00:00Z'}]}}});
    write({type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:1893459600}});
    write({type:'system',subtype:'task_started',task_id:'task-1',task_type:'local_agent',description:'检查配置'});
    write({type:'system',subtype:'task_notification',task_id:'task-1',status:'completed',summary:'完成检查',usage:{total_tokens:42,tool_uses:1,duration_ms:100}});
   }
   const stream=Buffer.from(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'中文🙂'}}})+'\\n');
   const split=stream.indexOf(Buffer.from('中'))+1;
   process.stdout.write(stream.subarray(0,split)); process.stdout.write(stream.subarray(split));
   write({type:'stream_event',event:{type:'message_delta',usage:{output_tokens:7}}});
   const assistant={type:'assistant',uuid:'assistant-1',session_id:session,message:{id:'message-1',model:'claude-sonnet-test',content:[{type:'text',text:'中文🙂'}],usage:{input_tokens:8,output_tokens:7,cache_read_input_tokens:80,cache_creation_input_tokens:5}}};
   write(assistant);write(assistant);
   finish();finish();
   setTimeout(()=>write({type:'system',subtype:'session_state_changed',state:'idle',session_id:session}),25);
  } else if(msg.type==='control_response') {
   writeFileSync(process.env.FIXTURE_RESPONSE,JSON.stringify(msg));
   if(['permission','auto-permission','exit-plan'].includes(mode)) write({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',is_error:msg.response.response.behavior==='deny',content:[{type:'text',text:'hello'}]}]}});
   finish();
  }
 });
 rl.on('close',()=>{
  if(mode==='linger') { process.on('SIGTERM',()=>process.exit(143)); setInterval(()=>{},1000); return; }
  if(mode==='steer-late') { writeFileSync(process.env.FIXTURE_RECORD,JSON.stringify({eofAfterSteer:turnDone})); }
  if(mode==='orphan-resume'||mode==='bg-states'||mode==='steer-late') {
   if(mode!=='steer-late') writeFileSync(process.env.FIXTURE_RESPONSE,JSON.stringify({eofAfterTurn:turnDone}));
   // Like the real CLI, a turn still in progress is finished before exiting.
   const exitWhenDone=()=>turnDone?process.exit(0):setTimeout(exitWhenDone,20);
   exitWhenDone();
   return;
  }
  if(mode==='late-followup') {
   // After input ends, a task the host never saw start reports back and wakes the model.
   write({type:'system',subtype:'task_notification',task_id:'unseen-1',status:'completed'});
   state('running');
   setTimeout(()=>{ said('result-l2','后续完成'); state('idle'); setTimeout(()=>process.exit(0),20); },400);
   return;
  }
  if(mode==='late-question') {
   // The same, but the follow-up turn asks a question that can no longer be answered.
   state('running');
   write({type:'control_request',request_id:'late-question-1',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:'late-question-tool',input:{questions:[{question:'继续吗？',header:'确认',options:[{label:'是',description:'继续'},{label:'否',description:'停止'}],multiSelect:false}]}}});
   state('requires_action');
   setInterval(()=>{},1000);
   return;
  }
  if(mode==='slow-close') {
   write({type:'system',subtype:'task_notification',task_id:'closing',status:'completed'});
   setTimeout(()=>process.exit(),100);
  } else process.exit();
 });
}
`;

async function setup(t, mode = 'normal', extra = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-runner-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const binary = join(cwd, 'fixture.mjs');
  await writeFile(binary, fixture);
  await chmod(binary, 0o700);
  const events = [], exits = [];
  const config = { cwd, binary, prompt: '测试输入', timeoutMs: 10000, initializationTimeoutMs: 5000,
    killGraceMs: 100, exitGraceMs: 100, taskSettleMs: 200,
    env: { FIXTURE_MODE: mode, FIXTURE_RECORD: join(cwd, 'record.json'), FIXTURE_RESPONSE: join(cwd, 'response.json'), ...extra.env },
    onEvent: (e) => { events.push(e); extra.onEvent?.(e); }, onExit: (e) => exits.push(e), ...extra };
  // Keep the recorder even if the test supplies an event observer.
  config.onEvent = (e) => { events.push(e); extra.onEvent?.(e); };
  config.env = { FIXTURE_MODE: mode, FIXTURE_RECORD: join(cwd, 'record.json'), FIXTURE_RESPONSE: join(cwd, 'response.json'), ...extra.env };
  const run = createClaudeRun(config);
  t.after(() => run.stop());
  return { run, events, exits, cwd };
}

test('real subprocess protocol preserves split UTF-8, initializes first, and deduplicates final accounting', async (t) => {
  const { run, events, exits, cwd } = await setup(t);
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(exits.length, 1);
  assert.deepEqual(events.filter(e => e.type === 'text_delta').map(e => e.text), ['中文🙂']);
  assert.equal(events.filter(e => e.type === 'message').length, 1);
  assert.equal(events.find(e => e.type === 'message').model, 'claude-sonnet-test', 'each reply carries the model that actually answered');
  assert.equal(events.filter(e => e.type === 'session').length, 1);
  const usage = events.filter(e => e.type === 'usage' && e.final);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 40);
  assert.equal(usage[0].contextTokens, 100);
  assert.equal(usage[0].contextWindow, 200000);
  assert.equal(usage[0].costUsd, 0.15);
  assert.equal(usage[0].scope, 'session');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(JSON.stringify(events).includes('secret-never-forwarded'), false);
  assert.equal(JSON.stringify(events).includes('private-account-never-forwarded'), false);
  assert.equal(JSON.stringify(events).includes('private-auth-never-forwarded'), false);
  const record = JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8'));
  assert.equal(record.user.message.content, '测试输入');
  assert.equal(record.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(record.args[record.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(record.args[record.args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(record.args.includes('--effort'), false, 'auto leaves the official CLI effort default in place');
});

test('administrator root opt-in reaches the official CLI without changing its user prompt or auto mode', async (t) => {
  const { run, cwd } = await setup(t, 'normal', { env: { WORKBENCH_ROOT_OPERATIONS: '1' } });
  assert.equal((await run.done).code, 0);
  const record = JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8'));
  assert.equal(record.user.message.content, '测试输入');
  assert.equal(record.args[record.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.match(record.args[record.args.indexOf('--append-system-prompt') + 1], /sudo/);
});

for (const allow of [true, false]) test(`permission ${allow ? 'approval' : 'denial'} responds once with the exact pending request`, async (t) => {
  let runner;
  const item = await setup(t, 'permission', { permissionMode: 'default', onEvent(e) {
    if (e.type === 'permission') {
      assert.equal(runner.respondPermission('wrong', true), false);
      assert.equal(runner.respondPermission(e.id, allow), true);
      assert.equal(runner.respondPermission(e.id, allow), false);
    }
  } });
  runner = item.run;
  await runner.done;
  const response = JSON.parse(await readFile(join(item.cwd, 'response.json'), 'utf8'));
  assert.equal(response.type, 'control_response');
  assert.equal(response.response.request_id, 'permission-1');
  assert.equal(response.response.response.behavior, allow ? 'allow' : 'deny');
  if (allow) assert.deepEqual(response.response.response.updatedInput, { command: 'echo hello' });
  else assert.equal('updatedPermissions' in response.response.response, false);
  assert.deepEqual(runner.pendingPermissionIds, []);
  assert.equal(item.events.filter(e => e.type === 'tool').at(-1).status, allow ? 'completed' : 'denied');
  const record = JSON.parse(await readFile(join(item.cwd, 'record.json'), 'utf8'));
  assert.equal(record.args[record.args.indexOf('--permission-mode') + 1], 'manual');
});

test('default bypass mode approves ordinary tool requests with their original input and an audit event', async t => {
  const { run, events, cwd } = await setup(t, 'auto-permission');
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(events.some(event => event.type === 'permission'), false);
  assert.deepEqual(run.pendingPermissionIds, []);
  assert.equal(events.filter(event => event.type === 'tool').at(-1).status, 'completed');
  const approvals = events.filter(event => event.type === 'approval');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'Bash');
  assert.equal(approvals[0].allow, true);
  assert.equal(approvals[0].automatic, true);
  const response = JSON.parse(await readFile(join(cwd, 'response.json'), 'utf8'));
  assert.equal(response.response.request_id, 'permission-1');
  assert.equal(response.response.response.behavior, 'allow');
  assert.deepEqual(response.response.response.updatedInput, { command: 'printf "Bearer fixture-secret-token"' });
  assert.equal(JSON.stringify(events).includes('fixture-secret-token'), false, 'the approval uses original input while public events remain redacted');
});

test('explicit plan mode still waits for approval to exit the plan', async t => {
  let runner, requested = false;
  const { run, events } = await setup(t, 'exit-plan', { permissionMode: 'plan', onEvent(event) {
    if (event.type !== 'permission') return;
    requested = true;
    assert.equal(event.toolName, 'ExitPlanMode');
    assert.deepEqual(runner.pendingPermissionIds, ['permission-1']);
    runner.respondPermission(event.id, true);
  } });
  runner = run;
  await run.done;
  assert.equal(requested, true);
  assert.equal(events.some(event => event.type === 'approval' && event.automatic), false);
});

test('cancelled approvals cannot subsequently be approved', async (t) => {
  const { run, events } = await setup(t, 'cancel', { permissionMode: 'default', onEvent(event) {
    if (event.type === 'permission_cancelled') {
      // Cancellation must update the tool before the run exits or continues.
      assert.equal(events.filter(e => e.type === 'tool').at(-1).status, 'cancelled');
    }
  } });
  await run.done;
  assert(events.some(e => e.type === 'permission_cancelled' && e.id === 'permission-1'));
  assert.equal(run.respondPermission('permission-1', true), false);
  assert.equal(events.filter(e => e.type === 'tool').at(-1).status, 'cancelled');
  assert.equal(events.filter(e => e.type === 'tool').at(-1).output, 'Tool request cancelled');
});

test('stopping while approval is pending immediately cancels its tool and disallows late approval', async (t) => {
  let runner;
  const { run, events } = await setup(t, 'permission', { permissionMode: 'default', onEvent(event) {
    if (event.type !== 'permission') return;
    assert.equal(runner.stop(), true);
    assert.deepEqual(runner.pendingPermissionIds, []);
    assert.equal(events.filter(e => e.type === 'tool').at(-1).status, 'cancelled');
    assert.equal(runner.respondPermission(event.id, true), false);
  } });
  runner = run;
  const exit = await run.done;
  assert.equal(exit.stopReason, 'user');
  assert.equal(events.filter(e => e.type === 'tool').at(-1).status, 'cancelled');
  assert.equal(events.filter(e => e.type === 'permission_cancelled').length, 1);
});

test('AskUserQuestion remains interactive in default bypass mode and validates answers without changing the question', async t => {
  let runner;
  const { run, cwd, events } = await setup(t, 'question', { onEvent(event) {
    if (event.type !== 'permission') return;
    assert.throws(() => runner.respondPermission(event.id, true, { answers: { '错误问题': '容器' } }), /unknown question/);
    assert.throws(() => runner.respondPermission(event.id, true, { questions: [], answers: {} }), /cannot be changed/);
    assert.throws(() => runner.respondPermission(event.id, true, { questions: null, answers: {} }), /cannot be changed/);
    assert.throws(() => runner.respondPermission(event.id, true, { ...event.input, metadata: { source: 'changed' }, answers: {} }), /Only question answers/);
    assert.throws(() => runner.respondPermission(event.id, true, { ...event.input, injected: true, answers: {} }), /Only question answers/);
    assert.throws(() => runner.respondPermission(event.id, true, { answers: {} }), /All questions/);
    assert.equal(runner.respondPermission(event.id, true, { ...event.input, answers: { '选择部署方式？': '容器' } }), true);
  } });
  runner = run;
  await run.done;
  const response = JSON.parse(await readFile(join(cwd, 'response.json'), 'utf8'));
  const updated = response.response.response.updatedInput;
  assert.equal(updated.questions[0].question, '选择部署方式？');
  assert.equal(updated.answers['选择部署方式？'], '容器');
  assert.deepEqual(updated.metadata, { source: 'deployment' });
  assert.equal(events.filter(event => event.type === 'permission').length, 1);
  assert.equal(events.some(event => event.type === 'approval' && event.automatic), false);
});

test('permission approval cannot rewrite a shell command', async t => {
  let runner;
  const { run } = await setup(t, 'permission', { permissionMode: 'default', onEvent(event) {
    if (event.type !== 'permission') return;
    assert.throws(() => runner.respondPermission(event.id, true, { command: 'different command' }), /Only AskUserQuestion/);
    runner.respondPermission(event.id, false);
  } });
  runner = run;
  await run.done;
});

test('Fable and pinned versions reach the CLI; malformed model values never start it', async t => {
  for (const model of ['fable', 'claude-opus-4-6']) {
    const { run, cwd } = await setup(t, 'normal', { model });
    await run.done;
    const record = JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8'));
    assert.equal(record.args[record.args.indexOf('--model') + 1], model);
  }
  await assert.rejects(setup(t, 'normal', { model: '--dangerously-skip-permissions' }));
});

test('effort is an official CLI flag and the documented haiku alias is accepted', async t => {
  const { run, cwd } = await setup(t, 'normal', { effort: 'max', model: 'haiku', env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } });
  await run.done;
  const record = JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8'));
  assert.equal(record.args[record.args.indexOf('--effort') + 1], 'max');
  assert.equal(record.args[record.args.indexOf('--model') + 1], 'haiku');
});

test('official thinking, quota, capabilities and task events are exposed without account data or thinking signatures', async t => {
  let runner;
  const { run, events, cwd } = await setup(t, 'ide', { onEvent(event) {
    if (event.type === 'task' && event.status === 'running') assert.equal(runner.stopTask(event.id), true);
  } });
  runner = run;
  await run.done;
  assert(events.some(event => event.type === 'thinking_delta' && event.text === '官方可见思考摘要'));
  assert(events.some(event => event.type === 'thinking' && event.redacted === true && event.text === ''));
  assert.equal(events.find(event => event.type === 'quota').fiveHour.utilization, 2);
  assert.equal(events.find(event => event.type === 'quota').sevenDay.utilization, 3);
  assert.equal(events.find(event => event.type === 'rate_limit').rateLimited, true);
  assert.equal(events.find(event => event.type === 'capabilities').commands[0].name, 'usage');
  assert.equal(events.filter(event => event.type === 'task').at(-1).status, 'completed');
  assert.equal(events.filter(event => event.type === 'task').at(-1).usage.total_tokens, 42);
  assert.equal(JSON.stringify(events).includes('signature-never-forwarded'), false);
  assert.equal(JSON.stringify(events).includes('redacted-payload-never-forwarded'), false);
  assert.equal(JSON.stringify(events).includes('private-account-never-forwarded'), false);
  const request = JSON.parse(await readFile(join(cwd, 'response.json'), 'utf8'));
  assert.equal(request.request.subtype, 'stop_task');
  assert.equal(request.request.task_id, 'task-1');
});

test('unsupported control requests are rejected rather than silently allowed', async (t) => {
  const { run, cwd } = await setup(t, 'unknown-control');
  await run.done;
  const response = JSON.parse(await readFile(join(cwd, 'response.json'), 'utf8'));
  assert.equal(response.response.subtype, 'error');
});

test('resume is a UUID argument; injected credential overrides are stripped while operator proxy passes through', async (t) => {
  const { run, cwd } = await setup(t, 'normal', { sessionId: SESSION, model: 'opus', permissionMode: 'plan',
    env: { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_AUTH_TOKEN: 'test-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth', HTTPS_PROXY: 'http://proxy.example:8080' } });
  await run.done;
  const record = JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8'));
  assert(record.args.includes(`--resume=${SESSION}`));
  assert.equal(record.args[record.args.indexOf('--permission-mode') + 1], 'plan');
  // Credentials must never be injectable from a request; the operator's own proxy is left untouched.
  assert.equal(record.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(record.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(record.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(record.env.HTTPS_PROXY, 'http://proxy.example:8080');
  assert.equal(record.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
});

test('error result and failing exit do not produce duplicate errors or usage', async (t) => {
  const { run, events } = await setup(t, 'error');
  await run.done;
  assert.equal(events.filter(e => e.type === 'error').length, 1);
  assert.equal(events.filter(e => e.type === 'usage' && e.final).length, 1);
});

test('stderr is bounded and token-shaped strings are redacted', async (t) => {
  const { run, events } = await setup(t, 'stderr');
  const exit = await run.done;
  assert(exit.stderr.length <= 8192);
  assert(!JSON.stringify({ exit, events }).includes('sk-ant-api03-secret'));
  assert(exit.stderr.includes('[REDACTED]'));
});

for (const mode of ['malformed', 'long-line', 'init-error']) test(`${mode} fails closed and terminates`, async (t) => {
  const { run, events } = await setup(t, mode, { maxLineBytes: 2048 });
  await run.done;
  assert(events.some(e => e.type === 'error'));
  assert.equal(events.filter(e => e.type === 'done').length, 1);
});

test('timeout escalates to SIGKILL for an unresponsive subprocess', async (t) => {
  const { run, events } = await setup(t, 'hang', { timeoutMs: 2000, initializationTimeoutMs: 5000 });
  const exit = await run.done;
  assert.equal(exit.timedOut, true);
  assert.equal(exit.signal, 'SIGKILL');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(run.stop(), false);
});

// Only the host clock is virtual. The real subprocess exchanges protocol frames,
// allowing these regressions to cross the former 30-minute deadline immediately.
test('default execution keeps streaming across the former 30-minute deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let progress;
  const nextProgress = () => new Promise(resolve => { progress = resolve; });
  const started = nextProgress();
  const { run, events } = await setup(t, 'long-stream', { timeoutMs: undefined,
    onEvent(event) { if (event.type === 'text_delta') progress(event); } });
  await started;
  for (let minute = 1; minute <= 31; minute++) {
    t.mock.timers.tick(60_000);
    const next = nextProgress();
    assert.equal(run.stopTask(`progress-${minute}`), true);
    assert.equal((await next).text, `progress-${minute}`);
  }
  assert.equal(run.stopTask('finish-fixture'), true);
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(exit.timedOut, false);
  assert.equal(events.some(event => event.type === 'error'), false);
});

for (const [mode, eventType, timeoutMs] of [['long-tool', 'tool', 0], ['long-task', 'task', undefined]]) {
  test(`${mode} may stay silent beyond 30 minutes without being terminated`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const { run, events } = await setup(t, mode, { timeoutMs,
      onEvent(event) { if (event.type === eventType) ready(); } });
    await started;
    t.mock.timers.tick(31 * 60_000);
    assert.equal(run.stopTask('finish-fixture'), true);
    const exit = await run.done;
    assert.equal(exit.code, 0);
    assert.equal(exit.timedOut, false);
    assert.equal(events.some(event => event.type === 'error'), false);
  });
}

for (const mode of ['question', 'permission']) {
  test(`${mode} remains answerable after the former execution deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let ready;
    const waiting = new Promise(resolve => { ready = resolve; });
    const { run, events } = await setup(t, mode, { timeoutMs: undefined, permissionMode: 'default',
      onEvent(event) { if (event.type === 'permission') ready(event); } });
    const permission = await waiting;
    t.mock.timers.tick(31 * 60_000);
    assert.deepEqual(run.pendingPermissionIds, [permission.id]);
    assert.equal(run.respondPermission(permission.id, true,
      mode === 'question' ? { answers: { '选择部署方式？': '原生' } } : undefined), true);
    const exit = await run.done;
    assert.equal(exit.code, 0);
    assert.equal(exit.timedOut, false);
    assert.equal(events.some(event => event.type === 'error'), false);
  });
}

test('initialization deadline remains enabled and reports one specific error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready;
  const spawned = new Promise(resolve => { ready = resolve; });
  const { run, events } = await setup(t, 'init-silent', { timeoutMs: undefined,
    onEvent(event) { if (event.type === 'session') ready(); } });
  await spawned;
  t.mock.timers.tick(5000);
  const exit = await run.done;
  assert.equal(exit.timedOut, true);
  assert.equal(exit.stopReason, 'timeout');
  assert.deepEqual(events.filter(event => event.type === 'error').map(event => event.message),
    ['Claude Code 初始化超时，未启动本次任务。']);
  assert.equal(events.filter(event => event.type === 'done').length, 1);
});

test('completed execution cannot time out while the CLI closes its input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready;
  const closing = new Promise(resolve => { ready = resolve; });
  const { run, events } = await setup(t, 'slow-close', { timeoutMs: 1000, exitGraceMs: 5000,
    onEvent(event) { if (event.type === 'task' && event.id === 'closing') ready(); } });
  await closing;
  t.mock.timers.tick(1500);
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(exit.timedOut, false);
  assert.equal(events.some(event => event.type === 'error'), false);
});

test('background Bash keeps the CLI alive until it reports back after the first result', async t => {
  const { run, events } = await setup(t, 'bg-bash');
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(exit.result.result, '后台完成');
  assert.equal(events.some(event => event.type === 'error'), false);
});

test('guidance sent while a tool runs reaches the CLI as a user message and reports when Claude takes it', async t => {
  const box = {};
  const { run, events, cwd } = await setup(t, 'steer', { onEvent: e => {
    if (e.type === 'tool' && e.status === 'running' && !box.sent) box.sent = box.run.steer('改用 pnpm');
  } });
  box.run = run;
  const exit = await run.done;
  assert.equal(box.sent.ok, true);
  assert.match(box.sent.id, /^[0-9a-f-]{36}$/);
  assert.equal(exit.code, 0);
  assert.equal(exit.result.result, '已按引导调整');
  const frame = JSON.parse(await readFile(join(cwd, 'response.json'), 'utf8'));
  assert.deepEqual(frame, { type: 'user', uuid: box.sent.id, session_id: SESSION, parent_tool_use_id: null,
    message: { role: 'user', content: '改用 pnpm' } });
  assert.deepEqual(events.filter(e => e.type === 'steer'), [{ type: 'steer', id: box.sent.id, state: 'delivered' }]);
  assert.equal(events.some(e => e.type === 'error'), false);
  assert.deepEqual(run.steer('太晚了'), { ok: false, reason: 'ending' });
});

test('guidance that arrives during the reply keeps input open for its follow-up turn', async t => {
  const box = {};
  const { run, events, cwd } = await setup(t, 'steer-late', { onEvent: e => {
    if (e.type === 'message' && !box.sent) box.sent = box.run.steer('再精简一点');
  } });
  box.run = run;
  const exit = await run.done;
  assert.equal(box.sent.ok, true);
  assert.equal(exit.code, 0);
  assert.equal(exit.result.result, '按引导改好');
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8')), { eofAfterSteer: true });
  assert.deepEqual(events.filter(e => e.type === 'steer').map(e => e.state), ['delivered']);
});

test('guidance is refused before the CLI starts, by a CLI without command lifecycle, and dropped on stop', async t => {
  const starting = await setup(t, 'steer');
  assert.deepEqual(starting.run.steer('先别急'), { ok: false, reason: 'starting' });
  assert.throws(() => starting.run.steer('  '), /Guidance/);
  assert.throws(() => starting.run.steer('x'.repeat(30_001)), /Guidance/);
  starting.run.stop();
  await starting.run.done;

  const box = {};
  const old = await setup(t, 'long-tool', { onEvent: e => {
    if (e.type === 'tool' && e.status === 'running' && !box.sent) { box.sent = box.run.steer('换个方向'); box.run.stop(); }
  } });
  box.run = old.run;
  await old.run.done;
  assert.deepEqual(box.sent, { ok: false, reason: 'unsupported' });

  const stopped = {};
  const dropped = await setup(t, 'steer', { onEvent: e => {
    if (e.type === 'tool' && e.status === 'running' && !stopped.sent) { stopped.sent = stopped.run.steer('改用 pnpm'); stopped.run.stop(); }
  } });
  stopped.run = dropped.run;
  await dropped.run.done;
  assert.equal(stopped.sent.ok, true);
  assert.deepEqual(dropped.events.filter(e => e.type === 'steer'), [{ type: 'steer', id: stopped.sent.id, state: 'dropped' }]);
});

test('a CLI that lingers after a successful result is ended without reporting exit 143', async t => {
  const { run, events } = await setup(t, 'linger');
  const exit = await run.done;
  assert.equal(exit.code, 143);
  assert.equal(exit.stopped, false);
  assert.equal(exit.endedAfterResult, true);
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(events.filter(event => event.type === 'done').at(-1).isError, false);
});

test('a resumed session that first reports an empty result for leftover work keeps its input until the turn is idle', async t => {
  const { run, events, cwd } = await setup(t, 'orphan-resume', { sessionId: SESSION });
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(exit.result.result, '继续完成');
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'response.json'), 'utf8')), { eofAfterTurn: true });
});

test('a background task that finishes while idle keeps input open for the follow-up turn', async t => {
  const { run, events, cwd } = await setup(t, 'bg-states', { taskSettleMs: 1000 });
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(exit.result.result, '后台完成');
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'response.json'), 'utf8')), { eofAfterTurn: true });
});

test('a follow-up turn after input ends is not cut short by the exit deadline', async t => {
  const { run, events } = await setup(t, 'late-followup');
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(exit.result.result, '后续完成');
  assert.equal(events.some(event => event.type === 'error'), false);
});

test('a question asked after input ends is cancelled with a clear error instead of hanging', async t => {
  const { run, events } = await setup(t, 'late-question');
  const exit = await run.done;
  assert.equal(exit.code, 143);
  assert.equal(exit.endedAfterResult, undefined);
  assert.deepEqual(events.filter(event => event.type === 'error').map(event => event.message),
    ['Claude Code 在输入结束后仍在等待确认，已结束进程。']);
  assert.equal(events.filter(event => event.type === 'permission_cancelled').length, 1);
});

test('cancelling a waiting task does not become a timeout during process cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const { run, events } = await setup(t, 'permission', { timeoutMs: 1000, permissionMode: 'default',
    onEvent(event) { if (event.type === 'permission') ready(); } });
  await waiting;
  assert.equal(run.stop(), true);
  t.mock.timers.tick(1500);
  const exit = await run.done;
  assert.equal(exit.stopped, true);
  assert.equal(exit.timedOut, false);
  assert.equal(exit.stopReason, 'user');
  assert.equal(events.some(event => event.type === 'error'), false);
});

test('missing binary still reports one error and one exit without waiting for timeout', async (t) => {
  const events = [];
  const run = createClaudeRun({ cwd: tmpdir(), binary: join(tmpdir(), `missing-claude-${process.pid}`),
    prompt: 'hello', onEvent: event => events.push(event) });
  const exit = await run.done;
  assert.notEqual(exit.code, 0);
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  assert.equal(events.filter(event => event.type === 'done').length, 1);
});

test('stop terminates the owned process group, including a SIGTERM-resistant child', async (t) => {
  let runner;
  const { run, cwd } = await setup(t, 'family', { onEvent(event) {
    if (event.type === 'session') runner.stop();
  } });
  runner = run;
  const exit = await run.done;
  const descendant = Number(await readFile(join(cwd, 'record.json'), 'utf8'));
  assert.equal(exit.stopped, true);
  let gone = false;
  for (let i = 0; i < 20; i++) {
    try { process.kill(descendant, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(gone, true, 'owned descendant must not survive stop');
});

test('cumulative resumed totals are kept as snapshots, not reconstructed from per-turn usage', () => {
  const result = { session_id: SESSION, total_cost_usd: 2, usage: { input_tokens: 2, output_tokens: 1 },
    modelUsage: { sonnet: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 50, contextWindow: 200000 },
      opus: { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 200, cacheCreationInputTokens: 0, contextWindow: 1000000 } } };
  const usage = normalizeResultUsage(result, { model: 'sonnet', contextTokens: 123 });
  assert.equal(usage.inputTokens, 130);
  assert.equal(usage.contextTokens, 123);
  assert.equal(usage.contextWindow, 200000);
  assert.equal(usage.cumulative, true);
  const legacy = normalizeResultUsage({ usage: { input_tokens: 2, output_tokens: 1 } });
  assert.equal(legacy.scope, 'turn');
  assert.equal(legacy.cumulative, false);
  assert.equal(legacy.contextWindow, undefined);
});

test('rejects unsafe launch arguments before spawning', () => {
  const base = { cwd: '/tmp', prompt: 'hello' };
  assert.throws(() => createClaudeRun({ ...base, sessionId: '--dangerously-skip-permissions' }), /UUID/);
  assert.throws(() => createClaudeRun({ ...base, permissionMode: 'made-up' }), /permission/);
  assert.throws(() => createClaudeRun({ ...base, model: 'custom-provider' }), /model/);
  assert.throws(() => createClaudeRun({ ...base, effort: 'made-up' }), /effort/);
  assert.throws(() => createClaudeRun({ ...base, cwd: '../tmp' }), /absolute/);
  for (const timeoutMs of [-1, NaN, Infinity, '1000', 2 ** 31]) {
    assert.throws(() => createClaudeRun({ ...base, timeoutMs }), /timeoutMs/);
  }
  for (const field of ['initializationTimeoutMs', 'killGraceMs', 'exitGraceMs']) {
    for (const value of [0, -1, NaN, Infinity, 2 ** 31]) {
      assert.throws(() => createClaudeRun({ ...base, [field]: value }), new RegExp(field));
    }
  }
});

test('capabilities expose only explicitly allowed public fields', () => {
  const capabilities = normalizeCapabilities({ commands: [{ name: 'usage', description: 'Usage', api_key: 'secret' }],
    models: [{ value: 'sonnet', resolvedModel: 'actual-model', supportsEffort: true, secret: 'private' }],
    agents: [{ name: 'Explore', model: 'haiku', credentials: 'private' }], account: { token: 'private' },
    claude_code_version: '2.1.292' });
  assert.equal(capabilities.version, '2.1.292');
  assert.equal('account' in capabilities, false);
  assert.equal(JSON.stringify(capabilities).includes('private'), false);
  assert.equal(JSON.stringify(capabilities).includes('secret'), false);
});

test('thinking blocks are bracketed, timed and accumulated across per-block final frames', async t => {
  const { run, events, cwd } = await setup(t, 'thinking-blocks');
  const exit = await run.done;
  assert.equal(exit.code, 0);
  const record = JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8'));
  assert.equal(record.args[record.args.indexOf('--thinking-display') + 1], 'summarized');
  const brackets = events.filter(e => e.type === 'thinking_start' || e.type === 'thinking_stop');
  assert.deepEqual(brackets.map(e => e.type), ['thinking_start', 'thinking_stop', 'thinking_start', 'thinking_stop', 'thinking_start', 'thinking_stop']);
  assert(brackets.every(e => e.messageId === 'message-1'));
  assert.deepEqual(events.filter(e => e.type === 'thinking_progress').map(e => [e.estimatedTokens, e.messageId]),
    [[3, 'message-1'], [9, 'message-1']], 'subagent estimates are not attributed to the main reply');
  assert.deepEqual(events.filter(e => e.type === 'message').map(e => e.text), ['第一段', '第一段第二段']);
  assert.deepEqual(events.filter(e => e.type === 'thinking' && !e.redacted).map(e => e.text), ['先看配置', '先看配置\n\n再确认']);
  assert.equal(JSON.stringify(events).includes('signature-never-forwarded'), false);
  assert.equal(JSON.stringify(events).includes('redacted-payload-never-forwarded'), false);

  const session = newSession();
  const state = { messageId: 'fallback', usageBase: { ...session.metrics } };
  const snapshots = [];
  for (const event of events) {
    applyEvent(session, event, state);
    const message = session.messages.find(m => m.id === 'message-1');
    if (message) snapshots.push(message.thinking || '');
  }
  const message = session.messages.find(m => m.id === 'message-1');
  assert.equal(message.text, '第一段第二段');
  assert.equal(message.thinking, '先看配置\n\n再确认');
  assert(snapshots.every(text => !text.endsWith('\n\n')), 'a redacted block never leaves a dangling separator');
  assert(snapshots.includes('先看配置'), 'streamed thinking survives the redacted block');
  assert.equal(message.thinkingRedacted, true);
  assert.equal(message.thinkingTokens, 9);
  assert(message.thinkingStartedAt && message.thinkingEndedAt);
  assert(message.thinkingEndedAt >= message.thinkingStartedAt);
  assert.equal(session.status, 'idle');
});

test('a CLI that rejects the hidden thinking display flag is retried once without it and remembered', async t => {
  const { run, events, cwd } = await setup(t, 'no-thinking-flag');
  const exit = await run.done;
  assert.equal(exit.code, 0);
  assert.equal(events.some(e => e.type === 'error'), false);
  assert.deepEqual(events.filter(e => e.type === 'message').map(e => e.text), ['中文🙂']);
  assert.equal(events.filter(e => e.type === 'capabilities').length >= 1, true);
  const record = JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8'));
  assert.equal(record.args.includes('--thinking-display'), false);
  const again = createClaudeRun({ cwd, binary: join(cwd, 'fixture.mjs'), prompt: '再来一次', timeoutMs: 10000,
    initializationTimeoutMs: 5000, killGraceMs: 100, exitGraceMs: 100,
    env: { FIXTURE_MODE: 'normal', FIXTURE_RECORD: join(cwd, 'second.json'), FIXTURE_RESPONSE: join(cwd, 'second-response.json') } });
  t.after(() => again.stop());
  assert.equal((await again.done).code, 0);
  const second = JSON.parse(await readFile(join(cwd, 'second.json'), 'utf8'));
  assert.equal(second.args.includes('--thinking-display'), false, 'the rejection is remembered for this binary');
});

test('thinking display can be disabled and unknown display modes are rejected', async t => {
  const { run, cwd } = await setup(t, 'normal', { thinkingDisplay: null });
  await run.done;
  const record = JSON.parse(await readFile(join(cwd, 'record.json'), 'utf8'));
  assert.equal(record.args.includes('--thinking-display'), false);
  assert.throws(() => createClaudeRun({ cwd, binary: join(cwd, 'fixture.mjs'), prompt: '测试', thinkingDisplay: 'verbose' }),
    /Unsupported thinking display/);
});

test('a tool call appears while its input is generated, with early fields, size and an execution-only duration', async t => {
  const { run, events } = await setup(t, 'tool-stream');
  await run.done;
  const tools = events.filter(e => e.type === 'tool');
  assert.deepEqual(tools[0], { type: 'tool', id: 'tool-w', name: 'Write', input: {}, status: 'preparing' });
  const preparing = tools.filter(e => e.status === 'preparing');
  assert(preparing.some(e => e.input.file_path === '/tmp/app.js'), 'the path is known before the content is complete');
  assert(preparing.every(e => !('content' in e.input)), 'long fields are never previewed');
  assert(preparing.length <= 4, `progress is throttled (${preparing.length} updates)`);
  const bytes = preparing.at(-1).inputBytes;
  assert(bytes > 5150 && bytes < 5200, `the final progress counts every streamed byte (${bytes})`);
  const running = tools.find(e => e.status === 'running'), completed = tools.find(e => e.status === 'completed');
  assert.deepEqual(running.input, { file_path: '/tmp/app.js', content: 'done' });
  assert.equal('inputBytes' in running, false);
  assert(completed.durationMs < 250, `duration excludes input generation (${completed.durationMs}ms)`);
  const session = newSession(), state = { messageId: 'fallback', usageBase: { ...session.metrics } };
  for (const event of events) applyEvent(session, event, state);
  assert.equal(session.tools.length, 1); assert.equal(session.tools[0].status, 'completed');
  assert.deepEqual(session.events.filter(e => e.type === 'tool').map(e => e.status), ['running', 'completed'], 'generation progress stays out of the audit log');
});

test('tool input previews read only complete identifying strings from the head of partial JSON', () => {
  assert.deepEqual(previewToolInput('{"command": "ls -la \\"dir\\"", "description": "列出'), { command: 'ls -la "dir"' });
  assert.deepEqual(previewToolInput('{"content": "x \\"file_path\\": \\"/etc\\" y", "file_path": "/a.js"}'), { file_path: '/a.js' });
  assert.deepEqual(previewToolInput('{"old_string": "a", "timeout": 5, "path": "src"}'), { path: 'src' });
  assert.deepEqual(previewToolInput(`{"content": "${'z'.repeat(5000)}", "file_path": "/late.js"}`), {}, 'fields after the scanned head are ignored');
  assert.deepEqual(previewToolInput('not json'), {});
});
