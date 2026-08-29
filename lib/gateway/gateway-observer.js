import { performance } from 'node:perf_hooks';
import { CanonicalRequest, CanonicalResponse, backendIdFromUrl } from './canonical.js';
import { ContextProfiler } from './context-profiler.js';
import { DecisionEngine } from './decision-engine.js';
import { TelemetryCollector } from './telemetry-collector.js';

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function contextWindowOf(req) {
  return numeric(req.headers?.['x-context-window'])
    || numeric(req.body?.context_window)
    || numeric(process.env.GATEWAY_CONTEXT_WINDOW);
}

function contentCharsFromPayload(payload) {
  let chars = 0;
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
    if (typeof content === 'string') chars += content.length;
    const toolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) chars += String(call?.function?.arguments || '').length;
    }
  }
  return chars;
}

function inspectPayload(payload, state) {
  if (!payload || typeof payload !== 'object') return;
  const usage = payload.usage || payload.metadata?.usage;
  if (usage && typeof usage === 'object') {
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens);
    if (Number.isFinite(prompt) && prompt >= 0) state.promptTokens = prompt;
    if (Number.isFinite(completion) && completion >= 0) state.completionTokens = completion;
  }
  state.completionChars += contentCharsFromPayload(payload);
}

function inspectSseChunk(chunk, state) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { inspectPayload(JSON.parse(data), state); } catch {}
  }
}

export class GatewayObserver {
  constructor(options = {}) {
    this.profiler = options.profiler || new ContextProfiler();
    this.decisionEngine = options.decisionEngine || new DecisionEngine();
    this.telemetry = options.telemetry || new TelemetryCollector();
  }

  observe(req, res, routing = {}) {
    const startedAt = performance.now();
    const backendId = routing.backendId || backendIdFromUrl(routing.difyApiUrl);
    const canonicalRequest = CanonicalRequest.fromExpress(req, {
      traceId: routing.traceId,
      providerId: routing.providerId || req.headers?.['x-provider-id'] || 'dify',
      backendId,
      contextWindow: routing.contextWindow || contextWindowOf(req),
      policyVersion: this.decisionEngine.policyVersion,
    });
    const profile = this.profiler.profile(canonicalRequest);
    const decision = this.decisionEngine.decide(canonicalRequest, profile, {
      backendId,
      model: routing.model || canonicalRequest.model,
    });

    const state = {
      completionChars: 0,
      promptTokens: undefined,
      completionTokens: undefined,
      firstTokenAt: undefined,
      finalized: false,
    };
    const markFirst = () => { if (state.firstTokenAt === undefined) state.firstTokenAt = performance.now(); };
    const originalWrite = res.write.bind(res);
    const originalJson = res.json.bind(res);
    res.write = (chunk, ...args) => {
      if (chunk !== undefined && chunk !== null && String(chunk).length > 0) markFirst();
      inspectSseChunk(chunk, state);
      return originalWrite(chunk, ...args);
    };
    res.json = (payload) => {
      markFirst();
      inspectPayload(payload, state);
      return originalJson(payload);
    };

    const finalize = () => {
      if (state.finalized) return;
      state.finalized = true;
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      const firstTokenLatencyMs = state.firstTokenAt === undefined
        ? undefined
        : Math.max(0, Math.round(state.firstTokenAt - startedAt));
      const completionTokens = state.completionTokens ?? Math.ceil(state.completionChars / 4);
      const success = res.statusCode >= 200 && res.statusCode < 400;
      const response = new CanonicalResponse({
        traceId: canonicalRequest.traceId,
        success,
        latencyMs,
        ...(firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs }),
        ...(state.promptTokens === undefined ? {} : { promptTokens: state.promptTokens }),
        completionTokens,
        retryCount: Number(res.locals?.gatewayRetryCount || 0),
        ...success ? {} : { errorType: String(res.locals?.gatewayErrorType || `http_${res.statusCode}`) },
      });
      this.telemetry.collect(canonicalRequest, decision, response);
    };
    res.once('finish', finalize);
    res.once('close', finalize);

    return { canonicalRequest, profile, decision };
  }
}

export const gatewayObserver = new GatewayObserver();
