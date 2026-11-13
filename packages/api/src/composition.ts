import type { PrismaClient } from '@prisma/client';
import type { AppConfig, AppContext } from './app.js';
import { repoRoot } from './config/envFiles.js';
import { AuthService, type AuthConfig } from './modules/identity/auth.service.js';
import { registerIdentityRoutes } from './modules/identity/identity.routes.js';
import { PasswordHasher } from './modules/identity/password.js';
import { SessionService, type SessionConfig } from './modules/identity/session.service.js';
import { TokenService, type TokenConfig } from './modules/identity/tokens.js';
import { registerDocumentTypeRoutes } from './modules/document-types/documentTypes.routes.js';
import { DocumentTypesService, type DocumentUsage } from './modules/document-types/documentTypes.service.js';
import { registerDocumentRoutes } from './modules/documents/documents.routes.js';
import { DocumentsService } from './modules/documents/documents.service.js';
import { registerEmailRoutes } from './modules/email/email.routes.js';
import { EmailService } from './modules/email/email.service.js';
import { EmailConnectionsService } from './modules/email/connections.service.js';
import { SecretBox } from './modules/email/secretBox.js';
import { ClamAvScanner, DisabledScanner, type MalwareScanner } from './modules/file-security/scanner.js';
import { ScanService, type ScanConfig } from './modules/file-security/scan.service.js';
import { JobRunner, type JobsConfig } from './modules/jobs/jobs.js';
import { FileCrypto } from './modules/storage/fileCrypto.js';
import { FileService } from './modules/storage/fileService.js';
import { registerTagRoutes } from './modules/tags/tags.routes.js';
import { TagsService } from './modules/tags/tags.service.js';
import { registerUserRoutes } from './modules/users/users.routes.js';
import { UsersService, type UsersConfig } from './modules/users/users.service.js';
import { registerAuditRoutes } from './modules/audit/audit.routes.js';
import { registerReportsRoutes } from './modules/reports/reports.routes.js';
import { createAuthenticator } from './platform/auth/guards.js';
import type { SecureRouter } from './platform/auth/secureRouter.js';
import { GmailProvider } from './providers/email/gmail.js';
import type { EmailProvider } from './providers/email/types.js';
import { EnvKeyProvider, decodeMasterKey, parseKeyList } from './providers/keys/envKeyProvider.js';
import { createStorageProvider, type StorageEnv } from './providers/storage/factory.js';

export type ServicesConfig = AppConfig &
  AuthConfig &
  SessionConfig &
  TokenConfig &
  UsersConfig &
  ScanConfig &
  JobsConfig & {
    BCRYPT_COST: number;
    REFRESH_COOKIE_NAME: string;
    ALLOWED_EMAIL_DOMAIN: string;
    EMAIL_MAX_ATTACHMENT_TOTAL_MB: number;
    APP_TIMEZONE: string;
    EMAIL_TOKEN_ENCRYPTION_KEY: string;
    APP_PUBLIC_URL?: string | undefined;
    GMAIL_OAUTH_CLIENT_ID?: string | undefined;
    GMAIL_OAUTH_CLIENT_SECRET?: string | undefined;
    GMAIL_OAUTH_REDIRECT_URI?: string | undefined;
  };

export interface ServiceDeps {
  files: FileService;
  scanner: MalwareScanner;
  /** Overridable in tests; by default "has documents" is read from the documents table. */
  usage?: DocumentUsage;
  emailProvider?: EmailProvider;
}

