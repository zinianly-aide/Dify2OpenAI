import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { sha256 } from './canonical.js';

const IMAGE_DATA_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i;

function attachmentError(message, code = 'UNSUPPORTED_ATTACHMENT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRemoteUrl(value) {
  const url = String(value || '').trim();
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return { type: 'image', source: { kind: 'url', url } };
}

function normalizeDataUrl(value) {
  const match = IMAGE_DATA_RE.exec(String(value || '').trim());
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, '');
  if (!base64) return null;
  return { type: 'image', source: { kind: 'data', mimeType, base64, contentHash: sha256(base64) } };
}

export function normalizeImageReference(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  return normalizeDataUrl(raw) || normalizeRemoteUrl(raw);
}

export function imageAttachmentFromOpenAIBlock(block) {
  if (!block || block.type !== 'image_url') return null;
  const attachment = normalizeImageReference(block.image_url);
  if (!attachment) throw attachmentError('OpenAI image_url must be an http(s) URL or image data URL');
  return attachment;
}

export function imageAttachmentFromDshBlock(block) {
  if (!block || block.type !== 'image') return null;
  const durable = block.attachment;
  if (durable?.attachmentId && durable?.mediaType) {
    return { type: 'image', source: { kind: 'dsh_attachment', attachment: durable } };
  }
  const direct = normalizeImageReference(block.image_url || block.url);
  if (direct) return direct;
  const source = block.source || {};
  const remote = normalizeImageReference(source.url);
  if (remote) return remote;
  const mimeType = String(source.mediaType || source.media_type || source.mimeType || source.mime_type || block.mimeType || block.mime_type || '').toLowerCase();
  const base64 = String(source.data || source.base64 || block.data || block.base64 || '').replace(/\s+/g, '');
  if (mimeType.startsWith('image/') && base64) {
    return { type: 'image', source: { kind: 'data', mimeType, base64, contentHash: sha256(base64) } };
  }
  throw attachmentError('DSH image block must contain a durable attachment reference, http(s) URL, or base64 image source');
}

function collectBlocks(blocks, mapper, out) {
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const attachment = mapper(block);
    if (attachment) out.push(attachment);
    if (block?.type === 'tool-result' && Array.isArray(block.content)) collectBlocks(block.content, mapper, out);
  }
}

export function currentImageAttachments(messages = [], dialect = 'openai') {
  const mapper = dialect === 'dsh' ? imageAttachmentFromDshBlock : imageAttachmentFromOpenAIBlock;
  const out = [];
  const current = Array.isArray(messages) ? messages.at(-1) : null;
  if (current) collectBlocks(current.content, mapper, out);
  return out;
}

function extensionForMime(mimeType) {
  const subtype = String(mimeType || 'image/png').split('/')[1] || 'png';
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9.+-]/gi, '') || 'bin';
}

function uploadEndpoint(baseURL) {
  return `${String(baseURL || '').replace(/\/+$/, '')}/files/upload`;
}

async function uploadDifyImageBytes({ baseURL, apiKey, bytes, mimeType, contentHash, user, signal, headers = {} }) {
  if (!user) throw attachmentError('Dify image upload requires the same non-empty user used by chat-messages', 'INVALID_ATTACHMENT_USER');
  if (!bytes?.length) throw attachmentError('Inline image decoded to an empty file');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), `image-${contentHash.slice(0, 12)}.${extensionForMime(mimeType)}`);
  form.append('user', String(user));
  const response = await fetch(uploadEndpoint(baseURL), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, ...headers },
    body: form,
    signal,
  });
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }
  if (!response.ok || !json?.id) {
    const error = attachmentError(json?.message || `Dify image upload failed with HTTP ${response.status}`, 'DIFY_UPLOAD_ERROR');
    error.status = response.status;
    throw error;
  }
  return String(json.id);
}

