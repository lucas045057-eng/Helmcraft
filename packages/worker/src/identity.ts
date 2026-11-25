import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { powershell, psArgs, psLiteral, windowsSystemDir } from './windows-powershell.js'

const windowsOptions: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf8', windowsHide: true, shell: false,
  timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
const aclContext = (path: string) => `
$path = ${psLiteral(path)}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
`

function restrictWindowsIdentity(path: string, writable = false) {
  // Replace the DACL atomically. /inheritance:r alone retains pre-existing explicit grants.
  return execFileSync(powershell, psArgs(aclContext(path) + `
$acl.SetSecurityDescriptorSddlForm(('D:P(A;;${writable ? 'FRFW' : 'FR'};;;' + $sid.Value + ')'), 'Access')
[System.IO.File]::SetAccessControl($path, $acl)
$sid.Value
`), windowsOptions).trim()
}

export function identityPermissionsArePrivate(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile()) return false
  if (process.platform !== 'win32') return (stat.mode & 0o077) === 0
  const result = execFileSync(powershell, psArgs(aclContext(path) + `
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$read = [System.Security.AccessControl.FileSystemRights]::Read
if ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and
    $rules[0].IdentityReference -eq $sid -and $rules[0].AccessControlType -eq 'Allow' -and
    ($rules[0].FileSystemRights -band $read) -eq $read) { 'private' }
`), windowsOptions)
  return result.trim() === 'private'
}

export function loadIdentity(path: string, create = false) {
  if (!existsSync(path) && create) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const { privateKey } = generateKeyPairSync('ed25519')
    // Restrict the empty file before materializing the key on either platform.
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
    try {
      const sid = process.platform === 'win32' ? restrictWindowsIdentity(path, true) : undefined
      writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }))
      if (sid) execFileSync(join(windowsSystemDir, 'icacls.exe'),
        [path, '/grant:r', '*' + sid + ':(R)'], windowsOptions)
    } catch (error) {
      try { unlinkSync(path) } catch { /* Preserve the original failure. */ }
      throw error
    }
  } else {
    if (!lstatSync(path).isFile()) throw new Error('Expected an identity file')
    if (process.platform === 'win32') restrictWindowsIdentity(path)
    else chmodSync(path, 0o600)
  }
  return readIdentity(path)
}

export function readIdentity(path: string) {
  if (!lstatSync(path).isFile()) throw new Error('Expected an identity file')
  const privateKey = createPrivateKey(readFileSync(path))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 worker identity')
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return { privateKey, publicKey: der.toString('base64'), fingerprint: createHash('sha256').update(der).digest('base64url').slice(0, 16) }
}
export type WorkerIdentity = ReturnType<typeof loadIdentity>
