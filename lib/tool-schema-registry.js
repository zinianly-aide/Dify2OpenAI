import { canonicalJson, sha256 } from './canonical.js';

export class ToolSchemaRegistry {
  constructor() { this.cache = new Map(); }
  key(dshConversationId, providerId, difyAppId = '') { return `${dshConversationId}::${providerId}::${difyAppId}`; }
  resolve({ dshConversationId, providerId, difyAppId = '', tools = [] }) {
    const canonicalTools = canonicalJson(tools);
    const toolSchemaHash = sha256(canonicalTools);
    const key = this.key(dshConversationId, providerId, difyAppId);
    const previous = this.cache.get(key);
    const changed = previous !== toolSchemaHash;
    this.cache.set(key, toolSchemaHash);
    return { toolSchemaHash, changed, traceEvent: changed ? 'tool_schema_changed' : 'tool_schema_reused', canonicalTools };
  }
}
