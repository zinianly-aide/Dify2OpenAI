import { performance } from 'node:perf_hooks';
import { CanonicalRequest, CanonicalResponse, backendIdFromUrl } from './canonical.js';
import { ContextProfiler } from './context-profiler.js';
import { DecisionEngine } from './decision-engine.js';
import { CompressionPolicy, compressionConfigFromEnv } from './compression-policy.js';
import { ContextCompressor } from './context-compressor.js';
import { CompressionQualityGuard, compressionQualityConfigFromEnv } from './compression-quality-guard.js';
import { BackendUsageExtractor, CheckpointRecommendation, checkpointRecommendationConfigFromEnv, reconcileBackendContext } from './backend-context.js';
import { TelemetryCollector } from './telemetry-collector.js';
import { getPolicyRuntime } from '../policy-runtime.js';

function numeric(value){const n=Number(value);return Number.isFinite(n)&&n>0?n:undefined;}
function nonNegative(value){const n=Number(value);return Number.isFinite(n)&&n>=0?n:undefined;}
function contextWindowOf(req){return numeric(req.headers?.['x-context-window'])||numeric(req.body?.context_window)||numeric(process.env.GATEWAY_CONTEXT_WINDOW);}
function contentCharsFromPayload(payload){let chars=0;for(const choice of Array.isArray(payload?.choices)?payload.choices:[]){const content=choice?.delta?.content??choice?.message?.content??choice?.text;if(typeof content==='string')chars+=content.length;const calls=choice?.delta?.tool_calls??choice?.message?.tool_calls;if(Array.isArray(calls))for(const call of calls)chars+=String(call?.function?.arguments||'').length;}return chars;}
function inspectPayload(payload,state,usageExtractor,backendType){if(!payload||typeof payload!=='object')return;const usage=usageExtractor.extract(payload,backendType);if(usage?.backendPromptTokens!==undefined)state.backendPromptTokens=usage.backendPromptTokens;if(usage?.backendCompletionTokens!==undefined)state.backendCompletionTokens=usage.backendCompletionTokens;state.completionChars+=contentCharsFromPayload(payload);}
function inspectSseChunk(chunk,state,usageExtractor,backendType){const text=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk??'');for(const line of text.split(/\r?\n/)){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;try{inspectPayload(JSON.parse(data),state,usageExtractor,backendType);}catch{}}}

export class GatewayObserver{
  constructor(options={}){
    const compressionConfig=options.compressionConfig||compressionConfigFromEnv(),checkpointConfig=options.checkpointRecommendationConfig||checkpointRecommendationConfigFromEnv(),compressionPolicy=options.compressionPolicy||new CompressionPolicy(compressionConfig);
    this.baseCompressionConfig=Object.freeze({...compressionConfig});this.baseCheckpointConfig=Object.freeze({...checkpointConfig});this.profiler=options.profiler||new ContextProfiler();this.decisionEngine=options.decisionEngine||new DecisionEngine({compressionPolicy});this.compressor=options.compressor||new ContextCompressor({policy:compressionPolicy});this.qualityGuard=options.qualityGuard||new CompressionQualityGuard({config:options.compressionQualityConfig||compressionQualityConfigFromEnv()});this.usageExtractor=options.usageExtractor||new BackendUsageExtractor();this.checkpointRecommendation=options.checkpointRecommendation||new CheckpointRecommendation({config:checkpointConfig});this.telemetry=options.telemetry||new TelemetryCollector();
  }

