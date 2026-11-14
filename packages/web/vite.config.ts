import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Ports and hosts come from the repository root .env (WEB_HOST, WEB_PORT, API_HOST, API_PORT); nothing is hardcoded here
// beyond the same defaults the API uses. VITE_API_TARGET overrides the proxy target (e.g. for a second API instance).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const apiTarget = process.env.VITE_API_TARGET ?? `http://${env.API_HOST || '127.0.0.1'}:${env.API_PORT || '7800'}`;
  const host = env.WEB_HOST || '127.0.0.1';
  const port = Number(env.WEB_PORT || '7801');
  // Vite's dev/preview server rejects any Host header it doesn't recognize (CVE-2025-30208-style DNS rebinding
  // protection). Behind Nginx on a real domain, the public hostname must be added explicitly or every request
  // is blocked with "Blocked request. This host is not allowed."
  const publicHost = env.APP_PUBLIC_URL ? new URL(env.APP_PUBLIC_URL).hostname : undefined;
  const allowedHosts = publicHost ? [publicHost] : undefined;
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'html-transform',
        transformIndexHtml(html) {
          const company = env.APP_COMPANY_NAME || 'DeCircle Solar';
          const googleEnabled = env.AUTH_GOOGLE_LOGIN_ENABLED === 'true' || env.GOOGLE_LOGIN_ENABLED === 'true';
          const passwordEnabled = env.AUTH_PASSWORD_LOGIN_ENABLED !== 'false';
          const domain = env.ALLOWED_EMAIL_DOMAIN || 'decirclesolar.com';
          const script = `<script>window.__APP_CONFIG__ = ${JSON.stringify({
            companyName: company,
            domain,
            googleLoginEnabled: googleEnabled,
            passwordLoginEnabled: passwordEnabled,
          })};</script>`;
          return html
            .replace(/<title>.*?<\/title>/, `<title>${company} Documents</title>`)
            .replace('</head>', `${script}</head>`);
        },
      },
    ],
    server: { host, port, strictPort: true, proxy: { '/api': { target: apiTarget, changeOrigin: false } }, allowedHosts },
    preview: { host, port, strictPort: true, proxy: { '/api': { target: apiTarget, changeOrigin: false } }, allowedHosts },
    envDir: fileURLToPath(new URL('../..', import.meta.url)),
    envPrefix: ['VITE_', 'AUTH_', 'GOOGLE_', 'APP_', 'ALLOWED_'],
    define: {
      'import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN': JSON.stringify(env.ALLOWED_EMAIL_DOMAIN || 'decirclesolar.com'),
      'import.meta.env.ALLOWED_EMAIL_DOMAIN': JSON.stringify(env.ALLOWED_EMAIL_DOMAIN || 'decirclesolar.com'),
      'import.meta.env.VITE_COMPANY_NAME': JSON.stringify(env.APP_COMPANY_NAME || 'DeCircle Solar'),
      'import.meta.env.APP_COMPANY_NAME': JSON.stringify(env.APP_COMPANY_NAME || 'DeCircle Solar'),
      'import.meta.env.VITE_APP_PUBLIC_URL': JSON.stringify(env.APP_PUBLIC_URL || ''),
      'import.meta.env.VITE_AUTH_GOOGLE_LOGIN_ENABLED': JSON.stringify(env.AUTH_GOOGLE_LOGIN_ENABLED || env.GOOGLE_LOGIN_ENABLED || 'false'),
      'import.meta.env.AUTH_GOOGLE_LOGIN_ENABLED': JSON.stringify(env.AUTH_GOOGLE_LOGIN_ENABLED || env.GOOGLE_LOGIN_ENABLED || 'false'),
      'import.meta.env.GOOGLE_LOGIN_ENABLED': JSON.stringify(env.AUTH_GOOGLE_LOGIN_ENABLED || env.GOOGLE_LOGIN_ENABLED || 'false'),
      'import.meta.env.VITE_AUTH_PASSWORD_LOGIN_ENABLED': JSON.stringify(env.AUTH_PASSWORD_LOGIN_ENABLED || 'true'),
      'import.meta.env.AUTH_PASSWORD_LOGIN_ENABLED': JSON.stringify(env.AUTH_PASSWORD_LOGIN_ENABLED || 'true'),
    },
    build: { sourcemap: false, target: 'es2022' },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
