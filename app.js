import express from "express";
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { log } from './config/logger.js';
import chatHandler from "./botType/chatHandler.js";
import dshChatHandler from "./botType/dshChatHandler.js";
import completionHandler from "./botType/completionHandler.js";
import workflowHandler from "./botType/workflowHandler.js";
import { logRequest, generateId } from "./botType/utils.js";
import { gatewayObserver } from './lib/gateway/gateway-observer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseConfig(authHeader, modelParam) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) throw new Error("Missing or invalid Authorization header");
  const token = authHeader.slice("Bearer ".length);
  const tokenParts = token.split("|");
  let config = {};
  if (tokenParts.length >= 3) {
    const [difyApiUrl, apiKey, botType, inputVariable, outputVariable, contextMode, contextRecentMessages, contextToolMaxChars] = tokenParts;
    config = { DIFY_API_URL:difyApiUrl, API_KEY:apiKey, BOT_TYPE:botType, INPUT_VARIABLE:inputVariable||"", OUTPUT_VARIABLE:outputVariable||"", CONTEXT_MODE:contextMode||"", CONTEXT_RECENT_MESSAGES:contextRecentMessages||"", CONTEXT_TOOL_MAX_CHARS:contextToolMaxChars||"" };
  } else {
    if (!modelParam) throw new Error("Missing model parameter");
    const modelParts = modelParam.split("|");
    if (modelParts[0] !== "dify" || modelParts.length < 3) throw new Error("Invalid model parameter format");
    if (token && !token.includes("http")) {
      const [, botType, difyApiUrl, inputVariable, outputVariable, contextMode, contextRecentMessages, contextToolMaxChars] = modelParts;
      config = { DIFY_API_URL:difyApiUrl, API_KEY:token.trim(), BOT_TYPE:botType, INPUT_VARIABLE:inputVariable||"", OUTPUT_VARIABLE:outputVariable||"", CONTEXT_MODE:contextMode||"", CONTEXT_RECENT_MESSAGES:contextRecentMessages||"", CONTEXT_TOOL_MAX_CHARS:contextToolMaxChars||"" };
    } else {
      const [, apiKey, botType, inputVariable, outputVariable, contextMode, contextRecentMessages, contextToolMaxChars] = modelParts;
      config = { DIFY_API_URL:token.trim(), API_KEY:apiKey, BOT_TYPE:botType, INPUT_VARIABLE:inputVariable||"", OUTPUT_VARIABLE:outputVariable||"", CONTEXT_MODE:contextMode||"", CONTEXT_RECENT_MESSAGES:contextRecentMessages||"", CONTEXT_TOOL_MAX_CHARS:contextToolMaxChars||"" };
    }
  }
  if (!config.DIFY_API_URL || !config.API_KEY || !config.BOT_TYPE) throw new Error("Missing required configuration parameters");
  return config;
}

function usesDshLifecycle(req) {
  return Boolean(
    req.headers['x-dsh-conversation-id'] ||
    req.headers['x-provider-id'] ||
    req.headers['x-dify-app-id'] ||
    req.headers['x-conversation-reset'] ||
    req.body?.dsh_conversation_id
  );
}

const app = express();
app.use((req,res,next)=>{ res.header("Access-Control-Allow-Origin","*"); res.header("Access-Control-Allow-Methods","GET, POST, PUT, DELETE, OPTIONS"); res.header("Access-Control-Allow-Headers","*"); if(req.method==="OPTIONS") return res.sendStatus(200); next(); });
app.use(express.static('public'));
app.use(express.json({limit:"100mb"}));
app.use(express.urlencoded({limit:"100mb",extended:true}));

app.get("/", (req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
app.get("/v1/models", (req,res)=>res.json({object:"list",data:[{id:"dify",object:"model",owned_by:"dify",permission:null,capabilities:{vision:true,file_processing:true,tools:true,conversation_lifecycle:true,context_compression:true}}]}));
app.get("/capabilities", (req,res)=>res.json({openai_compatible:true,chat_completions:true,tools:true,tool_call_id_correlation:true,provider_scoped_conversations:true,conversation_lifecycle_activation:"x-dsh-conversation-id",legacy_chat_fallback:true,conversation_states:["BOOTSTRAP","CONTINUE","TOOL_CONTINUE","RECOVER","RESET"],context_strategies:["FULL_BOOTSTRAP","DELTA_CONTINUE","TOOL_CONTINUE","RECOVERY_BOOTSTRAP"],tool_schema_hashing:"sha256",tool_execution_idempotency:true,decision_telemetry:true,decision_policy:"gateway-context-compression-v1",context_compression:true,context_compression_modes:["none","tool_prune","light","heavy"],context_compression_configurable:true,automatic_threshold_tuning:false,automatic_routing:false,automatic_optimization:false}));

app.post("/v1/chat/completions", async (req,res)=>{
  const requestId=generateId(); const startTime=Date.now(); logRequest(req,requestId);
  const authHeader=req.headers.authorization;
  if(!authHeader) return res.status(401).json({error:"Missing Authorization header"});
  try {
    const config=parseConfig(authHeader,req.body.model);
    gatewayObserver.observe(req,res,{
      traceId:requestId,
      providerId:String(req.headers['x-provider-id']||'dify'),
      difyApiUrl:config.DIFY_API_URL,
      model:req.body?.model,
    });
    if(config.BOT_TYPE==="Chat") {
      if(usesDshLifecycle(req)) await dshChatHandler.handleRequest(req,res,config,requestId,startTime);
      else await chatHandler.handleRequest(req,res,config,requestId,startTime);
    }
    else if(config.BOT_TYPE==="Completion") await completionHandler.handleRequest(req,res,config,requestId,startTime);
    else if(config.BOT_TYPE==="Workflow") await workflowHandler.handleRequest(req,res,config,requestId,startTime);
    else throw new Error("Invalid bot type in configuration.");
  } catch(error) {
    res.locals.gatewayErrorType=error?.name||'gateway_error';
    log("error","处理请求时发生错误",{requestId,error:{message:error.message,name:error.name}});
    if(!res.headersSent) res.status(500).json({error:error.message});
  }
});

const server=http.createServer(app);
server.listen(process.env.PORT||3099,()=>log('info','服务器启动成功',{port:process.env.PORT||3099,env:process.env.NODE_ENV||'development'}));