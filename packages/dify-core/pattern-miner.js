import { createKnowledgePattern, PatternCategory, PatternStatus } from './knowledge-pattern.js';
import { KnowledgeScope } from './knowledge-experience.js';

const DEFAULTS = Object.freeze({ minimumObservedEvidence: 1, minimumSupportedEvidence: 3, minimumStrongEvidence: 8, contradictionRateThreshold: 0.4, promotionThreshold: 0.5 });
const SCOPE_RANK = Object.freeze({ [KnowledgeScope.GENERAL]: 0, [KnowledgeScope.CLIENT_SPECIFIC]: 1, [KnowledgeScope.BACKEND_SPECIFIC]: 2, [KnowledgeScope.MODEL_SPECIFIC]: 3, [KnowledgeScope.VERSION_SPECIFIC]: 4 });

const RULES = Object.freeze([
  { key: 'stateful-context-amplification', title: 'Stateful backend context amplification', category: PatternCategory.CONTEXT, match: (e) => Number(e.context?.amplification) >= 1.2, support: (e) => e.outcome?.success === true, hypothesis: 'Stateful backend context can grow faster than gateway-visible context.', rootCause: 'Backend-retained conversation state amplifies effective prompt context.', effective: ['checkpoint', 'rotation'], failed: [], impact: 0.8 },
  { key: 'checkpoint-reduces-backend-context', title: 'Checkpoint reduces backend context pressure', category: PatternCategory.CONTEXT, match: (e) => e.context?.checkpoint === true, support: (e) => e.outcome?.success === true, hypothesis: 'Checkpointing can reduce context pressure while preserving task continuity.', rootCause: 'A compact durable checkpoint replaces redundant historical context.', effective: ['checkpoint'], failed: ['continue-without-checkpoint'], impact: 0.75 },
  { key: 'pending-tool-chain-blocks-rotation', title: 'Pending tool chain blocks rotation', category: PatternCategory.LIFECYCLE, match: (e) => (e.routing?.reasonCodes || []).includes('ROTATION_DEFERRED_PENDING_TOOL'), support: () => true, hypothesis: 'Conversation rotation must wait until the pending tool chain is resolved.', rootCause: 'Rotating mid-tool-chain can break call/result correlation and side-effect safety.', effective: ['defer-rotation-until-tool-chain-complete'], failed: ['rotate-mid-tool-chain'], impact: 0.9 },
  { key: 'new-generation-schema-reinjection', title: 'New generation requires schema reinjection', category: PatternCategory.LIFECYCLE, match: (e) => (e.routing?.reasonCodes || []).includes('SCHEMA_REINJECTION_REQUIRED'), support: (e) => e.outcome?.success === true, hypothesis: 'A new backend generation needs tool schema reinjection before tool use.', rootCause: 'Tool schema state is generation-scoped and not implicitly portable.', effective: ['reinject-tool-schema'], failed: ['reuse-generation-schema-assumption'], impact: 0.8 },
  { key: 'tool-pruning-missing-tool-recovery', title: 'Tool pruning can trigger missing-tool recovery', category: PatternCategory.TOOLS, match: (e) => Number(e.tools?.beforeCount) > Number(e.tools?.afterCount) && e.tools?.recoveryTriggered === true, support: (e) => e.outcome?.success === true, hypothesis: 'Aggressive tool pruning can remove a tool later required by the task.', rootCause: 'Relevance pruning is conservative but cannot prove future tool necessity.', effective: ['single-full-tool-recovery'], failed: ['prune-without-recovery'], impact: 0.7 },
  { key: 'completed-tool-idempotency', title: 'Completed tool execution remains idempotent', category: PatternCategory.TOOLS, match: (e) => (e.routing?.reasonCodes || []).includes('COMPLETED_TOOL_IDEMPOTENT'), support: (e) => e.outcome?.success === true, hypothesis: 'Completed tool side effects should remain authoritative across compatible runtime environments.', rootCause: 'Tool execution identity is gateway-owned rather than tied to one client or backend.', effective: ['preserve-completed-tool-ledger'], failed: ['reexecute-completed-tool'], impact: 0.95 },
  { key: 'completed-tools-survive-migration', title: 'Completed tools survive backend migration', category: PatternCategory.ROUTING, match: (e) => e.routing?.migration === true && (e.routing?.reasonCodes || []).includes('COMPLETED_TOOLS_PRESERVED'), support: (e) => e.outcome?.success === true, hypothesis: 'Completed tool side effects must remain authoritative across migration.', rootCause: 'Tool execution identity belongs to the gateway session rather than a backend generation.', effective: ['preserve-tool-ledger-across-migration'], failed: ['reexecute-completed-tools'], impact: 0.95 },
  { key: 'context-window-mismatch-migration', title: 'Context window mismatch triggers migration', category: PatternCategory.ROUTING, match: (e) => e.routing?.migration === true && (e.routing?.reasonCodes || []).includes('CONTEXT_WINDOW_MISMATCH'), support: (e) => e.outcome?.success === true, hypothesis: 'Requests that exceed backend context capability require deterministic migration.', rootCause: 'Selected backend context window is insufficient for the request budget.', effective: ['migrate-to-compatible-context-window'], failed: ['stay-on-insufficient-backend'], impact: 0.85 },
  { key: 'backend-unavailable-fallback', title: 'Backend unavailable triggers fallback', category: PatternCategory.RELIABILITY, match: (e) => e.routing?.fallback === true && (e.routing?.reasonCodes || []).includes('BACKEND_UNAVAILABLE'), support: (e) => e.outcome?.success === true, hypothesis: 'Unavailable backends require deterministic fallback to preserve request success.', rootCause: 'Primary backend health does not satisfy routing availability requirements.', effective: ['fallback-to-healthy-compatible-backend'], failed: ['retry-unavailable-backend-indefinitely'], impact: 0.9 },
  { key: 'dify-conversation-id-rotation', title: 'Dify conversation lifecycle requires backend-local rotation', category: PatternCategory.BACKEND, scope: KnowledgeScope.BACKEND_SPECIFIC, match: (e) => e.backendType === 'dify' && (e.routing?.reasonCodes || []).includes('DIFY_CONVERSATION_ID_ROTATION'), support: (e) => e.outcome?.success === true, hypothesis: 'Dify conversation identifiers require backend-local lifecycle handling.', rootCause: 'Dify conversation_id is backend-local state and cannot be generalized across providers.', effective: ['rotate-dify-conversation-safely'], failed: ['reuse-dify-conversation-across-backends'], impact: 0.9 },
]);

