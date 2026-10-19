// Creates or replaces the workbench login credential. Only a scrypt hash is stored, never the password.
//   npm run set-password                               interactive, input hidden
//   printf '%s' "$PASSWORD" | npm run set-password     non-interactive (reads stdin)
// Changing the password signs out every browser session; restart the service to apply it.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashPassword} from '../lib/auth.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir=process.env.WORKBENCH_DATA||path.join(root,'data');
const file=process.env.WORKBENCH_AUTH_FILE||path.join(dataDir,'auth.json');
const MIN_LENGTH=12,MAX_LENGTH=1024;

function prompt(question){
 return new Promise((resolve,reject)=>{
  const {stdin,stdout}=process;let value='';
  const finish=error=>{stdin.off('data',onData);stdin.setRawMode(false);stdin.pause();stdout.write('\n');if(error)reject(error);else resolve(value);};
  const onData=chunk=>{for(const c of chunk){if(c==='\r'||c==='\n')return finish();if(c==='\u0003')return finish(new Error('已取消，未做任何修改。'));if(c==='\u007f'||c==='\b')value=value.slice(0,-1);else if(c>=' ')value+=c;}};
  stdout.write(question);stdin.setEncoding('utf8');stdin.setRawMode(true);stdin.resume();stdin.on('data',onData);
 });
}
async function readStdin(){let text='';for await(const chunk of process.stdin)text+=chunk;return text.replace(/\r?\n$/,'');}

try{
 let password;
 if(process.stdin.isTTY){
  password=await prompt('设置工作台口令：');
  if(password.length>=MIN_LENGTH&&password!==await prompt('再次输入确认：'))throw new Error('两次输入不一致，未做任何修改。');
 }else password=await readStdin();
 if(password.length<MIN_LENGTH)throw new Error(`口令至少需要 ${MIN_LENGTH} 个字符：它保护的是一台服务器的终端。`);
 if(password.length>MAX_LENGTH)throw new Error(`口令最多 ${MAX_LENGTH} 个字符。`);
 let previous={};try{previous=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
 const record={...(typeof previous.userName==='string'?{userName:previous.userName}:{}),...await hashPassword(password),updatedAt:new Date().toISOString()};
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
 await fs.writeFile(`${file}.tmp`,JSON.stringify(record,null,2)+'\n',{mode:0o600});
 await fs.rename(`${file}.tmp`,file);
 await fs.rm(path.join(dataDir,'web-sessions.json'),{force:true});
 console.log(`已写入 ${file}（只保存 scrypt 哈希）。重启工作台服务后生效，所有浏览器需要重新登录。`);
}catch(error){console.error(error.message);process.exitCode=1;}
