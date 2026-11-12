import { ChevronDown, ChevronRight, Copy, Check, ShieldCheck, AlertTriangle, ShieldAlert, Filter, Search } from 'lucide-react';
import { useState, useEffect } from 'react';
import { api, errorMessage } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Empty, ErrorBanner, InfoBanner, PageHeader, Spinner, CopyButton } from '../../components/ui';
import { useTitle } from '../../hooks';
import { fmtDateTime } from '../../lib/format';
import type { AuditRow } from '../../types';

interface VerifyResult {
  ok: boolean;
  checked: number;
  headHash: string | null;
  failure?: { reason: string; entryId: string | null };
}

export function AdminAuditPage() {
  useTitle('Audit log');
  const { user } = useAuth();
  const [filters, setFilters] = useState({ action: '', resourceType: '', actorUserId: '' });
  const [applied, setApplied] = useState(filters);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [verify, setVerify] = useState<VerifyResult | 'running' | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  async function load(reset: boolean, from: string | null) {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<AuditRow[]>('/audit', {
        limit: 50,
        cursor: reset ? undefined : from,
        action: applied.action.trim().toUpperCase(),
        resourceType: applied.resourceType.trim(),
        actorUserId: applied.actorUserId.trim(),
      });
      setRows((cur) => (reset ? r.data : [...cur, ...r.data]));
      setCursor((r.meta as { nextCursor: string | null } | undefined)?.nextCursor ?? null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);

  async function runVerify() {
    setVerify('running');
    setVerifyError(null);
    try {
      setVerify((await api.post<VerifyResult>('/audit/verify')).data);
    } catch (e) {
      setVerify(null);
      setVerifyError(errorMessage(e));
    }
  }

  function toggleRow(id: string) {
    setExpandedRow((cur) => (cur === id ? null : id));
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Tamper-evident cryptographically signed event log of all system actions."
      >
        {user?.roles.includes('SUPER_ADMIN') && (
          <button
            type="button"
            className="btn"
            onClick={runVerify}
            disabled={verify === 'running'}
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            {verify === 'running' ? 'Verifying chain…' : 'Verify chain integrity'}
          </button>
        )}
      </PageHeader>

      {verifyError && <ErrorBanner message={verifyError} />}

      {verify && verify !== 'running' && (
        <div className="mb-4">
          {verify.ok ? (
            <InfoBanner kind="ok">
              <span className="font-semibold">Audit chain verified:</span> {verify.checked} entries verified sequentially with zero tamper indicators.
              <span className="block mt-1 font-mono text-xs text-muted-foreground break-all">
                Head hash: {verify.headHash}
              </span>
            </InfoBanner>
          ) : (
            <InfoBanner kind="warn">
              <span className="font-semibold text-danger">Integrity failure detected:</span> {verify.failure?.reason} (entry: {verify.failure?.entryId ?? 'n/a'}). Escalate as a security incident.
            </InfoBanner>
          )}
        </div>
      )}

      <form
        className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 !p-4 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filters);
        }}
      >
        <label className="field mb-0">
          <span className="text-xs font-semibold text-muted-foreground">Action</span>
          <input
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
            placeholder="e.g. LOGIN_SUCCESS, DOCUMENT_CREATED"
            className="!h-9 text-xs"
          />
        </label>
        <label className="field mb-0">
          <span className="text-xs font-semibold text-muted-foreground">Resource type</span>
          <input
            value={filters.resourceType}
            onChange={(e) => setFilters({ ...filters, resourceType: e.target.value })}
            placeholder="e.g. document, user, email"
            className="!h-9 text-xs"
          />
        </label>
        <label className="field mb-0">
          <span className="text-xs font-semibold text-muted-foreground">Actor ID</span>
          <input
            value={filters.actorUserId}
            onChange={(e) => setFilters({ ...filters, actorUserId: e.target.value })}
            placeholder="User UUID"
            className="!h-9 text-xs font-mono"
          />
        </label>
        <div className="flex items-center gap-2">
          <button type="submit" className="btn primary small w-full">
            <Filter className="size-3.5" />
            Apply filters
          </button>
          {(filters.action || filters.resourceType || filters.actorUserId) && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                const empty = { action: '', resourceType: '', actorUserId: '' };
                setFilters(empty);
                setApplied(empty);
              }}
            >
              Reset
            </button>
          )}
        </div>
      </form>

      {error != null && <ErrorBanner error={error} onRetry={() => load(true, null)} />}

      {loading && rows.length === 0 && <Spinner />}

      {!loading && rows.length === 0 && !error && (
        <Empty icon={ShieldCheck} title="No audit entries found">
          No audit entries match the current filter criteria.
        </Empty>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="w-8" />
                <th>Timestamp</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isExpanded = expandedRow === r.id;
                return (
                  <tr key={r.id} className="group cursor-pointer hover:bg-muted/30" onClick={() => toggleRow(r.id)}>
                    <td className="w-8 pl-3 text-muted-foreground">
                      {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                      {fmtDateTime(r.occurredAt)}
                    </td>
                    <td>
                      <div className="font-medium text-foreground">{r.actorName ?? r.actorType}</div>
                      {r.ip && <span className="font-mono text-[11px] text-muted-foreground">{r.ip}</span>}
                    </td>
                    <td>
                      <span className="inline-flex items-center rounded border border-border bg-muted/60 px-2 py-0.5 font-mono text-xs font-medium text-foreground">
                        {r.action}
                      </span>
                    </td>
                    <td>
                      <div className="text-xs text-foreground font-medium">{r.resourceType ?? '—'}</div>
                      {r.resourceId && (
                        <span className="font-mono text-[11px] text-muted-foreground truncate block max-w-[140px]">
                          {r.resourceId}
                        </span>
                      )}
                    </td>
                    <td>
                      <Badge tone={r.outcome === 'SUCCESS' ? 'ok' : 'bad'}>{r.outcome}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Expanded Detail Modal / Slide view */}
      {expandedRow && (() => {
        const row = rows.find((r) => r.id === expandedRow);
        if (!row) return null;
        return (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-4" onClick={() => setExpandedRow(null)}>
            <div className="card max-w-2xl w-full max-h-[85vh] overflow-y-auto space-y-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b pb-3">
                <div>
                  <h3 className="text-base font-semibold text-foreground">Audit Record Details</h3>
                  <p className="font-mono text-xs text-muted-foreground">Entry ID: {row.id}</p>
                </div>
                <button type="button" className="btn small" onClick={() => setExpandedRow(null)}>
                  Close
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 text-xs">
                <div className="rounded-lg border border-border/80 bg-muted/30 p-2.5">
                  <span className="muted block font-semibold mb-0.5">Timestamp:</span>
                  <span className="font-mono tabular-nums">{fmtDateTime(row.occurredAt)}</span>
                </div>
                <div className="rounded-lg border border-border/80 bg-muted/30 p-2.5">
                  <span className="muted block font-semibold mb-0.5">Action:</span>
                  <span className="font-mono font-medium">{row.action}</span>
                </div>
                <div className="rounded-lg border border-border/80 bg-muted/30 p-2.5">
                  <span className="muted block font-semibold mb-0.5">Actor:</span>
                  <span>{row.actorName ?? row.actorType} {row.actorUserId && `(${row.actorUserId})`}</span>
                </div>
                <div className="rounded-lg border border-border/80 bg-muted/30 p-2.5">
                  <span className="muted block font-semibold mb-0.5">IP & Request ID:</span>
                  <span className="font-mono">{row.ip ?? 'N/A'} {row.requestId && `• ${row.requestId}`}</span>
                </div>
                <div className="rounded-lg border border-border/80 bg-muted/30 p-2.5 sm:col-span-2">
                  <span className="muted block font-semibold mb-0.5">Resource:</span>
                  <span className="font-mono">{row.resourceType ?? 'None'} {row.resourceId && `ID: ${row.resourceId}`}</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between pb-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Payload Details</span>
                  <CopyButton text={JSON.stringify(row.details, null, 2)} label="Copy JSON" />
                </div>
                <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-muted/70 p-3 font-mono text-xs text-foreground/90">
                  {JSON.stringify(row.details, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        );
      })()}

      {cursor && (
        <div className="center mt-4">
          <button type="button" className="btn" disabled={loading} onClick={() => load(false, cursor)}>
            {loading ? 'Loading…' : 'Load more entries'}
          </button>
        </div>
      )}
    </>
  );
}