export async function uploadDifyImage({ baseURL, apiKey, attachment, user, signal, headers = {} }) {
  if (attachment?.type !== 'image' || attachment?.source?.kind !== 'data') {
    throw attachmentError('uploadDifyImage requires an inline image attachment');
  }
  const bytes = Buffer.from(attachment.source.base64, 'base64');
  return uploadDifyImageBytes({ baseURL, apiKey, bytes, mimeType: attachment.source.mimeType, contentHash: attachment.source.contentHash, user, signal, headers });
}

function rawContentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function resolveLocalFileUpload({ baseURL, apiKey, attachment, user, signal, headers }) {
  const source = attachment?.source || {};
  if (!source.localPath || !source.mimeType || !source.fingerprint || !source.toolCallId || !source.uploadIdentity) {
    throw attachmentError('read_image local attachment descriptor is incomplete', 'READ_IMAGE_ARGUMENTS_INVALID');
  }
  if (source.uploadFileId) return String(source.uploadFileId);
  let info;
  try { info = await fs.stat(source.localPath); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw attachmentError('read_image target disappeared before upload', 'READ_IMAGE_FILE_NOT_FOUND');
    throw attachmentError('read_image target cannot be accessed before upload', 'READ_IMAGE_FILE_NOT_FOUND');
  }
  if (!info.isFile()) throw attachmentError('read_image target is no longer a regular file', 'READ_IMAGE_NOT_REGULAR_FILE');
  const bytes = await fs.readFile(source.localPath);
  if (rawContentHash(bytes) !== source.fingerprint) {
    throw attachmentError('read_image target changed after correlation and before upload', 'READ_IMAGE_FILE_CHANGED');
  }
  const uploadFileId = await uploadDifyImageBytes({
    baseURL,
    apiKey,
    bytes,
    mimeType: source.mimeType,
    contentHash: source.fingerprint,
    user,
    signal,
    headers,
  });
  if (typeof source.rememberUpload === 'function') source.rememberUpload(uploadFileId);
  return uploadFileId;
}

export async function resolveDifyFiles({ baseURL, apiKey, attachments = [], user, signal, headers = {}, readDshAttachment }) {
  const files = [];
  for (const attachment of attachments) {
    if (attachment?.type !== 'image') continue;
    if (attachment.source?.kind === 'url') {
      files.push({ type: 'image', transfer_method: 'remote_url', url: attachment.source.url });
      continue;
    }
    if (attachment.source?.kind === 'data') {
      const uploadFileId = await uploadDifyImage({ baseURL, apiKey, attachment, user, signal, headers });
      files.push({ type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId });
      continue;
    }
    if (attachment.source?.kind === 'local_file') {
      const uploadFileId = await resolveLocalFileUpload({ baseURL, apiKey, attachment, user, signal, headers });
      files.push({ type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId });
      continue;
    }
    if (attachment.source?.kind === 'dsh_attachment') {
      if (typeof readDshAttachment !== 'function') throw attachmentError('DSH durable image attachment cannot be read because no attachment store is available', 'ATTACHMENT_STORE_UNAVAILABLE');
      const stored = await readDshAttachment(attachment.source.attachment, signal);
      const data = stored?.data;
      const ref = stored?.ref || attachment.source.attachment;
      const bytes = data instanceof Uint8Array ? data : Buffer.from(data || []);
      const mimeType = String(ref?.mediaType || attachment.source.attachment.mediaType || 'application/octet-stream');
      if (!mimeType.startsWith('image/')) throw attachmentError('DSH attachment store returned a non-image object', 'INVALID_ATTACHMENT_MEDIA_TYPE');
      const uploadFileId = await uploadDifyImageBytes({ baseURL, apiKey, bytes, mimeType, contentHash: sha256(Buffer.from(bytes).toString('base64')), user, signal, headers });
      files.push({ type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId });
      continue;
    }
    throw attachmentError('Unknown canonical image attachment source');
  }
  return files;
}
