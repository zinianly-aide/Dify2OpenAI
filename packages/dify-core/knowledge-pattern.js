import { canonicalJson, sha256 } from './canonical.js';
import { assertKnowledgePrivacy } from './knowledge-experience.js';

export const PatternStatus = Object.freeze({
  OBSERVED: 'OBSERVED',
  SUPPORTED: 'SUPPORTED',
  STRONG: 'STRONG',
  CONTRADICTED: 'CONTRADICTED',
  DEPRECATED: 'DEPRECATED',
});

export const PatternCategory = Object.freeze({
  CONTEXT: 'CONTEXT',
  TOOLS: 'TOOLS',
  ROUTING: 'ROUTING',
  LIFECYCLE: 'LIFECYCLE',
  BACKEND: 'BACKEND',
  CLIENT: 'CLIENT',
  RELIABILITY: 'RELIABILITY',
  COST: 'COST',
  LATENCY: 'LATENCY',
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export function createKnowledgePattern(input = {}) {
  const semanticKey = String(input.semanticKey || 'unknown');
  const patternId = `pattern-${sha256(semanticKey).slice(0, 24)}`;
  const body = {
    patternId,
    title: input.title,
    category: input.category,
    scope: input.scope,
    conditions: input.conditions || {},
    observations: input.observations || [],
    hypothesis: input.hypothesis || null,
    rootCause: input.rootCause || null,
    effectiveStrategies: input.effectiveStrategies || [],
    failedStrategies: input.failedStrategies || [],
    evidence: input.evidence,
    confidence: input.confidence,
    impact: input.impact,
    transferability: input.transferability,
    sourceExperienceIds: [...new Set(input.sourceExperienceIds || [])].sort(),
    status: input.status,
    promotionScore: input.promotionScore,
    promotionSignal: input.promotionSignal || null,
    semanticKey,
  };
  assertKnowledgePrivacy(body);
  const contentHash = sha256(canonicalJson(body));
  return freeze({ ...body, contentHash });
}
