import z from '@deepseek-ai/schemastery';
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm';
import { DifyAdapter } from './native-adapter.js';
import { ToolAttachmentBridge, mergeAttachments } from './tool-attachment-bridge.js';

export { DifyAdapter } from './native-adapter.js';

export const name = 'llm-dify';
export const inject = ['llm', 'tools'];

const appSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  baseURL: z.string(),
  apiKeyEnv: z.string(),
  contextWindow: z.number().step(1).min(1),
});

const compressionSchema = z.object({
  toolPruneThreshold: z.number().min(0).max(1),
  lightThreshold: z.number().min(0).max(1),
  heavyThreshold: z.number().min(0).max(1),
  forceThreshold: z.number().min(0).max(1),
  preservedRecentTurns: z.number().step(1).min(0),
  lightSummaryMaxChars: z.number().step(1).min(0),
  heavySummaryMaxChars: z.number().step(1).min(0),
});

export const Config = z.object({
  providerId: z.string().default('dify'),
  baseURL: z.string(),
  apiKeyEnv: z.string().default('DIFY_API_KEY'),
  timeoutMs: z.number().step(1).min(1).default(120000),
  apps: z.array(appSchema).min(1),
  compression: compressionSchema,
});

function normalizeApps(config) {
  const source = config.apps?.length ? config.apps : [{ id: 'default', name: 'Dify' }];
  const seen = new Set();
  return source.map((raw) => {
    if (!raw.id || seen.has(raw.id)) throw new Error(`dsh-dify-provider requires unique non-empty app ids; duplicate "${raw.id || ''}"`);
    seen.add(raw.id);
    return {
      id: raw.id,
      name: raw.name || raw.id,
      baseURL: raw.baseURL || config.baseURL || process.env.DIFY_API_URL,
      apiKeyEnv: raw.apiKeyEnv || config.apiKeyEnv || 'DIFY_API_KEY',
      ...(raw.contextWindow ? { contextWindow: raw.contextWindow } : {}),
    };
  });
}

function emitBridgeDiagnostic(ctx, event) {
  const line = JSON.stringify({ component: 'dify-tool-attachment-bridge', ...event });
  if (ctx.logger?.info) ctx.logger.info(line);
  if (process.env.DIFY_TELEMETRY_STDOUT === '1') console.log(line);
}

export function apply(ctx, config) {
  const providerId = String(config.providerId || 'dify').trim();
  if (!providerId) throw new Error('dsh-dify-provider providerId must be non-empty');
  const apps = normalizeApps(config);
  const toolAttachments = new ToolAttachmentBridge();

  const resolveApiKey = async (app) => {
    const ref = String(app.apiKeyEnv || 'DIFY_API_KEY');
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'dsh-dify-provider', ref);
    }
    const ambient = process.env[ref];
    if (ambient) return assertUsableApiKey(ambient, 'dsh-dify-provider', ref);
    throw new LlmError(
      `dsh-dify-provider has no API key for Dify app "${app.id}"; configure credential ref ${ref} or export it`,
      'MISSING_CREDENTIAL',
    );
  };

  const readDshAttachment = async (ref, signal) => {
    const attachments = ctx.get('attachments');
    if (attachments === undefined || typeof attachments.readImage !== 'function') {
      throw new LlmError('DSH attachment store is unavailable for image input', 'ATTACHMENT_STORE_UNAVAILABLE');
    }
    return attachments.readImage(ref, signal);
  };

  const adapter = new DifyAdapter({
    providerId,
    apps,
    timeoutMs: config.timeoutMs || 120000,
    resolveApiKey,
    readDshAttachment,
    logger: ctx.logger,
    compressionConfig: config.compression,
  });

  ctx.on('tools/result', (exec, result) => {
    const blockTypes = Array.isArray(result?.content)
      ? result.content.map((block) => String(block?.type || 'unknown').slice(0, 40))
      : [];
    const imageBlockCount = blockTypes.filter((type) => type === 'image').length;
    let captured = false;
    try {
      captured = toolAttachments.capture(exec, result);
    } catch (error) {
      if (ctx.logger?.warn) ctx.logger.warn(`dsh-dify-provider ignored malformed read_image attachment: ${String(error?.code || error?.name || 'invalid_attachment')}`);
    }
    emitBridgeDiagnostic(ctx, {
      event: 'tools/result',
      toolName: String(exec?.name || '').slice(0, 80),
      hasCallId: Boolean(exec?.callId),
      isError: Boolean(result?.isError),
      contentBlockTypes: blockTypes,
      imageBlockCount,
      captured,
    });
  });

  const stream = adapter.stream.bind(adapter);
  adapter.stream = async function* streamWithToolOwnership(options) {
    for await (const chunk of stream(options)) {
      if (chunk?.type === 'block-end' && chunk?.block?.type === 'tool-call') {
        const registered = toolAttachments.registerOwnership(options?.sessionId, chunk.block.id);
        emitBridgeDiagnostic(ctx, {
          event: 'tool-call-ownership',
          toolName: String(chunk.block.name || '').slice(0, 80),
          hasCallId: Boolean(chunk.block.id),
          hasSessionId: options?.sessionId !== undefined && options?.sessionId !== null,
          registered,
        });
      }
      yield chunk;
    }
  };

  const collect = adapter.collect.bind(adapter);
  adapter.collect = async (app, body, signal, attachments = []) => {
    const pending = toolAttachments.resolve(body?.user, body?.query);
    const merged = mergeAttachments(attachments, pending.attachments);
    if (pending.callIds.length || pending.attachments.length) {
      emitBridgeDiagnostic(ctx, {
        event: 'continuation-resolve',
        matchedToolCallCount: pending.callIds.length,
        attachmentCount: pending.attachments.length,
      });
    }
    const response = await collect(app, body, signal, merged);
    if (pending.callIds.length) toolAttachments.consume(body?.user, pending.callIds);
    return response;
  };

  const resetSession = adapter.resetSession.bind(adapter);
  adapter.resetSession = (sessionId, appId) => {
    toolAttachments.clearSession(sessionId);
    return resetSession(sessionId, appId);
  };

  ctx.llm.registerAdapter([providerId], adapter);
}
