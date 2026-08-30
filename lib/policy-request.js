import { cachedStablePolicySelection, getPolicyRuntime } from './policy-runtime.js';

export function gatewaySessionIdentity(req) {
  return req.headers?.['x-dsh-conversation-id']
    || req.headers?.['x-session-id']
    || req.body?.dsh_conversation_id
    || req.body?.session_id
    || req.body?.user
    || '';
}

export function selectPolicyForRequest(req, res, env = process.env) {
  res.locals ??= {};
  try {
    const runtime = getPolicyRuntime(env);
    if (!runtime) return null;
    const selection = runtime.controlPlane.selectPolicy({ sessionId: String(gatewaySessionIdentity(req)) });
    res.locals.gatewayPolicySelection = selection;
    return selection;
  } catch (error) {
    const fallback = cachedStablePolicySelection(error?.code || error?.message || 'POLICY_RUNTIME_UNAVAILABLE');
    if (!fallback) throw error;
    res.locals.gatewayPolicySelection = fallback;
    res.locals.gatewayGuardrail = {
      status: 'EVALUATION_FAILED',
      promotionEligible: false,
      reasonCodes: ['POLICY_RUNTIME_FAIL_OPEN_TO_STABLE_ACTIVE'],
    };
    return fallback;
  }
}
