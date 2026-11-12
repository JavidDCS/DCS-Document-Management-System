import { Check, Circle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth/AuthContext';
import { AuthShell } from '../components/AuthShell';
import { ErrorBanner, InfoBanner, cn } from '../components/ui';
import { useTitle } from '../hooks';
import { checkPasswordPolicy } from '../lib/password';

function PasswordInput({ value, onChange, autoComplete, id }: { value: string; onChange: (v: string) => void; autoComplete: string; id?: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative block">
      <input id={id} type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} className="!pr-11" required />
      <button type="button" className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </span>
  );
}

/** Shared by the forced first-sign-in page and the account settings page. */
export function PasswordForm({ onDone, forced }: { onDone: () => void; forced?: boolean }) {
  const { user, refreshUser } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const problems = checkPasswordPolicy(next, { email: user?.email ?? '', name: user?.name ?? '' });
  const has = (needle: string) => problems.some((p) => p.includes(needle));
  const rules = [
    { label: 'At least 12 characters', ok: next.length >= 12 },
    { label: 'Not a common password', ok: next.length > 0 && !has('common') && !has('different characters') },
    { label: 'Does not contain your name or email', ok: next.length > 0 && !has('email name') && !has('your name') },
    { label: 'Different from the current password', ok: next.length > 0 && next !== current },
    { label: 'Both new passwords match', ok: next.length > 0 && next === repeat },
  ];
  const passed = rules.filter((r) => r.ok).length;
  const valid = problems.length === 0 && rules.every((r) => r.ok);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      await refreshUser();
      toast.success('Password changed', { description: forced ? undefined : 'Your other sessions were signed out.' });
      setCurrent('');
      setNext('');
      setRepeat('');
      onDone();
    } catch (ex) {
      setError(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      {forced && <InfoBanner kind="warn">Choose a new password to continue. Your temporary password only works once.</InfoBanner>}
      {error && <ErrorBanner message={error} />}
      <label className="field">
        <span>{forced ? 'Temporary password' : 'Current password'}</span>
        <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" />
      </label>
      <label className="field">
        <span>New password</span>
        <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
      </label>
      <label className={`field${repeat !== '' && repeat !== next ? ' has-error' : ''}`}>
        <span>Repeat new password</span>
        <PasswordInput value={repeat} onChange={setRepeat} autoComplete="new-password" />
      </label>

      <div className="rounded-xl border bg-muted/40 p-4" aria-live="polite">
        <div className="mb-2.5 flex items-center justify-between text-xs font-medium">
          <span>Password strength checklist</span>
          <span className={cn(passed === rules.length ? 'text-success' : 'text-muted-foreground')}>{passed}/{rules.length}</span>
        </div>
        <div className="progress mb-3" role="progressbar" aria-valuemin={0} aria-valuemax={rules.length} aria-valuenow={passed} aria-label="Password requirements met">
          <div style={{ width: `${(passed / rules.length) * 100}%`, background: passed === rules.length ? 'var(--success)' : undefined }} />
        </div>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
          {rules.map((r) => (
            <li key={r.label} className={cn('flex items-center gap-2', r.ok ? 'text-success' : 'text-muted-foreground')}>
              {r.ok ? <Check className="size-3.5" aria-hidden="true" /> : <Circle className="size-3.5" aria-hidden="true" />}
              {r.label}<span className="sr-only">{r.ok ? ' (done)' : ' (not yet)'}</span>
            </li>
          ))}
        </ul>
      </div>

      <button className="btn primary h-10" type="submit" disabled={busy || !current || !valid}>
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

export function ChangePasswordPage() {
  useTitle('Change password');
  const nav = useNavigate();
  const { user, logout } = useAuth();
  return (
    <AuthShell>
      <div className="stack gap-5">
        <div>
          <h1 className="text-[26px]">Set a new password</h1>
          <p className="muted mt-1.5 text-sm">You are signed in as <strong className="text-foreground">{user?.email}</strong>.</p>
        </div>
        <PasswordForm forced={!!user?.mustChangePassword} onDone={() => nav('/', { replace: true })} />
        <button className="btn link self-center text-xs" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
      </div>
    </AuthShell>
  );
}
