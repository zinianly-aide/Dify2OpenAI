import { canonicalJson, sha256 } from './canonical.js';
import { KnowledgeScope } from './knowledge-experience.js';
import { PatternStatus } from './knowledge-pattern.js';
import { EvolutionLog } from './evolution-log.js';

const CHANGE_TYPES = new Set(['CREATED', 'MERGED', 'STRENGTHENED', 'WEAKENED', 'CONTRADICTED', 'DEPRECATED', 'SUPERSEDED', 'SCOPE_PROMOTED']);
const NEXT_SCOPE = Object.freeze({
  [KnowledgeScope.VERSION_SPECIFIC]: KnowledgeScope.BACKEND_SPECIFIC,
  [KnowledgeScope.BACKEND_SPECIFIC]: KnowledgeScope.CLIENT_SPECIFIC,
  [KnowledgeScope.CLIENT_SPECIFIC]: KnowledgeScope.GENERAL,
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}
function versionId(patternId, previousVersion, changeType, pattern) {
  return `pv-${sha256(canonicalJson({ patternId, previousVersion, changeType, pattern })).slice(0, 24)}`;
}
function mergeEvidence(base = {}, delta = {}) {
  const sum = (key) => Number(base[key] || 0) + Number(delta[key] || 0);
  return {
    ...base,
    observationCount: sum('observationCount'),
    successCount: sum('successCount'),
    failureCount: sum('failureCount'),
    firstSeen: [base.firstSeen, delta.firstSeen].filter(Boolean).sort()[0] || null,
    lastSeen: [base.lastSeen, delta.lastSeen].filter(Boolean).sort().at(-1) || null,
    clientDiversity: Math.max(Number(base.clientDiversity || 0), Number(delta.clientDiversity || 0)),
    backendDiversity: Math.max(Number(base.backendDiversity || 0), Number(delta.backendDiversity || 0)),
    modelDiversity: Math.max(Number(base.modelDiversity || 0), Number(delta.modelDiversity || 0)),
  };
}

export function canPromoteKnowledgeScope(currentScope, targetScope, evidence = {}) {
  if (NEXT_SCOPE[currentScope] !== targetScope) return false;
  const observations = Number(evidence.observationCount || 0);
  if (currentScope === KnowledgeScope.VERSION_SPECIFIC) return observations >= 3 && Number(evidence.backendDiversity || 0) >= 1;
  if (currentScope === KnowledgeScope.BACKEND_SPECIFIC) return observations >= 5 && Number(evidence.clientDiversity || 0) >= 2;
  if (currentScope === KnowledgeScope.CLIENT_SPECIFIC) {
    return observations >= 8
      && Number(evidence.clientDiversity || 0) >= 3
      && Number(evidence.backendDiversity || 0) >= 2
      && Number(evidence.modelDiversity || 0) >= 2;
  }
  return false;
}

export class WikiMaintainer {
  constructor({ evolutionLog } = {}) {
    this.evolutionLog = evolutionLog || new EvolutionLog();
    this.history = new Map();
  }

  create(pattern, { timestamp = 'unknown' } = {}) {
    if (this.history.has(pattern.patternId)) return this.latest(pattern.patternId);
    return this.#append(pattern.patternId, null, 'CREATED', pattern, {}, timestamp);
  }

  evolve(patternId, changeType, patch = {}, { evidenceDelta = {}, timestamp = 'unknown' } = {}) {
    if (!CHANGE_TYPES.has(changeType)) throw new Error(`INVALID_KNOWLEDGE_CHANGE:${changeType}`);
    const current = this.latest(patternId);
    if (!current) throw new Error(`PATTERN_NOT_FOUND:${patternId}`);
    const nextPattern = {
      ...current.pattern,
      ...patch,
      evidence: mergeEvidence(current.pattern.evidence, evidenceDelta),
      sourceExperienceIds: [...new Set([...(current.pattern.sourceExperienceIds || []), ...(patch.sourceExperienceIds || [])])].sort(),
    };
    if (changeType === 'CONTRADICTED') nextPattern.status = PatternStatus.CONTRADICTED;
    if (changeType === 'DEPRECATED') nextPattern.status = PatternStatus.DEPRECATED;
    return this.#append(patternId, current.patternVersion, changeType, nextPattern, evidenceDelta, timestamp);
  }

  promoteScope(patternId, targetScope, { evidenceDelta = {}, timestamp = 'unknown' } = {}) {
    const current = this.latest(patternId);
    if (!current) throw new Error(`PATTERN_NOT_FOUND:${patternId}`);
    const evidence = mergeEvidence(current.pattern.evidence, evidenceDelta);
    if (!canPromoteKnowledgeScope(current.pattern.scope, targetScope, evidence)) throw new Error('SCOPE_PROMOTION_EVIDENCE_INSUFFICIENT');
    return this.evolve(patternId, 'SCOPE_PROMOTED', { scope: targetScope }, { evidenceDelta, timestamp });
  }

  latest(patternId) {
    const versions = this.history.get(patternId) || [];
    return versions.at(-1) || null;
  }

  getVersion(patternId, patternVersion) {
    return (this.history.get(patternId) || []).find((record) => record.patternVersion === patternVersion) || null;
  }

  listHistory(patternId) { return [...(this.history.get(patternId) || [])]; }

  listLatest() {
    return [...this.history.keys()].map((id) => this.latest(id)).filter(Boolean).sort((a, b) => a.patternId.localeCompare(b.patternId));
  }

  #append(patternId, previousVersion, changeType, pattern, evidenceDelta, timestamp) {
    const patternVersion = versionId(patternId, previousVersion, changeType, pattern);
    const record = freeze({ patternId, patternVersion, previousVersion, changeType, timestamp, evidenceDelta, pattern: structuredClone(pattern) });
    const versions = this.history.get(patternId) || [];
    if (!versions.some((item) => item.patternVersion === patternVersion)) versions.push(record);
    this.history.set(patternId, versions);
    this.evolutionLog.append({ patternId, patternVersion, changeType, timestamp, evidenceDelta });
    return record;
  }
}
