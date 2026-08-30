import { GuardrailStatus } from './guardrail-monitor.js';
import { StableCanaryAssignment } from './canary-assignment.js';
import { PolicyStatus } from './policy-registry.js';

export class PromotionController {
  constructor({ registry, monitor } = {}) {
    this.registry = registry;
    this.monitor = monitor;
    this.lastStableActivePolicy = registry?.getActive?.() || null;
  }

  #refreshStableActive() {
    const active = this.registry?.getActive?.();
    if (active) this.lastStableActivePolicy = active;
    return active || this.lastStableActivePolicy;
  }

  startCanary(policyVersion, { timestamp } = {}) {
    const policy = this.registry?.get?.(policyVersion);
    if (!policy) throw new Error('POLICY_NOT_FOUND');
    if (policy.status !== PolicyStatus.REPLAY_PASSED) throw new Error('CANARY_REQUIRES_REPLAY_PASSED');
    return this.registry.transition(policyVersion, PolicyStatus.CANARY_5, {
      evaluationSnapshotId: policy.evidence?.replayDatasetId || null,
      reasonCodes: ['REPLAY_ACCEPTED_FOR_CANARY'],
      timestamp,
    });
  }

  evaluateAndPromote(policyVersion, { observationEnd } = {}) {
    try {
      const policy = this.registry?.get?.(policyVersion);
      const active = this.registry?.getActive?.();
      if (!policy || !active) return Object.freeze({ status: GuardrailStatus.EVALUATION_FAILED, reasonCodes: Object.freeze(['POLICY_REGISTRY_UNAVAILABLE']) });
      if (![PolicyStatus.CANARY_5, PolicyStatus.CANARY_20, PolicyStatus.CANARY_50].includes(policy.status)) {
        return Object.freeze({ status: GuardrailStatus.EVALUATION_FAILED, reasonCodes: Object.freeze(['POLICY_NOT_IN_CANARY_STAGE']) });
      }
      if (this.registry.frozen) return Object.freeze({ status: GuardrailStatus.HOLD_FOR_REVIEW, reasonCodes: Object.freeze(['POLICY_EVOLUTION_FROZEN']) });
      if (!this.registry.autoPromotionEnabled) return Object.freeze({ status: GuardrailStatus.HOLD_FOR_REVIEW, reasonCodes: Object.freeze(['AUTO_PROMOTION_DISABLED']) });
      const validation = this.registry.validatePolicy(policyVersion);
      if (!validation.valid) {
        const rollback = this.#autoRollback(policy, active, ['POLICY_VALIDATION_FAILURE'], observationEnd);
        return Object.freeze({ status: GuardrailStatus.AUTO_ROLLBACK, reasonCodes: Object.freeze(['POLICY_VALIDATION_FAILURE']), rollback });
      }
      const snapshot = this.monitor.evaluate({
        policyVersion,
        baselinePolicyVersion: active.policyVersion,
        stage: policy.status,
        observationStart: policy.stageEnteredAt,
        observationEnd,
      });
      if (snapshot.guardrailResults.status === GuardrailStatus.AUTO_ROLLBACK) {
        const rollback = this.#autoRollback(policy, active, snapshot.guardrailResults.reasonCodes, observationEnd);
        return Object.freeze({ status: GuardrailStatus.AUTO_ROLLBACK, reasonCodes: snapshot.guardrailResults.reasonCodes, snapshot, rollback });
      }
      if (snapshot.guardrailResults.status !== GuardrailStatus.ELIGIBLE_FOR_PROMOTION) {
        return Object.freeze({ status: snapshot.guardrailResults.status, reasonCodes: snapshot.guardrailResults.reasonCodes, snapshot });
      }
      const targetStage = this.registry.nextStage(policyVersion);
      if (!targetStage) return Object.freeze({ status: GuardrailStatus.EVALUATION_FAILED, reasonCodes: Object.freeze(['NO_VALID_PROMOTION_TARGET']), snapshot });
      const promoted = this.registry.transition(policyVersion, targetStage, {
        evaluationSnapshotId: snapshot.snapshotId,
        reasonCodes: snapshot.guardrailResults.reasonCodes,
        timestamp: observationEnd,
      });
      if (targetStage === PolicyStatus.ACTIVE) this.#refreshStableActive();
      return Object.freeze({
        status: GuardrailStatus.ELIGIBLE_FOR_PROMOTION,
        reasonCodes: snapshot.guardrailResults.reasonCodes,
        snapshot,
        promotion: Object.freeze({
          policyVersion,
          sourceStage: policy.status,
          targetStage,
          evaluationSnapshotId: snapshot.snapshotId,
          reasonCodes: snapshot.guardrailResults.reasonCodes,
          timestamp: observationEnd,
        }),
        policy: promoted,
      });
    } catch (error) {
      return Object.freeze({
        status: GuardrailStatus.EVALUATION_FAILED,
        reasonCodes: Object.freeze(['GUARDRAIL_EVALUATION_FAILED', String(error?.code || error?.message || 'UNKNOWN_ERROR').slice(0, 128)]),
      });
    }
  }

  #autoRollback(policy, active, reasonCodes, timestamp) {
    if (!active || active.policyVersion === policy.policyVersion) throw new Error('STABLE_ACTIVE_ROLLBACK_TARGET_REQUIRED');
    const targetValidation = this.registry.validatePolicy(active.policyVersion);
    if (!targetValidation.valid) throw new Error('ROLLBACK_TARGET_INVALID');
    const result = this.registry.rollback(policy.policyVersion, {
      targetPolicyVersion: active.policyVersion,
      reasonCodes,
      timestamp,
    });
    this.lastStableActivePolicy = result.targetPolicy;
    return Object.freeze({
      rollbackTriggered: true,
      rollbackReason: [...reasonCodes],
      rollbackTargetPolicy: result.targetPolicy.policyVersion,
    });
  }

  manualPromote(policyVersion, { timestamp, reasonCodes = ['MANUAL_PROMOTION'] } = {}) {
    const target = this.registry.nextStage(policyVersion);
    if (!target) throw new Error('NO_VALID_PROMOTION_TARGET');
    const result = this.registry.transition(policyVersion, target, { timestamp, reasonCodes, manual: true });
    if (target === PolicyStatus.ACTIVE) this.#refreshStableActive();
    return result;
  }

  manualRollback(policyVersion, targetPolicyVersion, { timestamp, reasonCodes = ['MANUAL_ROLLBACK'] } = {}) {
    const result = this.registry.rollback(policyVersion, { targetPolicyVersion, timestamp, reasonCodes, manual: true });
    this.lastStableActivePolicy = result.targetPolicy;
    return result;
  }
}

export class PolicyControlPlane {
  constructor({ registry, monitor } = {}) {
    this.registry = registry;
    this.monitor = monitor;
    this.assignment = new StableCanaryAssignment({ registry });
    this.promotion = new PromotionController({ registry, monitor });
    this.stableActivePolicy = registry?.getActive?.() || null;
  }

  selectPolicy({ sessionId } = {}) {
    try {
      const selected = this.assignment.select({ sessionId });
      const active = this.registry.getActive();
      if (active) this.stableActivePolicy = active;
      const validation = this.registry.validatePolicy(selected.selectedPolicyVersion);
      if (!validation.valid) throw new Error('SELECTED_POLICY_VALIDATION_FAILED');
      return selected;
    } catch (error) {
      const stable = this.stableActivePolicy;
      if (!stable) throw error;
      return Object.freeze({
        selectedPolicyVersion: stable.policyVersion,
        policyAssignment: 'STABLE_ACTIVE_FAIL_OPEN',
        canaryStage: null,
        canaryBucket: null,
        canaryPercent: 0,
        config: stable.config,
        selectionFallbackReason: String(error?.code || error?.message || 'POLICY_SELECTION_FAILED').slice(0, 128),
      });
    }
  }
}
