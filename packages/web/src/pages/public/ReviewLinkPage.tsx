import type { CreateReviewCommentInput, ReviewCommentDto, SubmitReviewFieldInput } from '@dcs-docs/shared';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../../api';
import { getReviewContent, getReviewLink, submitComments, submitReviewFields } from '../../api/publicClient';
import { AuthShell } from '../../components/AuthShell';
import { Logo } from '../../components/Logo';
import { PdfCanvasViewer, type PlacedPin } from '../../components/pdf/PdfCanvasViewer';
import { Badge, ErrorBanner, InfoBanner, Spinner } from '../../components/ui';
import { useTitle } from '../../hooks';
import { fmtDateTime } from '../../lib/format';
import { classifyReviewLinkState, REVIEW_LINK_MESSAGES } from './reviewLinkState';

const STATUS_TONE: Record<ReviewCommentDto['status'], 'warn' | 'ok' | 'neutral'> = { OPEN: 'warn', ACCEPTED: 'ok', DISMISSED: 'neutral' };
const STATUS_LABEL: Record<ReviewCommentDto['status'], string> = { OPEN: 'Waiting for review', ACCEPTED: 'Accepted', DISMISSED: 'Not taken forward' };

let draftSeq = 0;

interface DraftItem {
  id: string;
  input: CreateReviewCommentInput;
}

/** Turns a not-yet-sent draft into the shape PdfCanvasViewer already knows how to draw, purely so it shows up
 * as a marker on the page before it's actually sent. */
function toDraftComment(d: DraftItem): ReviewCommentDto {
  const i = d.input;
  return {
    id: d.id,
    shareLinkId: '',
    kind: i.kind,
    pageNumber: i.pageNumber,
    xPct: i.xPct,
    yPct: i.yPct,
    boxWPct: i.kind === 'CHANGE' ? (i.boxWPct ?? null) : null,
    boxHPct: i.kind === 'CHANGE' ? (i.boxHPct ?? null) : null,
    originalText: i.kind === 'CHANGE' ? (i.originalText ?? null) : null,
    replacementText: i.kind === 'CHANGE' ? (i.replacementText ?? null) : null,
    fieldKey: null,
    editedReplacementText: null,
    applied: false,
    body: i.body ?? '',
    status: 'OPEN',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  };
}

