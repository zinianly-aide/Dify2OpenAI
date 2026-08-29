import { canonicalJson, sha256 } from './canonical.js';

function toolIdentity(tool) {
  return String(tool?.name || tool?.function?.name || canonicalJson(tool));
}

export function normalizeToolSchemas(tools = []) {
  return [...tools].sort((a, b) => {
    const byName = toolIdentity(a).localeCompare(toolIdentity(b));
    return byName || canonicalJson(a).localeCompare(canonicalJson(b));
  });
}

export class ToolSchemaRegistry {
  constructor() { this.cache = new Map(); }
  key(dshConversationId, providerId, difyAppId = '') { return `${dshConversationId}::${providerId}::${difyAppId}`; }
  resolve({ dshConversationId, providerId, difyAppId = '', tools = [] }) {
    const normalizedTools = normalizeToolSchemas(tools);
    const canonicalTools = canonicalJson(normalizedTools);
    const toolSchemaHash = sha256(canonicalTools);
    const key = this.key(dshConversationId, providerId, difyAppId);
    const previous = this.cache.get(key);
    const changed = previous !== toolSchemaHash;
    this.cache.set(key, toolSchemaHash);
    return {
      toolSchemaHash,
      changed,
      traceEvent: changed ? 'tool_schema_changed' : 'tool_schema_reused',
      canonicalTools,
      normalizedTools,
    };
  }
}
