import { ApiError, createClient } from './client';

/** Late-bound hooks the auth provider installs (session expiry and the password re-confirmation dialog). */
export const bus: { onExpired: () => void; askReauth: () => Promise<boolean> } = {
  onExpired: () => {},
  askReauth: async () => false,
};

export const api = createClient({
  fetchFn: (input, init) => fetch(input, init),
  baseUrl: '/api/v1',
  onSessionExpired: () => bus.onExpired(),
  requestReauth: () => bus.askReauth(),
});

export { ApiError };

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

/** Field errors from the API `details`, keyed by the last path segment (and the full path). */
export function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError) {
    for (const d of e.details) {
      out[d.path] ??= d.message;
      const last = d.path.split('.').pop();
      if (last) out[last] ??= d.message;
    }
  }
  return out;
}
