import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import { ConversationState, resolveConversationState } from '../lib/conversation-manager.js';
import {
  checkpointManager,
  conversationStore,
  rotationRecommendationStore,
  toolSchemaRegistry,
  toolExecutionLedger,
} from '../lib/runtime.js';
import { sha256 } from '../lib/canonical.js';
import { currentImageAttachments, resolveDifyFiles } from '../lib/attachments.js';
import { backendContextReductionPct } from '../lib/backend-conversation-generation.js';
import {
  CheckpointRecommendation,
  DifyUsageExtractor,
  reconcileBackendContext,
} from '../lib/gateway/backend-context.js';
import { backendIdFromUrl } from '../lib/gateway/canonical.js';

const PROVIDER = 'dify';
const difyUsageExtractor = new DifyUsageExtractor();
const checkpointRecommendation = new CheckpointRecommendation();
const textOf = (m) => typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.filter(x=>x?.type==='text').map(x=>x.text||'').join('\n') : '';
const dshIdOf = (req) => String(req.headers['x-dsh-conversation-id'] || req.headers['x-session-id'] || req.body?.user || 'default');
const appIdOf = (req, config) => String(req.headers['x-dify-app-id'] || req.body?.dify_app_id || sha256(config.API_KEY || config.DIFY_API_URL).slice(0,16));
const resetOf = (req) => req.headers['x-conversation-reset'] === 'true' || req.body?.reset === true;
const responseLocals = (res) => res.locals ??= {};
const conversationHash = (value) => value ? sha256(`conversation:${String(value)}`).slice(0,24) : undefined;
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
function ledgerInput(providerId,appId,sessionId,call){return{providerId,appId,sessionId,toolCallId:call.id,arguments:call.function?.arguments||'{}'};}
function recordIncomingToolResults(providerId,appId,dshConversationId,messages){const{calls,results}=extractToolInfo(messages);for(const r of results){const c=calls.get(r.tool_call_id);if(!c)continue;toolExecutionLedger.complete(ledgerInput(providerId,appId,dshConversationId,c),textOf(r));}}
const isInvalidConversation=(status,body)=>[400,404].includes(status)&&/conversation|not found|invalid/i.test(body||'');
async function callDify(config,body,attachments=[]){
 const files=await resolveDifyFiles({baseURL:config.DIFY_API_URL,apiKey:config.API_KEY,attachments,user:body.user});
 const payload=files.length?{...body,files}:body;
 const resp=await fetch(`${config.DIFY_API_URL}/chat-messages`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.API_KEY}`},body:JSON.stringify(payload)});
 const raw=await resp.text();let json=null;try{json=JSON.parse(raw)}catch{}return{ok:resp.ok,status:resp.status,raw,json};
}
function openAIResponse(data,answer,toolCalls,traceId,backendUsage){
 const usage = backendUsage?.backendPromptTokens === undefined && backendUsage?.backendCompletionTokens === undefined
   ? undefined
   : {
       prompt_tokens: backendUsage?.backendPromptTokens ?? 0,
       completion_tokens: backendUsage?.backendCompletionTokens ?? 0,
       total_tokens: (backendUsage?.backendPromptTokens ?? 0) + (backendUsage?.backendCompletionTokens ?? 0),
     };
 return{id:`chatcmpl-${traceId}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:data.model||'dify',choices:[{index:0,message:{role:'assistant',content:toolCalls.length?null:answer,...(toolCalls.length?{tool_calls:toolCalls}:{})},finish_reason:toolCalls.length?'tool_calls':'stop'}],...(usage?{usage}:{})};
}
function send(res,data,payload){if(!data.stream)return res.json(payload);res.setHeader('Content-Type','text/event-stream');const msg=payload.choices[0].message;res.write(`data: ${JSON.stringify({id:payload.id,object:'chat.completion.chunk',created:payload.created,model:payload.model,choices:[{index:0,delta:{role:'assistant',...(msg.content?{content:msg.content}:{}),...(msg.tool_calls?{tool_calls:msg.tool_calls.map((x,index)=>({index,...x}))}:{})},finish_reason:payload.choices[0].finish_reason}]})}\n\n`);res.end('data: [DONE]\n\n');}

