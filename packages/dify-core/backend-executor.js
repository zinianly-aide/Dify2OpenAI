import { BackendContextMode, BackendProviderType } from './backend-registry.js';

function authHeaders(backend, credentials = {}) {
  const token = credentials.apiKey || credentials.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonOrText(response) {
  const raw = await response.text();
  try { return { raw, json: JSON.parse(raw) }; } catch { return { raw, json: null }; }
}

export class BackendExecutor {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('FETCH_IMPLEMENTATION_REQUIRED');
    this.fetch = fetchImpl;
  }

  async execute({ backend, credentials = {}, messages = [], tools = [], user, conversationId = '', stream = false, signal } = {}) {
    if (!backend) throw new Error('BACKEND_REQUIRED');
    if (backend.providerType === BackendProviderType.DIFY) {
      const query = messages.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')}`).join('\n\n');
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
      return Object.freeze({
        backendId: backend.backendId,
        answer: parsed.json?.answer ?? '',
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
