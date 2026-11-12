import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, bus, errorMessage } from '../api';
import { Modal, ErrorBanner } from '../components/ui';
import type { AuthUser, Permission } from '../types';

interface AuthState {
  status: 'loading' | 'anon' | 'authed';
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (u: AuthUser) => void;
  can: (p: Permission) => boolean;
  /** True when the user holds at least one of the permissions. */
  canAny: (...p: Permission[]) => boolean;
  expiredNotice: boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [expiredNotice, setExpiredNotice] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    bus.onExpired = () => {
      setUser(null);
      setStatus('anon');
      setExpiredNotice(true);
    };
    bus.askReauth = () =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setReauthOpen(true);
      });
    let alive = true;
    api.restoreSession().then((r) => {
      if (!alive) return;
      if (r) {
        setUser(r.user);
        setStatus('authed');
      } else setStatus('anon');
    });
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    setUser(r.user);
    setStatus('authed');
    setExpiredNotice(false);
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setStatus('anon');
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const r = await api.get<{ user: AuthUser }>('/auth/me');
    setUser(r.data.user);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      login,
      logout,
      refreshUser,
      setUser,
      can: (p) => !!user?.permissions.includes(p),
      canAny: (...ps) => ps.some((p) => !!user?.permissions.includes(p)),
      expiredNotice,
    }),
    [status, user, login, logout, refreshUser, expiredNotice]
  );

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setReauthOpen(false);
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {reauthOpen && <ReauthDialog onDone={finish} />}
    </Ctx.Provider>
  );
}

function ReauthDialog({ onDone }: { onDone: (ok: boolean) => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.reauth(pw);
      onDone(true);
    } catch (ex) {
      setErr(errorMessage(ex));
      setBusy(false);
    }
  }

  return (
    <Modal title="Confirm your password" onClose={() => onDone(false)}>
      <form onSubmit={submit} className="stack">
        <p>This action is sensitive. Enter your password to continue.</p>
        {err && <ErrorBanner message={err} />}
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus />
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={() => onDone(false)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !pw}>{busy ? 'Checking…' : 'Confirm'}</button>
        </div>
      </form>
    </Modal>
  );
}
