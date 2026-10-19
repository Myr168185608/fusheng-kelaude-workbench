import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TerminalManager} from '../lib/terminal.mjs';
import {spawn} from 'node:child_process';
const waitFor=async predicate=>{const until=performance.now()+8000;while(performance.now()<until){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Terminal condition timed out');};

async function idleFixture(t,kind){
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-terminal-idle-'));
 const binary=path.join(cwd,'fixture.py');
 await fs.writeFile(binary,"#!/usr/bin/python3\nimport os,time\nprint('IDLE_FIXTURE_READY',flush=True)\nwhile True:\n if os.path.exists('emit-output'):\n  os.remove('emit-output')\n  print('ACTUAL_PTY_OUTPUT',flush=True)\n time.sleep(0.02)\n",{mode:0o700});
 t.mock.timers.enable({apis:['Date','setInterval'],now:Date.UTC(2026,9,17)});
 const manager=new TerminalManager({binary});
 t.after(async()=>{t.mock.timers.reset();await manager.close();await fs.rm(cwd,{recursive:true,force:true});});
 const info=manager.start({sessionId:'idle-test',cwd,kind}),terminal=manager.get(info.id);
 await waitFor(()=>terminal.pgid);
 // Descendant cleanup has dedicated tests; do not scan /proc thousands of times
 // while advancing the inactivity clock by hours in these focused timer tests.
 clearInterval(terminal.processTimer);
 if(kind==='shell')manager.input(info.id,'/usr/bin/python3 -I fixture.py\r');
 await waitFor(()=>terminal.frames.some(f=>f.data?.includes('IDLE_FIXTURE_READY')));
 const emitOutput=async()=>{
  const before=terminal.seq;
  await fs.writeFile(path.join(cwd,'emit-output'),'1');
  await waitFor(()=>terminal.frames.some(f=>f.seq>before&&f.data?.includes('ACTUAL_PTY_OUTPUT')));
 };
 return {manager,terminal,emitOutput};
}

test('native Claude survives more than 30 minutes of silence or output and still supports Stop',async t=>{
 const {manager,terminal,emitOutput}=await idleFixture(t,'claude');
 assert.equal(terminal.timer,undefined,'native Claude must not inherit the shell idle reaper');
 t.mock.timers.tick(31*60_000);
 assert.equal(terminal.status,'running','quiet thinking must not terminate a native task');
 for(let i=0;i<2;i++){
  t.mock.timers.tick(20*60_000);
  await emitOutput();
  assert.equal(terminal.status,'running','a task producing output needs no keyboard keepalive');
 }
 assert(!terminal.frames.some(f=>f.data?.includes('闲置')));
 manager.stop(terminal.id);await terminal.done;
 assert.equal(terminal.status,'exited');
 assert.throws(()=>process.kill(-terminal.pgid,0),{code:'ESRCH'});
});

test('shell output renews its idle deadline but empty input and resize do not prevent real idle reclamation',async t=>{
 const {manager,terminal,emitOutput}=await idleFixture(t,'shell');
 t.mock.timers.tick(29*60_000);await emitOutput();
 const lastActivity=terminal.lastActivity;
 t.mock.timers.tick(2*60_000);
 assert.equal(terminal.status,'running','shell output keeps the task alive past 31 total minutes');
 t.mock.timers.tick(28*60_000);
 manager.input(terminal.id,'');manager.resize(terminal.id,120,30);
 assert.throws(()=>manager.input(terminal.id,'x'.repeat(65537)),/输入过大/);
 assert.equal(terminal.lastActivity,lastActivity,'only accepted nonempty input or PTY output counts');
 t.mock.timers.tick(60_000);await terminal.done;
 assert.equal(terminal.status,'exited');
 assert(terminal.frames.some(f=>f.data?.includes('Shell 无输入或输出超过闲置时限')));
});

test('accepted nonempty shell input renews its idle deadline',async t=>{
 const {manager,terminal}=await idleFixture(t,'shell');
 t.mock.timers.tick(29*60_000);
 manager.input(terminal.id,'x');
 assert.equal(terminal.lastActivity,Date.now());
 t.mock.timers.tick(2*60_000);
 assert.equal(terminal.status,'running');
 manager.stop(terminal.id);await terminal.done;
});

test('native terminal uses official bypass mode by default while preserving manual and plan choices',async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-terminal-modes-'));
 const binary=path.join(cwd,'claude-fixture.py');
 await fs.writeFile(binary,"#!/usr/bin/python3\nimport json,sys\nopen('argv.json','w').write(json.dumps(sys.argv[1:]))\n",{mode:0o700});
 const manager=new TerminalManager({binary});
 t.after(async()=>{await manager.close();await fs.rm(cwd,{recursive:true,force:true});});
 const session='767698b8-a7e8-435c-942d-1071d03bd34e';
 for(const [permissionMode,expected] of [[undefined,'bypassPermissions'],['bypassPermissions','bypassPermissions'],['default','manual'],['plan','plan']]){
  const info=manager.start({sessionId:'mode-test',cwd,kind:'claude',permissionMode,model:'opus',effort:'high',claudeSessionId:session});
  const terminal=manager.get(info.id);await terminal.done;
  assert.equal(terminal.exitCode,0);
  const args=JSON.parse(await fs.readFile(path.join(cwd,'argv.json'),'utf8'));
  assert.equal(args[args.indexOf('--permission-mode')+1],expected);
  assert.equal(args[args.indexOf('--model')+1],'opus');
  assert.equal(args[args.indexOf('--effort')+1],'high');
  assert(args.includes(`--resume=${session}`));
 }
 assert.throws(()=>manager.start({sessionId:'mode-test',cwd,kind:'claude',permissionMode:'injected'}),/配置/);
});
test('real PTY supports unicode, resize, output replay and exit without invoking Claude',async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-terminal-'));const manager=new TerminalManager({binary:'/usr/bin/false'});t.after(async()=>{await manager.close();await fs.rm(cwd,{recursive:true,force:true});});
 const info=manager.start({sessionId:'test',cwd,kind:'shell'});const terminal=manager.get(info.id);await waitFor(()=>terminal.pgid);
 manager.resize(info.id,120,30);manager.input(info.id,"printf '中文终端_OK\\n'; stty size\r");
 await waitFor(()=>terminal.frames.some(f=>f.data?.includes('30 120')));
 assert(terminal.frames.some(f=>f.data?.includes('中文终端_OK')));assert.throws(()=>manager.start({sessionId:'other',cwd}),/已有终端/);
 manager.input(info.id,'exit\r');await terminal.done;assert.equal(terminal.status,'exited');assert.equal(manager.active,undefined);assert(terminal.frames.some(f=>f.type==='exit'));
 assert.throws(()=>manager.input(info.id,'x'),/已经结束/);
});
test('stop kills the owned PTY process group and rejects invalid geometry and launch settings',async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-terminal-stop-'));const manager=new TerminalManager({binary:'/usr/bin/false'});t.after(async()=>{await manager.close();await fs.rm(cwd,{recursive:true,force:true});});
 assert.throws(()=>manager.start({sessionId:'test',cwd,cols:'evil'}),/尺寸/);assert.throws(()=>manager.start({sessionId:'test',cwd,kind:'root'}),/类型/);assert.throws(()=>manager.start({sessionId:'test',cwd,effort:'injected'}),/配置/);
 const info=manager.start({sessionId:'test',cwd});const term=manager.get(info.id);await waitFor(()=>term.pgid);manager.input(info.id,"sleep 90\r");manager.stop(info.id);await term.done;
 assert.equal(term.status,'exited');assert.throws(()=>process.kill(-term.pgid,0),{code:'ESRCH'});await manager.close();assert.throws(()=>manager.start({sessionId:'test',cwd}),/关闭/);
});

