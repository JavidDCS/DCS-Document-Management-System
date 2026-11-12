import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api';
import { ConfirmDialog, Empty, ErrorBanner, PageHeader, Spinner } from '../../components/ui';
import { useLoad, useTitle } from '../../hooks';
import type { TagDto } from '../../types';

export function AdminTagsPage() {
  useTitle('Tags');
  const tags = useLoad(async () => (await api.get<TagDto[]>('/tags')).data, []);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<TagDto | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/tags', { name });
      setName('');
      tags.reload();
    } catch (ex) {
      setError(errorMessage(ex));
    }
  }

  async function rename() {
    if (!editing) return;
    setError(null);
    try {
      await api.patch(`/tags/${editing.id}`, { name: editing.name });
      setEditing(null);
      tags.reload();
    } catch (ex) {
      setError(errorMessage(ex));
    }
  }

  return (
    <>
      <PageHeader title="Tags" />
      {error && <ErrorBanner message={error} />}
      <form className="card row" onSubmit={add}>
        <label className="sr-only" htmlFor="tag-name">New tag name</label>
        <input id="tag-name" style={{ flex: 1, minWidth: 200 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag name" maxLength={50} />
        <button className="btn primary" disabled={!name.trim()}>Add tag</button>
      </form>
      {tags.loading && !tags.data && <Spinner />}
      {tags.error != null && <ErrorBanner error={tags.error} onRetry={tags.reload} />}
      {tags.data && tags.data.length === 0 && <Empty>No tags yet.</Empty>}
      {tags.data && tags.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th /></tr></thead>
            <tbody>
              {tags.data.map((t) => (
                <tr key={t.id}>
                  <td>
                    {editing?.id === t.id ? (
                      <input aria-label={`Rename ${t.name}`} value={editing.name} onChange={(e) => setEditing({ id: t.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setEditing(null); }} autoFocus />
                    ) : t.name}
                  </td>
                  <td className="actions">
                    {editing?.id === t.id ? (
                      <><button className="btn small primary" onClick={rename}>Save</button> <button className="btn small" onClick={() => setEditing(null)}>Cancel</button></>
                    ) : (
                      <><button className="btn small" onClick={() => setEditing({ id: t.id, name: t.name })}>Rename</button> <button className="btn small danger" onClick={() => setDeleting(t)}>Delete</button></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deleting && (
        <ConfirmDialog title={`Delete tag “${deleting.name}”?`} message="It is removed from every document that uses it." confirmLabel="Delete" danger onClose={() => setDeleting(null)} onConfirm={async () => { await api.del(`/tags/${deleting.id}`); tags.reload(); }} />
      )}
    </>
  );
}
