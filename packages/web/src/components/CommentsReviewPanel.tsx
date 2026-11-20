import type { ReviewCommentDto, ShareLinkDto, ShareLinkStatus } from '@dcs-docs/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { FilePicker } from './FilePicker';
import { useLoad } from '../hooks';
import { fmtDateTime, saveBlob } from '../lib/format';
import type { DocumentDetail } from '../types';
import { PdfCanvasViewer } from './pdf/PdfCanvasViewer';
import { Badge, ConfirmDialog, ErrorBanner, InfoBanner, Spinner, cn } from './ui';

const STIRLING_PDF_URL = (import.meta.env.VITE_STIRLING_PDF_URL as string | undefined)?.trim();

const STATUS_TONE: Record<ReviewCommentDto['status'], 'warn' | 'ok' | 'neutral'> = { OPEN: 'warn', ACCEPTED: 'ok', DISMISSED: 'neutral' };
const LINK_STATUS_TONE: Record<ShareLinkStatus, 'warn' | 'ok' | 'neutral' | 'bad'> = {
  SENT: 'neutral',
  VIEWED: 'neutral',
  COMMENTED: 'warn',
  ACCEPTED: 'ok',
  DISMISSED: 'neutral',
  REVOKED: 'bad',
  FAILED: 'bad',
};

/** Step 1: email a client a one-time, no-login review link for the document's current version. */
function SendForReviewForm({ doc, onSent }: { doc: DocumentDetail; onSent: () => void }) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      await api.post(`/documents/${doc.id}/share-links`, { recipientEmail: email.trim() });
      toast.success(`Review link emailed to ${email.trim()}`);
      setEmail('');
      onSent();
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="stack gap-1">
        <span className="text-xs font-medium">Send for client review</span>
        <input type="email" required placeholder="client@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="input" disabled={sending} />
      </label>
      <button type="submit" className="btn primary" disabled={sending || !email.trim()}>
        {sending ? 'Sending…' : 'Send review link'}
      </button>
      {error != null && <ErrorBanner error={error} />}
    </form>
  );
}

/**
 * Opens the current version directly in a self-hosted Stirling-PDF instance (no manual upload) so staff can make
 * the changes the client asked for, right from this tab. Lives here instead of a separate "Edit document" tab.
 */
function EditInStirlingSection({ doc }: { doc: DocumentDetail }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function downloadCurrent() {
    if (!doc.currentVersionId) return;
    const r = await api.blob(`/documents/${doc.id}/versions/${doc.currentVersionId}/content`);
    saveBlob(r.blob, r.filename ?? 'document.pdf');
  }

  async function openInStirling() {
    // Navigates this same tab (not a new one), full-screen, since Stirling-PDF refuses to be framed inside our
    // page (it sends X-Frame-Options: DENY) -- this is as close to "inside the app" as it can get.
    setOpening(true);
    setError(null);
    try {
      const r = await api.post<{ url: string }>(`/documents/${doc.id}/review/stirling-link`, {});
      window.location.href = r.data.url;
    } catch (e) {
      setError(e);
      setOpening(false);
    }
  }

  if (!STIRLING_PDF_URL) return null;

  return (
    <div className="stack gap-2 rounded-lg border p-3 text-sm">
      <span className="text-xs font-medium">Make the changes above</span>
      <p className="muted mb-0 text-xs">Opens the current file in the PDF editor. Download the result there, then use "Send a modified copy" below -- use your browser's Back button to return here.</p>
      {error != null && <ErrorBanner error={error} />}
      <div className="row">
        <button type="button" className="btn small primary" onClick={openInStirling} disabled={opening}>{opening ? 'Opening…' : 'Open PDF editor'}</button>
        <button type="button" className="btn small" onClick={downloadCurrent}>Download current PDF</button>
      </div>
    </div>
  );
}

/**
 * Sends a locally-edited file (e.g. downloaded from Stirling-PDF after filling in the client's requested blanks)
 * straight to the client as an email attachment. No new DocumentVersion is created and the document's current
 * version never changes -- this is the only send step now; there is no separate incorporate/signature step.
 */
