import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from 'cordis'
import { z } from 'zod'

export const name = 'dashboard-static'
export const inject = ['http']
export const Config = z.strictObject({ distDir: z.string().min(1) })
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

export function apply(ctx: Context, config: z.infer<typeof Config>) {
  const dir = resolve(config.distDir)
  ctx.effect(() => ctx.http.staticFallback(async (req, res) => {
    const missing = () => res.code(404).send()
    if (req.method !== 'GET' && req.method !== 'HEAD') return missing()
    let path: string
    try { path = decodeURIComponent(req.url.split('?')[0]!) } catch { return res.code(400).send() }
    if (/^\/(?:api|ws|healthz|readyz)(?:\/|$)/.test(path) || /[\\\0:]/.test(path) ||
        path.split('/').some(part => part === '..' || part.startsWith('.'))) return missing()
    const root = await realpath(dir).catch(() => null)
    if (!root) return missing()
    const file = async (suffix: string) => {
      const target = await realpath(resolve(root, '.' + suffix)).catch(() => null)
      if (!target) return
      const rel = relative(root, target)
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return
      if ((await stat(target).catch(() => null))?.isFile()) return target
    }
    const asset = await file(path)
    const target = asset ?? (path.startsWith('/assets/') ? undefined : await file('/index.html'))
    if (!target) return missing()
    res.type(mime[extname(target)] ?? 'application/octet-stream')
    res.header('X-Content-Type-Options', 'nosniff')
    res.header('Cache-Control', asset && path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    return res.send(req.method === 'HEAD' ? undefined : createReadStream(target))
  }), 'dashboard:static')
}

