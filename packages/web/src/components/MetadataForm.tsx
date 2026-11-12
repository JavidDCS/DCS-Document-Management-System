import { Field } from './ui';
import type { FieldDefinition } from '../types';

/** Renders one input per ACTIVE field of a document type, whatever the admin defined. */
export function MetadataForm({
  fields, values, onChange, errors, disabled,
}: { fields: FieldDefinition[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; errors: Record<string, string>; disabled?: boolean }) {
  const active = fields.filter((f) => f.isActive).sort((a, b) => a.displayOrder - b.displayOrder);
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v });
  if (active.length === 0) return <p className="muted">This document type has no extra fields.</p>;

  return (
    <div className="form-grid">
      {active.map((f) => {
        const err = errors[`metadata.${f.key}`];
        const v = values[f.key];
        const common = { disabled, 'aria-invalid': err ? true : undefined } as const;
        let control: React.ReactNode;
        switch (f.fieldType) {
          case 'TEXTAREA':
            control = <textarea {...common} value={(v as string) ?? ''} placeholder={f.placeholder ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
            break;
          case 'NUMBER':
            control = (
              <input
                {...common}
                type="number"
                inputMode="decimal"
                step={f.validation?.integerOnly ? 1 : 'any'}
                value={typeof v === 'number' ? String(v) : ''}
                placeholder={f.placeholder ?? ''}
                onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            );
            break;
          case 'DATE':
            control = <input {...common} type="date" value={(v as string) ?? ''} min={f.validation?.minDate} max={f.validation?.maxDate} onChange={(e) => set(f.key, e.target.value)} />;
            break;
          case 'BOOLEAN':
            control = (
              <span className="check">
                <input {...common} type="checkbox" checked={v === true} onChange={(e) => set(f.key, e.target.checked)} />
                <span>{f.placeholder || 'Yes'}</span>
              </span>
            );
            break;
          case 'SELECT':
            control = (
              <select {...common} value={(v as string) ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">{f.required ? 'Choose…' : '— none —'}</option>
                {(f.options ?? []).filter((o) => o.isActive).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
            break;
          case 'MULTI_SELECT': {
            const cur = Array.isArray(v) ? (v as string[]) : [];
            control = (
              <span className="stack" role="group" aria-label={f.label}>
                {(f.options ?? []).filter((o) => o.isActive).map((o) => (
                  <span className="check" key={o.value}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={cur.includes(o.value)}
                      onChange={(e) => set(f.key, e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value))}
                    />
                    <span>{o.label}</span>
                  </span>
                ))}
              </span>
            );
            break;
          }
          default:
            control = <input {...common} type="text" value={(v as string) ?? ''} placeholder={f.placeholder ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
        }
        return f.fieldType === 'MULTI_SELECT' ? (
          <fieldset key={f.key} className={err ? 'has-error' : ''}>
            <legend>{f.label}{f.required && ' *'}</legend>
            {control}
            {f.helpText && <small className="muted">{f.helpText}</small>}
            {err && <small className="error-text" role="alert">{err}</small>}
          </fieldset>
        ) : (
          <Field key={f.key} label={f.label} error={err} help={f.helpText} required={f.required}>{control}</Field>
        );
      })}
    </div>
  );
}
