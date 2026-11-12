import type { SecureRouter, Access } from '../../src/platform/auth/secureRouter.js';
import { createApp, type AppConfig } from '../../src/app.js';

export const ALLOWED_ORIGIN = 'https://docs.example.test';

/** Access declaration for throwaway test routes. */
export const T: Access = { kind: 'public', reason: 'test route' };

export const baseConfig: AppConfig = {
  TRUST_PROXY: 0,
  CORS_ORIGINS: [ALLOWED_ORIGIN],
  CSP_REPORT_URI: undefined,
  CSRF_SECRET: 'test-csrf-secret-test-csrf-secret-0123456789',
  COOKIE_SECURE: false,
  REQUEST_BODY_LIMIT_KB: 1,
  RATE_LIMIT_WINDOW_MINUTES: 15,
  RATE_LIMIT_API_MAX_PER_IP: 1000,
  RATE_LIMIT_LOGIN_MAX: 1000,
  RATE_LIMIT_REFRESH_MAX: 1000,
  RATE_LIMIT_UPLOAD_MAX_PER_HOUR: 1000,
  RATE_LIMIT_DOWNLOAD_MAX_PER_HOUR: 1000,
  RATE_LIMIT_SEND_MAX_PER_HOUR: 1000,
  REAUTH_MAX_AGE_SECONDS: 300,
};

export function buildApp(overrides: Partial<AppConfig> = {}, mount?: (v1: SecureRouter) => void) {
  return createApp({ config: { ...baseConfig, ...overrides }, ...(mount ? { register: (secure) => mount(secure) } : {}) });
}
