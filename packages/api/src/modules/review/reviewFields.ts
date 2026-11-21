import { parseReviewFieldsConfig, type ReviewFieldDef } from '@dcs-docs/shared';

export type { ReviewFieldDef, ReviewFieldPosition } from '@dcs-docs/shared';

/** A document's type carries its own fixed client-review fields in `reviewFieldsConfig` (raw JSONB, set through
 * the document-types admin API) -- never hardcoded by document type here, so a new type needs no code change. */
export function reviewFieldsFor(reviewFieldsConfig: unknown): ReviewFieldDef[] {
  return parseReviewFieldsConfig(reviewFieldsConfig);
}

export function reviewFieldFor(reviewFieldsConfig: unknown, fieldKey: string): ReviewFieldDef | undefined {
  return reviewFieldsFor(reviewFieldsConfig).find((f) => f.key === fieldKey);
}
