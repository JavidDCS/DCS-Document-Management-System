import type { ManualTextEdit, ReviewCommentDto } from '@dcs-docs/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { saveBlob } from '../lib/format';
import type { DocumentDetail } from '../types';
import { PdfCanvasViewer, type PlacedBox } from './pdf/PdfCanvasViewer';
import { ErrorBanner, InfoBanner, Spinner } from './ui';

let fakeId = 0;

const STIRLING_PDF_URL = (import.meta.env.VITE_STIRLING_PDF_URL as string | undefined)?.trim();

/** Turns a not-yet-saved edit into the shape PdfCanvasViewer already knows how to draw (a green "accepted"
 * box) -- reuses the exact same overlay rendering as the client-review viewer, no new drawing code needed. */
function toFakeComment(e: ManualTextEdit, id: string): ReviewCommentDto {
  return {
    id,
    shareLinkId: '',
    kind: 'CHANGE',
    pageNumber: e.pageNumber,
    xPct: e.xPct,
    yPct: e.yPct,
    boxWPct: e.wPct,
    boxHPct: e.hPct,
    originalText: null,
    replacementText: e.text,
    editedReplacementText: null,
    applied: false,
    body: `Change to "${e.text}"`,
    status: 'ACCEPTED',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  };
}

/**
 * Lets staff edit the document's current version directly, anywhere -- drag a box around any text, type the
 * new wording, see it marked on the page, and save every pending edit as one new version. Not tied to any
 * client comment or share link; this is a separate, general capability from the client-review workflow.
 */
export function DocumentEditPanel({ doc, onDocumentChanged }: { doc: DocumentDetail; onDocumentChanged?: () => void }) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<unknown>(null);
  const [pending, setPending] = useState<PlacedBox | null>(null);
  const [draftText, setDraftText] = useState('');
  const [edits, setEdits] = useState<{ id: string; edit: ManualTextEdit }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

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
        objectUrl = URL.createObjectURL(new Blob([r.blob], { type: 'application/pdf' }));
        setPdfUrl(objectUrl);
      })
      .catch((e) => alive && setPdfError(e));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.id, doc.currentVersionId]);

  function addDraft(e: FormEvent) {
    e.preventDefault();
    if (!pending || !draftText.trim()) return;
    setEdits((cur) => [...cur, { id: `pending-${++fakeId}`, edit: { pageNumber: pending.pageNumber, xPct: pending.xPct, yPct: pending.yPct, wPct: pending.wPct, hPct: pending.hPct, text: draftText.trim() } }]);
    setPending(null);
    setDraftText('');
  }

  function removeDraft(id: string) {
    setEdits((cur) => cur.filter((x) => x.id !== id));
  }

  async function downloadForExternalEdit() {
    if (!doc.currentVersionId) return;
    const r = await api.blob(`/documents/${doc.id}/versions/${doc.currentVersionId}/content`);
    saveBlob(r.blob, r.filename ?? 'document.pdf');
  }

  async function save() {
    if (edits.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/documents/${doc.id}/review/edit-text`, { edits: edits.map((x) => x.edit) });
      toast.success(`Saved: ${edits.length} edit${edits.length === 1 ? '' : 's'} written into a new version`);
      setEdits([]);
      onDocumentChanged?.();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  const comments = edits.map((x) => toFakeComment(x.edit, x.id));

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="!mb-0">Edit document</h2>
        <button type="button" className="btn primary" disabled={saving || edits.length === 0} onClick={save}>
          {saving ? 'Saving…' : `Save as new version${edits.length ? ` (${edits.length})` : ''}`}
        </button>
      </div>
      <InfoBanner>Drag a box around any text to change it. Nothing is saved until you click "Save as new version" -- check everything looks right first.</InfoBanner>

      {STIRLING_PDF_URL && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
          <span>Need a full editor instead? Download the current file, edit it in Stirling-PDF, then use "Upload new version" (Versions tab) to bring the result back in.</span>
          <button type="button" className="btn small" onClick={downloadForExternalEdit}>Download current PDF</button>
          <a href={STIRLING_PDF_URL} target="_blank" rel="noopener noreferrer" className="btn small">Open Stirling-PDF editor</a>
        </div>
      )}

      {error != null && <ErrorBanner error={error} />}
      {pdfError != null && <ErrorBanner error={pdfError} />}
      {!pdfUrl && pdfError == null && <Spinner label="Decrypting the document…" />}

      {pdfUrl && (
        <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_320px]">
          <PdfCanvasViewer fileUrl={pdfUrl} comments={comments} onPlaceBox={setPending} pending={pending} />
          <div className="stack gap-2">
            {pending && (
              <form onSubmit={addDraft} className="stack gap-2 rounded-lg border p-3">
                <span className="text-xs font-medium">New text for this spot</span>
                <input type="text" autoFocus value={draftText} onChange={(e) => setDraftText(e.target.value)} maxLength={300} />
                <div className="row">
                  <button type="button" className="btn small" onClick={() => setPending(null)}>Cancel</button>
                  <button type="submit" className="btn small primary" disabled={!draftText.trim()}>Add</button>
                </div>
              </form>
            )}
            {edits.length === 0 && !pending && <InfoBanner>Drag a box on the document to start an edit.</InfoBanner>}
            {edits.map((x) => (
              <div key={x.id} className="rounded-lg border p-3 text-sm">
                <p className="muted mb-1 text-xs">Page {x.edit.pageNumber}</p>
                <p className="mb-2">
                  → <strong>{x.edit.text}</strong>
                </p>
                <button type="button" className="btn small" onClick={() => removeDraft(x.id)}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
