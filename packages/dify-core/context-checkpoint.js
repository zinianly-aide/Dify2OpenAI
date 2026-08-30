import { randomUUID } from 'node:crypto';
import { estimateConversationTokens } from './context-compressor.js';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || part.type === 'reasoning') return String(part.text || '');
    if (part.type === 'tool-result') return textOf(part.content);
    return '';
  }).filter(Boolean).join('\n');
}

function uniq(values, limit = 32) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function toolCallIds(message) {
  const ids = [];
  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) if (call?.id) ids.push(String(call.id));
  for (const block of Array.isArray(message?.content) ? message.content : []) if (block?.type === 'tool-call' && block.id) ids.push(String(block.id));
  return ids;
}

function toolResultIds(message) {
  const ids = [];
  if ((message?.role === 'tool' || message?.role === 'function') && message.tool_call_id) ids.push(String(message.tool_call_id));
  const walk = (blocks) => {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === 'tool-result' && block.toolCallId) ids.push(String(block.toolCallId));
      if (Array.isArray(block?.content)) walk(block.content);
    }
  };
  walk(message?.content);
  return ids;
}

export function pendingToolStateOf(messages = []) {
  const calls = new Map();
  const results = new Set();
  for (const message of messages) {
    for (const id of toolCallIds(message)) calls.set(id, message);
    for (const id of toolResultIds(message)) results.add(id);
  }
  const pending = [...calls.keys()].filter((id) => !results.has(id));
  return Object.freeze({ pending: pending.length > 0, toolCallIds: Object.freeze(pending) });
}

function recentTurnSlice(messages, protectedTurns) {
  const userIndexes = [];
  for (let i = 0; i < messages.length; i += 1) if (messages[i]?.role === 'user' && messages[i]?.source?.kind !== 'tool') userIndexes.push(i);
  const start = userIndexes.length > protectedTurns ? userIndexes[userIndexes.length - protectedTurns] : 0;
  return messages.slice(start);
}

