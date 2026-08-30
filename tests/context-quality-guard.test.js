import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompressionPolicy,
  CompressionQualityGuard,
  ContextCompressor,
  ContextProfiler,
  estimateConversationTokens,
} from '../packages/dify-core/index.js';

function harness({ compression = {}, quality = {} } = {}) {
  const policy = new CompressionPolicy({ preservedRecentTurns: 1, ...compression });
  return {
    compressor: new ContextCompressor({ policy }),
    profiler: new ContextProfiler(),
    guard: new CompressionQualityGuard({ config: quality }),
  };
}

function profileFor(messages, utilization, tools = []) {
  const tokens = estimateConversationTokens(messages, tools);
  const contextWindow = tokens / utilization;
  return {
    estimatedPromptTokens: tokens,
    toolSchemaEstimatedTokens: 0,
    toolSchemaTokens: 0,
    contextWindow,
    contextUtilization: utilization,
    messageCount: messages.length,
    toolCount: tools.length,
    clientType: 'dsh',
    backendId: 'dify-test',
    model: 'default',
  };
}

function oldHistory(count = 10, repeat = 80) {
  const out = [{ role: 'system', content: 'SYSTEM-MUST-STAY' }, { role: 'developer', content: 'DEVELOPER-MUST-STAY' }];
  for (let i = 0; i < count; i += 1) {
    out.push({ role: 'user', content: `old ${i} src/module-${i}/file-${i}.js ${'redundant '.repeat(repeat)}` });
    out.push({ role: 'assistant', content: `DONE src/module-${i}/file-${i}.js ${'historical '.repeat(repeat)}` });
  }
  out.push({ role: 'user', content: 'CURRENT-REQUEST-MUST-STAY' });
  return out;
}

function twoPassHeavyMessages() {
  const out = [{ role: 'system', content: 'SYSTEM-MUST-STAY' }, { role: 'developer', content: 'DEVELOPER-MUST-STAY' }];
  for (let i = 0; i < 10; i += 1) {
    const refs = Array.from({ length: 24 }, (_, j) => `src/feature-${i}/module-${j}/symbol-${i}-${j}.js`).join(' ');
    out.push({ role: 'user', content: `old request ${i} ${refs}` });
    out.push({ role: 'assistant', content: `DONE ${refs}` });
  }
  out.push({ role: 'user', content: `CURRENT-REQUEST-MUST-STAY ${'protected-current-context '.repeat(1100)}` });
  return out;
}

test('single pass reaches target', () => {
  const messages = oldHistory(10, 120);
  const h = harness();
  const result = h.guard.run({ messages, initialProfile: profileFor(messages, 0.85), compressor: h.compressor, profiler: h.profiler });
  assert.equal(result.result.targetReached, true);
  assert.equal(result.result.unableToReachTarget, false);
  assert.equal(result.result.compressionPasses, 1);
  assert.ok(result.result.reasonCodes.includes('TARGET_REACHED'));
});

test('multiple heavy passes reach target and dispatch representation is final pass', () => {
  const messages = twoPassHeavyMessages();
  const h = harness({
    compression: { heavySummaryMaxChars: 6000, strongerHeavySummaryMaxChars: 300 },
    quality: { targetUtilization: 0.68, maxCompressionPasses: 2, minimumSavingsRatio: 0 },
  });
  const result = h.guard.run({ messages, initialProfile: profileFor(messages, 0.91), compressor: h.compressor, profiler: h.profiler });
  assert.equal(result.passes.length, 2);
  assert.equal(result.passes[0].mode, 'heavy');
  assert.equal(result.passes[1].mode, 'heavy');
  assert.ok(result.passes[0].afterUtilization > 0.68);
  assert.ok(result.passes[1].afterUtilization <= 0.68);
  assert.equal(result.result.targetReached, true);
  assert.equal(result.result.compressionPasses, 2);
  assert.ok(result.messages.some((m) => String(m.content).startsWith('CURRENT-REQUEST-MUST-STAY')));
  assert.ok(result.messages.some((m) => m.content === 'SYSTEM-MUST-STAY'));
  assert.ok(result.messages.some((m) => m.content === 'DEVELOPER-MUST-STAY'));
  assert.ok(result.result.reasonCodes.includes('TARGET_REACHED'));
  console.log('QUALITY_GUARD_CASE_A', JSON.stringify({
    beforeUtilization: result.result.beforeUtilization,
    pass1: result.passes[0],
    pass2: result.passes[1],
    targetUtilization: result.result.targetUtilization,
    targetReached: result.result.targetReached,
    compressionPasses: result.result.compressionPasses,
  }));
});

