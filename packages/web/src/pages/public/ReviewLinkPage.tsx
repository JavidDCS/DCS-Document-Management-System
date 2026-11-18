import type { ReviewCommentDto } from '@dcs-docs/shared';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../../api';
import { getReviewContent, getReviewLink, submitComment } from '../../api/publicClient';
import { AuthShell } from '../../components/AuthShell';
import { PdfCanvasViewer, type PlacedPin } from '../../components/pdf/PdfCanvasViewer';
import { Badge, ErrorBanner, InfoBanner, Spinner } from '../../components/ui';
import { useTitle } from '../../hooks';
import { fmtDateTime } from '../../lib/format';
import { classifyReviewLinkState, REVIEW_LINK_MESSAGES } from './reviewLinkState';

const STATUS_TONE: Record<ReviewCommentDto['status'], 'warn' | 'ok' | 'neutral'> = { OPEN: 'warn', ACCEPTED: 'ok', DISMISSED: 'neutral' };

export function ReviewLinkPage() {
  useTitle('Review document');
  const { token = '' } = useParams();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof getReviewLink>> | null>(null);
  const [comments, setComments] = useState<ReviewCommentDto[]>([]);

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const [pendingPin, setPendingPin] = useState<PlacedPin | null>(null);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getReviewLink(token);
      setInfo(data);
      setComments(data.comments);
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!info || info.status !== 'ACTIVE') return;
    let alive = true;
    let objectUrl: string | null = null;
    setPdfError(null);
    getReviewContent(token)
      .then((r) => {
        if (!alive) return;
        objectUrl = r.url;
        setPdfUrl(r.url);
      })
      .catch(() => {
        if (alive) setPdfError('The document could not be loaded. Reload the page to try again.');
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.status, token]);

  const hasOpenComment = comments.some((c) => c.status === 'OPEN');

  function handlePlacePin(pos: PlacedPin) {
    setSubmitError(null);
    setPendingPin(pos);
  }

  function cancelComposer() {
    setPendingPin(null);
    setDraft('');
    setSubmitError(null);
  }

  async function saveComment() {
    if (!pendingPin || !draft.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await submitComment(token, { pageNumber: pendingPin.pageNumber, xPct: pendingPin.xPct, yPct: pendingPin.yPct, body: draft.trim() });
      setComments((prev) => [...prev, created]);
      setPendingPin(null);
      setDraft('');
    } catch (e) {
      // Draft text is intentionally preserved on failure so the client doesn't have to retype it.
      setSubmitError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  const state = classifyReviewLinkState({ loading, error: loadError, info });

  if (state.kind === 'loading') {
    return (
      <AuthShell>
        <div className="grid place-items-center py-10">
          <Spinner label="Opening the document…" />
        </div>
      </AuthShell>
    );
  }

  if (state.kind !== 'ready') {
    const msg = REVIEW_LINK_MESSAGES[state.kind];
    return (
      <AuthShell>
        <div className="stack gap-5">
          <div>
            <h1 className="text-[26px]">{msg.title}</h1>
            <p className="muted mt-1.5 text-sm">{msg.body}</p>
          </div>
          {state.kind === 'network' && <ErrorBanner message={msg.body} onRetry={load} />}
        </div>
      </AuthShell>
    );
  }

  const { info: ready } = state;

  return (
    <AuthShell wide>
      <div className="stack gap-5" aria-labelledby="review-title">
        <div>
          <h1 id="review-title" className="text-[26px]">{ready.documentName}</h1>
          <p className="muted mt-1.5 text-sm">Review the document below. Click anywhere on a page to leave a comment at that spot.</p>
          <p className="muted mt-1 text-xs">This link expires {fmtDateTime(ready.expiresAt)}.</p>
        </div>

        {pdfError && <ErrorBanner message={pdfError} />}
        {!pdfUrl && !pdfError && (
          <div className="py-8">
            <Spinner label="Decrypting the document…" />
          </div>
        )}

        {pdfUrl && (
          <PdfCanvasViewer
            fileUrl={pdfUrl}
            comments={comments}
            onPlacePin={hasOpenComment ? undefined : handlePlacePin}
            selectedCommentId={null}
          />
        )}

        {comments.length === 0 && !pendingPin && <InfoBanner>Click anywhere on the document to leave a comment.</InfoBanner>}

        {hasOpenComment && !pendingPin && (
          <InfoBanner kind="warn">
            A comment is already waiting on review for this link. Only one open comment is allowed per link — ask the sender for a new link if you need to raise something else.
          </InfoBanner>
        )}

        {pendingPin && (
          <div className="stack gap-2 rounded-xl border bg-muted/30 p-4">
            <label className="field">
              <span>Your comment (page {pendingPin.pageNumber})</span>
              <textarea
                rows={4}
                maxLength={2000}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Describe the change you'd like…"
                autoFocus
              />
            </label>
            {submitError && <ErrorBanner message={submitError} />}
            <div className="row end">
              <button type="button" className="btn" onClick={cancelComposer} disabled={submitting}>Cancel</button>
              <button type="button" className="btn primary" onClick={saveComment} disabled={submitting || !draft.trim()}>
                {submitting ? 'Saving…' : 'Save comment'}
              </button>
            </div>
          </div>
        )}

        {comments.length > 0 && (
          <div className="stack gap-2">
            <h2 className="!mb-0 text-sm font-semibold">Comments on this link</h2>
            <ol className="m-0 list-none stack gap-2 p-0">
              {comments.map((c) => (
                <li key={c.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="muted text-xs">Page {c.pageNumber}</span>
                    <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                  </div>
                  {/* Plain text only: a client's comment is attacker-controlled input, never rendered as HTML. */}
                  <p className="mb-0 mt-1 whitespace-pre-wrap">{c.body}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </AuthShell>
  );
}
