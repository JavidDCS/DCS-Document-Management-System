import {
  Archive, ArchiveRestore, CheckCircle2, Clock, Download, Eye, FileText, History, Loader2, MoreHorizontal, Pencil, Power, PowerOff, RotateCcw, Send, ShieldAlert, ShieldCheck, ShieldX, Star, Upload,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, errorMessage, fieldErrors } from '../api';
import { useAuth } from '../auth/AuthContext';
import { FilePicker, ProgressBar } from '../components/FilePicker';
import { MetadataForm } from '../components/MetadataForm';
import { TagPicker } from '../components/TagPicker';
import { ActionMenu, Badge, ConfirmDialog, CopyButton, Empty, ErrorBanner, InfoBanner, Modal, SkeletonList, Spinner, Tabs, cn } from '../components/ui';
import { useLoad, usePolling, useTitle } from '../hooks';
import { fmtDateTime, fmtSize, saveBlob } from '../lib/format';
import { cleanMetadata, displayValue, initialMetadata, validateMetadataLocal } from '../lib/metadata';
import type { DocumentDetail, ScanStatus, TagDto, VersionDto } from '../types';

const scanTone = (s: ScanStatus) => (s === 'CLEAN' ? 'ok' : s === 'PENDING' ? 'info' : 'bad') as 'ok' | 'info' | 'bad';
const scanText: Record<ScanStatus, string> = { PENDING: 'Scanning…', CLEAN: 'Clean', QUARANTINED: 'Quarantined', REJECTED: 'Rejected' };
const scanIcon = { PENDING: Clock, CLEAN: ShieldCheck, QUARANTINED: ShieldAlert, REJECTED: ShieldX } as const;
const scanColour = { PENDING: 'bg-info/10 text-info', CLEAN: 'bg-success/10 text-success', QUARANTINED: 'bg-danger/10 text-danger', REJECTED: 'bg-danger/10 text-danger' } as const;

type TabId = 'overview' | 'versions' | 'access';

