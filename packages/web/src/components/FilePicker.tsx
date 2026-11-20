import { CheckCircle2, FileText, UploadCloud, X, AlertCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { fmtSize } from '../lib/format';
import { cn } from '../lib/cn';

/** Client-side checks are a courtesy; the API re-checks extension, type, magic bytes, size and scans the file. */
export function checkPdf(file: File, maxMb: number): string | null {
  if (!/\.pdf$/i.test(file.name)) return 'Only PDF files are accepted.';
  if (file.type && file.type !== 'application/pdf') return 'Only PDF files are accepted.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > maxMb * 1024 * 1024) return `The file is larger than ${maxMb} MB.`;
  return null;
}

export function FilePicker({
  file,
  onPick,
  maxMb,
  error,
}: {
  file: File | null;
  onPick: (f: File | null) => void;
  maxMb: number;
  error?: string | null | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [local, setLocal] = useState<string | null>(null);

  function take(f: File | undefined | null) {
    if (!f) return;
    const problem = checkPdf(f, maxMb);
    setLocal(problem);
    onPick(problem ? null : f);
  }

  const msg = local ?? error;

  return (
    <div className="field">
      <span className="font-medium text-foreground">PDF Document</span>
      <div
        className={cn(
          'dropzone transition-all duration-200 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer',
          over ? 'border-primary bg-primary-soft/30 scale-[1.01]' : 'border-border/80 bg-card hover:border-primary/50 hover:bg-muted/30',
          file && 'border-success/40 bg-success/5'
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files[0]);
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).tagName !== 'BUTTON') {
            input.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.current?.click();
          }
        }}
        aria-label="Upload PDF file"
      >
        {file ? (
          <div className="flex flex-col items-center gap-3">
            <div className="grid size-12 place-items-center rounded-xl bg-success/15 text-success">
              <CheckCircle2 className="size-6" aria-hidden="true" />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 shadow-2xs">
              <FileText className="size-4 text-primary shrink-0" aria-hidden="true" />
              <strong className="text-sm font-medium text-foreground max-w-xs truncate">{file.name}</strong>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">({fmtSize(file.size)})</span>
              <button
                type="button"
                className="btn ghost icon small ml-1 text-muted-foreground hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(null);
                }}
                aria-label="Remove selected file"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <p className="m-0 text-xs text-muted-foreground">Click or drag another file to replace</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2.5">
            <div className="grid size-12 place-items-center rounded-xl bg-primary-soft text-primary transition-transform duration-200 group-hover:scale-105">
              <UploadCloud className="size-6" aria-hidden="true" />
            </div>
            <p className="m-0 text-sm font-medium text-foreground">
              <strong>Drag & drop a PDF here</strong> or click to browse
            </p>
            <p className="m-0 text-xs text-muted-foreground">
              Maximum allowed size: <span className="font-semibold">{maxMb} MB</span>. File will be encrypted with AES-256-GCM.
            </p>
          </div>
        )}
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = '';
          }}
          aria-label="PDF file"
        />
      </div>
      {msg && (
        <small className="error-text flex items-center gap-1.5 mt-1 text-danger font-medium" role="alert">
          <AlertCircle className="size-3.5 shrink-0" />
          {msg}
        </small>
      )}
    </div>
  );
}

/** Multi-file variant: any number of PDFs, each checked on its own; invalid ones are reported and skipped. */
export function FilesPicker({
  files,
  onChange,
  maxMb,
  disabled,
}: {
  files: File[];
  onChange: (f: File[]) => void;
  maxMb: number;
  disabled?: boolean | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);

  function take(list: FileList | null | undefined) {
    if (!list || list.length === 0) return;
    const next = [...files];
    const bad: string[] = [];
    for (const f of Array.from(list)) {
      const problem = checkPdf(f, maxMb);
      if (problem) bad.push(`${f.name}: ${problem}`);
      else if (!next.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) next.push(f);
    }
    setSkipped(bad);
    onChange(next);
  }

  return (
    <div className="field">
      <span className="font-medium text-foreground">PDF Documents</span>
      <div
        className={cn(
          'dropzone transition-all duration-200 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer',
          over ? 'border-primary bg-primary-soft/30 scale-[1.01]' : 'border-border/80 bg-card hover:border-primary/50 hover:bg-muted/30',
          disabled && 'pointer-events-none opacity-60',
        )}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
        aria-label="Upload PDF files"
      >
        <div className="flex flex-col items-center gap-2.5">
          <div className="grid size-12 place-items-center rounded-xl bg-primary-soft text-primary">
            <UploadCloud className="size-6" aria-hidden="true" />
          </div>
          <p className="m-0 text-sm font-medium text-foreground">
            <strong>Drag & drop PDFs here</strong> or click to browse. Select as many as you need.
          </p>
          <p className="m-0 text-xs text-muted-foreground">
            Maximum per file: <span className="font-semibold">{maxMb} MB</span>. Each file is encrypted with AES-256-GCM.
          </p>
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => { take(e.target.files); e.target.value = ''; }}
          aria-label="PDF files"
        />
      </div>
      {skipped.length > 0 && (
        <small className="error-text mt-1 block text-danger font-medium" role="alert">
          {skipped.map((s) => <span key={s} className="flex items-center gap-1.5"><AlertCircle className="size-3.5 shrink-0" />{s}</span>)}
        </small>
      )}
      {files.length > 0 && (
        <ul className="stack gap-1.5 m-0 mt-2 list-none p-0">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${f.lastModified}`} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 shadow-2xs">
              <FileText className="size-4 text-primary shrink-0" aria-hidden="true" />
              <strong className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{f.name}</strong>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{fmtSize(f.size)}</span>
              <button type="button" className="btn ghost icon small text-muted-foreground hover:text-danger" disabled={disabled} onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="stack gap-1.5">
      <div className="progress h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full bg-primary transition-all duration-300 ease-out" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{pct < 100 ? 'Uploading encrypted chunks…' : 'Upload finished. Security scanner analyzing…'}</span>
        <span className="font-mono tabular-nums font-semibold text-foreground">{pct}%</span>
      </div>
    </div>
  );
}
