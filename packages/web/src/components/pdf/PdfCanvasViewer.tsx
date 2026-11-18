import type { ReviewCommentDto } from '@dcs-docs/shared';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { ErrorBanner, Spinner, cn } from '../ui';
import './pdfWorker';
import { clickToPct, pctToStyle } from './pinMath';

export interface PlacedPin {
  pageNumber: number;
  xPct: number;
  yPct: number;
}

export interface PdfCanvasViewerProps {
  /** URL (http(s) or blob:) of the PDF bytes to render. */
  fileUrl: string;
  comments: ReviewCommentDto[];
  /** Omit to render read-only (staff review): pins are selectable but new ones cannot be placed. */
  onPlacePin?: (pos: PlacedPin) => void;
  selectedCommentId?: string | null;
  onSelectComment?: (id: string) => void;
}

const STATUS_DOT: Record<ReviewCommentDto['status'], string> = {
  OPEN: 'border-amber-600 bg-amber-400',
  ACCEPTED: 'border-emerald-600 bg-emerald-400',
  DISMISSED: 'border-slate-400 bg-slate-300 opacity-60',
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

/** Renders one PDF page at a time to a canvas, with an overlay for comment pins. Not continuous scroll. */
export function PdfCanvasViewer({ fileUrl, comments, onPlacePin, selectedCommentId, onSelectComment }: PdfCanvasViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTokenRef = useRef(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setDoc(null);
    pdfjsLib
      .getDocument({ url: fileUrl })
      .promise.then((d) => {
        if (!alive) return;
        setDoc(d);
        setPageCount(d.numPages);
        setPage(1);
      })
      .catch(() => {
        if (alive) {
          setError('This PDF could not be displayed. It may be corrupted or still processing.');
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [fileUrl]);

  useEffect(() => {
    if (!doc) return;
    const token = ++renderTokenRef.current;
    let cancelled = false;
    setLoading(true);
    doc
      .getPage(page)
      .then(async (p) => {
        const viewport = p.getViewport({ scale });
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx || cancelled || renderTokenRef.current !== token) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await p.render({ canvasContext: ctx, viewport, canvas }).promise;
        if (cancelled || renderTokenRef.current !== token) return;
        setSize({ width: viewport.width, height: viewport.height });
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError('This page could not be rendered.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [doc, page, scale]);

  const handleOverlayClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onPlacePin) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const { xPct, yPct } = clickToPct(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
      onPlacePin({ pageNumber: page, xPct, yPct });
    },
    [onPlacePin, page]
  );

  const pinsOnPage = comments.filter((c) => c.pageNumber === page);

  return (
    <div className="stack gap-3">
      {error && <ErrorBanner message={error} />}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="row items-center gap-2">
          <button type="button" className="btn small" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            Previous
          </button>
          <span className="muted">
            Page {page} of {pageCount}
          </span>
          <button type="button" className="btn small" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>
            Next
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="row items-center gap-1">
          <button type="button" className="btn ghost icon small" onClick={() => setScale((s) => Math.max(MIN_SCALE, +(s - 0.25).toFixed(2)))} aria-label="Zoom out" disabled={scale <= MIN_SCALE}>
            <ZoomOut className="size-4" aria-hidden="true" />
          </button>
          <span className="muted w-10 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
          <button type="button" className="btn ghost icon small" onClick={() => setScale((s) => Math.min(MAX_SCALE, +(s + 0.25).toFixed(2)))} aria-label="Zoom in" disabled={scale >= MAX_SCALE}>
            <ZoomIn className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="relative overflow-auto rounded-lg border bg-muted/20" style={{ maxWidth: '100%' }}>
        {loading && !size.width && (
          <div className="p-10">
            <Spinner label="Rendering page…" />
          </div>
        )}
        <div className="relative inline-block" style={{ width: size.width || undefined, height: size.height || undefined }}>
          <canvas ref={canvasRef} className="block" />
          <div
            className="absolute left-0 top-0 h-full w-full"
            style={{ cursor: onPlacePin ? 'crosshair' : 'default' }}
            onClick={handleOverlayClick}
            role={onPlacePin ? 'button' : undefined}
            aria-label={onPlacePin ? 'Click to place a comment pin' : undefined}
          >
            {pinsOnPage.map((c) => (
              <button
                key={c.id}
                type="button"
                className={cn('absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md', STATUS_DOT[c.status], selectedCommentId === c.id && 'ring-2 ring-primary ring-offset-1')}
                style={pctToStyle(c.xPct, c.yPct)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectComment?.(c.id);
                }}
                aria-label={`${c.status.toLowerCase()} comment pin on page ${c.pageNumber}`}
                title={c.body}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
