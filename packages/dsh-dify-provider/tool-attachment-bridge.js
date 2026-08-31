import { imageAttachmentFromDshBlock, sha256 } from '@zinianly-aide/dify-core';

function userKey(sessionId) {
  return `dsh-${sha256(String(sessionId)).slice(0, 24)}`;
}

function entryKey(user, callId) {
  return `${String(user)}::${String(callId)}`;
}

function attachmentKey(attachment) {
  const source = attachment?.source || {};
  if (source.kind === 'dsh_attachment') return `dsh:${String(source.attachment?.attachmentId || '')}`;
  if (source.kind === 'data') return `data:${String(source.contentHash || '')}`;
  if (source.kind === 'url') return `url:${String(source.url || '')}`;
  return JSON.stringify(attachment);
}

function queryToolCallIds(query) {
  const ids = [];
  const re = /tool_result tool_call_id=([^\s:]+)/g;
  for (const match of String(query || '').matchAll(re)) ids.push(String(match[1]));
  return [...new Set(ids)];
}

function canonicalImages(content) {
  const out = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'image') {
      const image = imageAttachmentFromDshBlock(block);
      if (image) out.push(image);
    }
    if (block?.type === 'tool-result' && Array.isArray(block.content)) out.push(...canonicalImages(block.content));
  }
  return out;
}

export class ToolAttachmentBridge {
  constructor() {
    this.entries = new Map();
    this.owners = new Map();
    this.ambiguousCallIds = new Set();
  }

  registerOwnership(sessionId, callId) {
    if (sessionId === undefined || sessionId === null || !callId) return false;
    const id = String(callId);
    const user = userKey(sessionId);
    if (this.ambiguousCallIds.has(id)) return false;
    const existing = this.owners.get(id);
    if (existing && existing !== user) {
      this.owners.delete(id);
      this.ambiguousCallIds.add(id);
      return false;
    }
    this.owners.set(id, user);
    return true;
  }

  capture(exec, result) {
    if (String(exec?.name || '') !== 'read_image' || result?.isError) return false;
    const callId = exec?.callId;
    if (!callId) return false;
    const id = String(callId);
    if (this.ambiguousCallIds.has(id)) return false;
    const user = this.owners.get(id);
    if (!user) return false;
    const images = canonicalImages(result?.content);
    if (!images.length) return false;
    const unique = new Map(images.map((image) => [attachmentKey(image), image]));
    this.entries.set(entryKey(user, id), Object.freeze([...unique.values()]));
    return true;
  }

  resolve(user, query) {
    const callIds = queryToolCallIds(query);
    const images = [];
    const matchedCallIds = [];
    const seen = new Set();
    for (const callId of callIds) {
      const entry = this.entries.get(entryKey(user, callId));
      if (!entry?.length) continue;
      matchedCallIds.push(callId);
      for (const image of entry) {
        const key = attachmentKey(image);
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(image);
      }
    }
    return { callIds: matchedCallIds, attachments: images };
  }

  consume(user, callIds = []) {
    for (const callId of callIds) {
      const id = String(callId);
      this.entries.delete(entryKey(user, id));
      if (this.owners.get(id) === String(user)) this.owners.delete(id);
      this.ambiguousCallIds.delete(id);
    }
  }

  clearSession(sessionId) {
    const user = userKey(sessionId);
    const prefix = `${user}::`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    for (const [callId, owner] of this.owners.entries()) {
      if (owner === user) this.owners.delete(callId);
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
