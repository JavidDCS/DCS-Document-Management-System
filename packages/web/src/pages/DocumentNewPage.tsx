import { FileType2, Loader2, UploadCloud } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, errorMessage, fieldErrors } from '../api';
import { useAuth } from '../auth/AuthContext';
import { FilePicker, ProgressBar } from '../components/FilePicker';
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
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  function pickType(id: string) {
    setTypeId(id);
    const t = types.data?.find((x) => x.id === id);
    setMetadata(t ? initialMetadata(t.fields) : {});
    setErrors({});
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!type || !file) return;
    const local: Record<string, string> = {};
    if (name.trim().length < 1) local.name = 'Enter a name';
    for (const i of validateMetadataLocal(type.fields, metadata)) local[i.path] = i.message;
    setErrors(local);
    if (Object.keys(local).length) return;

    const form = new FormData();
    form.append('typeId', type.id);
    form.append('name', name.trim());
    if (description.trim()) form.append('description', description.trim());
    form.append('metadata', JSON.stringify(cleanMetadata(type.fields, metadata)));
    form.append('tagIds', JSON.stringify(tagIds));
    if (changeNote.trim()) form.append('changeNote', changeNote.trim());
    form.append('file', file, file.name);

    setError(null);
    setProgress(0);
    try {
      const r = await api.upload<DocumentDetail>('/documents', form, setProgress);
      toast.success('Document uploaded', { description: 'It is being scanned and will be available shortly.' });
      nav(`/documents/${r.data.id}`);
    } catch (ex) {
      setProgress(null);
      setErrors(fieldErrors(ex));
      setError(ex instanceof ApiError ? ex.message : errorMessage(ex));
    }
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
  const step = !type ? 0 : !file ? 1 : 2;
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
                <Field label="Name" required error={errors.name}><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} disabled={busy} /></Field>
                <Field label="Description" error={errors.description}><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} disabled={busy} /></Field>
              </div>
              <MetadataForm fields={type.fields} values={metadata} onChange={setMetadata} errors={errors} disabled={busy} />
              <h3 className="!mb-0">Tags</h3>
              <TagPicker tags={tags.data ?? []} selected={tagIds} onChange={setTagIds} disabled={busy} />
            </div>
            <div className="card stack !mb-0">
              <h2>3. File</h2>
              <FilePicker file={file} onPick={(f) => { setFile(f); if (f && !name) setName(f.name.replace(/\.pdf$/i, '')); }} maxMb={type.maxFileSizeMb} error={errors.file} />
              <Field label="Note about this version (optional)"><input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={500} disabled={busy} /></Field>
              <p className="muted m-0 text-sm">The file is scanned for malware and active content before it can be sent. It stays unavailable until the scan passes.</p>
              {progress !== null && <ProgressBar value={progress} label="Upload progress" />}
              <div className="row end">
                <button type="submit" className="btn primary" disabled={!file || busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <UploadCloud className="size-4" aria-hidden="true" />}{busy ? 'Uploading…' : 'Upload document'}
                </button>
              </div>
            </div>
          </>
        )}
      </form>
    </>
  );
}
