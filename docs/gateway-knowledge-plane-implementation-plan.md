# Adaptive AI Gateway — Knowledge Plane Implementation Plan

> Source design reference: arXiv:2608.27454 (user-provided). The implementation remains constrained by this repository's existing deterministic, privacy-preserving Gateway architecture.

## Non-negotiable boundaries

- Preserve deterministic/configurable runtime behavior.
- Runtime evidence and knowledge must never contain raw prompt, raw session/conversation IDs, tool arguments/results, credentials/API keys, or attachment content.
- Knowledge history is append-only/immutable by version; rollback never deletes knowledge.
- Policy Evolution and Skill Evolution remain separate lifecycle state machines.
- LLM has no production authority. Where explicitly allowed later, it is proposer-only and its output must pass deterministic validation.
- No phase may silently implement functionality reserved for a later phase.
- Every phase closes only after unit/E2E/privacy tests and CI evidence pass.

## Phase 0 — Baseline and regression gate

Before Knowledge Plane work:

1. Record current `main` HEAD and relevant CI state.
2. Preserve existing Gateway lifecycle/routing/tool/policy behavior.
3. Keep unrelated known failures separate; do not weaken existing assertions to make CI green.
4. Add dedicated Knowledge Plane tests/workflow without deleting existing tests.

---

## Phase 1 — Knowledge Plane foundation

Pipeline:

`DecisionEvent / Runtime Evidence → ExperienceCompiler → KnowledgeExperience → GatewayKnowledgeStore`

### 1.1 KnowledgeExperience

Implement an immutable, sanitized model containing at least:

- `experienceId`, `timestamp`
- `clientType`, `taskType`
- `backendType`, `backendIdHash`, `modelFamily`
- `context`: utilization, amplification, compressionMode, checkpoint, rotation
- `tools`: beforeCount, afterCount, schemaTokensSaved, pruningMode, recoveryTriggered
- `routing`: migration, fallback, reasonCodes
- `outcome`: success, errorType, latencyBucket, tokenBucket, costBucket
- `policyVersion`
- `scope`
- sanitized source references to DecisionEvent / ReplayResult / GuardrailResult / ToolOptimizationResult / RotationResult

Forbidden fields include raw prompt/session/conversation IDs, tool arguments/results, credentials, API keys, attachment content.

### 1.2 ExperienceCompiler

Implement deterministic:

`Runtime Event → sanitize → normalize → classify → KnowledgeExperience`

- Canonical JSON serialization.
- Content-derived hash.
- Same normalized event → same `experienceId`.
- No LLM.

### 1.3 GatewayKnowledgeStore

Implement:

- `appendExperience`
- `getExperience`
- `queryExperiences`
- `createSnapshot`

Snapshot requirements:

- immutable
- deterministic ordering
- `contentHash`
- deterministic `snapshotId`

### 1.4 Knowledge Scope

Deterministic classification only:

- `GENERAL`
- `CLIENT_SPECIFIC`
- `BACKEND_SPECIFIC`
- `MODEL_SPECIFIC`
- `VERSION_SPECIFIC`

### 1.5 Privacy tests

Explicitly scan serialized Experience and Snapshot output and fail if sensitive key/value families appear.

### 1.6 Acceptance tests

- same event → same experienceId
- same dataset → same snapshotId
- different sessions remain anonymous
- scope classification deterministic
- sensitive fields removed
- DecisionEvent compiles
- tool recovery compiles
- rotation compiles
- routing/fallback compiles

### Phase 1 stop gate

Do **not** implement PatternMiner, WikiMaintainer, Skill, or EvolutionController until Phase 1 CI passes.

---

## Phase 2 — Deterministic Pattern Mining

Pipeline:

`KnowledgeExperience → PatternMiner → KnowledgePattern → PatternStore`

No Skill generation, Policy mutation, Canary, or LLM.

### 2.1 KnowledgePattern

Fields:

- patternId, title, category, scope
- conditions, observations
- hypothesis, rootCause
- effectiveStrategies, failedStrategies
- evidence: observationCount, successCount, failureCount, firstSeen, lastSeen
- confidence, impact, transferability
- sourceExperienceIds
- status
- promotionScore and `SKILL_CANDIDATE` signal only

Statuses:

- OBSERVED
- SUPPORTED
- STRONG
- CONTRADICTED
- DEPRECATED

Categories:

- CONTEXT
- TOOLS
- ROUTING
- LIFECYCLE
- BACKEND
- CLIENT
- RELIABILITY
- COST
- LATENCY

### 2.2 Initial deterministic patterns

Recognize repository-known semantics first:

