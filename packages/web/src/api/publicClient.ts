import type { CreateReviewCommentInput, PublicReviewLinkInfo, ReviewCommentDto } from '@dcs-docs/shared';
import { ApiError, toApiError } from './client';

/**
 * A small, dedicated fetch wrapper for the unauthenticated public review page. Unlike the shared `api`
 * singleton (which assumes a bearer/refresh-token session), this has no access token at all — possession
 * of the link's token is the only credential. It mirrors the shared client's own CSRF mechanism: fetch the
 * `/csrf` cookie+token pair lazily, once, before the first unsafe-method (POST) request, and send it back
 * as `X-CSRF-Token`.
 */
let csrfToken: string | null = null;

async function getCsrf(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  const res = await fetch('/api/v1/csrf', { credentials: 'same-origin' });
  const body = (await res.json().catch(() => null)) as { data?: { csrfToken?: string } } | null;
  if (!res.ok || !body?.data?.csrfToken) throw toApiError(res.status, body);
  csrfToken = body.data.csrfToken;
  return csrfToken;
}

async function parseJson<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw toApiError(res.status, body);
  return (body as { data: T }).data;
}

export async function getReviewLink(token: string): Promise<PublicReviewLinkInfo> {
  const res = await fetch(`/api/v1/public/review/${encodeURIComponent(token)}`, { credentials: 'same-origin' });
  return parseJson<PublicReviewLinkInfo>(res);
}

/** Fetches the PDF bytes for this link and returns a `Blob` + object URL the caller must revoke when done. */
export async function getReviewContent(token: string): Promise<{ blob: Blob; url: string }> {
  const res = await fetch(`/api/v1/public/review/${encodeURIComponent(token)}/content`, { credentials: 'same-origin' });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw toApiError(res.status, body);
  }
  const blob = await res.blob();
  return { blob, url: URL.createObjectURL(blob) };
}

export async function submitComment(token: string, input: CreateReviewCommentInput): Promise<ReviewCommentDto> {
  async function attempt(forceCsrf: boolean): Promise<ReviewCommentDto> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrf(forceCsrf) };
    const res = await fetch(`/api/v1/public/review/${encodeURIComponent(token)}/comments`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(input),
    });
    return parseJson<ReviewCommentDto>(res);
  }
  try {
    return await attempt(false);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'CSRF_FAILED') {
      csrfToken = null;
      return attempt(true);
    }
    throw e;
  }
}
