import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth/AuthContext';
import { AuthShell } from '../components/AuthShell';
import { ErrorBanner, InfoBanner } from '../components/ui';
import { useTitle } from '../hooks';

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
          <p className="muted mt-1.5 text-sm">Enter your DeCircle Solar credentials to access legal documents.</p>
        </div>
        {expiredNotice && <InfoBanner kind="warn">Your session ended. Please sign in again.</InfoBanner>}
        {error && <ErrorBanner message={error} />}
        <label className="field">
          <span>Company email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@decirclesolar.com" required autoFocus />
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
      </form>
    </AuthShell>
  );
}
