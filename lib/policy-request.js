import { getPolicyRuntime } from './policy-runtime.js';

export function gatewaySessionIdentity(req) {
  return req.headers?.['x-dsh-conversation-id']
    || req.headers?.['x-session-id']
    || req.body?.dsh_conversation_id
    || req.body?.session_id
    || req.body?.user
    || '';
}

export function selectPolicyForRequest(req, res, env = process.env) {
  const runtime = getPolicyRuntime(env);
  if (!runtime) return null;
  const selection = runtime.controlPlane.selectPolicy({ sessionId: String(gatewaySessionIdentity(req)) });
  res.locals ??= {};
  res.locals.gatewayPolicySelection = selection;
  return selection;
}
