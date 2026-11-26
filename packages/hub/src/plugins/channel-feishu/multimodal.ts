import { basename } from 'node:path'
import { redact } from '@agent-hub/common'
import type { ChannelConfig } from './index.js'
import type { FeishuMessageEvent, FeishuTransport } from './transport.js'

export interface InboundAttachmentData {
  kind: 'inbound_image' | 'inbound_audio' | 'inbound_file'
  fileKey: string
  resourceType: 'image' | 'file'
  name: string
  mimeType: string
  data: Buffer
  transcript?: string
}

export interface ParsedInboundContent {
  text: string | undefined
  resources: { kind: 'inbound_image' | 'inbound_audio' | 'inbound_file'; fileKey: string; resourceType: 'image' | 'file'; name: string; defaultMime: string }[]
}

function collectPost(node: unknown, texts: string[], imageKeys: string[]) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    if (node.some(Array.isArray)) {
      for (const child of node) collectPost(child, texts, imageKeys)
    } else {
      const subTexts: string[] = []
      for (const child of node) collectPost(child, subTexts, imageKeys)
      const line = subTexts.join('')
      if (line) texts.push(line)
    }
    return
  }
  if ('tag' in node) {
    const tag = String((node as { tag?: unknown }).tag)
    if ((tag === 'a' || tag === 'text') && 'text' in node && typeof (node as { text?: unknown }).text === 'string') {
      texts.push((node as { text: string }).text)
    } else if (tag === 'img' && 'image_key' in node && typeof (node as { image_key?: unknown }).image_key === 'string') {
      imageKeys.push((node as { image_key: string }).image_key)
    }
    return
  }
  if ('content' in node) {
    collectPost((node as { content?: unknown }).content, texts, imageKeys)
    return
  }
  const first = Object.values(node)[0]
  if (first !== undefined) collectPost(first, texts, imageKeys)
}

export function extractInboundContent(message: FeishuMessageEvent['message']): ParsedInboundContent {
  let value: unknown
  try { value = JSON.parse(message.content) } catch { return { text: '', resources: [] } }
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>

  if (message.message_type === 'text') {
    return { text: typeof obj.text === 'string' ? obj.text : '', resources: [] }
  }
  if (message.message_type === 'post') {
    const texts: string[] = []
    const imageKeys: string[] = []
    collectPost(value, texts, imageKeys)
    return {
      text: texts.join('\n'),
      resources: imageKeys.slice(0, 4).map((key, idx) => ({
        kind: 'inbound_image' as const,
        fileKey: key,
        resourceType: 'image' as const,
        name: `post-image-${idx + 1}.png`,
        defaultMime: 'image/png',
      })),
    }
  }
  if (message.message_type === 'image' && typeof obj.image_key === 'string' && obj.image_key) {
    return {
      text: undefined,
      resources: [{ kind: 'inbound_image', fileKey: obj.image_key, resourceType: 'image', name: 'image.png', defaultMime: 'image/png' }],
    }
  }
  if (message.message_type === 'audio' && typeof obj.file_key === 'string' && obj.file_key) {
    return {
      text: undefined,
      resources: [{ kind: 'inbound_audio', fileKey: obj.file_key, resourceType: 'file', name: 'voice.ogg', defaultMime: 'audio/ogg' }],
    }
  }
  if (message.message_type === 'file' && typeof obj.file_key === 'string' && obj.file_key) {
    const rawName = typeof obj.file_name === 'string' && obj.file_name ? basename(obj.file_name) : 'attachment.bin'
    const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'attachment.bin'
    return {
      text: undefined,
      resources: [{ kind: 'inbound_file', fileKey: obj.file_key, resourceType: 'file', name: safeName, defaultMime: 'application/octet-stream' }],
    }
  }
  return { text: undefined, resources: [] }
}

