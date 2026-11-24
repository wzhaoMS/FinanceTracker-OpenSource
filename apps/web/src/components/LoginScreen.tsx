import { useEffect, useState, type FormEvent } from 'react';

import { useAuthStore } from '../stores/auth';
import { HoldrMark } from './icons';

const USER_CLI_COMMAND = 'npm run holdr-user -- add <username>';
const SIGN_OUT_RETRY_MS = 10_000;

/** Minimal sign-in form. Accounts are created on the server with the holdr-user CLI. */
export function LoginScreen() {
  const status = useAuthStore((s) => s.status);
  const notice = useAuthStore((s) => s.notice);
  const signOutError = useAuthStore((s) => s.signOutError);
  const signOutBusy = useAuthStore((s) => s.signOutBusy);
  const storageWarning = useAuthStore((s) => s.storageWarning);
  const signIn = useAuthStore((s) => s.signIn);
  const retrySignOut = useAuthStore((s) => s.retrySignOut);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setupRequired = status === 'setup-required';
  const signingOut = status === 'signing-out';

  // Until the server confirms the sign-out, keep trying (and right away when the network returns).
  useEffect(() => {
    if (!signingOut) return undefined;
    const retry = () => { void retrySignOut(); };
    const timer = setInterval(retry, SIGN_OUT_RETRY_MS);
    window.addEventListener('online', retry);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', retry);
    };
  }, [signingOut, retrySignOut]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page">
      <form className="login-form" onSubmit={submit} aria-labelledby="login-title">
        <div className="login-brand">
          <HoldrMark size={30} className="brand-mark" />
          <h1 id="login-title">Holdr</h1>
        </div>
        <p className="login-lede">Sign in to your household portfolio and spending.</p>
        {signingOut ? (
          signOutError ? (
            <div className="login-message login-warning" role="alert">
              <strong>Sign-out not confirmed.</strong> {signOutError} The session may still be valid on the
              server, so your data stays hidden here and Holdr keeps retrying.{' '}
              <button type="button" className="login-retry" disabled={signOutBusy} onClick={() => { void retrySignOut(); }}>
                {signOutBusy ? 'Retrying…' : 'Retry now'}
              </button>
            </div>
          ) : (
            <div className="login-message" role="status">Signing out…</div>
          )
        ) : setupRequired ? (
          <div className="login-message" role="status">
            No Holdr users exist yet. On the server, run <code>{USER_CLI_COMMAND}</code>, then sign in here.
          </div>
        ) : notice ? (
          <div className="login-message" role="status">{notice}</div>
        ) : null}
        {storageWarning ? <div className="login-message login-warning" role="alert">{storageWarning}</div> : null}
        <label>
          Username
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
