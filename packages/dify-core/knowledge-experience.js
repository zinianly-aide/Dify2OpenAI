import { canonicalJson, sha256 } from './canonical.js';

export const KnowledgeScope = Object.freeze({
  GENERAL: 'GENERAL',
  CLIENT_SPECIFIC: 'CLIENT_SPECIFIC',
  BACKEND_SPECIFIC: 'BACKEND_SPECIFIC',
  MODEL_SPECIFIC: 'MODEL_SPECIFIC',
  VERSION_SPECIFIC: 'VERSION_SPECIFIC',
});

const SENSITIVE_KEY = /(prompt|session.?id|conversation.?id|arguments?|tool.?result|credential|api.?key|attachment.?content)/i;
const TOP_LEVEL_KEYS = new Set(['timestamp','clientType','taskType','backendType','backendIdHash','modelFamily','context','tools','routing','outcome','policyVersion','scope','source']);
const NESTED_KEYS = Object.freeze({
  context: new Set(['utilization','amplification','compressionMode','checkpoint','rotation']),
  tools: new Set(['beforeCount','afterCount','schemaTokensSaved','pruningMode','recoveryTriggered']),
  routing: new Set(['migration','fallback','reasonCodes']),
  outcome: new Set(['success','errorType','latencyBucket','tokenBucket','costBucket']),
  source: new Set(['type','idHash']),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
function pick(input, keys) {
  const out = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(input || {}, key)) out[key] = input[key];
  return out;
}
function strictBody(input = {}) {
  const top = pick(input, TOP_LEVEL_KEYS);
  for (const [key, keys] of Object.entries(NESTED_KEYS)) top[key] = pick(input?.[key], keys);
  top.routing.reasonCodes = Object.freeze([...(Array.isArray(top.routing.reasonCodes) ? top.routing.reasonCodes : [])].map(String).sort());
  return top;
}

export function assertKnowledgePrivacy(value, path = '$') {
  if (!value || typeof value !== 'object') return true;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`KNOWLEDGE_PRIVACY_VIOLATION:${path}.${key}`);
    assertKnowledgePrivacy(child, `${path}.${key}`);
  }
  return true;
}

export function createKnowledgeExperience(input = {}) {
  const body = strictBody(input);
  assertKnowledgePrivacy(body);
  const experienceId = `exp-${sha256(canonicalJson(body)).slice(0, 24)}`;
  return deepFreeze({ experienceId, ...body });
}

export const KNOWLEDGE_SENSITIVE_KEY_PATTERN = SENSITIVE_KEY;
export const KNOWLEDGE_EXPERIENCE_ALLOWED_KEYS = Object.freeze([...TOP_LEVEL_KEYS].sort());
