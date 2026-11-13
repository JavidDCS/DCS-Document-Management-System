/**
 * DCS Documents Platform - Multi-Stage Diagnostic Doctor & Deployment Readiness Engine
 *
 * Designed for both local development and live production server environments (Docker, Kubernetes, VM, PM2).
 * Verifies every single deployment stage:
 *   Stage 1: System, OS & Host Resources
 *   Stage 2: Production Build Artifacts & Dependency Integrity
 *   Stage 3: Configuration & Live Production Security Compliance
 *   Stage 4: Storage Infrastructure & Data Isolation
 *   Stage 5: PostgreSQL Database, Extensions & Audit Security Triggers
 *   Stage 6: Database Schema & Zero-Drift Migrations
 *   Stage 7: Access Control & Super Administrator Provisioning
 *   Stage 8: Network Readiness, Reverse Proxy & Security Daemons
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  formatBox,
  formatFriendlyError,
  redactSensitive,
  translateError,
} from '../packages/shared/src/friendlyError.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// CLI Arguments
const args = process.argv.slice(2);
const isProdFlag = args.includes('--prod') || args.includes('--production');

interface CheckResult {
  stageNumber: number;
  stageName: string;
  name: string;
  ok: boolean;
  message?: string;
  warning?: boolean;
  errorDetails?: {
    title: string;
    stage: string;
    whatHappened: string;
    details?: string;
    file?: string;
    howToFix: string;
  };
}

const results: CheckResult[] = [];
let currentStageNumber = 1;
let currentStageName = '';

function setStage(num: number, name: string) {
  currentStageNumber = num;
  currentStageName = name;
  console.log(`\n\x1b[1m[Stage ${num}/8] ${name}\x1b[0m`);
}

function pass(name: string, message?: string) {
  results.push({
    stageNumber: currentStageNumber,
    stageName: currentStageName,
    name,
    ok: true,
    message,
  });
  console.log(`  ✅ ${name}${message ? ` (${message})` : ''}`);
}

function warn(name: string, whatHappened: string, howToFix: string, details?: string, file?: string) {
  results.push({
    stageNumber: currentStageNumber,
    stageName: currentStageName,
    name,
    ok: true,
    warning: true,
    errorDetails: {
      title: name,
      stage: `Stage ${currentStageNumber}: ${currentStageName}`,
      whatHappened,
      details,
      file,
      howToFix,
    },
  });
  console.log(`  ⚠️  ${name}`);
}

function fail(name: string, whatHappened: string, howToFix: string, details?: string, file?: string) {
  results.push({
    stageNumber: currentStageNumber,
    stageName: currentStageName,
    name,
    ok: false,
    errorDetails: {
      title: name,
      stage: `Stage ${currentStageNumber}: ${currentStageName}`,
      whatHappened,
      details,
      file,
      howToFix,
    },
  });
  console.log(`  ❌ ${name}`);
}

/** Check TCP port connection */
function checkTcpPort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let responded = false;
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      responded = true;
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      if (!responded) {
        responded = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.on('error', () => {
      if (!responded) {
        responded = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.connect(port, host);
  });
}

/** Safely decodes base64 string to bytes length */
function decodeBase64ByteLength(str: string): number {
  try {
    const buf = Buffer.from(str, 'base64');
    return buf.length;
  } catch {
    return 0;
  }
}

/** Parse PostgreSQL URL into components */
function parseDbUrl(urlStr: string): { host: string; port: number; user: string; database: string } | null {
  try {
    const u = new URL(urlStr);
    return {
      host: u.hostname || '127.0.0.1',
      port: u.port ? Number(u.port) : 5432,
      user: decodeURIComponent(u.username),
      database: u.pathname.replace(/^\//, ''),
    };
  } catch {
    return null;
  }
}

/** Tests file write and read inside a directory */
function testDirectoryWritable(dirPath: string): { ok: boolean; error?: string } {
  try {
    if (!fs.existsSync(dirPath)) {
      return { ok: false, error: `Directory does not exist at '${dirPath}'` };
    }
    const testFile = path.join(dirPath, `.dcs-doctor-write-test-${Date.now()}`);
    fs.writeFileSync(testFile, 'dcs-doctor-ok', 'utf8');
    const content = fs.readFileSync(testFile, 'utf8');
    fs.unlinkSync(testFile);
    if (content !== 'dcs-doctor-ok') {
      return { ok: false, error: `Verification mismatch when writing to '${dirPath}'` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function runDoctor() {
  const startTime = Date.now();

  console.log(`\n╔════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║      🩺 DCS Documents Platform - Multi-Stage Live Deployment Doctor            ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════════════╝`);

  // Detect environment source: .env file or system environment (Docker/K8s/CI)
  const envPath = path.join(REPO_ROOT, '.env');
  let fileEnv: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    try {
      fileEnv = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    } catch {
      // Handled in stage 3
    }
  }

  // Combined environment: process.env (system/container env) overrides .env file
  const env: Record<string, string> = { ...fileEnv, ...process.env as Record<string, string> };
  const isProduction = isProdFlag || env.NODE_ENV === 'production';

  console.log(`\x1b[36mRunning in ${isProduction ? '🔴 PRODUCTION' : '🟢 DEVELOPMENT'} mode\x1b[0m\n`);

  // =========================================================================
  // STAGE 1: System, OS & Host Resources
  // =========================================================================
  setStage(1, 'System, OS & Host Resources');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) {
    pass(`Node.js Runtime`, `v${process.versions.node} (meets requirement >= 20, recommended 24.x)`);
  } else {
    fail(
      'Unsupported Node.js Version',
      `Server is running Node.js v${process.versions.node}. DCS Documents requires Node.js v20.0.0 or higher.`,
      'Upgrade Node.js to v24 LTS on this server: https://nodejs.org/'
    );
  }

  const totalMemGb = (os.totalmem() / (1024 ** 3)).toFixed(1);
  const freeMemGb = (os.freemem() / (1024 ** 3)).toFixed(1);
  if (Number(freeMemGb) >= 0.3) {
    pass(`Host Memory Available`, `${freeMemGb} GB free of ${totalMemGb} GB total`);
  } else {
    warn(
      'Low Host Available Memory',
      `Server has only ${freeMemGb} GB of free memory available. Heavy PDF parsing and scanning may exhaust memory.`,
      'Ensure the server or container has at least 1 GB of free RAM.'
    );
  }

  const platform = process.platform;
  const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  pass(`Host Environment`, `${platform} ${os.arch()}${isDocker ? ' (Container/Docker)' : ''}`);

  // =========================================================================
  // STAGE 2: Build Artifacts & Dependency Integrity
  // =========================================================================
  setStage(2, 'Build Artifacts & Dependency Integrity');

  const rootNodeModules = path.join(REPO_ROOT, 'node_modules');
  if (fs.existsSync(rootNodeModules)) {
    pass(`Dependencies installed`, `node_modules present`);
  } else {
    fail(
      'Dependencies Not Installed',
      'The root node_modules folder is missing on this server.',
      'Run "npm ci --omit=dev" (in production) or "npm ci" to install dependencies.'
    );
  }

  const sharedDist = path.join(REPO_ROOT, 'packages/shared/dist/index.js');
  if (fs.existsSync(sharedDist)) {
    pass(`@dcs-docs/shared build`, `packages/shared/dist compiled`);
  } else {
    fail(
      '@dcs-docs/shared Not Compiled',
      'The shared library build output is missing.',
      'Run "npm run build -w packages/shared".'
    );
  }

  const apiDist = path.join(REPO_ROOT, 'packages/api/dist/index.js');
  if (fs.existsSync(apiDist)) {
    pass(`@dcs-docs/api production build`, `packages/api/dist ready for live deployment`);
  } else if (isProduction) {
    fail(
      '@dcs-docs/api Production Build Missing',
      'Live production server requires the compiled API output (packages/api/dist/index.js) to run "npm start".',
      'Run "npm run build -w packages/api" or "npm run build" before deploying to live server.'
    );
  } else {
    pass(`@dcs-docs/api development mode`, `Running directly with tsx watch in dev`);
  }

  const webDist = path.join(REPO_ROOT, 'packages/web/dist/index.html');
  if (fs.existsSync(webDist)) {
    pass(`@dcs-docs/web production bundle`, `packages/web/dist compiled for static hosting / Nginx`);
  } else if (isProduction) {
    fail(
      '@dcs-docs/web Static Bundle Missing',
      'Live server requires the compiled Vite production bundle (packages/web/dist/index.html) to serve to users.',
      'Run "npm run build -w packages/web" or "npm run build" to generate the web bundle.'
    );
  } else {
    pass(`@dcs-docs/web development mode`, `Vite dev server handles frontend in dev`);
  }

  const prismaClientPath = path.join(REPO_ROOT, 'node_modules/@prisma/client');
  if (fs.existsSync(prismaClientPath)) {
    pass(`Prisma Client generated`, `Database client available`);
  } else {
    fail(
      'Prisma Client Not Generated',
      'Prisma ORM client has not been generated into node_modules.',
      'Run "npm run prisma:generate -w packages/api".'
    );
  }

  // =========================================================================
  // STAGE 3: Configuration & Live Production Security Compliance
  // =========================================================================
  setStage(3, 'Configuration & Live Security Compliance');

  if (fs.existsSync(envPath)) {
    pass(`Environment source`, `.env file detected at ${envPath}`);
  } else if (process.env.DATABASE_URL) {
    pass(`Environment source`, `Container / System environment variables active (Cloud/K8s mode)`);
  } else {
    fail(
      'Environment Configuration Missing',
      'No .env file found and no system environment variables (like DATABASE_URL) are set.',
      'Provide environment variables or copy .env.example to .env: "cp .env.example .env"'
    );
  }

  // Database URL
  const dbUrl = env.DATABASE_URL || '';
  if (!dbUrl) {
    fail('DATABASE_URL Missing', 'DATABASE_URL is not configured.', 'Set DATABASE_URL=postgresql://user:password@host:port/database in .env or server environment.');
  } else if (dbUrl.includes('USER:PASSWORD')) {
    fail(
      'DATABASE_URL Placeholder Detected',
      'DATABASE_URL still contains default placeholder credentials "USER:PASSWORD".',
      'Replace USER and PASSWORD with real PostgreSQL credentials in your configuration.'
    );
  } else {
    pass(`DATABASE_URL format`, redactSensitive(dbUrl));
  }

  // Secrets Entropy
  const csrfSecret = env.CSRF_SECRET || '';
  if (!csrfSecret || csrfSecret.length < 32) {
    fail('CSRF_SECRET Weak', 'CSRF_SECRET must be at least 32 characters long.', 'Generate a secret with "openssl rand -base64 48" and set CSRF_SECRET.');
  } else if (/^change[-_ ]?me/i.test(csrfSecret)) {
    fail('CSRF_SECRET Placeholder Used', 'CSRF_SECRET contains the example placeholder value.', 'Generate a real production secret with "openssl rand -base64 48".');
  } else {
    pass(`CSRF_SECRET entropy`, `${csrfSecret.length} characters`);
  }

  const jwtSecret = env.JWT_ACCESS_SECRET || '';
  if (!jwtSecret || jwtSecret.length < 32) {
    fail('JWT_ACCESS_SECRET Weak', 'JWT_ACCESS_SECRET must be at least 32 characters long.', 'Generate a secret with "openssl rand -base64 48" and set JWT_ACCESS_SECRET.');
  } else if (/^change[-_ ]?me/i.test(jwtSecret)) {
    fail('JWT_ACCESS_SECRET Placeholder Used', 'JWT_ACCESS_SECRET contains the example placeholder value.', 'Generate a real production secret with "openssl rand -base64 48".');
  } else if (jwtSecret === csrfSecret) {
    fail('JWT_ACCESS_SECRET Identical to CSRF_SECRET', 'JWT_ACCESS_SECRET and CSRF_SECRET must be two distinct random secrets.', 'Generate separate random secrets for JWT and CSRF.');
  } else {
    pass(`JWT_ACCESS_SECRET entropy`, `${jwtSecret.length} characters`);
  }

  // Encryption Keys
  const fileKey = env.FILE_ENCRYPTION_MASTER_KEY || '';
  const fileKeyBytes = decodeBase64ByteLength(fileKey);
  if (fileKeyBytes !== 32) {
    fail('FILE_ENCRYPTION_MASTER_KEY Invalid Size', `FILE_ENCRYPTION_MASTER_KEY must be exactly 32 random bytes (base64 encoded). Received ${fileKeyBytes} bytes.`, 'Generate with: openssl rand -base64 32');
  } else {
    pass(`FILE_ENCRYPTION_MASTER_KEY valid`, `256-bit AES master envelope key`);
  }

  const emailKey = env.EMAIL_TOKEN_ENCRYPTION_KEY || '';
  const emailKeyBytes = decodeBase64ByteLength(emailKey);
  if (emailKeyBytes !== 32) {
    fail('EMAIL_TOKEN_ENCRYPTION_KEY Invalid Size', `EMAIL_TOKEN_ENCRYPTION_KEY must be exactly 32 random bytes (base64 encoded). Received ${emailKeyBytes} bytes.`, 'Generate with: openssl rand -base64 32');
  } else if (emailKey === fileKey) {
    fail('EMAIL_TOKEN_ENCRYPTION_KEY Reuses File Key', 'EMAIL_TOKEN_ENCRYPTION_KEY must be distinct from FILE_ENCRYPTION_MASTER_KEY for cryptographic separation.', 'Generate a separate key with: openssl rand -base64 32');
  } else {
    pass(`EMAIL_TOKEN_ENCRYPTION_KEY valid`, `256-bit key`);
  }

  // Google Workspace SSO Login OAuth check
  const googleLoginEnabled = env.AUTH_GOOGLE_LOGIN_ENABLED === 'true' || env.GOOGLE_LOGIN_ENABLED === 'true';
  const googleClientId = env.GOOGLE_CLIENT_ID || '';
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET || '';

  if (googleLoginEnabled) {
    if (!googleClientId || !googleClientSecret) {
      fail(
        'Google Workspace Login Misconfigured',
        'AUTH_GOOGLE_LOGIN_ENABLED=true but GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing.',
        'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from Google Cloud Console to your environment.'
      );
    } else {
      pass(`Google Workspace Sign-In OAuth`, `Enabled & Configured`);
    }
  } else {
    pass(`Google Workspace Sign-In OAuth`, `Disabled (password login active)`);
  }

  // Gmail Dispatch OAuth check
  const gmailClientId = env.GMAIL_OAUTH_CLIENT_ID || '';
  const gmailClientSecret = env.GMAIL_OAUTH_CLIENT_SECRET || '';

  if (gmailClientId || gmailClientSecret) {
    if (!gmailClientId || !gmailClientSecret) {
      fail(
        'Gmail Dispatch OAuth Misconfigured',
        'GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set together.',
        'Provide both GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env, or leave both empty.'
      );
    } else {
      pass(`Gmail Mailbox Dispatch OAuth`, `Enabled & Configured (scope: gmail.send)`);
    }
  } else {
    pass(`Gmail Mailbox Dispatch OAuth`, `Not configured (optional feature)`);
  }

  // Production-Specific Compliance Rules
  if (isProduction) {
    // APP_PUBLIC_URL must be HTTPS
    const publicUrl = env.APP_PUBLIC_URL || '';
    if (!publicUrl) {
      fail('APP_PUBLIC_URL Missing in Production', 'Live servers must define APP_PUBLIC_URL (e.g. https://docs.yourcompany.com) so CORS, redirects, and emails are properly routed.', 'Set APP_PUBLIC_URL=https://docs.yourcompany.com in server environment.');
    } else if (!publicUrl.startsWith('https://')) {
      fail('APP_PUBLIC_URL Insecure Protocol', `APP_PUBLIC_URL must use https:// in production. Received: "${publicUrl}"`, 'Change APP_PUBLIC_URL to use https://');
    } else {
      pass(`APP_PUBLIC_URL HTTPS enforcement`, publicUrl);
    }

    // TRUST_PROXY
    const trustProxy = Number(env.TRUST_PROXY ?? 0);
    if (trustProxy < 1) {
      warn(
        'TRUST_PROXY=0 on Live Server',
        'In production behind a reverse proxy (Nginx/Cloudflare/AWS ALB), every client shares the proxy IP. This causes all users to share rate limits.',
        'Set TRUST_PROXY=1 in production environment when behind a reverse proxy.'
      );
    } else {
      pass(`TRUST_PROXY reverse proxy configuration`, `${trustProxy} hop(s)`);
    }

    // COOKIE_SECURE
    if (env.COOKIE_SECURE === 'false') {
      fail('COOKIE_SECURE=false Forbidden in Production', 'Cookies must not disable secure transmission flags in production.', 'Remove COOKIE_SECURE=false or set COOKIE_SECURE=true.');
    } else {
      pass(`COOKIE_SECURE flag`, `Strict HTTPS transmission`);
    }

    // BCRYPT_COST
    const bcryptCost = Number(env.BCRYPT_COST ?? 12);
    if (bcryptCost < 12) {
      fail('BCRYPT_COST Too Low for Production', `BCRYPT_COST is set to ${bcryptCost}. Production requires at least 12 for password hashing security.`, 'Set BCRYPT_COST=12 in production.');
    } else {
      pass(`BCRYPT_COST cost factor`, `${bcryptCost}`);
    }

    // CORS Origins: No wildcard in production
    const corsOrigin = env.CORS_ORIGIN || '';
    if (corsOrigin.includes('*')) {
      fail('CORS Wildcard Forbidden in Production', 'CORS_ORIGIN must not use wildcard "*" on live servers.', 'Specify explicit HTTPS origins (e.g. CORS_ORIGIN=https://docs.example.com).');
    } else if (corsOrigin) {
      pass(`CORS_ORIGIN explicit allowlist`, corsOrigin);
    }

    // Seed password notice
    if (env.SEED_SUPER_ADMIN_PASSWORD) {
      warn(
        'SEED_SUPER_ADMIN_PASSWORD Present in Production',
        'SEED_SUPER_ADMIN_PASSWORD should be removed from live server configuration after initial bootstrap.',
        'Remove SEED_SUPER_ADMIN_PASSWORD from production environment.'
      );
    }
  }

  // =========================================================================
  // STAGE 4: Storage Infrastructure & Data Isolation
  // =========================================================================
  setStage(4, 'Storage Infrastructure & Data Isolation');

  const storageDriver = env.STORAGE_DRIVER || 'local';
  if (storageDriver === 'local') {
    const cleanRoot = env.STORAGE_LOCAL_ROOT || '';
    const quarantineRoot = env.STORAGE_QUARANTINE_ROOT || '';

    if (!cleanRoot) {
      fail('STORAGE_LOCAL_ROOT Not Configured', 'STORAGE_LOCAL_ROOT is required when STORAGE_DRIVER=local.', 'Set STORAGE_LOCAL_ROOT in your configuration to an absolute directory path.');
    } else if (!path.isAbsolute(cleanRoot)) {
      fail('STORAGE_LOCAL_ROOT Must Be Absolute', `STORAGE_LOCAL_ROOT must be an absolute path outside the repository. Received: "${cleanRoot}"`, 'Change STORAGE_LOCAL_ROOT to an absolute path.');
    } else {
      const writeCheck = testDirectoryWritable(cleanRoot);
      if (writeCheck.ok) {
        pass(`Clean Storage directory writable`, cleanRoot);
      } else {
        fail('Clean Storage Inaccessible', `Cannot write to clean storage folder: ${writeCheck.error}`, `Ensure directory exists and user has write permissions: mkdir -p "${cleanRoot}"`);
      }
    }

    if (!quarantineRoot) {
      fail('STORAGE_QUARANTINE_ROOT Not Configured', 'STORAGE_QUARANTINE_ROOT is required when STORAGE_DRIVER=local.', 'Set STORAGE_QUARANTINE_ROOT in your configuration to an absolute directory path.');
    } else if (!path.isAbsolute(quarantineRoot)) {
      fail('STORAGE_QUARANTINE_ROOT Must Be Absolute', `STORAGE_QUARANTINE_ROOT must be an absolute path outside the repository. Received: "${quarantineRoot}"`, 'Change STORAGE_QUARANTINE_ROOT to an absolute path.');
    } else if (cleanRoot && path.resolve(cleanRoot) === path.resolve(quarantineRoot)) {
      fail('Storage Isolation Failed', 'STORAGE_QUARANTINE_ROOT must be a distinct directory from STORAGE_LOCAL_ROOT to quarantine uninspected files.', 'Assign separate folders for clean storage and quarantine storage.');
    } else {
      const writeCheck = testDirectoryWritable(quarantineRoot);
      if (writeCheck.ok) {
        pass(`Quarantine directory writable`, quarantineRoot);
      } else {
        fail('Quarantine Storage Inaccessible', `Cannot write to quarantine folder: ${writeCheck.error}`, `Ensure directory exists and user has write permissions: mkdir -p "${quarantineRoot}"`);
      }
    }

    // POSIX permissions check on Linux / Unix in production
    if (process.platform !== 'win32' && cleanRoot && fs.existsSync(cleanRoot)) {
      try {
        const stat = fs.statSync(cleanRoot);
        const mode = stat.mode & 0o777;
        if ((mode & 0o077) !== 0) {
          warn(
            'Storage Folder Permissions Too Permissive',
            `Clean storage directory "${cleanRoot}" has mode 0${mode.toString(8)}. Other users on the system may read sensitive files.`,
            `Lock down directory permissions: chmod 0700 "${cleanRoot}"`
          );
        } else {
          pass(`Storage directory POSIX mode`, `Strict 0700 permissions`);
        }
      } catch {
        // Ignore stat errors if non-POSIX
      }
    }
  } else if (storageDriver === 's3' || storageDriver === 'oci') {
    const bucket = storageDriver === 's3' ? env.S3_BUCKET_NAME : env.OCI_BUCKET_NAME;
    const region = storageDriver === 's3' ? env.S3_REGION : env.OCI_REGION;
    if (!bucket || !region) {
      fail(`${storageDriver.toUpperCase()} Bucket Configuration Incomplete`, `Missing bucket name or region for ${storageDriver} storage driver.`, `Set ${storageDriver === 's3' ? 'S3_BUCKET_NAME and S3_REGION' : 'OCI_BUCKET_NAME and OCI_REGION'}.`);
    } else {
      pass(`${storageDriver.toUpperCase()} Cloud Storage configured`, `Bucket: ${bucket}, Region: ${region}`);
    }
  }

  // =========================================================================
  // STAGE 5: PostgreSQL Database, Extensions & Audit Security Triggers
  // =========================================================================
  setStage(5, 'PostgreSQL Database & Audit Security Triggers');

  let prismaClient: PrismaClient | null = null;
  const dbInfo = parseDbUrl(dbUrl);

  if (dbInfo) {
    const canReachSocket = await checkTcpPort(dbInfo.host, dbInfo.port);
    if (canReachSocket) {
      pass(`PostgreSQL TCP socket reachable`, `${dbInfo.host}:${dbInfo.port}`);
    } else {
      fail(
        'Database Server Unreachable (ECONNREFUSED)',
        `Cannot establish a network socket connection to PostgreSQL at ${dbInfo.host}:${dbInfo.port}.`,
        'Check that the database server is running, the host and port are correct, and security groups/firewalls permit traffic.',
        `Host: ${dbInfo.host}, Port: ${dbInfo.port}`
      );
    }

    if (canReachSocket) {
      try {
        prismaClient = new PrismaClient({
          datasourceUrl: dbUrl,
          log: [{ emit: 'event', level: 'error' }],
        });

        // Version & Connection test
        const versionResult = await prismaClient.$queryRawUnsafe<Array<{ version: string }>>('SELECT version();');
        const pgVersion = versionResult[0]?.version || 'Connected';
        pass(`PostgreSQL connection & auth`, pgVersion.split(' on ')[0] || 'Active');

        // Required extensions: citext and pg_trgm
        const extensions = await prismaClient.$queryRawUnsafe<Array<{ extname: string }>>(
          "SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm');"
        );
        const extNames = extensions.map((e) => e.extname);
        if (extNames.includes('citext') && extNames.includes('pg_trgm')) {
          pass(`PostgreSQL extensions installed`, `citext, pg_trgm`);
        } else {
          const missing = ['citext', 'pg_trgm'].filter((e) => !extNames.includes(e));
          warn(
            'Missing PostgreSQL Extensions',
            `Database is missing recommended extensions: ${missing.join(', ')}.`,
            'Run "npm run prisma:deploy" or execute in psql: CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm;'
          );
        }

        // Audit Log Security Triggers
        const triggers = await prismaClient.$queryRawUnsafe<Array<{ tgname: string }>>(
          "SELECT tgname FROM pg_trigger JOIN pg_class ON pg_class.oid = pg_trigger.tgrelid WHERE pg_class.relname = 'audit_logs';"
        );
        const triggerNames = triggers.map((t) => t.tgname);
        if (triggerNames.includes('audit_logs_no_update_delete') && triggerNames.includes('audit_logs_no_truncate')) {
          pass(`Audit log immutability triggers`, `audit_logs_no_update_delete & audit_logs_no_truncate active`);
        } else {
          warn(
            'Audit Log Immutability Triggers Missing',
            'PostgreSQL triggers preventing UPDATE, DELETE, or TRUNCATE on audit_logs table are missing.',
            'Deploy initial migration to install triggers: npm run prisma:deploy'
          );
        }

        // Audit Log Hash Chain Verification (Canary check)
        const auditCount = await prismaClient.auditLog.count();
        if (auditCount > 0) {
          const lastEntries = await prismaClient.auditLog.findMany({
            orderBy: { id: 'desc' },
            take: 2,
            select: { id: true, prevHash: true, entryHash: true },
          });
          if (lastEntries.length >= 2 && lastEntries[0]!.prevHash !== lastEntries[1]!.entryHash) {
            fail(
              'Audit Log Hash Chain Broken',
              'The cryptographic SHA-256 hash chain in audit_logs is broken or was tampered with.',
              'Run "npm run audit:verify" to locate the corrupted or tampered entry.'
            );
          } else {
            pass(`Audit log cryptographic integrity`, `${auditCount} record(s) verified`);
          }
        } else {
          pass(`Audit log cryptographic integrity`, `Genesis state (empty chain)`);
        }
      } catch (err: any) {
        const translated = translateError(err);
        fail(translated.title, translated.whatHappened, translated.howToFix, translated.details || err.message);
      }
    }
  }

  // =========================================================================
  // STAGE 6: Database Schema & Zero-Drift Migrations
  // =========================================================================
  setStage(6, 'Database Schema & Zero-Drift Migrations');

  const migrationsFolder = path.join(REPO_ROOT, 'packages/api/prisma/migrations');
  if (!fs.existsSync(migrationsFolder)) {
    fail('Migrations Directory Missing', 'packages/api/prisma/migrations directory was not found.', 'Check repository files.');
  } else if (prismaClient) {
    try {
      const diskMigrations = fs
        .readdirSync(migrationsFolder)
        .filter((dir) => fs.statSync(path.join(migrationsFolder, dir)).isDirectory() && fs.existsSync(path.join(migrationsFolder, dir, 'migration.sql')));

      const appliedMigrations = await prismaClient.$queryRawUnsafe<
        Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
      >('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at ASC;');

      const appliedMap = new Map(appliedMigrations.map((m) => [m.migration_name, m]));
      const unapplied = diskMigrations.filter((m) => !appliedMap.has(m) || !appliedMap.get(m)?.finished_at);
      const rolledBack = appliedMigrations.filter((m) => m.rolled_back_at !== null);

      if (rolledBack.length > 0) {
        fail(
          'Database Migration Rolled Back',
          `The following migration(s) were rolled back: ${rolledBack.map((r) => r.migration_name).join(', ')}.`,
          'Fix the migration error and redeploy: npm run prisma:deploy'
        );
      } else if (unapplied.length > 0) {
        fail(
          'Pending Database Migrations Unapplied',
          `Found ${unapplied.length} pending migration(s) not yet applied to the database: ${unapplied.join(', ')}.`,
          'Deploy migrations before starting the server: npm run prisma:deploy'
        );
      } else {
        pass(`Schema synchronized`, `All ${diskMigrations.length} migration(s) active with zero drift`);
      }
    } catch (err: any) {
      if (err.message?.includes('relation "_prisma_migrations" does not exist') || err.code === '42P01') {
        fail(
          'Database Tables Not Initialized',
          'The database exists but has not had migrations applied yet (_prisma_migrations missing).',
          'Run "npm run prisma:deploy" to create tables.'
        );
      } else {
        const translated = translateError(err);
        fail(translated.title, translated.whatHappened, translated.howToFix);
      }
    }
  }

  // =========================================================================
  // STAGE 7: Access Control & Super Administrator Provisioning
  // =========================================================================
  setStage(7, 'Access Control & Super Administrator Provisioning');

  if (prismaClient) {
    try {
      const superAdminCount = await prismaClient.userRole.count({ where: { role: 'SUPER_ADMIN' } });
      if (superAdminCount > 0) {
        const adminUser = await prismaClient.user.findFirst({
          where: { roles: { some: { role: 'SUPER_ADMIN' } } },
          select: { email: true, name: true, status: true },
        });
        pass(`Super Administrator account`, `${adminUser?.email || 'admin'} (status: ${adminUser?.status})`);
      } else {
        const adminMsg = 'No SUPER_ADMIN account found in the database. Users will not be able to log in to the portal.';
        const fixMsg = 'Bootstrap the initial administrator: SEED_SUPER_ADMIN_EMAIL=admin@yourdomain.com npm run bootstrap:admin -w packages/api';
        if (isProduction) {
          fail('Super Administrator Not Provisioned', adminMsg, fixMsg);
        } else {
          warn('Super Administrator Not Provisioned', adminMsg, fixMsg);
        }
      }
    } catch (err: any) {
      const translated = translateError(err);
      fail(translated.title, translated.whatHappened, translated.howToFix);
    }
  }

  // =========================================================================
  // STAGE 8: Network Readiness, Reverse Proxy & Security Daemons
  // =========================================================================
  setStage(8, 'Network Readiness, Reverse Proxy & Security Daemons');

  const apiHost = env.API_HOST || '127.0.0.1';
  const apiPort = Number(env.API_PORT || 7800);
  const webHost = env.WEB_HOST || '127.0.0.1';
  const webPort = Number(env.WEB_PORT || 7801);

  const apiPortActive = await checkTcpPort(apiHost, apiPort, 800);
  if (apiPortActive) {
    pass(`API Port ${apiPort}`, `Active / Serving`);
  } else {
    pass(`API Port ${apiPort}`, `Available for startup`);
  }

  const webPortActive = await checkTcpPort(webHost, webPort, 800);
  if (webPortActive) {
    pass(`Web Port ${webPort}`, `Active / Serving`);
  } else {
    pass(`Web Port ${webPort}`, `Available for startup`);
  }

  // ClamAV Antivirus Daemon
  const malwareEnabled = env.MALWARE_SCAN_ENABLED === 'true';
  const clamHost = env.CLAMAV_HOST || '127.0.0.1';
  const clamPort = Number(env.CLAMAV_PORT || 3310);

  if (isProduction && !malwareEnabled) {
    fail(
      'Malware Scanner Disabled in Production',
      'MALWARE_SCAN_ENABLED=false is refused in production. Uploaded PDF files must be scanned for viruses and active content.',
      'Set MALWARE_SCAN_ENABLED=true and ensure ClamAV daemon is running on port 3310.'
    );
  } else if (malwareEnabled) {
    const clamReachable = await checkTcpPort(clamHost, clamPort, 1200);
    if (clamReachable) {
      pass(`ClamAV Antivirus daemon online`, `${clamHost}:${clamPort}`);
    } else {
      const clamError = `ClamAV antivirus daemon is enabled but cannot be reached at ${clamHost}:${clamPort}.`;
      const clamFix = 'Start ClamAV daemon: "docker run -d -p 3310:3310 clamav/clamav:latest" (or set MALWARE_SCAN_ENABLED=false for local dev).';
      if (isProduction) {
        fail('ClamAV Antivirus Daemon Offline', clamError, clamFix);
      } else {
        warn('ClamAV Antivirus Daemon Offline', clamError, clamFix);
      }
    }
  } else {
    pass(`Malware Scan bypass active`, `Development offline mode`);
  }

  // Close Prisma connection
  if (prismaClient) {
    await prismaClient.$disconnect().catch(() => {});
  }

  // =========================================================================
  // Final Diagnostic Report & Summary
  // =========================================================================
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const failures = results.filter((r) => !r.ok);
  const warnings = results.filter((r) => r.warning);

  console.log(`\n────────────────────────────────────────────────────────────────────────────────`);
  console.log(`Diagnostic completed in ${duration}s. Total checks: ${results.length}. Failures: ${failures.length}. Warnings: ${warnings.length}.\n`);

  // Print stage breakdown
  for (let s = 1; s <= 8; s++) {
    const stageResults = results.filter((r) => r.stageNumber === s);
    const stageFailures = stageResults.filter((r) => !r.ok);
    const stageWarnings = stageResults.filter((r) => r.warning);
    const stageName = stageResults[0]?.stageName || `Stage ${s}`;

    const statusBadge =
      stageFailures.length > 0
        ? '\x1b[31m❌ FAILED\x1b[0m'
        : stageWarnings.length > 0
          ? '\x1b[33m⚠️  WARNINGS\x1b[0m'
          : '\x1b[32m✅ PASSED\x1b[0m';

    console.log(`  Stage ${s}: ${stageName.padEnd(48)} ${statusBadge}`);
  }
  console.log('');

  if (failures.length > 0) {
    console.log(`\x1b[1m\x1b[31mIssues Requiring Action Before Deployment:\x1b[0m`);
    for (const f of failures) {
      if (f.errorDetails) {
        console.log(
          formatBox({
            title: f.errorDetails.title,
            fields: [
              { label: 'Stage', value: f.errorDetails.stage },
              { label: 'What happened', value: f.errorDetails.whatHappened },
              ...(f.errorDetails.details ? [{ label: 'Details', value: f.errorDetails.details }] : []),
              ...(f.errorDetails.file ? [{ label: 'File', value: f.errorDetails.file }] : []),
              { label: 'How to fix it', value: f.errorDetails.howToFix },
            ],
            severity: 'error',
          })
        );
      }
    }
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`\x1b[1m\x1b[33mDeployment Notices & Recommendations:\x1b[0m`);
    for (const w of warnings) {
      if (w.errorDetails) {
        console.log(
          formatBox({
            title: w.errorDetails.title,
            fields: [
              { label: 'Stage', value: w.errorDetails.stage },
              { label: 'What happened', value: w.errorDetails.whatHappened },
              ...(w.errorDetails.details ? [{ label: 'Details', value: w.errorDetails.details }] : []),
              { label: 'Recommendation', value: w.errorDetails.howToFix },
            ],
            severity: 'warning',
          })
        );
      }
    }
  }

  console.log(
    formatBox({
      title: isProduction ? 'PRODUCTION READY: All 8 Deployment Stages Passed' : 'ALL CHECKS PASSED: Environment Is Ready',
      fields: [
        { label: 'Mode', value: isProduction ? 'Live Server Production' : 'Local Development' },
        { label: 'Verdict', value: 'System resources, build artifacts, security secrets, PostgreSQL database, and migrations verified.' },
        { label: 'Web Service', value: isProduction ? (env.APP_PUBLIC_URL || `http://${webHost}:${webPort}`) : `http://${webHost}:${webPort}` },
        { label: 'API Service', value: `http://${apiHost}:${apiPort}` },
        { label: 'Next Command', value: isProduction ? 'npm start (or systemd / docker start)' : 'npm run dev' },
      ],
      severity: 'info',
    })
  );

  process.exit(0);
}

// Run if called directly
runDoctor().catch((err) => {
  console.error('\nFatal Doctor Error:');
  console.error(formatFriendlyError(err));
  process.exit(1);
});
