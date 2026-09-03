import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ToolAttachmentBridge } from '../tool-attachment-bridge.js';
import { resolveDifyFiles } from '../../dify-core/attachments.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQtMAAAAASUVORK5CYII=', 'base64');
const PNG_ALT = Buffer.concat([PNG, Buffer.from('bridge-fingerprint-variant')]);

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-read-image-'));
  const image = path.join(root, 'fixture.png');
  await fs.writeFile(image, PNG);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, image };
}

async function outsideFixture(t, bytes = PNG) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-read-image-outside-'));
  const image = path.join(root, 'outside.png');
  await fs.writeFile(image, bytes);
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

test('absolute read_image path registers descriptor and uploads exactly once', async (t) => {
  const { root, image } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-a', {
    id: 'call-read-image', name: 'read_image', arguments: { file_path: image },
  });
  assert.equal(diagnostic.resolved, true);
  assert.equal(diagnostic.reasonCode, 'READ_IMAGE_DESCRIPTOR_REGISTERED');
  const pending = bridge.resolveSession('session-a', continuation());
  assert.equal(pending.attachments.length, 1);
  const files = await filesFor(server, pending.attachments);
  assert.equal(server.count(), 1);
  assert.deepEqual(files, [{ type: 'image', transfer_method: 'local_file', upload_file_id: 'upload-1' }]);
});

test('read_image accepts all path aliases as object arguments', async (t) => {
  const { root, image } = await fixture(t);
  for (const [index, key] of ['file_path', 'path', 'file', 'image_path'].entries()) {
    const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
    const diagnostic = await bridge.registerToolCall(`session-alias-${index}`, {
      id: `call-alias-${index}`, name: 'read_image', arguments: { [key]: image },
    });
    assert.equal(diagnostic.resolved, true, key);
  }
});

test('read_image accepts JSON string arguments', async (t) => {
  const { root, image } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-json', {
    id: 'call-json', name: 'read_image', arguments: JSON.stringify({ file_path: image }),
  });
  assert.equal(diagnostic.resolved, true);
});

test('path alias precedence is deterministic: file_path then path then file then image_path', async (t) => {
  const { root, image } = await fixture(t);
  const alternate = path.join(root, 'alternate.png');
  await fs.writeFile(alternate, PNG_ALT);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  await bridge.registerToolCall('session-priority', {
    id: 'call-priority',
    name: 'read_image',
    arguments: { image_path: alternate, file: alternate, path: alternate, file_path: image },
  });
  const [descriptor] = [...bridge.entries.values()];
  assert.equal(descriptor.fingerprint, hash(PNG));
});

test('relative path resolves from workspace root', async (t) => {
  const { root } = await fixture(t);
  const nested = path.join(root, 'images');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'relative.png'), PNG);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-relative', {
    id: 'call-relative', name: 'read_image', arguments: { image_path: 'images/relative.png' },
  });
  assert.equal(diagnostic.resolved, true);
});

test('explicit fixture allow-root permits a safe absolute image outside workspace root', async (t) => {
  const { root } = await fixture(t);
  const outside = await outsideFixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root, allowedRoots: [outside.root] });
  const diagnostic = await bridge.registerToolCall('session-allow-root', {
    id: 'call-allow-root', name: 'read_image', arguments: { file_path: outside.image },
  });
  assert.equal(diagnostic.resolved, true);
});

test('invalid JSON and missing path fail safely', async (t) => {
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

test('file not found never creates attachment or upload', async (t) => {
  const { root } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-missing', {
    id: 'call-missing', name: 'read_image', arguments: { file: 'missing.png' },
  });
  assert.equal(diagnostic.reasonCode, 'READ_IMAGE_FILE_NOT_FOUND');
  const pending = bridge.resolveSession('session-missing', continuation('call-missing'));
  assert.equal(pending.attachments.length, 0);
  await filesFor(server, pending.attachments);
  assert.equal(server.count(), 0);
});

test('direct outside-root path and traversal are rejected', async (t) => {
  const { root } = await fixture(t);
  const outside = await outsideFixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const direct = await bridge.registerToolCall('session-outside', {
    id: 'call-outside', name: 'read_image', arguments: { path: outside.image },
  });
  assert.equal(direct.reasonCode, 'READ_IMAGE_PATH_OUTSIDE_ALLOWED_ROOT');
  const traversal = await bridge.registerToolCall('session-traversal', {
    id: 'call-traversal', name: 'read_image', arguments: { path: path.relative(root, outside.image) },
  });
  assert.equal(traversal.reasonCode, 'READ_IMAGE_PATH_OUTSIDE_ALLOWED_ROOT');
});

test('symlink escape is rejected', async (t) => {
  const { root } = await fixture(t);
  const outside = await outsideFixture(t);
  const link = path.join(root, 'escape.png');
  await fs.symlink(outside.image, link);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const escaped = await bridge.registerToolCall('session-escape', {
    id: 'call-escape', name: 'read_image', arguments: { path: link },
  });
  assert.equal(escaped.reasonCode, 'READ_IMAGE_PATH_OUTSIDE_ALLOWED_ROOT');
});

