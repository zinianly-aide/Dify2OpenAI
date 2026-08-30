import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompressionPolicy,
  ContextCompressor,
} from '../packages/dify-core/index.js';

function compressor(config = {}) {
  return new ContextCompressor({ policy: new CompressionPolicy({ preservedRecentTurns: 1, ...config }) });
}

function profile(contextUtilization, overrides = {}) {
  return {
    estimatedPromptTokens: Math.round(contextUtilization * 10000),
    contextWindow: 10000,
    contextUtilization,
    messageCount: 8,
    toolSchemaTokens: 500,
    clientType: 'dsh',
    backendId: 'dify-test',
    model: 'default',
    ...overrides,
  };
}

const oldText = 'old context '.repeat(1200);

function baseMessages() {
  return [
    { role: 'system', content: 'CORE SYSTEM INSTRUCTION: never drop this.' },
    { role: 'user', content: `old request ${oldText}` },
    { role: 'assistant', content: `old response ${oldText}` },
    { role: 'user', content: 'Current request must remain unchanged.' },
  ];
}

test('short context is not compressed', () => {
  const messages = baseMessages();
  const { messages: output, result } = compressor().compress({ messages, tools: [], profile: profile(0.30) });
  assert.equal(result.mode, 'none');
  assert.equal(result.beforeTokens, result.afterTokens);
  assert.equal(result.savedTokens, 0);
  assert.equal(output, messages);
});

test('55 percent enters tool_prune and removes only completed old tool history', () => {
  const messages = [
    { role: 'system', content: 'keep' },
    { role: 'user', content: 'old tool request' },
    { role: 'assistant', tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old-call', content: oldText },
    { role: 'assistant', content: 'old tool completed' },
    { role: 'user', content: 'current request' },
  ];
  const { messages: output, result } = compressor().compress({ messages, profile: profile(0.55) });
  assert.equal(result.mode, 'tool_prune');
  assert.equal(output.some((m) => m.tool_call_id === 'old-call'), false);
  assert.equal(output.some((m) => m.tool_calls?.some((c) => c.id === 'old-call')), false);
  assert.ok(output.some((m) => m.content === 'current request'));
  assert.ok(result.reasonCodes.includes('compression_category=completed_tool_history'));
});

test('70 percent boundary uses light compression with before/after estimates', () => {
  const { messages, result } = compressor().compress({ messages: baseMessages(), tools: [], profile: profile(0.70) });
  assert.equal(result.mode, 'light');
  assert.ok(result.beforeTokens > result.afterTokens);
  assert.equal(result.savedTokens, result.beforeTokens - result.afterTokens);
  assert.ok(messages.some((m) => String(m.content).includes('Current request must remain unchanged.')));
  assert.ok(result.reasonCodes.includes('compression_preserved_current_user_request'));
});

test('85 percent uses heavy compression', () => {
  const { result } = compressor().compress({ messages: baseMessages(), tools: [], profile: profile(0.85) });
  assert.equal(result.mode, 'heavy');
  assert.ok(result.savedTokens > 0);
});

test('active tool call chain is never broken and tool calling can continue', () => {
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
  const messages = [
    { role: 'system', content: 'keep tool safety rules' },
    { role: 'user', content: oldText },
    { role: 'assistant', content: oldText },
    { role: 'user', content: 'inspect the file' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-active', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.js"}' } }] },
    { role: 'tool', tool_call_id: 'call-active', content: 'Error: file temporarily unavailable' },
  ];
  const { messages: output, result } = compressor().compress({ messages, tools, profile: profile(0.88) });
  assert.equal(result.mode, 'heavy');
  assert.ok(output.some((m) => m.tool_calls?.some((c) => c.id === 'call-active')));
  assert.ok(output.some((m) => m.tool_call_id === 'call-active'));
  assert.deepEqual(tools[0].function.name, 'read_file');
  assert.ok(result.reasonCodes.includes('compression_preserved_tool_chain'));
});

