import { useState, type FormEvent } from 'react';
import { api, errorMessage, fieldErrors } from '../../api';
import { Badge, Empty, ErrorBanner, Field, Modal, PageHeader, Spinner } from '../../components/ui';
import { useLoad, useTitle } from '../../hooks';
import type { EmailTemplate } from '../../types';

const PLACEHOLDERS = ['{{recipient_name}}', '{{sender_name}}', '{{sender_email}}', '{{document_name}}', '{{document_type}}', '{{version_number}}', '{{date}}'];

export function AdminTemplatesPage() {
  useTitle('Email templates');
  const list = useLoad(async () => (await api.get<EmailTemplate[]>('/email-templates')).data, []);
  const [editing, setEditing] = useState<EmailTemplate | 'new' | null>(null);

  return (
    <>
      <PageHeader title="Email templates"><button className="btn primary" onClick={() => setEditing('new')}>New template</button></PageHeader>
      {list.loading && !list.data && <Spinner />}
      {list.error != null && <ErrorBanner error={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <Empty>No templates yet. Senders write their own subject and message until one exists.</Empty>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Subject</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name} {t.isDefault && <Badge tone="info">Default</Badge>}</td>
                  <td>{t.subject}</td>
                  <td><Badge tone={t.isActive ? 'ok' : 'neutral'}>{t.isActive ? 'Active' : 'Inactive'}</Badge></td>
                  <td className="actions"><button className="btn small" onClick={() => setEditing(t)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <TemplateForm template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </>
  );
}

function TemplateForm({ template, onClose, onSaved }: { template: EmailTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [body, setBody] = useState(template?.body ?? 'Please find attached the requested document.');
  const [isDefault, setIsDefault] = useState(template?.isDefault ?? false);
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    const payload = { name: name.trim(), subject: subject.trim(), body, isDefault, isActive };
    try {
      if (template) await api.patch(`/email-templates/${template.id}`, payload);
      else await api.post('/email-templates', payload);
      onSaved();
    } catch (ex) {
      setErrors(fieldErrors(ex));
      setError(errorMessage(ex));
      setBusy(false);
    }
  }

  return (
    <Modal title={template ? 'Edit template' : 'New template'} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        {error && <ErrorBanner message={error} />}
        <Field label="Name" required error={errors.name}><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus /></Field>
        <Field label="Subject" required error={errors.subject}><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required /></Field>
        <Field label="Message" required error={errors.body}><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} required /></Field>
        <p className="muted">Allowed placeholders: {PLACEHOLDERS.map((p) => <code key={p} className="mono"> {p}</code>)}. Anything else is rejected. Values are inserted as plain text.</p>
        <label className="check"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /><span>Use as the default template</span></label>
        <label className="check"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /><span>Active (offered to senders)</span></label>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !name || !subject || !body}>{busy ? 'Saving…' : 'Save template'}</button></div>
      </form>
    </Modal>
  );
}