export function DocumentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const doc = useLoad(async () => (await api.get<DocumentDetail>(`/documents/${id}`)).data, [id]);
  const tags = useLoad(async () => (can('documents:read') ? (await api.get<TagDto[]>('/tags')).data : []), []);
  const [tab, setTab] = useState<TabId>('overview');
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: 'restore' | 'promote' | 'archive' | 'unarchive' | 'deactivate'; version?: VersionDto }>(null);
  const [preview, setPreview] = useState<VersionDto | null>(null);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const d = doc.data;
  useTitle(d?.name ?? 'Document');
  const pending = !!d?.versions.some((v) => v.scanStatus === 'PENDING');
  usePolling(pending, () => doc.reload(), 2000);

  async function act(fn: () => Promise<unknown>, msg?: string) {
    setActionError(null);
    try {
      await fn();
      if (msg) toast.success(msg);
      doc.reload();
    } catch (e) {
      setActionError(e);
    }
  }

  if (doc.loading && !d) return <SkeletonList rows={5} />;
  if (doc.error != null && !d) {
    return doc.error instanceof ApiError && doc.error.status === 404 ? (
      <Empty icon={FileText} title="Document not found" action={<Link className="btn primary" to="/documents">Back to documents</Link>}>It may have been deactivated or you may not have access to it.</Empty>
    ) : <ErrorBanner error={doc.error} onRetry={doc.reload} />;
  }
  if (!d) return null;

  const manage = can('documents:manage');
  const canDownload = can('versions:download');
  const sendable = d.isActive && d.versions.some((v) => v.scanStatus === 'CLEAN');
  const tabs: { id: TabId; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'versions', label: `Versions (${d.versions.length})` }, ...(manage ? [{ id: 'access' as const, label: 'Access' }] : [])];

  return (
    <>
      <section className="relative mb-6 overflow-hidden rounded-2xl border bg-card p-6 shadow-card sm:p-7" aria-label="Document summary">
        <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: 'linear-gradient(90deg, #ffc450, #f5a524 45%, #f2703f)' }} aria-hidden="true" />
        <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full opacity-70" style={{ background: 'radial-gradient(circle, var(--mesh-a), transparent 65%)' }} aria-hidden="true" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 items-start gap-5">
            <span className="doc-thumb h-[84px] w-[66px]" aria-hidden="true">
              <FileText className="size-7 text-primary" />
              <span className="absolute inset-x-2 bottom-2 grid gap-1"><i className="block h-1 rounded-full bg-slate-200" /><i className="block h-1 w-2/3 rounded-full bg-slate-200" /></span>
            </span>
            <div className="min-w-0">
              <h1 className="font-display truncate !text-[28px]">{d.name}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground">{d.typeName}</span>
                <Badge tone={d.isActive ? 'ok' : 'neutral'}>{d.isActive ? 'Active' : 'Inactive'}</Badge>
                {d.archiveStatus !== 'LIVE' && <Badge tone="warn">{d.archiveStatus === 'ARCHIVED' ? 'Archived' : 'Legal hold'}</Badge>}
                {d.currentVersionNumber && <Badge tone="info">v{d.currentVersionNumber} current</Badge>}
              </div>
              <dl className="m-0 mt-4 flex flex-wrap gap-x-8 gap-y-2 text-xs">
                <div><dt className="muted">Versions</dt><dd className="m-0 text-sm font-semibold tabular-nums">{d.versions.length}</dd></div>
                <div><dt className="muted">Last updated</dt><dd className="m-0 text-sm font-semibold">{fmtDateTime(d.updatedAt)}</dd></div>
                <div><dt className="muted">Integrity</dt><dd className="m-0 flex items-center gap-1 text-sm font-semibold text-success"><ShieldCheck className="size-4" aria-hidden="true" />AES-256 + SHA-256 verified</dd></div>
              </dl>
            </div>
          </div>
          <div className="row">
            {can('email:send') && sendable && <Link className="btn primary" to={`/send?documentId=${d.id}`}><Send className="size-4" />Send</Link>}
            <ActionMenu
              label="Document actions"
              trigger={<button className="btn"><MoreHorizontal className="size-4" />Actions</button>}
              actions={[
                { label: 'Edit details', icon: Pencil, hidden: !manage, onSelect: () => { setTab('overview'); setEditing(true); } },
                { label: 'Upload new version', icon: Upload, hidden: !can('versions:create'), onSelect: () => { setTab('versions'); setUploading(true); } },
                { label: 'Activate', icon: Power, hidden: !(manage && !d.isActive && d.currentVersionId), onSelect: () => act(() => api.post(`/documents/${d.id}/activate`), 'Document activated') },
                { label: 'Deactivate', icon: PowerOff, hidden: !(manage && d.isActive), onSelect: () => setDialog({ kind: 'deactivate' }) },
                { label: 'Archive', icon: Archive, hidden: !(can('documents:archive') && d.archiveStatus === 'LIVE'), onSelect: () => setDialog({ kind: 'archive' }) },
                { label: 'Unarchive', icon: ArchiveRestore, hidden: !(can('documents:archive') && d.archiveStatus === 'ARCHIVED'), onSelect: () => setDialog({ kind: 'unarchive' }) },
              ]}
            />
          </div>
        </div>
      </section>

      <div className="stack gap-3 mb-4 empty:hidden">
        {actionError != null && <ErrorBanner error={actionError} />}
        {pending && <InfoBanner>A file is being scanned. This page updates automatically.</InfoBanner>}
        {d.versions.some((v) => v.scanStatus === 'QUARANTINED' || v.scanStatus === 'REJECTED') && (
          <InfoBanner kind="warn">One or more uploaded files were blocked by the security scan and cannot be sent or downloaded. See the versions tab for the reason.</InfoBanner>
        )}
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="!mb-0">Details</h2>
            {manage && !editing && <button className="btn small" onClick={() => setEditing(true)}><Pencil className="size-3.5" />Edit</button>}
          </div>
          {editing ? (
            <EditForm doc={d} allTags={tags.data ?? []} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); toast.success('Changes saved'); doc.reload(); }} />
          ) : (
            <dl className="kv">
              <dt>Type</dt><dd>{d.typeName}</dd>
              <dt>Description</dt><dd>{d.description || <span className="muted">—</span>}</dd>
              <dt>Tags</dt><dd>{d.tags.length ? d.tags.map((t) => <span className="tag" key={t.id}>{t.name}</span>) : <span className="muted">—</span>}</dd>
              {d.type.fields.filter((f) => f.isActive).map((f) => (<FieldRow key={f.key} label={f.label} value={displayValue(f, d.metadata[f.key])} />))}
              <dt>Last updated</dt><dd>{fmtDateTime(d.updatedAt)}</dd>
            </dl>
          )}
        </div>
      )}

      {tab === 'versions' && (
        <div className="card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="!mb-0">Version history</h2>
            {can('versions:create') && <button className="btn small" onClick={() => setUploading((u) => !u)}><Upload className="size-3.5" />{uploading ? 'Cancel' : 'Upload new version'}</button>}
          </div>
          {uploading && <UploadVersion doc={d} onDone={() => { setUploading(false); toast.success('Version uploaded', { description: 'It will be available after the scan.' }); doc.reload(); }} />}
          <ol className="m-0 list-none p-0">
            {d.versions.map((v, i) => {
              const Icon = scanIcon[v.scanStatus];
              return (
                <li key={v.id} className="relative flex gap-4 pb-6 last:pb-0">
                  {i < d.versions.length - 1 && <span className="absolute left-[19px] top-10 bottom-0 w-px bg-border" aria-hidden="true" />}
                  <span className={cn('relative z-10 grid size-10 shrink-0 place-items-center rounded-full', scanColour[v.scanStatus])}>
                    {v.scanStatus === 'PENDING' ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : <Icon className="size-5" aria-hidden="true" />}
                  </span>
                  <div className="min-w-0 flex-1 rounded-xl border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">Version {v.versionNumber}</span>
                      {v.isCurrent && <Badge tone="ok"><Star className="size-3" />Current</Badge>}
                      <Badge tone={scanTone(v.scanStatus)}>{scanText[v.scanStatus]}</Badge>
                      {v.restoredFromVersionId && <Badge>Restored</Badge>}
                      <span className="muted ml-auto text-xs">{fmtDateTime(v.createdAt)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                      <span className="font-medium text-foreground">{v.originalFilename}</span>
                      <span className="muted">{fmtSize(v.sizeBytes)}</span>
                      <span className="muted">Uploaded by {v.uploadedBy.name}</span>
                      <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-mono text-muted-foreground">AES-256-GCM</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs">
                        <span className="text-muted-foreground font-mono">SHA-256:</span>
                        <span className="font-mono text-foreground">{v.sha256.slice(0, 16)}…{v.sha256.slice(-8)}</span>
                        <CopyButton text={v.sha256} label="Copy" />
                      </div>
                    </div>
                    {v.changeNote && <p className="muted mb-0 mt-2 text-sm">“{v.changeNote}”</p>}
                    {v.scanDetail && <p className="mb-0 mt-2 text-sm text-danger">{v.scanDetail}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {v.scanStatus === 'CLEAN' && canDownload && (
                        <>
                          <button className="btn small" onClick={() => setPreview(v)}><Eye className="size-3.5" />Preview</button>
                          <button className="btn small" onClick={() => act(async () => { const r = await api.blob(`/documents/${d.id}/versions/${v.id}/content`); saveBlob(r.blob, r.filename ?? v.originalFilename); })}><Download className="size-3.5" />Download</button>
                        </>
                      )}
                      {v.scanStatus === 'CLEAN' && !v.isCurrent && manage && <button className="btn small" onClick={() => setDialog({ kind: 'promote', version: v })}><CheckCircle2 className="size-3.5" />Make current</button>}
                      {can('versions:restore') && v.scanStatus === 'CLEAN' && <button className="btn small" onClick={() => setDialog({ kind: 'restore', version: v })}><RotateCcw className="size-3.5" />Restore as new</button>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {tab === 'access' && manage && <AccessTab docId={d.id} />}

      {preview && <PreviewModal doc={d} version={preview} onClose={() => setPreview(null)} />}
      {dialog?.kind === 'promote' && dialog.version && (
        <ConfirmDialog title="Make this the current version?" message={`Version ${dialog.version.versionNumber} becomes the version senders get by default.`} onClose={() => setDialog(null)} onConfirm={async () => { await api.post(`/documents/${d.id}/versions/${dialog.version!.id}/promote`); toast.success('Current version changed'); doc.reload(); }} />
      )}
      {dialog?.kind === 'restore' && dialog.version && (
        <ConfirmDialog title="Restore as a new version?" message={`A new version is created from version ${dialog.version.versionNumber}. History is never rewritten.`} confirmLabel="Restore" onClose={() => setDialog(null)} onConfirm={async () => { await api.post(`/documents/${d.id}/versions/${dialog.version!.id}/restore`); toast.success('A new version was created'); doc.reload(); }} />
      )}
      {dialog?.kind === 'deactivate' && (
        <ConfirmDialog title="Deactivate this document?" message="Senders will no longer find or send it. Its history is kept." confirmLabel="Deactivate" danger onClose={() => setDialog(null)} onConfirm={async () => { await api.post(`/documents/${d.id}/deactivate`); toast.success('Document deactivated'); doc.reload(); }} />
      )}
      {dialog?.kind === 'archive' && (
        <ConfirmDialog title="Archive this document?" message="It is hidden from search and cannot be sent. Administrators can still open it." confirmLabel="Archive" onClose={() => setDialog(null)} onConfirm={async () => { await api.post(`/documents/${d.id}/archive`); toast.success('Document archived'); doc.reload(); }} />
      )}
      {dialog?.kind === 'unarchive' && (
        <ConfirmDialog title="Unarchive this document?" message="It returns to the library." confirmLabel="Unarchive" onClose={() => setDialog(null)} onConfirm={async () => { await api.post(`/documents/${d.id}/unarchive`); toast.success('Document unarchived'); doc.reload(); }} />
      )}
    </>
  );
}

function AccessTab({ docId }: { docId: string }) {
  const rules = useLoad(async () => (await api.get<{ id: string; subjectType: string; userId: string | null; role: string | null; permission: string; effect: string }[]>(`/documents/${docId}/access-rules`)).data, [docId]);
  return (
    <div className="card">
      <h2>Access rules</h2>
      <p className="muted mb-4 mt-0 text-sm">By default every user can see an active document according to their role. Rules narrow or block access for specific users or roles.</p>
      {rules.loading && <Spinner />}
      {rules.error != null && <ErrorBanner error={rules.error} onRetry={rules.reload} />}
      {rules.data && rules.data.length === 0 && <Empty icon={ShieldCheck} title="No restrictions">Everyone with the right role can see this document.</Empty>}
      {rules.data && rules.data.length > 0 && (
        <div className="table-wrap shadow-none">
          <table>
            <thead><tr><th>Applies to</th><th>Permission</th><th>Effect</th></tr></thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.subjectType === 'ROLE' ? `Role: ${r.role}` : <span className="mono">{r.userId}</span>}</td>
                  <td>{r.permission}</td>
                  <td><Badge tone={r.effect === 'DENY' ? 'bad' : 'ok'}>{r.effect}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (<><dt>{label}</dt><dd>{value}</dd></>);
}

function EditForm({ doc, allTags, onCancel, onSaved }: { doc: DocumentDetail; allTags: TagDto[]; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(doc.name);
  const [description, setDescription] = useState(doc.description ?? '');
  const [metadata, setMetadata] = useState(() => initialMetadata(doc.type.fields, doc.metadata));
  const [tagIds, setTagIds] = useState(doc.tags.map((t) => t.id));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const local: Record<string, string> = {};
    if (!name.trim()) local.name = 'Enter a name';
    for (const i of validateMetadataLocal(doc.type.fields, metadata)) local[i.path] = i.message;
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/documents/${doc.id}`, { name: name.trim(), description: description.trim() || null, metadata: cleanMetadata(doc.type.fields, metadata), tagIds });
      onSaved();
    } catch (e) {
      setErrors(fieldErrors(e));
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error && <ErrorBanner message={error} />}
      <div className="form-grid">
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />{errors.name && <small className="error-text">{errors.name}</small>}</label>
        <label className="field"><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} /></label>
      </div>
      <MetadataForm fields={doc.type.fields} values={metadata} onChange={setMetadata} errors={errors} />
      <h3 className="!mb-0">Tags</h3>
      <TagPicker tags={allTags} selected={tagIds} onChange={setTagIds} />
      <div className="row end">
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  );
}

function UploadVersion({ doc, onDone }: { doc: DocumentDetail; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!file) return;
    const form = new FormData();
    form.append('file', file, file.name);
    if (note.trim()) form.append('changeNote', note.trim());
    setProgress(0);
    setError(null);
    try {
      await api.upload(`/documents/${doc.id}/versions`, form, setProgress);
      onDone();
    } catch (e) {
      setProgress(null);
      setError(errorMessage(e));
    }
  }

  return (
    <div className="stack mb-5 rounded-xl border bg-muted/30 p-4">
      {error && <ErrorBanner message={error} />}
      <FilePicker file={file} onPick={setFile} maxMb={doc.type.maxFileSizeMb} />
      <label className="field"><span>Note about this version (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
      {progress !== null && <ProgressBar value={progress} label="Upload progress" />}
      <div className="row end"><button className="btn primary" disabled={!file || progress !== null} onClick={go}><Upload className="size-4" />Upload version</button></div>
    </div>
  );
}

function PreviewModal({ doc, version, onClose }: { doc: DocumentDetail; version: VersionDto; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [blobData, setBlobData] = useState<Blob | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    api
      .blob(`/documents/${doc.id}/versions/${version.id}/content`, { inline: 1 })
      .then((r) => {
        if (!alive) return;
        const pdfBlob = new Blob([r.blob], { type: 'application/pdf' });
        objectUrl = URL.createObjectURL(pdfBlob);
        setBlobData(pdfBlob);
        setUrl(objectUrl);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.id, version.id]);

  return (
    <Modal title={`${doc.name} — v${version.versionNumber}`} onClose={onClose} wide>
      {error != null && <ErrorBanner error={error} />}
      {!url && !error && <Spinner label="Decrypting and verifying SHA-256…" />}
      {url && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <ShieldCheck className="size-4 text-success shrink-0" aria-hidden="true" />
              <span className="truncate font-medium text-foreground">{version.originalFilename}</span>
              <span className="muted shrink-0">({fmtSize(version.sizeBytes)})</span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn small"
              >
                <Eye className="size-3.5" />
                Open in new tab
              </a>
              {blobData && (
                <button
                  type="button"
                  className="btn small primary"
                  onClick={() => saveBlob(blobData, version.originalFilename)}
                >
                  <Download className="size-3.5" />
                  Download
                </button>
              )}
            </div>
          </div>
          <iframe
            className="preview-frame"
            title={`Preview of ${version.originalFilename}`}
            src={url}
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </Modal>
  );
}
