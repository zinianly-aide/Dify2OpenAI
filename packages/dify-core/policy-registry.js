import { canonicalJson, sha256 } from './canonical.js';
import { validatePolicyCandidate, validatePolicyChanges } from './policy-candidate.js';
import { PolicyEvaluation } from './policy-evaluator.js';

export const PolicyStatus=Object.freeze({DRAFT:'DRAFT',REPLAY_PASSED:'REPLAY_PASSED',CANARY_5:'CANARY_5',CANARY_20:'CANARY_20',CANARY_50:'CANARY_50',ACTIVE:'ACTIVE',SUPERSEDED:'SUPERSEDED',REJECTED:'REJECTED',ROLLED_BACK:'ROLLED_BACK'});
export const CANARY_STAGES=Object.freeze([PolicyStatus.CANARY_5,PolicyStatus.CANARY_20,PolicyStatus.CANARY_50]);
const NEXT_STAGE=Object.freeze({[PolicyStatus.REPLAY_PASSED]:PolicyStatus.CANARY_5,[PolicyStatus.CANARY_5]:PolicyStatus.CANARY_20,[PolicyStatus.CANARY_20]:PolicyStatus.CANARY_50,[PolicyStatus.CANARY_50]:PolicyStatus.ACTIVE});
function clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value));}
function iso(value){const text=String(value||'');if(!text||Number.isNaN(Date.parse(text)))throw new Error('POLICY_TIMESTAMP_INVALID');return new Date(text).toISOString();}
function freezePolicy(policy){return Object.freeze({...policy,config:Object.freeze(clone(policy.config||{})),evidence:Object.freeze(clone(policy.evidence||{}))});}
function versionOf(candidate){return `policy-${sha256(canonicalJson({basePolicyVersion:candidate.basePolicyVersion,candidateId:candidate.candidateId,changes:candidate.changes})).slice(0,20)}`;}
function activePolicies(map){return [...map.values()].filter(policy=>policy.status===PolicyStatus.ACTIVE);}

