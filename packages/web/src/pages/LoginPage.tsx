import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth/AuthContext';
import { AuthShell } from '../components/AuthShell';
import { ErrorBanner, InfoBanner } from '../components/ui';
import { useTitle } from '../hooks';

function GoogleIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" {...props}>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.6 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.6 35 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.3 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.6 5.6C39.9 37.1 44 31.1 44 24c0-1.3-.1-2.7-.4-3.5z" />
    </svg>
  );
}

const companyName = (import.meta as any).env.VITE_COMPANY_NAME || 'DeCircle Solar';
const domain = (import.meta as any).env.VITE_ALLOWED_EMAIL_DOMAIN || 'decirclesolar.com';
const googleLoginEnabled = (import.meta as any).env.VITE_AUTH_GOOGLE_LOGIN_ENABLED === 'true';
const passwordLoginEnabled = (import.meta as any).env.VITE_AUTH_PASSWORD_LOGIN_ENABLED !== 'false';

const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  wrong_domain: `This Google account is not part of ${companyName}. Sign in with your work Google account.`,
  not_invited: 'No account is set up for this Google address. Ask an administrator to invite you.',
  deactivated: 'This account has been deactivated. Contact an administrator.',
  cancelled: 'Sign-in with Google was cancelled.',
  expired: 'That sign-in attempt expired. Please try again.',
  invalid: 'Google sign-in failed. Please try again.',
};

export function LoginPage() {
  useTitle('Sign in');
  const { status, login, expiredNotice } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (loc.state as { from?: string } | null)?.from;
  const googleErrorCode = new URLSearchParams(loc.search).get('error');
  const googleError = googleErrorCode ? (GOOGLE_ERROR_MESSAGES[googleErrorCode] ?? GOOGLE_ERROR_MESSAGES.invalid) : null;

  if (status === 'authed') return <Navigate to={from && from !== '/login' ? from : '/'} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login(email.trim(), password);
      nav(u.mustChangePassword ? '/change-password' : from && from !== '/login' ? from : '/', { replace: true });
    } catch (ex) {
      setError(ex instanceof ApiError && ex.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : ex instanceof Error ? ex.message : 'Sign-in failed');
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <form className="stack gap-5" onSubmit={submit} aria-labelledby="login-title">
        <div>
          <h1 id="login-title" className="text-[26px]">Sign in</h1>
          <p className="muted mt-1.5 text-sm">Enter your {companyName} credentials to access legal documents.</p>
        </div>
        {expiredNotice && <InfoBanner kind="warn">Your session ended. Please sign in again.</InfoBanner>}
        {googleError && <ErrorBanner message={googleError} />}
        {error && <ErrorBanner message={error} />}
        {googleLoginEnabled && (
          <>
            <a href="/api/v1/auth/google/start" className="btn h-10 w-full justify-center gap-2 no-underline">
              <GoogleIcon className="size-4" aria-hidden="true" />Continue with Google
            </a>
            {passwordLoginEnabled && (
              <div className="row items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
                <span className="h-px flex-1 bg-border" /><span>or</span><span className="h-px flex-1 bg-border" />
              </div>
            )}
          </>
        )}
        {passwordLoginEnabled && (
          <>
            <label className="field">
              <span>Company email</span>
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={`name@${domain}`} required autoFocus />
            </label>
            <label className="field">
              <span>Password</span>
              <span className="relative block">
                <input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="!pr-11" required />
                <button type="button" className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </span>
            </label>
            <button className="btn primary h-10 w-full" type="submit" disabled={busy || !email || !password}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="muted m-0 text-center text-xs">Forgot your password? Ask an administrator to reset it.</p>
          </>
        )}
      </form>
    </AuthShell>
  );
}
