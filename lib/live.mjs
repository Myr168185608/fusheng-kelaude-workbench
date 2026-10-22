import {randomUUID} from 'node:crypto';
import {liveTool} from './state.mjs';

// Streaming changes reach the browser as small SSE patches instead of full snapshot refetches.
// Patches carry a per-session `seq`; a `?view=live` snapshot reports the seq it already
// contains, so the browser applies only later patches and refetches when it sees a gap.
// `epoch` changes with every server start, which resets all sequences.
const messageEvents=new Set(['text_delta','message','thinking_delta','thinking','thinking_start','thinking_stop','thinking_progress']);
const metaFields=['role','createdAt','thinkingStartedAt','thinkingEndedAt','thinkingTokens','thinkingRedacted','model'];
export const messageMeta=m=>Object.fromEntries(metaFields.filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));
// Within one batch: adjacent appends join, and only the newest copy of a full record is kept
// (at its first position, so a message is always created before text is appended to it).
export function compactOps(ops){
 const out=[],slots=new Map();
 for(const op of ops){
  const last=out.at(-1);
  if(op.op==='append'&&last?.op==='append'&&last.id===op.id&&last.field===op.field){last.value+=op.value;continue;}
  const slot=op.op==='message'?`m:${op.id}`:op.op==='tool'?`t:${op.tool.id}`:op.op==='metrics'?'metrics':null;
  if(slot&&slots.has(slot)){out[slots.get(slot)]=op;continue;}
  if(slot)slots.set(slot,out.length);
  out.push(op.op==='append'?{...op}:op);
 }
 return out;
}
export class LiveFeed{
 constructor({broadcast,delayMs=40}){this.epoch=randomUUID();this.broadcast=broadcast;this.delayMs=delayMs;this.seqs=new Map();this.queues=new Map();}
 // Call before applyEvent: remembers what the browser already has for the affected message.
 before(s,e,run){
  if(!messageEvents.has(e.type))return null;
  const id=e.id||e.messageId||run.messageId,m=s.messages.findLast(x=>x.id===id);
  return {id,exists:Boolean(m),text:m?.text||'',thinking:m?.thinking||'',meta:m?JSON.stringify(messageMeta(m)):''};
 }
 // Call after applyEvent. Returns false for events the browser must learn from a snapshot.
 after(s,e,run,before){
  const ops=[];
  if(before){
   const m=s.messages.findLast(x=>x.id===before.id);if(!m)return true;
   const meta=messageMeta(m);if(!before.exists||JSON.stringify(meta)!==before.meta)ops.push({op:'message',id:m.id,meta});
   for(const field of ['text','thinking']){
    const previous=before[field],next=m[field]||'';if(previous===next)continue;
    const delta=e.type===`${field}_delta`?e.text||'':null;
    if(delta!==null&&next.length===previous.length+delta.length)ops.push({op:'append',id:m.id,field,value:delta});
    else if(next.length>previous.length&&next.startsWith(previous))ops.push({op:'append',id:m.id,field,value:next.slice(previous.length)});
    else ops.push({op:'set',id:m.id,field,value:next});
   }
  }else if(e.type==='tool'){const t=s.tools.findLast(x=>x.id===e.id);if(t)ops.push({op:'tool',tool:liveTool(t)});}
  else if(e.type==='usage')ops.push({op:'metrics',metrics:s.metrics});
  else return false;
  if(ops.length)this.queue(s.id,ops);
  return true;
 }
 queue(id,ops){if(this.closed)return;let q=this.queues.get(id);if(!q){q={ops:[],timer:setTimeout(()=>this.flush(id),this.delayMs)};this.queues.set(id,q);}q.ops.push(...ops);}
 flush(id){
  const q=this.queues.get(id);if(!q)return;
  clearTimeout(q.timer);this.queues.delete(id);
  const seq=(this.seqs.get(id)||0)+1;this.seqs.set(id,seq);
  this.broadcast({type:'session-patch',sessionId:id,epoch:this.epoch,seq,now:new Date().toISOString(),ops:compactOps(q.ops)});
 }
 // Snapshot metadata. Pending patches are flushed first, so a snapshot never contains a
 // change that a later seq would apply a second time.
 info(id){this.flush(id);return {epoch:this.epoch,seq:this.seqs.get(id)||0,now:new Date().toISOString()};}
 close(){this.closed=true;for(const q of this.queues.values())clearTimeout(q.timer);this.queues.clear();}
}
