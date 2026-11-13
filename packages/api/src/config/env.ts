import { formatBox } from '@dcs-docs/shared';
import { logger } from '../utils/logger.js';
import { loadEnvFiles } from './envFiles.js';
import { defaultOrigin, envSchema, parseOrigins } from './envSchema.js';
import { requireTestDatabaseUrl } from './testDatabase.js';

/**
 * The ONE place that reads process.env. Everything else imports `env` from here (or receives it as a parameter).
 * Order: .env file -> (tests: swap in DATABASE_URL_TEST) -> Zod validation -> export.
 * Validation errors name the variable and the rule, never its value.
 */
loadEnvFiles();

if (process.env.NODE_ENV === 'test') {
  try {
    process.env.DATABASE_URL = requireTestDatabaseUrl(process.env.DATABASE_URL_TEST, process.env.DATABASE_URL);
  } catch (err) {
    console.error(`Configuration error: ${(err as Error).message}`);
    process.exit(1);
  }
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Configuration validation failed for environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error(
    formatBox({
      title: 'Environment Configuration Error (.env)',
      fields: [
        { label: 'What happened', value: `Found ${parsed.error.issues.length} invalid or missing environment variable(s).` },
        { label: 'Details', value: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') },
        { label: 'File', value: '.env' },
        { label: 'How to fix it', value: 'Check your .env file against .env.example, or run "npm run check" for automated diagnosis.' },
      ],
      severity: 'error',
    })
  );
  process.exit(1);
}

export const env = {
  ...parsed.data,
  COOKIE_SECURE: parsed.data.COOKIE_SECURE ?? parsed.data.NODE_ENV === 'production',
  CORS_ORIGINS: parseOrigins(parsed.data.CORS_ORIGIN ?? defaultOrigin(parsed.data)),
};

export type Env = typeof env;

logger.setLevel(env.LOG_LEVEL);

if (env.NODE_ENV === 'production' && env.TRUST_PROXY === 0) {
  logger.warn('TRUST_PROXY=0 in production: behind a reverse proxy every client shares one IP, so rate limits are shared. Set TRUST_PROXY=1.');
}
