import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.FAKE_DIFY_PORT || 39124);
const output = process.env.FAKE_DIFY_OUTPUT || '/tmp/fake-dify-requests.json';
const marker = 'DSH_GATEWAY_E2E_OK';
const requests = [];
let sequence = 0;

function persist() {
  fs.writeFileSync(output, JSON.stringify(requests, null, 2));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/chat-messages') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw); } catch {}

  sequence += 1;
  const conversationId = body.conversation_id || `fake-dify-conv-${sequence}`;
  requests.push({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
    assignedConversationId: conversationId,
  });
  persist();

  console.log(`FAKE_DIFY_REQUEST ${JSON.stringify({
    index: requests.length - 1,
    conversationIdIn: body.conversation_id || '',
    conversationIdOut: conversationId,
    queryLength: typeof body.query === 'string' ? body.query.length : 0,
    hasToolInstructions: typeof body.query === 'string' && /tool|function/i.test(body.query),
    responseMode: body.response_mode,
  })}`);

  const createdAt = Math.floor(Date.now() / 1000);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.write(`data: ${JSON.stringify({
    event: 'message',
    answer: marker,
    conversation_id: conversationId,
    created_at: createdAt,
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    event: 'message_end',
    conversation_id: conversationId,
    created_at: createdAt,
    metadata: {
      usage: {
        prompt_tokens: 1,
        prompt_unit_price: '0',
        prompt_price_unit: '0.001',
        prompt_price: '0',
        completion_tokens: 1,
        completion_unit_price: '0',
        completion_price_unit: '0.001',
        completion_price: '0',
        total_tokens: 2,
        total_price: '0',
        currency: 'USD',
        latency: 0.001,
      },
    },
  })}\n\n`);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`FAKE_DIFY_READY http://127.0.0.1:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
