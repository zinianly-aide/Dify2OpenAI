import { createHash } from 'node:crypto';
import { CANARY_STAGES, PolicyStatus } from './policy-registry.js';

export const CANARY_PERCENT = Object.freeze({
  [PolicyStatus.CANARY_5]: 5,
  [PolicyStatus.CANARY_20]: 20,
  [PolicyStatus.CANARY_50]: 50,
});

export function stableCanaryBucket(sessionId, policyVersion) {
  const session = String(sessionId || '');
  const version = String(policyVersion || '');
  if (!session) throw new Error('GATEWAY_SESSION_REQUIRED');
  if (!version) throw new Error('POLICY_VERSION_REQUIRED');
  const digest = createHash('sha256').update(`${session}\u0000${version}`, 'utf8').digest();
  return digest.readUInt32BE(0) % 100;
}

function stageRank(status) {
  const index = CANARY_STAGES.indexOf(status);
  return index < 0 ? -1 : index;
}

export class StableCanaryAssignment {
  constructor({ registry } = {}) {
    this.registry = registry;
  }

  select({ sessionId } = {}) {
    if (!this.registry) throw new Error('POLICY_REGISTRY_REQUIRED');
    const active = this.registry.getActive();
    if (!active) throw new Error('ACTIVE_POLICY_REQUIRED');
    const candidates = this.registry.list()
      .filter((policy) => CANARY_STAGES.includes(policy.status))
      .sort((a, b) => stageRank(b.status) - stageRank(a.status) || a.createdAt.localeCompare(b.createdAt) || a.policyVersion.localeCompare(b.policyVersion));

    for (const candidate of candidates) {
      const bucket = stableCanaryBucket(sessionId, candidate.policyVersion);
      const percent = CANARY_PERCENT[candidate.status];
      if (bucket < percent) {
        return Object.freeze({
          selectedPolicyVersion: candidate.policyVersion,
          policyAssignment: 'CANARY',
          canaryStage: candidate.status,
          canaryBucket: bucket,
          canaryPercent: percent,
          config: candidate.config,
        });
      }
    }
    const reference = candidates[0] || null;
    return Object.freeze({
      selectedPolicyVersion: active.policyVersion,
      policyAssignment: 'ACTIVE_BASELINE',
      canaryStage: reference?.status ?? null,
      canaryBucket: reference ? stableCanaryBucket(sessionId, reference.policyVersion) : null,
      canaryPercent: reference ? CANARY_PERCENT[reference.status] : 0,
      config: active.config,
    });
  }
}
