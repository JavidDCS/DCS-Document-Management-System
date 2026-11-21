import { ArrowRightLeft, FolderPlus, Layers } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '../api';
import { ErrorBanner, Field, Modal, Spinner } from './ui';
import { useLoad } from '../hooks';
import type { DocumentTypeDto } from '../types';

export interface MoveTypeModalProps {
  documentId: string;
  documentName: string;
  currentTypeId: string;
  currentTypeName?: string;
  onClose: () => void;
  onMoved: (targetType: DocumentTypeDto) => void;
}

export function MoveTypeModal({
  documentId,
  documentName,
  currentTypeId,
  currentTypeName,
  onClose,
  onMoved,
}: MoveTypeModalProps) {
  const types = useLoad(async () => (await api.get<DocumentTypeDto[]>('/document-types')).data, []);
  const [mode, setMode] = useState<'select' | 'create'>('select');
  const [selectedTypeId, setSelectedTypeId] = useState<string>('');
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeDescription, setNewTypeDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-pick first non-current type when types load
  const availableTypes = types.data?.filter((t) => t.id !== currentTypeId) ?? [];
  const effectiveSelectedId = selectedTypeId || (availableTypes.length > 0 ? availableTypes[0]!.id : '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      let targetType: DocumentTypeDto;

      if (mode === 'create') {
        const trimmed = newTypeName.trim();
        if (!trimmed) {
          setError('Enter a document type name.');
          setBusy(false);
          return;
        }
        const createRes = await api.post<DocumentTypeDto>('/document-types', {
          name: trimmed,
          description: newTypeDescription.trim() || undefined,
          maxFileSizeMb: 25,
        });
        targetType = createRes.data;
      } else {
        if (!effectiveSelectedId) {
          setError('Select a target document type.');
          setBusy(false);
          return;
        }
        targetType = types.data!.find((t) => t.id === effectiveSelectedId)!;
      }

      await api.patch(`/documents/${documentId}`, {
        documentTypeId: targetType.id,
      });

      toast.success(`Moved "${documentName}" to "${targetType.name}"`);
      onMoved(targetType);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Move to another document type" onClose={onClose}>
      <form onSubmit={submit} className="stack gap-4">
        {error && <ErrorBanner message={error} />}

        <div className="rounded-lg border bg-muted/40 p-3 text-xs">
          <div className="muted">Document:</div>
          <div className="font-semibold text-foreground truncate mt-0.5">{documentName}</div>
          <div className="muted mt-2">Current type:</div>
          <div className="font-medium text-foreground">{currentTypeName ?? 'Assigned type'}</div>
        </div>

        <div className="flex rounded-lg border bg-muted p-1 text-xs">
          <button
            type="button"
            className={`flex-1 rounded-md py-1.5 font-medium transition-all ${
              mode === 'select' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('select')}
          >
            <Layers className="inline mr-1.5 size-3.5" />
            Existing type
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md py-1.5 font-medium transition-all ${
              mode === 'create' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('create')}
          >
            <FolderPlus className="inline mr-1.5 size-3.5" />
            + Create new type
          </button>
        </div>

        {types.loading && !types.data && <Spinner label="Loading types…" />}

        {mode === 'select' && types.data && (
          <div className="stack gap-3">
            <Field label="Target document type" required>
              <select
                value={effectiveSelectedId}
                onChange={(e) => {
                  if (e.target.value === '__CREATE__') {
                    setMode('create');
                  } else {
                    setSelectedTypeId(e.target.value);
                  }
                }}
              >
                {types.data.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.id === currentTypeId}>
                    {t.name} {t.id === currentTypeId ? '(current)' : ''}
                  </option>
                ))}
                <option value="__CREATE__">+ Create new document type…</option>
              </select>
            </Field>
            <p className="muted text-xs">
              Moving will update the category classification of this document. Any metadata fields not matching the new type will be cleanly discarded.
            </p>
          </div>
        )}

        {mode === 'create' && (
          <div className="stack gap-3">
            <Field label="New type name" required>
              <input
                value={newTypeName}
                onChange={(e) => setNewTypeName(e.target.value)}
                placeholder="e.g. Referral Agreement, Engagement Letter"
                autoFocus
                required
                maxLength={100}
              />
            </Field>
            <Field label="Description (optional)">
              <input
                value={newTypeDescription}
                onChange={(e) => setNewTypeDescription(e.target.value)}
                placeholder="Brief summary of document purpose"
                maxLength={500}
              />
            </Field>
            <p className="muted text-xs">
              A new document type will be created instantly and this document will be moved into it.
            </p>
          </div>
        )}

        <div className="row end pt-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={
              busy ||
              types.loading ||
              (mode === 'select' && (!effectiveSelectedId || effectiveSelectedId === currentTypeId)) ||
              (mode === 'create' && !newTypeName.trim())
            }
          >
            {busy ? (
              'Moving…'
            ) : mode === 'create' ? (
              <>
                <FolderPlus className="size-4" />
                Create & move
              </>
            ) : (
              <>
                <ArrowRightLeft className="size-4" />
                Move document
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
