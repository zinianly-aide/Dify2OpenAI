function blockText(block) {
  if (block?.type === 'text') return block.text || '';
  if (block?.type === 'reasoning') return block.text || '';
  if (block?.type === 'tool-result') return (block.content || []).map(blockText).filter(Boolean).join('\n');
  return '';
}

export function messageText(message) {
  return (message?.content || []).map(blockText).filter(Boolean).join('\n');
}

export function toolCallsOf(message) {
  return (message?.content || []).filter((block) => block?.type === 'tool-call');
}

export function toolResultsOf(message) {
  return (message?.content || []).filter((block) => block?.type === 'tool-result');
}

export function serializeMessage(message) {
  const calls = toolCallsOf(message);
  if (calls.length) {
    return `assistant_tool_calls: ${JSON.stringify(calls.map((call) => ({ id: String(call.id), name: call.name, arguments: call.arguments })))}`;
  }
  const results = toolResultsOf(message);
  if (results.length) {
    return results.map((result) => `tool_result tool_call_id=${String(result.toolCallId)}${result.isError ? ' error=true' : ''}: ${blockText(result)}`).join('\n');
  }
  const text = messageText(message);
  return text ? `${message.role}: ${text}` : '';
}

export function fullHistory(messages, system) {
  const parts = [];
  if (system) parts.push(`system: ${system}`);
  parts.push(...messages.map(serializeMessage).filter(Boolean));
  return parts.join('\n\n');
}

export function messagesAfterOwnAssistant(messages, providerId, appId) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const source = messages[i]?.source;
    if (messages[i]?.role === 'assistant' && source?.kind === 'model' && source.provider === providerId && source.model === appId) {
      return messages.slice(i + 1);
    }
  }
  return messages;
}

export function deltaHistory(messages, providerId, appId) {
  return messagesAfterOwnAssistant(messages, providerId, appId).map(serializeMessage).filter(Boolean).join('\n\n');
}

export function tailToolResults(messages) {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const results = toolResultsOf(messages[i]);
    if (!results.length) break;
    out.unshift(...results);
  }
  return out;
}

export function findToolCall(messages, toolCallId) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    for (const call of toolCallsOf(messages[i])) {
      if (String(call.id) === String(toolCallId)) return call;
    }
  }
  return null;
}

export function schemaInstruction(tools, changed) {
  if (!changed) return '';
  if (!tools?.length) return 'External tools are currently unavailable. Do not request a tool call.';
  return [
    'External tools available to the DSH client:',
    JSON.stringify(tools),
    'If a tool is required, return ONLY JSON in this exact shape:',
    '{"tool_calls":[{"id":"stable-call-id","name":"tool_name","arguments":"{\\"key\\":\\"value\\"}"}]}',
    'arguments MUST be a JSON string. Preserve each tool call id exactly when tool results are returned.',
  ].join('\n');
}

export function parseToolCalls(answer = '') {
  const text = String(answer).trim();
  const candidates = [text, text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed?.tool_calls)) continue;
      return parsed.tool_calls.map((call) => ({
        id: String(call.id || ''),
        name: String(call.name || call.function?.name || ''),
        arguments: typeof (call.arguments ?? call.function?.arguments) === 'string'
          ? (call.arguments ?? call.function?.arguments)
          : JSON.stringify(call.arguments ?? call.function?.arguments ?? {}),
      })).filter((call) => call.id && call.name);
    } catch {}
  }
  return [];
}

export function assertSupportedMessages(messages) {
  for (const message of messages) {
    if ((message?.content || []).some((block) => block?.type === 'image')) {
      const error = new Error('dsh-dify-provider does not yet support DSH image blocks');
      error.code = 'UNSUPPORTED_CONTENT';
      throw error;
    }
  }
}
