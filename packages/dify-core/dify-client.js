export class DifyHttpError extends Error {
  constructor(message, { status, body, requestId } = {}) {
    super(message);
    this.name = 'DifyHttpError';
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

function endpoint(baseURL) {
  return `${String(baseURL || '').replace(/\/+$/, '')}/chat-messages`;
}

function parseDataBlock(block) {
  const lines = block.split(/\r?\n/);
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { return { event: 'protocol_error', raw: data }; }
}

export async function* streamDifyChat({ baseURL, apiKey, body, signal, headers = {} }) {
  const response = await fetch(endpoint(baseURL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${apiKey}`,
      ...headers,
    },
    body: JSON.stringify({ ...body, response_mode: 'streaming' }),
    signal,
  });

  if (!response.ok) {
    const raw = await response.text();
    let message = raw || `Dify request failed with HTTP ${response.status}`;
    try { message = JSON.parse(raw)?.message || message; } catch {}
    throw new DifyHttpError(message, {
      status: response.status,
      body: raw,
      requestId: response.headers.get('x-request-id') || undefined,
    });
  }
  if (!response.body) throw new DifyHttpError('Dify response body is empty', { status: response.status });

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseDataBlock(block);
      if (event) yield event;
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, '\n');
  if (buffer.trim()) {
    const event = parseDataBlock(buffer);
    if (event) yield event;
  }
}

export function isInvalidConversationError(error) {
  return error instanceof DifyHttpError
    && (error.status === 400 || error.status === 404)
    && /conversation|not found|invalid/i.test(error.body || error.message || '');
}
