import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompressionPolicy,
  ContextCompressor,
} from '../packages/dify-core/index.js';

function compressor(config = {}) {
  return new ContextCompressor({ policy: new CompressionPolicy({ preservedRecentTurns: 1, ...config }) });
}

function profile(contextUtilization) {
  return {
    estimatedPromptTokens: Math.round(contextUtilization * 10000),
    contextWindow: 10000,
    contextUtilization,
    messageCount: 8,
    toolSchemaTokens: 500,
    clientType: 'dsh',
    backendId: 'dify-test',
    model: 'default',
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

test('around 70 percent uses light compression with before/after estimates', () => {
  const { messages, result } = compressor().compress({ messages: baseMessages(), tools: [], profile: profile(0.71) });
  assert.equal(result.mode, 'light');
  assert.ok(result.beforeTokens > result.afterTokens);
  assert.equal(result.savedTokens, result.beforeTokens - result.afterTokens);
  assert.ok(messages.some((m) => String(m.content).includes('Current request must remain unchanged.')));
});

test('around 85 percent uses heavy compression', () => {
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

test('forced threshold remains deterministic heavy compression without automatic routing', () => {
  const { result } = compressor().compress({ messages: baseMessages(), profile: profile(0.95) });
  assert.equal(result.mode, 'heavy');
  assert.ok(result.reasonCodes.includes('compression_forced=true'));
  assert.ok(result.reasonCodes.every((code) => !code.includes(oldText.slice(0, 40))));
});
