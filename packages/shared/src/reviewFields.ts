import { z } from 'zod';

/**
 * A document type's "fixed fields" for client review: instead of dragging a freeform box around arbitrary text,
 * the client fills in a short form of exactly the values this type's documents actually vary by (e.g. a
 * counterparty's name, a start date). Configured per document type via its own `reviewFieldsConfig` (set through
 * the document-types admin API, like every other part of a type's definition) -- never hardcoded by document
 * type in source, so a new type needs no code change to get its own set of fields.
 */

/** One spot in the document a field's value gets stamped into -- a fraction-of-page box, the same convention
 * pinPositionSchema/applyReplacements already use. Most fields sit mid-sentence rather than in their own isolated
 * run of text, so `template` substitutes the value into a `{{<field key>}}` token inside fixed surrounding text;
 * a position with no template just draws the value as-is. */
export const reviewFieldPositionSchema = z.strictObject({
  pageNumber: z.number().int().min(1),
  xPct: z.number().min(0).max(1),
  yPct: z.number().min(0).max(1),
  wPct: z.number().gt(0).max(1),
  hPct: z.number().gt(0).max(1),
  template: z.string().trim().min(1).max(2000).optional(),
});
export type ReviewFieldPosition = z.output<typeof reviewFieldPositionSchema>;

/** One named field a client can fill in. `positions` lists every spot this field's value is stamped into -- a
 * value can appear more than once in the same document (e.g. a counterparty's name in both an intro paragraph
 * and a signing block). */
export const reviewFieldDefSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, digits and _, starting with a letter').max(100),
  label: z.string().trim().min(1).max(100),
  placeholder: z.string().trim().max(150).optional(),
  positions: z.array(reviewFieldPositionSchema).min(1).max(10),
});
export type ReviewFieldDef = z.output<typeof reviewFieldDefSchema>;

/** A document type's whole set of fixed fields. Null/empty means a client reviewing that type only ever gets
 * the freeform-comment fallback (no fixed fields configured for it). */
export const reviewFieldsConfigSchema = z
  .array(reviewFieldDefSchema)
  .max(30)
  .nullable()
  .refine((fields) => !fields || new Set(fields.map((f) => f.key)).size === fields.length, 'Field keys must be unique');
export type ReviewFieldsConfig = z.output<typeof reviewFieldsConfigSchema>;

/** Field labels/placeholders only -- what the public review page may show a client. Never positions. */
export interface ReviewFieldOption {
  key: string;
  label: string;
  placeholder?: string;
}

/** Safely reads a document type's stored `reviewFieldsConfig` (raw JSONB) back into typed field definitions.
 * Invalid or missing stored data degrades to "no fixed fields" rather than throwing -- the freeform-comment
 * fallback still works either way. */
export function parseReviewFieldsConfig(raw: unknown): ReviewFieldDef[] {
  const r = reviewFieldsConfigSchema.safeParse(raw ?? null);
  return r.success ? (r.data ?? []) : [];
}

export function reviewFieldFor(config: unknown, fieldKey: string): ReviewFieldDef | undefined {
  return parseReviewFieldsConfig(config).find((f) => f.key === fieldKey);
}
