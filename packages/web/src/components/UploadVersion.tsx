import { Upload } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import type { DocumentDetail } from '../types';
import { FilePicker, ProgressBar } from './FilePicker';
import { ConfirmDialog } from './ui';

/** Uploads a file as the document's next version -- used both on the Versions tab and wherever an externally
 * edited file (e.g. from Stirling-PDF) needs to come back in as the current version. Picking a file never
 * changes anything by itself; "Upload version" only starts the actual upload after the confirmation below. */
export function UploadVersion({ doc, onDone }: { doc: DocumentDetail; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function go() {
    if (!file) return;
    const form = new FormData();
    form.append('file', file, file.name);
    if (note.trim()) form.append('changeNote', note.trim());
    setProgress(0);
    try {
      await api.upload(`/documents/${doc.id}/versions`, form, setProgress);
      onDone();
    } catch (e) {
      setProgress(null);
      throw e;
    }
  }

  return (
    <div className="stack mb-5 rounded-xl border bg-muted/30 p-4">
      <FilePicker file={file} onPick={setFile} maxMb={doc.type.maxFileSizeMb} />
      <label className="field"><span>Note about this version (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
      {progress !== null && <ProgressBar value={progress} label="Upload progress" />}
      <div className="row end"><button className="btn primary" disabled={!file || progress !== null} onClick={() => setConfirming(true)}><Upload className="size-4" />Upload version</button></div>
      {confirming && (
        <ConfirmDialog
          title="Replace the current version?"
          message={`"${file?.name}" becomes the current version. Nothing changes until you confirm.`}
          confirmLabel="Upload"
          onClose={() => setConfirming(false)}
          onConfirm={go}
        />
      )}
    </div>
  );
}
