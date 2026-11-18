import type { SignatureAssetDto } from '@dcs-docs/shared';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '../../api';
import { Badge, Empty, ErrorBanner, InfoBanner, PageHeader, Spinner } from '../../components/ui';
import { useLoad, useTitle } from '../../hooks';
import { fmtDateTime } from '../../lib/format';

/** Where the signature lands when the form is left alone: one inch in from the bottom-left corner of page 1. */
const DEFAULTS = { pageNumber: '1', xPt: '72', yPt: '72', widthPt: '150', heightPt: '60' };

/**
 * The pre-approved signature that staff stamp onto a document as the last step of a client review. An administrator
 * uploads the signer's JPG once (the signer signs on a sheet, it is photographed or scanned) and says where it goes
 * on the page; reviewers then add it with one click. The image is encrypted at rest like any document.
 */
export function AdminSignaturesPage() {
  useTitle('Signature');
  const assets = useLoad(async () => (await api.get<SignatureAssetDto[]>('/signature-assets')).data, []);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [pos, setPos] = useState(DEFAULTS);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.append('label', label.trim());
    form.append('pageNumber', pos.pageNumber);
    form.append('xPt', pos.xPt);
    form.append('yPt', pos.yPt);
    form.append('widthPt', pos.widthPt);
    form.append('heightPt', pos.heightPt);
    // The file goes last: the server reads the text fields before it reaches the file part.
    form.append('file', file, file.name);
    setError(null);
    setProgress(0);
    try {
      const created = await api.upload<SignatureAssetDto>('/signature-assets', form, setProgress);
      // The first signature becomes the default on its own, so "Add signature" works straight away.
      if (!(assets.data ?? []).some((a) => a.isDefault && a.isActive)) await api.post(`/signature-assets/${created.data.id}/set-default`);
      toast.success('Signature uploaded');
      setFile(null);
      setLabel('');
      setPos(DEFAULTS);
      assets.reload();
    } catch (ex) {
      setError(errorMessage(ex));
    } finally {
      setProgress(null);
    }
  }

  async function act(id: string, action: 'set-default' | 'deactivate') {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/signature-assets/${id}/${action}`);
      assets.reload();
    } catch (ex) {
      setError(errorMessage(ex));
    } finally {
      setBusyId(null);
    }
  }

  const num = (key: keyof typeof DEFAULTS, label: string, hint?: string) => (
    <label className="field" key={key}>
      <span>{label}</span>
      <input type="number" min={key === 'pageNumber' ? 1 : 0} step="any" required value={pos[key]} onChange={(e) => setPos((p) => ({ ...p, [key]: e.target.value }))} title={hint} />
    </label>
  );

  const valid = Boolean(file) && label.trim().length > 0 && Object.values(pos).every((v) => v !== '' && Number(v) >= 0) && Number(pos.pageNumber) >= 1 && Number(pos.widthPt) > 0 && Number(pos.heightPt) > 0;

  return (
    <>
      <PageHeader title="Signature" />
      <InfoBanner>
        This is the signature reviewers stamp onto a document as the final step before it goes back to the client. Upload it as a JPG. Positions are in points
        measured from the <strong>bottom-left</strong> corner of the page (72 points = 1 inch; an A4 page is about 595 × 842).
      </InfoBanner>

      {error && <ErrorBanner message={error} />}

      <form className="card stack" onSubmit={upload}>
        <h2 className="!mb-0">Upload a signature</h2>
        <label className="field">
          <span>Signature image (JPG)</span>
          <input type="file" accept="image/jpeg,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="field">
          <span>Name for this signature</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="e.g. Authorised signatory" />
        </label>
        <div className="grid gap-3 sm:grid-cols-5">
          {num('pageNumber', 'Page', 'Which page of the document to stamp')}
          {num('xPt', 'From left (pt)')}
          {num('yPt', 'From bottom (pt)')}
          {num('widthPt', 'Width (pt)')}
          {num('heightPt', 'Height (pt)')}
        </div>
        {progress !== null && <div className="muted text-xs">Uploading… {Math.round(progress * 100)}%</div>}
        <div className="row end">
          <button className="btn primary" disabled={!valid || progress !== null}>Upload signature</button>
        </div>
      </form>

      {assets.loading && !assets.data && <Spinner />}
      {assets.error != null && <ErrorBanner error={assets.error} onRetry={assets.reload} />}
      {assets.data && assets.data.length === 0 && <Empty>No signature uploaded yet. Reviewers cannot add one until you upload it.</Empty>}
      {assets.data && assets.data.length > 0 && (
        <div className="card stack">
          <h2 className="!mb-0">Uploaded signatures</h2>
          {assets.data.map((a) => (
            <div key={a.id} className="row items-center gap-3 text-sm">
              <strong>{a.label}</strong>
              {a.isDefault && a.isActive && <Badge tone="ok">In use</Badge>}
              {!a.isActive && <Badge tone="neutral">Switched off</Badge>}
              <span className="muted text-xs">
                page {a.pageNumber} · {a.xPt}, {a.yPt} pt · {a.widthPt} × {a.heightPt} pt · {fmtDateTime(a.createdAt)}
              </span>
              <span className="row gap-2" style={{ marginLeft: 'auto' }}>
                {a.isActive && !a.isDefault && <button type="button" className="btn small" disabled={busyId === a.id} onClick={() => act(a.id, 'set-default')}>Use this one</button>}
                {a.isActive && <button type="button" className="btn small" disabled={busyId === a.id} onClick={() => act(a.id, 'deactivate')}>Switch off</button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
