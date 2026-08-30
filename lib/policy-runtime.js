import {
  GuardrailMonitor,
  PolicyControlPlane,
  PolicyRegistry,
} from '../packages/dify-core/index.js';

let runtime;
let runtimeSource;

function parsePolicies(raw) {
  const parsed = JSON.parse(String(raw || '[]'));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('GATEWAY_POLICIES_JSON_REQUIRES_NONEMPTY_ARRAY');
  return parsed;
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
  return Object.freeze({ registry, monitor, controlPlane });
}

export function getPolicyRuntime(env = process.env) {
  const source = String(env.GATEWAY_POLICIES_JSON || '');
  if (!source) return null;
  if (runtime && runtimeSource === source) return runtime;
  runtime = createPolicyRuntimeFromEnv(env);
  runtimeSource = source;
  return runtime;
}

export function resetPolicyRuntimeForTests() {
  runtime = undefined;
  runtimeSource = undefined;
}
