import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ToolAttachmentBridge } from '../tool-attachment-bridge.js';
import { resolveDifyFiles } from '../../dify-core/attachments.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQtMAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-read-image-'));
  const image = path.join(root, 'fixture.png');
  await fs.writeFile(image, PNG);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, image };
}

async function uploadServer(t) {
  let uploadCount = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/files/upload') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    uploadCount += 1;
    for await (const _chunk of req) {}
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `upload-${uploadCount}` }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { baseURL: `http://127.0.0.1:${address.port}`, count: () => uploadCount };
}

async function filesFor(server, attachments) {
  return resolveDifyFiles({
    baseURL: server.baseURL,
    apiKey: 'test-key',
    user: 'dsh-session-user',
    attachments,
  });
}

function continuation(callId = 'call-read-image') {
  return `tool_result tool_call_id=${callId}: read_image completed`;
}

test('A absolute read_image path resolves and uploads exactly once', async (t) => {
  const { root, image } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-a', {
    id: 'call-read-image', name: 'read_image', arguments: { path: image },
  });
  assert.equal(diagnostic.resolved, true);
  const pending = bridge.resolveSession('session-a', continuation());
  assert.equal(pending.attachments.length, 1);
  const files = await filesFor(server, pending.attachments);
  assert.equal(server.count(), 1);
  assert.deepEqual(files, [{ type: 'image', transfer_method: 'local_file', upload_file_id: 'upload-1' }]);
});

test('B JSON string arguments parse file_path and resolve', async (t) => {
  const { root, image } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-b', {
    id: 'call-json', name: 'read_image', arguments: JSON.stringify({ file_path: image }),
  });
  assert.equal(diagnostic.resolved, true);
  assert.equal(bridge.resolveSession('session-b', continuation('call-json')).attachments.length, 1);
});

test('C relative image_path resolves beneath workspace root', async (t) => {
  const { root } = await fixture(t);
  const nested = path.join(root, 'images');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'relative.png'), PNG);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-c', {
    id: 'call-relative', name: 'read_image', arguments: { image_path: 'images/relative.png' },
  });
  assert.equal(diagnostic.resolved, true);
});

test('D missing file emits safe reason code and never uploads', async (t) => {
  const { root } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-d', {
    id: 'call-missing', name: 'read_image', arguments: { file: 'missing.png' },
  });
  assert.equal(diagnostic.resolved, false);
  assert.equal(diagnostic.reasonCode, 'READ_IMAGE_FILE_NOT_FOUND');
  const pending = bridge.resolveSession('session-d', continuation('call-missing'));
  assert.equal(pending.attachments.length, 0);
  await filesFor(server, pending.attachments);
  assert.equal(server.count(), 0);
});

test('E duplicate same session and toolCallId reuses uploaded Dify id', async (t) => {
  const { root, image } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  await bridge.registerToolCall('session-e', {
    id: 'call-dup', name: 'read_image', arguments: { path: image },
  });
  const first = bridge.resolveSession('session-e', continuation('call-dup'));
  const firstFiles = await filesFor(server, first.attachments);
  bridge.consumeSession('session-e', first.callIds);
  const retry = bridge.resolveSession('session-e', continuation('call-dup'));
  const retryFiles = await filesFor(server, retry.attachments);
  assert.equal(server.count(), 1);
  assert.deepEqual(retryFiles, firstFiles);
});

test('F conversation rotation metadata cannot break Gateway Session correlation', async (t) => {
  const { root, image } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  await bridge.registerToolCall('gateway-session-f', {
    id: 'call-rotation', name: 'read_image', arguments: { path: image }, conversation_id: 'old-conversation', generation: 1,
  });
  const resolved = bridge.resolveSession('gateway-session-f', continuation('call-rotation'));
  assert.equal(resolved.attachments.length, 1);
  assert.equal(resolved.callIds[0], 'call-rotation');
});

test('G backend migration metadata cannot break Gateway Session correlation', async (t) => {
  const { root, image } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  await bridge.registerToolCall('gateway-session-g', {
    id: 'call-migration', name: 'read_image', arguments: { path: image }, backend: 'source-backend', generation: 4,
  });
  const resolved = bridge.resolveSession('gateway-session-g', continuation('call-migration'));
  assert.equal(resolved.attachments.length, 1);
});

test('H non-read_image tool never creates attachment or upload', async (t) => {
  const { root, image } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-h', {
    id: 'call-bash', name: 'bash', arguments: { path: image },
  });
  assert.equal(diagnostic.detected, false);
  const pending = bridge.resolveSession('session-h', continuation('call-bash'));
  assert.equal(pending.attachments.length, 0);
  await filesFor(server, pending.attachments);
  assert.equal(server.count(), 0);
});

test('all supported path aliases resolve deterministically', async (t) => {
  const { root, image } = await fixture(t);
  for (const [index, key] of ['path', 'file', 'file_path', 'image_path'].entries()) {
    const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
    const diagnostic = await bridge.registerToolCall(`session-alias-${index}`, {
      id: `call-alias-${index}`, name: 'read_image', arguments: { [key]: image },
    });
    assert.equal(diagnostic.resolved, true, key);
  }
});

test('invalid arguments and missing path produce explicit safe reason codes', async (t) => {
  const { root } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const invalid = await bridge.registerToolCall('session-invalid', {
    id: 'call-invalid', name: 'read_image', arguments: '{not-json',
  });
  assert.equal(invalid.reasonCode, 'READ_IMAGE_ARGUMENTS_INVALID');
  const missing = await bridge.registerToolCall('session-no-path', {
    id: 'call-no-path', name: 'read_image', arguments: { note: 'none' },
  });
  assert.equal(missing.reasonCode, 'READ_IMAGE_PATH_MISSING');
});

test('symlink escape is rejected and unsupported image type is rejected', async (t) => {
  const { root } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-read-image-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const outsideImage = path.join(outside, 'outside.png');
  await fs.writeFile(outsideImage, PNG);
  const link = path.join(root, 'escape.png');
  await fs.symlink(outsideImage, link);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const escaped = await bridge.registerToolCall('session-escape', {
    id: 'call-escape', name: 'read_image', arguments: { path: link },
  });
  assert.equal(escaped.reasonCode, 'READ_IMAGE_PATH_OUTSIDE_ALLOWED_ROOT');

  const textFile = path.join(root, 'fake.png');
  await fs.writeFile(textFile, 'not an image');
  const unsupported = await bridge.registerToolCall('session-type', {
    id: 'call-type', name: 'read_image', arguments: { path: textFile },
  });
  assert.equal(unsupported.reasonCode, 'READ_IMAGE_UNSUPPORTED_TYPE');
});
