import { canonicalJson, sha256 } from './canonical.js';

export const SkillScope = Object.freeze({
  GENERAL: 'GENERAL',
  CLIENT_SPECIFIC: 'CLIENT_SPECIFIC',
  BACKEND_SPECIFIC: 'BACKEND_SPECIFIC',
  MODEL_SPECIFIC: 'MODEL_SPECIFIC',
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export function createSkillCandidate(input = {}) {
  const body = {
    version: input.version || 1,
    family: input.family,
    scope: input.scope,
    instructions: String(input.instructions || '').trim(),
    sourcePatternIds: [...new Set(input.sourcePatternIds || [])].sort(),
    purpose: input.purpose || {},
    evidenceSummary: input.evidenceSummary || {},
    confidence: Number(input.confidence || 0),
  };
  const contentHash = sha256(canonicalJson(body));
  const skillId = input.skillId || `skill-${body.family}-${contentHash.slice(0, 16)}`;
  return freeze({ skillId, ...body, contentHash });
}
