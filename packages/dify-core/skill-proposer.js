import { createSkillCandidate, SkillScope } from './skill-candidate.js';

const VALID_SCOPES = new Set(Object.values(SkillScope));
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._-]{8,}|BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=])/i;

function unique(patterns, key) {
  return [...new Set(patterns.flatMap((p) => p.conditions?.environment?.[key] || []))].sort();
}
function requiredCapabilities(family) {
  if (family === 'tool-calling') return ['tools'];
  return [];
}
function deterministicProposal(group) {
  const patterns = group.patterns || [];
  const effective = [...new Set(patterns.flatMap((p) => p.effectiveStrategies || []))].sort();
  const failed = [...new Set(patterns.flatMap((p) => p.failedStrategies || []))].sort();
  const instructions = [
    `Apply ${group.family} procedures only when the selected scope matches.`,
    ...effective.map((strategy, i) => `${i + 1}. ${strategy}.`),
    ...(failed.length ? [`Avoid known failed strategies: ${failed.join(', ')}.`] : []),
  ].join('\n');
  const observationCount = patterns.reduce((sum, p) => sum + Number(p.evidence?.observationCount || 0), 0);
  const confidence = patterns.length ? patterns.reduce((sum, p) => sum + Number(p.confidence || 0), 0) / patterns.length : 0;
  return {
    family: group.family,
    scope: group.scope,
    instructions,
    sourcePatternIds: patterns.map((p) => p.patternId),
    purpose: {
      reason: `Procedural guidance derived from ${patterns.length} supported gateway pattern(s).`,
      sourcePatternIds: patterns.map((p) => p.patternId),
      knownFailedStrategies: failed,
      scope: group.scope,
      bindings: {
        clientTypes: unique(patterns, 'clientTypes'),
        backendTypes: group.family === 'dify-session-management' ? ['dify'] : unique(patterns, 'backendTypes'),
        backendIdHashes: unique(patterns, 'backendIdHashes'),
        modelFamilies: unique(patterns, 'modelFamilies'),
        requiredCapabilities: requiredCapabilities(group.family),
      },
    },
    evidenceSummary: { patternCount: patterns.length, observationCount },
    confidence,
  };
}

function validateSchema(proposal) {
  if (!proposal || typeof proposal !== 'object') throw new Error('SKILL_PROPOSAL_SCHEMA_INVALID');
  for (const key of ['family', 'scope', 'instructions', 'sourcePatternIds', 'purpose', 'evidenceSummary', 'confidence']) {
    if (!(key in proposal)) throw new Error(`SKILL_PROPOSAL_SCHEMA_INVALID:${key}`);
  }
  if (!Array.isArray(proposal.sourcePatternIds) || !proposal.sourcePatternIds.length) throw new Error('SKILL_PROPOSAL_SCHEMA_INVALID:sourcePatternIds');
}

function validateScope(group, proposal) {
  if (!VALID_SCOPES.has(proposal.scope)) throw new Error('SKILL_PROPOSAL_SCOPE_INVALID');
  const hasBackendSpecific = (group.patterns || []).some((p) => p.scope === 'BACKEND_SPECIFIC' || p.scope === 'VERSION_SPECIFIC');
  if (hasBackendSpecific && proposal.scope === SkillScope.GENERAL) throw new Error('SKILL_NEGATIVE_TRANSFER_SCOPE_REJECTED');
  if (proposal.scope !== group.scope) throw new Error('SKILL_PROPOSAL_SCOPE_MISMATCH');
}

function validateProvenance(group, proposal) {
  const expected = [...new Set((group.patterns || []).map((p) => p.patternId))].sort();
  const actual = [...new Set(proposal.sourcePatternIds || [])].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('SKILL_PROPOSAL_PROVENANCE_INVALID');
  const purposeSources = [...new Set(proposal.purpose?.sourcePatternIds || [])].sort();
  if (JSON.stringify(expected) !== JSON.stringify(purposeSources)) throw new Error('SKILL_PROPOSAL_PURPOSE_PROVENANCE_INVALID');
}

function validateSize(proposal, maxInstructionChars) {
  if (!String(proposal.instructions || '').trim() || String(proposal.instructions).length > maxInstructionChars) throw new Error('SKILL_PROPOSAL_SIZE_INVALID');
}
function validateSafety(proposal) {
  if (SECRET_VALUE.test(JSON.stringify(proposal))) throw new Error('SKILL_PROPOSAL_SAFETY_REJECTED');
}

export class SkillProposer {
  constructor({ proposalProvider = null, maxInstructionChars = 4000 } = {}) {
    this.proposalProvider = proposalProvider;
    this.maxInstructionChars = maxInstructionChars;
  }

  async propose(group) {
    const raw = this.proposalProvider ? await this.proposalProvider(group) : deterministicProposal(group);
    validateSchema(raw);
    validateScope(group, raw);
    validateSize(raw, this.maxInstructionChars);
    validateProvenance(group, raw);
    validateSafety(raw);
    return createSkillCandidate(raw);
  }
}

export const deterministicSkillProposal = deterministicProposal;
