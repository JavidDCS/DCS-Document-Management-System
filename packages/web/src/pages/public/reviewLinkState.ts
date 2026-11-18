import type { PublicReviewLinkInfo } from '@dcs-docs/shared';
import { ApiError } from '../../api';

export type ReviewLinkViewState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'consumed' }
  | { kind: 'revoked' }
  | { kind: 'network' }
  | { kind: 'ready'; info: PublicReviewLinkInfo };

/**
 * Pure classifier for the public review page's top-level state, kept separate from the component so it
 * can be unit-tested without rendering React. A 404 (missing/expired-at-lookup/revoked/consumed token all
 * return the same 404 from the API, per the backend's "same answer for missing and not-allowed" convention)
 * is distinguished from a genuine network/5xx failure, which is retryable.
 */
export function classifyReviewLinkState(params: { loading: boolean; error: unknown; info: PublicReviewLinkInfo | null }): ReviewLinkViewState {
  const { loading, error, info } = params;
  if (info) {
    if (info.status === 'EXPIRED') return { kind: 'expired' };
    if (info.status === 'CONSUMED') return { kind: 'consumed' };
    if (info.status === 'REVOKED') return { kind: 'revoked' };
    return { kind: 'ready', info };
  }
  if (error) return { kind: error instanceof ApiError && error.status === 404 ? 'invalid' : 'network' };
  if (loading) return { kind: 'loading' };
  return { kind: 'loading' };
}

export const REVIEW_LINK_MESSAGES: Record<Exclude<ReviewLinkViewState['kind'], 'loading' | 'ready'>, { title: string; body: string }> = {
  invalid: { title: 'Link not found', body: 'This review link is invalid. Double-check the link you were given, or ask the sender for a new one.' },
  expired: { title: 'Link expired', body: 'This review link has expired. Ask the sender to send a new one.' },
  consumed: {
    title: 'Review already completed',
    body: 'This document has already been reviewed through this link. If you need to suggest another change, ask the sender for a new link.',
  },
  revoked: { title: 'Link no longer active', body: 'This review link has been revoked and can no longer be used. Contact the sender for a new link.' },
  network: { title: 'Something went wrong', body: 'We could not reach the server. Check your connection and try again.' },
};
