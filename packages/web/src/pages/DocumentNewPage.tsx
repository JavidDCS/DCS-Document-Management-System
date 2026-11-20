import { FileType2, Loader2, UploadCloud } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, errorMessage, fieldErrors } from '../api';
import { useAuth } from '../auth/AuthContext';
import { FilesPicker, ProgressBar } from '../components/FilePicker';
import { MetadataForm } from '../components/MetadataForm';
import { TagPicker } from '../components/TagPicker';
import { Empty, ErrorBanner, Field, PageHeader, SkeletonList, Stepper } from '../components/ui';
import { useLoad, useTitle } from '../hooks';
import { cleanMetadata, initialMetadata, validateMetadataLocal } from '../lib/metadata';
import type { DocumentDetail, DocumentTypeDto, TagDto } from '../types';

export function DocumentNewPage() {
  useTitle('Upload document');
  const nav = useNavigate();
  const { can } = useAuth();
  const types = useLoad(async () => (await api.get<DocumentTypeDto[]>('/document-types', { active: 'true' })).data, []);
  const tags = useLoad(async () => (await api.get<TagDto[]>('/tags')).data, []);

  const [typeId, setTypeId] = useState('');
  const type = useMemo(() => types.data?.find((t) => t.id === typeId) ?? null, [types.data, typeId]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [metadata, setMetadata] = useState<Record<string, unknown>>({});
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [changeNote, setChangeNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState<{ name: string; message: string }[]>([]);

  function pickType(id: string) {
    setTypeId(id);
    const t = types.data?.find((x) => x.id === id);
    setMetadata(t ? initialMetadata(t.fields) : {});
    setErrors({});
  }

  /** Name for one file: the typed name for a single file, otherwise the file name without ".pdf". */
  function nameFor(f: File, single: boolean): string {
    const typed = name.trim();
    const own = f.name.replace(/\.pdf$/i, '').trim();
    return (single && typed ? typed : own || 'Untitled').slice(0, 200);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!type || files.length === 0) return;
    const local: Record<string, string> = {};
    for (const i of validateMetadataLocal(type.fields, metadata)) local[i.path] = i.message;
    setErrors(local);
    if (Object.keys(local).length) return;

    const single = files.length === 1;
    const total = files.length;
    const meta = JSON.stringify(cleanMetadata(type.fields, metadata));
    const tagJson = JSON.stringify(tagIds);
    const left: File[] = [];
    const problems: { name: string; message: string }[] = [];
    let lastId = '';
    let stopped = false;

    setError(null);
    setFailed([]);
    for (let i = 0; i < total; i++) {
      const f = files[i]!;
      if (stopped) { left.push(f); continue; }
      setStatus(`Uploading ${i + 1} of ${total}: ${f.name}`);
      setProgress(i / total);
      const form = new FormData();
      form.append('typeId', type.id);
      form.append('name', nameFor(f, single));
      if (description.trim()) form.append('description', description.trim());
      form.append('metadata', meta);
      form.append('tagIds', tagJson);
      if (changeNote.trim()) form.append('changeNote', changeNote.trim());
      form.append('file', f, f.name);
      try {
        const r = await api.upload<DocumentDetail>('/documents', form, (p) => setProgress((i + p) / total));
        lastId = r.data.id;
      } catch (ex) {
        left.push(f);
        problems.push({ name: f.name, message: ex instanceof ApiError ? ex.message : errorMessage(ex) });
        if (ex instanceof ApiError && ex.status === 429) stopped = true; // rate limit: stop, keep the rest for a retry
        if (single) setErrors(fieldErrors(ex));
      }
    }
    setProgress(null);
    setStatus('');
    const ok = total - left.length;
    if (ok > 0) toast.success(ok === 1 ? 'Document uploaded' : `${ok} documents uploaded`, { description: 'They are being scanned and will be available shortly.' });
    if (left.length === 0) {
      nav(total === 1 ? `/documents/${lastId}` : '/documents');
      return;
    }
    setFiles(left);
    setFailed(problems);
    setError(stopped ? 'Upload limit reached. The remaining files were not sent. Wait a while, then upload them again.' : `${left.length} file${left.length === 1 ? '' : 's'} could not be uploaded. Fix the problem and try again.`);
  }

  if (types.loading) return <SkeletonList rows={4} />;
  if (types.error != null) return <ErrorBanner error={types.error} onRetry={types.reload} />;
  if (!types.data || types.data.length === 0) {
    return (
      <>
        <PageHeader title="Upload document" />
        <Empty icon={FileType2} title="No document types yet" action={can('doc_types:manage') ? <Link className="btn primary" to="/admin/document-types">Create a document type</Link> : undefined}>
          Every document belongs to a type. Create one first, then come back to upload.
        </Empty>
      </>
    );
  }

  const busy = progress !== null;
  const step = !type ? 0 : files.length === 0 ? 1 : 2;
  return (
    <>
      <PageHeader title="Upload document" description="Choose a type, describe the document, then add the PDF." />
      <Stepper steps={['Document type', 'Details', 'File']} current={step} />
      <form className="stack" onSubmit={submit} noValidate>
        {error && <ErrorBanner message={error} />}
        <div className="card stack !mb-0">
          <h2>1. Document type</h2>
          <Field label="Type" required error={errors.typeId}>
            <select value={typeId} onChange={(e) => pickType(e.target.value)} required disabled={busy}>
              <option value="">Choose a type…</option>
              {types.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          {type?.description && <p className="muted m-0 text-sm">{type.description}</p>}
        </div>

        {type && (
          <>
            <div className="card stack !mb-0">
              <h2>2. Details</h2>
              <div className="form-grid">
                {files.length > 1
                  ? <p className="muted m-0 text-sm">Each document is named after its file. Description, fields and tags below apply to all {files.length} files.</p>
                  : <Field label="Name (optional)" error={errors.name}><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Defaults to the file name" disabled={busy} /></Field>}
                <Field label="Description" error={errors.description}><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} disabled={busy} /></Field>
              </div>
              <MetadataForm fields={type.fields} values={metadata} onChange={setMetadata} errors={errors} disabled={busy} />
              <h3 className="!mb-0">Tags</h3>
              <TagPicker tags={tags.data ?? []} selected={tagIds} onChange={setTagIds} disabled={busy} />
            </div>
            <div className="card stack !mb-0">
              <h2>3. File</h2>
              <FilesPicker files={files} onChange={setFiles} maxMb={type.maxFileSizeMb} disabled={busy} />
              {errors.file && <small className="error-text text-danger font-medium" role="alert">{errors.file}</small>}
              {failed.length > 0 && (
                <ul className="m-0 list-none p-0 text-sm text-danger" role="alert">
                  {failed.map((f) => <li key={f.name}><strong>{f.name}</strong>: {f.message}</li>)}
                </ul>
              )}
              <Field label="Note about this version (optional)"><input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={500} disabled={busy} /></Field>
              <p className="muted m-0 text-sm">Each file is scanned for malware and active content before it can be sent. It stays unavailable until the scan passes.</p>
              {progress !== null && <ProgressBar value={progress} label="Upload progress" />}
              {status && <p className="muted m-0 text-sm" aria-live="polite">{status}</p>}
              <div className="row end">
                <button type="submit" className="btn primary" disabled={files.length === 0 || busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <UploadCloud className="size-4" aria-hidden="true" />}{busy ? 'Uploading…' : files.length > 1 ? `Upload ${files.length} documents` : 'Upload document'}
                </button>
              </div>
            </div>
          </>
        )}
      </form>
    </>
  );
}
