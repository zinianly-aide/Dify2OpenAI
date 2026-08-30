export const BackendProviderType = Object.freeze({
  DIFY: 'dify',
  OPENAI_COMPATIBLE: 'openai-compatible',
  LOCAL_OPENAI_COMPATIBLE: 'local-openai-compatible',
});

export const BackendContextMode = Object.freeze({
  STATEFUL: 'stateful',
  STATELESS: 'stateless',
});

export const BackendCostTier = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

export class BackendCapabilities {
  constructor(input = {}) {
    this.maxContextWindow = Number.isFinite(Number(input.maxContextWindow)) && Number(input.maxContextWindow) > 0
      ? Number(input.maxContextWindow)
      : undefined;
    this.supportsTools = input.supportsTools === true;
    this.supportsVision = input.supportsVision === true;
    this.supportsStreaming = input.supportsStreaming !== false;
    this.supportsReasoning = input.supportsReasoning === true;
    this.contextMode = input.contextMode === BackendContextMode.STATEFUL || input.statefulContext === true
      ? BackendContextMode.STATEFUL
      : BackendContextMode.STATELESS;
    this.costTier = Object.values(BackendCostTier).includes(input.costTier) ? input.costTier : BackendCostTier.MEDIUM;
    Object.freeze(this);
  }
}

function normalizeBackend(input = {}) {
  if (!input.backendId) throw new Error('BACKEND_ID_REQUIRED');
  if (!Object.values(BackendProviderType).includes(input.providerType)) throw new Error(`BACKEND_PROVIDER_TYPE_INVALID:${input.backendId}`);
  if (!input.baseUrl) throw new Error(`BACKEND_BASE_URL_REQUIRED:${input.backendId}`);
  return Object.freeze({
    backendId: String(input.backendId),
    providerType: input.providerType,
    baseUrl: String(input.baseUrl).replace(/\/$/, ''),
    model: input.model === undefined ? undefined : String(input.model),
    enabled: input.enabled !== false,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
    capabilities: new BackendCapabilities({
      maxContextWindow: input.maxContextWindow ?? input.capabilities?.maxContextWindow,
      supportsTools: input.supportsTools ?? input.capabilities?.supportsTools,
      supportsVision: input.supportsVision ?? input.capabilities?.supportsVision,
      supportsStreaming: input.supportsStreaming ?? input.capabilities?.supportsStreaming,
      supportsReasoning: input.supportsReasoning ?? input.capabilities?.supportsReasoning,
      statefulContext: input.statefulContext,
      contextMode: input.capabilities?.contextMode,
      costTier: input.costTier ?? input.capabilities?.costTier,
    }),
  });
}

export class BackendRegistry {
  constructor(backends = []) {
    this.backends = new Map();
    for (const backend of backends) this.register(backend);
  }

  register(input) {
    const backend = normalizeBackend(input);
    if (this.backends.has(backend.backendId)) throw new Error(`BACKEND_ALREADY_REGISTERED:${backend.backendId}`);
    this.backends.set(backend.backendId, backend);
    return backend;
  }

  upsert(input) {
    const backend = normalizeBackend(input);
    this.backends.set(backend.backendId, backend);
    return backend;
  }

  get(backendId) { return this.backends.get(String(backendId)) || null; }

  list({ enabledOnly = true } = {}) {
    return [...this.backends.values()]
      .filter((backend) => !enabledOnly || backend.enabled)
      .sort((a, b) => a.priority - b.priority || a.backendId.localeCompare(b.backendId));
  }

  capabilities(backendId) { return this.get(backendId)?.capabilities || null; }
}
