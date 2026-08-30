import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import { ConversationState, resolveConversationState } from '../lib/conversation-manager.js';
import { conversationStore, toolSchemaRegistry, toolExecutionLedger } from '../lib/runtime.js';
import { sha256 } from '../lib/canonical.js';
import { currentImageAttachments, resolveDifyFiles } from '../lib/attachments.js';

const PROVIDER = 'dify';
const textOf = (m) => typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.filter(x=>x?.type==='text').map(x=>x.text||'').join('\n') : '';
const dshIdOf = (req) => String(req.headers['x-dsh-conversation-id'] || req.headers['x-session-id'] || req.body?.user || 'default');
const appIdOf = (req, config) => String(req.headers['x-dify-app-id'] || req.body?.dify_app_id || sha256(config.API_KEY || config.DIFY_API_URL).slice(0,16));
const resetOf = (req) => req.headers['x-conversation-reset'] === 'true' || req.body?.reset === true;
const responseLocals = (res) => res.locals ??= {};
function trace(event) {
  const { dshConversationId, ...rest } = event;
  console.log(JSON.stringify({
    ts:new Date().toISOString(),
    component:'dify2oai',
    ...dshConversationId === undefined ? {} : { sessionIdHash: sha256(`session:${String(dshConversationId)}`).slice(0,24) },
    ...rest,
  }));
}
function extractToolInfo(messages=[]) { const calls=new Map(),results=[]; for(const m of messages){ if(m.role==='assistant'&&Array.isArray(m.tool_calls)) for(const c of m.tool_calls) calls.set(c.id,c); if(m.role==='tool'||m.role==='function') results.push(m); } return {calls,results}; }
function serializeMessage(m) { if(m.role==='assistant'&&Array.isArray(m.tool_calls)&&m.tool_calls.length) return `assistant_tool_calls: ${JSON.stringify(m.tool_calls)}`; if(m.role==='tool'||m.role==='function') return `tool_result tool_call_id=${m.tool_call_id||''}: ${textOf(m)}`; return `${m.role}: ${textOf(m)}`; }
const fullHistory=(messages)=>messages.map(serializeMessage).filter(Boolean).join('\n\n');
const deltaHistory=(messages)=>{const last=[...messages].reverse().find(m=>m.role==='user');return last?serializeMessage(last):serializeMessage(messages.at(-1));};
function toolContinuation(messages){let i=messages.length-1;const tail=[];while(i>=0&&(messages[i].role==='tool'||messages[i].role==='function'))tail.unshift(messages[i--]);if(i>=0&&messages[i].role==='assistant'&&Array.isArray(messages[i].tool_calls))tail.unshift(messages[i]);return tail.map(serializeMessage).join('\n\n');}
function schemaPrompt(tools){if(!tools?.length)return'';return `External tools available to the client:\n${JSON.stringify(tools)}\nIf an external tool is required, return ONLY JSON: {"tool_calls":[{"id":"stable-id","type":"function","function":{"name":"tool_name","arguments":"{\\"key\\":\\"value\\"}"}}]}. Preserve each tool call id exactly on subsequent turns.`;}
function parseToolCalls(answer=''){const candidates=[answer.trim(),answer.replace(/^```json\s*/i,'').replace(/```$/,'').trim()];for(const c of candidates){try{const j=JSON.parse(c);if(Array.isArray(j?.tool_calls))return j.tool_calls;}catch{}}const out=[];const re=/```(?:bash|sh|shell)\s*\n([\s\S]*?)```/gi;let m;while((m=re.exec(answer)))out.push({id:`call_${sha256(m[1]).slice(0,16)}`,type:'function',function:{name:'bash',arguments:JSON.stringify({command:m[1].trim()})}});return out;}
function recordIncomingToolResults(providerId,dshConversationId,messages){const{calls,results}=extractToolInfo(messages);for(const r of results){const c=calls.get(r.tool_call_id);if(!c)continue;toolExecutionLedger.complete({providerId,conversationId:dshConversationId,toolCallId:c.id,arguments:c.function?.arguments||'{}'},textOf(r));}}
const isInvalidConversation=(status,body)=>[400,404].includes(status)&&/conversation|not found|invalid/i.test(body||'');
async function callDify(config,body,attachments=[]){
 const files=await resolveDifyFiles({baseURL:config.DIFY_API_URL,apiKey:config.API_KEY,attachments,user:body.user});
 const payload=files.length?{...body,files}:body;
 const resp=await fetch(`${config.DIFY_API_URL}/chat-messages`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.API_KEY}`},body:JSON.stringify(payload)});
 const raw=await resp.text();let json=null;try{json=JSON.parse(raw)}catch{}return{ok:resp.ok,status:resp.status,raw,json};
}
function openAIResponse(data,answer,toolCalls,traceId){return{id:`chatcmpl-${traceId}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:data.model||'dify',choices:[{index:0,message:{role:'assistant',content:toolCalls.length?null:answer,...(toolCalls.length?{tool_calls:toolCalls}:{})},finish_reason:toolCalls.length?'tool_calls':'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}};}
function send(res,data,payload){if(!data.stream)return res.json(payload);res.setHeader('Content-Type','text/event-stream');const msg=payload.choices[0].message;res.write(`data: ${JSON.stringify({id:payload.id,object:'chat.completion.chunk',created:payload.created,model:payload.model,choices:[{index:0,delta:{role:'assistant',...(msg.content?{content:msg.content}:{}),...(msg.tool_calls?{tool_calls:msg.tool_calls.map((x,index)=>({index,...x}))}:{})},finish_reason:payload.choices[0].finish_reason}]})}\n\n`);res.end('data: [DONE]\n\n');}

async function handleRequest(req,res,config){
 const data=req.body||{},messages=Array.isArray(data.messages)?data.messages:[],traceId=randomUUID(),dshConversationId=dshIdOf(req),providerId=String(req.headers['x-provider-id']||PROVIDER),difyAppId=appIdOf(req,config),currentAttachments=currentImageAttachments(messages,'openai');
 if(resetOf(req)){conversationStore.resetProvider(dshConversationId,providerId,difyAppId);trace({traceId,dshConversationId,providerId,difyAppId,conversationState:'RESET',contextStrategy:'FULL_BOOTSTRAP'});}
 let remote=conversationStore.get(dshConversationId,providerId,difyAppId),resolved=resolveConversationState({remoteState:remote,messages,reset:false});
 const schema=toolSchemaRegistry.resolve({dshConversationId,providerId,difyAppId,tools:data.tools||[]});recordIncomingToolResults(providerId,dshConversationId,messages);
 const buildQuery=(strategy)=>{let q=strategy==='DELTA_CONTINUE'?deltaHistory(messages):strategy==='TOOL_CONTINUE'?toolContinuation(messages):fullHistory(messages);if(schema.changed&&data.tools?.length)q=`${schemaPrompt(data.tools)}\n\n${q}`;return q;};
 const makeBody=(conversationId,strategy)=>({inputs:{},query:buildQuery(strategy),response_mode:'blocking',conversation_id:conversationId||'',user:String(data.user||dshConversationId),auto_generate_name:false});
 const attachmentsFor=()=>currentAttachments;
 trace({traceId,dshConversationId,providerId,difyConversationId:remote?.conversationId||'',conversationState:resolved.state,attachmentCount:attachmentsFor().length,toolSchemaHash:schema.toolSchemaHash,contextStrategy:resolved.contextStrategy,event:schema.traceEvent});
 let result;
 try{result=await callDify(config,makeBody(remote?.conversationId,resolved.contextStrategy),attachmentsFor());}
 catch(error){responseLocals(res).gatewayErrorType=String(error?.code||'dify_attachment_error');return res.status(error?.status||502).json({error:{message:error?.message||'Dify attachment processing failed',type:'dify_attachment_error',trace_id:traceId}});}
 if(!result.ok&&remote?.conversationId&&isInvalidConversation(result.status,result.raw)){
   conversationStore.invalidate(dshConversationId,providerId,difyAppId);
   resolved=resolveConversationState({remoteState:conversationStore.get(dshConversationId,providerId,difyAppId),messages,remoteInvalid:true});
   trace({traceId,dshConversationId,providerId,difyConversationId:remote.conversationId,conversationState:ConversationState.RECOVER,attachmentCount:attachmentsFor().length,toolSchemaHash:schema.toolSchemaHash,contextStrategy:resolved.contextStrategy});
   const locals=responseLocals(res);
   locals.gatewayRetryCount=Number(locals.gatewayRetryCount||0)+1;
   try{result=await callDify(config,makeBody('',resolved.contextStrategy),attachmentsFor());}
   catch(error){locals.gatewayErrorType=String(error?.code||'dify_attachment_error');return res.status(error?.status||502).json({error:{message:error?.message||'Dify attachment processing failed',type:'dify_attachment_error',trace_id:traceId}});}
 }
 if(!result.ok){responseLocals(res).gatewayErrorType='dify_error';return res.status(result.status||502).json({error:{message:result.json?.message||result.raw||'Dify request failed',type:'dify_error',trace_id:traceId}});}
 const difyConversationId=result.json?.conversation_id||remote?.conversationId||'';if(difyConversationId)remote=conversationStore.set(dshConversationId,providerId,difyAppId,{conversationId:difyConversationId,valid:true,updatedAt:Date.now(),toolSchemaHash:schema.toolSchemaHash});
 let answer=String(result.json?.answer||''),toolCalls=parseToolCalls(answer);const emitted=[],replay=[];
 for(const c of toolCalls){const args=c.function?.arguments||'{}',entry=toolExecutionLedger.begin({providerId,conversationId:dshConversationId,toolCallId:c.id,arguments:args});trace({traceId,dshConversationId,providerId,difyConversationId,conversationState:resolved.state,toolSchemaHash:schema.toolSchemaHash,toolCallId:c.id,argumentsHash:entry.argumentsHash,toolExecutionStatus:entry.status,contextStrategy:resolved.contextStrategy});if(entry.replay)replay.push({call:c,result:entry.result});else if(!entry.duplicate)emitted.push(c);}
 if(replay.length&&!emitted.length){const replayQuery=replay.map(x=>`tool_result tool_call_id=${x.call.id}: ${x.result}`).join('\n');const continued=await callDify(config,{...makeBody(difyConversationId,'TOOL_CONTINUE'),query:replayQuery},[]);if(continued.ok){answer=String(continued.json?.answer||'');toolCalls=parseToolCalls(answer);for(const c of toolCalls){const e=toolExecutionLedger.begin({providerId,conversationId:dshConversationId,toolCallId:c.id,arguments:c.function?.arguments||'{}'});if(!e.duplicate)emitted.push(c);}}}
 send(res,data,openAIResponse(data,answer,emitted,traceId));
}
export default{handleRequest};
