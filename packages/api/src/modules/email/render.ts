import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { PLACEHOLDER_PATTERN, type EmailPlaceholder } from '@dcs-docs/shared';

// eslint-disable-next-line no-control-regex
const LINE_BREAKS_AND_CONTROL = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Single-pass placeholder substitution. Values are cleaned of control characters (so a document name can never add a
 * header line) and are inserted as data: they are never scanned for placeholders again, so there is no template injection.
 */
export function renderText(text: string, values: Record<EmailPlaceholder, string>, kind: 'subject' | 'body'): string {
  return text.replace(PLACEHOLDER_PATTERN, (_m, name: string) => {
    const raw = (values as Record<string, string>)[name] ?? '';
    return kind === 'subject' ? raw.replace(LINE_BREAKS_AND_CONTROL, ' ').trim() : raw.replace(/\r\n?/g, '\n').replace(BODY_CONTROL, '');
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The HTML alternative is generated from the plain text with everything escaped; user HTML is never accepted. */
export function textToHtml(text: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

/** "javid.fazil@x.com" -> "Javid Fazil" (best effort, for {{recipient_name}}). */
export function nameFromAddress(address: string): string {
  const local = address.split('@')[0] ?? '';
  return local
    .split(/[._+-]+/)
    .filter((p) => /^[a-z]+$/i.test(p))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

export interface MimeInput {
  fromName: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  messageId: string;
  attachments: { filename: string; content: Buffer }[];
}

/** Builds the RFC 5322 message. Headers are encoded by the MIME library; addresses and subject were validated first. */
export async function buildMime(m: MimeInput): Promise<Buffer> {
  const composer = new MailComposer({
    from: { name: m.fromName.replace(LINE_BREAKS_AND_CONTROL, ' '), address: m.fromAddress },
    replyTo: m.fromAddress,
    to: m.to,
    ...(m.cc.length ? { cc: m.cc } : {}),
    ...(m.bcc.length ? { bcc: m.bcc } : {}),
    subject: m.subject,
    text: m.body,
    html: textToHtml(m.body),
    messageId: `<${m.messageId}@dcs-documents.local>`,
    attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: 'application/pdf' })),
  });
  return composer.compile().build();
}