async function handleRequest(req,res,config){
 const data=req.body||{},messages=Array.isArray(data.messages)?data.messages:[],authoritativeMessages=Array.isArray(res.locals?.gatewayOriginalMessages)?res.locals.gatewayOriginalMessages:messages,traceId=randomUUID(),dshConversationId=dshIdOf(req),providerId=String(req.headers['x-provider-id']||PROVIDER),difyAppId=appIdOf(req,config),backendId=String(res.locals?.gatewayBackendId||backendIdFromUrl(config.DIFY_API_URL)),currentAttachments=currentImageAttachments(authoritativeMessages,'openai'),compressionResult=res.locals?.gatewayCompressionResult;
 if(resetOf(req)){conversationStore.resetProvider(dshConversationId,providerId,difyAppId,backendId);rotationRecommendationStore.clear(dshConversationId,backendId,providerId,difyAppId);trace({traceId,dshConversationId,providerId,difyAppId,backendId,conversationState:'RESET',contextStrategy:'FULL_BOOTSTRAP'});}
 let remote=conversationStore.get(dshConversationId,providerId,difyAppId,backendId),resolved=resolveConversationState({remoteState:remote,messages:authoritativeMessages,reset:false});
 const schema=toolSchemaRegistry.resolve({dshConversationId,providerId,difyAppId,tools:data.tools||[]});recordIncomingToolResults(providerId,difyAppId,dshConversationId,authoritativeMessages);
 const buildQuery=(strategy,sourceMessages=messages)=>{let q=strategy==='DELTA_CONTINUE'?deltaHistory(sourceMessages):strategy==='TOOL_CONTINUE'?toolContinuation(sourceMessages):fullHistory(sourceMessages);if(schema.changed&&data.tools?.length)q=`${schemaPrompt(data.tools)}\n\n${q}`;return q;};
 const makeBody=(conversationId,strategy,sourceMessages=messages)=>({inputs:{},query:buildQuery(strategy,sourceMessages),response_mode:'blocking',conversation_id:conversationId||'',user:String(data.user||dshConversationId),auto_generate_name:false});
 const locals=responseLocals(res);
 const pendingRecommendation=rotationRecommendationStore.get(dshConversationId,backendId,providerId,difyAppId);
 const currentRecommendation=checkpointRecommendation.recommend({compressionResult,reconciliation:undefined});
 const rotationReasons=[...new Set([...(pendingRecommendation?.reasonCodes||[]),...(currentRecommendation.recommended?currentRecommendation.reasonCodes:[])])];
 const shouldRotate=Boolean(remote&&rotationReasons.length);
 let result;
 let rotationTarget;
 let rotationCheckpoint;
 let rotationSucceeded=false;

 if(shouldRotate){
   const checkpointResult=checkpointManager.create({
     sessionId:dshConversationId,backendId,providerId,appId:difyAppId,sourceGeneration:remote.generation,contextVersion:(remote.contextVersion||remote.generation||1)+1,messages:authoritativeMessages,compressedMessages:messages,system:data.system,tools:data.tools||[],compressionResult,reasonCodes:rotationReasons,
   });
   locals.gatewayCheckpointRecommendation={recommended:true,reasonCodes:rotationReasons};
   if(checkpointResult.deferred){
     locals.gatewayRotation={checkpointCreated:false,sourceGeneration:remote.generation,targetGeneration:null,rotationStarted:false,rotationSuccess:false,rotationFailureReason:'ROTATION_DEFERRED_PENDING_TOOL',checkpointBeforeTokens:compressionResult?.beforeTokens??null,checkpointAfterTokens:compressionResult?.afterTokens??null,oldConversationIdHash:conversationHash(remote.conversationId)};
     trace({traceId,dshConversationId,providerId,difyAppId,backendId,conversationState:ConversationState.CHECKPOINT,sourceGeneration:remote.generation,rotationStarted:false,rotationDeferred:true,reasonCode:'ROTATION_DEFERRED_PENDING_TOOL'});
   }else if(checkpointResult.created){
     rotationCheckpoint=checkpointResult.checkpoint;
     rotationTarget=conversationStore.createNextGeneration({dshConversationId,providerId,difyAppId,backendId,checkpointId:rotationCheckpoint.checkpointId,contextVersion:rotationCheckpoint.contextVersion});
     resolved=resolveConversationState({remoteState:remote,messages:authoritativeMessages,rotating:true});
     locals.gatewayRotation={checkpointCreated:true,sourceGeneration:remote.generation,targetGeneration:rotationTarget.generation,rotationStarted:true,rotationSuccess:false,checkpointBeforeTokens:rotationCheckpoint.estimatedTokensBefore,checkpointAfterTokens:rotationCheckpoint.estimatedTokensAfter,oldConversationIdHash:conversationHash(remote.conversationId)};
     trace({traceId,dshConversationId,providerId,difyAppId,backendId,conversationState:ConversationState.ROTATE_BOOTSTRAP,sourceGeneration:remote.generation,targetGeneration:rotationTarget.generation,checkpointCreated:true,rotationStarted:true,contextStrategy:resolved.contextStrategy});
     const bootstrapMessages=checkpointManager.builder.bootstrapMessages(rotationCheckpoint);
     try{result=await callDify(config,makeBody('',resolved.contextStrategy,bootstrapMessages),currentAttachments);}
     catch(error){conversationStore.invalidateGeneration({dshConversationId,providerId,difyAppId,backendId,generation:rotationTarget.generation,reason:error?.code||'ROTATION_BOOTSTRAP_ERROR'});locals.gatewayRotation={...locals.gatewayRotation,rotationFailureReason:String(error?.code||'ROTATION_BOOTSTRAP_ERROR').slice(0,160)};locals.gatewayErrorType=String(error?.code||'dify_attachment_error');return res.status(error?.status||502).json({error:{message:error?.message||'Dify rotation bootstrap failed',type:'dify_rotation_error',trace_id:traceId}});}
     if(!result.ok){conversationStore.invalidateGeneration({dshConversationId,providerId,difyAppId,backendId,generation:rotationTarget.generation,reason:`HTTP_${result.status}`});locals.gatewayRotation={...locals.gatewayRotation,rotationFailureReason:`HTTP_${result.status}`};locals.gatewayErrorType='dify_rotation_error';return res.status(result.status||502).json({error:{message:result.json?.message||result.raw||'Dify rotation bootstrap failed',type:'dify_rotation_error',trace_id:traceId}});}
     const newConversationId=String(result.json?.conversation_id||'');
     if(!newConversationId){conversationStore.invalidateGeneration({dshConversationId,providerId,difyAppId,backendId,generation:rotationTarget.generation,reason:'ROTATION_MISSING_CONVERSATION_ID'});locals.gatewayRotation={...locals.gatewayRotation,rotationFailureReason:'ROTATION_MISSING_CONVERSATION_ID'};locals.gatewayErrorType='dify_rotation_missing_conversation_id';return res.status(502).json({error:{message:'Dify rotation bootstrap did not return conversation_id',type:'dify_rotation_error',trace_id:traceId}});}
     const rotationUsage=difyUsageExtractor.extract(result.json)||undefined;
     const reduction=backendContextReductionPct(remote.lastBackendPromptTokens,rotationUsage?.backendPromptTokens);
     remote=conversationStore.activateGeneration({dshConversationId,providerId,difyAppId,backendId,generation:rotationTarget.generation,conversationId:newConversationId,extra:{toolSchemaHash:schema.toolSchemaHash,...(rotationUsage?.backendPromptTokens===undefined?{}:{lastBackendPromptTokens:rotationUsage.backendPromptTokens})}});
     rotationRecommendationStore.clear(dshConversationId,backendId,providerId,difyAppId);
     locals.gatewayRotation={...locals.gatewayRotation,rotationSuccess:true,newConversationIdHash:conversationHash(newConversationId),...(reduction===undefined?{}:{backendContextReductionPct:reduction})};
     rotationSucceeded=true;
     trace({traceId,dshConversationId,providerId,difyAppId,backendId,conversationState:ConversationState.ROTATE,sourceGeneration:rotationCheckpoint.sourceGeneration,targetGeneration:rotationTarget.generation,rotationSuccess:true,oldConversationIdHash:locals.gatewayRotation.oldConversationIdHash,newConversationIdHash:locals.gatewayRotation.newConversationIdHash,...(reduction===undefined?{}:{backendContextReductionPct:reduction})});
   }
 }

 if(!rotationSucceeded){
   remote=conversationStore.get(dshConversationId,providerId,difyAppId,backendId);
   resolved=resolveConversationState({remoteState:remote,messages:authoritativeMessages,reset:false});
   trace({traceId,dshConversationId,providerId,difyAppId,backendId,difyConversationId:remote?.conversationId?'***':'',sourceGeneration:remote?.generation||null,conversationState:resolved.state,attachmentCount:currentAttachments.length,toolSchemaHash:schema.toolSchemaHash,contextStrategy:resolved.contextStrategy,event:schema.traceEvent});
   try{result=await callDify(config,makeBody(remote?.conversationId,resolved.contextStrategy),currentAttachments);}
   catch(error){locals.gatewayErrorType=String(error?.code||'dify_attachment_error');return res.status(error?.status||502).json({error:{message:error?.message||'Dify attachment processing failed',type:'dify_attachment_error',trace_id:traceId}});}
   if(!result.ok&&remote?.conversationId&&isInvalidConversation(result.status,result.raw)){
     conversationStore.invalidate(dshConversationId,providerId,difyAppId,backendId);
     resolved=resolveConversationState({remoteState:{...remote,valid:false},messages:authoritativeMessages,remoteInvalid:true});
     trace({traceId,dshConversationId,providerId,difyAppId,backendId,difyConversationId:'***',conversationState:ConversationState.RECOVER,sourceGeneration:remote.generation,attachmentCount:currentAttachments.length,toolSchemaHash:schema.toolSchemaHash,contextStrategy:resolved.contextStrategy});
     locals.gatewayRetryCount=Number(locals.gatewayRetryCount||0)+1;
     try{result=await callDify(config,makeBody('',resolved.contextStrategy),currentAttachments);}
     catch(error){locals.gatewayErrorType=String(error?.code||'dify_attachment_error');return res.status(error?.status||502).json({error:{message:error?.message||'Dify attachment processing failed',type:'dify_attachment_error',trace_id:traceId}});}
     if(result.ok&&result.json?.conversation_id){
       remote=conversationStore.set(dshConversationId,providerId,difyAppId,{backendId,conversationId:String(result.json.conversation_id),valid:true,updatedAt:Date.now(),toolSchemaHash:schema.toolSchemaHash});
     }
   }
 }
 if(!result.ok){locals.gatewayErrorType='dify_error';return res.status(result.status||502).json({error:{message:result.json?.message||result.raw||'Dify request failed',type:'dify_error',trace_id:traceId}});}
 const backendUsage=difyUsageExtractor.extract(result.json)||undefined;
 if(backendUsage)locals.gatewayBackendUsage=backendUsage;
 const difyConversationId=String(result.json?.conversation_id||remote?.conversationId||'');
 if(!rotationSucceeded&&difyConversationId){remote=conversationStore.set(dshConversationId,providerId,difyAppId,{backendId,conversationId:difyConversationId,valid:true,updatedAt:Date.now(),toolSchemaHash:schema.toolSchemaHash,...(backendUsage?.backendPromptTokens===undefined?{}:{lastBackendPromptTokens:backendUsage.backendPromptTokens})});}
 const reconciliation=reconcileBackendContext({gatewayEstimatedInputTokens:compressionResult?.beforeTokens,gatewayCompressedTokens:compressionResult?.afterTokens,backendPromptTokens:backendUsage?.backendPromptTokens,backendCompletionTokens:backendUsage?.backendCompletionTokens});
 const nextRecommendation=checkpointRecommendation.recommend({compressionResult,reconciliation});
 locals.gatewayCheckpointRecommendation=nextRecommendation;
 if(nextRecommendation.recommended&&!rotationSucceeded)rotationRecommendationStore.set(dshConversationId,backendId,providerId,difyAppId,nextRecommendation);
 if(!nextRecommendation.recommended&&rotationSucceeded)rotationRecommendationStore.clear(dshConversationId,backendId,providerId,difyAppId);
 let answer=String(result.json?.answer||''),toolCalls=parseToolCalls(answer);const emitted=[],replay=[];
 for(const c of toolCalls){const entry=toolExecutionLedger.begin(ledgerInput(providerId,difyAppId,dshConversationId,c));trace({traceId,dshConversationId,providerId,backendId,difyConversationIdHash:conversationHash(difyConversationId),sourceGeneration:remote?.generation||null,conversationState:resolved.state,toolSchemaHash:schema.toolSchemaHash,toolCallId:c.id,argumentsHash:entry.argumentsHash,toolExecutionStatus:entry.status,contextStrategy:resolved.contextStrategy});if(entry.replay)replay.push({call:c,result:entry.result});else if(!entry.duplicate)emitted.push(c);}
 if(replay.length&&!emitted.length){const replayQuery=replay.map(x=>`tool_result tool_call_id=${x.call.id}: ${x.result}`).join('\n');const continued=await callDify(config,{...makeBody(difyConversationId,'TOOL_CONTINUE'),query:replayQuery},[]);if(continued.ok){const replayUsage=difyUsageExtractor.extract(continued.json);if(replayUsage)locals.gatewayBackendUsage=replayUsage;answer=String(continued.json?.answer||'');toolCalls=parseToolCalls(answer);for(const c of toolCalls){const e=toolExecutionLedger.begin(ledgerInput(providerId,difyAppId,dshConversationId,c));if(!e.duplicate)emitted.push(c);}}}
 send(res,data,openAIResponse(data,answer,emitted,traceId,locals.gatewayBackendUsage));
}
export default{handleRequest};
