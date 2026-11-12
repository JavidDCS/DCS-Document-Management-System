import type { LoginResponse } from '../types';

/** Failure from the API in its standard error shape: { error: { code, message, requestId, details? } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details: { path: string; message: string }[] = []
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientDeps {
  fetchFn: typeof fetch;
  baseUrl: string;
  /** Called when the session cannot be renewed (refresh failed). */
  onSessionExpired: () => void;
  /** Asks the user for their password; resolves true after a successful POST /auth/reauth. */
  requestReauth: () => Promise<boolean>;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** false for login/refresh/logout/csrf (no bearer token, no retry). */
  auth?: boolean;
  signal?: AbortSignal;
}

export function toApiError(status: number, body: unknown): ApiError {
  const e = (body as { error?: { code?: string; message?: string; requestId?: string; details?: { path: string; message: string }[] } } | null)?.error;
  return new ApiError(status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Request failed (${status})`, e?.requestId, e?.details ?? []);
}

/**
 * The API client. The access token lives only in this closure (memory); the refresh token is an httpOnly cookie
 * the browser sends by itself. On 401 UNAUTHENTICATED it refreshes once (shared across concurrent calls) and retries;
 * on 401 REAUTH_REQUIRED it asks for the password, re-authenticates and retries.
 */
export function createClient(deps: ClientDeps) {
  let accessToken: string | null = null;
  let csrfToken: string | null = null;
  let refreshing: Promise<boolean> | null = null;
  let restoring: Promise<LoginResponse | null> | null = null;

  const url = (path: string, query?: Query) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    return `${deps.baseUrl}${path}${s ? `?${s}` : ''}`;
  };

  async function getCsrf(force = false): Promise<string> {
    if (csrfToken && !force) return csrfToken;
    const res = await deps.fetchFn(url('/csrf'), { credentials: 'same-origin' });
    const body = (await res.json()) as { data?: { csrfToken?: string } };
    if (!res.ok || !body.data?.csrfToken) throw toApiError(res.status, body);
    csrfToken = body.data.csrfToken;
    return csrfToken;
  }

  /** One HTTP exchange, no retry logic. `cookieAuth` requests carry the CSRF token instead of a bearer token. */
  async function once<T>(method: string, path: string, opts: RequestOptions & { cookieAuth?: boolean }): Promise<{ data: T; meta?: unknown }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (opts.cookieAuth) headers['X-CSRF-Token'] = await getCsrf();
    const init: RequestInit = { method, headers, credentials: 'same-origin' };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    const res = await deps.fetchFn(url(path, opts.query), init);
    if (res.status === 204) return { data: undefined as T };
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) throw toApiError(res.status, body);
    const parsed = body as { data: T; meta?: unknown };
    return parsed;
  }

  async function doRefresh(): Promise<boolean> {
    try {
      const r = await once<LoginResponse>('POST', '/auth/refresh', { auth: false, cookieAuth: true });
      accessToken = r.data.accessToken;
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CSRF_FAILED') {
        csrfToken = null;
        try {
          const r = await once<LoginResponse>('POST', '/auth/refresh', { auth: false, cookieAuth: true });
          accessToken = r.data.accessToken;
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /** All concurrent callers share one refresh round-trip. */
  function refreshOnce(): Promise<boolean> {
    refreshing ??= doRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** Runs `op`, transparently renewing the session or re-authenticating once when the API asks for it. */
  async function withAuthRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      if (e.code === 'REAUTH_REQUIRED') {
        if (!(await deps.requestReauth())) throw e;
        return op();
      }
      if (e.code === 'UNAUTHENTICATED') {
        if (await refreshOnce()) return op();
        accessToken = null;
        deps.onSessionExpired();
      }
      throw e;
    }
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<{ data: T; meta?: unknown }> {
    if (opts.auth === false) return once<T>(method, path, opts);
    return withAuthRetry(() => once<T>(method, path, opts));
  }

  return {
    setAccessToken(token: string | null) {
      accessToken = token;
    },
    hasToken: () => accessToken !== null,
    request,
    withAuthRetry,
    get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) }),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body === undefined ? {} : { body }),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body === undefined ? {} : { body }),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body === undefined ? {} : { body }),
    del: <T>(path: string) => request<T>('DELETE', path),

    // Cookie-authenticated calls (no bearer token): login, refresh, logout.
    async login(email: string, password: string): Promise<LoginResponse> {
      const r = await once<LoginResponse>('POST', '/auth/login', { auth: false, cookieAuth: true, body: { email, password } });
      accessToken = r.data.accessToken;
      return r.data;
    },
    /** Shared in-flight promise: React StrictMode runs effects twice in development, and a second refresh with the
     * same cookie would look like token reuse to the server and end the session. */
    restoreSession(): Promise<LoginResponse | null> {
      restoring ??= (async () => {
        try {
          const r = await once<LoginResponse>('POST', '/auth/refresh', { auth: false, cookieAuth: true });
          accessToken = r.data.accessToken;
          return r.data;
        } catch {
          return null;
        }
      })().finally(() => {
        restoring = null;
      });
      return restoring;
    },
    async logout(): Promise<void> {
      try {
        await once<void>('POST', '/auth/logout', { auth: false, cookieAuth: true });
      } finally {
        accessToken = null;
      }
    },
    async reauth(password: string): Promise<void> {
      const r = await once<{ accessToken: string }>('POST', '/auth/reauth', { body: { password } });
      accessToken = r.data.accessToken;
    },

    /** Downloads a protected file as a Blob using the bearer token (never a URL a browser could share). */
    async blob(path: string, query?: Query): Promise<{ blob: Blob; filename: string | null }> {
      return withAuthRetry(async () => {
        const headers: Record<string, string> = {};
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        const res = await deps.fetchFn(url(path, query), { headers, credentials: 'same-origin' });
        if (!res.ok) {
          let body: unknown = null;
          try {
            body = await res.json();
          } catch {
            /* ignore */
          }
          throw toApiError(res.status, body);
        }
        const cd = res.headers.get('content-disposition') ?? '';
        const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
        return { blob: await res.blob(), filename: m?.[1] ? decodeURIComponent(m[1]) : null };
      });
    },

    /** Multipart upload with real progress (fetch cannot report upload progress, XHR can). */
    upload<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<{ data: T }> {
      return withAuthRetry(
        () =>
          new Promise<{ data: T }>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url(path));
            if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
            xhr.setRequestHeader('Accept', 'application/json');
            xhr.upload.onprogress = (ev) => {
              if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total);
            };
            xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Network error while uploading'));
            xhr.onload = () => {
              let body: unknown = null;
              try {
                body = JSON.parse(xhr.responseText);
              } catch {
                /* ignore */
              }
              if (xhr.status >= 200 && xhr.status < 300) resolve(body as { data: T });
              else reject(toApiError(xhr.status, body));
            };
            xhr.send(form);
          })
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createClient>;
