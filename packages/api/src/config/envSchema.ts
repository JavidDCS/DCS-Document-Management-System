import path from 'node:path';
import { z } from 'zod';
import { decodeMasterKey, parseKeyList } from '../providers/keys/envKeyProvider.js';

/**
 * Every environment variable the API reads, with its validation rules.
 * Free of side effects (no dotenv, no process.exit) so tests and tooling can import it safely.
 * `config/env.ts` loads the .env files and applies this schema; nothing else may read process.env.
 * Error messages name the variable and the rule, never the value.
 */
const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);

const intInRange = (min: number, max: number, fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));

const flag = (fallback: boolean) =>
  z.preprocess(blankToUndefined, z.enum(['true', 'false']).default(fallback ? 'true' : 'false')).transform((v) => v === 'true');

const optionalString = z.preprocess(blankToUndefined, z.string().optional());

const PLACEHOLDER = /^change[-_ ]?me/i;

/** The browser origin when CORS_ORIGIN is not set: the origin of APP_PUBLIC_URL, else http://WEB_HOST:WEB_PORT. */
export function defaultOrigin(e: { APP_PUBLIC_URL?: string | undefined; WEB_HOST: string; WEB_PORT: number }): string {
  return e.APP_PUBLIC_URL ? new URL(e.APP_PUBLIC_URL).origin : `http://${e.WEB_HOST}:${e.WEB_PORT}`;
}

export function parseOrigins(csv: string): string[] {
  return [...new Set(csv.split(',').map((o) => o.trim()).filter(Boolean))];
}

function isBareOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === origin;
  } catch {
    return false;
  }
}

