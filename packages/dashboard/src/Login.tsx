import { useState } from 'react'
import type { FormEvent } from 'react'
import { errorText } from './api.js'

export function Login({ onLogin }: { onLogin: (token: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const token = String(new FormData(event.currentTarget).get('token'))
    setBusy(true)
    setError('')
    try { await onLogin(token) } catch (fault) { setError(errorText(fault)) } finally { setBusy(false) }
  }
  return <main className="login-shell">
    <section className="login-panel" data-testid="login-page">
      <div className="brand-mark" aria-hidden="true">⌘</div>
      <div className="wordmark">AGENT<span>HUB</span></div>
      <h1>虚拟中台指挥台</h1>
      <form onSubmit={submit}>
        <label>管理令牌<input data-testid="login-token" name="token" type="password" autoComplete="current-password" required autoFocus /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" data-testid="login-submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>
    </section>
  </main>
}

