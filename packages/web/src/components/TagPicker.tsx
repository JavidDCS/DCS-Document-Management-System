import type { TagDto } from '../types';

export function TagPicker({ tags, selected, onChange, disabled }: { tags: TagDto[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  if (tags.length === 0) return <p className="muted">No tags exist yet. An administrator can create them under Tags.</p>;
  return (
    <div className="row" role="group" aria-label="Tags">
      {tags.map((t) => {
        const on = selected.includes(t.id);
        return (
          <label key={t.id} className="check tag" style={{ cursor: disabled ? 'default' : 'pointer', padding: '2px 8px' }}>
            <input type="checkbox" disabled={disabled} checked={on} onChange={() => onChange(on ? selected.filter((x) => x !== t.id) : [...selected, t.id])} />
            <span>{t.name}</span>
          </label>
        );
      })}
    </div>
  );
}
