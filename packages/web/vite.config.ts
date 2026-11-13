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
  return {
    plugins: [react(), tailwindcss()],
    server: { host, port, strictPort: true, proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
    preview: { host, port, strictPort: true, proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
    build: { sourcemap: false, target: 'es2022' },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
