export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'SENDER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'users:read' | 'users:manage' | 'users:roles'
  | 'doc_types:read' | 'doc_types:manage'
  | 'documents:read' | 'documents:manage' | 'documents:archive' | 'documents:legal_hold'
  | 'versions:create' | 'versions:restore' | 'versions:download'
  | 'email:send' | 'email:send_external' | 'email:read_own' | 'email:read_all' | 'email:connect'
  | 'templates:read' | 'templates:manage'
  | 'audit:read' | 'audit:export' | 'reports:read';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  status: 'INVITED' | 'ACTIVE' | 'DEACTIVATED';
  roles: Role[];
  permissions: Permission[];
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  status: 'INVITED' | 'ACTIVE' | 'DEACTIVATED';
  roles: Role[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  ip: string | null;
  userAgent: string | null;
}

export const FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldOption {
  value: string;
  label: string;
  isActive: boolean;
}

export interface FieldValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  integerOnly?: boolean;
  minDate?: string;
  maxDate?: string;
}

export interface FieldDefinition {
  id?: string;
  key: string;
  label: string;
  fieldType: FieldType;
  required: boolean;
  helpText: string | null;
  placeholder: string | null;
  defaultValue: unknown;
  options: FieldOption[] | null;
  validation: FieldValidation | null;
  searchable: boolean;
  displayOrder: number;
  isActive: boolean;
}

export interface DocumentTypeDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  allowedMimeTypes: string[];
  maxFileSizeMb: number;
  retentionYears: number | null;
  isActive: boolean;
  fieldsVersion: number;
  fields: FieldDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface TagDto {
  id: string;
  name: string;
  createdAt: string;
}

export type ScanStatus = 'PENDING' | 'CLEAN' | 'QUARANTINED' | 'REJECTED';
export type ArchiveStatus = 'LIVE' | 'ARCHIVED' | 'LEGAL_HOLD';

export interface VersionDto {
  id: string;
  versionNumber: number;
  originalFilename: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: ScanStatus;
  scanDetail: string | null;
  isCurrent: boolean;
  changeNote: string | null;
  restoredFromVersionId: string | null;
  uploadedBy: { id: string; name: string };
  createdAt: string;
}

export interface DocumentListItem {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  isActive: boolean;
  archiveStatus: ArchiveStatus;
  currentVersionNumber: number | null;
  currentVersionId: string | null;
  tags: { id: string; name: string }[];
  updatedAt: string;
}

export interface DocumentDetail extends DocumentListItem {
  description: string | null;
  metadata: Record<string, unknown>;
  fieldsVersion: number;
  versions: VersionDto[];
  type: DocumentTypeDto;
}

export interface ListMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface GmailConnection {
  status: 'NONE' | 'ACTIVE' | 'REVOKED' | 'ERROR';
  googleEmail: string | null;
  available: boolean;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface DraftItem {
  documentId: string;
  versionId: string;
}

export interface DraftRequest {
  items: DraftItem[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  templateId?: string;
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

export type EmailStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN';

export interface EmailListItem {
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

export interface EmailDetail extends EmailListItem {
  body: string;
  replyTo?: string;
  recipients: { kind: 'TO' | 'CC' | 'BCC'; address: string; external: boolean }[];
  attachments: { documentId: string; documentName: string; versionId: string; versionNumber: number; filename: string; sizeBytes: number; sha256: string }[];
  providerMessageId: string | null;
  errorCode: string | null;
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorType: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  ip: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface ReportSummary {
  documentsActive: number;
  documentsInactive: number;
  versionsPending: number;
  versionsQuarantined: number;
  emailsSent30d: number;
  emailsFailed30d: number;
  usersActive: number;
  recentEmails: EmailListItem[];
}

export interface Issue {
  path: string;
  message: string;
}
