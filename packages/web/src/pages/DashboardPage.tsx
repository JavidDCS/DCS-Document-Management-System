import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock, FilePlus2, FileText, FileX2,
  FileType2, Mail, MailWarning, Search, Send, ShieldAlert, Sparkles, Users,
} from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { SunPanels } from '../components/Illustrations';
import { Rise, Stagger } from '../components/Motion';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Badge, Empty, ErrorBanner, PageHeader, Skeleton, StatCard, Tabs } from '../components/ui';
import { useLoad, useTitle } from '../hooks';
import { fmtDateTime } from '../lib/format';
import type { DocumentListItem, EmailListItem, ReportSummary } from '../types';

export const emailTone = (s: string) =>
  (s === 'SENT' ? 'ok' : s === 'FAILED' ? 'bad' : s === 'UNKNOWN' ? 'warn' : 'info') as 'ok' | 'bad' | 'warn' | 'info';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage() {
  useTitle('Dashboard');
  const { user, can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [feedTab, setFeedTab] = useState<'emails' | 'docs'>('emails');

  const summary = useLoad(
    async () => (can('reports:read') ? (await api.get<ReportSummary>('/reports/summary')).data : null),
    []
  );

  const recentDocs = useLoad(
    async () => (can('documents:read') ? (await api.get<DocumentListItem[]>('/documents', { limit: 5 })).data : []),
    []
  );

  const recentEmails = useLoad(
    async () => (!can('reports:read') && can('email:read_own') ? (await api.get<EmailListItem[]>('/email/messages', { limit: 5 })).data : []),
    []
  );

  const allDocs = useLoad(
    async () => (can('documents:read') ? (await api.get<DocumentListItem[]>('/documents', { limit: 100 })).data : []),
    []
  );
  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of allDocs.data ?? []) m.set(d.typeName, (m.get(d.typeName) ?? 0) + 1);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [allDocs.data]);

  function search(e: FormEvent) {
    e.preventDefault();
    if (q.trim()) {
      nav(`/documents?search=${encodeURIComponent(q.trim())}`);
    }
  }

  const s = summary.data;

  // Sparkline data samples
  const docSparkline = s ? [Math.max(1, s.documentsActive - 6), Math.max(1, s.documentsActive - 4), Math.max(1, s.documentsActive - 3), Math.max(1, s.documentsActive - 1), s.documentsActive] : [1, 2, 4, 3, 5];
  const emailSparkline = s ? [Math.max(0, s.emailsSent30d - 8), Math.max(0, s.emailsSent30d - 5), Math.max(0, s.emailsSent30d - 2), Math.max(0, s.emailsSent30d - 4), s.emailsSent30d] : [0, 2, 5, 3, 8];

  const actions = [
    can('email:send') && {
      to: '/send',
      icon: Send,
      title: 'Send documents',
      text: 'Compose an email, pick versioned PDFs, and send securely.',
    },
    can('documents:manage') && {
      to: '/documents/new',
      icon: FilePlus2,
      title: 'Upload document',
      text: 'Scan, envelope-encrypt (AES-256), and store a PDF.',
    },
    can('doc_types:manage') && {
      to: '/admin/document-types',
      icon: FileType2,
      title: 'Document types',
      text: 'Configure metadata schemas and validation rules.',
    },
    can('documents:read') && {
      to: '/documents',
      icon: FileText,
      title: 'Browse library',
      text: 'Search documents by name, type, tags, or metadata.',
    },
  ].filter(Boolean) as { to: string; icon: typeof Send; title: string; text: string }[];

  const needsAttention = s && (s.versionsQuarantined > 0 || s.emailsFailed30d > 0 || s.versionsPending > 0);

  const attention: string[] = [];
  if (s?.versionsQuarantined) attention.push(`${s.versionsQuarantined} quarantined file${s.versionsQuarantined > 1 ? 's' : ''}`);
  if (s?.versionsPending) attention.push(`${s.versionsPending} file${s.versionsPending > 1 ? 's' : ''} waiting for a scan`);
  if (s?.emailsFailed30d) attention.push(`${s.emailsFailed30d} failed email${s.emailsFailed30d > 1 ? 's' : ''}`);
  const summaryLine = !s ? 'Search, send and manage your confidential contracts.' : attention.length ? `Needs attention: ${attention.join(', ')}.` : 'All clear: no files waiting, nothing quarantined, no failed emails.';

  const statusBars = s
    ? [
        { name: 'Active', Documents: s.documentsActive },
        { name: 'Inactive', Documents: s.documentsInactive },
        { name: 'Scanning', Documents: s.versionsPending },
        { name: 'Quarantined', Documents: s.versionsQuarantined },
      ]
    : [];
  const BAR_COLORS = ['#0b8f63', '#7e93b5', '#f5a524', '#d12f2f'];
  const PIE_COLORS = ['#f5a524', '#2f6fe0', '#0b8f63', '#6d4ae0', '#f2703f', '#7e93b5'];
  const sent = s?.emailsSent30d ?? 0;
  const failed = s?.emailsFailed30d ?? 0;
  const deliveryRate = sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : null;

  return (
    <>
      <Rise>
        <section className="hero mb-6 p-7 sm:p-9" aria-label="Welcome">
          <SunPanels className="animate-drift pointer-events-none absolute -bottom-8 right-2 hidden w-[340px] opacity-95 md:block" />
          <div className="relative max-w-2xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {user?.roles?.[0] && (
                <span className="inline-flex items-center rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold text-amber-200 backdrop-blur">
                  {user.roles[0].replace('_', ' ')}
                </span>
              )}
              <span className="text-xs text-slate-300">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
            </div>
            <h1 className="font-display !text-[34px] !leading-tight text-white">
              {greeting()}, {user?.name.split(' ')[0] ?? ''}
            </h1>
            <p className="mb-6 mt-2 max-w-xl text-[15px] text-slate-200">{summaryLine}</p>

            {can('documents:read') && (
              <form className="relative mb-5 max-w-xl" onSubmit={search} role="search">
                <label className="sr-only" htmlFor="dash-search">Search documents</label>
                <Search className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-slate-500" aria-hidden="true" />
                <input
                  id="dash-search"
                  className="!h-12 !rounded-xl !border-white/10 !bg-white !pl-11 !pr-24 !text-[15px] !text-slate-900 shadow-lift placeholder:!text-slate-500"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search by name, type or tag"
                />
                <button className="btn primary absolute right-1.5 top-1/2 -translate-y-1/2" type="submit">Search</button>
              </form>
            )}

            <div className="flex flex-wrap items-center gap-2.5">
              {can('email:send') && (
                <Link className="btn primary" to="/send"><Send className="size-4" /><span>Send documents</span></Link>
              )}
              {can('documents:manage') && (
                <Link className="btn on-dark" to="/documents/new"><FilePlus2 className="size-4" /><span>Upload a PDF</span></Link>
              )}
            </div>
          </div>
        </section>
      </Rise>

      {summary.loading && can('reports:read') && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-[142px] rounded-xl" />
          ))}
        </div>
      )}

      {summary.error != null && (
        <div className="mb-4">
          <ErrorBanner error={summary.error} onRetry={summary.reload} />
        </div>
      )}

      {s && (
        <Stagger className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={FileText} label="Active documents" value={s.documentsActive} sparkline={docSparkline} onClick={() => nav('/documents?active=true')} />
          <StatCard icon={FileX2} label="Inactive documents" value={s.documentsInactive} tone="warn" onClick={() => nav('/documents?active=false')} />
          <StatCard icon={Clock} label="Files awaiting scan" value={s.versionsPending} tone={s.versionsPending > 0 ? 'warn' : 'ok'} />
          <StatCard icon={ShieldAlert} label="Quarantined files" value={s.versionsQuarantined} tone={s.versionsQuarantined ? 'bad' : 'ok'} onClick={() => nav('/documents?active=false')} />
          <StatCard icon={Mail} label="Emails sent (30 days)" value={s.emailsSent30d} tone="ok" sparkline={emailSparkline} onClick={() => nav('/sent')} />
          <StatCard icon={MailWarning} label="Emails failed (30 days)" value={s.emailsFailed30d} tone={s.emailsFailed30d ? 'bad' : 'ok'} onClick={() => nav('/sent')} />
          <StatCard icon={Users} label="Active users" value={s.usersActive} onClick={can('users:read') ? () => nav('/admin/users') : undefined} />
          <StatCard icon={CheckCircle2} label="Delivery success rate" value={deliveryRate === null ? '—' : `${deliveryRate}%`} hint={deliveryRate === null ? 'no sends yet' : undefined} tone={deliveryRate !== null && deliveryRate < 90 ? 'warn' : 'ok'} />
        </Stagger>
      )}

      {s && (
        <div className="mb-6 grid gap-4 lg:grid-cols-3">
          <div className="card !mb-0">
            <h2 className="!mb-0.5 text-sm">Documents by type</h2>
            <p className="muted mb-3 text-xs">Where your library is concentrated</p>
            {byType.length === 0 ? (
              <Empty icon={FileText} title="No documents yet">Upload a PDF to see the breakdown.</Empty>
            ) : (
              <div className="flex items-center gap-4">
                <div className="h-[170px] w-[170px] shrink-0" role="img" aria-label={`Documents by type: ${byType.map((b) => `${b.name} ${b.value}`).join(', ')}`}>
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={byType} dataKey="value" nameKey="name" innerRadius={52} outerRadius={80} paddingAngle={3} stroke="none">
                        {byType.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <RTooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="m-0 min-w-0 flex-1 list-none space-y-1.5 p-0 text-xs">
                  {byType.slice(0, 6).map((b, i) => (
                    <li key={b.name} className="flex items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      <span className="font-semibold tabular-nums">{b.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="card !mb-0">
            <h2 className="!mb-0.5 text-sm">Library health</h2>
            <p className="muted mb-3 text-xs">Documents and files by state</p>
            <div className="h-[170px]" role="img" aria-label={`Library health: ${statusBars.map((b) => `${b.name} ${b.Documents}`).join(', ')}`}>
              <ResponsiveContainer>
                <BarChart data={statusBars} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <XAxis type="number" hide allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={84} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: 'currentColor' }} />
                  <RTooltip cursor={{ fill: 'rgb(127 127 127 / .08)' }} />
                  <Bar dataKey="Documents" radius={[0, 8, 8, 0]} barSize={16}>
                    {statusBars.map((_, i) => <Cell key={i} fill={BAR_COLORS[i]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card !mb-0">
            <h2 className="!mb-0.5 text-sm">Email delivery (30 days)</h2>
            <p className="muted mb-3 text-xs">Sent versus failed</p>
            {sent + failed === 0 ? (
              <Empty icon={Mail} title="Nothing sent yet">Your delivery rate appears after the first email.</Empty>
            ) : (
              <div className="flex items-center gap-5">
                <div className="relative grid size-[150px] shrink-0 place-items-center">
                  <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden="true">
                    <circle cx="60" cy="60" r="48" fill="none" stroke="var(--muted)" strokeWidth="12" />
                    <circle cx="60" cy="60" r="48" fill="none" stroke="#0b8f63" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(deliveryRate! / 100) * 301.6} 301.6`} />
                  </svg>
                  <span className="font-display absolute text-3xl font-semibold tabular-nums">{deliveryRate}%</span>
                </div>
                <dl className="m-0 space-y-2 text-sm">
                  <div><dt className="muted text-xs">Sent</dt><dd className="m-0 font-semibold tabular-nums">{sent}</dd></div>
                  <div><dt className="muted text-xs">Failed</dt><dd className="m-0 font-semibold tabular-nums">{failed}</dd></div>
                </dl>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <div className="card">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
              <Tabs
                tabs={[
                  { id: 'emails', label: 'Recent Deliveries' },
                  ...(can('documents:read') ? [{ id: 'docs', label: 'Recent Documents' }] : []),
                ]}
                value={feedTab}
                onChange={(t) => setFeedTab(t as 'emails' | 'docs')}
              />
              <Link to={feedTab === 'emails' ? '/sent' : '/documents'} className="text-xs font-semibold text-primary hover:underline">
                View all →
              </Link>
            </div>

            {feedTab === 'emails' && (
              <>
                {s && <RecentEmailsTable rows={s.recentEmails} />}
                {!can('reports:read') && recentEmails.loading && <Skeleton className="h-48 rounded-xl" />}
                {!can('reports:read') && recentEmails.data && <RecentEmailsTable rows={recentEmails.data} />}
              </>
            )}

            {feedTab === 'docs' && can('documents:read') && (
              <>
                {recentDocs.loading && <Skeleton className="h-48 rounded-xl" />}
                {recentDocs.data && <RecentDocsTable rows={recentDocs.data} />}
              </>
            )}
          </div>
        </div>

        {actions.length > 0 && (
          <div className="card h-fit space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Quick actions</h2>
            <div className="stack gap-2.5">
              {actions.map((a) => (
                <Link
                  key={a.to}
                  to={a.to}
                  className="group flex items-start gap-3.5 rounded-xl border border-border/70 bg-card p-3.5 no-underline transition-all duration-200 hover:border-primary/40 hover:bg-muted/40 hover:shadow-xs"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary transition-transform group-hover:scale-105">
                    <a.icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                      {a.title}
                    </span>
                    <span className="muted block text-xs leading-relaxed mt-0.5">{a.text}</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function RecentEmailsTable({ rows }: { rows: EmailListItem[] }) {
  if (rows.length === 0) {
    return (
      <Empty icon={Mail} title="No emails sent yet">
        Emails you send will appear here with their end-to-end delivery confirmation.
      </Empty>
    );
  }

  return (
    <div className="-mx-5 overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Sender</th>
            <th>When</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className="transition-colors hover:bg-muted/40">
              <td className="max-w-[260px] truncate">
                <Link to={`/sent/${m.id}`} className="font-medium text-foreground hover:text-primary">
                  {m.subject}
                </Link>
              </td>
              <td className="text-muted-foreground">{m.senderName}</td>
              <td className="muted whitespace-nowrap text-xs">{fmtDateTime(m.sentAt ?? m.createdAt)}</td>
              <td>
                <Badge tone={emailTone(m.status)}>{m.status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentDocsTable({ rows }: { rows: DocumentListItem[] }) {
  if (rows.length === 0) {
    return (
      <Empty icon={FileText} title="No documents found">
        Uploaded documents will appear here with active version and scanning telemetry.
      </Empty>
    );
  }

  return (
    <div className="-mx-5 overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>Document</th>
            <th>Type</th>
            <th>Version</th>
            <th>Updated</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="transition-colors hover:bg-muted/40">
              <td className="max-w-[240px] truncate">
                <Link to={`/documents/${d.id}`} className="font-medium text-foreground hover:text-primary">
                  {d.name}
                </Link>
              </td>
              <td>
                <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
                  {d.typeName}
                </span>
              </td>
              <td className="font-mono text-xs tabular-nums font-semibold text-muted-foreground">
                {d.currentVersionNumber ? `v${d.currentVersionNumber}` : '—'}
              </td>
              <td className="muted whitespace-nowrap text-xs">{fmtDateTime(d.updatedAt)}</td>
              <td>
                <Badge tone={d.isActive ? 'ok' : 'bad'}>{d.isActive ? 'Active' : 'Inactive'}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
