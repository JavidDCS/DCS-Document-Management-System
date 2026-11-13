/**
 * DCS Documents Platform - Diagnostic Doctor Script
 * Validates Node runtime, dependencies, .env secrets, PostgreSQL database,
 * migrations, storage directories, super admin status, and ports.
 *
 * Runs in under 2 seconds and speaks plain, friendly English for every issue.
 */

import fs from 'node:fs';
import net from 'node:net';
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

interface CheckResult {
  category: string;
  name: string;
  ok: boolean;
  message?: string;
  warning?: boolean;
  errorDetails?: {
    title: string;
    whatHappened: string;
    details?: string;
    file?: string;
    howToFix: string;
  };
}

const results: CheckResult[] = [];

function pass(category: string, name: string, message?: string) {
  results.push({ category, name, ok: true, message });
  console.log(`  ✅ ${name}${message ? ` (${message})` : ''}`);
}

function warn(category: string, name: string, whatHappened: string, howToFix: string, details?: string) {
  results.push({
    category,
    name,
    ok: true,
    warning: true,
    errorDetails: {
      title: name,
      whatHappened,
      details,
      howToFix,
    },
  });
  console.log(`  ⚠️  ${name}`);
}

function fail(category: string, name: string, whatHappened: string, howToFix: string, details?: string) {
  results.push({
    category,
    name,
    ok: false,
    errorDetails: {
      title: name,
      whatHappened,
      details,
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

async function runDoctor() {
  const startTime = Date.now();

  console.log(`\n╔════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║             🩺 DCS Documents Platform - System Health Doctor                   ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════════════╝\n`);

  // =========================================================================
  // 1. Runtime & Environment
  // =========================================================================
  console.log(`\x1b[1m[1/7] Checking Runtime & Dependencies...\x1b[0m`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) {
    pass('Runtime', `Node.js version`, `v${process.versions.node} (meets requirement >= 20)`);
  } else {
    fail(
      'Runtime',
      'Outdated Node.js Version',
      `You are running Node.js v${process.versions.node}. DCS Documents requires Node.js v20.0.0 or higher (v24.x recommended).`,
      'Please install Node.js v24 from https://nodejs.org/'
    );
  }

  const rootNodeModules = path.join(REPO_ROOT, 'node_modules');
  if (fs.existsSync(rootNodeModules)) {
    pass('Dependencies', 'Root node_modules present');
  } else {
    fail(
      'Dependencies',
      'Missing Dependencies',
      'Project node_modules directory was not found.',
      'Run "npm ci" or "npm install" at the repository root.'
    );
  }

  const sharedDist = path.join(REPO_ROOT, 'packages/shared/dist/index.js');
  if (fs.existsSync(sharedDist)) {
    pass('Dependencies', '@dcs-docs/shared build', 'compiled');
  } else {
    fail(
      'Dependencies',
      'Shared Package Not Built',
      'The @dcs-docs/shared package dist folder is missing.',
      'Run "npm run build -w packages/shared" to compile the shared library.'
    );
  }

  const prismaClientPath = path.join(REPO_ROOT, 'node_modules/@prisma/client');
  if (fs.existsSync(prismaClientPath)) {
    pass('Dependencies', 'Prisma Client generated');
  } else {
    fail(
      'Dependencies',
      'Prisma Client Missing',
      'Prisma database client has not been generated.',
      'Run "npm run prisma:generate -w packages/api".'
    );
  }

  // =========================================================================
  // 2. Configuration & .env File
  // =========================================================================
  console.log(`\n\x1b[1m[2/7] Checking .env Configuration & Cryptographic Secrets...\x1b[0m`);
  const envPath = path.join(REPO_ROOT, '.env');
  let envValues: Record<string, string> = {};

  if (!fs.existsSync(envPath)) {
    fail(
      'Configuration',
      '.env File Missing',
      'No .env file was found in the project root directory.',
      'Copy .env.example to .env: "copy .env.example .env" and fill in your database credentials and secret keys.',
      envPath
    );
  } else {
    pass('Configuration', '.env file exists', envPath);
    try {
      const rawEnv = fs.readFileSync(envPath, 'utf8');
      envValues = dotenv.parse(rawEnv);
    } catch (err) {
      fail(
        'Configuration',
        '.env Syntax Error',
        `Failed to parse .env file: ${(err as Error).message}`,
        'Check the syntax in your .env file for unclosed quotes or invalid characters.',
        envPath
      );
    }
  }

  const dbUrl = envValues.DATABASE_URL || '';
  if (!dbUrl) {
    fail('Configuration', 'DATABASE_URL Missing', 'DATABASE_URL is not set in your .env file.', 'Add DATABASE_URL=postgresql://user:password@127.0.0.1:5432/dcs_docs to .env');
  } else if (dbUrl.includes('USER:PASSWORD')) {
    fail(
      'Configuration',
      'DATABASE_URL Placeholder Detected',
      'DATABASE_URL still contains the default placeholder "USER:PASSWORD".',
      'Replace USER and PASSWORD with your actual local PostgreSQL credentials in .env.'
    );
  } else {
    pass('Configuration', 'DATABASE_URL format', redactSensitive(dbUrl));
  }

  const dbUrlTest = envValues.DATABASE_URL_TEST || '';
  if (dbUrlTest && !dbUrlTest.includes('_test')) {
    fail(
      'Configuration',
      'DATABASE_URL_TEST Safety Rule Violated',
      'DATABASE_URL_TEST must point to a database name ending with "_test" to protect production and development data.',
      'Update the database name in DATABASE_URL_TEST to end with "_test", e.g. "dcs_docs_test".'
    );
  } else if (dbUrlTest) {
    pass('Configuration', 'DATABASE_URL_TEST format', redactSensitive(dbUrlTest));
  }

  const csrfSecret = envValues.CSRF_SECRET || '';
  if (!csrfSecret || csrfSecret.length < 32) {
    fail('Configuration', 'CSRF_SECRET Too Weak', 'CSRF_SECRET must be at least 32 characters long.', 'Generate a secret in your terminal: openssl rand -base64 48 and set CSRF_SECRET in .env');
  } else if (/^change[-_ ]?me/i.test(csrfSecret)) {
    fail('Configuration', 'CSRF_SECRET Placeholder Used', 'CSRF_SECRET still contains the example placeholder.', 'Generate a fresh random secret with: openssl rand -base64 48 and update CSRF_SECRET in .env');
  } else {
    pass('Configuration', 'CSRF_SECRET entropy', `${csrfSecret.length} characters`);
  }

  const jwtSecret = envValues.JWT_ACCESS_SECRET || '';
  if (!jwtSecret || jwtSecret.length < 32) {
    fail('Configuration', 'JWT_ACCESS_SECRET Too Weak', 'JWT_ACCESS_SECRET must be at least 32 characters long.', 'Generate a secret in your terminal: openssl rand -base64 48 and set JWT_ACCESS_SECRET in .env');
  } else if (/^change[-_ ]?me/i.test(jwtSecret)) {
    fail('Configuration', 'JWT_ACCESS_SECRET Placeholder Used', 'JWT_ACCESS_SECRET still contains the example placeholder.', 'Generate a fresh random secret with: openssl rand -base64 48 and update JWT_ACCESS_SECRET in .env');
  } else if (jwtSecret === csrfSecret) {
    fail('Configuration', 'JWT_ACCESS_SECRET and CSRF_SECRET Identical', 'JWT_ACCESS_SECRET and CSRF_SECRET must be two distinct secrets.', 'Generate separate secrets for JWT_ACCESS_SECRET and CSRF_SECRET.');
  } else {
    pass('Configuration', 'JWT_ACCESS_SECRET entropy', `${jwtSecret.length} characters`);
  }

  const fileKey = envValues.FILE_ENCRYPTION_MASTER_KEY || '';
  const fileKeyBytes = decodeBase64ByteLength(fileKey);
  if (fileKeyBytes !== 32) {
    fail(
      'Configuration',
      'FILE_ENCRYPTION_MASTER_KEY Invalid Size',
      `FILE_ENCRYPTION_MASTER_KEY must be exactly 32 random bytes (base64 encoded). Received ${fileKeyBytes} bytes.`,
      'Generate a 32-byte key with: openssl rand -base64 32 and update FILE_ENCRYPTION_MASTER_KEY in .env.'
    );
  } else {
    pass('Configuration', 'FILE_ENCRYPTION_MASTER_KEY valid', '256-bit AES master key');
  }

  const emailKey = envValues.EMAIL_TOKEN_ENCRYPTION_KEY || '';
  const emailKeyBytes = decodeBase64ByteLength(emailKey);
  if (emailKeyBytes !== 32) {
    fail(
      'Configuration',
      'EMAIL_TOKEN_ENCRYPTION_KEY Invalid Size',
      `EMAIL_TOKEN_ENCRYPTION_KEY must be exactly 32 random bytes (base64 encoded). Received ${emailKeyBytes} bytes.`,
      'Generate a 32-byte key with: openssl rand -base64 32 and update EMAIL_TOKEN_ENCRYPTION_KEY in .env.'
    );
  } else if (emailKey === fileKey) {
    fail(
      'Configuration',
      'EMAIL_TOKEN_ENCRYPTION_KEY Reuses File Key',
      'EMAIL_TOKEN_ENCRYPTION_KEY must be different from FILE_ENCRYPTION_MASTER_KEY for domain separation.',
      'Generate a separate 32-byte key for EMAIL_TOKEN_ENCRYPTION_KEY with: openssl rand -base64 32'
    );
  } else {
    pass('Configuration', 'EMAIL_TOKEN_ENCRYPTION_KEY valid', '256-bit key');
  }

  // =========================================================================
  // 3. Storage & Quarantine Directories
  // =========================================================================
  console.log(`\n\x1b[1m[3/7] Checking Storage & Quarantine Directories...\x1b[0m`);
  const storageDriver = envValues.STORAGE_DRIVER || 'local';

  if (storageDriver === 'local') {
    const cleanRoot = envValues.STORAGE_LOCAL_ROOT || '';
    const quarantineRoot = envValues.STORAGE_QUARANTINE_ROOT || '';

    if (!cleanRoot) {
      fail('Storage', 'STORAGE_LOCAL_ROOT Not Set', 'STORAGE_LOCAL_ROOT is required when STORAGE_DRIVER=local.', 'Set STORAGE_LOCAL_ROOT in .env (e.g. D:/DCS-Docs-Data/storage)');
    } else if (!path.isAbsolute(cleanRoot)) {
      fail('Storage', 'STORAGE_LOCAL_ROOT Not Absolute', `STORAGE_LOCAL_ROOT must be an absolute path. Received: "${cleanRoot}"`, 'Change STORAGE_LOCAL_ROOT to an absolute path outside the repository.');
    } else {
      const writeCheck = testDirectoryWritable(cleanRoot);
      if (writeCheck.ok) {
        pass('Storage', 'Clean Storage Root writable', cleanRoot);
      } else {
        fail('Storage', 'Clean Storage Root Inaccessible', `Cannot access or write to clean storage root: ${writeCheck.error}`, `Ensure directory exists and has write permissions: New-Item -ItemType Directory -Force -Path "${cleanRoot}"`);
      }
    }

    if (!quarantineRoot) {
      fail('Storage', 'STORAGE_QUARANTINE_ROOT Not Set', 'STORAGE_QUARANTINE_ROOT is required when STORAGE_DRIVER=local.', 'Set STORAGE_QUARANTINE_ROOT in .env (e.g. D:/DCS-Docs-Data/quarantine)');
    } else if (!path.isAbsolute(quarantineRoot)) {
      fail('Storage', 'STORAGE_QUARANTINE_ROOT Not Absolute', `STORAGE_QUARANTINE_ROOT must be an absolute path. Received: "${quarantineRoot}"`, 'Change STORAGE_QUARANTINE_ROOT to an absolute path outside the repository.');
    } else if (cleanRoot && path.resolve(cleanRoot) === path.resolve(quarantineRoot)) {
      fail('Storage', 'Storage and Quarantine Roots Identical', 'STORAGE_QUARANTINE_ROOT must be a different folder from STORAGE_LOCAL_ROOT for isolation.', 'Set separate folders for clean storage and quarantine storage.');
    } else {
      const writeCheck = testDirectoryWritable(quarantineRoot);
      if (writeCheck.ok) {
        pass('Storage', 'Quarantine Storage Root writable', quarantineRoot);
      } else {
        fail('Storage', 'Quarantine Storage Root Inaccessible', `Cannot access or write to quarantine storage root: ${writeCheck.error}`, `Ensure directory exists and has write permissions: New-Item -ItemType Directory -Force -Path "${quarantineRoot}"`);
      }
    }
  } else {
    pass('Storage', `Storage Driver configured`, storageDriver);
  }

  // =========================================================================
  // 4. PostgreSQL Database & Connectivity
  // =========================================================================
  console.log(`\n\x1b[1m[4/7] Checking PostgreSQL Database & Extensions...\x1b[0m`);
  let prismaClient: PrismaClient | null = null;
  const dbInfo = parseDbUrl(dbUrl);

  if (!dbInfo) {
    fail('Database', 'Malformed DATABASE_URL', 'Could not parse host and port from DATABASE_URL in .env.', 'Verify DATABASE_URL follows standard: postgresql://user:password@host:port/database');
  } else {
    // 4.1 TCP socket ping
    const canReachSocket = await checkTcpPort(dbInfo.host, dbInfo.port);
    if (canReachSocket) {
      pass('Database', `PostgreSQL socket reachable`, `${dbInfo.host}:${dbInfo.port}`);
    } else {
      fail(
        'Database',
        'PostgreSQL Server Unreachable (ECONNREFUSED)',
        `Cannot establish a network socket connection to PostgreSQL at ${dbInfo.host}:${dbInfo.port}.`,
        'Verify your PostgreSQL server service is running: in Windows PowerShell run "Get-Service *postgres*" or start it in Services.',
        `Host: ${dbInfo.host}, Port: ${dbInfo.port}`
      );
    }

    // 4.2 Prisma client connection & authentication
    if (canReachSocket) {
      try {
        prismaClient = new PrismaClient({
          datasourceUrl: dbUrl,
          log: [{ emit: 'event', level: 'error' }],
        });

        // Test basic query
        const versionResult = await prismaClient.$queryRawUnsafe<Array<{ version: string }>>('SELECT version();');
        const pgVersion = versionResult[0]?.version || 'Unknown';
        pass('Database', 'PostgreSQL authentication & connection', pgVersion.split(' on ')[0] || 'Connected');

        // Check required extensions (citext and pg_trgm)
        const extensions = await prismaClient.$queryRawUnsafe<Array<{ extname: string }>>(
          "SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm');"
        );
        const extNames = extensions.map((e) => e.extname);
        if (extNames.includes('citext') && extNames.includes('pg_trgm')) {
          pass('Database', 'PostgreSQL extensions installed', 'citext, pg_trgm');
        } else {
          const missing = ['citext', 'pg_trgm'].filter((e) => !extNames.includes(e));
          warn(
            'Database',
            'Missing PostgreSQL Extensions',
            `Database is missing recommended extensions: ${missing.join(', ')}.`,
            'Run "npm run prisma:deploy" or execute in psql: CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm;'
          );
        }
      } catch (err: any) {
        const translated = translateError(err);
        fail(
          'Database',
          translated.title,
          translated.whatHappened,
          translated.howToFix,
          translated.details || err.message
        );
      }
    }
  }

  // =========================================================================
  // 5. Database Migrations Status
  // =========================================================================
  console.log(`\n\x1b[1m[5/7] Checking Database Migrations...\x1b[0m`);
  const migrationsFolder = path.join(REPO_ROOT, 'packages/api/prisma/migrations');

  if (!fs.existsSync(migrationsFolder)) {
    fail(
      'Migrations',
      'Migrations Directory Missing',
      'The prisma/migrations folder was not found.',
      'Check repository files or recreate migrations with Prisma.'
    );
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
          'Migrations',
          'Rolled Back Migration Detected',
          `The following migration(s) were recorded as rolled back: ${rolledBack.map((r) => r.migration_name).join(', ')}.`,
          'Investigate failed migration SQL and redeploy with "npm run prisma:deploy".'
        );
      } else if (unapplied.length > 0) {
        fail(
          'Migrations',
          'Pending Migrations Unapplied',
          `Found ${unapplied.length} migration(s) on disk that have not been applied to the database: ${unapplied.join(', ')}.`,
          'Apply all pending migrations by running: npm run prisma:deploy'
        );
      } else {
        pass('Migrations', 'All migrations applied', `${diskMigrations.length} migration(s) active`);
      }
    } catch (err: any) {
      if (err.message?.includes('relation "_prisma_migrations" does not exist') || err.code === '42P01') {
        fail(
          'Migrations',
          'No Migrations Applied Yet',
          'The database exists but contains no schema migrations yet (_prisma_migrations table missing).',
          'Deploy the initial schema by running: npm run prisma:deploy'
        );
      } else {
        const translated = translateError(err);
        fail('Migrations', translated.title, translated.whatHappened, translated.howToFix);
      }
    }
  }

  // =========================================================================
  // 6. Super Admin Account
  // =========================================================================
  console.log(`\n\x1b[1m[6/7] Checking Super Administrator Account...\x1b[0m`);
  if (prismaClient) {
    try {
      const superAdminCount = await prismaClient.userRole.count({ where: { role: 'SUPER_ADMIN' } });
      if (superAdminCount > 0) {
        const adminUser = await prismaClient.user.findFirst({
          where: { roles: { some: { role: 'SUPER_ADMIN' } } },
          select: { email: true, name: true, status: true },
        });
        pass('Security', 'SUPER_ADMIN account exists', `${adminUser?.email || 'admin'} (${adminUser?.status})`);
      } else {
        warn(
          'Security',
          'No SUPER_ADMIN Account Found',
          'The database has no Super Administrator account configured yet. You will not be able to log in to the portal.',
          'Bootstrap your first admin account by running: npm run bootstrap:admin -w packages/api'
        );
      }
    } catch (err: any) {
      const translated = translateError(err);
      fail('Security', translated.title, translated.whatHappened, translated.howToFix);
    }
  }

  // =========================================================================
  // 7. Network Ports & ClamAV Status
  // =========================================================================
  console.log(`\n\x1b[1m[7/7] Checking Network Ports & Services...\x1b[0m`);
  const apiHost = envValues.API_HOST || '127.0.0.1';
  const apiPort = Number(envValues.API_PORT || 7800);
  const webHost = envValues.WEB_HOST || '127.0.0.1';
  const webPort = Number(envValues.WEB_PORT || 7801);

  const apiPortInUse = await checkTcpPort(apiHost, apiPort, 800);
  if (apiPortInUse) {
    pass('Network', `API Port ${apiPort} active`, 'DCS API dev server is running');
  } else {
    pass('Network', `API Port ${apiPort} available`, 'Ready for "npm run dev"');
  }

  const webPortInUse = await checkTcpPort(webHost, webPort, 800);
  if (webPortInUse) {
    pass('Network', `Web Port ${webPort} active`, 'DCS Web dev server is running');
  } else {
    pass('Network', `Web Port ${webPort} available`, 'Ready for "npm run dev"');
  }

  // ClamAV
  const malwareEnabled = envValues.MALWARE_SCAN_ENABLED === 'true';
  if (malwareEnabled) {
    const clamHost = envValues.CLAMAV_HOST || 'localhost';
    const clamPort = Number(envValues.CLAMAV_PORT || 3310);
    const clamReachable = await checkTcpPort(clamHost, clamPort, 1000);
    if (clamReachable) {
      pass('Services', 'ClamAV daemon reachable', `${clamHost}:${clamPort}`);
    } else {
      fail(
        'Services',
        'ClamAV Service Unreachable',
        `MALWARE_SCAN_ENABLED=true in .env, but ClamAV daemon is not reachable on ${clamHost}:${clamPort}.`,
        'Start ClamAV via Docker (docker run -d -p 3310:3310 clamav/clamav) or set MALWARE_SCAN_ENABLED=false in .env for offline development.'
      );
    }
  } else {
    pass('Services', 'Malware Scan bypass enabled', 'Development offline mode');
  }

  // Close Prisma connection cleanly
  if (prismaClient) {
    await prismaClient.$disconnect().catch(() => {});
  }

  // =========================================================================
  // Final Diagnostic Report
  // =========================================================================
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const failures = results.filter((r) => !r.ok);
  const warnings = results.filter((r) => r.warning);

  console.log(`\n────────────────────────────────────────────────────────────────────────────────`);
  console.log(`Diagnostic completed in ${duration}s. Total checks: ${results.length}. Failures: ${failures.length}. Warnings: ${warnings.length}.\n`);

  if (failures.length > 0) {
    console.log(`\x1b[1m\x1b[31mThe following issue(s) were found:\x1b[0m`);
    for (const f of failures) {
      if (f.errorDetails) {
        console.log(
          formatBox({
            title: f.errorDetails.title,
            fields: [
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
    console.log(`\x1b[1m\x1b[33mNotices & Warnings:\x1b[0m`);
    for (const w of warnings) {
      if (w.errorDetails) {
        console.log(
          formatBox({
            title: w.errorDetails.title,
            fields: [
              { label: 'What happened', value: w.errorDetails.whatHappened },
              ...(w.errorDetails.details ? [{ label: 'Details', value: w.errorDetails.details }] : []),
              { label: 'How to fix it', value: w.errorDetails.howToFix },
            ],
            severity: 'warning',
          })
        );
      }
    }
  }

  console.log(
    formatBox({
      title: 'ALL CHECKS PASSED: Environment Is 100% Ready',
      fields: [
        { label: 'Status', value: 'All database, secret keys, directory permissions, and migration checks passed successfully.' },
        { label: 'Web Portal', value: `http://${webHost}:${webPort}` },
        { label: 'API Server', value: `http://${apiHost}:${apiPort}` },
        { label: 'Next Step', value: 'Run "npm run dev" to launch both the Web frontend and API backend.' },
      ],
      severity: 'info',
    })
  );

  process.exit(0);
}

runDoctor().catch((err) => {
  console.error('\nFatal Doctor Error:');
  console.error(formatFriendlyError(err));
  process.exit(1);
});