function clamp(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function mostSpecificScope(experiences) { return [...experiences].map((e) => e.scope || KnowledgeScope.GENERAL).sort((a, b) => (SCOPE_RANK[b] ?? 0) - (SCOPE_RANK[a] ?? 0))[0] || KnowledgeScope.GENERAL; }
function unique(experiences, selector) { return [...new Set(experiences.map(selector).filter((v) => v && v !== 'unknown' && !String(v).endsWith('-unknown')))].sort(); }
function statusFor({ count, failureCount, config }) { const rate = count ? failureCount / count : 0; if (count >= config.minimumSupportedEvidence && rate >= config.contradictionRateThreshold) return PatternStatus.CONTRADICTED; if (count >= config.minimumStrongEvidence) return PatternStatus.STRONG; if (count >= config.minimumSupportedEvidence) return PatternStatus.SUPPORTED; return PatternStatus.OBSERVED; }

export class PatternMiner {
  constructor(config = {}) { this.config = Object.freeze({ ...DEFAULTS, ...config }); }
  mine(experiences = []) {
    const patterns = [];
    for (const rule of RULES) {
      const matched = experiences.filter(rule.match).sort((a, b) => a.experienceId.localeCompare(b.experienceId));
      if (matched.length < this.config.minimumObservedEvidence) continue;
      const successCount = matched.filter(rule.support).length;
      const failureCount = matched.length - successCount;
      const successRate = matched.length ? successCount / matched.length : 0;
      const clientTypes = unique(matched, (e) => e.clientType);
      const backendTypes = unique(matched, (e) => e.backendType);
      const backendIdHashes = unique(matched, (e) => e.backendIdHash);
      const modelFamilies = unique(matched, (e) => e.modelFamily);
      const policyVersions = unique(matched, (e) => e.policyVersion);
      const clientDiversity = clientTypes.length;
      const backendDiversity = backendIdHashes.length;
      const modelDiversity = modelFamilies.length;
      const transferability = clamp((Math.min(clientDiversity, 3) / 3) * 0.4 + (Math.min(backendDiversity, 3) / 3) * 0.3 + (Math.min(modelDiversity, 3) / 3) * 0.3);
      const evidenceStrength = clamp(matched.length / this.config.minimumStrongEvidence);
      const recurrence = clamp(matched.length / this.config.minimumStrongEvidence);
      const confidence = clamp(successRate * (1 - (failureCount / matched.length) * 0.75));
      const impact = clamp(rule.impact);
      const promotionScore = clamp(recurrence * evidenceStrength * impact * transferability * confidence);
      const status = statusFor({ count: matched.length, failureCount, config: this.config });
      patterns.push(createKnowledgePattern({ semanticKey: rule.key, title: rule.title, category: rule.category, scope: rule.scope || mostSpecificScope(matched), conditions: { semanticRule: rule.key, environment: { clientTypes, backendTypes, backendIdHashes, modelFamilies, policyVersions } }, observations: [`matched:${matched.length}`, `success:${successCount}`, `failure:${failureCount}`], hypothesis: rule.hypothesis, rootCause: rule.rootCause, effectiveStrategies: rule.effective, failedStrategies: failureCount > 0 ? rule.failed : [], evidence: { observationCount: matched.length, successCount, failureCount, firstSeen: matched.map((e) => e.timestamp).sort()[0] || null, lastSeen: matched.map((e) => e.timestamp).sort().at(-1) || null, clientDiversity, backendDiversity, modelDiversity }, confidence, impact, transferability, sourceExperienceIds: matched.map((e) => e.experienceId), status, promotionScore, promotionSignal: status === PatternStatus.STRONG && promotionScore >= this.config.promotionThreshold ? 'SKILL_CANDIDATE' : null }));
    }
    return patterns.sort((a, b) => a.patternId.localeCompare(b.patternId));
  }
}

export const PATTERN_MINER_DEFAULTS = DEFAULTS;
