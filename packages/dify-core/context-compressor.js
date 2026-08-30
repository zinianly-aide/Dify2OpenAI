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
  return toolCallIds(message).length > 0 || toolResultIds(message).length > 0 || message?.role === 'tool' || message?.role === 'function';
}

function recentTurnIndexes(messages, count) {
  const userIndexes = [];
  for (let i = 0; i < messages.length; i += 1) if (messages[i]?.role === 'user') userIndexes.push(i);
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
    message: { role: 'assistant', content: `Compressed prior context (important references only):\n${unique}` },
    categories: [...categories],
  };
}

function estimateConversation(messages, tools = [], system) {
  let total = estimateTokens(system || '') + estimateTokens(tools);
  for (const message of messages) {
    total += estimateTokens(message?.role || '');
    total += estimateTokens(contentText(message?.content));
    total += estimateTokens(message?.tool_calls || []);
  }
  return total;
}

export class ContextCompressor {
  constructor(options = {}) {
    this.policy = options.policy || new CompressionPolicy(options.config);
  }

  compress({ messages = [], tools = [], system, profile }) {
    const input = Array.isArray(messages) ? messages : [];
    const beforeTokens = estimateConversation(input, tools, system);
    const decision = this.policy.decide(profile);
    if (decision.mode === 'none' || input.length === 0) {
      return {
        messages: input,
        result: new CompressionResult({
          mode: 'none', beforeTokens, afterTokens: beforeTokens, savedTokens: 0,
          preservedRecentTurns: this.policy.config.preservedRecentTurns,
          reasonCodes: [...decision.reasonCodes, 'compression_no_changes'],
        }),
      };
    }

    const recent = recentTurnIndexes(input, this.policy.config.preservedRecentTurns);
    const toolChains = toolChainIndexes(input);
    const preserve = new Set();
    for (let i = 0; i < input.length; i += 1) {
      if (isCoreInstruction(input[i]) || recent.has(i) || toolChains.has(i)) preserve.add(i);
    }
    const latestUser = [...input.keys()].reverse().find((i) => input[i]?.role === 'user');
    if (latestUser !== undefined) preserve.add(latestUser);

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

    if ((decision.mode === 'light' || decision.mode === 'heavy') && removed.length) {
      const maxChars = decision.mode === 'heavy'
        ? this.policy.config.heavySummaryMaxChars
        : this.policy.config.lightSummaryMaxChars;
      const summary = summaryMessage(removed, maxChars);
      summary.categories.forEach((x) => categories.add(x));
      if (summary.message) {
        const firstProtected = output.findIndex((m) => !isCoreInstruction(m));
        const insertAt = firstProtected < 0 ? output.length : firstProtected;
        output = [...output.slice(0, insertAt), summary.message, ...output.slice(insertAt)];
        categories.add('summarized_context');
      }
    }

    const afterTokens = estimateConversation(output, tools, system);
    const savedTokens = Math.max(0, beforeTokens - afterTokens);
    const mode = savedTokens > 0 ? decision.mode : 'none';
    const reasonCodes = [
      ...decision.reasonCodes,
      `compression_removed_messages=${removed.length}`,
      `compression_preserved_recent_turns=${this.policy.config.preservedRecentTurns}`,
      ...[...categories].sort().map((category) => `compression_category=${category}`),
      ...(toolChains.size ? ['compression_preserved_tool_chain'] : []),
      ...(decision.forced ? ['compression_forced=true'] : []),
    ];
    return {
      messages: output,
      result: new CompressionResult({
        mode,
        beforeTokens,
        afterTokens,
        savedTokens,
        preservedRecentTurns: this.policy.config.preservedRecentTurns,
        reasonCodes,
      }),
    };
  }
}
