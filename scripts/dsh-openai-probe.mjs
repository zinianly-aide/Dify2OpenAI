import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.DSH_PROBE_PORT || 39123);
const output = process.env.DSH_PROBE_OUTPUT || '';
const marker = 'DSH_PLUGIN_E2E_OK';
const records = [];

function persist() {
  if (output) fs.writeFileSync(output, JSON.stringify(records, null, 2));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw); } catch {}

  const record = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  };
  records.push(record);
  persist();

  console.log(`DSH_PROBE_REQUEST ${JSON.stringify({
    index: records.length - 1,
    url: record.url,
    userAgent: record.headers['user-agent'] || null,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    bodyKeys: Object.keys(body).sort(),
    candidateHeaderKeys: Object.keys(record.headers).filter((key) => /session|conversation|dsh|request|trace/i.test(key)).sort(),
    candidateBodyKeys: Object.keys(body).filter((key) => /session|conversation|user|metadata|trace/i.test(key)).sort(),
  })}`);

  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || 'dify2openai-e2e';
  const first = {
    id: 'chatcmpl-dsh-probe',
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: null }],
  };
  const last = {
    id: 'chatcmpl-dsh-probe',
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  res.write(`data: ${JSON.stringify(last)}\n\n`);
  res.end('data: [DONE]\n\n');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`DSH_PROBE_READY http://127.0.0.1:${port}/v1`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