- stateful backend context amplification
- protected context dominates compression
- checkpoint reduces backend context
- pending tool chain blocks rotation
- new generation requires schema reinjection
- tool pruning can trigger missing-tool recovery
- completed tools survive migration
- context window mismatch triggers migration
- backend unavailable triggers fallback

### 2.3 Evidence thresholds

Configurable:

- minimumObservedEvidence
- minimumSupportedEvidence
- minimumStrongEvidence

Status/confidence also considers recurrence, success rate, cross-session, cross-backend, and cross-client evidence.

### 2.4 Contradiction and deduplication

- Supporting and contradicting evidence both accumulate.
- Regression after a previously safe strategy lowers confidence and can mark CONTRADICTED.
- Deterministic semantic key merges repeated evidence into one pattern.

### 2.5 Promotion score

Normalize each factor to 0..1:

`promotionScore = recurrence × evidenceStrength × impact × transferability × confidence`

Threshold crossing emits only `SKILL_CANDIDATE` signal.

### 2.6 Acceptance tests

- repeated context amplification → one pattern
- checkpoint success strengthens pattern
- failed intervention lowers confidence
- cross-client evidence increases transferability
- version-only issue stays VERSION_SPECIFIC
- repeated evidence does not duplicate patterns
- insufficient evidence stays OBSERVED
- strong evidence → STRONG
- contradictory evidence → CONTRADICTED
- threshold → SKILL_CANDIDATE signal

### Phase 2 stop gate

Do **not** implement SkillProposer.

---

## Phase 3 — Wiki evolution and provenance

Pipeline:

`PatternStore → WikiMaintainer → EvolutionLog → PatternImpactTracker → Gateway Wiki Snapshot`

No Skill generation.

### 3.1 WikiMaintainer

Support append-only knowledge evolution:

- merge
- strengthen
- weaken
- contradict
- deprecate
- supersede

Never overwrite/delete historical Pattern versions.

### 3.2 Pattern versions

Each change creates:

- patternVersion
- previousVersion
- changeType
- timestamp
- evidenceDelta

### 3.3 EvolutionLog

Record sanitized events for pattern created/strengthened/weakened/contradicted/deprecated/superseded.

### 3.4 PatternImpactTracker

Track Pattern influence on:

- PolicyCandidate
- SkillCandidate
- Replay
- Canary
- Production Outcome

Keep provenance queryable end-to-end.

### 3.5 Wiki Snapshot

Immutable snapshot fields:

- wikiSnapshotId
- patternCount
- strongPatternCount
- skillCandidateCount
- contentHash
- createdAt

Same knowledge state → same content hash. Snapshot identity excludes nondeterministic wall-clock metadata from content hashing.

### 3.6 Scope promotion

Evidence-gated deterministic progression:

`VERSION_SPECIFIC → BACKEND_SPECIFIC → CLIENT_SPECIFIC → GENERAL`

No LLM scope promotion.

### 3.7 Rollback principle

Policy/Skill rollback never removes Wiki knowledge. It appends failed-strategy, contradiction, and impact evidence.

### 3.8 Acceptance tests

- history preserved
- strengthen creates version
- contradiction preserved
- deprecated pattern queryable
- policy rollback does not delete pattern
- skill rollback does not delete pattern
- scope promotion requires evidence
- same Wiki state → same snapshot hash
- impact lineage queryable

---

## Phase 4 — Candidate Skill proposal

Pipeline:

`Gateway Wiki → SkillCandidateSelector → SkillProposer → Candidate Skill`

No automatic publish, ACTIVE transition, production Canary, or Policy mutation.

### 4.1 Candidate selection

Require:

- status STRONG
- promotionScore ≥ threshold
- sufficient evidence

Block CONTRADICTED / DEPRECATED by default.

### 4.2 Skill scopes

- GENERAL
- CLIENT_SPECIFIC
- BACKEND_SPECIFIC
- MODEL_SPECIFIC

Backend-specific workarounds must not leak into GENERAL skills without evidence-supported scope promotion.

### 4.3 Initial Skill families

- context-management
- tool-calling
- backend-routing
- dify-session-management

### 4.4 SkillProposer

Output validated `SkillCandidate`:

- skillId, version, scope
- instructions
- sourcePatternIds
- purpose
- evidenceSummary
- confidence
- contentHash

Skill content must be concise, procedural, executable, and transferable; PURPOSE/provenance is stored separately from runtime instructions.

### 4.5 LLM boundary

LLM use is permitted only in this phase as proposer and only if configured. Every proposal must pass deterministic:

- schema validation
- scope validation
- size validation
- provenance validation
- safety validation

