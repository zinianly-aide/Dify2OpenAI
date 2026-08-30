import { randomUUID } from 'node:crypto';
import {
  AdaptiveBackendGateway,
  BackendExecutor,
  BackendHealthStore,
  ContextMigrationPlanner,
  DeterministicBackendRouter,
  hashSessionValue,
} from '../packages/dify-core/index.js';
import {
  checkpointManager,
  conversationStore,
  toolExecutionLedger,
} from '../lib/runtime.js';
import {
  backendCredentialResolverFromEnv,
  createBackendRegistryFromEnv,
} from '../lib/backend-registry-config.js';

let runtime;

function getRuntime() {
  if (runtime) return runtime;
  const registry = createBackendRegistryFromEnv();
  if (!registry) throw new Error('ADAPTIVE_BACKEND_REGISTRY_NOT_CONFIGURED');
  const healthStore = new BackendHealthStore();
  const router = new DeterministicBackendRouter({ registry, healthStore });
  runtime = {
    registry,
    healthStore,
    gateway: new AdaptiveBackendGateway({
      registry,
      router,
      migrationPlanner: new ContextMigrationPlanner({ checkpointStore: checkpointManager.store }),
      conversationStore,
      checkpointManager,
      healthStore,
      toolLedger: toolExecutionLedger,
      executor: new BackendExecutor(),
      credentialsResolver: backendCredentialResolverFromEnv(),
    }),
  };
  return runtime;
}

export function adaptiveRoutingConfigured(env = process.env) {
  return Boolean(env.GATEWAY_BACKENDS_JSON);
}

function gatewaySession(req) {
  return req.headers?.['x-dsh-conversation-id']
    || req.headers?.['x-session-id']
    || req.body?.dsh_conversation_id
    || req.body?.session_id
    || req.body?.user
    || '';
}

function hasImages(messages = []) {
  return messages.some((message) => Array.isArray(message?.content) && message.content.some((part) =>
    part?.type === 'image' || part?.type === 'image_url' || part?.type === 'input_image'));
}

function explicitBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true' || String(value || '') === '1';
}

function csv(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function findToolCall(messages, toolCallId) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    for (const call of messages[i]?.tool_calls || []) {
      if (String(call?.id || '') === String(toolCallId)) return call;
    }
  }
  return null;
}

function recordCompletedToolResults({ messages, providerId, appId, sessionId }) {
  const completed = [];
  for (const message of messages) {
    if (message?.role !== 'tool' || !message.tool_call_id) continue;
    const call = findToolCall(messages, message.tool_call_id);
    if (!call) continue;
    const input = {
      providerId,
      appId,
      sessionId,
      toolCallId: String(message.tool_call_id),
      toolName: String(call.function?.name || call.name || ''),
      arguments: call.function?.arguments ?? call.arguments ?? '{}',
    };
    toolExecutionLedger.complete(input, typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));
    completed.push(input);
  }
  return completed;
}

function usageOf(result) {
  const usage = result?.usage || {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens);
  const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens);
  return {
    ...(Number.isFinite(promptTokens) && promptTokens >= 0 ? { prompt_tokens: promptTokens } : {}),
    ...(Number.isFinite(completionTokens) && completionTokens >= 0 ? { completion_tokens: completionTokens } : {}),
  };
}

function openAIResponse(result, requestedModel) {
  const usage = usageOf(result);
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  return {
    id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.routing?.selectedBackend || requestedModel || 'adaptive-gateway',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length ? null : String(result.answer || ''),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    }],
    ...(prompt !== undefined || completion !== undefined ? {
      usage: {
        prompt_tokens: prompt ?? 0,
        completion_tokens: completion ?? 0,
        total_tokens: (prompt ?? 0) + (completion ?? 0),
      },
    } : {}),
  };
}

function sendResponse(req, res, payload) {
  if (!req.body?.stream) return res.json(payload);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ ...payload, object: 'chat.completion.chunk' })}\n\n`);
  res.write('data: [DONE]\n\n');
  return res.end();
}

const adaptiveChatHandler = {
  async handleRequest(req, res) {
    const { gateway } = getRuntime();
    const sessionId = String(gatewaySession(req));
    if (!sessionId) {
      const error = new Error('GATEWAY_SESSION_REQUIRED');
      error.status = 400;
      throw error;
    }
    const providerId = String(req.headers?.['x-provider-id'] || 'gateway');
    const appId = String(req.headers?.['x-dify-app-id'] || req.body?.app_id || 'default');
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const canonicalMessages = Array.isArray(res.locals?.gatewayOriginalMessages)
      ? res.locals.gatewayOriginalMessages
      : messages;
    const tools = Array.isArray(req.body?.tools) ? req.body.tools : [];
    const completedToolInputs = recordCompletedToolResults({ messages: canonicalMessages, providerId, appId, sessionId });
    const estimatedTokens = Number(res.locals?.gatewayCompressionResult?.afterTokens
      ?? res.locals?.gatewayCompressionResult?.beforeTokens
      ?? req.body?.estimated_tokens
      ?? 0);
    const contextWindow = Number(req.headers?.['x-context-window'] || req.body?.context_window || 0);
    const result = await gateway.execute({
      sessionId,
      providerId,
      appId,
      clientType: String(req.headers?.['x-client-type'] || 'openai-compatible'),
      taskType: String(req.headers?.['x-task-type'] || req.body?.task_type || 'general'),
      taskHints: csv(req.headers?.['x-tool-task-hints'] || req.body?.tool_task_hints),
      requiredTools: csv(req.headers?.['x-required-tools'] || req.body?.required_tools),
      messages,
      canonicalMessages,
      tools,
      estimatedTokens: Number.isFinite(estimatedTokens) ? estimatedTokens : 0,
      contextUtilization: Number.isFinite(contextWindow) && contextWindow > 0 ? estimatedTokens / contextWindow : undefined,
      requiresTools: tools.length > 0,
      toolCount: tools.length,
      hasImages: hasImages(canonicalMessages),
      reasoningRequired: explicitBoolean(req.headers?.['x-reasoning-required'] ?? req.body?.reasoning_required),
      streamingRequired: explicitBoolean(req.body?.stream),
      latencyTarget: req.headers?.['x-latency-target'] || req.body?.latency_target,
      budgetTier: req.headers?.['x-budget-tier'] || req.body?.budget_tier,
      explicitBackendId: req.headers?.['x-backend-id'] || req.body?.backend_id,
      checkpointAvailable: Boolean(req.body?.checkpoint_available),
      completedToolInputs,
      user: `gateway-${hashSessionValue(sessionId)}`,
      stream: false,
    });

    res.locals.gatewayRouting = result.routing;
    res.locals.gatewayMigration = result.migration;
    res.locals.gatewayBackendHealth = result.routing?.backendHealth;
    res.locals.gatewayToolOptimization = result.toolOptimization;
    const usage = usageOf(result);
    if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) {
      res.locals.gatewayBackendUsage = {
        ...(usage.prompt_tokens !== undefined ? { backendPromptTokens: usage.prompt_tokens } : {}),
        ...(usage.completion_tokens !== undefined ? { backendCompletionTokens: usage.completion_tokens } : {}),
      };
    }
    return sendResponse(req, res, openAIResponse(result, req.body?.model));
  },
};

export default adaptiveChatHandler;
