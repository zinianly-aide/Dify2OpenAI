import { canonicalJson, sha256 } from './canonical.js';
import { assertKnowledgePrivacy } from './knowledge-experience.js';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export class PatternImpactTracker {
  constructor() { this.records = []; }

  record(input = {}) {
    const body = {
      patternId: input.patternId,
      targetType: input.targetType,
      targetIdHash: input.targetId ? sha256(String(input.targetId)).slice(0, 16) : null,
      stage: input.stage,
      outcome: input.outcome,
      rollback: input.rollback === true,
      reasonCodes: [...new Set(input.reasonCodes || [])].sort(),
      timestamp: input.timestamp || 'unknown',
    };
    assertKnowledgePrivacy(body);
    const impactId = `impact-${sha256(canonicalJson(body)).slice(0, 24)}`;
    const record = freeze({ impactId, ...body });
    if (!this.records.some((item) => item.impactId === impactId)) this.records.push(record);
    return record;
  }

  query({ patternId, targetType, stage, outcome } = {}) {
    return this.records.filter((record) =>
      (patternId === undefined || record.patternId === patternId)
      && (targetType === undefined || record.targetType === targetType)
      && (stage === undefined || record.stage === stage)
      && (outcome === undefined || record.outcome === outcome))
      .sort((a, b) => a.impactId.localeCompare(b.impactId));
  }
}
