import { ArrowDown, ArrowUp, CheckCircle, Eye, FileType2, Plus, Settings } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage, fieldErrors } from '../../api';
import { Badge, Empty, ErrorBanner, Field, InfoBanner, Modal, PageHeader, Spinner, Tabs } from '../../components/ui';
import { MetadataForm } from '../../components/MetadataForm';
import { gradientFor } from '../../components/Illustrations';
import { useLoad, useTitle } from '../../hooks';
import { slugifyKey } from '../../lib/metadata';
import { FIELD_TYPES, type DocumentTypeDto, type FieldDefinition, type FieldOption, type FieldType, type FieldValidation } from '../../types';

const TYPE_LABEL: Record<FieldType, string> = {
  TEXT: 'Text (single-line)',
  TEXTAREA: 'Text (multi-line)',
  NUMBER: 'Number',
  DATE: 'Date',
  BOOLEAN: 'Yes / No',
  SELECT: 'Select (single)',
  MULTI_SELECT: 'Multi-select',
};

export function AdminDocumentTypesPage() {
  useTitle('Document types');
  const nav = useNavigate();
  const list = useLoad(async () => (await api.get<DocumentTypeDto[]>('/document-types')).data, []);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Document types"
        description="Define document classification types, schemas, and metadata validation rules."
      >
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          <span>New document type</span>
        </button>
      </PageHeader>

      {list.loading && !list.data && <Spinner />}
      {list.error != null && <ErrorBanner error={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && (
        <Empty icon={FileType2} title="No document types configured">
          Document types determine the custom fields and validation required for legal uploads.
        </Empty>
      )}

      {list.data && list.data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.map((t) => {
            const active = t.fields.filter((f) => f.isActive);
            return (
              <Link
                key={t.id}
                to={`/admin/document-types/${t.id}`}
                className="group relative flex flex-col overflow-hidden rounded-2xl border bg-card no-underline shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift"
              >
                <span className="h-20 w-full" style={{ background: gradientFor(t.name) }} aria-hidden="true">
                  <span className="block h-full w-full" style={{ backgroundImage: 'radial-gradient(rgb(255 255 255 / .28) 1px, transparent 1px)', backgroundSize: '18px 18px' }} />
                </span>
                <span className="icon-chip sun absolute left-5 top-12 !size-12 !rounded-2xl ring-4 ring-card">
                  <FileType2 className="size-5" aria-hidden="true" />
                </span>
                <span className="flex flex-1 flex-col gap-3 px-5 pb-5 pt-9">
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="font-display block truncate text-[17px] font-semibold text-foreground">{t.name}</span>
                      <span className="muted mt-0.5 line-clamp-2 block min-h-[2.4em] text-xs">{t.description || 'No description yet.'}</span>
                    </span>
                    <Badge tone={t.isActive ? 'ok' : 'neutral'}>{t.isActive ? 'Active' : 'Inactive'}</Badge>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {active.slice(0, 4).map((f) => (
                      <span key={f.key} className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{f.label}</span>
                    ))}
                    {active.length > 4 && <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">+{active.length - 4} more</span>}
                    {active.length === 0 && <span className="text-[11px] text-muted-foreground">No custom fields</span>}
                  </span>
                  <span className="mt-auto flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
                    <span><strong className="text-foreground tabular-nums">{active.length}</strong> field{active.length === 1 ? '' : 's'}</span>
                    <span>Up to <strong className="text-foreground tabular-nums">{t.maxFileSizeMb} MB</strong></span>
                    <span>{t.retentionYears ? `${t.retentionYears} yr retention` : 'Kept indefinitely'}</span>
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
      {creating && <CreateTypeDialog onClose={() => setCreating(false)} onCreated={(t) => nav(`/admin/document-types/${t.id}`)} />}
    </>
  );
}

function CreateTypeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: DocumentTypeDto) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [maxMb, setMaxMb] = useState('25');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<DocumentTypeDto>('/document-types', {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        maxFileSizeMb: Number(maxMb),
      });
      onCreated(r.data);
    } catch (ex) {
      setErrors(fieldErrors(ex));
      setError(errorMessage(ex));
      setBusy(false);
    }
  }

  return (
    <Modal title="New document type" onClose={onClose}>
      <form className="stack gap-4" onSubmit={submit}>
        {error && <ErrorBanner message={error} />}
        <Field label="Name" required error={errors.name}>
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={100} autoFocus placeholder="e.g. Master Power Purchase Agreement" />
        </Field>
        <Field label="Description" error={errors.description}>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Brief summary of document purpose" />
        </Field>
        <Field label="Largest file allowed (MB)" error={errors.maxFileSizeMb} help="Maximum size for encrypted PDF uploads.">
          <input type="number" min={1} max={100} value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />
        </Field>
        <p className="muted text-xs">Custom metadata schema fields will be configured on the builder screen.</p>
        <div className="row end pt-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || name.trim().length < 2}>
            {busy ? 'Creating…' : 'Create type'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DocumentTypeBuilderPage() {
  const { id = '' } = useParams();
  const type = useLoad(async () => (await api.get<DocumentTypeDto>(`/document-types/${id}`)).data, [id]);
  const t = type.data;
  useTitle(t ? `${t.name} · Schema Builder` : 'Document type');
  const [tab, setTab] = useState<'builder' | 'preview' | 'settings'>('builder');
  const [editing, setEditing] = useState<FieldDefinition | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>({});

  if (type.loading && !t) return <Spinner />;
  if (type.error != null && !t) {
    return type.error instanceof ApiError && type.error.status === 404 ? (
      <div className="card">
        <h1>Not found</h1>
        <Link to="/admin/document-types">Back to document types</Link>
      </div>
    ) : (
      <ErrorBanner error={type.error} onRetry={type.reload} />
    );
  }
  if (!t) return null;

  const fields = [...t.fields].sort((a, b) => a.displayOrder - b.displayOrder);

  async function move(index: number, dir: -1 | 1) {
    const ids = fields.map((f) => f.id!);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    setError(null);
    try {
      type.setData((await api.put<DocumentTypeDto>(`/document-types/${t!.id}/fields/order`, { fieldIds: ids })).data);
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <PageHeader title={t.name} description={`Schema version ${t.fieldsVersion} • Key: ${t.key}`}>
        <Link className="btn" to="/admin/document-types">
          All types
        </Link>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus className="size-4" /> Add field
        </button>
      </PageHeader>

      {notice && <InfoBanner kind="ok">{notice}</InfoBanner>}
      {error != null && <ErrorBanner error={error} />}

      <div className="mb-4">
        <Tabs
          tabs={[
            { id: 'builder', label: `Fields (${fields.length})` },
            { id: 'preview', label: 'Live Form Preview' },
            { id: 'settings', label: 'Type Settings' },
          ]}
          value={tab}
          onChange={(v) => setTab(v as 'builder' | 'preview' | 'settings')}
        />
      </div>

      {tab === 'builder' && (
        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="!mb-0">Metadata Fields</h2>
              <p className="muted text-xs mt-1">
                Field order determines how fields appear during upload. Saved fields are permanent to protect audit integrity; deactivate them to hide from future uploads.
              </p>
            </div>
            <button className="btn small primary" onClick={() => setEditing('new')}>
              <Plus className="size-3.5" /> Add field
            </button>
          </div>

          {fields.length === 0 ? (
            <Empty title="No custom fields configured">
              Documents of this type will only record standard properties (name, description, tags, version). Add custom fields to capture structured metadata.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="w-20">Order</th>
                    <th>Label</th>
                    <th>Key</th>
                    <th>Type</th>
                    <th>Attributes</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f, i) => (
                    <tr key={f.id} className={f.isActive ? 'hover:bg-muted/30 transition-colors' : 'opacity-60 bg-muted/20'}>
                      <td>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className="btn ghost icon small"
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                            aria-label={`Move ${f.label} up`}
                          >
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            className="btn ghost icon small"
                            disabled={i === fields.length - 1}
                            onClick={() => move(i, 1)}
                            aria-label={`Move ${f.label} down`}
                          >
                            <ArrowDown className="size-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="font-medium text-foreground">{f.label}</td>
                      <td className="font-mono text-xs text-muted-foreground">{f.key}</td>
                      <td>
                        <span className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-xs font-medium">
                          {TYPE_LABEL[f.fieldType]}
                        </span>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {f.required && <Badge tone="info">Required</Badge>}
                          {f.searchable && <Badge tone="neutral">Searchable</Badge>}
                          {!f.isActive && <Badge tone="warn">Hidden</Badge>}
                        </div>
                      </td>
                      <td className="actions">
                        <button type="button" className="btn small" onClick={() => setEditing(f)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'preview' && (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <div>
              <h2 className="!mb-0 text-base">Uploader Form Simulation</h2>
              <p className="muted text-xs mt-0.5">
                Live interactive rendering of the upload form matching what staff will experience.
              </p>
            </div>
            <button type="button" className="btn small" onClick={() => setPreviewValues({})}>
              Clear sample inputs
            </button>
          </div>
          <div className="rounded-xl border border-border/80 bg-surface p-5">
            <MetadataForm fields={t.fields} values={previewValues} onChange={setPreviewValues} errors={{}} />
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <TypeSettings
          type={t}
          onSaved={(x) => {
            type.setData(x);
            setNotice('Settings saved.');
          }}
        />
      )}

      {editing && (
        <FieldEditor
          typeId={t.id}
          field={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(x) => {
            type.setData(x);
            setEditing(null);
            setNotice('Field saved successfully.');
          }}
        />
      )}
    </>
  );
}

function TypeSettings({ type, onSaved }: { type: DocumentTypeDto; onSaved: (t: DocumentTypeDto) => void }) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description ?? '');
  const [maxMb, setMaxMb] = useState(String(type.maxFileSizeMb));
  const [retention, setRetention] = useState(type.retentionYears === null ? '' : String(type.retentionYears));
  const [isActive, setIsActive] = useState(type.isActive);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const r = await api.patch<DocumentTypeDto>(`/document-types/${type.id}`, {
        name: name.trim(),
        description: description.trim() || null,
        maxFileSizeMb: Number(maxMb),
        retentionYears: retention === '' ? null : Number(retention),
        isActive,
      });
      onSaved(r.data);
    } catch (ex) {
      setErrors(fieldErrors(ex));
      setError(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack gap-4" onSubmit={save}>
      <h2>Type Settings</h2>
      {error && <ErrorBanner message={error} />}
      <div className="form-grid">
        <Field label="Name" required error={errors.name}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </Field>
        <Field label="Description" error={errors.description}>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <Field label="Largest file allowed (MB)" error={errors.maxFileSizeMb}>
          <input type="number" min={1} max={100} value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />
        </Field>
        <Field label="Keep for (years)" error={errors.retentionYears} help="Leave empty for indefinite retention.">
          <input type="number" min={0} max={100} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        <span>Active (allow new document uploads of this type)</span>
      </label>
      <p className="muted text-xs">
        Key: <code className="mono">{type.key}</code> (immutable). Allowed file type: PDF.
      </p>
      <div className="row end">
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

interface OptionRow extends FieldOption {
  saved: boolean;
}

function FieldEditor({
  typeId,
  field,
  onClose,
  onSaved,
}: {
  typeId: string;
  field: FieldDefinition | null;
  onClose: () => void;
  onSaved: (t: DocumentTypeDto) => void;
}) {
  const existing = field !== null;
  const [label, setLabel] = useState(field?.label ?? '');
  const [key, setKey] = useState(field?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(false);
  const [fieldType, setFieldType] = useState<FieldType>(field?.fieldType ?? 'TEXT');
  const [required, setRequired] = useState(field?.required ?? false);
  const [searchable, setSearchable] = useState(field?.searchable ?? false);
  const [isActive, setIsActive] = useState(field?.isActive ?? true);
  const [helpText, setHelpText] = useState(field?.helpText ?? '');
  const [placeholder, setPlaceholder] = useState(field?.placeholder ?? '');
  const [options, setOptions] = useState<OptionRow[]>((field?.options ?? []).map((o) => ({ ...o, saved: true })));
  const v0 = field?.validation ?? {};
  const [minLength, setMinLength] = useState(v0.minLength?.toString() ?? '');
  const [maxLength, setMaxLength] = useState(v0.maxLength?.toString() ?? '');
  const [pattern, setPattern] = useState(v0.pattern ?? '');
  const [min, setMin] = useState(v0.min?.toString() ?? '');
  const [max, setMax] = useState(v0.max?.toString() ?? '');
  const [integerOnly, setIntegerOnly] = useState(v0.integerOnly ?? false);
  const [minDate, setMinDate] = useState(v0.minDate ?? '');
  const [maxDate, setMaxDate] = useState(v0.maxDate ?? '');
  const [def, setDef] = useState<unknown>(field?.defaultValue ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSelect = fieldType === 'SELECT' || fieldType === 'MULTI_SELECT';
  const isText = fieldType === 'TEXT' || fieldType === 'TEXTAREA';

  function validation(): FieldValidation | null {
    const v: FieldValidation = {};
    const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
    if (isText) {
      if (num(minLength) !== undefined) v.minLength = num(minLength)!;
      if (num(maxLength) !== undefined) v.maxLength = num(maxLength)!;
      if (pattern.trim()) v.pattern = pattern.trim();
    } else if (fieldType === 'NUMBER') {
      if (num(min) !== undefined) v.min = num(min)!;
      if (num(max) !== undefined) v.max = num(max)!;
      if (integerOnly) v.integerOnly = true;
    } else if (fieldType === 'DATE') {
      if (minDate) v.minDate = minDate;
      if (maxDate) v.maxDate = maxDate;
    }
    return Object.keys(v).length ? v : null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    const opts = isSelect ? options.map((o) => ({ value: o.value.trim(), label: o.label.trim(), isActive: o.isActive })) : null;
    const defaultValue = def === '' || def === undefined ? null : def;
    try {
      let r;
      if (existing) {
        r = await api.patch<DocumentTypeDto>(`/document-types/${typeId}/fields/${field.id}`, {
          label: label.trim(),
          required,
          searchable,
          isActive,
          helpText: helpText.trim() || null,
          placeholder: placeholder.trim() || null,
          options: opts,
          validation: validation(),
          defaultValue,
          ...(fieldType !== field.fieldType ? { fieldType } : {}),
        });
      } else {
        r = await api.post<DocumentTypeDto>(`/document-types/${typeId}/fields`, {
          key: key.trim(),
          fieldType,
          label: label.trim(),
          required,
          searchable,
          ...(helpText.trim() ? { helpText: helpText.trim() } : {}),
          ...(placeholder.trim() ? { placeholder: placeholder.trim() } : {}),
          ...(opts ? { options: opts } : {}),
          ...(validation() ? { validation: validation() } : {}),
          ...(defaultValue !== null ? { defaultValue } : {}),
        });
      }
      onSaved(r.data);
    } catch (ex) {
      setErrors(fieldErrors(ex));
      setError(errorMessage(ex));
      setBusy(false);
    }
  }

  const activeOpts = options.filter((o) => o.isActive && o.value.trim());

  return (
    <Modal title={existing ? `Edit Field: ${field.label}` : 'Add Custom Field'} onClose={onClose} wide>
      <form className="stack gap-4" onSubmit={submit}>
        {error && <ErrorBanner message={error} />}
        <div className="form-grid">
          <Field label="Label" required error={errors.label} help="Display name shown next to input.">
            <input
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (!existing && !keyTouched) setKey(slugifyKey(e.target.value));
              }}
              maxLength={100}
              required
              autoFocus
            />
          </Field>
          <Field label="Key" required error={errors.key} help={existing ? 'Immutable once created.' : 'Lower-case letters, digits, and underscores.'}>
            <input className="mono" value={key} onChange={(e) => { setKey(e.target.value); setKeyTouched(true); }} readOnly={existing} maxLength={50} required />
          </Field>
          <Field label="Field Type" required error={errors.fieldType} help={existing ? 'Cannot change if documents exist.' : undefined}>
            <select value={fieldType} onChange={(e) => { setFieldType(e.target.value as FieldType); setDef(null); }}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Placeholder" error={errors.placeholder}>
            <input value={placeholder} onChange={(e) => setPlaceholder(e.target.value)} maxLength={100} />
          </Field>
        </div>
        <Field label="Help text" error={errors.helpText}>
          <input value={helpText} onChange={(e) => setHelpText(e.target.value)} maxLength={300} placeholder="Instructions for document uploaders" />
        </Field>
        <div className="row gap-4">
          <label className="check">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
            <span>Required</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={searchable} onChange={(e) => setSearchable(e.target.checked)} />
            <span>Searchable</span>
          </label>
          {existing && (
            <label className="check">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              <span>Visible in upload forms</span>
            </label>
          )}
        </div>

        {isSelect && (
          <fieldset>
            <legend>Option Values</legend>
            {errors.options && <small className="error-text" role="alert">{errors.options}</small>}
            <div className="stack gap-2">
              {options.map((o, i) => (
                <div className="row gap-2" key={i}>
                  <input
                    aria-label={`Option ${i + 1} label`}
                    placeholder="Label"
                    value={o.label}
                    onChange={(e) =>
                      setOptions(
                        options.map((x, j) =>
                          j === i ? { ...x, label: e.target.value, ...(x.saved ? {} : { value: slugifyKey(e.target.value) || x.value }) } : x
                        )
                      )
                    }
                    style={{ flex: 2, minWidth: 140 }}
                  />
                  <input
                    aria-label={`Option ${i + 1} value`}
                    className="mono"
                    placeholder="value"
                    value={o.value}
                    readOnly={o.saved}
                    onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    style={{ flex: 1, minWidth: 100 }}
                  />
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={o.isActive}
                      onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, isActive: e.target.checked } : x)))}
                    />
                    <span>Active</span>
                  </label>
                  {!o.saved && (
                    <button type="button" className="btn small" onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label={`Remove option ${i + 1}`}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <div>
                <button type="button" className="btn small" onClick={() => setOptions([...options, { value: '', label: '', isActive: true, saved: false }])}>
                  <Plus className="size-3.5" /> Add option
                </button>
              </div>
              {existing && <small className="muted text-xs">Saved options cannot be deleted to preserve existing documents; uncheck Active to hide.</small>}
            </div>
          </fieldset>
        )}

        {isText && (
          <fieldset>
            <legend>Text Validation Rules</legend>
            <div className="form-grid">
              <Field label="Minimum characters" error={errors.minLength}>
                <input type="number" min={0} value={minLength} onChange={(e) => setMinLength(e.target.value)} />
              </Field>
              <Field label="Maximum characters" error={errors.maxLength}>
                <input type="number" min={1} value={maxLength} onChange={(e) => setMaxLength(e.target.value)} />
              </Field>
              <Field label="Regex pattern" error={errors.pattern} help="e.g. ^DCS-[0-9]{4}$">
                <input className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
              </Field>
            </div>
          </fieldset>
        )}

        {fieldType === 'NUMBER' && (
          <fieldset>
            <legend>Numeric Validation Rules</legend>
            <div className="form-grid">
              <Field label="Minimum value" error={errors.min}>
                <input type="number" step="any" value={min} onChange={(e) => setMin(e.target.value)} />
              </Field>
              <Field label="Maximum value" error={errors.max}>
                <input type="number" step="any" value={max} onChange={(e) => setMax(e.target.value)} />
              </Field>
            </div>
            <label className="check mt-2">
              <input type="checkbox" checked={integerOnly} onChange={(e) => setIntegerOnly(e.target.checked)} />
              <span>Whole integers only</span>
            </label>
          </fieldset>
        )}

        {fieldType === 'DATE' && (
          <fieldset>
            <legend>Date Range Rules</legend>
            <div className="form-grid">
              <Field label="Earliest allowed date" error={errors.minDate}>
                <input type="date" value={minDate} onChange={(e) => setMinDate(e.target.value)} />
              </Field>
              <Field label="Latest allowed date" error={errors.maxDate}>
                <input type="date" value={maxDate} onChange={(e) => setMaxDate(e.target.value)} />
              </Field>
            </div>
          </fieldset>
        )}

        <fieldset>
          <legend>Default Value (Optional)</legend>
          {errors.defaultValue && <small className="error-text" role="alert">{errors.defaultValue}</small>}
          {isText && <input aria-label="Default value" value={(def as string) ?? ''} onChange={(e) => setDef(e.target.value)} />}
          {fieldType === 'NUMBER' && (
            <input
              aria-label="Default value"
              type="number"
              step="any"
              value={typeof def === 'number' ? def : ''}
              onChange={(e) => setDef(e.target.value === '' ? null : Number(e.target.value))}
            />
          )}
          {fieldType === 'DATE' && <input aria-label="Default value" type="date" value={(def as string) ?? ''} onChange={(e) => setDef(e.target.value || null)} />}
          {fieldType === 'BOOLEAN' && (
            <select aria-label="Default value" value={def === true ? 'true' : def === false ? 'false' : ''} onChange={(e) => setDef(e.target.value === '' ? null : e.target.value === 'true')}>
              <option value="">No default</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          )}
          {fieldType === 'SELECT' && (
            <select aria-label="Default value" value={(def as string) ?? ''} onChange={(e) => setDef(e.target.value || null)}>
              <option value="">No default</option>
              {activeOpts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label || o.value}
                </option>
              ))}
            </select>
          )}
          {fieldType === 'MULTI_SELECT' && (
            <div className="stack gap-1.5">
              {activeOpts.map((o) => {
                const cur = Array.isArray(def) ? (def as string[]) : [];
                return (
                  <label className="check" key={o.value}>
                    <input
                      type="checkbox"
                      checked={cur.includes(o.value)}
                      onChange={(e) => {
                        const n = e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value);
                        setDef(n.length ? n : null);
                      }}
                    />
                    <span>{o.label || o.value}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>

        <div className="row end pt-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !label.trim() || !key.trim()}>
            {busy ? 'Saving…' : 'Save field'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
