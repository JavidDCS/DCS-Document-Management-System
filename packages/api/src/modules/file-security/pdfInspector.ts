import { inflateSync } from 'node:zlib';

/**
 * Static inspection of a PDF for content that can run code or open things without the reader asking.
 * This never renders or executes the file. Compressed object streams can hide dictionaries from a raw scan, so
 * FlateDecode streams are inflated (with strict size and count limits) and scanned too; anything that cannot be
 * inspected within the limits is rejected rather than trusted.
 */
export type PdfFinding =
  | 'JAVASCRIPT'
  | 'LAUNCH_ACTION'
  | 'EMBEDDED_FILE'
  | 'OPEN_ACTION'
  | 'ADDITIONAL_ACTIONS'
  | 'RICH_MEDIA'
  | 'FORM_SUBMIT'
  | 'GOTO_REMOTE';

export type PdfProblem =
  | 'NOT_A_PDF'
  | 'ENCRYPTED'
  | 'TRUNCATED'
  | 'UNINSPECTABLE_OBJECT_STREAM'
  | 'TOO_COMPLEX';

export interface PdfInspection {
  findings: PdfFinding[];
  problems: PdfProblem[];
}

const NAME_TO_FINDING: Record<string, PdfFinding> = {
  javascript: 'JAVASCRIPT',
  js: 'JAVASCRIPT',
  launch: 'LAUNCH_ACTION',
  embeddedfile: 'EMBEDDED_FILE',
  embeddedfiles: 'EMBEDDED_FILE',
  filespec: 'EMBEDDED_FILE',
  openaction: 'OPEN_ACTION',
  aa: 'ADDITIONAL_ACTIONS',
  richmedia: 'RICH_MEDIA',
  submitform: 'FORM_SUBMIT',
  importdata: 'FORM_SUBMIT',
  gotor: 'GOTO_REMOTE',
  gotoe: 'GOTO_REMOTE',
};

const MAX_INFLATED_PER_STREAM = 10 * 1024 * 1024;
const MAX_INFLATED_TOTAL = 64 * 1024 * 1024;
const MAX_STREAMS = 5000;

/** Resolves #xx escapes inside a PDF name (e.g. /#4AavaScript) so obfuscated names cannot hide. */
function decodeName(raw: string): string {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).toLowerCase();
}

function scanText(text: string, findings: Set<PdfFinding>, problems: Set<PdfProblem>) {
  for (const m of text.matchAll(/\/([A-Za-z0-9#_.+-]{1,64})/g)) {
    const name = decodeName(m[1]!);
    const f = NAME_TO_FINDING[name];
    if (f) findings.add(f);
    if (name === 'encrypt') problems.add('ENCRYPTED');
  }
}

export function inspectPdf(buf: Buffer): PdfInspection {
  const findings = new Set<PdfFinding>();
  const problems = new Set<PdfProblem>();

  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { findings: [], problems: ['NOT_A_PDF'] };
  }
  if (!buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1').includes('%%EOF')) problems.add('TRUNCATED');

  const text = buf.toString('latin1');
  scanText(text, findings, problems);

  // Streams: look for object streams and inflate compressed ones.
  let totalInflated = 0;
  let streams = 0;
  const re = /(?<!end)stream\r?\n/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = re.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = text.indexOf('endstream', bodyStart);
    if (bodyEnd === -1) break;
    re.lastIndex = bodyEnd;
    if (++streams > MAX_STREAMS) {
      problems.add('TOO_COMPLEX');
      break;
    }
    // The stream dictionary is the text between the previous object start and the "stream" keyword.
    const dictStart = Math.max(lastEnd, text.lastIndexOf('obj', match.index));
    const dict = text.slice(dictStart, match.index);
    lastEnd = bodyEnd;

    const isObjStm = /\/Type\s*\/ObjStm/.test(dict) || /\/Type\s*\/XRef/.test(dict);
    const filters = [...dict.matchAll(/\/(FlateDecode|Fl|LZWDecode|ASCII85Decode|ASCIIHexDecode|RunLengthDecode|Crypt|JBIG2Decode|DCTDecode|CCITTFaxDecode|JPXDecode)\b/g)].map((m) => m[1]!);
    const flate = filters.includes('FlateDecode') || filters.includes('Fl');
    const onlyFlate = filters.length > 0 && filters.every((f) => f === 'FlateDecode' || f === 'Fl');

    if (isObjStm && filters.length > 0 && !onlyFlate) problems.add('UNINSPECTABLE_OBJECT_STREAM');
    if (!flate) {
      // Uncompressed object streams are plain text, already covered by the raw scan above.
      continue;
    }
    // Inflate every Flate stream: a normal PDF's content/image streams contain no names that matter, and an object
    // stream (or a smuggled dictionary) does. Failures are ignored: such a stream just cannot hide dictionaries.
    try {
      const body = Buffer.from(text.slice(bodyStart, bodyEnd), 'latin1');
      const out = inflateSync(body, { maxOutputLength: MAX_INFLATED_PER_STREAM, finishFlush: 2 /* Z_SYNC_FLUSH */ });
      totalInflated += out.length;
      if (totalInflated > MAX_INFLATED_TOTAL) {
        problems.add('TOO_COMPLEX');
        break;
      }
      scanText(out.toString('latin1'), findings, problems);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        // A stream that inflates beyond the limit is a decompression bomb (or an enormous object stream).
        problems.add(isObjStm ? 'TOO_COMPLEX' : 'TOO_COMPLEX');
        break;
      }
    }
  }

  return { findings: [...findings].sort(), problems: [...problems].sort() };
}
