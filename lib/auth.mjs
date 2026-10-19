import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,scrypt as scryptCb,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCb), digest=x=>createHash('sha256').update(x).digest('hex');
export async function hashPassword(password,salt=randomBytes(24).toString('hex')){return {salt,hash:(await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024})).toString('hex')};}
export async function verifyPassword(password,record){if(typeof password!=='string'||password.length>1024)return false;const {hash}=await hashPassword(password,record.salt);const actual=Buffer.from(hash,'hex'),expected=Buffer.from(record.hash,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export function parseCookie(header=''){return Object.fromEntries(header.split(';').map(v=>v.trim().split('=')).filter(x=>x.length===2));}
export class Auth{
 constructor({dir,passwordRecord,secure=true,ttl=12*3600*1000,userName='operator'}){this.dir=dir;this.record=passwordRecord;this.secure=secure;this.ttl=ttl;this.userName=userName;this.sessions=new Map();this.attempts=new Map();this.file=path.join(dir,'web-sessions.json');this.writeQueue=Promise.resolve();this.loginBusy=0;}
 async init(){await fs.mkdir(this.dir,{recursive:true,mode:0o700});try{for(const [k,v]of JSON.parse(await fs.readFile(this.file,'utf8')))if(v.expires>Date.now())this.sessions.set(k,v);}catch{}}
 persist(){const value=JSON.stringify([...this.sessions]);this.writeQueue=this.writeQueue.catch(()=>{}).then(async()=>{await fs.writeFile(this.file+'.tmp',value,{mode:0o600});await fs.rename(this.file+'.tmp',this.file);});return this.writeQueue;}
 get(req){const raw=parseCookie(req.headers.cookie).workbench_session;if(!raw||!/^[a-f0-9]{64}$/.test(raw))return null;const key=digest(raw),s=this.sessions.get(key);if(!s||s.expires<Date.now()){if(s)this.sessions.delete(key);return null;}return {...s,key};}
 cookie(raw,maxAge=this.ttl){return `workbench_session=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge/1000)}${this.secure?'; Secure':''}`;}
 async login(password,ip){const time=Date.now();for(const [key,value]of this.attempts)if(value.until<time)this.attempts.delete(key);const a=this.attempts.get(ip)||{count:0,until:time+15*60*1000};if(a.count>=8||this.loginBusy>=2)return {error:'尝试次数较多，请稍后再试。',status:429};a.count++;this.attempts.set(ip,a);this.loginBusy++;let ok;try{ok=await verifyPassword(password,this.record);}finally{this.loginBusy--;}if(!ok)return {error:'口令不正确。',status:401};this.attempts.delete(ip);for(const[k,v]of this.sessions)if(v.expires<time)this.sessions.delete(k);while(this.sessions.size>=20)this.sessions.delete(this.sessions.keys().next().value);const raw=randomBytes(32).toString('hex'),s={csrfToken:randomBytes(24).toString('hex'),expires:time+this.ttl,user:{name:this.userName}};this.sessions.set(digest(raw),s);await this.persist();return {raw,...s};}
 async logout(s){this.sessions.delete(s.key);await this.persist();}
}
