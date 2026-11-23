import { FileText } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useLoad } from '../hooks';
import { fmtDateTime } from '../lib/format';
import { Badge, ConfirmDialog, ErrorBanner, InfoBanner, Spinner } from './ui';

interface TemplateInfo {
  present: boolean;
  filename: string | null;
  uploadedAt: string | null;
  blanks: string[];
  blanksWithoutField: string[];
  fieldsWithoutBlank: string[];
  blanksWithoutDefault: string[];
  converter: { available: boolean; engine: string };
}

const engineName = (e: string) => (e === 'stirling' ? 'Stirling-PDF' : e === 'libreoffice' ? 'LibreOffice' : e);

/**
 * The Word version of the agreement. When one is uploaded, "accepting the client's changes" fills its {{blanks}} and makes a fresh
 * PDF from it: the new words have the same font, size and spacing as the rest, and nothing is painted over anything.
 * Everyone who reviews can look; only an administrator can upload or remove.
 */
export function ReviewTemplatePanel({ documentId, onChanged }: { documentId: string; onChanged?: () => void }) {
  const { can } = useAuth();
  const manage = can('documents:manage');
  const info = useLoad(async () => (await api.get<TemplateInfo>(`/documents/${documentId}/review-template`)).data, [documentId]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState(false);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      await api.upload<TemplateInfo>(`/documents/${documentId}/review-template`, form);
      toast.success('The Word template was saved');
      info.reload();
      onChanged?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const t = info.data;
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="!mb-0 flex items-center gap-2 text-sm font-semibold">
          <FileText className="size-4" aria-hidden="true" /> Word template of this agreement
        </h3>
        {t && <Badge tone={t.present ? 'ok' : 'neutral'}>{t.present ? 'Uploaded' : 'Not uploaded'}</Badge>}
      </div>
      <p className="muted mb-2 text-xs">
        With a Word template, accepting the client's answers makes a fresh PDF from it, so the new words match the rest of the agreement exactly. Without one, the new words are painted over the PDF.
      </p>

      {info.loading && !t && <Spinner />}
      {info.error != null && <ErrorBanner error={info.error} />}

      {t && !t.converter.available && t.present && (
        <InfoBanner>No Word-to-PDF converter is set up on the server, so accepting changes will stop with a message. Ask the administrator to set DOCX_PDF_CONVERTER in .env.</InfoBanner>
      )}

      {t?.present && (
        <div className="stack gap-2 text-xs">
          <p className="mb-0">
            <b>{t.filename}</b>
            {t.uploadedAt ? <span className="muted"> · saved {fmtDateTime(t.uploadedAt)}</span> : null}
            {t.converter.available ? <span className="muted"> · made into a PDF by {engineName(t.converter.engine)}</span> : null}
          </p>
          <p className="mb-0">
            Blanks found in the file: {t.blanks.map((b) => <code key={b} className="mr-1 rounded bg-muted px-1">{`{{${b}}}`}</code>)}
          </p>
          {t.blanksWithoutField.length > 0 && (
            <p role="alert" className="mb-0 text-rose-700">
              These blanks have no field in the document type, so nobody can fill them and the document cannot be made: {t.blanksWithoutField.join(', ')}.
            </p>
          )}
          {t.fieldsWithoutBlank.length > 0 && (
            <p className="mb-0 text-amber-800">These fields have no blank in the Word file, so their answers would go nowhere: {t.fieldsWithoutBlank.join(', ')}.</p>
          )}
          {t.blanksWithoutDefault.length > 0 && (
            <p className="muted mb-0">If the client leaves one of these empty the document cannot be made, so make them required: {t.blanksWithoutDefault.join(', ')}.</p>
          )}
        </div>
      )}

      {manage && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" data-testid="template-file" onChange={(e) => void upload(e.target.files?.[0])} />
          <button type="button" className="btn small primary" disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? 'Uploading…' : t?.present ? 'Replace the Word file' : 'Upload the Word file'}
          </button>
          {t?.present && (
            <button type="button" className="btn small" disabled={busy} onClick={() => setRemoving(true)}>
              Remove
            </button>
          )}
          <span className="muted text-xs">Type each changing part in the Word file as a blank like {'{{counterparty_legal_name}}'}, save as .docx, then upload it.</span>
        </div>
      )}
      {error != null && <ErrorBanner error={error} />}

      {removing && (
        <ConfirmDialog
          title="Remove the Word template?"
          message="Accepted client changes will go back to being painted over the PDF. Versions already made are not touched."
          confirmLabel="Remove"
          danger
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            await api.del(`/documents/${documentId}/review-template`);
            toast.success('The Word template was removed');
            info.reload();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
