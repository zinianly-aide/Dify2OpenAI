import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  currentImageAttachments,
  imageAttachmentFromDshBlock,
  imageAttachmentFromOpenAIBlock,
  resolveDifyFiles,
} from '../packages/dify-core/index.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('OpenAI remote image_url maps directly to Dify remote_url', async () => {
  const attachment = imageAttachmentFromOpenAIBlock({
    type: 'image_url',
    image_url: { url: 'https://example.invalid/image.png' },
  });
  const files = await resolveDifyFiles({
    baseURL: 'http://127.0.0.1:9/v1',
    apiKey: 'unused',
    user: 'user-a',
    attachments: [attachment],
  });
  assert.deepEqual(files, [{
    type: 'image',
    transfer_method: 'remote_url',
    url: 'https://example.invalid/image.png',
  }]);
});

test('OpenAI data image uploads once and maps returned id to upload_file_id', async (t) => {
  let uploadCount = 0;
  let seenAuthorization = '';
  let seenBody = '';
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/files/upload') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    uploadCount += 1;
    seenAuthorization = String(req.headers.authorization || '');
    for await (const chunk of req) seenBody += chunk.toString('latin1');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'upload-image-001' }));
  });
  t.after(() => close(server));
  const address = await listen(server);
  const attachment = imageAttachmentFromOpenAIBlock({
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,aGVsbG8=' },
  });
  const files = await resolveDifyFiles({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'test-key',
    user: 'same-user',
    attachments: [attachment],
  });

  assert.equal(uploadCount, 1);
  assert.equal(seenAuthorization, 'Bearer test-key');
  assert.match(seenBody, /name="user"/);
  assert.match(seenBody, /same-user/);
  assert.match(seenBody, /name="file"/);
  assert.deepEqual(files, [{
    type: 'image',
    transfer_method: 'local_file',
    upload_file_id: 'upload-image-001',
  }]);
});

test('DSH base64 image source maps to canonical inline image', () => {
  const attachment = imageAttachmentFromDshBlock({
    type: 'image',
    source: { type: 'base64', mediaType: 'image/jpeg', data: 'aGVsbG8=' },
  });
  assert.equal(attachment.type, 'image');
  assert.equal(attachment.source.kind, 'data');
  assert.equal(attachment.source.mimeType, 'image/jpeg');
  assert.equal(attachment.source.base64, 'aGVsbG8=');
  assert.equal(attachment.source.contentHash.length, 64);
});

test('attachments are only taken from the current user turn and not resent on tool continuation', () => {
  const imageUser = {
    role: 'user',
    content: [
      { type: 'text', text: 'inspect this' },
      { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } },
    ],
  };
  assert.equal(currentImageAttachments([imageUser], 'openai').length, 1);
  assert.equal(currentImageAttachments([
    imageUser,
    { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
  ], 'openai').length, 0);

  const dshImageUser = {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' } }],
  };
  assert.equal(currentImageAttachments([dshImageUser], 'dsh').length, 1);
  assert.equal(currentImageAttachments([
    dshImageUser,
    { role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] },
  ], 'dsh').length, 0);
});
