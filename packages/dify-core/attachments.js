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
  return {
    type: 'image',
    source: {
      kind: 'data',
      mimeType,
      base64,
      contentHash: sha256(base64),
    },
  };
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

  const direct = normalizeImageReference(block.image_url || block.url);
  if (direct) return direct;

  const source = block.source || {};
  const remote = normalizeImageReference(source.url);
  if (remote) return remote;

  const mimeType = String(source.mediaType || source.media_type || source.mimeType || source.mime_type || block.mimeType || block.mime_type || '').toLowerCase();
  const base64 = String(source.data || source.base64 || block.data || block.base64 || '').replace(/\s+/g, '');
  if (mimeType.startsWith('image/') && base64) {
    return {
      type: 'image',
      source: {
        kind: 'data',
        mimeType,
        base64,
        contentHash: sha256(base64),
      },
    };
  }

  throw attachmentError('DSH image block must contain an http(s) URL or base64 image source');
}

function isActualUserMessage(message, dialect) {
  if (message?.role !== 'user') return false;
  if (dialect === 'dsh') return !message?.source || message.source.kind === 'user';
  return true;
}

export function currentImageAttachments(messages = [], dialect = 'openai') {
  const last = messages.at(-1);
  if (!isActualUserMessage(last, dialect)) return [];
  const content = Array.isArray(last.content) ? last.content : [];
  const mapper = dialect === 'dsh' ? imageAttachmentFromDshBlock : imageAttachmentFromOpenAIBlock;
  return content.map(mapper).filter(Boolean);
}

function extensionForMime(mimeType) {
  const subtype = String(mimeType || 'image/png').split('/')[1] || 'png';
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9.+-]/gi, '') || 'bin';
}

function uploadEndpoint(baseURL) {
  return `${String(baseURL || '').replace(/\/+$/, '')}/files/upload`;
}

export async function uploadDifyImage({ baseURL, apiKey, attachment, user, signal, headers = {} }) {
  if (attachment?.type !== 'image' || attachment?.source?.kind !== 'data') {
    throw attachmentError('uploadDifyImage requires an inline image attachment');
  }
  if (!user) throw attachmentError('Dify image upload requires the same non-empty user used by chat-messages', 'INVALID_ATTACHMENT_USER');

  const bytes = Buffer.from(attachment.source.base64, 'base64');
  if (!bytes.length) throw attachmentError('Inline image decoded to an empty file');
  const mimeType = attachment.source.mimeType;
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), `image-${attachment.source.contentHash.slice(0, 12)}.${extensionForMime(mimeType)}`);
  form.append('user', String(user));

  const response = await fetch(uploadEndpoint(baseURL), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...headers,
    },
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

export async function resolveDifyFiles({ baseURL, apiKey, attachments = [], user, signal, headers = {} }) {
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
    throw attachmentError('Unknown canonical image attachment source');
  }
  return files;
}
