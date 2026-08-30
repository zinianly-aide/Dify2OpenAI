import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalContextBuilder, CheckpointManager } from '../packages/dify-core/index.js';

const user = (text) => ({ role: 'user', content: text });
const assistant = (text) => ({ role: 'assistant', content: text });

test('checkpoint bootstrap preserves old system/developer instructions even outside recent turn window', () => {
  const messages = [
    { role: 'system', content: 'SYSTEM-INSTRUCTION-MUST-SURVIVE' },
    { role: 'developer', content: 'DEVELOPER-INSTRUCTION-MUST-SURVIVE' },
    user('old task 1'), assistant('old result 1'),
    user('old task 2'), assistant('old result 2'),
    user('old task 3'), assistant('old result 3'),
    user('CURRENT-TASK-MUST-SURVIVE'),
  ];
  const builder = new CanonicalContextBuilder({ recentTurns: 1 });
  const manager = new CheckpointManager({ builder });
  const result = manager.create({
    sessionId: 'session-protection',
    backendId: 'dify-test',
    providerId: 'dify',
    appId: 'app',
    sourceGeneration: 1,
    messages,
    compressedMessages: messages.slice(-2),
    system: 'SEPARATE-DSH-SYSTEM-MUST-SURVIVE',
    compressionResult: { beforeTokens: 1000, afterTokens: 600 },
  });
  assert.equal(result.created, true);
  assert.equal(result.checkpoint.systemInstruction, 'SEPARATE-DSH-SYSTEM-MUST-SURVIVE');
  const bootstrap = builder.bootstrapMessages(result.checkpoint);
  assert.ok(bootstrap.some((m) => m.role === 'system' && m.content === 'SYSTEM-INSTRUCTION-MUST-SURVIVE'));
  assert.ok(bootstrap.some((m) => m.role === 'developer' && m.content === 'DEVELOPER-INSTRUCTION-MUST-SURVIVE'));
  assert.ok(bootstrap.some((m) => m.role === 'user' && m.content === 'CURRENT-TASK-MUST-SURVIVE'));
  assert.equal(bootstrap.some((m) => m.content === 'old task 1'), false);
});
