import type { AdapterId } from '@agent-hub/protocol'
import { row } from '../adapters/structured.js'
import type { PersonalRole } from './roles.js'

// The general CLI summary may be truncated or inferred from a log tail. Personal
// runs require the native terminal event and a complete result within the wire limit.
export class PersonalResult {
  private text: string | undefined
  private ended = false
  private invalid = false
  private reviewerReady = false
  constructor(
    private readonly role: PersonalRole,
    private readonly adapter?: AdapterId,
    private readonly flexible = false,
  ) {}

  observe(line: string, truncated = false) {
    if (truncated) { this.invalid = true; return }
    let event: ReturnType<typeof row>
    try { event = row(JSON.parse(line)) } catch { this.invalid = true; return }
    if (!event || this.ended) { this.invalid = true; return }
    if (!this.flexible) {
      if (this.role === 'main') {
        const item = row(event.item)
        if (event.type === 'item.completed' && item?.type === 'agent_message') this.capture(item.text)
        if (event.type === 'turn.completed') this.ended = true
      } else if (this.role === 'reviewer') {
        if (event.type === 'system' && event.subtype === 'init') {
          this.reviewerReady = Array.isArray(event.tools) && event.tools.length === 0 && event.model === 'claude-opus-5-5'
          if (!this.reviewerReady) this.invalid = true
        }
        if (event.type === 'result' && event.subtype === 'success' && event.is_error === false) {
          this.capture(event.result)
          this.ended = true
        }
      } else if (event.event === 'result') {
        const result = row(event.result)
        if (result?.status === 'SUCCESS') this.capture(result.response)
        this.ended = true
      }
      return
    }
    if (this.adapter === 'claude-code') {
      if (event.type === 'system' && event.subtype === 'init') {
        if (this.role === 'reviewer') {
          this.reviewerReady = Array.isArray(event.tools) && event.tools.length === 0
          if (!this.reviewerReady) this.invalid = true
        }
      }
      if (event.type === 'result' && event.subtype === 'success' && event.is_error === false) {
        this.capture(event.result)
        this.ended = true
      }
    } else if (this.adapter === 'antigravity') {
      if (event.event === 'result') {
        const result = row(event.result)
        if (result?.status === 'SUCCESS') this.capture(result.response)
        this.ended = true
      }
    } else if (this.adapter === 'mock') {
      if (event.type === 'message' && event.role === 'assistant' && event.final === true) {
        this.capture(event.text)
        this.ended = true
      }
    } else {
      const item = row(event.item)
      if (event.type === 'item.completed' && item?.type === 'agent_message') this.capture(item.text)
      if (event.type === 'turn.completed') this.ended = true
    }
  }

  private capture(value: unknown) {
    this.text = typeof value === 'string' && value.length <= 20_000 && value.trim() ? value : undefined
  }

  finish() {
    const needsReviewerInit = !this.flexible ? this.role === 'reviewer' : (this.role === 'reviewer' && this.adapter === 'claude-code')
    return this.ended && !this.invalid && (!needsReviewerInit || this.reviewerReady) ? this.text : undefined
  }
}
