import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import {
  ConversationState,
  MemoryConversationStore,
  ToolExecutionLedger,
  ToolSchemaRegistry,
  isInvalidConversationError,
  resolveConversationState,
  sha256,
  streamDifyChat,
} from '@zinianly-aide/dify-core';
import {
  assertSupportedMessages,
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

function usageOf(metadata) {
  const raw = metadata?.usage;
  if (!raw) return undefined;
  const inputTokens = n(raw.prompt_tokens);
  const outputTokens = n(raw.completion_tokens);
  const totalTokens = n(raw.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function ownsAssistant(message, providerId, appId) {
  return message?.role === 'assistant'
    && message?.source?.kind === 'model'
    && message.source.provider === providerId
    && message.source.model === appId;
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
  constructor({ providerId, apps, timeoutMs = 120000, resolveApiKey, logger }) {
    super();
    this.providerId = providerId;
    this.apps = new Map(apps.map((app) => [app.id, Object.freeze({ ...app })]));
    this.timeoutMs = timeoutMs;
    this.resolveApiKey = resolveApiKey;
    this.logger = logger;
    this.conversations = new MemoryConversationStore();
    this.toolSchemas = new ToolSchemaRegistry();
    this.toolLedger = new ToolExecutionLedger();
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
      inputModalities: ['text'],
    })));
  }

  resolveModel(provider, model) {
    const app = provider === this.providerId ? this.apps.get(model) : undefined;
    if (!app) return Promise.reject(new LlmError(`unknown Dify route ${provider}/${model}`, 'UNKNOWN_MODEL'));
    return Promise.resolve({
      provider,
      id: model,
      name: app.name || model,
      inputModalities: ['text'],
      ...(app.contextWindow ? { context: { contextWindow: app.contextWindow } } : {}),
    });
  }

  resetSession(sessionId, appId) {
    this.conversations.resetProvider(String(sessionId), this.providerId, appId);
  }

  async collect(app, body, signal) {
    if (!app.baseURL) throw new LlmError(`Dify app "${app.id}" has no baseURL`, 'MISSING_CONFIG');
    const apiKey = await this.resolveApiKey(app);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let answer = '';
    let conversationId = body.conversation_id || '';
    let usage;
    try {
      for await (const event of streamDifyChat({
        baseURL: app.baseURL,
        apiKey,
        body,
        signal: requestSignal,
        headers: attributionHeaders(),
      })) {
        if (event?.conversation_id) conversationId = String(event.conversation_id);
        if (event?.event === 'message' || event?.event === 'agent_message') {
          if (typeof event.answer === 'string') answer += event.answer;
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
      throw error;
    }
    return { answer, conversationId, usage };
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
    const app = this.apps.get(appId);
    if (!app) throw new LlmError(`Dify app "${appId}" is not configured`, 'UNKNOWN_MODEL');

    const messages = options.messages || [];
    assertSupportedMessages(messages);
    const tools = options.tools || [];
    const toolResults = tailToolResults(messages);
    const schema = this.toolSchemas.resolve({ dshConversationId: sessionId, providerId, difyAppId: appId, tools });
    const resultInputs = this.recordToolResults(sessionId, providerId, appId, messages);
    let remote = this.conversations.get(sessionId, providerId, appId);
    let resolved = resolveConversationState({ remoteState: remote, messages, toolResults });

    if (remote?.conversationId && messages.length && !messages.some((m) => ownsAssistant(m, providerId, appId))) {
      this.conversations.invalidate(sessionId, providerId, appId);
      resolved = resolveConversationState({ remoteState: remote, messages, toolResults, remoteInvalid: true });
    }

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
    );

    let response;
    try {
      response = await request(remote?.conversationId || '', resolved.contextStrategy);
    } catch (error) {
      if (!(remote?.conversationId && isInvalidConversationError(error))) throw error;
      retryCount = 1;
      this.conversations.invalidate(sessionId, providerId, appId);
      resolved = resolveConversationState({ remoteState: remote, messages, toolResults, remoteInvalid: true });
      emitTrace(this.logger, {
        traceId,
        dshSessionIdHash: sessionHash(sessionId),
        providerId,
        difyAppId: appId,
        conversationState: ConversationState.RECOVER,
        hasDifyConversationId: true,
        toolCount: tools.length,
        toolSchemaChanged: schema.changed,
        toolCallCount: 0,
        toolResultCount: toolResults.length,
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
      const replayResponse = await this.collect(app, this.bodyFor(sessionId, conversationId, replayQuery), options.signal);
      answer = replayResponse.answer;
      usage = replayResponse.usage || usage;
      conversationId = replayResponse.conversationId || conversationId;
      calls = parseToolCalls(answer);
    }

    const gap = messagesAfterOwnAssistant(messages, providerId, appId);
    const providerSwitch = gap.some((m) => m?.role === 'assistant' && m?.source?.kind === 'model'
      && (m.source.provider !== providerId || m.source.model !== appId));
    emitTrace(this.logger, {
      traceId,
      dshSessionIdHash: sessionHash(sessionId),
      providerId,
      difyAppId: appId,
      conversationState: resolved.state,
      hasDifyConversationId: Boolean(conversationId),
      toolCount: tools.length,
      toolSchemaChanged: schema.changed,
      toolCallCount: emitted.length,
      toolResultCount: toolResults.length,
      retryCount,
      latencyMs: Date.now() - startedAt,
      status: 'ok',
      ...(providerSwitch ? { providerSwitch: true } : {}),
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
  }
}