function SendModifiedCopyForm({ doc, links }: { doc: DocumentDetail; links: ShareLinkDto[] }) {
  const latest = links[0];
  const [email, setEmail] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (latest && !email) setEmail(latest.recipientEmail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.recipientEmail]);

  // A preview of exactly the file about to be sent -- so staff can check it's the right one before confirming.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function go() {
    if (!file) return;
    setSending(true);
    setError(null);
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('recipientEmail', email.trim());
    if (note.trim()) form.append('note', note.trim());
    try {
      await api.upload(`/documents/${doc.id}/review/send-modified-copy`, form);
      toast.success(`Sent to ${email.trim()}`);
      setFile(null);
      setNote('');
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="stack gap-2 rounded-xl border bg-muted/30 p-4">
      <span className="text-sm font-medium">Send a modified copy (e.g. edited in Stirling-PDF)</span>
      <p className="muted mb-0 text-xs">Goes straight to the client as an attachment -- this never becomes a new version of the document.</p>
      <FilePicker file={file} onPick={setFile} maxMb={doc.type.maxFileSizeMb} />
      {file && (
        <div className="stack gap-1">
          <span className="muted text-xs">Preview of "{file.name}" -- check this is correct before sending</span>
          {previewUrl ? (
            <iframe src={previewUrl} title="Selected file preview" className="preview-frame" style={{ width: '100%', height: '60vh', border: 0 }} />
          ) : (
            <p className="muted mb-0 text-xs">This file does not look like a PDF, so it cannot be previewed here.</p>
          )}
        </div>
      )}
      <label className="field"><span>Client email</span><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={sending} /></label>
      <label className="field"><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={sending} /></label>
      {error != null && <ErrorBanner error={error} />}
      <div className="row end">
        <button type="button" className="btn primary" disabled={!file || !email.trim() || sending} onClick={() => setConfirming(true)}>
          {sending ? 'Sending…' : 'Send Modified PDF'}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Send this file to the client?"
          message={`"${file?.name}" is emailed to ${email.trim()} right now. The document's current version is not changed.`}
          confirmLabel="Send"
          onClose={() => setConfirming(false)}
          onConfirm={go}
        />
      )}
    </div>
  );
}

/**
 * Staff side of the external review, as one left-to-right workflow: send link -> client comments ->
 * accept/dismiss each -> prepare the modified PDF elsewhere (e.g. Stirling-PDF) -> send it to the client.
 * The panel always tells staff which step is next. It reuses the page's already-loaded `doc`.
 */