function extractMetadata(messages) {
  const text = messages.map((m) => textOf(m?.content)).join('\n');
  const filePaths = uniq([...text.matchAll(/(?:^|\s)(\/?(?:[\w.-]+\/)+[\w.-]+)/g)].map((m) => m[1]), 48);
  const symbols = uniq([
    ...[...text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/g)].map((m) => m[0]),
    ...[...text.matchAll(/\b(?:class|function|interface|type|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]),
  ], 48);
  const errors = uniq([...text.matchAll(/\b(?:Error|Exception|FAILED|FAIL|timeout|timed out|ECONN\w+|HTTP\s+\d{3})\b[^\n]{0,220}/gi)].map((m) => m[0].trim()), 24);
  const decisions = uniq([...text.matchAll(/\b(?:decision|decided|must|shall|keep|preserve|do not|don't|禁止|必须|保留|决定)\b[^\n]{0,220}/gi)].map((m) => m[0].trim()), 24);
  return { filePaths, symbols, errors, decisions };
}

export class CanonicalContextBuilder {
  constructor(options = {}) {
    this.recentTurns = Number.isInteger(options.recentTurns) && options.recentTurns > 0 ? options.recentTurns : 3;
    this.summaryMaxChars = Number.isInteger(options.summaryMaxChars) && options.summaryMaxChars > 0 ? options.summaryMaxChars : 12000;
  }

  build({ messages = [], compressedMessages = [], system, tools = [] }) {
    const authoritative = Array.isArray(messages) ? messages : [];
    const compressed = Array.isArray(compressedMessages) && compressedMessages.length ? compressedMessages : authoritative;
    const instructions = authoritative.filter((m) => m?.role === 'system' || m?.role === 'developer');
    const currentTask = [...authoritative].reverse().find((m) => m?.role === 'user' && m?.source?.kind !== 'tool');
    const recentMessages = recentTurnSlice(authoritative, this.recentTurns);
    const pendingToolState = pendingToolStateOf(authoritative);
    const metadata = extractMetadata(authoritative);
    const compressionSummary = compressed.filter((m) => m?.gatewayCompressionSummary === true).map((m) => textOf(m.content)).join('\n');
    const deterministicSummary = [
      compressionSummary,
      metadata.filePaths.length ? `Files:\n${metadata.filePaths.join('\n')}` : '',
      metadata.symbols.length ? `Symbols:\n${metadata.symbols.join('\n')}` : '',
      metadata.errors.length ? `Unresolved errors:\n${metadata.errors.join('\n')}` : '',
      metadata.decisions.length ? `Important decisions:\n${metadata.decisions.join('\n')}` : '',
    ].filter(Boolean).join('\n\n').slice(0, this.summaryMaxChars);
    const taskGoals = currentTask ? [textOf(currentTask.content)].filter(Boolean) : [];
    const recentWithoutInstructions = recentMessages.filter((m) => m?.role !== 'system' && m?.role !== 'developer');
    return Object.freeze({
      summary: deterministicSummary,
      recentMessages: Object.freeze([...recentMessages]),
      taskGoals: Object.freeze(taskGoals),
      activeFiles: Object.freeze(metadata.filePaths),
      importantSymbols: Object.freeze(metadata.symbols),
      unresolvedErrors: Object.freeze(metadata.errors),
      importantDecisions: Object.freeze(metadata.decisions),
      pendingToolState,
      instructions: Object.freeze([...instructions]),
      currentTask: currentTask || null,
      estimatedTokens: estimateConversationTokens([...instructions, ...(deterministicSummary ? [{ role: 'assistant', gatewayCheckpointSummary: true, content: deterministicSummary }] : []), ...recentWithoutInstructions], tools, system),
    });
  }

  bootstrapMessages(checkpoint) {
    const recent = Array.isArray(checkpoint?.recentMessages) ? checkpoint.recentMessages : [];
    const instructions = Array.isArray(checkpoint?.instructions)
      ? checkpoint.instructions
      : recent.filter((m) => m?.role === 'system' || m?.role === 'developer');
    const nonInstructions = recent.filter((m) => m?.role !== 'system' && m?.role !== 'developer');
    return [
      ...instructions,
      ...(checkpoint?.summary ? [{ role: 'assistant', gatewayCheckpointSummary: true, content: `Context checkpoint:\n${checkpoint.summary}` }] : []),
      ...nonInstructions,
    ];
  }
}

export class ContextCheckpointStore {
  constructor() { this.byId = new Map(); this.byScope = new Map(); }
  scopeKey(sessionId, backendId, providerId, appId) { return `${sessionId}::${backendId}::${providerId}::${appId}`; }
  save(checkpoint) {
    this.byId.set(checkpoint.checkpointId, checkpoint);
    const key = this.scopeKey(checkpoint.sessionId, checkpoint.sourceBackendId, checkpoint.providerId, checkpoint.appId);
    if (!this.byScope.has(key)) this.byScope.set(key, []);
    this.byScope.get(key).push(checkpoint.checkpointId);
    return checkpoint;
  }
  get(checkpointId) { return this.byId.get(checkpointId) || null; }
  list(sessionId, backendId, providerId, appId) {
    const ids = this.byScope.get(this.scopeKey(sessionId, backendId, providerId, appId)) || [];
    return ids.map((id) => this.byId.get(id)).filter(Boolean);
  }
  latest(sessionId, backendId, providerId, appId) { return this.list(sessionId, backendId, providerId, appId).at(-1) || null; }
}

export class CheckpointManager {
  constructor(options = {}) {
    this.store = options.store || new ContextCheckpointStore();
    this.builder = options.builder || new CanonicalContextBuilder(options.builderOptions);
  }

  create({ sessionId, backendId, providerId, appId, sourceGeneration, contextVersion, messages = [], compressedMessages = [], system, tools = [], compressionResult, reasonCodes = [] }) {
    const built = this.builder.build({ messages, compressedMessages, system, tools });
    if (built.pendingToolState.pending) {
      return Object.freeze({ created: false, deferred: true, reasonCodes: Object.freeze(['ROTATION_DEFERRED_PENDING_TOOL']), pendingToolState: built.pendingToolState });
    }
    const checkpoint = Object.freeze({
      sessionId: String(sessionId),
      checkpointId: randomUUID(),
      contextVersion: Number(contextVersion || sourceGeneration || 1),
      sourceBackendId: String(backendId),
      providerId: String(providerId),
      appId: String(appId),
      sourceGeneration: Number(sourceGeneration || 1),
      summary: built.summary,
      recentMessages: built.recentMessages,
      taskGoals: built.taskGoals,
      activeFiles: built.activeFiles,
      importantSymbols: built.importantSymbols,
      unresolvedErrors: built.unresolvedErrors,
      importantDecisions: built.importantDecisions,
      pendingToolState: built.pendingToolState,
      instructions: built.instructions,
      currentTask: built.currentTask,
      estimatedTokensBefore: Number(compressionResult?.beforeTokens || 0),
      estimatedTokensAfter: Number(built.estimatedTokens || compressionResult?.afterTokens || 0),
      reasonCodes: Object.freeze([...reasonCodes]),
      createdAt: Date.now(),
    });
    this.store.save(checkpoint);
    return Object.freeze({ created: true, deferred: false, checkpoint, reasonCodes: Object.freeze([...reasonCodes]) });
  }
}
