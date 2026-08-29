import { sha256 } from '../canonical.js';

const POLICY_VERSION = 'gateway-static-v1';

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return String(part.text || '');
    if (part.type === 'tool-result') return '[tool-result]';
    if (part.type === 'image' || part.type === 'image_url') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

export function estimateTokens(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.max(0, Math.ceil(text.length / 4));
}

export function detectClientType(req) {
  const explicit = String(req.headers?.['x-client-type'] || '').trim().toLowerCase();
  if (explicit) return explicit;
  const ua = String(req.headers?.['user-agent'] || '').toLowerCase();
  const candidates = [
    ['codex', /\bcodex\b/],
    ['opencode', /\bopencode\b/],
    ['cline', /\bcline\b/],
    ['reasonix', /\breasonix\b/],
    ['dsh', /deepseek|\bdsh\b|harness/],
  ];
  for (const [name, pattern] of candidates) if (pattern.test(ua)) return name;
  if (req.headers?.['x-dsh-conversation-id'] || req.body?.dsh_conversation_id) return 'dsh';
  return 'openai-compatible';
}

export function hashSessionId(req) {
  const raw = req.headers?.['x-dsh-conversation-id']
    || req.headers?.['x-session-id']
    || req.body?.dsh_conversation_id
    || req.body?.session_id
    || req.body?.user;
  if (raw === undefined || raw === null || String(raw) === '') return undefined;
  return sha256(`session:${String(raw)}`).slice(0, 24);
}

export function safeModelName(model) {
  if (typeof model !== 'string' || !model) return undefined;
  if (model.includes('|')) return model.split('|')[0] || 'dify';
  return model.slice(0, 160);
}

export function backendIdFromUrl(url) {
  if (!url) return 'unresolved';
  return `dify-${sha256(String(url)).slice(0, 12)}`;
}

function estimatePromptTokens(messages, system) {
  let chars = typeof system === 'string' ? system.length : 0;
  for (const message of messages) {
    chars += String(message?.role || '').length + textValue(message?.content).length;
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        chars += String(call?.id || '').length;
        chars += String(call?.function?.name || '').length;
        chars += String(call?.function?.arguments || '').length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export class CanonicalRequest {
  constructor(fields) { Object.assign(this, fields); Object.freeze(this); }

  static fromExpress(req, options = {}) {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const contextWindow = Number.isFinite(Number(options.contextWindow)) && Number(options.contextWindow) > 0
      ? Number(options.contextWindow)
      : undefined;
    const estimatedPromptTokens = estimatePromptTokens(messages, body.system);
    const toolSchemaEstimatedTokens = estimateTokens(tools);
    const totalEstimatedTokens = estimatedPromptTokens + toolSchemaEstimatedTokens;
    return new CanonicalRequest({
      traceId: String(options.traceId || ''),
      clientType: detectClientType(req),
      sessionIdHash: hashSessionId(req),
      providerId: String(options.providerId || req.headers?.['x-provider-id'] || 'dify'),
      backendId: String(options.backendId || 'unresolved'),
      model: safeModelName(body.model),
      estimatedPromptTokens: totalEstimatedTokens,
      contextWindow,
      contextUtilization: contextWindow ? Math.min(1, totalEstimatedTokens / contextWindow) : undefined,
      messageCount: messages.length,
      toolCount: tools.length,
      toolSchemaEstimatedTokens,
      policyVersion: String(options.policyVersion || POLICY_VERSION),
    });
  }
}

export class CanonicalResponse {
  constructor(fields) { Object.assign(this, fields); Object.freeze(this); }
}

export { POLICY_VERSION };
