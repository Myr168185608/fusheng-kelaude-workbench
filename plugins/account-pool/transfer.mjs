import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail=(message)=>Object.assign(new Error(message),{status:409,statusCode:409});

// Copy only this conversation's local transcript and rewind/subagent records.
// Account configuration, credentials, caches, policies and active PID records
// never cross account boundaries. The shared workspace itself stays in place.
export async function transferConversation({sessionId,sourceDir,targetDir,cwd}) {
  if(!uuid.test(sessionId)||![sourceDir,targetDir,cwd].every(v=>typeof v==='string'&&path.isAbsolute(v)))throw fail('会话接续参数无效。');
  if(path.resolve(sourceDir)===path.resolve(targetDir))return;
  const project=cwd.replace(/[^a-zA-Z0-9]/g,'-');
  const projectRelative=path.join('projects',project);
  const transcript=path.join(projectRelative,`${sessionId}.jsonl`);
  let total=0,entries=0;
  const files=[],directories=new Set();
  async function safeParent(base,relative,create=false,allowMissing=false) {
    let current=base;const baseStat=await fs.lstat(base);
    if(!baseStat.isDirectory()||baseStat.isSymbolicLink())throw fail('账号目录不可用于接续。');
    for(const part of relative.split(path.sep).filter(Boolean)) {
      current=path.join(current,part);
      if(create)await fs.mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      let st;try{st=await fs.lstat(current);}catch(e){if(allowMissing&&e.code==='ENOENT')return current;throw e;}
      if(!st.isDirectory()||st.isSymbolicLink())throw fail('会话目录包含不支持的链接。');
    }
    return current;
  }
  async function inspect(relative,optional=false) {
    const source=path.join(sourceDir,relative),target=path.join(targetDir,relative);
    let st;try{st=await fs.lstat(source);}catch(e){if(optional&&e.code==='ENOENT')return;throw fail('原账号的官方会话记录不存在，已保留原会话。');}
    if(++entries>10000)throw fail('会话记录文件过多，未开始新任务。');
    if(st.isSymbolicLink())throw fail('会话记录含链接，无法安全接续。');
    await safeParent(sourceDir,path.dirname(relative));
    if(st.isDirectory()) {
      await safeParent(targetDir,relative,false,true);
      directories.add(relative);
      for(const name of await fs.readdir(source))await inspect(path.join(relative,name));
      return;
    }
    if(!st.isFile()||st.nlink!==1||(total+=st.size)>128*1024*1024)throw fail('会话记录过大或类型不支持，未开始新任务。');
    await safeParent(targetDir,path.dirname(relative),false,true);
    try {const previous=await fs.lstat(target);if(!previous.isFile()||previous.isSymbolicLink()||previous.nlink!==1)throw fail('目标会话记录不可覆盖。');}catch(e){if(e.code!=='ENOENT')throw e;}
    files.push({relative,size:st.size,ino:st.ino,dev:st.dev});
  }
  async function copy(record) {
    const {relative}=record;
    const source=path.join(sourceDir,relative),target=path.join(targetDir,relative);
    await safeParent(sourceDir,path.dirname(relative));
    await safeParent(targetDir,path.dirname(relative),true);
    // Recheck immediately before publishing, even though inspection has already
    // rejected unsupported records throughout the complete transfer.
    const current=await fs.lstat(source);
    if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||current.ino!==record.ino||current.dev!==record.dev||current.size!==record.size)throw fail('会话记录发生变化，请稍后重试。');
    const tmp=`${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      // Keep the inspected inode open without following a substituted symlink.
      // The host's shared lock keeps Claude from appending during this transfer.
      handle=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW);
      const opened=await handle.stat();
      if(!opened.isFile()||opened.nlink!==1||opened.ino!==record.ino||opened.dev!==record.dev||opened.size!==record.size)throw fail('会话记录发生变化，请稍后重试。');
      const bytes=await handle.readFile();
      if(bytes.length!==record.size)throw fail('会话记录发生变化，请稍后重试。');
      await fs.writeFile(tmp,bytes,{flag:'wx',mode:0o600});
      await safeParent(targetDir,path.dirname(relative));
      await fs.rename(tmp,target);
    }finally{await handle?.close();await fs.rm(tmp,{force:true});}
  }
  try {
    // Preflight every source and existing target before changing any destination.
    // The explicit source is the account that most recently ran this session;
    // filesystem mtimes do not determine which conversation state wins.
    await safeParent(sourceDir,projectRelative);
    const st=await fs.lstat(path.join(sourceDir,transcript)).catch(()=>null);
    if(!st?.isFile()||st.isSymbolicLink()||st.nlink!==1)throw fail('原账号的官方会话记录尚未落盘或不是独立文件，请稍后重试。');
    await inspect(path.join(projectRelative,sessionId),true);
    await inspect(path.join('file-history',sessionId),true);
    await inspect(transcript);
    for(const directory of directories)await safeParent(targetDir,directory,true);
    for(const record of files)await copy(record);
  } catch(error) {
    if(error.status===409)throw error;
    throw fail('会话记录暂时无法接续，已保留原会话，请稍后重试。');
  }
}
