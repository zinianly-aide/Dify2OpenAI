import { BackendRegistry } from './backend-registry.js';

export function backendRegistryConfigFromEnv(env = process.env) {
  const raw = env.GATEWAY_BACKENDS_JSON;
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('GATEWAY_BACKENDS_JSON_INVALID'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('GATEWAY_BACKENDS_JSON_EMPTY');
  return parsed.map((entry) => {
    const backend = { ...entry };
    if (backend.apiKeyEnv) {
      backend.credentialEnv = String(backend.apiKeyEnv);
      delete backend.apiKeyEnv;
    }
    return backend;
  });
}

export function createBackendRegistryFromEnv(env = process.env) {
  const config = backendRegistryConfigFromEnv(env);
  return config ? new BackendRegistry(config) : null;
}

export function backendCredentialResolverFromEnv(env = process.env) {
  return (backend) => {
    const record = backend?.credentialEnv || backend?.apiKeyEnv;
    if (!record) return {};
    const apiKey = env[String(record)];
    return apiKey ? { apiKey } : {};
  };
}
