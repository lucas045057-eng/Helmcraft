import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

const reserved = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]*\.|$)/iu
const control = /[\x00-\x1f\x7f]/u
function validateSegments(path: string) {
  for (const segment of path.split(/[\\/]/u)) {
    if (!segment || segment === '.') continue
    if (segment === '..' || /[<>:"|?*]/u.test(segment) || control.test(segment) || /[ .]$/u.test(segment) || reserved.test(segment)) {
      throw new Error('Unsafe workspace path component')
    }
  }
}

export function withinWorkspace(root: string, path: string, windows = process.platform === 'win32'): boolean {
  if (windows) {
    root = win32.normalize(root).toLowerCase()
    path = win32.normalize(path).toLowerCase()
  }
  const separator = windows ? '\\' : sep
  return root === path || path.startsWith(root.endsWith(separator) ? root : root + separator)
}

export function resolveWorkspaceRoot(path: string): string {
  if (!isAbsolute(path) || /^[\\/]{2}/u.test(path) || (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(path))) throw new Error('Workspace root must be an absolute local path')
  validateSegments(path.replace(/^[a-z]:/iu, ''))
  const root = realpathSync.native(path)
  if (/^[\\/]{2}/u.test(root) || !statSync(root).isDirectory()) throw new Error('Workspace root must be a local directory')
  validateSegments(root.replace(/^[a-z]:/iu, ''))
  return root
}

export function workspaceSubdirPath(root: string, subdir = '.'): string {
  if (isAbsolute(subdir) || win32.isAbsolute(subdir) || /^[a-z]:/iu.test(subdir)) throw new Error('Expected a relative working directory')
  validateSegments(subdir)
  return resolve(root, ...subdir.split(/[\\/]/u))
}

export function resolveWorkspaceSubdir(root: string, subdir = '.'): string {
  const path = workspaceSubdirPath(root, subdir)
  const verifiedRoot = resolveWorkspaceRoot(root)
  if (!withinWorkspace(root, verifiedRoot) || !withinWorkspace(verifiedRoot, root)) throw new Error('Workspace root changed')
  const directory = realpathSync.native(path)
  if (!withinWorkspace(root, directory) || !statSync(directory).isDirectory()) throw new Error('Working directory escapes workspace')
  return directory
}

export function mapWorkspaceFile(root: string, cwd: string, path: string): string {
  if (/^[\\/]{2}/u.test(path)) throw new Error('File is outside the workspace')
  // A POSIX file can have a literal backslash in its name. Prefer that entry
  // when present, while accepting portable CLI paths when it is absent.
  const native = resolve(cwd, path)
  const literal = process.platform !== 'win32' && path.includes('\\') && withinWorkspace(root, native) &&
    lstatSync(native, { throwIfNoEntry: false })
  const candidate = literal ? native : resolve(cwd, path.replaceAll('\\', '/'))
  if (!withinWorkspace(root, candidate)) throw new Error('File is outside the workspace')
  const local = relative(root, candidate)
  validateSegments(local)
  // Deleted files may no longer resolve. The nearest remaining ancestor must
  // still be inside the workspace and must not resolve through a junction out.
  let probe = candidate
  for (;;) {
    try {
      const real = realpathSync.native(probe)
      if (!withinWorkspace(root, real)) throw new Error('File resolves outside the workspace')
      return literal ? local : local.replaceAll('\\', '/')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || probe === root) throw error
      probe = dirname(probe)
    }
  }
}