export class PolicyRegistry{
  constructor({policies=[],frozen=false,autoPromotionEnabled=true}={}){this.policies=new Map();this.audit=[];this.frozen=frozen===true;this.autoPromotionEnabled=autoPromotionEnabled!==false;this.pinnedActivePolicyVersion=null;for(const policy of policies)this.register(policy,{audit:false});this.#assertUniqueActive(this.policies);}
  #assertUniqueActive(map){if(activePolicies(map).length>1)throw new Error('MULTIPLE_ACTIVE_POLICIES_FORBIDDEN');}
  #assertExactlyOneActive(map){if(activePolicies(map).length!==1)throw new Error('EXACTLY_ONE_ACTIVE_POLICY_REQUIRED');}
  #audit(action,details={}){const entry=Object.freeze({action,...clone(details)});this.audit.push(entry);return entry;}
  #commit(nextPolicies,{requireActive=false}={}){this.#assertUniqueActive(nextPolicies);if(requireActive)this.#assertExactlyOneActive(nextPolicies);this.policies=nextPolicies;}

  register(input,{audit=true}={}){
    if(!input?.policyVersion)throw new Error('POLICY_VERSION_REQUIRED');if(this.policies.has(input.policyVersion))throw new Error('POLICY_VERSION_ALREADY_EXISTS');if(!Object.values(PolicyStatus).includes(input.status))throw new Error('POLICY_STATUS_INVALID');
    const validation=validatePolicyChanges(input.config||{});if(!validation.valid){const error=new Error(`POLICY_CONFIG_INVALID:${validation.errors.join(',')}`);error.code='POLICY_CONFIG_INVALID';error.validation=validation;throw error;}
    const policy=freezePolicy({policyVersion:String(input.policyVersion),basePolicyVersion:input.basePolicyVersion?String(input.basePolicyVersion):null,candidateId:input.candidateId?String(input.candidateId):null,status:input.status,config:input.config||{},createdAt:iso(input.createdAt),activatedAt:input.activatedAt?iso(input.activatedAt):null,rollbackOf:input.rollbackOf?String(input.rollbackOf):null,evidence:input.evidence||{},stageEnteredAt:input.stageEnteredAt?iso(input.stageEnteredAt):iso(input.createdAt)});
    if(policy.status===PolicyStatus.ACTIVE&&this.getActive())throw new Error('ACTIVE_POLICY_ALREADY_EXISTS');const next=new Map(this.policies);next.set(policy.policyVersion,policy);this.#commit(next);if(audit)this.#audit('REGISTER_POLICY',{policyVersion:policy.policyVersion,status:policy.status,timestamp:policy.createdAt});return policy;
  }

  registerReplayPassed({candidate,evaluation,replayResult,baseConfig={},policyVersion,createdAt}){
    const candidateValidation=validatePolicyCandidate(candidate||{});if(!candidateValidation.valid)throw new Error(`CANDIDATE_VALIDATION_FAILED:${candidateValidation.errors.join(',')}`);if(evaluation?.conclusion!==PolicyEvaluation.ACCEPT_FOR_CANARY)throw new Error('CANARY_REQUIRES_ACCEPT_FOR_CANARY');if(!replayResult||replayResult.candidateId!==candidate.candidateId||replayResult.basePolicyVersion!==candidate.basePolicyVersion)throw new Error('REPLAY_IDENTITY_MISMATCH');if(Number(replayResult.risk?.capabilityViolationCount||0)>0)throw new Error('CANARY_CAPABILITY_VALIDATION_FAILED');if(Number(replayResult.risk?.unsupportedDecisionCount||0)>0)throw new Error('CANARY_UNSUPPORTED_DECISION');const active=this.getActive();if(!active||active.policyVersion!==candidate.basePolicyVersion)throw new Error('CANARY_BASE_POLICY_VERSION_MISMATCH');
    const config={...(clone(baseConfig)||{}),...(clone(candidate.changes)||{}),compression:{...(baseConfig.compression||{}),...(candidate.changes?.compression||{})},checkpoint:{...(baseConfig.checkpoint||{}),...(candidate.changes?.checkpoint||{})},backendPriority:{...(baseConfig.backendPriority||{}),...(candidate.changes?.backendPriority||{})},backendHealth:{...(baseConfig.backendHealth||{}),...(candidate.changes?.backendHealth||{})},tool:{...(baseConfig.tool||{}),...(candidate.changes?.tool||{})}};const configValidation=validatePolicyChanges(config);if(!configValidation.valid)throw new Error(`POLICY_CONFIG_INVALID:${configValidation.errors.join(',')}`);
    return this.register({policyVersion:policyVersion||versionOf(candidate),basePolicyVersion:candidate.basePolicyVersion,candidateId:candidate.candidateId,status:PolicyStatus.REPLAY_PASSED,config,createdAt,evidence:{replayDatasetId:replayResult.dataset?.datasetId??null,replayContentHash:replayResult.dataset?.contentHash??null,replayEvaluation:evaluation.conclusion,replayReasonCodes:evaluation.reasonCodes||[]}});
  }

  get(policyVersion){return this.policies.get(String(policyVersion))||null;}
  list(){return [...this.policies.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.policyVersion.localeCompare(b.policyVersion));}
  getActive(){return this.list().find(policy=>policy.status===PolicyStatus.ACTIVE)||null;}
  getAuditLog(){return [...this.audit];}
  validatePolicy(policyVersion){const policy=this.get(policyVersion);if(!policy)return Object.freeze({valid:false,errors:Object.freeze(['POLICY_NOT_FOUND'])});const validation=validatePolicyChanges(policy.config||{});return Object.freeze({valid:validation.valid,errors:Object.freeze([...validation.errors])});}
  nextStage(policyVersion){const policy=this.get(policyVersion);return policy?NEXT_STAGE[policy.status]||null:null;}

  transition(policyVersion,targetStage,{evaluationSnapshotId=null,reasonCodes=[],timestamp,manual=false}={}){
    const policy=this.get(policyVersion);if(!policy)throw new Error('POLICY_NOT_FOUND');const expected=NEXT_STAGE[policy.status];if(expected!==targetStage)throw new Error(`POLICY_STAGE_SKIP_FORBIDDEN:${policy.status}->${targetStage}`);if(!manual&&this.frozen)throw new Error('POLICY_EVOLUTION_FROZEN');if(!manual&&!this.autoPromotionEnabled&&targetStage!==PolicyStatus.CANARY_5)throw new Error('AUTO_PROMOTION_DISABLED');if(targetStage===PolicyStatus.ACTIVE&&this.pinnedActivePolicyVersion&&this.pinnedActivePolicyVersion!==policyVersion)throw new Error('ACTIVE_POLICY_PINNED');const when=iso(timestamp),validation=this.validatePolicy(policyVersion);if(!validation.valid)throw new Error(`POLICY_CONFIG_INVALID:${validation.errors.join(',')}`);
    const sourceStage=policy.status,next=new Map(this.policies);if(targetStage===PolicyStatus.ACTIVE){const oldActive=this.getActive();if(!oldActive)throw new Error('STABLE_ACTIVE_REQUIRED_FOR_PROMOTION');if(oldActive.policyVersion!==policyVersion)next.set(oldActive.policyVersion,freezePolicy({...oldActive,status:PolicyStatus.SUPERSEDED}));}
    const updated=freezePolicy({...policy,status:targetStage,stageEnteredAt:when,activatedAt:targetStage===PolicyStatus.ACTIVE?when:policy.activatedAt,evidence:{...clone(policy.evidence),lastTransition:{sourceStage,targetStage,evaluationSnapshotId,reasonCodes:[...reasonCodes],timestamp:when,manual:manual===true}}});next.set(policyVersion,updated);
    this.#commit(next,{requireActive:true});this.#audit(manual?'MANUAL_PROMOTE':'PROMOTE',{policyVersion,sourceStage,targetStage,evaluationSnapshotId,reasonCodes:[...reasonCodes],timestamp:when});return updated;
  }

  rollback(policyVersion,{targetPolicyVersion,reasonCodes=[],timestamp,manual=false}={}){
    const policy=this.get(policyVersion);if(!policy)throw new Error('POLICY_NOT_FOUND');const target=this.get(targetPolicyVersion);if(!target)throw new Error('ROLLBACK_TARGET_NOT_FOUND');const targetValidation=validatePolicyChanges(target.config||{});if(!targetValidation.valid)throw new Error('ROLLBACK_TARGET_INVALID');const when=iso(timestamp),active=this.getActive(),candidateWasActive=active?.policyVersion===policyVersion;if(candidateWasActive&&target.status!==PolicyStatus.ACTIVE&&target.status!==PolicyStatus.SUPERSEDED)throw new Error('ROLLBACK_TARGET_NOT_STABLE');
    const next=new Map(this.policies),rolledBack=freezePolicy({...policy,status:PolicyStatus.ROLLED_BACK,rollbackOf:target.policyVersion,evidence:{...clone(policy.evidence),rollback:{targetPolicyVersion:target.policyVersion,reasonCodes:[...reasonCodes],timestamp:when,manual:manual===true}}});next.set(policyVersion,rolledBack);let targetAfter=target;if(candidateWasActive){targetAfter=freezePolicy({...target,status:PolicyStatus.ACTIVE,activatedAt:when,stageEnteredAt:when});next.set(target.policyVersion,targetAfter);}this.#commit(next,{requireActive:true});this.#audit(manual?'MANUAL_ROLLBACK':'AUTO_ROLLBACK',{policyVersion,targetPolicyVersion:target.policyVersion,reasonCodes:[...reasonCodes],timestamp:when});return Object.freeze({rolledBackPolicy:rolledBack,targetPolicy:targetAfter});
  }

  freezeEvolution({timestamp}){this.frozen=true;return this.#audit('FREEZE_EVOLUTION',{timestamp:iso(timestamp)});}
  resumeEvolution({timestamp}){this.frozen=false;return this.#audit('RESUME_EVOLUTION',{timestamp:iso(timestamp)});}
  disableAutoPromotion({timestamp}){this.autoPromotionEnabled=false;return this.#audit('DISABLE_AUTO_PROMOTION',{timestamp:iso(timestamp)});}
  enableAutoPromotion({timestamp}){this.autoPromotionEnabled=true;return this.#audit('ENABLE_AUTO_PROMOTION',{timestamp:iso(timestamp)});}
  pinActivePolicy(policyVersion,{timestamp}){const policy=this.get(policyVersion);if(!policy||policy.status!==PolicyStatus.ACTIVE)throw new Error('PIN_REQUIRES_ACTIVE_POLICY');this.pinnedActivePolicyVersion=policy.policyVersion;return this.#audit('PIN_ACTIVE_POLICY',{policyVersion:policy.policyVersion,timestamp:iso(timestamp)});}
  clearActivePin({timestamp}){const previous=this.pinnedActivePolicyVersion;this.pinnedActivePolicyVersion=null;return this.#audit('CLEAR_ACTIVE_PIN',{policyVersion:previous,timestamp:iso(timestamp)});}
}
