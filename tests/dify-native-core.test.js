import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolSchemaRegistry } from '../packages/dify-core/tool-schema-registry.js';
import {
  deltaHistory,
  findToolCall,
  tailToolResults,
} from '../packages/dsh-dify-provider/message-converter.js';

const tool = (name, description = name) => ({
  name,
  description,
  parameters: { type: 'object', properties: { value: { type: 'string' } } },
});

const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const assistant = (id, provider, model, text) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider, model },
  content: [{ type: 'text', text }],
});

test('native tool schema hash ignores tool enumeration order but detects real schema changes', () => {
  const registry = new ToolSchemaRegistry();
  const base = { dshConversationId: 'session-a', providerId: 'dify-prod', difyAppId: 'coding' };
  const first = registry.resolve({ ...base, tools: [tool('bash'), tool('read')] });
  const reordered = registry.resolve({ ...base, tools: [tool('read'), tool('bash')] });
  const changed = registry.resolve({ ...base, tools: [tool('read'), tool('bash', 'changed description')] });
  assert.equal(first.changed, true);
  assert.equal(reordered.changed, false);
  assert.equal(reordered.toolSchemaHash, first.toolSchemaHash);
  assert.equal(changed.changed, true);
  assert.notEqual(changed.toolSchemaHash, first.toolSchemaHash);
});

test('native delta includes provider-switch gap and not prior Dify history', () => {
  const messages = [
    user('u1', 'first'),
    assistant('a1', 'dify-prod', 'coding', 'dify answer'),
    user('u2', 'question handled elsewhere'),
    assistant('a2', 'openai', 'gpt', 'openai answer'),
    user('u3', 'back to dify'),
  ];
  const delta = deltaHistory(messages, 'dify-prod', 'coding');
  assert.doesNotMatch(delta, /first/);
  assert.doesNotMatch(delta, /dify answer/);
  assert.match(delta, /question handled elsewhere/);
  assert.match(delta, /openai answer/);
  assert.match(delta, /back to dify/);
});

test('native tool result correlation uses exact toolCallId', () => {
  const call = { type: 'tool-call', id: 'call_123', name: 'bash', arguments: '{"command":"pwd"}' };
  const result = { type: 'tool-result', toolCallId: 'call_123', content: [{ type: 'text', text: '/tmp' }] };
  const messages = [
    { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'dify', model: 'default' }, content: [call] },
    { id: 't1', role: 'user', source: { kind: 'tool', callId: 'call_123' }, content: [result] },
  ];
  assert.equal(findToolCall(messages, 'call_123'), call);
  assert.equal(findToolCall(messages, 'call_999'), null);
  assert.deepEqual(tailToolResults(messages), [result]);
});