export function CommentsReviewPanel({ doc }: { doc: DocumentDetail }) {
  const comments = useLoad(async () => (await api.get<ReviewCommentDto[]>(`/documents/${doc.id}/review-comments`)).data, [doc.id]);
  const shareLinks = useLoad(async () => (await api.get<ShareLinkDto[]>(`/documents/${doc.id}/share-links`)).data, [doc.id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (!doc.currentVersionId) return;
    let alive = true;
    let objectUrl: string | null = null;
    setPdfUrl(null);
    setPdfError(null);
    api
      .blob(`/documents/${doc.id}/versions/${doc.currentVersionId}/content`, { inline: 1 })
      .then((r) => {
        if (!alive) return;
        const blob = new Blob([r.blob], { type: 'application/pdf' });
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch((e) => alive && setPdfError(e));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.id, doc.currentVersionId]);

  const list = useMemo(
    () => (comments.data ?? []).slice().sort((a, b) => Number(b.status === 'OPEN') - Number(a.status === 'OPEN') || a.createdAt.localeCompare(b.createdAt)),
    [comments.data]
  );
  const links = shareLinks.data ?? [];

  const openCount = list.filter((c) => c.status === 'OPEN').length;

  async function run(key: string, call: () => Promise<unknown>, success: string) {
    setBusy(key);
    setActionError(null);
    try {
      await call();
      toast.success(success);
      comments.reload();
      shareLinks.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  const decide = (id: string, action: 'accept' | 'dismiss') =>
    run(id, () => api.post(`/review-comments/${id}/${action}`), action === 'accept' ? 'Accepted' : 'Dismissed');

  // "What now?" -- the one line a person needs, in the order the work actually happens.
  let next: string;
  if (links.length === 0) next = 'Step 1: email the document to the client for review.';
  else if (list.length === 0) next = 'Waiting for the client. You will get an email as soon as they comment.';
  else if (openCount > 0) next = `Step 2: accept or dismiss each of the ${openCount} open comment${openCount === 1 ? '' : 's'}.`;
  else next = 'Step 3: prepare the modified PDF (e.g. in Stirling-PDF) and send it to the client below.';

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="!mb-0">Client review</h2>
        {list.length > 0 && (
          <span className="muted text-xs">
            {list.length} request{list.length === 1 ? '' : 's'} from the client · {openCount} open · {list.filter((c) => c.status === 'ACCEPTED').length} accepted · {list.filter((c) => c.status === 'DISMISSED').length} dismissed
          </span>
        )}
      </div>

      <InfoBanner>{next}</InfoBanner>
      <p className="muted mb-0 mt-1 text-xs">This page only shows what the client asked to change -- nothing here can be edited.</p>

      <div className="my-4">
        <SendForReviewForm doc={doc} onSent={shareLinks.reload} />
      </div>

      {links.length > 0 && (
        <div className="mb-4 stack gap-1">
          <span className="muted text-xs">Links sent</span>
          {links.map((l) => (
            <div key={l.id} className="row items-center gap-2 text-sm">
              <Badge tone={LINK_STATUS_TONE[l.status]}>{l.status}</Badge>
              <span>{l.recipientEmail}</span>
              <span className="muted text-xs">· {fmtDateTime(l.createdAt)}</span>
            </div>
          ))}
        </div>
      )}

      {actionError != null && <ErrorBanner error={actionError} />}
      {comments.loading && !comments.data && <Spinner label="Loading comments…" />}
      {comments.error != null && !comments.data && <ErrorBanner error={comments.error} onRetry={comments.reload} />}

      {comments.data && (
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <div>
            {pdfError != null && <ErrorBanner error={pdfError} />}
            {!pdfUrl && pdfError == null && <Spinner label="Decrypting the document…" />}
            {pdfUrl && <PdfCanvasViewer fileUrl={pdfUrl} comments={list} selectedCommentId={selected} onSelectComment={setSelected} />}
          </div>
          <div className="stack gap-2">
            {list.length === 0 && <InfoBanner>No comments yet from any client review link for this document.</InfoBanner>}
            {list.map((c) => (
              <div key={c.id} className={cn('rounded-lg border p-3 text-sm', selected === c.id && 'border-primary')} onClick={() => setSelected(c.id)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="muted text-xs">
                    {c.kind === 'CHANGE' ? 'Suggested change' : 'Comment'} · page {c.pageNumber}
                  </span>
                  <span className="row gap-1">
                    {c.applied && <Badge tone="ok">Applied</Badge>}
                    <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                  </span>
                </div>
                {/* Plain text only: a client's comment is attacker-controlled input, never rendered as HTML. */}
                {c.kind === 'CHANGE' ? (
                  <p className="mb-0 mt-1">
                    {c.originalText ? <span className="line-through">{c.originalText}</span> : <span className="muted">(text inside the box)</span>}
                    {' → '}
                    <strong>{c.editedReplacementText ?? c.replacementText}</strong>
                    {c.editedReplacementText && c.editedReplacementText !== c.replacementText && (
                      <span className="muted text-xs"> (client wrote "{c.replacementText}")</span>
                    )}
                  </p>
                ) : null}
                {c.kind === 'COMMENT' || !c.body.startsWith('Change ') ? <p className="mb-0 mt-1 whitespace-pre-wrap">{c.body}</p> : null}
                {c.status === 'OPEN' && (
                  <div className="row mt-2">
                    <button type="button" className="btn small" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); decide(c.id, 'dismiss'); }}>Dismiss</button>
                    <button type="button" className="btn small primary" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); decide(c.id, 'accept'); }}>Accept</button>
                  </div>
                )}
                {c.resolvedBy && (
                  <p className="muted mb-0 mt-2 text-xs">
                    {c.status === 'ACCEPTED' ? 'Accepted' : 'Dismissed'} by {c.resolvedBy.name}
                    {c.resolvedAt ? ` · ${fmtDateTime(c.resolvedAt)}` : ''}
                  </p>
                )}
              </div>
            ))}
            <EditInStirlingSection doc={doc} />
          </div>
        </div>
      )}

      <div className="mt-5 stack gap-3 border-t pt-4">
        <SendModifiedCopyForm doc={doc} links={links} />
      </div>
    </div>
  );
}
