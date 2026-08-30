import {
  GuardrailMonitor,
  PolicyControlPlane,
  PolicyRegistry,
} from '../packages/dify-core/index.js';

let runtime;
let runtimeSource;
let cachedStableActivePolicy;

function parsePolicies(raw) {
  const parsed = JSON.parse(String(raw || '[]'));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('GATEWAY_POLICIES_JSON_REQUIRES_NONEMPTY_ARRAY');
  return parsed;
}

function rememberStableActive(runtimeValue) {
  try {
    const active = runtimeValue?.registry?.getActive?.();
    if (active) cachedStableActivePolicy = active;
  } catch {}
}

export function createPolicyRuntimeFromEnv(env = process.env) {
  if (!env.GATEWAY_POLICIES_JSON) return null;
  const policies = parsePolicies(env.GATEWAY_POLICIES_JSON);
  const registry = new PolicyRegistry({
    policies,
    frozen: String(env.GATEWAY_POLICY_EVOLUTION_FROZEN || '').toLowerCase() === 'true',
    autoPromotionEnabled: String(env.GATEWAY_AUTO_PROMOTION_ENABLED || 'true').toLowerCase() !== 'false',
  });
  const monitor = new GuardrailMonitor();
  const controlPlane = new PolicyControlPlane({ registry, monitor });
  const value = Object.freeze({ registry, monitor, controlPlane });
  rememberStableActive(value);
  return value;
}

export function getPolicyRuntime(env = process.env) {
  const source = String(env.GATEWAY_POLICIES_JSON || '');
  if (!source) return null;
  if (runtime && runtimeSource === source) {
    rememberStableActive(runtime);
    return runtime;
  }
  const nextRuntime = createPolicyRuntimeFromEnv(env);
  runtime = nextRuntime;
  runtimeSource = source;
  rememberStableActive(runtime);
  return runtime;
}

export function cachedStablePolicySelection(reason = 'POLICY_RUNTIME_UNAVAILABLE') {
  if (!cachedStableActivePolicy) return null;
  return Object.freeze({
    selectedPolicyVersion: cachedStableActivePolicy.policyVersion,
    policyAssignment: 'STABLE_ACTIVE_FAIL_OPEN',
    canaryStage: null,
    canaryBucket: null,
    canaryPercent: 0,
    config: cachedStableActivePolicy.config,
    selectionFallbackReason: String(reason || 'POLICY_RUNTIME_UNAVAILABLE').slice(0, 128),
  });
}

export function resetPolicyRuntimeForTests() {
  runtime = undefined;
  runtimeSource = undefined;
  cachedStableActivePolicy = undefined;
}
