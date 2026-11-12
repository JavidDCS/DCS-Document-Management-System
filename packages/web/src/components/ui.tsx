import * as Dialog from '@radix-ui/react-dialog';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as RTabs from '@radix-ui/react-tabs';
import * as Tip from '@radix-ui/react-tooltip';
import * as RSwitch from '@radix-ui/react-switch';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Check, Copy, Info, Loader2, Lock, Mail, Search, Send, X, type LucideIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../api';
import { isEmail } from '../lib/format';
import { cn } from '../lib/cn';
import { useCountUp } from '../lib/motion';
import { ArtFor, gradientFor, type Art } from './Illustrations';

export { cn };

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="center" role="status" aria-live="polite">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" /> {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" />;
}

/** Placeholder rows/cards while data loads. */
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="card" role="status" aria-label="Loading">
      <div className="stack gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-9 shrink-0 !rounded-lg" />
            <div className="flex-1 space-y-2"><Skeleton className="h-3 w-2/5" /><Skeleton className="h-3 w-3/5" /></div>
            <Skeleton className="hidden h-6 w-16 !rounded-full sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorBanner({ message, error, onRetry }: { message?: string; error?: unknown; onRetry?: () => void }) {
  const text = message ?? errorMessage(error);
  return (
    <div className="banner error" role="alert">
      <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{text}</span>
      {onRetry && <button className="btn small" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function InfoBanner({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'warn' | 'ok' }) {
  const Icon = kind === 'ok' ? CheckCircle2 : kind === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`banner ${kind}`} role={kind === 'warn' ? 'alert' : 'status'}>
      <span className="flex items-start gap-2"><Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{children}</span></span>
    </div>
  );
}

export function Empty({ children, icon: Icon, title, action, art }: { children?: ReactNode; icon?: LucideIcon; title?: string; action?: ReactNode; art?: Art }) {
  const inferred: Art = art ?? (Icon === Lock ? 'shield' : Icon === Send ? 'send' : Icon === Mail ? 'inbox' : Icon === Search ? 'search' : 'folder');
  return (
    <div className="empty">
      <ArtFor art={inferred} className="h-24 w-24" />
      {title && <div className="font-display text-base font-semibold tracking-tight text-foreground">{title}</div>}
      {children && <div className="max-w-md text-sm">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="min-w-0">
        <h1>{title}</h1>
        {description && <p className="muted mt-1 max-w-2xl text-sm">{description}</p>}
      </div>
      <div className="row">{children}</div>
    </div>
  );
}

/** Small round avatar with a deterministic gradient. */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: gradientFor(name) }} aria-hidden="true">
      {initials}
    </span>
  );
}

export function Sparkline({ data, tone = 'primary', height = 36 }: { data: number[]; tone?: 'primary' | 'ok' | 'warn' | 'bad'; height?: number }) {
  const id = useId().replace(/:/g, '');
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 120;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, height - 4 - ((v - min) / range) * (height - 10)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const color = { primary: '#F5A524', ok: '#0B8F63', warn: '#F2703F', bad: '#D12F2F' }[tone];
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-9 w-full overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".32" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${line} ${w},${height}`} fill={`url(#${id})`} />
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" points={line} />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center gap-0.5 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground shadow-2xs">
      {children}
    </kbd>
  );
}

export function ProgressBar({ value, max = 100, tone = 'primary' }: { value: number; max?: number; tone?: 'primary' | 'ok' | 'warn' | 'bad' }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const fillCls = {
    primary: 'bg-primary',
    ok: 'bg-success',
    warn: 'bg-warning',
    bad: 'bg-danger',
  }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className={cn('h-full transition-all duration-300 ease-out', fillCls)} style={{ width: `${pct}%` }} />
    </div>
  );
}

const CHIP_FOR_TONE = { primary: 'sun', ok: 'mint', warn: 'sun', bad: 'rose' } as const;

