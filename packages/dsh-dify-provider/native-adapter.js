import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import {
  CanonicalRequest,
  CanonicalResponse,
  CheckpointRecommendation,
  CompressionPolicy,
  CompressionQualityGuard,
  ContextCompressor,
  ContextProfiler,
  ConversationState,
  DecisionEngine,
  DifyUsageExtractor,
  MemoryConversationStore,
  TelemetryCollector,
  ToolExecutionLedger,
  ToolSchemaRegistry,
  backendIdFromUrl,
  checkpointRecommendationConfigFromEnv,
  compressionConfigFromEnv,
  compressionQualityConfigFromEnv,
  currentImageAttachments,
  isInvalidConversationError,
  reconcileBackendContext,
  resolveConversationState,
  resolveDifyFiles,
  sha256,
  streamDifyChat,
} from '@zinianly-aide/dify-core';
import {
  deltaHistory,
  findToolCall,
  fullHistory,
  messagesAfterOwnAssistant,
  parseToolCalls,
  schemaInstruction,
  serializeMessage,
  tailToolResults,
  toolResultsOf,
} from './message-converter.js';
import { emitTrace, newTraceId, sessionHash } from './observability.js';

const n = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const difyUsageExtractor = new DifyUsageExtractor();

function usageOf(metadata) {
  const extracted = difyUsageExtractor.extract({ metadata });
  const raw = metadata?.usage;
  if (!extracted && !raw) return undefined;
  const totalTokens = n(raw?.total_tokens);
  return {
    inputTokens: extracted?.backendPromptTokens ?? 0,
    outputTokens: extracted?.backendCompletionTokens ?? 0,
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function errorType(error) {
  return String(error?.code || error?.name || 'unknown_error').slice(0, 120);
}

function ledgerInput(sessionId, providerId, appId, call) {
  return {
    providerId,
    appId,
    conversationId: sessionId,
    toolCallId: String(call.id),
    arguments: call.arguments || '{}',
  };
}

export class DifyAdapter extends LlmAdapter {
  constructor({
    providerId,
    apps,
    timeoutMs = 120000,
    resolveApiKey,
    readDshAttachment,
    logger,
    compressionConfig,
    compressionQualityConfig,
    checkpointRecommendationConfig,
  }) {
    super();
    this.providerId = providerId;
    this.apps = new Map(apps.map((app) => [app.id, Object.freeze({ ...app })]));
    this.timeoutMs = timeoutMs;
    this.resolveApiKey = resolveApiKey;
    this.readDshAttachment = readDshAttachment;
    this.logger = logger;
    this.conversations = new MemoryConversationStore();
    this.toolSchemas = new ToolSchemaRegistry();
    this.toolLedger = new ToolExecutionLedger();
    this.contextProfiler = new ContextProfiler();
    const compressionPolicy = new CompressionPolicy(compressionConfig || compressionConfigFromEnv());
    this.contextCompressor = new ContextCompressor({ policy: compressionPolicy });
    this.compressionQualityGuard = new CompressionQualityGuard({
      config: compressionQualityConfig || compressionQualityConfigFromEnv(),
    });
    this.checkpointRecommendation = new CheckpointRecommendation({
      config: checkpointRecommendationConfig || checkpointRecommendationConfigFromEnv(),
    });
    this.decisionEngine = new DecisionEngine({ compressionPolicy });
    this.telemetry = new TelemetryCollector({
      sink: (payload) => {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          component: 'gateway-decision',
          source: 'dsh-dify-provider',
          ...payload,
        });
        if (this.logger?.info) this.logger.info(line);
        if (!this.logger?.info || process.env.DIFY_TELEMETRY_STDOUT === '1') console.log(line);
      },
    });
  }

  providerInfo(provider) {
    return { id: provider, name: 'Dify' };
  }

  listModels(provider) {
    if (provider !== this.providerId) return Promise.resolve([]);
    return Promise.resolve([...this.apps.values()].map((app) => ({
      provider,
      id: app.id,
      name: app.name || app.id,
      inputModalities: ['text', 'image'],
    })));
  }

  resolveModel(provider, model) {
    const app = provider === this.providerId ? this.apps.get(model) : undefined;
    if (!app) return Promise.reject(new LlmError(`unknown Dify route ${provider}/${model}`, 'UNKNOWN_MODEL'));
    return Promise.resolve({
      provider,
      id: model,
      name: app.name || model,
      inputModalities: ['text', 'image'],
      ...(app.contextWindow ? { context: { contextWindow: app.contextWindow } } : {}),
    });
  }

  resetSession(sessionId, appId) {
    this.conversations.resetProvider(String(sessionId), this.providerId, appId);
  }

  telemetrySnapshot() {
    return this.telemetry.snapshot();
  }

  async collect(app, body, signal, attachments = []) {
    if (!app.baseURL) throw new LlmError(`Dify app "${app.id}" has no baseURL`, 'MISSING_CONFIG');
    const apiKey = await this.resolveApiKey(app);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let answer = '';
    let conversationId = body.conversation_id || '';
    let usage;
    let firstTokenAt;
    try {
      const files = await resolveDifyFiles({
        baseURL: app.baseURL,
        apiKey,
        attachments,
        user: body.user,
        signal: requestSignal,
        headers: attributionHeaders(),
        readDshAttachment: this.readDshAttachment,
      });
      const requestBody = files.length ? { ...body, files } : body;
      for await (const event of streamDifyChat({
        baseURL: app.baseURL,
        apiKey,
        body: requestBody,
        signal: requestSignal,
        headers: attributionHeaders(),
      })) {
        if (event?.conversation_id) conversationId = String(event.conversation_id);
        if (event?.event === 'message' || event?.event === 'agent_message') {
          if (typeof event.answer === 'string') {
            if (event.answer && firstTokenAt === undefined) firstTokenAt = Date.now();
            answer += event.answer;
          }
        } else if (event?.event === 'message_end') {
          usage = usageOf(event.metadata) || usage;
        } else if (event?.event === 'error') {
          throw new LlmError(event.message || 'Dify returned an error event', String(event.code || 'DIFY_ERROR'));
        } else if (event?.event === 'protocol_error') {
          throw new LlmError('Dify returned malformed SSE data', 'DIFY_PROTOCOL');
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeoutSignal.aborted) throw new LlmError(`Dify request timed out after ${this.timeoutMs}ms`, 'DIFY_TIMEOUT', { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(error?.message || 'Dify attachment processing failed', String(error?.code || 'DIFY_ATTACHMENT_ERROR'), { cause: error });
    }
    return { answer, conversationId, usage, firstTokenAt };
  }

  queryFor({ messages, system, tools, schema, strategy, providerId, appId }) {
    const history = strategy === 'FULL_BOOTSTRAP' || strategy === 'RECOVERY_BOOTSTRAP'
      ? fullHistory(messages, system)
      : deltaHistory(messages, providerId, appId);
    return [schemaInstruction(tools, schema.changed), history].filter(Boolean).join('\n\n');
  }

  bodyFor(sessionId, conversationId, query) {
    return {
      inputs: {},
      query,
      conversation_id: conversationId || '',
      user: `dsh-${sha256(sessionId).slice(0, 24)}`,
      auto_generate_name: false,
    };
  }

  recordToolResults(sessionId, providerId, appId, messages) {
    const forwarded = [];
    for (const message of messages) {
      for (const result of toolResultsOf(message)) {
        const call = findToolCall(messages, result.toolCallId);
        if (!call) continue;
        const input = ledgerInput(sessionId, providerId, appId, call);
        this.toolLedger.complete(input, serializeMessage(message));
        forwarded.push(input);
      }
    }
    return forwarded;
  }

  async *stream(options) {
    const startedAt = Date.now();
    const traceId = newTraceId();
    const providerId = options.provider;
    const appId = options.model;
    const sessionId = options.sessionId === undefined ? '' : String(options.sessionId);
    if (!sessionId) throw new LlmError('dsh-dify-provider requires GenerateOptions.sessionId', 'MISSING_SESSION_ID');
    if (providerId !== this.providerId) throw new LlmError(`provider "${providerId}" is not owned by dsh-dify-provider`, 'NO_ADAPTER');
    if (options.stop !== undefined) throw new LlmError('dsh-dify-provider does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION');
    const app = this.apps.get(appId);
    if (!app) throw new LlmError(`Dify app "${appId}" is not configured`, 'UNKNOWN_MODEL');

    const originalMessages = options.messages || [];
    const currentAttachments = currentImageAttachments(originalMessages, 'dsh');
    const canonicalRequest = CanonicalRequest.fromDsh(options, {
      traceId,
      providerId,
      backendId: backendIdFromUrl(app.baseURL),
      model: appId,
      contextWindow: app.contextWindow,
      policyVersion: this.decisionEngine.policyVersion,
    });
    const contextProfile = this.contextProfiler.profile(canonicalRequest);
    const decision = this.decisionEngine.decide(canonicalRequest, contextProfile, {
      backendId: canonicalRequest.backendId,
      model: appId,
    });
    const compression = this.compressionQualityGuard.run({
      messages: originalMessages,
      tools: options.tools || [],
      system: options.system,
      initialProfile: contextProfile,
      compressor: this.contextCompressor,
      profiler: this.contextProfiler,
    });
    const messages = compression.messages;
    let telemetryRecorded = false;
    const recordDecision = (fields) => {
      if (telemetryRecorded) return;
      telemetryRecorded = true;
      const backendReconciliation = reconcileBackendContext({
        gatewayEstimatedInputTokens: canonicalRequest.estimatedPromptTokens,
        gatewayCompressedTokens: compression.result.afterTokens,
        backendPromptTokens: fields.backendPromptTokens ?? fields.promptTokens,
        backendCompletionTokens: fields.backendCompletionTokens ?? fields.completionTokens,
      });
      const checkpoint = this.checkpointRecommendation.recommend({
        compressionResult: compression.result,
        reconciliation: backendReconciliation,
      });
      this.telemetry.collect(canonicalRequest, decision, new CanonicalResponse({
        latencyMs: Date.now() - startedAt,
        retryCount: 0,
        compressionResult: compression.result,
        backendReconciliation,
        checkpointRecommendation: checkpoint,
        ...fields,
      }));
    };

    try {
      if (options.purpose !== undefined) {
        const response = await this.collect(
          app,
          this.bodyFor(sessionId, '', fullHistory(messages, options.system)),
          options.signal,
          currentAttachments,
        );
        emitTrace(this.logger, {
          traceId,
          dshSessionIdHash: sessionHash(sessionId),
          providerId,
          difyAppId: appId,
          conversationState: 'AUXILIARY',
          hasDifyConversationId: false,
          attachmentCount: currentAttachments.length,
          toolCount: options.tools?.length || 0,
          toolSchemaChanged: false,
          toolCallCount: 0,
          toolResultCount: 0,
          compressionMode: compression.result.mode,
          compressionSavedTokens: compression.result.savedTokens,
          compressionPasses: compression.result.compressionPasses,
          compressionTargetReached: compression.result.targetReached,
          compressionUnableToReachTarget: compression.result.unableToReachTarget,
          retryCount: 0,
          latencyMs: Date.now() - startedAt,
          status: 'ok',
          purpose: options.purpose,
        });
        recordDecision({
          success: true,
          firstTokenLatencyMs: response.firstTokenAt === undefined ? undefined : response.firstTokenAt - startedAt,
          promptTokens: response.usage?.inputTokens,
          completionTokens: response.usage?.outputTokens,
          backendPromptTokens: response.usage?.inputTokens,
          backendCompletionTokens: response.usage?.outputTokens,
        });
        if (response.answer) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: response.answer };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: response.answer } };
        }
        if (response.usage) yield { type: 'usage', usage: response.usage };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      const tools = options.tools || [];
      const toolResults = tailToolResults(originalMessages);
      const schema = this.toolSchemas.resolve({ dshConversationId: sessionId, providerId, difyAppId: appId, tools });
      const resultInputs = this.recordToolResults(sessionId, providerId, appId, originalMessages);
      let remote = this.conversations.get(sessionId, providerId, appId);
      let resolved = resolveConversationState({ remoteState: remote, messages: originalMessages, toolResults });

      let retryCount = 0;
      const request = async (conversationId, strategy) => this.collect(
        app,
        this.bodyFor(sessionId, conversationId, this.queryFor({
          messages,
          system: options.system,
          tools,
          schema,
          strategy,
          providerId,
          appId,
        })),
        options.signal,
        currentAttachments,
      );

      let response;
      try {
        response = await request(remote?.conversationId || '', resolved.contextStrategy);
      } catch (error) {
        if (!(remote?.conversationId && isInvalidConversationError(error))) throw error;
        retryCount = 1;
        this.conversations.invalidate(sessionId, providerId, appId);
        resolved = resolveConversationState({ remoteState: remote, messages: originalMessages, toolResults, remoteInvalid: true });
        emitTrace(this.logger, {
          traceId,
          dshSessionIdHash: sessionHash(sessionId),
          providerId,
          difyAppId: appId,
          conversationState: ConversationState.RECOVER,
          hasDifyConversationId: true,
          attachmentCount: currentAttachments.length,
          toolCount: tools.length,
          toolSchemaChanged: schema.changed,
          toolCallCount: 0,
          toolResultCount: toolResults.length,
          compressionMode: compression.result.mode,
          compressionSavedTokens: compression.result.savedTokens,
          compressionPasses: compression.result.compressionPasses,
          compressionTargetReached: compression.result.targetReached,
          compressionUnableToReachTarget: compression.result.unableToReachTarget,
          retryCount,
          latencyMs: Date.now() - startedAt,
          status: 'recovering',
        });
        response = await request('', resolved.contextStrategy);
      }

      let conversationId = response.conversationId || remote?.conversationId || '';
      if (conversationId) {
        remote = this.conversations.set(sessionId, providerId, appId, {
          conversationId,
          valid: true,
          updatedAt: Date.now(),
          toolSchemaHash: schema.toolSchemaHash,
        });
      }
      for (const input of resultInputs) this.toolLedger.markForwarded(input);

      let answer = response.answer;
      let usage = response.usage;
      let firstTokenAt = response.firstTokenAt;
      let calls = parseToolCalls(answer);
      let emitted = [];
      let replayRounds = 0;
      while (calls.length && replayRounds < 3) {
        const replay = [];
        emitted = [];
        for (const call of calls) {
          const entry = this.toolLedger.begin(ledgerInput(sessionId, providerId, appId, call));
          if (entry.replay) replay.push({ call, result: entry.result });
          else if (!entry.duplicate) emitted.push(call);
        }
        if (emitted.length || replay.length === 0) break;
        replayRounds += 1;
        retryCount += 1;
        const replayQuery = replay.map(({ call, result }) => `tool_result tool_call_id=${call.id}: ${result}`).join('\n');
        const replayResponse = await this.collect(app, this.bodyFor(sessionId, conversationId, replayQuery), options.signal, []);
        answer = replayResponse.answer;
        usage = replayResponse.usage || usage;
        firstTokenAt = firstTokenAt || replayResponse.firstTokenAt;
        conversationId = replayResponse.conversationId || conversationId;
        if (conversationId) {
          this.conversations.set(sessionId, providerId, appId, {
            conversationId,
            valid: true,
            updatedAt: Date.now(),
            toolSchemaHash: schema.toolSchemaHash,
          });
        }
        calls = parseToolCalls(answer);
      }

      const gap = messagesAfterOwnAssistant(originalMessages, providerId, appId);
      const providerSwitch = gap.some((m) => m?.role === 'assistant' && m?.source?.kind === 'model'
        && (m.source.provider !== providerId || m.source.model !== appId));
      emitTrace(this.logger, {
        traceId,
        dshSessionIdHash: sessionHash(sessionId),
        providerId,
        difyAppId: appId,
        conversationState: resolved.state,
        hasDifyConversationId: Boolean(conversationId),
        attachmentCount: currentAttachments.length,
        toolCount: tools.length,
        toolSchemaChanged: schema.changed,
        toolCallCount: emitted.length,
        toolResultCount: toolResults.length,
        compressionMode: compression.result.mode,
        compressionBeforeTokens: compression.result.beforeTokens,
        compressionAfterTokens: compression.result.afterTokens,
        compressionSavedTokens: compression.result.savedTokens,
        compressionPasses: compression.result.compressionPasses,
        compressionTargetReached: compression.result.targetReached,
        compressionUnableToReachTarget: compression.result.unableToReachTarget,
        retryCount,
        latencyMs: Date.now() - startedAt,
        status: 'ok',
        ...(providerSwitch ? { providerSwitch: true } : {}),
      });

      recordDecision({
        success: true,
        retryCount,
        firstTokenLatencyMs: firstTokenAt === undefined ? undefined : firstTokenAt - startedAt,
        promptTokens: usage?.inputTokens,
        completionTokens: usage?.outputTokens,
        backendPromptTokens: usage?.inputTokens,
        backendCompletionTokens: usage?.outputTokens,
      });

      let index = 0;
      if (emitted.length) {
        for (const call of emitted) {
          const current = index++;
          yield { type: 'block-start', index: current, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: current, id: call.id, name: call.name, argumentsDelta: call.arguments };
          yield { type: 'block-end', index: current, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } };
        }
      } else if (answer) {
        const current = index++;
        yield { type: 'block-start', index: current, blockType: 'text' };
        yield { type: 'text-delta', index: current, text: answer };
        yield { type: 'block-end', index: current, block: { type: 'text', text: answer } };
      }
      if (usage) yield { type: 'usage', usage };
      yield {
        type: 'finish',
        reason: { kind: emitted.length ? 'tool-calls' : 'stop' },
        ...(conversationId ? {
          replayState: { response: { kind: 'dify', conversationId, providerId, appId } },
        } : {}),
      };
    } catch (error) {
      recordDecision({
        success: false,
        errorType: errorType(error),
      });
      throw error;
    }
  }
}
