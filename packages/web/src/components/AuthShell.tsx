import { FileLock2, KeyRound, ScrollText, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from './Logo';
import { SunPanels } from './Illustrations';

const POINTS = [
  { icon: FileLock2, tone: 'sun', title: 'Every file encrypted', text: 'Each PDF has its own AES-256 key, wrapped by a master key.' },
  { icon: KeyRound, tone: 'sky', title: 'Access you control', text: 'Role-based permissions and a password check before sensitive actions.' },
  { icon: ScrollText, tone: 'mint', title: 'A record nobody can edit', text: 'Every action is written to a tamper-evident audit chain.' },
] as const;

const LINES = ['Confidential by design.', 'Invitation-only access.', 'Scanned, encrypted, auditable.'];

/** Split layout used by sign-in and forced password change: sunrise brand panel left, form right. */
export function AuthShell({ children }: { children: ReactNode }) {
  const appConfig = (typeof window !== 'undefined' && (window as any).__APP_CONFIG__) || {};
  const companyName = appConfig.companyName || (import.meta as any).env.VITE_COMPANY_NAME || (import.meta as any).env.APP_COMPANY_NAME || 'DeCircle Solar';
  const [line, setLine] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setLine((l) => (l + 1) % LINES.length), 3200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <aside className="hero relative hidden flex-col justify-between rounded-none p-12 lg:flex">
        <div className="flex items-center gap-3 text-lg font-semibold tracking-tight">
          <Logo size={38} />
          <span className="font-display">{companyName}</span>
        </div>

        <div className="max-w-xl">
          <p className="mb-3 h-6 text-sm font-medium text-amber-300" aria-live="polite" key={line}>
            <span className="animate-sunrise inline-block">{LINES[line]}</span>
          </p>
          <h2 className="font-display !mb-4 text-[40px] font-semibold leading-[1.1] tracking-tight text-white">
            Contracts that stay private, from upload to inbox.
          </h2>
          <p className="mb-9 max-w-md text-[15px] leading-relaxed text-slate-300">
            Store NDAs and mandates once, keep every version, and send the right one in a few clicks.
          </p>
          <ul className="relative z-10 m-0 grid list-none gap-3.5 p-0">
            {POINTS.map((p) => (
              <li key={p.title} className="flex items-start gap-3.5 rounded-xl border border-white/10 bg-white/[0.06] p-3.5 backdrop-blur">
                <span className={`icon-chip ${p.tone} !size-9`}>
                  <p.icon className="size-[18px]" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-white">{p.title}</span>
                  <span className="block text-[13px] leading-snug text-slate-300">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative">
          <SunPanels className="animate-drift pointer-events-none absolute -bottom-10 -right-12 w-[300px] opacity-80" />
          <p className="relative flex items-center gap-2 text-xs text-slate-300">
            <ShieldCheck className="size-4 text-amber-400" aria-hidden="true" />
            Internal use only. Activity is recorded.
          </p>
        </div>
      </aside>

      <main className="relative grid place-items-center bg-background px-6 py-12">
        <div className="w-full max-w-[420px] rounded-2xl border bg-card p-8 shadow-lift">
          <div className="mb-7 flex items-center gap-3 lg:hidden">
            <Logo size={36} />
            <span className="font-display text-lg font-semibold tracking-tight">{companyName}</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
