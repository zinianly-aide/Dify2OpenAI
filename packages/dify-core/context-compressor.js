import { estimateTokens } from './gateway-canonical.js';
import { CompressionPolicy } from './compression-policy.js';

export class CompressionResult {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.reasonCodes);
    Object.freeze(this);
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || part.type === 'reasoning') return String(part.text || '');
    if (part.type === 'tool-result') return contentText(part.content);
    return '';
  }).filter(Boolean).join('\n');
}

function isCoreInstruction(message) {
  return message?.role === 'system' || message?.role === 'developer';
}

function isCompressionSummary(message) {
  return message?.gatewayCompressionSummary === true;
}

function isHumanUserMessage(message) {
  if (message?.role !== 'user') return false;
  return message?.source?.kind !== 'tool';
}

function toolCallIds(message) {
  const ids = [];
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) if (call?.id) ids.push(String(call.id));
  }
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'tool-call' && block.id) ids.push(String(block.id));
  }
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

function isToolMessage(message) {
  return toolCallIds(message).length > 0 || toolResultIds(message).length > 0 || message?.role === 'tool' || message?.role === 'function' || message?.source?.kind === 'tool';
}

function recentTurnIndexes(messages, count) {
  const userIndexes = [];
  for (let i = 0; i < messages.length; i += 1) if (isHumanUserMessage(messages[i])) userIndexes.push(i);
  const start = userIndexes.length > count ? userIndexes[userIndexes.length - count] : 0;
  const out = new Set();
  for (let i = start; i < messages.length; i += 1) out.add(i);
  return out;
}

function toolChainIndexes(messages) {
  const calls = new Map();
  const results = new Map();
  for (let i = 0; i < messages.length; i += 1) {
    for (const id of toolCallIds(messages[i])) calls.set(id, i);
    for (const id of toolResultIds(messages[i])) {
      if (!results.has(id)) results.set(id, []);
      results.get(id).push(i);
    }
  }
  const preserve = new Set();
  for (const [id, callIndex] of calls) {
    const matching = results.get(id) || [];
    if (!matching.length) {
      preserve.add(callIndex);
      for (let i = callIndex + 1; i < messages.length; i += 1) preserve.add(i);
    }
  }
  const last = messages.length - 1;
  if (last >= 0 && isToolMessage(messages[last])) {
    let start = last;
    while (start > 0 && isToolMessage(messages[start - 1])) start -= 1;
    for (let i = start; i <= last; i += 1) preserve.add(i);
    for (const id of toolResultIds(messages[last])) if (calls.has(id)) preserve.add(calls.get(id));
  }
  return preserve;
}

function importantFragments(text) {
  const source = String(text || '');
  const fragments = [];
  const patterns = [
    /(?:^|\s)(\/?(?:[\w.-]+\/)+[\w.-]+)/g,
    /\b(?:Error|Exception|FAILED|FAIL|WARN(?:ING)?|timeout|timed out|ECONN\w+|HTTP\s+\d{3})\b[^\n]{0,180}/gi,
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/g,
    /\b(?:TODO|DONE|PASS|BLOCKED|PENDING|IN_PROGRESS|SUCCESS|FAILED)\b[^\n]{0,120}/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) && fragments.length < 24) {
      const value = String(match[1] || match[0]).trim();
      if (value && !fragments.includes(value)) fragments.push(value);
    }
  }
  return fragments;
}

