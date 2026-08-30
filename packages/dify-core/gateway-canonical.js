import { sha256 } from './canonical.js';

export const POLICY_VERSION = 'gateway-static-v1';

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return String(part.text || '');
    if (part.type === 'tool-result') return '[tool-result]';
    if (part.type === 'image' || part.type === 'image_url') return '[image]';
    if (part.type === 'tool-call') return `${String(part.name || '')}:${String(part.arguments || '')}`;
    return '';
  }).filter(Boolean).join('\n');
}

export function estimateTokens(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.max(0, Math.ceil(text.length / 4));
}

function estimatePromptTokens(messages, system) {
  let chars = typeof system === 'string' ? system.length : 0;
  for (const message of messages || []) {
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

export function hashSessionValue(raw) {
  if (raw === undefined || raw === null || String(raw) === '') return undefined;
  return sha256(`session:${String(raw)}`).slice(0, 24);
}

export function hashSessionId(req) {
  return hashSessionValue(req.headers?.['x-dsh-conversation-id']
    || req.headers?.['x-session-id']
    || req.body?.dsh_conversation_id
    || req.body?.session_id
    || req.body?.user);
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

function buildCanonical(fields, messages, tools, system, contextWindow) {
  const estimatedMessageTokens = estimatePromptTokens(messages, system);
  const toolSchemaEstimatedTokens = estimateTokens(tools);
  const estimatedPromptTokens = estimatedMessageTokens + toolSchemaEstimatedTokens;
  const normalizedContextWindow = Number.isFinite(Number(contextWindow)) && Number(contextWindow) > 0
    ? Number(contextWindow)
    : undefined;
  return new CanonicalRequest({
    ...fields,
    estimatedPromptTokens,
    contextWindow: normalizedContextWindow,
    contextUtilization: normalizedContextWindow ? Math.min(1, estimatedPromptTokens / normalizedContextWindow) : undefined,
    messageCount: messages.length,
    toolCount: tools.length,
    toolSchemaEstimatedTokens,
  });
}

export class CanonicalRequest {
  constructor(fields) { Object.assign(this, fields); Object.freeze(this); }

  static fromExpress(req, options = {}) {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    return buildCanonical({
      traceId: String(options.traceId || ''),
      clientType: detectClientType(req),
      sessionIdHash: hashSessionId(req),
      providerId: String(options.providerId || req.headers?.['x-provider-id'] || 'dify'),
      backendId: String(options.backendId || 'unresolved'),
      model: safeModelName(body.model),
      policyVersion: String(options.policyVersion || POLICY_VERSION),
    }, messages, tools, body.system, options.contextWindow);
  }

  static fromDsh(options, route = {}) {
    const messages = Array.isArray(options?.messages) ? options.messages : [];
    const tools = Array.isArray(options?.tools) ? options.tools : [];
    return buildCanonical({
      traceId: String(route.traceId || ''),
      clientType: 'dsh',
      sessionIdHash: hashSessionValue(options?.sessionId),
      providerId: String(route.providerId || options?.provider || 'dify'),
      backendId: String(route.backendId || 'unresolved'),
      model: safeModelName(String(route.model || options?.model || '')),
      policyVersion: String(route.policyVersion || POLICY_VERSION),
    }, messages, tools, options?.system, route.contextWindow);
  }
}

export class CanonicalResponse {
  constructor(fields) { Object.assign(this, fields); Object.freeze(this); }
}