export const envObject = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_COMPANY_NAME: z.string().min(1).default('DeCircle Solar'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: intInRange(1, 65535, 7800),
  WEB_HOST: z.string().min(1).default('127.0.0.1'),
  WEB_PORT: intInRange(1, 65535, 7801),
  APP_PUBLIC_URL: z.preprocess(blankToUndefined, z.url().optional()),
  TRUST_PROXY: intInRange(0, 10, 0),
  APP_TIMEZONE: z
    .string()
    .min(1)
    .default('Asia/Kolkata')
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat('en-GB', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'APP_TIMEZONE must be a valid IANA time zone such as Asia/Kolkata' }
    ),
  REQUEST_BODY_LIMIT_KB: intInRange(1, 1024, 100),

  // Database (PostgreSQL 14+). Credentials live only here, never in code or docs.
  DATABASE_URL: z
    .string({ message: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgresql:// URL'),
  // Used ONLY by automated tests; the database name must end in "_test".
  DATABASE_URL_TEST: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL_TEST must be a postgresql:// URL')
      .refine((url) => /\/[^/?]*_test(\?|$)/.test(url), {
        message: 'DATABASE_URL_TEST must point at a database whose name ends in "_test"',
      })
      .optional()
  ),

  // CORS: explicit origins only
  // Comma-separated browser origins. When unset: the origin of APP_PUBLIC_URL, else http://WEB_HOST:WEB_PORT.
  CORS_ORIGIN: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  CSP_REPORT_URI: z.preprocess(blankToUndefined, z.url().optional()),

  // CSRF and cookies
  CSRF_SECRET: z
    .string({ message: 'CSRF_SECRET is required' })
    .min(32, 'CSRF_SECRET must be at least 32 characters'),
  COOKIE_SECURE: z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()).transform((v) => (v === undefined ? undefined : v === 'true')),

  // Authentication (email + password, JWT access token, rotating refresh token)
  ALLOWED_EMAIL_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'ALLOWED_EMAIL_DOMAIN must be a domain such as example.com')
    .default('decirclesolar.com'),
  BCRYPT_COST: intInRange(4, 15, 12),
  LOGIN_MAX_FAILED_ATTEMPTS: intInRange(1, 100, 5),
  LOGIN_LOCKOUT_MINUTES: intInRange(1, 1440, 15),
  JWT_ACCESS_SECRET: z
    .string({ message: 'JWT_ACCESS_SECRET is required' })
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.preprocess(blankToUndefined, z.string().regex(/^\d+[sm]$/, 'ACCESS_TOKEN_TTL must look like 600s or 10m').default('10m')),
  REFRESH_TOKEN_IDLE_TIMEOUT_MINUTES: intInRange(5, 10_080, 480),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: intInRange(1, 168, 12),
  REFRESH_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'REFRESH_COOKIE_NAME may only contain letters, digits, _ and -')
    .default('dcs_docs_refresh'),
  REAUTH_MAX_AGE_SECONDS: intInRange(30, 3600, 300),

  // Google Workspace sign-in (OIDC Authorization Code + PKCE), an additional login method. Optional until configured.
  AUTH_PASSWORD_LOGIN_ENABLED: flag(true),
  AUTH_GOOGLE_LOGIN_ENABLED: flag(false),
  AUTH_GOOGLE_AUTO_PROVISION: flag(false),
  AUTH_GOOGLE_DEFAULT_ROLE: z.enum(['VIEWER', 'SENDER', 'ADMIN']).default('VIEWER'),
  GOOGLE_LOGIN_ENABLED: z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()).transform((v) => v === 'true'),
  GOOGLE_AUTO_PROVISION: z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()).transform((v) => v === 'true'),
  GOOGLE_AUTO_PROVISION_DEFAULT_ROLE: z.preprocess(blankToUndefined, z.enum(['VIEWER', 'SENDER', 'ADMIN']).optional()),
  ALLOWED_GOOGLE_DOMAINS: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  // Optional: defaults to <APP_PUBLIC_URL or the web origin>/api/v1/auth/google/callback.
  GOOGLE_REDIRECT_URI: z.preprocess(blankToUndefined, z.url().optional()),

  // First SUPER_ADMIN, used only by `npm run bootstrap:admin`
  SEED_SUPER_ADMIN_EMAIL: z.preprocess(blankToUndefined, z.string().trim().toLowerCase().pipe(z.email()).optional()),
  SEED_SUPER_ADMIN_NAME: z.preprocess(blankToUndefined, z.string().trim().min(1).max(100).optional()),
  SEED_SUPER_ADMIN_PASSWORD: optionalString,

  // Storage: local disk now; OCI Object Storage / S3 / MinIO later by changing these variables only
  STORAGE_DRIVER: z.enum(['local', 'oci', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: optionalString,
  STORAGE_QUARANTINE_ROOT: optionalString,
  STORAGE_MAX_FILE_SIZE_MB: intInRange(1, 100, 25),
  STORAGE_ALLOWED_MIME_TYPES: z.string().default('application/pdf'),
  OCI_REGION: optionalString,
  OCI_NAMESPACE: optionalString,
  OCI_BUCKET_NAME: optionalString,
  OCI_S3_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
  OCI_ACCESS_KEY_ID: optionalString,
  OCI_SECRET_ACCESS_KEY: optionalString,
  S3_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
  S3_REGION: optionalString,
  S3_BUCKET_NAME: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: flag(false),

  // File encryption (AES-256-GCM, per-file data key wrapped by this master key). No default: never runs without a real key.
  FILE_ENCRYPTION_MASTER_KEY: z
    .string({ message: 'FILE_ENCRYPTION_MASTER_KEY is required' })
    .refine((v) => {
      try {
        decodeMasterKey(v);
        return true;
      } catch {
        return false;
      }
    }, 'FILE_ENCRYPTION_MASTER_KEY must be 32 random bytes, base64 encoded (generate with: openssl rand -base64 32)'),
  FILE_ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/, 'FILE_ENCRYPTION_KEY_ID may only contain letters, digits, _ and - (max 32)')
    .default('v1'),
  // Previous master keys kept only while old files are re-wrapped: "v0=<base64>;v-1=<base64>"
  FILE_ENCRYPTION_PREVIOUS_KEYS: z.preprocess(
    blankToUndefined,
    z
      .string()
      .refine((v) => {
        try {
          parseKeyList(v);
          return true;
        } catch {
          return false;
        }
      }, 'FILE_ENCRYPTION_PREVIOUS_KEYS must look like id=base64;id2=base64 with 32-byte keys')
      .optional()
  ),

  // Malware scanning and PDF inspection
  MALWARE_SCAN_ENABLED: flag(true),
  CLAMAV_HOST: z.string().min(1).default('localhost'),
  CLAMAV_PORT: intInRange(1, 65535, 3310),
  CLAMAV_TIMEOUT_MS: intInRange(1000, 600_000, 60_000),
  PDF_ACTIVE_CONTENT_POLICY: z.enum(['block', 'flag']).default('block'),

  // Email: Gmail API with per-user OAuth (scope gmail.send only, separate from login). Optional until configured.
  GMAIL_OAUTH_CLIENT_ID: optionalString,
  GMAIL_OAUTH_CLIENT_SECRET: optionalString,
  // Optional: defaults to <APP_PUBLIC_URL or the web origin>/api/v1/email/connection/callback, so it follows the ports and domain.
  GMAIL_OAUTH_REDIRECT_URI: z.preprocess(blankToUndefined, z.url().optional()),
  EMAIL_TOKEN_ENCRYPTION_KEY: z
    .string({ message: 'EMAIL_TOKEN_ENCRYPTION_KEY is required' })
    .refine((v) => {
      try {
        decodeMasterKey(v);
        return true;
      } catch {
        return false;
      }
    }, 'EMAIL_TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 encoded (generate with: openssl rand -base64 32)'),
  EMAIL_MAX_ATTACHMENT_TOTAL_MB: intInRange(1, 35, 20),

  // Background jobs (Postgres-backed, in the API process)
  JOBS_ENABLED: flag(true),
  JOBS_MAX_ATTEMPTS: intInRange(1, 100, 8),
  JOBS_LEASE_MS: intInRange(1000, 3_600_000, 60_000),
  JOBS_POLL_INTERVAL_MS: intInRange(250, 3_600_000, 2000),

  // Rate limiting
  RATE_LIMIT_WINDOW_MINUTES: intInRange(1, 1440, 15),
  RATE_LIMIT_API_MAX_PER_IP: intInRange(1, 1_000_000, 600),
  RATE_LIMIT_LOGIN_MAX: intInRange(1, 100_000, 20),
  RATE_LIMIT_REFRESH_MAX: intInRange(1, 1_000_000, 120),
  RATE_LIMIT_UPLOAD_MAX_PER_HOUR: intInRange(1, 100_000, 30),
  RATE_LIMIT_DOWNLOAD_MAX_PER_HOUR: intInRange(1, 100_000, 100),
  RATE_LIMIT_SEND_MAX_PER_HOUR: intInRange(1, 100_000, 50),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

/** Cross-field rules. Production is stricter: these mistakes would silently weaken security, so the API refuses to start. */
export const envSchema = envObject.superRefine((e, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

  if (e.ACCESS_TOKEN_TTL.endsWith('m') ? Number.parseInt(e.ACCESS_TOKEN_TTL, 10) > 60 : Number.parseInt(e.ACCESS_TOKEN_TTL, 10) > 3600) {
    fail('ACCESS_TOKEN_TTL', 'ACCESS_TOKEN_TTL must not exceed 60 minutes');
  }
  if (e.SEED_SUPER_ADMIN_EMAIL && !e.SEED_SUPER_ADMIN_EMAIL.endsWith(`@${e.ALLOWED_EMAIL_DOMAIN}`)) {
    fail('SEED_SUPER_ADMIN_EMAIL', `SEED_SUPER_ADMIN_EMAIL must be an @${e.ALLOWED_EMAIL_DOMAIN} address`);
  }

  if (e.STORAGE_ALLOWED_MIME_TYPES.split(',').map((m) => m.trim()).filter(Boolean).join(',') !== 'application/pdf') {
    fail('STORAGE_ALLOWED_MIME_TYPES', 'Only application/pdf is allowed in this version');
  }
  if (e.STORAGE_DRIVER === 'local') {
    for (const k of ['STORAGE_LOCAL_ROOT', 'STORAGE_QUARANTINE_ROOT'] as const) {
      const v = e[k];
      if (!v) fail(k, `${k} is required when STORAGE_DRIVER=local`);
      else if (!path.isAbsolute(v)) fail(k, `${k} must be an absolute path outside the repository`);
    }
    if (e.STORAGE_LOCAL_ROOT && e.STORAGE_QUARANTINE_ROOT && path.resolve(e.STORAGE_LOCAL_ROOT) === path.resolve(e.STORAGE_QUARANTINE_ROOT)) {
      fail('STORAGE_QUARANTINE_ROOT', 'STORAGE_QUARANTINE_ROOT must differ from STORAGE_LOCAL_ROOT');
    }
  }
  if (e.STORAGE_DRIVER === 'oci') {
    for (const k of ['OCI_REGION', 'OCI_NAMESPACE', 'OCI_BUCKET_NAME', 'OCI_S3_ENDPOINT', 'OCI_ACCESS_KEY_ID', 'OCI_SECRET_ACCESS_KEY'] as const) {
      if (!e[k]) fail(k, `${k} is required when STORAGE_DRIVER=oci`);
    }
  }
  if (e.STORAGE_DRIVER === 's3') {
    for (const k of ['S3_REGION', 'S3_BUCKET_NAME', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      if (!e[k]) fail(k, `${k} is required when STORAGE_DRIVER=s3`);
    }
  }
  if (e.FILE_ENCRYPTION_PREVIOUS_KEYS && parseKeyList(e.FILE_ENCRYPTION_PREVIOUS_KEYS).has(e.FILE_ENCRYPTION_KEY_ID)) {
    fail('FILE_ENCRYPTION_PREVIOUS_KEYS', 'FILE_ENCRYPTION_PREVIOUS_KEYS must not reuse the current FILE_ENCRYPTION_KEY_ID');
  }

  const gmail = [e.GMAIL_OAUTH_CLIENT_ID, e.GMAIL_OAUTH_CLIENT_SECRET];
  if (gmail.some(Boolean) && !gmail.every(Boolean)) {
    fail('GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set together');
  }
  const google = [e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET];
  if (google.some(Boolean) && !google.every(Boolean)) {
    fail('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
  }
  const googleLoginActive = e.AUTH_GOOGLE_LOGIN_ENABLED || Boolean(e.GOOGLE_LOGIN_ENABLED);
  if (googleLoginActive && !google.every(Boolean)) {
    fail('AUTH_GOOGLE_LOGIN_ENABLED', 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required when Google login is enabled');
  }
  if (!e.AUTH_PASSWORD_LOGIN_ENABLED && !googleLoginActive) {
    fail('AUTH_PASSWORD_LOGIN_ENABLED', 'At least one of AUTH_PASSWORD_LOGIN_ENABLED or AUTH_GOOGLE_LOGIN_ENABLED must be true');
  }
  if (e.EMAIL_TOKEN_ENCRYPTION_KEY === e.FILE_ENCRYPTION_MASTER_KEY) {
    fail('EMAIL_TOKEN_ENCRYPTION_KEY', 'EMAIL_TOKEN_ENCRYPTION_KEY must differ from FILE_ENCRYPTION_MASTER_KEY');
  }

  const origins = parseOrigins(e.CORS_ORIGIN ?? defaultOrigin(e));
  if (origins.length === 0) fail('CORS_ORIGIN', 'CORS_ORIGIN must list at least one origin');
  for (const o of origins) {
    if (o === '*') {
      if (e.NODE_ENV === 'production') fail('CORS_ORIGIN', 'CORS_ORIGIN must list explicit origins in production ("*" is not allowed)');
    } else if (!isBareOrigin(o)) {
      fail('CORS_ORIGIN', 'CORS_ORIGIN entries must be bare origins such as https://docs.example.com (no path, no trailing slash)');
    } else if (e.NODE_ENV === 'production' && !o.startsWith('https://')) {
      fail('CORS_ORIGIN', 'CORS_ORIGIN origins must use https in production');
    }
  }

  if (e.NODE_ENV === 'production') {
    if (PLACEHOLDER.test(e.CSRF_SECRET)) {
      fail('CSRF_SECRET', 'CSRF_SECRET still has the .env.example placeholder; generate a random value for production');
    }
    if (!e.MALWARE_SCAN_ENABLED) {
      fail('MALWARE_SCAN_ENABLED', 'MALWARE_SCAN_ENABLED must be true in production');
    }
    if (PLACEHOLDER.test(e.JWT_ACCESS_SECRET)) {
      fail('JWT_ACCESS_SECRET', 'JWT_ACCESS_SECRET still has the .env.example placeholder; generate a random value for production');
    }
    if (e.JWT_ACCESS_SECRET === e.CSRF_SECRET) {
      fail('JWT_ACCESS_SECRET', 'JWT_ACCESS_SECRET and CSRF_SECRET must be different values');
    }
    if (e.BCRYPT_COST < 12) {
      fail('BCRYPT_COST', 'BCRYPT_COST must be at least 12 in production');
    }
    if (e.COOKIE_SECURE === false) {
      fail('COOKIE_SECURE', 'COOKIE_SECURE must not be false in production');
    }
    if (e.APP_PUBLIC_URL && !e.APP_PUBLIC_URL.startsWith('https://')) {
      fail('APP_PUBLIC_URL', 'APP_PUBLIC_URL must use https in production');
    }
  }
});

export type RawEnv = z.infer<typeof envSchema>;
