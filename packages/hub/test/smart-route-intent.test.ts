import { expect, it } from 'vitest'
import { classifyAndRoute } from '../src/plugins/channel-feishu/smart-router.js'

const route = (text: string) => classifyAndRoute(text, ['claude-code', 'codex', 'antigravity'], true, { autoSelectAdapter: true, proposeAutopilot: true })

it('answers small talk and plain questions read-only so they never touch code or the blackboard', () => {
  for (const text of ['今天天气怎么样', '你好，你现在是什么模型', '现在语音功能能用吗，接的是声网的语音吗', '安装的路径是什么', '这个方案行不行？', 'hello'])
    expect(route(text), text).toMatchObject({ intent: 'quick_qa', recommendedProfile: 'readonly' })
})

it('keeps real work as normal tasks even when phrased as a question', () => {
  for (const text of ['帮我修复登录页的 bug', '能帮我实现一个导出接口吗', '给 Forma 新增一个设置页'])
    expect(route(text).intent, text).not.toBe('quick_qa')
})
