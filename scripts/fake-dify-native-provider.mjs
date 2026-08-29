import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.FAKE_DIFY_NATIVE_PORT || 39125);
const output = process.env.FAKE_DIFY_NATIVE_OUTPUT || '/tmp/fake-dify-native-requests.json';
const requests = [];

function persist() {
  fs.writeFileSync(output, JSON.stringify(requests, null, 2));
}

function sendEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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

  const index = requests.length;
  const conversationId = body.conversation_id || `native-conv-${String(index + 1).padStart(3, '0')}`;
  const record = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
    assignedConversationId: conversationId,
    sessionHashUser: body.user || '',
    hasToolSchema: /External tools available/.test(body.query || ''),
    hasToolResult: /tool_result tool_call_id=/.test(body.query || ''),
  };
  requests.push(record);
  persist();
  console.log('FAKE_DIFY_NATIVE_REQUEST', JSON.stringify({
    index,
    conversationIdIn: body.conversation_id || '',
    conversationIdOut: conversationId,
    sessionHashUser: record.sessionHashUser,
    hasToolSchema: record.hasToolSchema,
    hasToolResult: record.hasToolResult,
    queryLength: String(body.query || '').length,
  }));

  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  const createdAt = Math.floor(Date.now() / 1000);

  if (!record.hasToolResult && record.hasToolSchema) {
    sendEvent(res, {
      event: 'message',
      answer: JSON.stringify({
        tool_calls: [{
          id: 'call_native_001',
          name: 'bash',
          arguments: JSON.stringify({ command: 'printf DSH_NATIVE_TOOL_OK' }),
        }],
      }),
      conversation_id: conversationId,
      created_at: createdAt,
    });
  } else {
    sendEvent(res, {
      event: 'message',
      answer: 'DSH_NATIVE_PROVIDER_OK',
      conversation_id: conversationId,
      created_at: createdAt,
    });
  }

  sendEvent(res, {
    event: 'message_end',
    conversation_id: conversationId,
    created_at: createdAt,
    metadata: {
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  });
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`FAKE_DIFY_NATIVE_READY http://127.0.0.1:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