LLM cannot publish, modify ACTIVE Skill/Policy, or access credentials.

A deterministic proposer/test double remains available so reproducibility tests do not depend on external LLM calls.

### 4.6 Negative transfer defense

Reject backend-specific evidence compiled into GENERAL scope without promotion evidence.

### 4.7 Acceptance tests

- STRONG → candidate
- OBSERVED → none
- CONTRADICTED → blocked
- Dify-specific stays backend-specific
- related patterns merge into one candidate
- source patterns referenced
- same deterministic input → stable provenance
- malformed proposer output rejected
- oversized skill rejected

---

## Phase 5 — Skill Replay and Registry

Pipeline:

`Candidate Skill → SkillReplay → SkillEvaluator → SkillRegistry`

No automatic production Canary. Maximum automatic state: REPLAY_PASSED.

### 5.1 SkillRegistry states

- DRAFT
- WIKI_SUPPORTED
- REPLAY_PASSED
- REPLAY_FAILED
- NEEDS_REVIEW
- ACTIVE
- ROLLED_BACK
- DEPRECATED

### 5.2 Replay comparison

Use identical benchmark conditions for:

- NO_SKILL
- BASELINE_SKILL
- CANDIDATE_SKILL

Hold task/model/backend/tool availability/context budget/evaluation criteria constant.

Metrics:

- task success
- tool success
- tool retry
- context usage
- token usage
- latency
- cost
- error rate
- quality score only when a reliable evaluator exists

Never fabricate unobservable quality.

### 5.3 Transfer validation

GENERAL requires multiple clients/models where available. Detect regression and allow deterministic scope downgrade to CLIENT_SPECIFIC or MODEL_SPECIFIC when evidence supports it.

### 5.4 Failure semantics

Replay failure updates Skill state and PatternImpactTracker but never deletes Wiki evidence.

### 5.5 Required cases

- A: 70% → 84%, retries down, tokens reasonable → REPLAY_PASSED
- B: Model A +15%, Model B -12%, GENERAL → NEEDS_REVIEW / scope downgrade
- C: tokens -20%, task success -8% → REPLAY_FAILED
- D: rejected Skill leaves Wiki evidence intact

---

## Phase 6 — EvolutionController integration

Only after Phases 1–5 pass independently.

Coordinate but do not merge these state machines:

### Policy Evolution

`Decision Events → Analyzer → PolicyCandidate → HistoricalReplay → Canary → Guardrail → Promotion/Rollback`

### Skill Evolution

`KnowledgeExperience → Wiki Pattern → SkillCandidate → SkillReplay → Validation → SkillRegistry`

### 6.1 Scheduled analysis

Support independently configurable enable/disable/freeze/resume for:

- Experience compilation
- Pattern mining
- Wiki maintenance
- Policy analysis
- Skill candidate discovery

### 6.2 Production authority

- LLM → researcher/proposer only
- Replay → validation
- Canary → production evidence
- Guardrail → promotion authority
- Stable ACTIVE → fallback authority

### 6.3 Permanent knowledge layer

Policy rollback, Skill rollback, Canary failure, and Replay failure append evidence; none deletes Wiki history.

### 6.4 Runtime Skill Selection

Runtime path:

`Gateway Wiki → Skill Registry → deterministic Skill Selector → small relevant skill set → Agent`

Never inject the whole Wiki. Selection matches client/backend/model/taskType/requiredCapabilities/scope.

### 6.5 Governance

Add audited controls:

- freezePolicyEvolution
- freezeSkillEvolution
- manualPolicyRollback
- manualSkillRollback
- pinPolicyVersion
- pinSkillVersion
- disableAutoPromotion

### 6.6 Provenance observability

Must answer deterministically:

- why a Pattern exists and which Experiences support it
- why a Skill exists and which Patterns support it
- why a Skill passed/failed
- which Skill affected which tasks
- which Policy affected which requests
- why a rollback occurred

### 6.7 Final E2E

Success loop:

`Runtime experiences → Pattern discovered → strengthened → Skill candidate → Replay passed → registered → Runtime selection → new outcome → PatternImpact updated`

Failure loop:

`Skill candidate → Replay regression → REPLAY_FAILED → Wiki retained → failure becomes evidence`

Also verify Policy Evolution and Skill Evolution can freeze/rollback independently.

## Completion definition

The full roadmap is complete only when all six phase gates pass their dedicated tests and relevant existing regression suites. After completion, send a concise Slack notification containing final HEAD, CI evidence, implemented phases, known independent failures/blocked external tests, and confirmation that no unrequested production authority was introduced.
