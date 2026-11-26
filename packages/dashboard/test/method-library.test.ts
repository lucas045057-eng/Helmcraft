import { expect, it } from 'vitest'
import { MethodInput } from '@agent-hub/protocol'
import type { MethodCard } from '@agent-hub/protocol'
import { toBody, toDraft } from '../src/MethodLibrary.js'

// 回归：编辑已有方法卡时，表单曾把 id / revision / examples 一并发回，被服务端严格校验拒绝（「请求参数无效」）。
it('sends only editable fields when saving an existing method card', () => {
  const card: MethodCard = { id: 'mtd_' + '1'.repeat(26), name: '给外行画流程图', kind: 'skill', scenario: '让不懂技术的人看懂流程', avoid: '写代码',
    keywords: ['流程图', 'archify'], steps: '调用 archify', done: '一张能看懂的图', status: 'self_confirmed', revision: 3,
    createdAt: 1, updatedAt: 2, examples: [{ id: 'mex_1', title: 't', content: 'c', taskId: null, taskNo: null, revision: 1, createdAt: 1 }] }
  const body = toBody({ ...toDraft(card), keywords: '流程图，archify、架构图' })
  expect(Object.keys(body).sort()).toEqual(['avoid', 'done', 'keywords', 'kind', 'name', 'scenario', 'steps'])
  expect(body.keywords).toEqual(['流程图', 'archify', '架构图'])
  expect(MethodInput.safeParse(body).success).toBe(true)
})