test('DSH tool-result tail does not replace the current human user request', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: oldText }] },
    { role: 'assistant', source: { kind: 'model', provider: 'dify', model: 'default' }, content: [{ type: 'text', text: oldText }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'CURRENT-HUMAN-REQUEST' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'dify', model: 'default' }, content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }] },
    { role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'tool output' }] }] },
  ];
  const { messages: output, result } = compressor().compress({ messages, profile: profile(0.88) });
  assert.ok(output.some((m) => Array.isArray(m.content) && m.content.some((x) => x.text === 'CURRENT-HUMAN-REQUEST')));
  assert.ok(output.some((m) => Array.isArray(m.content) && m.content.some((x) => x.type === 'tool-call' && x.id === 'call-1')));
  assert.ok(result.reasonCodes.includes('compression_preserved_current_user_request'));
});

test('system and developer instructions are preserved', () => {
  const messages = [
    { role: 'system', content: 'SYSTEM-MUST-STAY' },
    { role: 'developer', content: 'DEVELOPER-MUST-STAY' },
    { role: 'user', content: oldText },
    { role: 'assistant', content: oldText },
    { role: 'user', content: 'current' },
  ];
  const { messages: output } = compressor().compress({ messages, profile: profile(0.90) });
  assert.ok(output.some((m) => m.role === 'system' && m.content === 'SYSTEM-MUST-STAY'));
  assert.ok(output.some((m) => m.role === 'developer' && m.content === 'DEVELOPER-MUST-STAY'));
  assert.equal(output.some((m) => m.role === 'system' && String(m.content).startsWith('Compressed prior context')), false);
});

test('two sessions are independent because compressor keeps no session state', () => {
  const c = compressor();
  const a = c.compress({ messages: [{ role: 'user', content: `session-a ${oldText}` }, { role: 'assistant', content: oldText }, { role: 'user', content: 'A current' }], profile: profile(0.85) });
  const b = c.compress({ messages: [{ role: 'user', content: `session-b ${oldText}` }, { role: 'assistant', content: oldText }, { role: 'user', content: 'B current' }], profile: profile(0.30) });
  assert.equal(a.result.mode, 'heavy');
  assert.equal(b.result.mode, 'none');
  assert.ok(b.messages.every((m) => !String(m.content).includes('session-a')));
});

test('thresholds are configurable and not fixed in compressor business logic', () => {
  const c = compressor({ toolPruneThreshold: 0.20, lightThreshold: 0.30, heavyThreshold: 0.40, forceThreshold: 0.50 });
  const { result } = c.compress({ messages: baseMessages(), profile: profile(0.45) });
  assert.equal(result.mode, 'heavy');
});

test('client backend model profile rule can override thresholds deterministically', () => {
  const c = compressor({
    rules: [{
      id: 'codex-large-context',
      match: { clientType: 'codex', backendId: 'backend-large', model: 'large' },
      thresholds: { toolPruneThreshold: 0.70, lightThreshold: 0.80, heavyThreshold: 0.90, forceThreshold: 0.97 },
    }],
  });
  const matched = c.compress({
    messages: baseMessages(),
    profile: profile(0.75, { clientType: 'codex', backendId: 'backend-large', model: 'large' }),
  });
  const unmatched = c.compress({
    messages: baseMessages(),
    profile: profile(0.75, { clientType: 'cline', backendId: 'backend-large', model: 'large' }),
  });
  assert.equal(matched.result.mode, 'tool_prune');
  assert.ok(matched.result.reasonCodes.includes('compression_rule=codex-large-context'));
  assert.equal(unmatched.result.mode, 'light');
  assert.ok(unmatched.result.reasonCodes.includes('compression_rule=default'));
});

test('forced threshold remains deterministic heavy compression without automatic routing', () => {
  const { result } = compressor().compress({ messages: baseMessages(), profile: profile(0.95) });
  assert.equal(result.mode, 'heavy');
  assert.ok(result.reasonCodes.includes('compression_forced=true'));
  assert.ok(result.reasonCodes.every((code) => !code.includes(oldText.slice(0, 40))));
});
