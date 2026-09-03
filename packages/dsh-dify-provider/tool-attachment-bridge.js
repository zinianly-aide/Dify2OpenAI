import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256 } from '@zinianly-aide/dify-core';

const IMAGE_MEDIA_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});
const READ_IMAGE_PATH_KEYS = Object.freeze(['file_path', 'path', 'file', 'image_path']);

function userKey(sessionId) {
  return `dsh-${sha256(String(sessionId)).slice(0, 24)}`;
}

function entryKey(user, callId) {
  return `${String(user)}::${String(callId)}`;
}

function uploadKey(user, descriptor) {
  return `${String(user)}::${String(descriptor.toolCallId)}::${String(descriptor.fingerprint)}`;
}

function attachmentKey(attachment) {
  const source = attachment?.source || {};
  if (source.kind === 'dsh_attachment') return `dsh:${String(source.attachment?.attachmentId || '')}`;
  if (source.kind === 'data') return `data:${String(source.contentHash || '')}`;
  if (source.kind === 'url') return `url:${String(source.url || '')}`;
  if (source.kind === 'local_file') return `local:${String(source.uploadIdentity || source.fingerprint || '')}`;
  return JSON.stringify(attachment);
}

function queryToolCallIds(query) {
  const ids = [];
  const re = /tool_result tool_call_id=([^\s:]+)/g;
  for (const match of String(query || '').matchAll(re)) ids.push(String(match[1]));
  return [...new Set(ids)];
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseReadImageArguments(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch {
      throw bridgeError('READ_IMAGE_ARGUMENTS_INVALID', 'read_image arguments are not valid JSON');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bridgeError('READ_IMAGE_ARGUMENTS_INVALID', 'read_image arguments must be an object or JSON object string');
  }
  for (const key of READ_IMAGE_PATH_KEYS) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  throw bridgeError('READ_IMAGE_PATH_MISSING', 'read_image arguments do not contain a supported path field');
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function configuredAllowedRoots(allowedRoots = []) {
  const envRoots = String(process.env.DSH_READ_IMAGE_ALLOW_ROOTS || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...allowedRoots, ...envRoots];
}

async function realAllowedRoots(workspaceRoot, allowedRoots) {
  const workspaceInput = String(workspaceRoot || process.env.DSH_WORKSPACE_ROOT || process.env.GITHUB_WORKSPACE || process.cwd());
  let workspace;
  try { workspace = await fs.realpath(workspaceInput); } catch {
    throw bridgeError('READ_IMAGE_PATH_OUTSIDE_ALLOWED_ROOT', 'configured read_image workspace root is unavailable');
  }
  const roots = [workspace];
  for (const input of configuredAllowedRoots(allowedRoots)) {
    try {
      const resolved = await fs.realpath(String(input));
      if (!roots.includes(resolved)) roots.push(resolved);
    } catch {
      throw bridgeError('READ_IMAGE_PATH_OUTSIDE_ALLOWED_ROOT', 'configured read_image allow-root is unavailable');
    }
  }
  return { workspace, roots };
}

function mediaTypeFromHeader(header) {
  const bytes = Buffer.from(header || []);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function inspectImageFile(rawPath, workspaceRoot, allowedRoots = []) {
  const { workspace, roots } = await realAllowedRoots(workspaceRoot, allowedRoots);
  const requested = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(workspace, rawPath);
  let resolved;
  try { resolved = await fs.realpath(requested); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw bridgeError('READ_IMAGE_FILE_NOT_FOUND', 'read_image target does not exist');
    throw bridgeError('READ_IMAGE_FILE_NOT_FOUND', 'read_image target cannot be resolved');
  }
  if (!roots.some((root) => withinRoot(root, resolved))) {
    throw bridgeError('READ_IMAGE_PATH_OUTSIDE_ALLOWED_ROOT', 'read_image target resolves outside an allowed root');
  }
  const info = await fs.stat(resolved);
  if (!info.isFile()) throw bridgeError('READ_IMAGE_NOT_REGULAR_FILE', 'read_image target is not a regular file');

  const handle = await fs.open(resolved, 'r');
  let header;
  try {
    header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    header = header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const detected = mediaTypeFromHeader(header);
  const extension = path.extname(resolved).toLowerCase();
  const declared = IMAGE_MEDIA_BY_EXTENSION[extension] || null;
  if (!detected || !declared || declared !== detected) {
    throw bridgeError('READ_IMAGE_UNSUPPORTED_TYPE', 'read_image target is not a supported PNG/JPEG/WebP/GIF image');
  }

  const digest = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(resolved);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return {
    localPath: resolved,
    mediaType: detected,
    fingerprint: digest.digest('hex'),
    pathHash: sha256(`path:${resolved}`).slice(0, 24),
  };
}

function safeDescriptor(callId, file) {
  return Object.freeze({
    toolCallId: String(callId),
    mediaType: file.mediaType,
    localPath: file.localPath,
    source: 'read_image',
    fingerprint: file.fingerprint,
  });
}

export class ToolAttachmentBridge {
  constructor({ workspaceRoot, allowedRoots = [] } = {}) {
    this.workspaceRoot = workspaceRoot || process.env.DSH_WORKSPACE_ROOT || process.env.GITHUB_WORKSPACE || process.cwd();
    this.allowedRoots = Object.freeze([...allowedRoots]);
    this.entries = new Map();
    this.completed = new Map();
    this.owners = new Map();
    this.uploadLedger = new Map();
  }

  registerOwnership(sessionId, callId) {
    if (sessionId === undefined || sessionId === null || !callId) return false;
    const id = String(callId);
    const user = userKey(sessionId);
    let owners = this.owners.get(id);
    if (!owners) {
      owners = new Set();
      this.owners.set(id, owners);
    }
    owners.add(user);
    return true;
  }

  async registerToolCall(sessionId, block) {
    const callId = block?.id || block?.callId;
    const toolName = String(block?.name || block?.toolName || '');
    const registered = this.registerOwnership(sessionId, callId);
    const sessionHash = sessionId === undefined || sessionId === null ? null : sha256(`session:${String(sessionId)}`).slice(0, 24);
    const toolCallIdHash = callId ? sha256(`tool-call:${String(callId)}`).slice(0, 24) : null;
    if (toolName !== 'read_image') return { detected: false, registered, sessionHash, toolCallIdHash };
    if (!registered) return { detected: true, registered: false, resolved: false, sessionHash, toolCallIdHash, reasonCode: 'READ_IMAGE_CORRELATION_MISSING' };

    const user = userKey(sessionId);
    const id = String(callId);
    const key = entryKey(user, id);
    try {
      const rawPath = parseReadImageArguments(block?.arguments ?? block?.input);
      const file = await inspectImageFile(rawPath, this.workspaceRoot, this.allowedRoots);
      const existing = this.entries.get(key) || this.completed.get(key);
      if (existing?.fingerprint === file.fingerprint) {
        return {
          detected: true, registered: true, resolved: true, reused: true,
          sessionHash, toolCallIdHash, pathHash: file.pathHash, mediaType: file.mediaType,
          reasonCode: 'READ_IMAGE_DESCRIPTOR_REUSED',
        };
      }
      this.entries.set(key, safeDescriptor(id, file));
      this.completed.delete(key);
      return {
        detected: true, registered: true, resolved: true, reused: false,
        sessionHash, toolCallIdHash, pathHash: file.pathHash, mediaType: file.mediaType,
        reasonCode: 'READ_IMAGE_DESCRIPTOR_REGISTERED',
      };
    } catch (error) {
      return { detected: true, registered: true, resolved: false, sessionHash, toolCallIdHash, reasonCode: String(error?.code || 'READ_IMAGE_ARGUMENTS_INVALID') };
    }
  }

  capture(exec, result) {
    if (String(exec?.name || '') !== 'read_image' || result?.isError) return false;
    const callId = exec?.callId;
    if (!callId) return false;
    const id = String(callId);
    const owners = this.owners.get(id);
    if (!owners || owners.size !== 1) return false;
    const [user] = owners;
    const key = entryKey(user, id);
    return Boolean(this.entries.get(key) || this.completed.get(key));
  }

  attachmentFor(user, descriptor) {
    const identity = uploadKey(user, descriptor);
    const uploadFileId = this.uploadLedger.get(identity);
    return {
      type: 'image',
      source: {
        kind: 'local_file',
        localPath: descriptor.localPath,
        mimeType: descriptor.mediaType,
        fingerprint: descriptor.fingerprint,
        toolCallId: descriptor.toolCallId,
        uploadIdentity: identity,
        ...(uploadFileId ? { uploadFileId } : {}),
        rememberUpload: (id) => {
          const value = String(id || '');
          if (value) this.uploadLedger.set(identity, value);
        },
      },
    };
  }

  resolve(user, query) {
    const callIds = queryToolCallIds(query);
    const images = [];
    const matchedCallIds = [];
    const seen = new Set();
    for (const callId of callIds) {
      const key = entryKey(user, callId);
      const descriptor = this.entries.get(key) || this.completed.get(key);
      if (!descriptor) continue;
      matchedCallIds.push(callId);
      const image = this.attachmentFor(user, descriptor);
      const keyOfImage = attachmentKey(image);
      if (seen.has(keyOfImage)) continue;
      seen.add(keyOfImage);
      images.push(image);
    }
    return { callIds: matchedCallIds, attachments: images };
  }

  resolveSession(sessionId, query) {
    return this.resolve(userKey(sessionId), query);
  }

  consume(user, callIds = []) {
    for (const callId of callIds) {
      const id = String(callId);
      const key = entryKey(user, id);
      const descriptor = this.entries.get(key);
      if (descriptor) {
        this.completed.set(key, descriptor);
        this.entries.delete(key);
      }
      const owners = this.owners.get(id);
      if (owners) {
        owners.delete(String(user));
        if (!owners.size) this.owners.delete(id);
      }
    }
  }

  consumeSession(sessionId, callIds = []) {
    this.consume(userKey(sessionId), callIds);
  }

  clearSession(sessionId) {
    const user = userKey(sessionId);
    const prefix = `${user}::`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
    for (const key of this.completed.keys()) if (key.startsWith(prefix)) this.completed.delete(key);
    for (const key of this.uploadLedger.keys()) if (key.startsWith(prefix)) this.uploadLedger.delete(key);
    for (const [callId, owners] of this.owners.entries()) {
      owners.delete(user);
      if (!owners.size) this.owners.delete(callId);
    }
  }
}

export function mergeAttachments(primary = [], supplemental = []) {
  const out = [];
  const seen = new Set();
  for (const attachment of [...primary, ...supplemental]) {
    const key = attachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(attachment);
  }
  return out;
}