  observe(req,res,routing={}){
    const startedAt=performance.now(),backendId=routing.backendId||backendIdFromUrl(routing.difyApiUrl),backendType=routing.backendType||'generic-openai',originalMessages=Array.isArray(req.body?.messages)?req.body.messages:[],policySelection=res.locals?.gatewayPolicySelection||null,policyConfig=policySelection?.config||{},selectedPolicyVersion=policySelection?.selectedPolicyVersion;
    const dynamicCompressionPolicy=policySelection?new CompressionPolicy({...this.baseCompressionConfig,...(policyConfig.compression||{})}):null;
    const decisionEngine=dynamicCompressionPolicy?new DecisionEngine({compressionPolicy:dynamicCompressionPolicy,policyVersion:selectedPolicyVersion}):this.decisionEngine,compressor=dynamicCompressionPolicy?new ContextCompressor({policy:dynamicCompressionPolicy}):this.compressor,checkpointRecommendation=policySelection?new CheckpointRecommendation({config:{...this.baseCheckpointConfig,...(policyConfig.checkpoint||{})}}):this.checkpointRecommendation;
    const canonicalRequest=CanonicalRequest.fromExpress(req,{traceId:routing.traceId,providerId:routing.providerId||req.headers?.['x-provider-id']||'dify',backendId,contextWindow:routing.contextWindow||contextWindowOf(req),policyVersion:selectedPolicyVersion||decisionEngine.policyVersion});
    const initialProfile=this.profiler.profile(canonicalRequest),decision=decisionEngine.decide(canonicalRequest,initialProfile,{backendId,model:routing.model||canonicalRequest.model}),guarded=this.qualityGuard.run({messages:originalMessages,tools:req.body?.tools,system:req.body?.system,initialProfile,compressor,profiler:this.profiler});
    if(req.body&&Array.isArray(req.body.messages)&&guarded.messages!==req.body.messages)req.body.messages=guarded.messages;res.locals??={};res.locals.gatewayOriginalMessages=originalMessages;res.locals.gatewayCompressionResult=guarded.result;res.locals.gatewayBackendId=backendId;
    const state={completionChars:0,backendPromptTokens:undefined,backendCompletionTokens:undefined,firstTokenAt:undefined,finalized:false},markFirst=()=>{if(state.firstTokenAt===undefined)state.firstTokenAt=performance.now();},originalWrite=res.write.bind(res),originalJson=res.json.bind(res);
    res.write=(chunk,...args)=>{if(chunk!==undefined&&chunk!==null&&String(chunk).length>0)markFirst();inspectSseChunk(chunk,state,this.usageExtractor,backendType);return originalWrite(chunk,...args);};
    res.json=(payload)=>{markFirst();inspectPayload(payload,state,this.usageExtractor,backendType);return originalJson(payload);};

    const blockCanarySafely=(reasonCode)=>{try{const runtime=getPolicyRuntime();const selected=res.locals?.gatewayPolicySelection;if(runtime&&selected?.policyAssignment==='CANARY')runtime.controlPlane.blockCanaryPolicy(selected.selectedPolicyVersion,[reasonCode]);}catch{}};
    const finalize=()=>{
      if(state.finalized)return;state.finalized=true;
      const latencyMs=Math.max(0,Math.round(performance.now()-startedAt)),firstTokenLatencyMs=state.firstTokenAt===undefined?undefined:Math.max(0,Math.round(state.firstTokenAt-startedAt)),explicit=res.locals?.gatewayBackendUsage||{},backendPromptTokens=nonNegative(explicit.backendPromptTokens)??state.backendPromptTokens,backendCompletionTokens=nonNegative(explicit.backendCompletionTokens)??state.backendCompletionTokens,completionTokens=backendCompletionTokens??Math.ceil(state.completionChars/4),success=res.statusCode>=200&&res.statusCode<400;
      const reconciliation=reconcileBackendContext({gatewayEstimatedInputTokens:canonicalRequest.estimatedPromptTokens,gatewayCompressedTokens:guarded.result.afterTokens,backendPromptTokens,backendCompletionTokens,backendContextWindow:routing.backendContextWindow}),computedCheckpoint=checkpointRecommendation.recommend({compressionResult:guarded.result,reconciliation}),checkpoint=res.locals?.gatewayCheckpointRecommendation||computedCheckpoint;
      const response=new CanonicalResponse({traceId:canonicalRequest.traceId,success,latencyMs,...(firstTokenLatencyMs===undefined?{}:{firstTokenLatencyMs}),...(backendPromptTokens===undefined?{}:{promptTokens:backendPromptTokens,backendPromptTokens}),...(backendCompletionTokens===undefined?{}:{backendCompletionTokens}),completionTokens,retryCount:Number(res.locals?.gatewayRetryCount||0),compressionResult:res.locals?.gatewayCompressionResult,backendReconciliation:reconciliation,checkpointRecommendation:checkpoint,rotation:res.locals?.gatewayRotation,routing:res.locals?.gatewayRouting,migration:res.locals?.gatewayMigration,backendHealth:res.locals?.gatewayBackendHealth,toolOptimization:res.locals?.gatewayToolOptimization,policySelection:res.locals?.gatewayPolicySelection,guardrail:res.locals?.gatewayGuardrail,promotion:res.locals?.gatewayPromotion,rollback:res.locals?.gatewayRollback,...(success?{}:{errorType:String(res.locals?.gatewayErrorType||`http_${res.statusCode}`)})});
      let collected;
      try{collected=this.telemetry.collect(canonicalRequest,decision,response);}catch{blockCanarySafely('TELEMETRY_UNAVAILABLE');return;}
      try{
        const runtime=getPolicyRuntime(),selected=res.locals?.gatewayPolicySelection;
        if(runtime&&selected?.selectedPolicyVersion)runtime.monitor.record({timestamp:collected.telemetry.timestamp,policyVersion:selected.selectedPolicyVersion,success,backendPromptTokens,completionTokens,estimatedCost:collected.telemetry.estimatedCost,contextWindow:canonicalRequest.contextWindow,contextOverflow:Boolean(canonicalRequest.contextWindow&&backendPromptTokens!==undefined&&backendPromptTokens>canonicalRequest.contextWindow),forcedCompression:guarded.result?.forced===true||guarded.result?.mode==='force',compressionMode:guarded.result?.mode,checkpointCreated:res.locals?.gatewayRotation?.checkpointCreated===true,toolRequest:canonicalRequest.toolCount>0,toolSuccessRate:response.toolSuccessRate??null,toolRecoveryTriggered:res.locals?.gatewayToolOptimization?.recoveryTriggered===true,fallbackUsed:res.locals?.gatewayRouting?.fallbackUsed===true,latencyMs,firstTokenLatencyMs,capabilityViolationCount:Number(res.locals?.gatewayCapabilityViolationCount||0),unsupportedDecisionCount:Number(res.locals?.gatewayUnsupportedDecisionCount||0),policyValidationFailure:false,routingDrift:Boolean(res.locals?.gatewayRoutingDrift)});
      }catch{blockCanarySafely('TELEMETRY_UNAVAILABLE');}
    };
    res.once('finish',finalize);res.once('close',finalize);
    return{canonicalRequest,profile:initialProfile,finalProfile:guarded.profile,compressionPasses:guarded.passes,decision,compressionResult:guarded.result};
  }
}
export const gatewayObserver=new GatewayObserver();
