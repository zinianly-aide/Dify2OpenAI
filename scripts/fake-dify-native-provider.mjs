import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.FAKE_DIFY_NATIVE_PORT || 39125);
const output = process.env.FAKE_DIFY_NATIVE_OUTPUT || '/tmp/fake-dify-native-requests.json';
const uploadOutput = process.env.FAKE_DIFY_NATIVE_UPLOAD_OUTPUT || '/tmp/fake-dify-native-uploads.json';
const imageE2E = process.env.FAKE_DIFY_NATIVE_IMAGE_E2E === '1';
const imagePath = process.env.FAKE_DIFY_NATIVE_IMAGE_PATH || '/tmp/dsh-native-read-image.png';
const requests = [];
const uploads = [];

function persist() {
  fs.writeFileSync(output, JSON.stringify(requests, null, 2));
  fs.writeFileSync(uploadOutput, JSON.stringify(uploads, null, 2));
}

function sendEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function toolResultPayloadLength(query) {
  const match = String(query || '').match(/tool_result tool_call_id=[^:]+:\s*([\s\S]*)$/);
  return match ? match[1].trim().length : 0;
}

function sanitizedHeaders(headers) {
  const out = { ...headers };
  if (out.authorization) out.authorization = '***';
  if (out.cookie) out.cookie = '***';
  return out;
}

function toolsFromQuery(query) {
  const text = String(query || '');
  const prefix = 'External tools available to the DSH client:\n';
  const suffix = '\nIf a tool is required, return ONLY JSON in this exact shape:';
  const start = text.indexOf(prefix);
  if (start < 0) return [];
  const end = text.indexOf(suffix, start + prefix.length);
  if (end < 0) return [];
  try {
    const parsed = JSON.parse(text.slice(start + prefix.length, end));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toolName(tool) {
  return String(tool?.name || tool?.function?.name || '');
}

function imageToolCall(query) {
  const tools = toolsFromQuery(query);
  const readImage = tools.find((tool) => toolName(tool) === 'read_image');
  if (!readImage) return null;
  return {
    id: 'call_native_001',
    name: 'read_image',
    arguments: JSON.stringify({ file_path: imagePath }),
  };
}

function fileIds(body) {
  return Array.isArray(body?.files)
    ? body.files.map((file) => String(file?.upload_file_id || file?.url || '')).filter(Boolean)
    : [];
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/files/upload') {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const id = `native-upload-${String(uploads.length + 1).padStart(3, '0')}`;
    const authorizationPresent = /^Bearer\s+\S+$/i.test(String(req.headers.authorization || ''));
    uploads.push({
      id,
      authorizationPresent,
      contentType: String(req.headers['content-type'] || ''),
      contentLength: raw.length,
      hasMultipartFile: /name="file"/i.test(raw.toString('latin1')),
      hasMultipartUser: /name="user"/i.test(raw.toString('latin1')),
    });
    persist();
    console.log('FAKE_DIFY_NATIVE_UPLOAD', JSON.stringify({
      id,
      authorizationPresent,
      contentLength: raw.length,
      hasMultipartFile: true,
    }));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/chat-messages') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw); } catch {}

  const authorizationPresent = /^Bearer\s+\S+$/i.test(String(req.headers.authorization || ''));
  const index = requests.length;
  const conversationId = body.conversation_id || `native-conv-${String(index + 1).padStart(3, '0')}`;
  const record = {
    method: req.method,
    url: req.url,
    headers: sanitizedHeaders(req.headers),
    authorizationPresent,
    body,
    assignedConversationId: conversationId,
    sessionHashUser: body.user || '',
    hasToolSchema: /External tools available/.test(body.query || ''),
    hasToolResult: /tool_result tool_call_id=/.test(body.query || ''),
    toolResultPayloadLength: toolResultPayloadLength(body.query),
    fileCount: Array.isArray(body.files) ? body.files.length : 0,
    fileIds: fileIds(body),
  };
  requests.push(record);
  persist();
  console.log('FAKE_DIFY_NATIVE_REQUEST', JSON.stringify({
    index,
    conversationIdIn: body.conversation_id || '',
    conversationIdOut: conversationId,
    sessionHashUser: record.sessionHashUser,
    authorizationPresent,
    hasToolSchema: record.hasToolSchema,
    hasToolResult: record.hasToolResult,
    toolResultPayloadLength: record.toolResultPayloadLength,
    fileCount: record.fileCount,
    queryLength: String(body.query || '').length,
  }));

  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  const createdAt = Math.floor(Date.now() / 1000);

  if (!record.hasToolResult && record.hasToolSchema) {
    const imageCall = imageE2E ? imageToolCall(body.query) : null;
    if (imageE2E && !imageCall) {
      sendEvent(res, {
        event: 'error',
        code: 'READ_IMAGE_TOOL_MISSING',
        message: 'real DSH request did not expose read_image',
        conversation_id: conversationId,
        created_at: createdAt,
      });
    } else {
      sendEvent(res, {
        event: 'message',
        answer: JSON.stringify({
          tool_calls: [imageCall || {
            id: 'call_native_001',
            name: 'bash',
            arguments: JSON.stringify({ command: 'printf DSH_NATIVE_TOOL_OK' }),
          }],
        }),
        conversation_id: conversationId,
        created_at: createdAt,
      });
    }
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
  persist();
  console.log(`FAKE_DIFY_NATIVE_READY http://127.0.0.1:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
