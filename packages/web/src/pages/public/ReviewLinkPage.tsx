import type { ReviewCommentDto } from '@dcs-docs/shared';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../../api';
import { getReviewContent, getReviewLink, submitComment } from '../../api/publicClient';
import { AuthShell } from '../../components/AuthShell';
import { PdfCanvasViewer, type PlacedBox, type PlacedPin } from '../../components/pdf/PdfCanvasViewer';
import { Badge, ErrorBanner, InfoBanner, Spinner } from '../../components/ui';
import { useTitle } from '../../hooks';
import { fmtDateTime } from '../../lib/format';
import { classifyReviewLinkState, REVIEW_LINK_MESSAGES } from './reviewLinkState';

const STATUS_TONE: Record<ReviewCommentDto['status'], 'warn' | 'ok' | 'neutral'> = { OPEN: 'warn', ACCEPTED: 'ok', DISMISSED: 'neutral' };
const STATUS_LABEL: Record<ReviewCommentDto['status'], string> = { OPEN: 'Waiting for review', ACCEPTED: 'Accepted', DISMISSED: 'Not taken forward' };

export function ReviewLinkPage() {
  useTitle('Review document');
  const { token = '' } = useParams();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof getReviewLink>> | null>(null);
  const [comments, setComments] = useState<ReviewCommentDto[]>([]);

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // What the client is composing: a click leaves a pin (a comment), a drag draws a box (a suggested change).
  const [pending, setPending] = useState<PlacedPin | PlacedBox | null>(null);
  const [draft, setDraft] = useState('');
  const [replacement, setReplacement] = useState('');
  const [original, setOriginal] = useState('');
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

  const pendingIsChange = pending !== null && 'wPct' in pending;
  const canSave = pending !== null && (pendingIsChange ? replacement.trim().length > 0 : draft.trim().length > 0);

  function handlePlacePin(pos: PlacedPin) {
    setSubmitError(null);
    setPending(pos);
  }

  function handlePlaceBox(box: PlacedBox) {
    setSubmitError(null);
    setPending(box);
  }

  function cancelComposer() {
    setPending(null);
    setDraft('');
    setReplacement('');
    setOriginal('');
    setSubmitError(null);
  }

  async function saveComment() {
    if (!pending || !canSave) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await submitComment(
        token,
        'wPct' in pending
          ? {
              kind: 'CHANGE',
              pageNumber: pending.pageNumber,
              xPct: pending.xPct,
              yPct: pending.yPct,
              boxWPct: pending.wPct,
              boxHPct: pending.hPct,
              originalText: original.trim() || undefined,
              replacementText: replacement.trim(),
              body: draft.trim() || undefined,
            }
          : { kind: 'COMMENT', pageNumber: pending.pageNumber, xPct: pending.xPct, yPct: pending.yPct, body: draft.trim() }
      );
      setComments((prev) => [...prev, created]);
      cancelComposer();
    } catch (e) {
      // What the client typed is intentionally preserved on failure so they do not have to retype it.
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
          <p className="muted mt-1.5 text-sm">Read the document below, then tell us what you would like changed. You can add as many comments as you need.</p>
          <ul className="muted mt-2 list-disc pl-5 text-sm">
            <li><strong>To leave a comment:</strong> click the spot on the page.</li>
            <li><strong>To change a name, price, date or period:</strong> drag a box around that text, then type the new value.</li>
          </ul>
          <p className="muted mt-2 text-xs">This link expires {fmtDateTime(ready.expiresAt)}.</p>
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
            onPlacePin={handlePlacePin}
            onPlaceBox={handlePlaceBox}
            pending={pending}
            selectedCommentId={null}
          />
        )}

        {comments.length === 0 && !pending && <InfoBanner>Nothing added yet. Click the document to comment, or drag a box around text you want changed.</InfoBanner>}

        {pending && (
          <div className="stack gap-3 rounded-xl border bg-muted/30 p-4">
            <h2 className="!mb-0 text-sm font-semibold">{pendingIsChange ? `Suggest a change (page ${pending.pageNumber})` : `Your comment (page ${pending.pageNumber})`}</h2>

            {pendingIsChange ? (
              <>
                <label className="field">
                  <span>Text in the box today <span className="muted">(optional, helps us find it)</span></span>
                  <input type="text" maxLength={300} value={original} onChange={(e) => setOriginal(e.target.value)} placeholder="e.g. [Counterparty Legal Name]" />
                </label>
                <label className="field">
                  <span>Change it to</span>
                  <input type="text" maxLength={300} value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="e.g. Acme Solar Pvt Ltd" autoFocus />
                </label>
                <label className="field">
                  <span>Note <span className="muted">(optional)</span></span>
                  <textarea rows={2} maxLength={2000} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Anything we should know about this change" />
                </label>
              </>
            ) : (
              <label className="field">
                <span>Your comment</span>
                <textarea rows={4} maxLength={2000} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Describe what you would like to change…" autoFocus />
              </label>
            )}

            {submitError && <ErrorBanner message={submitError} />}
            <div className="row end">
              <button type="button" className="btn" onClick={cancelComposer} disabled={submitting}>Cancel</button>
              <button type="button" className="btn primary" onClick={saveComment} disabled={submitting || !canSave}>
                {submitting ? 'Saving…' : pendingIsChange ? 'Save suggested change' : 'Save comment'}
              </button>
            </div>
          </div>
        )}

        {comments.length > 0 && (
          <div className="stack gap-2">
            <h2 className="!mb-0 text-sm font-semibold">Your comments ({comments.length})</h2>
            <p className="muted m-0 text-xs">Our team has been told. You will get the updated document from the sender once they have gone through these.</p>
            <ol className="m-0 list-none stack gap-2 p-0">
              {comments.map((c) => (
                <li key={c.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="muted text-xs">
                      {c.kind === 'CHANGE' ? 'Suggested change' : 'Comment'} · page {c.pageNumber}
                    </span>
                    <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                  </div>
                  {/* Plain text only: a client's comment is attacker-controlled input, never rendered as HTML. */}
                  {c.kind === 'CHANGE' ? (
                    <p className="mb-0 mt-1">
                      {c.originalText ? <span className="line-through">{c.originalText}</span> : <span className="muted">(text in the box)</span>}
                      {' → '}
                      <strong>{c.replacementText}</strong>
                    </p>
                  ) : null}
                  {c.kind === 'COMMENT' || !c.body.startsWith('Change ') ? <p className="mb-0 mt-1 whitespace-pre-wrap">{c.body}</p> : null}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </AuthShell>
  );
}