async function transcribeAudio(data: Buffer, name: string, mimeType: string, cfg: ChannelConfig['multimodal'], scrub: (text: string) => string): Promise<string | undefined> {
  if (!cfg.asrUrl) return undefined
  const form = new FormData()
  form.append('model', cfg.asrModel)
  form.append('file', new Blob([new Uint8Array(data)], { type: mimeType || 'audio/ogg' }), name)
  const headers: Record<string, string> = {}
  const apiKey = cfg.asrApiKeyEnv ? process.env[cfg.asrApiKeyEnv] : undefined
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey
  const res = await fetch(cfg.asrUrl, {
    method: 'POST',
    headers,
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(cfg.asrTimeoutMs),
  })
  if (!res.ok) throw new Error('ASR HTTP ' + res.status)
  const body = (await res.json()) as { text?: unknown }
  return typeof body.text === 'string' ? scrub(redact(body.text)).trim() : undefined
}

export async function resolveInboundMedia(
  transport: FeishuTransport,
  message: FeishuMessageEvent['message'],
  parsed: ParsedInboundContent,
  cfg: ChannelConfig['multimodal'],
  scrub: (text: string) => string = text => redact(text),
): Promise<{ prompt: string | undefined; attachments: InboundAttachmentData[]; error?: string }> {
  const attachments: InboundAttachmentData[] = []
  const promptParts: string[] = []
  const cleanText = parsed.text?.replace(/@_user_\d+\b/g, '').trim()
  if (cleanText) promptParts.push(cleanText)

  if (!parsed.resources.length) {
    return { prompt: cleanText, attachments }
  }
  if (!transport.downloadResource) {
    if (cleanText !== undefined) return { prompt: cleanText, attachments }
    return { prompt: undefined, attachments, error: '当前传输通道暂不支持下载媒体附件' }
  }

  const dispatchBudget = Math.min(cfg.inlineMaxBytes, 500_000)
  let totalInlineBytes = 0
  const audioCandidates: InboundAttachmentData[] = []

  for (const res of parsed.resources.slice(0, 6)) {
    try {
      const downloaded = await transport.downloadResource(message.message_id, res.fileKey, res.resourceType, cfg.maxFileBytes)
      const mimeType = downloaded.mimeType || res.defaultMime
      let transcript: string | undefined
      if (res.kind === 'inbound_audio') {
        try {
          transcript = await transcribeAudio(downloaded.data, res.name, mimeType, cfg, scrub)
        } catch {
          return { prompt: undefined, attachments, error: '语音转写服务暂不可用，请改发文字或检查 ASR 配置' }
        }
        if (!transcript) {
          return { prompt: undefined, attachments, error: '未配置语音转写（feishu.multimodal.asrUrl），暂无法直接识别语音' }
        }
        promptParts.push(transcript)
        audioCandidates.push({
          kind: res.kind,
          fileKey: res.fileKey,
          resourceType: res.resourceType,
          name: res.name,
          mimeType,
          data: downloaded.data,
          transcript,
        })
      } else {
        if (totalInlineBytes + downloaded.data.length > dispatchBudget) {
          return {
            prompt: undefined,
            attachments: [],
            error: `附件体积超出模型单次处理上限（${Math.round(dispatchBudget / 1024)} KB），请压缩或分批发送`,
          }
        }
        totalInlineBytes += downloaded.data.length
        attachments.push({
          kind: res.kind,
          fileKey: res.fileKey,
          resourceType: res.resourceType,
          name: res.name,
          mimeType,
          data: downloaded.data,
        })
      }
    } catch {
      return { prompt: undefined, attachments, error: `下载飞书附件失败或超出大小限制（上限 ${Math.round(cfg.maxFileBytes / (1024 * 1024))} MiB）` }
    }
  }

  for (const candidate of audioCandidates) {
    if (totalInlineBytes + candidate.data.length <= dispatchBudget) {
      totalInlineBytes += candidate.data.length
      attachments.push(candidate)
    }
  }

  if (!promptParts.length) {
    if (attachments.some(a => a.kind === 'inbound_image')) {
      promptParts.push('请结合附带的截图图片分析并处理当前问题。')
    } else if (attachments.some(a => a.kind === 'inbound_file')) {
      const names = attachments.map(a => a.name).join('、')
      promptParts.push(`请查看并处理附带的文件：${names}`)
    }
  }
  return {
    prompt: promptParts.join('\n').trim() || undefined,
    attachments,
  }
}