function summaryMessage(messages, maxChars) {
  if (maxChars <= 0) return { message: null, categories: [] };
  const fragments = [];
  const categories = new Set();
  for (const message of messages) {
    const text = contentText(message?.content);
    const important = importantFragments(text);
    if (important.length) {
      fragments.push(...important);
      if (important.some((x) => /\//.test(x))) categories.add('file_paths');
      if (important.some((x) => /error|exception|failed|timeout|http\s+\d{3}/i.test(x))) categories.add('errors');
      if (important.some((x) => /\./.test(x) && !/\//.test(x))) categories.add('code_symbols');
      if (important.some((x) => /todo|done|pass|blocked|pending|success|failed/i.test(x))) categories.add('task_status');
    }
  }
  const unique = [...new Set(fragments)].join('\n').slice(0, maxChars);
  if (!unique) return { message: null, categories: [] };
  return {
    message: {
      role: 'assistant',
      gatewayCompressionSummary: true,
      content: `Compressed prior context (important references only):\n${unique}`,
    },
    categories: [...categories],
  };
}

export function estimateConversationTokens(messages, tools = [], system) {
  let total = estimateTokens(system || '') + estimateTokens(tools);
  for (const message of messages || []) {
    total += estimateTokens(message?.role || '');
    total += estimateTokens(contentText(message?.content));
    total += estimateTokens(message?.tool_calls || []);
  }
  return total;
}

function utilization(tokens, contextWindow) {
  const window = Number(contextWindow);
  return Number.isFinite(window) && window > 0 ? Math.min(1, tokens / window) : undefined;
}

export class ContextCompressor {
  constructor(options = {}) {
    this.policy = options.policy || new CompressionPolicy(options.config);
  }

  compress({ messages = [], tools = [], system, profile, modeOverride, pass = 1, targetUtilization }) {
    const input = Array.isArray(messages) ? messages : [];
    const beforeTokens = estimateConversationTokens(input, tools, system);
    const policyDecision = this.policy.decide(profile);
    const decision = modeOverride
      ? { ...policyDecision, mode: modeOverride, reasonCodes: [...policyDecision.reasonCodes, `compression_mode_override=${modeOverride}`, `compression_pass=${pass}`] }
      : policyDecision;
    const config = decision.config || this.policy.config;
    const beforeUtilization = utilization(beforeTokens, profile?.contextWindow);
    if (decision.mode === 'none' || input.length === 0) {
      return {
        messages: input,
        result: new CompressionResult({
          mode: 'none', beforeTokens, afterTokens: beforeTokens, savedTokens: 0,
          ...(beforeUtilization === undefined ? {} : { beforeUtilization, afterUtilization: beforeUtilization }),
          ...(targetUtilization === undefined ? {} : { targetUtilization }),
          compressionPasses: 0,
          targetReached: targetUtilization === undefined || beforeUtilization === undefined ? false : beforeUtilization <= targetUtilization,
          unableToReachTarget: false,
          preservedRecentTurns: config.preservedRecentTurns,
          reasonCodes: [...decision.reasonCodes, 'compression_no_changes'],
        }),
      };
    }

    const recent = recentTurnIndexes(input, config.preservedRecentTurns);
    const toolChains = toolChainIndexes(input);
    const preserve = new Set();
    for (let i = 0; i < input.length; i += 1) {
      const protectedRecent = recent.has(i) && !isCompressionSummary(input[i]);
      if (isCoreInstruction(input[i]) || protectedRecent || toolChains.has(i)) preserve.add(i);
    }
    const latestHumanUser = [...input.keys()].reverse().find((i) => isHumanUserMessage(input[i]));
    if (latestHumanUser !== undefined) preserve.add(latestHumanUser);

    const removed = [];
    const retained = [];
    for (let i = 0; i < input.length; i += 1) {
      if (preserve.has(i)) retained.push(input[i]);
      else if (decision.mode === 'tool_prune' && !isToolMessage(input[i])) retained.push(input[i]);
      else removed.push(input[i]);
    }

    let output = retained;
    const categories = new Set();
    if (removed.some(isToolMessage)) categories.add('completed_tool_history');
    if (removed.some((m) => !isToolMessage(m))) categories.add('older_conversation');
    if (removed.some(isCompressionSummary)) categories.add('prior_compression_summary');

    if ((decision.mode === 'light' || decision.mode === 'heavy') && removed.length) {
      let maxChars = decision.mode === 'heavy' ? config.heavySummaryMaxChars : config.lightSummaryMaxChars;
      if (decision.mode === 'heavy' && pass > 1) maxChars = Math.min(maxChars, config.strongerHeavySummaryMaxChars);
      const summary = summaryMessage(removed, maxChars);
      summary.categories.forEach((x) => categories.add(x));
      if (summary.message) {
        const firstProtected = output.findIndex((m) => !isCoreInstruction(m));
        const insertAt = firstProtected < 0 ? output.length : firstProtected;
        output = [...output.slice(0, insertAt), summary.message, ...output.slice(insertAt)];
        categories.add('summarized_context');
      }
    }

    const afterTokens = estimateConversationTokens(output, tools, system);
    const afterUtilization = utilization(afterTokens, profile?.contextWindow);
    const savedTokens = Math.max(0, beforeTokens - afterTokens);
    const mode = savedTokens > 0 ? decision.mode : 'none';
    const protectedCount = preserve.size;
    const reasonCodes = [
      ...decision.reasonCodes,
      `compression_removed_messages=${removed.length}`,
      `compression_protected_messages=${protectedCount}`,
      `compression_preserved_recent_turns=${config.preservedRecentTurns}`,
      ...[...categories].sort().map((category) => `compression_category=${category}`),
      ...(toolChains.size ? ['compression_preserved_tool_chain'] : []),
      ...(latestHumanUser !== undefined ? ['compression_preserved_current_user_request'] : []),
      ...(decision.forced ? ['compression_forced=true'] : []),
      ...(removed.length === 0 ? ['compression_not_enough_compressible_history'] : []),
      ...(removed.length === 0 && protectedCount === input.length ? ['compression_protected_context_dominates'] : []),
    ];
    return {
      messages: output,
      result: new CompressionResult({
        mode,
        beforeTokens,
        afterTokens,
        savedTokens,
        ...(beforeUtilization === undefined ? {} : { beforeUtilization }),
        ...(afterUtilization === undefined ? {} : { afterUtilization }),
        ...(targetUtilization === undefined ? {} : { targetUtilization }),
        compressionPasses: mode === 'none' ? 0 : 1,
        targetReached: targetUtilization === undefined || afterUtilization === undefined ? false : afterUtilization <= targetUtilization,
        unableToReachTarget: false,
        preservedRecentTurns: config.preservedRecentTurns,
        reasonCodes,
      }),
    };
  }
}
