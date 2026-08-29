import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm';
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

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function usageOf(metadata) {
  const usage = metadata?.usage;
  if (!usage) return undefined;
  const inputTokens = numeric(usage.prompt_tokens);
  const outputTokens = numeric(usage.completion_tokens);
  const totalTokens = numeric(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function hasOwnAssistant(messages, providerId, appId) {
  return messages.some((message) => message?.role === 'assistant'
    && message?.source?.kind === 'model'
    && message.source.provider === providerId
    && message.source.model === appId);
}

function providerSwitchDetected(messages, providerId, appId) {
  return messagesAfterOwnAssistant(messages, providerId, appId).some((message) => (
    message?.role === 'assistant'
    && message?.source?.kind === 'model'
    && (message.source.provider !== providerId || message.source.model !== appId)
  ));
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

function toolResultQuery(results) {
  return results.map(({ call, result }) => `tool_result tool_call_id=${String(call.id)}: ${result}`).join('\n');
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
    if (provider !== this.providerId || !this.apps.has(model)) {
      return Promise.reject(new LlmError(`dsh-dify-provider has no configured app "${model}" on provider "${provider}"`, 'UNKNOWN_MODEL'));
    }
    const app = this.apps.get(model);
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
    if (!app.baseURL) throw new LlmError(`Dify app "${app.id}" has no baseURL; set DIFY_API_URL or configure apps[].baseURL`, 'MISSING_CONFIG');
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
        switch (event?.event) {
          case 'message':
          case 'agent_message':
            if (typeof event.answer === 'string') answer += event.answer;
            break;
          case 'message_end':
            usage = usageOf(event.metadata) || usage;
            break;
          case 'error':
            throw new LlmError(event.message || 'Dify returned an in-band error', String(event.code || 'DIFY_ERROR'));
          case 'protocol_error':
            throw new LlmError('Dify returned malformed SSE data', 'DIFY_PROTOCOL');
          default:
            break;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeoutSignal.aborted) throw new LlmError(`Dify request timed out after ${this.timeoutMs}ms`, 'DIFY_TIMEOUT', { cause: error });
      throw error;
    }
    return { answer, conversationId, usage };
  }

  buildQuery({ messages, system, tools, schema, strategy, providerId, appId }) {
    const history = strategy === 'FULL_BOOTSTRAP' || strategy === 'RECOVERY_BOOTSTRAP'
      ? fullHistory(messages, system)
      : deltaHistory(messages, providerId, appId);
    const schemaText = schemaInstruction(tools, schema.changed);
    return [schemaText, history].filter(Boolean).join('\n\n');
  }

  makeBody({ sessionId, conversationId, query }) {
    return {
      inputs: {},
      query,
      conversation_id: conversationId || '',
      user: `dsh-${sha256(sessionId).slice(0, 24)}`,
      auto_generate_name: false,
    };
  }

  recordIncomingToolResults({ sessionId, providerId, appId, messages }) {
    const completed = [];
    for (const message of messages) {
      for (const result of toolResultsOf(message)) {
        const call = findToolCall(messages, result.toolCallId);
        if (!call) continue;
        const input = ledgerInput(sessionId, providerId, appId, call);
        this.toolLedger.complete(input, serializeMessage(message));
        completed.push(input);
      }
    }
    return completed;
  }

  async stream(options) {
    const startedAt = Date.now();
    const traceId = newTraceId();
    const providerId = options.provider;
    const appId = options.model;
    const sessionId = options.sessionId === undefined ? '' : String(options.sessionId);
    if (!sessionId) throw new LlmError('dsh-dify-provider requires GenerateOptions.sessionId', 'MISSING_SESSION_ID');
    if (providerId !== this.providerId) throw new LlmError(`dsh-dify-provider does not own provider "${providerId}"`, 'NO_ADAPTER');
    const app = this.apps.get(appId);
    if (!app) throw new LlmError(`dsh-dify-provider has no configured Dify app "${appId}"`, 'UNKNOWN_MODEL');

    const messages = options.messages || [];
    assertSupportedMessages(messages);
    const tools = options.tools || [];
    const toolResults = tailToolResults(messages);
    const schema = this.toolSchemas.resolve({
      dshConversationId: sessionId,
      providerId,
      difyAppId: appId,
      tools,
    });
    const completedInputs = this.recordIncomingToolResults({ sessionId, providerId, appId, messages });
    let remote = this.conversations.get(sessionId, providerId, appId);
    let resolved = resolveConversationState({ remoteState: remote, messages, toolResults });

    if (remote?.conversationId && messages.length && !hasOwnAssistant(messages, providerId, appId)) {
      this.conversations.invalidate(sessionId, providerId, appId);
      resolved = resolveConversationState({
        remoteState: this.conversations.get(sessionId, providerId, appId),
        messages,
        remoteInvalid: true,
      });
    }

    let retryCount = 0;
    let query = this.buildQuery({
      messages,
      system: options.system,
      tools,
      schema,
      strategy: resolved.contextStrategy,
      providerId,
      appId,
    });
    let body = this.makeBody({ sessionId, conversationId: remote?.conversationId || '', query });
    let response;
    try {
      response = await this.collect(app, body, options.signal);
    } catch (error) {
      if (!(remote?.conversationId && isInvalidConversationError(error))) throw error;
      retryCount += 1;
      this.conversations.invalidate(sessionId, providerId, appId);
      resolved = resolveConversationState({
        remoteState: this.conversations.get(sessionId, providerId, appId),
        messages,
        toolResults,
        remoteInvalid: true,
      });
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
      query = this.buildQuery({
        messages,
        system: options.system,
        tools,
        schema,
        strategy: resolved.contextStrategy,
        providerId,
        appId,
      });
      body = this.makeBody({ sessionId, conversationId: '', query });
      response = await this.collect(app, body, options.signal);
    }

    let difyConversationId = response.conversationId || remote?.conversationId || '';
    if (difyConversationId) {
      remote = this.conversations.set(sessionId, providerId, appId, {
        conversationId: difyConversationId,
        valid: true,
        updatedAt: Date.now(),
        toolSchemaHash: schema.toolSchemaHash,
      });
    }
    for (const input of completedInputs) this.toolLedger.markForwarded(input);

    let answer = response.answer;
    let usage = response.usage;
    let parsedCalls = parseToolCalls(answer);
    let emittedCalls = [];
    let replayRounds = 0;

    while (parsedCalls.length && replayRounds < 3) {
      const replay = [];
      emittedCalls = [];
      for (const call of parsedCalls) {
        const entry = this.toolLedger.begin(ledgerInput(sessionId, providerId, appId, call));
        if (entry.replay) replay.push({ call, result: entry.result });
        else if (!entry.duplicate) emittedCalls.push(call);
      }
      if (emittedCalls.length || replay.length === 0) break;
      replayRounds += 1;
      retryCount += 1;
      const replayResponse = await this.collect(app, this.makeBody({
        sessionId,
        conversationId: difyConversationId,
        query: toolResultQuery(replay),
      }), options.signal);
      answer = replayResponse.answer;
      usage = replayResponse.usage || usage;
      difyConversationId = replayResponse.conversationId || difyConversationId;
      if (difyConversationId) {
        this.conversations.set(sessionId, providerId, appId, {
          conversationId: difyConversationId,
          valid: true,
          updatedAt: Date.now(),
          toolSchemaHash: schema.toolSchemaHash,
        });
      }
      parsedCalls = parseToolCalls(answer);
    }

    const providerSwitch = providerSwitchDetected(messages, providerId, appId);
    emitTrace(this.logger, {
      traceId,
      dshSessionIdHash: sessionHash(sessionId),
      providerId,
      difyAppId: appId,
      conversationState: resolved.state,
      hasDifyConversationId: Boolean(difyConversationId),
      toolCount: tools.length,
      toolSchemaChanged: schema.changed,
      toolCallCount: emittedCalls.length,
      toolResultCount: toolResults.length,
      retryCount,
      latencyMs: Date.now() - startedAt,
      status: 'ok',
      ...(providerSwitch ? { providerSwitch: true } : {}),
    });

    let blockIndex = 0;
    if (emittedCalls.length) {
      for (const call of emittedCalls) {
        const index = blockIndex++;
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: call.arguments,
        };
        yield {
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          },
        };
      }
    } else if (answer) {
      const index = blockIndex++;
      yield { type: 'block-start', index, blockType: 'text' };
      yield { type: 'text-delta', index, text: answer };
      yield { type: 'block-end', index, block: { type: 'text', text: answer } };
    }

    if (usage) yield { type: 'usage', usage };
    yield {
      type: 'finish',
      reason: { kind: emittedCalls.length ? 'tool-calls' : 'stop' },
      ...(difyConversationId ? {
        replayState: {
          response: {
            kind: 'dify',
            conversationId: difyConversationId,
            providerId,
            appId,
          },
        },
      } : {}),
    };
  }
}