for (const action of ['stop','exit']) test(`${action} removes background jobs that ignore HUP/TERM without killing unrelated processes`,async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-terminal-descendants-'));
 const manager=new TerminalManager({binary:'/usr/bin/false'});
 const unrelated=spawn('/bin/sleep',['30'],{stdio:'ignore'});
 let jobPid;
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 t.after(async()=>{if(jobPid)try{process.kill(jobPid,'SIGKILL');}catch{}unrelated.kill('SIGKILL');await manager.close();await fs.rm(cwd,{recursive:true,force:true});});
 await fs.writeFile(path.join(cwd,'job.py'),"import os,signal,time\nsignal.signal(signal.SIGHUP,signal.SIG_IGN)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen('job.pid','w').write(str(os.getpid()))\ntime.sleep(30)\n");
 const info=manager.start({sessionId:'tree-test',cwd}),term=manager.get(info.id);
 await waitFor(()=>term.pgid);
 manager.input(info.id,"/usr/bin/python3 -I job.py >/dev/null 2>&1 &\r");
 const until=Date.now()+5000;
 while(Date.now()<until){try{jobPid=Number(await fs.readFile(path.join(cwd,'job.pid'),'utf8'));if(jobPid)break;}catch{}await new Promise(r=>setTimeout(r,20));}
 assert(jobPid,'background fixture started');assert(alive(jobPid));
 if(action==='stop')manager.stop(info.id);else manager.input(info.id,'exit\r');
 await term.done;
 await waitFor(()=>!alive(jobPid));
 assert(alive(unrelated.pid),'terminal cleanup must preserve unrelated sibling process');
 assert.equal(term.status,'exited');assert.equal(manager.active,undefined);
});