test('directory and unsupported file type are rejected', async (t) => {
  const { root } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const directory = path.join(root, 'folder.png');
  await fs.mkdir(directory);
  const notRegular = await bridge.registerToolCall('session-directory', {
    id: 'call-directory', name: 'read_image', arguments: { path: directory },
  });
  assert.equal(notRegular.reasonCode, 'READ_IMAGE_NOT_REGULAR_FILE');

  const textFile = path.join(root, 'fake.png');
  await fs.writeFile(textFile, 'not an image');
  const unsupported = await bridge.registerToolCall('session-type', {
    id: 'call-type', name: 'read_image', arguments: { path: textFile },
  });
  assert.equal(unsupported.reasonCode, 'READ_IMAGE_UNSUPPORTED_TYPE');

  const wrongExtension = path.join(root, 'real-image.txt');
  await fs.writeFile(wrongExtension, PNG);
  const wrongType = await bridge.registerToolCall('session-extension', {
    id: 'call-extension', name: 'read_image', arguments: { path: wrongExtension },
  });
  assert.equal(wrongType.reasonCode, 'READ_IMAGE_UNSUPPORTED_TYPE');
});

test('isError=true text-only result does not erase emitted descriptor and still uploads once', async (t) => {
  const { root, image } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  const diagnostic = await bridge.registerToolCall('session-text-only', {
    id: 'call-text-only', name: 'read_image', arguments: { file_path: image },
  });
  assert.equal(diagnostic.resolved, true);
  const captured = bridge.capture(
    { name: 'read_image', callId: 'call-text-only' },
    { isError: true, content: [{ type: 'text', text: 'read_image failed to emit an image block' }] },
  );
  assert.equal(captured, false);
  const pending = bridge.resolveSession('session-text-only', continuation('call-text-only'));
  assert.equal(pending.attachments.length, 1);
  const files = await filesFor(server, pending.attachments);
  assert.equal(server.count(), 1);
  assert.equal(files.length, 1);
  assert.equal(files[0].upload_file_id, 'upload-1');
});

test('duplicate same toolCallId uses session+toolCallId+fingerprint upload ledger and uploads once', async (t) => {
  const { root, image } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  await bridge.registerToolCall('session-dup', {
    id: 'call-dup', name: 'read_image', arguments: { path: image },
  });
  const first = bridge.resolveSession('session-dup', continuation('call-dup'));
  const firstFiles = await filesFor(server, first.attachments);
  bridge.consumeSession('session-dup', first.callIds);
  const retry = bridge.resolveSession('session-dup', continuation('call-dup'));
  const retryFiles = await filesFor(server, retry.attachments);
  assert.equal(server.count(), 1);
  assert.deepEqual(retryFiles, firstFiles);
  assert.equal(bridge.uploadLedger.size, 1);
});

test('same local path under a different toolCallId is not a path-only cache hit', async (t) => {
  const { root, image } = await fixture(t);
  const server = await uploadServer(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  for (const id of ['call-one', 'call-two']) {
    await bridge.registerToolCall('session-path-identity', { id, name: 'read_image', arguments: { path: image } });
    const pending = bridge.resolveSession('session-path-identity', continuation(id));
    await filesFor(server, pending.attachments);
  }
  assert.equal(server.count(), 2);
  assert.equal(bridge.uploadLedger.size, 2);
});

test('conversation rotation metadata does not affect Gateway Session descriptor identity', async (t) => {
  const { root, image } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  await bridge.registerToolCall('gateway-session-rotation', {
    id: 'call-rotation', name: 'read_image', arguments: { path: image }, conversation_id: 'old-conversation', generation: 1,
  });
  const resolved = bridge.resolveSession('gateway-session-rotation', continuation('call-rotation'));
  assert.equal(resolved.attachments.length, 1);
  assert.equal(resolved.callIds[0], 'call-rotation');
});

test('backend migration metadata does not affect Gateway Session descriptor identity', async (t) => {
  const { root, image } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  await bridge.registerToolCall('gateway-session-migration', {
    id: 'call-migration', name: 'read_image', arguments: { path: image }, backendId: 'source-backend', generation: 4,
  });
  const resolved = bridge.resolveSession('gateway-session-migration', continuation('call-migration'));
  assert.equal(resolved.attachments.length, 1);
});

test('non-read_image tools never trigger attachment discovery even with path-like arguments', async (t) => {
  const { root, image } = await fixture(t);
  const server = await uploadServer(t);
  for (const [index, name] of ['bash', 'read_file', 'grep', 'write_file'].entries()) {
    const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
    const id = `call-non-image-${index}`;
    const diagnostic = await bridge.registerToolCall(`session-non-image-${index}`, {
      id,
      name,
      arguments: { file_path: image, path: image, file: image, image_path: image },
    });
    assert.equal(diagnostic.detected, false, name);
    const pending = bridge.resolveSession(`session-non-image-${index}`, continuation(id));
    assert.equal(pending.attachments.length, 0, name);
    await filesFor(server, pending.attachments);
  }
  assert.equal(server.count(), 0);
});

test('stored SafeAttachmentDescriptor contains only approved fields', async (t) => {
  const { root, image } = await fixture(t);
  const bridge = new ToolAttachmentBridge({ workspaceRoot: root });
  await bridge.registerToolCall('session-descriptor', {
    id: 'call-descriptor',
    name: 'read_image',
    arguments: { file_path: image, note: 'raw arguments must not be stored' },
  });
  const [descriptor] = [...bridge.entries.values()];
  assert.deepEqual(Object.keys(descriptor).sort(), ['fingerprint', 'localPath', 'mediaType', 'source', 'toolCallId'].sort());
  assert.equal(descriptor.source, 'read_image');
  assert.equal(Object.isFrozen(descriptor), true);
  const serialized = JSON.stringify(descriptor);
  assert.equal(serialized.includes('raw arguments must not be stored'), false);
});
