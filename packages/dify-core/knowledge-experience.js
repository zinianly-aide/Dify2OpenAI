import { canonicalJson, sha256 } from './canonical.js';

export const KnowledgeScope = Object.freeze({
  GENERAL: 'GENERAL',
  CLIENT_SPECIFIC: 'CLIENT_SPECIFIC',
  BACKEND_SPECIFIC: 'BACKEND_SPECIFIC',
  MODEL_SPECIFIC: 'MODEL_SPECIFIC',
  VERSION_SPECIFIC: 'VERSION_SPECIFIC',
});

const SENSITIVE_KEY = /(prompt|session.?id|conversation.?id|arguments?|tool.?result|credential|api.?key|attachment.?content)/i;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
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
  const body = {
    timestamp: input.timestamp,
    clientType: input.clientType,
    taskType: input.taskType,
    backendType: input.backendType,
    backendIdHash: input.backendIdHash,
    modelFamily: input.modelFamily,
    context: input.context,
    tools: input.tools,
    routing: input.routing,
    outcome: input.outcome,
    policyVersion: input.policyVersion,
    scope: input.scope,
    source: input.source,
  };
  assertKnowledgePrivacy(body);
  const experienceId = `exp-${sha256(canonicalJson(body)).slice(0, 24)}`;
  return deepFreeze({ experienceId, ...body });
}

export const KNOWLEDGE_SENSITIVE_KEY_PATTERN = SENSITIVE_KEY;