test('max passes stops compression without deleting protected context', () => {
  const messages = oldHistory(25, 20);
  messages[messages.length - 1] = { role: 'user', content: `CURRENT-REQUEST-MUST-STAY ${'protected '.repeat(1500)}` };
  const h = harness({
    compression: { heavySummaryMaxChars: 12000, strongerHeavySummaryMaxChars: 6000 },
    quality: { targetUtilization: 0.20, maxCompressionPasses: 2, minimumSavingsRatio: 0 },
  });
  const result = h.guard.run({ messages, initialProfile: profileFor(messages, 0.95), compressor: h.compressor, profiler: h.profiler });
  assert.equal(result.result.targetReached, false);
  assert.equal(result.result.unableToReachTarget, true);
  assert.equal(result.result.compressionPasses, 2);
  assert.ok(result.result.reasonCodes.includes('MAX_PASSES_REACHED'));
  assert.ok(result.messages.some((m) => String(m.content).startsWith('CURRENT-REQUEST-MUST-STAY')));
});

test('no meaningful savings stops compression', () => {
  const messages = oldHistory(4, 5);
  messages[messages.length - 1] = { role: 'user', content: `CURRENT ${'protected '.repeat(1200)}` };
  const h = harness({ quality: { targetUtilization: 0.20, maxCompressionPasses: 2, minimumSavingsRatio: 0.50 } });
  const result = h.guard.run({ messages, initialProfile: profileFor(messages, 0.90), compressor: h.compressor, profiler: h.profiler });
  assert.equal(result.result.unableToReachTarget, true);
  assert.ok(result.result.reasonCodes.includes('NO_MEANINGFUL_SAVINGS'));
});

test('protected context prevents target and every pass preserves invariants', () => {
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
  const messages = [
    { role: 'system', content: `SYSTEM-MUST-STAY ${'core '.repeat(700)}` },
    { role: 'developer', content: `DEVELOPER-MUST-STAY ${'rule '.repeat(700)}` },
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old response' },
    { role: 'user', content: `CURRENT-REQUEST-MUST-STAY ${'current '.repeat(700)}` },
    { role: 'assistant', tool_calls: [{ id: 'pending-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.js"}' } }] },
  ];
  const h = harness({ quality: { targetUtilization: 0.20, maxCompressionPasses: 2, minimumSavingsRatio: 0 } });
  const result = h.guard.run({ messages, tools, initialProfile: profileFor(messages, 0.95, tools), compressor: h.compressor, profiler: h.profiler });
  assert.equal(result.result.targetReached, false);
  assert.equal(result.result.unableToReachTarget, true);
  assert.ok(result.result.reasonCodes.some((x) => x === 'PROTECTED_CONTEXT_DOMINATES' || x === 'MAX_PASSES_REACHED'));
  assert.ok(result.messages.some((m) => m.role === 'system' && String(m.content).startsWith('SYSTEM-MUST-STAY')));
  assert.ok(result.messages.some((m) => m.role === 'developer' && String(m.content).startsWith('DEVELOPER-MUST-STAY')));
  assert.ok(result.messages.some((m) => m.role === 'user' && String(m.content).startsWith('CURRENT-REQUEST-MUST-STAY')));
  assert.ok(result.messages.some((m) => m.tool_calls?.some((call) => call.id === 'pending-call')));
});
