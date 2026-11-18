import type { ReviewCommentDto } from '@dcs-docs/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../api';
import { useLoad } from '../hooks';
import { fmtDateTime } from '../lib/format';
import type { DocumentDetail } from '../types';
import { PdfCanvasViewer } from './pdf/PdfCanvasViewer';
import { Badge, ErrorBanner, InfoBanner, Spinner, cn } from './ui';

const STATUS_TONE: Record<ReviewCommentDto['status'], 'warn' | 'ok' | 'neutral'> = { OPEN: 'warn', ACCEPTED: 'ok', DISMISSED: 'neutral' };

/** Staff-facing review of a document's client comments: read-only PDF + pin list, with Accept/Dismiss per
 * comment and a "Stamp & send back" action once every comment is resolved. Bolted onto DocumentDetailPage
 * as the 'comments' tab; reuses that page's already-loaded `doc`, so this fetches only the comments and the
 * current version's bytes, not the document itself again. */
export function CommentsReviewPanel({ doc }: { doc: DocumentDetail }) {
  const comments = useLoad(async () => (await api.get<ReviewCommentDto[]>(`/documents/${doc.id}/review-comments`)).data, [doc.id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (!doc.currentVersionId) return;
    let alive = true;
    let objectUrl: string | null = null;
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

  async function decide(id: string, action: 'accept' | 'dismiss') {
    setBusyId(id);
    setActionError(null);
    try {
      await api.post(`/review-comments/${id}/${action}`);
      toast.success(action === 'accept' ? 'Comment accepted — a new, stamped version was created' : 'Comment dismissed');
      comments.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusyId(null);
    }
  }

  const list = (comments.data ?? []).slice().sort((a, b) => Number(b.status === 'OPEN') - Number(a.status === 'OPEN'));
  const hasOpen = list.some((c) => c.status === 'OPEN');

  return (
    <div className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="!mb-0">Client review comments</h2>
        {/* "Stamp & send back": per the plan, accepting a comment already creates the stamped version
         * (ReviewService.acceptComment). Sending it back reuses the existing compose/send screen rather than
         * a new endpoint, matching the plan's design call that every external send goes through that one
         * confirmation step. If a later pass adds a dedicated resend action on the share-link itself, point
         * this at that instead. */}
        <Link
          className={cn('btn primary', hasOpen && 'pointer-events-none opacity-50')}
          to={`/send?documentId=${doc.id}`}
          aria-disabled={hasOpen}
          tabIndex={hasOpen ? -1 : undefined}
          title={hasOpen ? 'Resolve the open comment before sending the stamped document back' : 'Send the current version back to the client'}
        >
          Stamp &amp; send back
        </Link>
      </div>

      {actionError != null && <ErrorBanner error={actionError} />}
      {comments.loading && !comments.data && <Spinner label="Loading comments…" />}
      {comments.error != null && !comments.data && <ErrorBanner error={comments.error} onRetry={comments.reload} />}

      {comments.data && (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div>
            {pdfError != null && <ErrorBanner error={pdfError} />}
            {!pdfUrl && pdfError == null && <Spinner label="Decrypting the document…" />}
            {pdfUrl && <PdfCanvasViewer fileUrl={pdfUrl} comments={list} selectedCommentId={selected} onSelectComment={setSelected} />}
          </div>
          <div className="stack gap-2">
            {list.length === 0 && <InfoBanner>No comments yet from any client review link for this document.</InfoBanner>}
            {list.map((c) => (
              <div key={c.id} className={cn('rounded-lg border p-3 text-sm', selected === c.id && 'border-primary')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="muted text-xs">Page {c.pageNumber}</span>
                  <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                </div>
                {/* Plain text only: a client's comment is attacker-controlled input, never rendered as HTML. */}
                <p className="mb-0 mt-1 whitespace-pre-wrap">{c.body}</p>
                {c.status === 'OPEN' && (
                  <div className="row mt-2">
                    <button type="button" className="btn small" disabled={busyId === c.id} onClick={() => decide(c.id, 'dismiss')}>Dismiss</button>
                    <button type="button" className="btn small primary" disabled={busyId === c.id} onClick={() => decide(c.id, 'accept')}>Accept &amp; stamp</button>
                  </div>
                )}
                {c.resolvedBy && (
                  <p className="muted mb-0 mt-2 text-xs">
                    Resolved by {c.resolvedBy.name}
                    {c.resolvedAt ? ` · ${fmtDateTime(c.resolvedAt)}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
