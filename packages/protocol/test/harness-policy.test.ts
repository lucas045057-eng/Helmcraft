import fc from 'fast-check'
import { expect, it } from 'vitest'
import { resolveHarness, autoAcceptDecision } from '../src/index.js'
import type { ResolveHarnessInput, AutoAcceptInput } from '../src/index.js'

const input: ResolveHarnessInput = { caps: ['blackboard.v1','verify.v1'], requesterType:'owner', profile:'edit', adapter:'mock',
  prompt:'#scenario:success harness=1', resume:false, handoff:false, policy:{enabled:true,blackboard:true,verify:true,
    allowRequesterBlackboard:false,allowRequesterVerify:false,autoFixMaxRetries:2} }
it('applies capability, policy and mock opt-in gates first', () => {
  for (const change of [{ caps: [] }, { policy: { ...input.policy, enabled: false } }, { prompt: 'harness=1' },
    { prompt: '#scenario:success\nharness=1' }]) expect(resolveHarness({...input,...change})).toBeNull()
  expect(resolveHarness(input)).toMatchObject({ board:'write', inject:'fresh', bootstrap:true,verify:{autoFixMaxRetries:2} })
  expect(resolveHarness({...input,resume:true,handoff:true})).toMatchObject({inject:'resume',bootstrap:false})
  expect(resolveHarness({...input,requesterType:'requester'})).toEqual({v:1,board:'capture',inject:'none',trust:'requester',bootstrap:false})
  expect(resolveHarness({...input,requesterType:'requester',overrides:{blackboard:true,verify:true},handoff:true})).toMatchObject({
    board:'write',inject:'handoff',bootstrap:false,verify:{autoFixMaxRetries:0} })
})
it('keeps bootstrap and verification inside the requested authority and profile', () => {
  fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),(owner,resume,allow,readonly) => {
    const result = resolveHarness({...input,requesterType:owner?'owner':'requester',profile:readonly?'readonly':'edit',resume,
      overrides:{blackboard:allow,verify:allow}})!
    expect(result.bootstrap).toBe(owner && allow && !readonly && !resume)
    if (readonly) { expect(result.verify).toBeUndefined(); expect(result.board).not.toBe('write') }
    if (!owner && result.verify) expect(result.verify.autoFixMaxRetries).toBe(0)
  }))
})
const accept: AutoAcceptInput = {trust:'owner',profile:'edit',runStatus:'succeeded',verificationRequested:false,predecessorAccepted:false}
it('automatically accepts only eligible outcomes', () => {
  expect(autoAcceptDecision(accept).accept).toBe(true)
  for (const change of [{trust:'requester'}, {profile:'readonly'}, {runStatus:'failed'}, {verificationRequested:true}] as const) {
    expect(autoAcceptDecision({...accept,...change}).accept).toBe(false)
  }
  for (const reason of ['NO_COMMANDS','NO_CHANGES','TAMPER_RISK','CONFIG_EXPOSED'] as const) {
    for (const predecessorAccepted of [false,true]) expect(autoAcceptDecision({...accept,verificationRequested:true,predecessorAccepted,
      verification:{status:'skipped',reason,attempts:0,failed:[]}}).accept).toBe(reason==='NO_COMMANDS'||(reason==='NO_CHANGES'&&predecessorAccepted))
  }
})
