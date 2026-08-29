import fetch from 'node-fetch';
const { DIFY_API_URL, DIFY_API_KEY } = process.env;
if (!DIFY_API_URL || !DIFY_API_KEY) { console.log('integration: SKIP/BLOCKED - Dify environment not configured'); process.exit(0); }
const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), Number(process.env.DIFY_TIMEOUT || 30000));
try {
  const response = await fetch(`${DIFY_API_URL.replace(/\/$/,'')}/chat-messages`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${DIFY_API_KEY}`}, body:JSON.stringify({inputs:{},query:'Reply with exactly: integration-ok',response_mode:'blocking',conversation_id:'',user:process.env.DIFY_USER || 'dify2oai-integration',auto_generate_name:false}), signal:controller.signal });
  const text = await response.text();
  if (!response.ok) { console.log(`integration: FAIL - real Dify returned HTTP ${response.status}`); process.exitCode=1; }
  else { let body={}; try{body=JSON.parse(text)}catch{}; if(!body.conversation_id) { console.log('integration: FAIL - response missing conversation_id'); process.exitCode=1; } else console.log('integration: PASS - real Dify called successfully'); }
} catch (error) { console.log(`integration: FAIL - ${error.name || 'Error'}: ${error.message}`); process.exitCode=1; }
finally { clearTimeout(timeout); }
