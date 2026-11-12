import { describe, expect, it } from 'vitest';
import { envSchema } from '../src/config/envSchema.js';

const keyA = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
const keyB = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 32)).toString('base64');

const valid = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/dcs_docs',
  CSRF_SECRET: 'a'.repeat(40),
  JWT_ACCESS_SECRET: 'j'.repeat(40),
  CORS_ORIGIN: 'http://127.0.0.1:5173',
  FILE_ENCRYPTION_MASTER_KEY: keyA,
  EMAIL_TOKEN_ENCRYPTION_KEY: keyB,
  STORAGE_LOCAL_ROOT: '/var/dcs-docs/storage',
  STORAGE_QUARANTINE_ROOT: '/var/dcs-docs/quarantine',
};

const prod = {
  ...valid,
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://docs.example.com',
  CSRF_SECRET: 'r4nd0m-'.repeat(8),
  JWT_ACCESS_SECRET: 'jwt-r4nd0m-'.repeat(5),
};

function failures(input: Record<string, unknown>): string[] {
  const r = envSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
}

describe('envSchema', () => {
  it('accepts a minimal development configuration and applies defaults', () => {
    const r = envSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.API_PORT).toBe(4800);
      expect(r.data.NODE_ENV).toBe('development');
      expect(r.data.RATE_LIMIT_LOGIN_MAX).toBe(20);
    }
  });

  it('treats blank values as unset', () => {
    const r = envSchema.safeParse({ ...valid, API_PORT: '', COOKIE_SECURE: '', APP_PUBLIC_URL: '', CSP_REPORT_URI: '' });
    expect(r.success).toBe(true);
  });

  it('requires DATABASE_URL, CSRF_SECRET and JWT_ACCESS_SECRET', () => {
    expect(failures({ CORS_ORIGIN: valid.CORS_ORIGIN })).toEqual(expect.arrayContaining(['DATABASE_URL', 'CSRF_SECRET', 'JWT_ACCESS_SECRET']));
  });

  it('rejects a short CSRF_SECRET and a non-postgres URL', () => {
    expect(failures({ ...valid, CSRF_SECRET: 'short' })).toContain('CSRF_SECRET');
    expect(failures({ ...valid, DATABASE_URL: 'mysql://x' })).toContain('DATABASE_URL');
  });

  it('requires DATABASE_URL_TEST to name a _test database', () => {
    expect(failures({ ...valid, DATABASE_URL_TEST: 'postgresql://u:p@h:5432/dcs_docs' })).toContain('DATABASE_URL_TEST');
    expect(failures({ ...valid, DATABASE_URL_TEST: 'postgresql://u:p@h:5432/dcs_docs_test' })).toEqual([]);
  });

  it('rejects out-of-range numbers', () => {
    expect(failures({ ...valid, API_PORT: '70000' })).toContain('API_PORT');
    expect(failures({ ...valid, TRUST_PROXY: '-1' })).toContain('TRUST_PROXY');
  });

  it('rejects an invalid time zone and log level', () => {
    expect(failures({ ...valid, APP_TIMEZONE: 'Mars/Base' })).toContain('APP_TIMEZONE');
    expect(failures({ ...valid, LOG_LEVEL: 'trace' })).toContain('LOG_LEVEL');
  });

  describe('CORS_ORIGIN', () => {
    it('rejects paths, trailing slashes and non-origins', () => {
      expect(failures({ ...valid, CORS_ORIGIN: 'http://127.0.0.1:5173/' })).toContain('CORS_ORIGIN');
      expect(failures({ ...valid, CORS_ORIGIN: 'http://127.0.0.1:5173/app' })).toContain('CORS_ORIGIN');
      expect(failures({ ...valid, CORS_ORIGIN: 'docs.example.com' })).toContain('CORS_ORIGIN');
    });

    it('accepts several origins', () => {
      expect(failures({ ...valid, CORS_ORIGIN: 'http://a.test:1, https://b.test' })).toEqual([]);
    });
  });

  describe('production rules (the API refuses to start)', () => {
    it('accepts a sound production configuration', () => {
      expect(failures(prod)).toEqual([]);
    });

    it('refuses "*" and http origins', () => {
      expect(failures({ ...prod, CORS_ORIGIN: '*' })).toContain('CORS_ORIGIN');
      expect(failures({ ...prod, CORS_ORIGIN: 'http://docs.example.com' })).toContain('CORS_ORIGIN');
    });

    it('refuses the placeholder CSRF secret', () => {
      expect(failures({ ...prod, CSRF_SECRET: 'change-me-generate-with-openssl-rand-base64-48' })).toContain('CSRF_SECRET');
    });

    it('refuses COOKIE_SECURE=false and a non-https APP_PUBLIC_URL', () => {
      expect(failures({ ...prod, COOKIE_SECURE: 'false' })).toContain('COOKIE_SECURE');
      expect(failures({ ...prod, APP_PUBLIC_URL: 'http://docs.example.com' })).toContain('APP_PUBLIC_URL');
    });

    it('refuses the placeholder JWT secret, a reused secret and a weak bcrypt cost', () => {
      expect(failures({ ...prod, JWT_ACCESS_SECRET: 'change-me-generate-with-openssl-rand-base64-48' })).toContain('JWT_ACCESS_SECRET');
      expect(failures({ ...prod, JWT_ACCESS_SECRET: prod.CSRF_SECRET })).toContain('JWT_ACCESS_SECRET');
      expect(failures({ ...prod, BCRYPT_COST: '10' })).toContain('BCRYPT_COST');
      expect(failures({ ...prod, BCRYPT_COST: '12' })).toEqual([]);
    });

    it('allows the same weak values outside production', () => {
      expect(failures({ ...valid, COOKIE_SECURE: 'false', CSRF_SECRET: 'change-me'.padEnd(40, 'x') })).toEqual([]);
    });
  });

  describe('authentication settings', () => {
    it('applies defaults', () => {
      const r = envSchema.safeParse(valid);
      expect(r.success && r.data).toMatchObject({
        ALLOWED_EMAIL_DOMAIN: 'decirclesolar.com', BCRYPT_COST: 12, LOGIN_MAX_FAILED_ATTEMPTS: 5, LOGIN_LOCKOUT_MINUTES: 15,
        ACCESS_TOKEN_TTL: '10m', REFRESH_TOKEN_IDLE_TIMEOUT_MINUTES: 480, SESSION_ABSOLUTE_TIMEOUT_HOURS: 12,
      });
    });

    it('bounds the access token lifetime and the numbers', () => {
      expect(failures({ ...valid, ACCESS_TOKEN_TTL: '2h' })).toContain('ACCESS_TOKEN_TTL');
      expect(failures({ ...valid, ACCESS_TOKEN_TTL: '90m' })).toContain('ACCESS_TOKEN_TTL');
      expect(failures({ ...valid, ACCESS_TOKEN_TTL: '3601s' })).toContain('ACCESS_TOKEN_TTL');
      expect(failures({ ...valid, ACCESS_TOKEN_TTL: '60m' })).toEqual([]);
      expect(failures({ ...valid, BCRYPT_COST: '3' })).toContain('BCRYPT_COST');
      expect(failures({ ...valid, BCRYPT_COST: '16' })).toContain('BCRYPT_COST');
      expect(failures({ ...valid, JWT_ACCESS_SECRET: 'short' })).toContain('JWT_ACCESS_SECRET');
      expect(failures({ ...valid, SESSION_ABSOLUTE_TIMEOUT_HOURS: '0' })).toContain('SESSION_ABSOLUTE_TIMEOUT_HOURS');
    });

    it('requires the bootstrap email to belong to the allowed domain', () => {
      expect(failures({ ...valid, SEED_SUPER_ADMIN_EMAIL: 'boss@gmail.com' })).toContain('SEED_SUPER_ADMIN_EMAIL');
      expect(failures({ ...valid, SEED_SUPER_ADMIN_EMAIL: 'boss@decirclesolar.com' })).toEqual([]);
      expect(failures({ ...valid, SEED_SUPER_ADMIN_EMAIL: '' })).toEqual([]);
    });
  });

  it('never puts the offending value in an error message', () => {
    const secret = 'SuperSecretValue-do-not-leak';
    const r = envSchema.safeParse({ ...valid, DATABASE_URL: secret, CSRF_SECRET: 'x' });
    expect(JSON.stringify(r.success ? {} : r.error.issues)).not.toContain(secret);
  });
});
