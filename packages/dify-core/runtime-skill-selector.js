import { SkillScope } from './skill-candidate.js';
import { SkillStatus } from './skill-registry.js';

function includes(list, value) { return Array.isArray(list) && list.includes(value); }
function scopeMatches(candidate, request) {
  const bindings = candidate.purpose?.bindings || {};
  if (candidate.scope === SkillScope.GENERAL) return true;
  if (candidate.scope === SkillScope.CLIENT_SPECIFIC) return includes(bindings.clientTypes, request.clientType);
  if (candidate.scope === SkillScope.BACKEND_SPECIFIC) {
    return includes(bindings.backendTypes, request.backendType) || includes(bindings.backendIdHashes, request.backendIdHash);
  }
  if (candidate.scope === SkillScope.MODEL_SPECIFIC) return includes(bindings.modelFamilies, request.modelFamily);
  return false;
}
function capabilityMatches(candidate, request) {
  const required = candidate.purpose?.bindings?.requiredCapabilities || [];
  const available = new Set(request.requiredCapabilities || []);
  return required.every((item) => available.has(item));
}

export class RuntimeSkillSelector {
  select(registry, request = {}) {
    return registry.list({ status: SkillStatus.ACTIVE })
      .filter((entry) => scopeMatches(entry.candidate, request) && capabilityMatches(entry.candidate, request))
      .map((entry) => entry.candidate)
      .sort((a, b) => a.skillId.localeCompare(b.skillId));
  }
}