/** The composition root: the only place that wires concrete services together. */
export function buildServices(db: PrismaClient, cfg: ServicesConfig, deps: ServiceDeps) {
  const hasher = new PasswordHasher(cfg.BCRYPT_COST);
  const tokens = new TokenService(cfg);
  const sessions = new SessionService(db, cfg);
  const auth = new AuthService(db, cfg, hasher, tokens, sessions);
  const users = new UsersService(db, cfg, hasher, sessions);
  const usage: DocumentUsage = deps.usage ?? { countForType: (typeId) => db.document.count({ where: { documentTypeId: typeId } }) };
  const documentTypes = new DocumentTypesService(db, usage, cfg);
  const tags = new TagsService(db);
  const documents = new DocumentsService(db, deps.files, documentTypes, cfg);
  const scan = new ScanService(db, deps.files, deps.scanner, cfg);

  const publicUrl = (cfg.APP_PUBLIC_URL ?? cfg.CORS_ORIGINS[0]!).replace(/\/+$/, '');
  const emailKey = decodeMasterKey(cfg.EMAIL_TOKEN_ENCRYPTION_KEY);
  const secretBox = new SecretBox(emailKey);
  const emailProvider =
    deps.emailProvider ??
    new GmailProvider({
      clientId: cfg.GMAIL_OAUTH_CLIENT_ID,
      clientSecret: cfg.GMAIL_OAUTH_CLIENT_SECRET,
      redirectUri: cfg.GMAIL_OAUTH_REDIRECT_URI ?? `${publicUrl}/api/v1/email/connection/callback`,
    });
  const emailConnections = new EmailConnectionsService(db, emailProvider, secretBox);
  const email = new EmailService(db, deps.files, documents, emailConnections, emailProvider, cfg, emailKey);

  users.onDeactivate(async (tx, userId) => {
    await emailConnections.wipe(tx, userId, 'REVOKED');
  });

  const jobs = new JobRunner(db, cfg)
    .register('scan_file', (job) => scan.handle(job))
    .register('send_email', (job) => email.handleSend(job))
    .setDeadLetterHook((job, error) => scan.onDeadLetter(job, error));

  const authenticate = createAuthenticator(tokens, sessions);
  return {
    db,
    hasher,
    tokens,
    sessions,
    auth,
    users,
    documentTypes,
    tags,
    documents,
    scan,
    jobs,
    files: deps.files,
    authenticate,
    email,
    emailConnections,
    emailProvider,
  };
}

export type Services = ReturnType<typeof buildServices>;

export function registerRoutes(secure: SecureRouter, ctx: AppContext, svc: Services, cfg: ServicesConfig) {
  registerIdentityRoutes(secure, ctx, {
    auth: svc.auth,
    sessions: svc.sessions,
    cookie: { name: cfg.REFRESH_COOKIE_NAME, secure: cfg.COOKIE_SECURE },
  });
  registerUserRoutes(secure, ctx, svc.users);
  registerDocumentTypeRoutes(secure, ctx, svc.documentTypes);
  registerTagRoutes(secure, ctx, svc.tags);
  registerDocumentRoutes(secure, ctx, svc.documents, svc.files);
  registerEmailRoutes(secure, ctx, {
    email: svc.email,
    connections: svc.emailConnections,
    publicUrl: cfg.APP_PUBLIC_URL ?? cfg.CORS_ORIGINS[0]!,
  });
  registerAuditRoutes(secure, ctx, svc.db);
  registerReportsRoutes(secure, ctx, svc.db);
}

export interface FileStackEnv extends StorageEnv {
  FILE_ENCRYPTION_MASTER_KEY: string;
  FILE_ENCRYPTION_KEY_ID: string;
  FILE_ENCRYPTION_PREVIOUS_KEYS?: string | undefined;
  MALWARE_SCAN_ENABLED: boolean;
  CLAMAV_HOST: string;
  CLAMAV_PORT: number;
  CLAMAV_TIMEOUT_MS: number;
}

/** Builds the storage driver (from STORAGE_DRIVER), the envelope encryption layer above it and the malware scanner. */
export async function buildFileStack(env: FileStackEnv): Promise<{ files: FileService; scanner: MalwareScanner }> {
  const provider = await createStorageProvider(env, { forbiddenParents: [repoRoot()] });
  const keys = new EnvKeyProvider(env.FILE_ENCRYPTION_KEY_ID, decodeMasterKey(env.FILE_ENCRYPTION_MASTER_KEY), parseKeyList(env.FILE_ENCRYPTION_PREVIOUS_KEYS));
  const files = new FileService(provider, new FileCrypto(keys));
  const scanner: MalwareScanner = env.MALWARE_SCAN_ENABLED
    ? new ClamAvScanner({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT, timeoutMs: env.CLAMAV_TIMEOUT_MS })
    : new DisabledScanner();
  return { files, scanner };
}
