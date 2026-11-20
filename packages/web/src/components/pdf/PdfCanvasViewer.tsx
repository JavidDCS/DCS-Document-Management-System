import type { ReviewCommentDto } from '@dcs-docs/shared';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ErrorBanner, Spinner, cn } from '../ui';
import './pdfWorker';
import { boxToStyle, dragToSelection, pctToStyle } from './pinMath';

export interface PlacedPin {
  pageNumber: number;
  xPct: number;
  yPct: number;
}

/** A box drawn around the text to change. (xPct, yPct) is its top-left corner; sizes are fractions of the page. */
export interface PlacedBox extends PlacedPin {
  wPct: number;
  hPct: number;
}

export interface PdfCanvasViewerProps {
  /** URL (http(s) or blob:) of the PDF bytes to render. */
  fileUrl: string;
  comments: ReviewCommentDto[];
  /** Omit both place handlers to render read-only (staff review): marks are selectable but new ones cannot be drawn. */
  onPlacePin?: (pos: PlacedPin) => void;
  /** Called when the reader drags a box instead of clicking. Without it a drag is ignored. */
  onPlaceBox?: (box: PlacedBox) => void;
  /** The mark being composed right now, shown so the reader sees what the comment box below refers to. */
  pending?: PlacedPin | PlacedBox | null;
  selectedCommentId?: string | null;
  onSelectComment?: (id: string) => void;
}

const STATUS_DOT: Record<ReviewCommentDto['status'], string> = {
  OPEN: 'border-amber-600 bg-amber-400',
  ACCEPTED: 'border-emerald-600 bg-emerald-400',
  DISMISSED: 'border-slate-400 bg-slate-300 opacity-60',
};

const STATUS_BOX: Record<ReviewCommentDto['status'], string> = {
  OPEN: 'border-amber-600 bg-amber-300/30',
  ACCEPTED: 'border-emerald-600 bg-emerald-300/30',
  DISMISSED: 'border-slate-400 bg-slate-300/20 opacity-60',
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

interface Drag {
  sx: number;
  sy: number;
  ex: number;
  ey: number;
}

function isBox(p: PlacedPin | PlacedBox): p is PlacedBox {
  return 'wPct' in p;
}

/** Renders one PDF page at a time to a canvas, with an overlay for comment pins and suggested-change boxes. Not continuous scroll. */
export function PdfCanvasViewer({ fileUrl, comments, onPlacePin, onPlaceBox, pending, selectedCommentId, onSelectComment }: PdfCanvasViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTokenRef = useRef(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const interactive = Boolean(onPlacePin || onPlaceBox);

  // Selecting a comment from the list jumps the page to wherever it actually is -- otherwise picking one on a
  // page you're not currently viewing looks like nothing happened.
  useEffect(() => {
    if (!selectedCommentId) return;
    const c = comments.find((x) => x.id === selectedCommentId);
    if (c) setPage(c.pageNumber);
  }, [selectedCommentId, comments]);

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

  // Pointer events (not click) so one gesture covers both: press-release = a pin, press-drag-release = a box.
  // setPointerCapture keeps the drag alive if the pointer leaves the page, and it works for mouse, touch and pen.
  const offsetIn = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, width: rect.width, height: rect.height };
  };

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!interactive || e.button !== 0) return;
      const { x, y } = offsetIn(e);
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ sx: x, sy: y, ex: x, ey: y });
    },
    [interactive]
  );

  const handlePointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const { x, y } = offsetIn(e);
    setDrag((d) => (d ? { ...d, ex: x, ey: y } : d));
  }, []);

  const handlePointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      const { x, y, width, height } = offsetIn(e);
      setDrag(null);
      const sel = dragToSelection(drag.sx, drag.sy, x, y, width, height);
      if (sel.kind === 'box') {
        if (onPlaceBox) onPlaceBox({ pageNumber: page, xPct: sel.xPct, yPct: sel.yPct, wPct: sel.wPct, hPct: sel.hPct });
        else onPlacePin?.({ pageNumber: page, xPct: sel.xPct, yPct: sel.yPct });
      } else {
        onPlacePin?.({ pageNumber: page, xPct: sel.xPct, yPct: sel.yPct });
      }
    },
    [drag, onPlaceBox, onPlacePin, page]
  );

  // With one comment selected, show only that mark -- a page full of other boxes made it hard to tell exactly
  // what the client asked to change.
  const marksOnPage = comments.filter((c) => c.pageNumber === page && (!selectedCommentId || c.id === selectedCommentId));
  const pendingOnPage = pending && pending.pageNumber === page ? pending : null;
  const liveBox = drag && Math.hypot(drag.ex - drag.sx, drag.ey - drag.sy) >= 6 && size.width > 0 ? dragToSelection(drag.sx, drag.sy, drag.ex, drag.ey, size.width, size.height) : null;

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
            className="absolute left-0 top-0 h-full w-full select-none"
            style={{ cursor: interactive ? 'crosshair' : 'default', touchAction: interactive ? 'none' : undefined }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setDrag(null)}
            role={interactive ? 'application' : undefined}
            aria-label={interactive ? 'Click to leave a comment, or drag a box around text you want changed' : undefined}
          >
            {marksOnPage.map((c) =>
              c.kind === 'CHANGE' && c.boxWPct !== null && c.boxHPct !== null ? (
                <button
                  key={c.id}
                  type="button"
                  className={cn('absolute border-2 border-dashed', STATUS_BOX[c.status], selectedCommentId === c.id && 'ring-2 ring-primary ring-offset-1')}
                  style={boxToStyle(c.xPct, c.yPct, c.boxWPct, c.boxHPct)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectComment?.(c.id);
                  }}
                  aria-label={`${c.status.toLowerCase()} suggested change on page ${c.pageNumber}`}
                  title={c.replacementText ? `Change to: ${c.replacementText}` : c.body}
                />
              ) : (
                <button
                  key={c.id}
                  type="button"
                  className={cn('absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md', STATUS_DOT[c.status], selectedCommentId === c.id && 'ring-2 ring-primary ring-offset-1')}
                  style={pctToStyle(c.xPct, c.yPct)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectComment?.(c.id);
                  }}
                  aria-label={`${c.status.toLowerCase()} comment pin on page ${c.pageNumber}`}
                  title={c.body}
                />
              )
            )}

            {/* What the reader is composing right now (and the live rectangle while dragging). */}
            {pendingOnPage &&
              (isBox(pendingOnPage) ? (
                <div className="pointer-events-none absolute border-2 border-primary bg-primary/15" style={boxToStyle(pendingOnPage.xPct, pendingOnPage.yPct, pendingOnPage.wPct, pendingOnPage.hPct)} />
              ) : (
                <div className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/40" style={pctToStyle(pendingOnPage.xPct, pendingOnPage.yPct)} />
              ))}
            {liveBox && liveBox.kind === 'box' && (
              <div className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10" style={boxToStyle(liveBox.xPct, liveBox.yPct, liveBox.wPct, liveBox.hPct)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