test('Linux subreaper removes a double-forked child in a different session',{skip:process.platform!=='linux'},async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-terminal-daemon-'));
 const manager=new TerminalManager({binary:'/usr/bin/false'});let daemonPid;
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 t.after(async()=>{if(daemonPid)try{process.kill(daemonPid,'SIGKILL');}catch{}await manager.close();await fs.rm(cwd,{recursive:true,force:true});});
 await fs.writeFile(path.join(cwd,'daemon.py'),"import os,signal,time\nif os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\nsignal.signal(signal.SIGHUP,signal.SIG_IGN)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen('daemon.pid','w').write(str(os.getpid()))\ntime.sleep(30)\n");
 const info=manager.start({sessionId:'daemon-test',cwd}),term=manager.get(info.id);await waitFor(()=>term.pgid);
 manager.input(info.id,'/usr/bin/python3 -I daemon.py >/dev/null 2>&1\r');
 const until=Date.now()+5000;
 while(Date.now()<until){try{daemonPid=Number(await fs.readFile(path.join(cwd,'daemon.pid'),'utf8'));if(daemonPid)break;}catch{}await new Promise(r=>setTimeout(r,20));}
 assert(daemonPid,'double-forked fixture started');assert(alive(daemonPid));
 manager.stop(info.id);await term.done;await waitFor(()=>!alive(daemonPid));
 assert.equal(manager.active,undefined);
});

test('Linux fallback terminates owned jobs after abrupt PTY bridge death',{skip:process.platform!=='linux'},async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-terminal-bridge-death-'));
 const manager=new TerminalManager({binary:'/usr/bin/false'});let jobPid;
 const alive=pid=>{try{const raw=readFileForPid(pid);return raw!=='Z';}catch(error){if(error.code==='ENOENT')return false;throw error;}};
 const {readFileSync}=await import('node:fs');
 const readFileForPid=pid=>{const raw=readFileSync(`/proc/${pid}/stat`,'utf8');return raw.slice(raw.lastIndexOf(')')+2).split(' ')[0];};
 t.after(async()=>{if(jobPid)try{process.kill(jobPid,'SIGKILL');}catch{}await manager.close();await fs.rm(cwd,{recursive:true,force:true});});
 await fs.writeFile(path.join(cwd,'job.py'),"import os,signal,time\nsignal.signal(signal.SIGHUP,signal.SIG_IGN)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen('job.pid','w').write(str(os.getpid()))\ntime.sleep(30)\n");
 const info=manager.start({sessionId:'bridge-death',cwd}),term=manager.get(info.id);await waitFor(()=>term.pgid);
 manager.input(info.id,'/usr/bin/python3 -I job.py >/dev/null 2>&1 &\r');
 const until=Date.now()+5000;
 while(Date.now()<until){try{jobPid=Number(await fs.readFile(path.join(cwd,'job.pid'),'utf8'));if(jobPid)break;}catch{}await new Promise(r=>setTimeout(r,20));}
 assert(jobPid);await new Promise(r=>setTimeout(r,350));
 term.child.kill('SIGKILL');await term.done;await waitFor(()=>!alive(jobPid));
 assert.equal(manager.active,undefined);
});
