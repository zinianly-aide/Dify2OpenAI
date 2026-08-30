import { BackendContextMode, BackendProviderType } from './backend-registry.js';

function authHeaders(backend, credentials = {}) {
  const token = credentials.apiKey || credentials.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonOrText(response) {
  const raw = await response.text();
  try { return { raw, json: JSON.parse(raw) }; } catch { return { raw, json: null }; }
}

function serializeMessage(message = {}) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return `assistant_tool_calls: ${JSON.stringify(message.tool_calls.map((call) => ({
      id: String(call.id || ''),
      name: String(call.function?.name || call.name || ''),
      arguments: call.function?.arguments ?? call.arguments ?? '{}',
    })))}`;
  }
  if (message.role === 'tool') {
    return `tool_result tool_call_id=${String(message.tool_call_id || '')}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')}`;
  }
  return `${String(message.role || 'user')}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')}`;
}

function difyToolInstruction(tools = []) {
  if (!tools.length) return '';
  return [
    'External tools available to the Gateway client:',
    JSON.stringify(tools),
    'If a tool is required, return ONLY JSON in this exact shape:',
    '{"tool_calls":[{"id":"stable-call-id","name":"tool_name","arguments":"{\\"key\\":\\"value\\"}"}]}',
    'arguments MUST be a JSON string and tool call ids must remain stable.',
  ].join('\n');
}

function parseDifyToolCalls(answer = '') {
  const raw = String(answer || '').trim();
  const candidates = [raw, raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed?.tool_calls)) continue;
      return parsed.tool_calls.map((call) => ({
        id: String(call.id || ''),
        type: 'function',
        function: {
          name: String(call.name || call.function?.name || ''),
          arguments: typeof (call.arguments ?? call.function?.arguments) === 'string'
            ? (call.arguments ?? call.function?.arguments)
            : JSON.stringify(call.arguments ?? call.function?.arguments ?? {}),
        },
      })).filter((call) => call.id && call.function.name);
    } catch {}
  }
  return [];
}

export class BackendExecutor {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('FETCH_IMPLEMENTATION_REQUIRED');
    this.fetch = fetchImpl;
  }

  async execute({ backend, credentials = {}, messages = [], tools = [], user, conversationId = '', stream = false, signal } = {}) {
    if (!backend) throw new Error('BACKEND_REQUIRED');
    if (backend.providerType === BackendProviderType.DIFY) {
      const parts = [];
      const toolInstruction = difyToolInstruction(tools);
      if (toolInstruction) parts.push(toolInstruction);
      parts.push(...messages.map(serializeMessage).filter(Boolean));
      const query = parts.join('\n\n');
      const response = await this.fetch(`${backend.baseUrl}/chat-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(backend, credentials) },
        body: JSON.stringify({ inputs: {}, query, response_mode: 'blocking', conversation_id: conversationId || '', user: String(user || 'gateway'), auto_generate_name: false }),
        signal,
      });
      const parsed = await jsonOrText(response);
      if (!response.ok) {
        const error = new Error(parsed.json?.message || parsed.raw || `Backend ${backend.backendId} failed`);
        error.status = response.status;
        error.code = response.status >= 500 ? 'BACKEND_5XX' : 'BACKEND_REQUEST_FAILED';
        throw error;
      }
      const answer = parsed.json?.answer ?? '';
      return Object.freeze({
        backendId: backend.backendId,
        answer,
        toolCalls: parseDifyToolCalls(answer),
        conversationId: parsed.json?.conversation_id ? String(parsed.json.conversation_id) : '',
        usage: parsed.json?.metadata?.usage || parsed.json?.usage,
        raw: parsed.json,
      });
    }

    if (backend.providerType === BackendProviderType.OPENAI_COMPATIBLE || backend.providerType === BackendProviderType.LOCAL_OPENAI_COMPATIBLE) {
      const response = await this.fetch(`${backend.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(backend, credentials) },
        body: JSON.stringify({ model: backend.model, messages, ...(tools.length ? { tools } : {}), stream: stream === true }),
        signal,
      });
      const parsed = await jsonOrText(response);
      if (!response.ok) {
        const error = new Error(parsed.json?.error?.message || parsed.raw || `Backend ${backend.backendId} failed`);
        error.status = response.status;
        error.code = response.status >= 500 ? 'BACKEND_5XX' : 'BACKEND_REQUEST_FAILED';
        throw error;
      }
      return Object.freeze({
        backendId: backend.backendId,
        answer: parsed.json?.choices?.[0]?.message?.content ?? '',
        toolCalls: parsed.json?.choices?.[0]?.message?.tool_calls || [],
        conversationId: '',
        usage: parsed.json?.usage,
        raw: parsed.json,
      });
    }

    throw new Error(`BACKEND_PROVIDER_UNSUPPORTED:${backend.providerType}`);
  }

  static isStateful(backend) {
    return backend?.capabilities?.contextMode === BackendContextMode.STATEFUL;
  }
}