export function StatCard({
  icon: Icon, label, value, sparkline, tone = 'primary', onClick, chip, hint,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  sparkline?: number[];
  tone?: 'primary' | 'ok' | 'warn' | 'bad';
  onClick?: () => void;
  chip?: 'sun' | 'sky' | 'mint' | 'rose' | 'violet' | 'slate';
  hint?: string;
}) {
  const isNumber = typeof value === 'number';
  const animated = useCountUp(isNumber ? (value as number) : 0);
  const display = isNumber ? animated : value;

  const body = (
    <div className={cn('stat-tile', onClick && 'clickable')}>
      <div className="flex items-start justify-between gap-3">
        <div className={cn('icon-chip', chip ?? CHIP_FOR_TONE[tone])}><Icon className="size-[18px]" aria-hidden="true" /></div>
        {hint && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{hint}</span>}
      </div>
      <div>
        <div className="font-display text-[32px] font-semibold leading-none tracking-tight tabular-nums">{display}</div>
        <div className="muted mt-1.5 text-[13px]">{label}</div>
      </div>
      <div className="-mx-1 -mb-1 h-9">{sparkline && sparkline.length >= 2 ? <Sparkline data={sparkline} tone={tone} /> : null}</div>
    </div>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block h-full w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
        {body}
      </button>
    );
  }
  return body;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** Accessible modal on Radix Dialog: labelled, Esc closes, focus is trapped and returned to the opener. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className={cn('dialog', wide && 'wide')} aria-describedby={undefined}>
          <div className="flex items-center justify-between border-b px-5 py-3.5">
            <Dialog.Title className="m-0 text-base font-semibold tracking-tight">{title}</Dialog.Title>
            <Dialog.Close className="btn ghost icon" aria-label="Close dialog"><X className="size-4" /></Dialog.Close>
          </div>
          <div className="p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfirmDialog({
  title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose, closeOnSuccess = true,
}: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void; closeOnSuccess?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm();
      if (closeOnSuccess) onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <div className="text-sm">{message}</div>
        {err != null && <ErrorBanner error={err} />}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={go} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Field({ label, error, help, children, required }: { label: string; error?: string | undefined; help?: string | null | undefined; children: ReactNode; required?: boolean }) {
  return (
    <label className={`field${error ? ' has-error' : ''}`}>
      <span>{label}{required && <abbr title="required" aria-hidden="true" className="no-underline text-danger"> *</abbr>}</span>
      {children}
      {help && <small className="muted text-xs">{help}</small>}
      {error && <small className="error-text" role="alert">{error}</small>}
    </label>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-2" aria-label="Pagination">
      <span className="muted text-xs">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <div className="row">
        <button className="btn small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}><ChevronLeft className="size-3.5" />Previous</button>
        <span className="muted text-xs">Page {page} of {pages}</span>
        <button className="btn small" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next<ChevronRight className="size-3.5" /></button>
      </div>
    </nav>
  );
}

/** Email-address chips: Enter, comma, space or blur adds; invalid addresses are flagged, not added. */
export function ChipInput({ label, values, onChange, max = 50, error }: { label: string; values: string[]; onChange: (v: string[]) => void; max?: number; error?: string | undefined }) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState<string | null>(null);
  const id = useId();

  function commit(raw: string) {
    const parts = raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...values];
    for (const p of parts) {
      if (!isEmail(p)) {
        setBad(`“${p}” is not a valid email address`);
        setText(p);
        onChange(next);
        return;
      }
      if (!next.includes(p) && next.length < max) next.push(p);
    }
    setBad(null);
    setText('');
    onChange(next);
  }

  return (
    <div className={`field${error || bad ? ' has-error' : ''}`}>
      <label htmlFor={id}><span>{label}</span></label>
      <div className="chips">
        {values.map((v) => (
          <span className="chip" key={v}>
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><X className="size-3" /></button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setBad(null);
          }}
          onKeyDown={(e) => {
            if (['Enter', ',', ';', ' '].includes(e.key) && text.trim()) {
              e.preventDefault();
              commit(text);
            } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={() => text.trim() && commit(text)}
          placeholder={values.length ? '' : 'name@example.com'}
          inputMode="email"
          autoComplete="off"
        />
      </div>
      {(bad || error) && <small className="error-text" role="alert">{bad ?? error}</small>}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          toast.success('Copied to clipboard');
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error('Could not copy. Select the text and copy it manually.');
        }
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{done ? 'Copied' : label}
    </button>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <RTabs.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RTabs.List className="tabs" aria-label="Sections">
        {tabs.map((t) => <RTabs.Trigger key={t.id} value={t.id} className="tab">{t.label}</RTabs.Trigger>)}
      </RTabs.List>
    </RTabs.Root>
  );
}

/** Row/overflow action menu. Items: { label, icon, onSelect, danger, hidden, disabled }. */
export interface MenuAction { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; hidden?: boolean; disabled?: boolean }
export function ActionMenu({ actions, label = 'Actions', trigger }: { actions: MenuAction[]; label?: string; trigger?: ReactNode }) {
  const shown = actions.filter((a) => !a.hidden);
  if (shown.length === 0) return null;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        {trigger ?? <button className="btn ghost icon small" aria-label={label}><span aria-hidden="true" className="text-base leading-none">⋯</span></button>}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align="end" sideOffset={6}>
          {shown.map((a) => (
            <Dropdown.Item key={a.label} className={cn('menu-item', a.danger && 'danger')} disabled={a.disabled} onSelect={a.onSelect}>
              {a.icon && <a.icon className="size-4" aria-hidden="true" />}{a.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export { Dropdown };

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Tip.Provider delayDuration={250}>{children}</Tip.Provider>;
}

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tip.Root>
      <Tip.Trigger asChild>{children}</Tip.Trigger>
      <Tip.Portal><Tip.Content className="tooltip" sideOffset={6}>{text}</Tip.Content></Tip.Portal>
    </Tip.Root>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <RSwitch.Root className="switch" checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled}>
      <RSwitch.Thumb asChild><span /></RSwitch.Thumb>
    </RSwitch.Root>
  );
}

/** Numbered stepper used by the upload and send flows. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s} className={i === current ? 'current' : i < current ? 'done' : ''} aria-current={i === current ? 'step' : undefined}>
          <span className="grid size-4 place-items-center rounded-full bg-current/15 text-[10px]">{i < current ? <Check className="size-3" /> : i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}
