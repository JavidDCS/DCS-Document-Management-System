import { formatFriendlyError } from '@dcs-docs/shared';
import { createApp } from './app.js';
import { buildFileStack, buildServices, registerRoutes } from './composition.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { logger } from './utils/logger.js';

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    logger.error('Cannot reach the database; check DATABASE_URL and that PostgreSQL is running', err);
    console.error(formatFriendlyError(err, { action: 'Database connection check at startup' }));
    process.exit(1);
  }

  let stack;
  try {
    stack = await buildFileStack(env);
  } catch (err) {
    logger.error('Cannot start file storage; check the STORAGE_* and FILE_ENCRYPTION_* settings', err);
    console.error(formatFriendlyError(err, { action: 'File storage initialization' }));
    process.exit(1);
  }
  if (!env.MALWARE_SCAN_ENABLED) logger.warn('MALWARE_SCAN_ENABLED=false: uploads are NOT scanned for malware (development only)');

  const services = buildServices(prisma, env, stack);
  const app = createApp({
    config: env,
    authenticate: services.authenticate,
    register: (secure, ctx) => registerRoutes(secure, ctx, services, env),
  });

  const server = app.listen(env.API_PORT, env.API_HOST, () => {
    logger.info(`API listening on ${env.API_HOST}:${env.API_PORT} (${env.NODE_ENV}, storage=${env.STORAGE_DRIVER})`);
  });

  server.on('error', (err) => {
    console.error(formatFriendlyError(err, { action: `Server startup on ${env.API_HOST}:${env.API_PORT}` }));
    process.exit(1);
  });
  if (env.JOBS_ENABLED) services.jobs.start();

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => {
      void services.jobs
        .stop()
        .then(() => prisma.$disconnect())
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