export function ReviewLinkPage() {
  useTitle('Review document');
  const { token = '' } = useParams();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof getReviewLink>> | null>(null);
  const [comments, setComments] = useState<ReviewCommentDto[]>([]);

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // The fixed field form: what the client has typed so far, and what's queued but not yet sent.
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [fieldQueue, setFieldQueue] = useState<SubmitReviewFieldInput[]>([]);
  const [fieldSending, setFieldSending] = useState(false);
  const [fieldSubmitError, setFieldSubmitError] = useState<string | null>(null);

  // The 1% fallback: a click leaves a pin (a free-text comment) for anything the fixed fields don't cover.
  const [pending, setPending] = useState<PlacedPin | null>(null);
  const [draft, setDraft] = useState('');

  // Queued locally -- nothing is sent to the team until "Send to our team" below, so adding several items in a
  // row produces exactly one notification email covering all of them, not one email per item.
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [sending, setSending] = useState(false);
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

  const canSave = pending !== null && draft.trim().length > 0;

  function handlePlacePin(pos: PlacedPin) {
    setSubmitError(null);
    setPending(pos);
  }

  function cancelComposer() {
    setPending(null);
    setDraft('');
    setSubmitError(null);
  }

  function addDraft() {
    if (!pending || !canSave) return;
    const input: CreateReviewCommentInput = { kind: 'COMMENT', pageNumber: pending.pageNumber, xPct: pending.xPct, yPct: pending.yPct, body: draft.trim() };
    setDrafts((cur) => [...cur, { id: `draft-${++draftSeq}`, input }]);
    cancelComposer();
  }

  function removeDraft(id: string) {
    setDrafts((cur) => cur.filter((d) => d.id !== id));
  }

  async function sendDrafts() {
    if (drafts.length === 0) return;
    setSending(true);
    setSubmitError(null);
    try {
      const created = await submitComments(token, drafts.map((d) => d.input));
      setComments((prev) => [...prev, ...created]);
      setDrafts([]);
    } catch (e) {
      // The queued drafts are kept on failure so nothing typed has to be redone.
      setSubmitError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  function queueFields(fields: { key: string; label: string }[]) {
    const toQueue = fields.filter((f) => fieldValues[f.key]?.trim());
    if (toQueue.length === 0) return;
    setFieldSubmitError(null);
    setFieldQueue((cur) => {
      const next = cur.filter((q) => !toQueue.some((f) => f.key === q.fieldKey));
      return [...next, ...toQueue.map((f) => ({ fieldKey: f.key, value: fieldValues[f.key]!.trim() }))];
    });
    setFieldValues((cur) => {
      const next = { ...cur };
      for (const f of toQueue) delete next[f.key];
      return next;
    });
  }

  function removeQueuedField(fieldKey: string) {
    setFieldQueue((cur) => cur.filter((q) => q.fieldKey !== fieldKey));
  }

  async function sendFieldQueue() {
    if (fieldQueue.length === 0) return;
    setFieldSending(true);
    setFieldSubmitError(null);
    try {
      const created = await submitReviewFields(token, fieldQueue);
      setComments((prev) => [...prev, ...created]);
      setFieldQueue([]);
    } catch (e) {
      setFieldSubmitError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setFieldSending(false);
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
  const draftComments = drafts.map(toDraftComment);
  const fieldLabels = Object.fromEntries(ready.editableFields.map((f) => [f.key, f.label]));
  const appConfig = (typeof window !== 'undefined' && (window as any).__APP_CONFIG__) || {};
  const companyName = appConfig.companyName || (import.meta as any).env.VITE_COMPANY_NAME || (import.meta as any).env.APP_COMPANY_NAME || 'DeCircle Solar';

  return (
    <div className="min-h-screen bg-background">
      <header className="topbar">
        <div className="flex items-center gap-3">
          <Logo size={30} />
          <span className="font-display text-[15px] font-semibold tracking-tight">{companyName}</span>
        </div>
        <div className="ml-auto text-right">
          <div className="text-sm font-semibold">{ready.documentName}</div>
          <div className="muted text-xs">Link expires {fmtDateTime(ready.expiresAt)}</div>
        </div>
      </header>

      <main className="main max-w-[1400px]">
        <div className="mb-5">
          <h1 id="review-title" className="text-[22px]">Review this document</h1>
          <p className="muted mt-1 text-sm">
            Fill in anything below that needs to change, then send it -- our team gets one message covering everything,
            not one per item. Something else entirely? Click the spot on the document to leave a comment.
          </p>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[1fr_420px]">
          <section className="order-2 lg:order-1 lg:sticky lg:top-24">
            <div className="rounded-2xl border bg-card p-4 shadow-xs">
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">Document preview</span>
                <a
                  className="btn small"
                  href={`/api/v1/public/review/${encodeURIComponent(token)}/content`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View full PDF
                </a>
              </div>
              {pdfError && <ErrorBanner message={pdfError} />}
              {!pdfUrl && !pdfError && (
                <div className="py-16">
                  <Spinner label="Decrypting the document…" />
                </div>
              )}
              {pdfUrl && (
                <PdfCanvasViewer
                  fileUrl={pdfUrl}
                  comments={[...comments, ...draftComments]}
                  onPlacePin={handlePlacePin}
                  pending={pending}
                  selectedCommentId={null}
                />
              )}
            </div>
          </section>

          <aside className="order-1 stack gap-5 lg:order-2">
            {ready.editableFields.length > 0 && (
              <div className="stack gap-3 rounded-2xl border bg-card p-5 shadow-xs">
                <h2 className="!mb-0 text-sm font-semibold">What needs to change?</h2>
                {ready.editableFields.map((f) => (
                  <label key={f.key} className="field">
                    <span>{f.label}</span>
                    <input
                      type="text"
                      maxLength={300}
                      value={fieldValues[f.key] ?? ''}
                      onChange={(e) => setFieldValues((cur) => ({ ...cur, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                    />
                  </label>
                ))}
                <div className="row end">
                  <button type="button" className="btn primary" onClick={() => queueFields(ready.editableFields)}>Add to list</button>
                </div>
              </div>
            )}

            {comments.length === 0 && drafts.length === 0 && fieldQueue.length === 0 && !pending && (
              <InfoBanner>Nothing added yet. Fill in a field above, or click the document to leave a comment.</InfoBanner>
            )}

            {pending && (
              <div className="stack gap-3 rounded-2xl border bg-card p-5 shadow-xs">
                <h2 className="!mb-0 text-sm font-semibold">Your comment (page {pending.pageNumber})</h2>
                <label className="field">
                  <span>Your comment</span>
                  <textarea rows={4} maxLength={2000} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Describe what you would like to change…" autoFocus />
                </label>
                <div className="row end">
                  <button type="button" className="btn" onClick={cancelComposer}>Cancel</button>
                  <button type="button" className="btn primary" onClick={addDraft} disabled={!canSave}>Add comment</button>
                </div>
              </div>
            )}

            {fieldQueue.length > 0 && (
              <div className="stack gap-2 rounded-2xl border bg-card p-5 shadow-xs">
                <h2 className="!mb-0 text-sm font-semibold">Not sent yet ({fieldQueue.length})</h2>
                <p className="muted m-0 text-xs">Add more fields above, or send everything below -- our team gets one message covering all of these together.</p>
                <ol className="m-0 list-none stack gap-2 p-0">
                  {fieldQueue.map((q) => (
                    <li key={q.fieldKey} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="muted text-xs">{fieldLabels[q.fieldKey] ?? q.fieldKey}</span>
                        <button type="button" className="btn small" onClick={() => removeQueuedField(q.fieldKey)}>Remove</button>
                      </div>
                      <p className="mb-0 mt-1"><strong>{q.value}</strong></p>
                    </li>
                  ))}
                </ol>
                {fieldSubmitError && <ErrorBanner message={fieldSubmitError} />}
                <div className="row end">
                  <button type="button" className="btn primary" onClick={sendFieldQueue} disabled={fieldSending}>
                    {fieldSending ? 'Sending…' : `Send ${fieldQueue.length} to our team`}
                  </button>
                </div>
              </div>
            )}

            {drafts.length > 0 && (
              <div className="stack gap-2 rounded-2xl border bg-card p-5 shadow-xs">
                <h2 className="!mb-0 text-sm font-semibold">Not sent yet ({drafts.length})</h2>
                <p className="muted m-0 text-xs">Add more, or send everything below -- our team gets one message covering all of these together.</p>
                <ol className="m-0 list-none stack gap-2 p-0">
                  {drafts.map((d) => (
                    <li key={d.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="muted text-xs">Comment · page {d.input.pageNumber}</span>
                        <button type="button" className="btn small" onClick={() => removeDraft(d.id)}>Remove</button>
                      </div>
                      <p className="mb-0 mt-1 whitespace-pre-wrap">{d.input.body}</p>
                    </li>
                  ))}
                </ol>
                {submitError && <ErrorBanner message={submitError} />}
                <div className="row end">
                  <button type="button" className="btn primary" onClick={sendDrafts} disabled={sending}>
                    {sending ? 'Sending…' : `Send ${drafts.length} to our team`}
                  </button>
                </div>
              </div>
            )}

            {comments.length > 0 && (
              <div className="stack gap-2 rounded-2xl border bg-card p-5 shadow-xs">
                <h2 className="!mb-0 text-sm font-semibold">Sent ({comments.length})</h2>
                <p className="muted m-0 text-xs">Our team has been told. You will get the updated document from the sender once they have gone through these.</p>
                <ol className="m-0 list-none stack gap-2 p-0">
                  {comments.map((c) => (
                    <li key={c.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="muted text-xs">
                          {c.kind === 'CHANGE' ? (c.fieldKey ? fieldLabels[c.fieldKey] ?? 'Suggested change' : 'Suggested change') : 'Comment'}
                          {c.kind === 'COMMENT' ? ` · page ${c.pageNumber}` : ''}
                        </span>
                        <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                      </div>
                      {/* Plain text only: a client's comment is attacker-controlled input, never rendered as HTML. */}
                      {c.kind === 'CHANGE' ? <p className="mb-0 mt-1"><strong>{c.replacementText}</strong></p> : null}
                      {c.kind === 'COMMENT' ? <p className="mb-0 mt-1 whitespace-pre-wrap">{c.body}</p> : null}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
