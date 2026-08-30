import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyRegistry, PolicyStatus } from '../packages/dify-core/index.js';

const T0='2026-08-30T04:00:00.000Z',T1='2026-08-30T04:10:00.000Z',T2='2026-08-30T04:20:00.000Z',T3='2026-08-30T04:30:00.000Z',T4='2026-08-30T04:40:00.000Z';

test('ACTIVE promotion is atomic when an exception occurs after staging old ACTIVE replacement',()=>{
  const registry=new PolicyRegistry({policies:[{policyVersion:'v1',basePolicyVersion:null,candidateId:null,status:PolicyStatus.ACTIVE,config:{},createdAt:T0,activatedAt:T0,rollbackOf:null,evidence:{}}]});
  registry.register({policyVersion:'v2',basePolicyVersion:'v1',candidateId:'c2',status:PolicyStatus.REPLAY_PASSED,config:{},createdAt:T1,activatedAt:null,rollbackOf:null,evidence:{}});
  registry.transition('v2',PolicyStatus.CANARY_5,{timestamp:T1,evaluationSnapshotId:'s1',reasonCodes:['OK']});
  registry.transition('v2',PolicyStatus.CANARY_20,{timestamp:T2,evaluationSnapshotId:'s2',reasonCodes:['OK']});
  registry.transition('v2',PolicyStatus.CANARY_50,{timestamp:T3,evaluationSnapshotId:'s3',reasonCodes:['OK']});

  const explodingReasons={
    *[Symbol.iterator](){ yield 'FIRST_REASON'; throw new Error('INJECTED_MID_PROMOTION_FAILURE'); },
  };
  assert.throws(()=>registry.transition('v2',PolicyStatus.ACTIVE,{timestamp:T4,evaluationSnapshotId:'s4',reasonCodes:explodingReasons}),/INJECTED_MID_PROMOTION_FAILURE/);
  assert.equal(registry.getActive().policyVersion,'v1');
  assert.equal(registry.get('v1').status,PolicyStatus.ACTIVE);
  assert.equal(registry.get('v2').status,PolicyStatus.CANARY_50);
  assert.equal(registry.list().filter(p=>p.status===PolicyStatus.ACTIVE).length,1);
});
