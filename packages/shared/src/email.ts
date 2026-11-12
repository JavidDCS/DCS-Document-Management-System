import { z } from 'zod';

/** The only placeholders a template or an email may contain. Anything else is rejected. */
export const EMAIL_PLACEHOLDERS = ['recipient_name', 'sender_name', 'sender_email', 'document_name', 'document_type', 'version_number', 'date'] as const;
export type EmailPlaceholder = (typeof EMAIL_PLACEHOLDERS)[number];

export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Names of all `{{...}}` tokens in a text (including unknown ones). */
export function findPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]!);
}

export function unknownPlaceholders(...texts: string[]): string[] {
  const known = new Set<string>(EMAIL_PLACEHOLDERS);
  return [...new Set(texts.flatMap(findPlaceholders).filter((p) => !known.has(p)))];
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const subjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !CONTROL.test(s), 'Must be a single line without control characters');

export const bodySchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine((s) => !BODY_CONTROL.test(s), 'Contains control characters');

export const emailAddressSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const EMAIL_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const itemSchema = z.strictObject({ documentId: z.uuid(), versionId: z.uuid() });

const draftShape = {
  items: z.array(itemSchema).min(1).max(10),
  to: z.array(emailAddressSchema).min(1).max(50),
  cc: z.array(emailAddressSchema).max(50).default([]),
  bcc: z.array(emailAddressSchema).max(50).default([]),
  subject: subjectSchema,
  body: bodySchema,
  templateId: z.uuid().optional(),
};

export const draftSchema = z.strictObject(draftShape);
export type DraftInput = z.output<typeof draftSchema>;

export const sendSchema = z.strictObject({
  ...draftShape,
  idempotencyKey: z.uuid(),
  confirmationToken: z.string().min(10).max(1000).optional(),
});
export type SendInput = z.output<typeof sendSchema>;

export const resolveUnknownSchema = z.strictObject({ outcome: z.enum(['SENT', 'FAILED']) });

export const listMessagesQuerySchema = z.strictObject({
  scope: z.enum(['mine', 'all']).default('mine'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const templateInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    subject: subjectSchema,
    body: bodySchema,
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((t, ctx) => {
    const bad = unknownPlaceholders(t.subject, t.body);
    if (bad.length > 0) ctx.addIssue({ code: 'custom', path: ['body'], message: `Unknown placeholder: ${bad.map((b) => `{{${b}}}`).join(', ')}` });
  });
export type TemplateInput = z.output<typeof templateInputSchema>;

export const templateUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    subject: subjectSchema.optional(),
    body: bodySchema.optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one property to change')
  .superRefine((t, ctx) => {
    const bad = unknownPlaceholders(t.subject ?? '', t.body ?? '');
    if (bad.length > 0) ctx.addIssue({ code: 'custom', path: ['body'], message: `Unknown placeholder: ${bad.map((b) => `{{${b}}}`).join(', ')}` });
  });

export interface EmailTemplateDto {
  id: string;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  updatedAt: string;
}

export interface DraftPreview {
  subject: string;
  body: string;
  from: string;
  replyTo: string;
  recipients: { kind: 'TO' | 'CC' | 'BCC'; address: string; external: boolean }[];
  attachments: { documentId: string; documentName: string; versionId: string; versionNumber: number; filename: string; sizeBytes: number; sha256: string }[];
  hasExternal: boolean;
  confirmationToken: string | null;
  expiresAt: string;
}

export interface EmailMessageListItem {
  id: string;
  status: EmailStatus;
  subject: string;
  from: string;
  sentAt: string | null;
  createdAt: string;
  recipientCount: number;
  attachmentCount: number;
  senderName: string;
}
export type EmailListItem = EmailMessageListItem;

export interface EmailMessageDetail extends EmailMessageListItem {
  replyTo: string;
  body: string;
  recipients: { kind: 'TO' | 'CC' | 'BCC'; address: string; external: boolean }[];
  attachments: { documentId: string; versionId: string; filename: string; sizeBytes: number; sha256: string }[];
  providerMessageId: string | null;
  errorCode: string | null;
  externalConfirmed: boolean;
}

export interface GmailConnectionDto {
  status: 'NONE' | 'ACTIVE' | 'REVOKED' | 'ERROR';
  googleEmail: string | null;
  available: boolean;
}
