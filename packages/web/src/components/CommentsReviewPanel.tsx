import type { ReviewCommentDto, ShareLinkDto, ShareLinkStatus } from '@dcs-docs/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { useLoad } from '../hooks';
import { fmtDateTime } from '../lib/format';
import type { DocumentDetail } from '../types';
import { PdfCanvasViewer } from './pdf/PdfCanvasViewer';
import { Badge, ErrorBanner, InfoBanner, Spinner, cn } from './ui';

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

/** The change note the server writes on the version it creates when it stamps the signature. */
const SIGNATURE_NOTE = 'Signature added';

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

/** Step 6: email the final PDF (attached, with a link) to the client for signing. */
function SendForSigningForm({ doc, links, disabledReason, onSent }: { doc: DocumentDetail; links: ShareLinkDto[]; disabledReason: string | null; onSent: () => void }) {
  const latest = links[0];
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The person the review went to is almost always who signs; prefill once their link is known, but never overwrite typing.
  useEffect(() => {
    if (latest && !email) setEmail(latest.recipientEmail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.recipientEmail]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      // The server only accepts a "resend" built on a link that has finished (accepted or dismissed).
      const previous = links.find((l) => l.status === 'ACCEPTED' || l.status === 'DISMISSED');
      await api.post(`/documents/${doc.id}/share-links`, {
        recipientEmail: email.trim(),
        purpose: 'SIGNING',
        ...(previous && previous.recipientEmail === email.trim().toLowerCase() ? { previousLinkId: previous.id } : {}),
      });
      toast.success(`The final document was emailed to ${email.trim()} for signing`);
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
        <span className="text-xs font-medium">Send the final document for signing</span>
        <input type="email" required placeholder="client@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="input" disabled={sending} />
      </label>
      <button type="submit" className="btn primary" disabled={sending || !email.trim() || disabledReason !== null} title={disabledReason ?? 'Email the current version to the client with the PDF attached'}>
        {sending ? 'Sending…' : 'Send for signing'}
      </button>
      {disabledReason && <span className="muted w-full text-xs">{disabledReason}</span>}
      {error != null && <ErrorBanner error={error} />}
    </form>
  );
}

/**
 * Staff side of the external review, as one left-to-right workflow:
 *   send link -> client comments -> accept/dismiss each -> apply accepted changes -> add signature -> send for signing.
 * The panel always tells staff which step is next. It reuses the page's already-loaded `doc`; after a step writes a
 * new version it asks the page to reload (`onDocumentChanged`) so the version list and this viewer follow along.
 */
export function CommentsReviewPanel({ doc, onDocumentChanged }: { doc: DocumentDetail; onDocumentChanged?: () => void }) {
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
  const waiting = list.filter((c) => c.kind === 'CHANGE' && c.status === 'ACCEPTED' && !c.applied);
  const waitingByLink = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of waiting) m.set(c.shareLinkId, (m.get(c.shareLinkId) ?? 0) + 1);
    return m;
  }, [waiting]);
  const current = doc.versions.find((v) => v.id === doc.currentVersionId);
  const signed = current?.changeNote === SIGNATURE_NOTE;

  async function run(key: string, call: () => Promise<unknown>, success: string, changesDocument: boolean) {
    setBusy(key);
    setActionError(null);
    try {
      await call();
      toast.success(success);
      comments.reload();
      shareLinks.reload();
      if (changesDocument) onDocumentChanged?.();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  const decide = (id: string, action: 'accept' | 'dismiss') =>
    run(id, () => api.post(`/review-comments/${id}/${action}`), action === 'accept' ? 'Accepted' : 'Dismissed', false);

  // "What now?" -- the one line a person needs, in the order the work actually happens.
  let next: string;
  if (links.length === 0) next = 'Step 1: email the document to the client for review.';
  else if (list.length === 0) next = 'Waiting for the client. You will get an email as soon as they comment.';
  else if (openCount > 0) next = `Step 2: accept or dismiss each of the ${openCount} open comment${openCount === 1 ? '' : 's'}.`;
  else if (waiting.length > 0) next = `Step 3: apply the ${waiting.length} accepted change${waiting.length === 1 ? '' : 's'} to the PDF.`;
  else if (!signed) next = 'Step 4: add the signature to the final PDF.';
  else next = 'Step 5: send the signed document to the client.';

  const signDisabled = waiting.length > 0 ? 'Apply the accepted changes first. The signature goes on last.' : signed ? 'This version already carries the signature.' : null;
  const sendDisabled = waiting.length > 0 ? 'Apply the accepted changes before sending.' : openCount > 0 ? 'Answer every open comment before sending.' : null;

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="!mb-0">Client review</h2>
      </div>

      <InfoBanner>{next}</InfoBanner>

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
              {(waitingByLink.get(l.id) ?? 0) > 0 && openCount === 0 && (
                <button
                  type="button"
                  className="btn small primary"
                  disabled={busy !== null}
                  onClick={() =>
                    run(
                      `apply-${l.id}`,
                      () => api.post(`/documents/${doc.id}/review/apply-changes`, { shareLinkId: l.id }),
                      'Changes applied: a new version of the PDF was created',
                      true
                    )
                  }
                >
                  {busy === `apply-${l.id}` ? 'Applying…' : `Apply ${waitingByLink.get(l.id)} accepted change${waitingByLink.get(l.id) === 1 ? '' : 's'}`}
                </button>
              )}
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
                    <strong>{c.replacementText}</strong>
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
          </div>
        </div>
      )}

      <div className="mt-5 stack gap-3 border-t pt-4">
        <div className="row items-center gap-3">
          <button
            type="button"
            className="btn"
            disabled={busy !== null || signDisabled !== null}
            title={signDisabled ?? 'Stamp the pre-approved signature onto the current version'}
            onClick={() => run('sign', () => api.post(`/documents/${doc.id}/review/stamp-signature`, {}), 'Signature added: a new version of the PDF was created', true)}
          >
            {busy === 'sign' ? 'Adding…' : signed ? 'Signature added ✓' : 'Add signature'}
          </button>
          {signDisabled && !signed && <span className="muted text-xs">{signDisabled}</span>}
        </div>
        <SendForSigningForm doc={doc} links={links} disabledReason={sendDisabled} onSent={shareLinks.reload} />
      </div>
    </div>
  );
}
