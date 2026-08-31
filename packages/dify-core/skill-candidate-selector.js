import { PatternStatus } from './knowledge-pattern.js';
import { KnowledgeScope } from './knowledge-experience.js';
import { SkillScope } from './skill-candidate.js';

const FAMILY_RULES = Object.freeze([
  ['context-management', ['stateful-context-amplification', 'checkpoint-reduces-backend-context', 'pending-tool-chain-blocks-rotation', 'new-generation-schema-reinjection']],
  ['tool-calling', ['tool-pruning-missing-tool-recovery', 'completed-tools-survive-migration']],
  ['backend-routing', ['context-window-mismatch-migration', 'backend-unavailable-fallback']],
  ['dify-session-management', ['dify-session-management', 'dify-conversation-rotation']],
]);

function skillScope(patterns) {
  const scopes = new Set(patterns.map((p) => p.scope));
  if (scopes.has(KnowledgeScope.MODEL_SPECIFIC)) return SkillScope.MODEL_SPECIFIC;
  if (scopes.has(KnowledgeScope.BACKEND_SPECIFIC) || scopes.has(KnowledgeScope.VERSION_SPECIFIC)) return SkillScope.BACKEND_SPECIFIC;
  if (scopes.has(KnowledgeScope.CLIENT_SPECIFIC)) return SkillScope.CLIENT_SPECIFIC;
  return SkillScope.GENERAL;
}

export class SkillCandidateSelector {
  constructor({ promotionThreshold = 0.5, minimumEvidence = 3 } = {}) {
    this.promotionThreshold = promotionThreshold;
    this.minimumEvidence = minimumEvidence;
  }

  select(patterns = []) {
    const eligible = patterns.filter((pattern) =>
      pattern.status === PatternStatus.STRONG
      && Number(pattern.promotionScore || 0) >= this.promotionThreshold
      && Number(pattern.evidence?.observationCount || 0) >= this.minimumEvidence);

    const groups = [];
    for (const [family, keys] of FAMILY_RULES) {
      const selected = eligible.filter((pattern) => keys.includes(pattern.semanticKey));
      if (!selected.length) continue;
      groups.push(Object.freeze({
        family,
        scope: skillScope(selected),
        patterns: Object.freeze([...selected].sort((a, b) => a.patternId.localeCompare(b.patternId))),
      }));
    }
    return Object.freeze(groups);
  }
}
