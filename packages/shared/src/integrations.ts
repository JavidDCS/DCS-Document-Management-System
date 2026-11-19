import { z } from 'zod';
import { emailAddressSchema } from './email.js';

/**
 * Server-to-server contract with the sister "DCS Leads Manager" app (leads.decirclesolar.com): it creates a
 * hand-off before sending a person here, reads back what was actually sent afterwards, and in between the person
 * sends an NDA or Teaser from their own connected Gmail on this app's existing Send page, exactly as today.
 */
export const INTEGRATION_DOCUMENT_TYPE_KEYS = ['nda', 'teaser'] as const;
export type IntegrationDocumentTypeKey = (typeof INTEGRATION_DOCUMENT_TYPE_KEYS)[number];

const refSchema = z.string().trim().min(1).max(100);
const requestedBySchema = z.string().trim().min(1).max(200);

export const handoffCreateSchema = z.strictObject({
  to: emailAddressSchema,
  documentTypeKey: z.enum(INTEGRATION_DOCUMENT_TYPE_KEYS),
  documentId: z.uuid().optional(),
  ref: refSchema,
  requestedBy: requestedBySchema,
});
export type HandoffCreateInput = z.output<typeof handoffCreateSchema>;

export const integrationDocumentsQuerySchema = z.strictObject({
  type: z.enum(INTEGRATION_DOCUMENT_TYPE_KEYS),
});

export const sentLookupSchema = z.strictObject({
  refs: z.array(z.string().trim().min(1).max(100)).max(200),
});

export interface HandoffCreatedDto {
  id: string;
}

export interface IntegrationDocumentListItem {
  id: string;
  name: string;
  versionLabel: string;
  sizeBytes: number;
}

export interface SentLookupItem {
  ref: string;
  sentAt: string;
  senderName: string;
}

/** The signed-in Send page's own view of a hand-off; not part of the fixed Leads-Manager contract above. */
export interface HandoffLookupDto {
  to: string;
  documentTypeKey: IntegrationDocumentTypeKey;
  documentTypeId: string | null;
  documentId: string | null;
  documentName: string | null;
  ref: string;
}
