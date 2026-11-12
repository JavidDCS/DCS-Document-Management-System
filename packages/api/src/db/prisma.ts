import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: [{ emit: 'event', level: 'error' }],
});

prisma.$on('error', (e) => {
  logger.error('Prisma error', { message: e.message, target: e.target });
});
