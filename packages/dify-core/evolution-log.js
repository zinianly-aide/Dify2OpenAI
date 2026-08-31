import { canonicalJson, sha256 } from './canonical.js';
import { assertKnowledgePrivacy } from './knowledge-experience.js';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export class EvolutionLog {
  constructor() { this.entries = []; }

  append(input = {}) {
    const body = {
      patternId: input.patternId,
      patternVersion: input.patternVersion,
      changeType: input.changeType,
      timestamp: input.timestamp || 'unknown',
      evidenceDelta: input.evidenceDelta || {},
      reasonCodes: [...new Set(input.reasonCodes || [])].sort(),
    };
    assertKnowledgePrivacy(body);
    const entryId = `evo-${sha256(canonicalJson(body)).slice(0, 24)}`;
    const entry = freeze({ entryId, ...body });
    if (!this.entries.some((item) => item.entryId === entryId)) this.entries.push(entry);
    return entry;
  }

  list({ patternId, changeType } = {}) {
    return this.entries.filter((entry) =>
      (patternId === undefined || entry.patternId === patternId)
      && (changeType === undefined || entry.changeType === changeType))
      .sort((a, b) => a.entryId.localeCompare(b.entryId));
  }
}
