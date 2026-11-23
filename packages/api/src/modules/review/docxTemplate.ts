import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import type { ReviewFieldFormat } from '@dcs-docs/shared';

/**
 * Filling a Word template. The agreement is kept as a normal Word file (.docx) whose changing parts are blanks such as
 * {{counterparty_name}} or {{start_date}}. A blank is replaced INSIDE the Word file, so the sentence keeps its own font,
 * size, spacing and alignment and flows around the new words. Nothing is painted over anything.
 */

/** Something is wrong with the Word file or with the values for it. The message is in plain English and safe to show. */
export class DocxTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxTemplateError';
  }
}

const MAX_UNPACKED_BYTES = 80 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const BLANK = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
/** the parts of a .docx that carry text a person reads */
const TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

export function isZip(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Opens a .docx safely: it must be a real Word file, small enough when unpacked, and without macros. */
function open(bytes: Buffer): PizZip {
  if (!isZip(bytes)) throw new DocxTemplateError('This is not a Word (.docx) file.');
  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch {
    throw new DocxTemplateError('This Word file is damaged and could not be read.');
  }
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRIES) throw new DocxTemplateError('This Word file has too many parts.');
  if (!names.includes('word/document.xml') || !names.includes('[Content_Types].xml')) throw new DocxTemplateError('This is not a Word (.docx) file.');
  if (names.some((n) => /vbaProject\.bin$|vbaData\.xml$/i.test(n))) throw new DocxTemplateError('Word files with macros are not accepted. Save the agreement as a normal .docx (not .docm).');
  let unpacked = 0;
  for (const n of names) {
    const size = (zip.files[n] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    unpacked += size;
  }
  if (unpacked > MAX_UNPACKED_BYTES) throw new DocxTemplateError('This Word file is too large when unpacked.');
  return zip;
}

/** The plain text of each paragraph of an XML part, with the text of all its runs joined: a blank Word split over several runs is found whole. */
function paragraphs(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const text = [...p.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1] ?? '').join('');
    out.push(text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
  }
  return out;
}

/** Every {{blank}} in the Word file, in the order first seen. */
export function findBlanks(bytes: Buffer): string[] {
  const zip = open(bytes);
  const seen: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!TEXT_PARTS.test(name)) continue;
    for (const text of paragraphs(zip.file(name)?.asText() ?? '')) {
      for (const m of text.matchAll(BLANK)) {
        const key = m[1] ?? '';
        if (key && !seen.includes(key)) seen.push(key);
      }
    }
  }
  return seen;
}

/** Characters that never belong in a name or a date: control characters and text-direction tricks. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩‎‏؜]/g, '').replace(/\s+/g, ' ').trim();

const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'de', 'van', 'von', 'bin', 'al']);
const KEEP_UPPER = /^(llp|llc|ceo|cfo|coo|cto|md|vp|fzc|fze|dwc|uae|usa|uk|lp|nv|bv|gmbh|ag|sa)\.?$/i;

function capitalise(word: string, first: boolean, mode: 'name' | 'title'): string {
  if (word === '') return word;
  if (KEEP_UPPER.test(word)) return word.toUpperCase();
  // a word that already has a capital after its first letter (McDonald, DeCircle) keeps its own capitals; only its first letter is raised
  if (/[A-Z]/.test(word.slice(1)) && /[a-z]/.test(word)) return word.charAt(0).toUpperCase() + word.slice(1);
  if (mode === 'title' && !first && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
  // each part of a hyphenated or apostrophe name: "o'brien-smith" -> "O'Brien-Smith"
  return word
    .toLowerCase()
    .replace(/(^|[-'’.])([a-zà-ÿ])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;

/** "2026-03-19" or "19/03/2026" (day first) or "19 March 2026" becomes "19th of March, 2026". Anything else is returned as typed. */
export function formatDateOrdinal(raw: string): string {
  const s = clean(raw);
  let y: number, m: number, d: number;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else if ((hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else if ((hit = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase().startsWith((hit![2] ?? '').toLowerCase().slice(0, 3)));
    if (mi < 0) return s;
    [d, m, y] = [Number(hit[1]), mi + 1, Number(hit[3])];
  } else return s;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return s;
  return `${ordinal(d)} of ${MONTHS[m - 1]}, ${y}`;
}

/** Tidies a value the client typed, the way its field says (see REVIEW_FIELD_FORMATS). */
export function formatValue(raw: string, format: ReviewFieldFormat | undefined): string {
  const s = clean(raw);
  switch (format) {
    case 'name':
    case 'title':
      return s
        .split(' ')
        .map((w, i) => capitalise(w, i === 0, format))
        .join(' ');
    case 'upper':
      return s.toUpperCase();
    case 'date_ordinal':
      return formatDateOrdinal(s);
    default:
      return s;
  }
}

/**
 * Fills every {{blank}} with its value and returns the finished Word file. A blank with no value is an error (never a
 * leftover "{{...}}" in an agreement that goes to a client), and a value for a blank that is not in the file is ignored.
 */
export function fillTemplate(bytes: Buffer, values: Record<string, string>): Buffer {
  const zip = open(bytes);
  const blanks = findBlanks(bytes);
  const missing = blanks.filter((k) => !Object.prototype.hasOwnProperty.call(values, k) || clean(values[k] ?? '') === '');
  if (missing.length) throw new DocxTemplateError(`The template needs a value for: ${missing.join(', ')}.`);
  let doc: Docxtemplater;
  try {
    doc = new Docxtemplater(zip, { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: false, nullGetter: () => '' });
    const data: Record<string, string> = {};
    for (const k of blanks) data[k] = clean(values[k] ?? '');
    doc.render(data);
  } catch (e) {
    const props = (e as { properties?: { errors?: { properties?: { explanation?: string } }[] } }).properties;
    const why = props?.errors?.[0]?.properties?.explanation;
    throw new DocxTemplateError(`The Word template could not be filled${why ? `: ${why}` : '. Check that every blank is typed exactly like {{name}}, with two braces each side and no spaces inside the name.'}`);
  }
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
