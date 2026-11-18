// Wires pdfjs-dist's worker for Vite: the worker script is bundled and served from its own URL,
// then pdfjs-dist is told to use it instead of trying (and failing) to resolve a worker itself.
// Side-effecting module: import it once, before the first `getDocument()` call.
import { GlobalWorkerOptions } from 'pdfjs-dist';
// eslint-disable-next-line import/no-unresolved
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
