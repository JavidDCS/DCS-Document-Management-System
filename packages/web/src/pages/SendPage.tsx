import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useAuth } from '../auth/AuthContext';
import { ArrowLeft, ArrowRight, FileText, Mail, Plus, Search, Send as SendIcon, Trash2 } from 'lucide-react';
import { Badge, ChipInput, Empty, ErrorBanner, InfoBanner, Modal, PageHeader, Spinner, Stepper } from '../components/ui';
import { useDebounced, useLoad, useTitle } from '../hooks';
import { fmtSize, newId } from '../lib/format';
import type { DocumentDetail, DocumentListItem, DraftPreview, EmailTemplate, GmailConnection } from '../types';

interface Item {
  documentId: string;
  documentName: string;
  versionId: string;
  versionNumber: number;
  /** Clean versions the sender can choose from. */
  choices: { id: string; versionNumber: number; isCurrent: boolean }[];
}

const DEFAULT_BODY = 'Please find attached the requested document.';

export function SendPage() {
  useTitle('Send documents');
  const nav = useNavigate();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [items, setItems] = useState<Item[]>([]);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const appConfig = (typeof window !== 'undefined' && (window as any).__APP_CONFIG__) || {};
  const companyName = appConfig.companyName || (import.meta as any).env.VITE_COMPANY_NAME || (import.meta as any).env.APP_COMPANY_NAME || 'DeCircle Solar';
  const [subject, setSubject] = useState(`Documents from ${companyName}`);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [templateId, setTemplateId] = useState('');
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search);

  const conn = useLoad(async () => (await api.get<GmailConnection>('/email/connection')).data, []);
  const templates = useLoad(async () => (can('templates:read') ? (await api.get<EmailTemplate[]>('/email-templates')).data.filter((t) => t.isActive) : []), []);
  const found = useLoad(async () => (q.trim() ? (await api.get<DocumentListItem[]>('/documents', { search: q, active: 'true', archive: 'LIVE', limit: 8 })).data : []), [q]);

  // One idempotency key per send intent: it only changes when the content being sent changes.
  const keyRef = useRef({ key: newId(), fingerprint: '' });

  async function addDocument(id: string) {
    if (items.some((i) => i.documentId === id)) return;
    try {
      const d = (await api.get<DocumentDetail>(`/documents/${id}`)).data;
      const clean = d.versions.filter((v) => v.scanStatus === 'CLEAN');
      const pick = clean.find((v) => v.isCurrent) ?? clean[0];
      if (!d.isActive || !pick) {
        setError(`“${d.name}” cannot be sent: it is inactive or has no clean version.`);
        return;
      }
      setError(null);
      setItems((cur) => cur.some((i) => i.documentId === d.id) ? cur : [...cur, { documentId: d.id, documentName: d.name, versionId: pick.id, versionNumber: pick.versionNumber, choices: clean.map((v) => ({ id: v.id, versionNumber: v.versionNumber, isCurrent: v.isCurrent })) }]);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const preselect = params.get('documentId');
  useEffect(() => {
    if (preselect) void addDocument(preselect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect]);

  // Default template fills subject/body once.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current || !templates.data?.length) return;
    const def = templates.data.find((t) => t.isDefault);
    if (def) {
      appliedDefault.current = true;
      setTemplateId(def.id);
      setSubject(def.subject);
      setBody(def.body);
    }
  }, [templates.data]);

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templates.data?.find((x) => x.id === id);
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
    }
  }

  const request = useMemo(
    () => ({ items: items.map((i) => ({ documentId: i.documentId, versionId: i.versionId })), to, cc, bcc, subject: subject.trim(), body, ...(templateId ? { templateId } : {}) }),
    [items, to, cc, bcc, subject, body, templateId]
  );
  const problems: string[] = [];
  if (items.length === 0) problems.push('Add at least one document.');
  if (to.length === 0) problems.push('Add at least one recipient in To.');
  if (!subject.trim()) problems.push('Enter a subject.');
  if (/[\r\n]/.test(subject)) problems.push('The subject must be a single line.');
  if (!body.trim()) problems.push('Enter a message.');

  async function makePreview() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<DraftPreview>('/email/drafts', request);
      const fp = JSON.stringify(request);
      if (keyRef.current.fingerprint !== fp) keyRef.current = { key: newId(), fingerprint: fp };
      setPreview(r.data);
      setConfirmed(false);
      setStep('review');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: string; status: string }>('/email/messages', { ...request, idempotencyKey: keyRef.current.key, ...(preview.confirmationToken ? { confirmationToken: preview.confirmationToken } : {}) });
      nav(`/sent/${r.data.id}`);
    } catch (e) {
      setConfirmOpen(false);
      setError(e instanceof ApiError && e.code === 'CONFLICT' ? `${e.message} Go back and preview again.` : errorMessage(e));
      setBusy(false);
    }
  }

  const connected = conn.data?.status === 'ACTIVE';

  const external = preview?.recipients.filter((r) => r.external) ?? [];

  return (
    <>
      <PageHeader title="Send documents" description="Choose documents and versions, add recipients, review, then send from your own mailbox." />
      <Stepper steps={['Compose', 'Review and send']} current={step === 'edit' ? 0 : 1} />

      <div className="stack mb-4 empty:hidden">
        {conn.data && !connected && conn.data.available && (
          <InfoBanner kind="warn">Your Gmail account is not connected, so the email cannot be sent from your address. <Link to="/settings/gmail">Connect Gmail</Link></InfoBanner>
        )}
        {conn.data && !conn.data.available && <InfoBanner kind="warn">Email sending is not configured on this server yet. You can prepare an email, but it cannot be sent.</InfoBanner>}
        {error && <ErrorBanner message={error} />}
      </div>

      {step === 'edit' && (
        <div className="stack">
          <div className="card stack !mb-0">
            <h2>Documents</h2>
            <label className="field"><span className="sr-only">Find a document</span>
              <span className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <input className="!pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search active documents by name, type or tag…" aria-label="Find a document" />
              </span>
            </label>
            {q.trim() && found.loading && <Spinner />}
            {found.data && found.data.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Search results">
                {found.data.map((d) => {
                  const added = items.some((i) => i.documentId === d.id);
                  return (
                    <li key={d.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><FileText className="size-4" aria-hidden="true" /></span>
                        <span className="min-w-0"><span className="block truncate text-sm font-medium">{d.name}</span><span className="muted block text-xs">{d.typeName}{d.currentVersionNumber ? ` · v${d.currentVersionNumber}` : ''}</span></span>
                      </span>
                      <button className="btn small" disabled={added || !d.currentVersionId} onClick={() => addDocument(d.id)}>{added ? 'Added' : <><Plus className="size-3.5" />Add</>}</button>
                    </li>
                  );
                })}
              </ul>
            )}
            {q.trim() && found.data && found.data.length === 0 && !found.loading && <Empty>No active documents match “{q}”.</Empty>}

            <h3 className="!mb-0 mt-2">Selected ({items.length})</h3>
            {items.length === 0 ? <Empty icon={FileText} title="No documents selected yet">Search above and add the documents you want to send.</Empty> : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {items.map((i) => (
                  <li key={i.documentId} className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
                    <Link to={`/documents/${i.documentId}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm font-medium">{i.documentName}</Link>
                    <select className="!w-auto" aria-label={`Version of ${i.documentName}`} value={i.versionId} onChange={(e) => { const c = i.choices.find((x) => x.id === e.target.value)!; setItems(items.map((x) => (x.documentId === i.documentId ? { ...x, versionId: c.id, versionNumber: c.versionNumber } : x))); }}>
                      {i.choices.map((c) => <option key={c.id} value={c.id}>v{c.versionNumber}{c.isCurrent ? ' (current)' : ''}</option>)}
                    </select>
                    <button className="btn ghost icon small" aria-label={`Remove ${i.documentName}`} onClick={() => setItems(items.filter((x) => x.documentId !== i.documentId))}><Trash2 className="size-4" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card stack !mb-0">
            <h2>Recipients</h2>
            <ChipInput label="To" values={to} onChange={setTo} />
            <div className="grid gap-4 md:grid-cols-2">
              <ChipInput label="CC" values={cc} onChange={setCc} />
              <ChipInput label="BCC" values={bcc} onChange={setBcc} />
            </div>
            <small className="muted">The email is sent from your own address; replies come back to you.</small>
          </div>

          <div className="card stack !mb-0">
            <h2>Message</h2>
            {templates.data && templates.data.length > 0 && (
              <label className="field"><span>Template</span>
                <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">— none —</option>
                  {templates.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
            <label className="field"><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></label>
            <label className="field"><span>Message</span><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} maxLength={20000} />
              <small className="muted">Placeholders such as {'{{recipient_name}}'} or {'{{document_name}}'} are filled in by the server.</small>
            </label>
          </div>

          {problems.length > 0 && <ul className="hints" aria-live="polite">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <div className="row end">
            <button className="btn primary" disabled={busy || problems.length > 0} onClick={makePreview}>
              {busy ? 'Preparing preview…' : 'Continue to review'}
            </button>
          </div>
        </div>
      )}

      {step === 'review' && preview && (
        <div className="stack">
          <div className="card stack !mb-0">
            <h2>Review</h2>
            <dl className="kv">
              <dt>From</dt><dd>{preview.from}</dd>
              <dt>Reply-To</dt><dd>{preview.replyTo}</dd>
              <dt>Subject</dt><dd className="font-medium">{preview.subject}</dd>
            </dl>
            <h3 className="!mb-0">Recipients</h3>
            <div className="table-wrap shadow-none"><table>
              <thead><tr><th>Field</th><th>Address</th><th /></tr></thead>
              <tbody>{preview.recipients.map((r) => (
                <tr key={`${r.kind}-${r.address}`}><td>{r.kind}</td><td>{r.address}</td><td>{r.external ? <Badge tone="warn">External</Badge> : <Badge tone="ok">Internal</Badge>}</td></tr>
              ))}</tbody>
            </table></div>
            <h3 className="!mb-0">Attachments</h3>
            <div className="table-wrap shadow-none"><table>
              <thead><tr><th>Document</th><th>Version</th><th>File</th><th>Size</th></tr></thead>
              <tbody>{preview.attachments.map((a) => (
                <tr key={a.versionId}><td>{a.documentName}</td><td>v{a.versionNumber}</td><td>{a.filename}<br /><small className="mono muted">{a.sha256.slice(0, 16)}…</small></td><td>{fmtSize(a.sizeBytes)}</td></tr>
              ))}</tbody>
            </table></div>
            <h3 className="!mb-0">Message</h3>
            <pre className="details !max-w-none rounded-lg border bg-muted/30 p-4 !text-sm">{preview.body}</pre>
          </div>

          {preview.hasExternal && <InfoBanner kind="warn">This email goes to {external.length} external recipient{external.length === 1 ? '' : 's'}. A sent document cannot be recalled.</InfoBanner>}
          <div className="row between">
            <button className="btn" disabled={busy} onClick={() => setStep('edit')}>Back to compose</button>
            <button className="btn primary" disabled={busy} onClick={() => { setConfirmed(false); setConfirmOpen(true); }}>
              <SendIcon className="size-4" />{busy ? 'Sending…' : 'Confirm and send'}
            </button>
          </div>
        </div>
      )}

      {confirmOpen && preview && (
        <Modal title="Confirm and send" onClose={() => !busy && setConfirmOpen(false)}>
          <div className="stack">
            <p className="m-0 text-sm">You are about to send <strong>{preview.attachments.length} document{preview.attachments.length === 1 ? '' : 's'}</strong> to <strong>{preview.recipients.length} recipient{preview.recipients.length === 1 ? '' : 's'}</strong>.</p>
            <div className="rounded-lg border p-3 text-sm">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recipients</div>
              <ul className="m-0 list-none p-0">{preview.recipients.map((r) => <li key={`${r.kind}-${r.address}`} className="flex items-center justify-between gap-2 py-0.5"><span className="truncate">{r.kind} · {r.address}</span>{r.external && <Badge tone="warn">External</Badge>}</li>)}</ul>
            </div>
            <div className="rounded-lg border p-3 text-sm">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Attachments</div>
              <ul className="m-0 list-none p-0">{preview.attachments.map((a) => <li key={a.versionId} className="py-0.5">{a.documentName} · v{a.versionNumber} · {a.filename}</li>)}</ul>
            </div>
            {preview.hasExternal && (
              <label className="check rounded-lg border p-3 text-sm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I have checked the {external.length} external recipient(s) and the {preview.attachments.length} attached document(s) above, and I want to send them.</span>
              </label>
            )}
            <div className="row end">
              <button className="btn" disabled={busy} onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button className="btn primary" disabled={busy || (preview.hasExternal && !confirmed)} onClick={send}><Mail className="size-4" />{busy ? 'Sending…' : 'Send now'}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
