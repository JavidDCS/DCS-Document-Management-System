import type { PublicReviewLinkInfo } from '@dcs-docs/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import { classifyReviewLinkState, REVIEW_LINK_MESSAGES } from './reviewLinkState';

const baseInfo: PublicReviewLinkInfo = {
  documentName: 'Sample NDA',
  versionId: 'v1',
  pageCount: 3,
  expiresAt: '2026-12-01T00:00:00.000Z',
  status: 'ACTIVE',
  comments: [],
};

describe('classifyReviewLinkState', () => {
  it('is "loading" while the first request is in flight', () => {
    expect(classifyReviewLinkState({ loading: true, error: null, info: null })).toEqual({ kind: 'loading' });
  });

  it('is "invalid" for a 404 (missing/unknown token)', () => {
    const error = new ApiError(404, 'NOT_FOUND', 'Not found');
    expect(classifyReviewLinkState({ loading: false, error, info: null })).toEqual({ kind: 'invalid' });
  });

  it('is "network" for a non-404 failure (e.g. a 500 or a thrown network error)', () => {
    const error = new ApiError(503, 'HTTP_ERROR', 'Service unavailable');
    expect(classifyReviewLinkState({ loading: false, error, info: null })).toEqual({ kind: 'network' });
  });

  it('is "network" for a plain Error (e.g. fetch rejecting on a network failure)', () => {
    expect(classifyReviewLinkState({ loading: false, error: new TypeError('Failed to fetch'), info: null })).toEqual({ kind: 'network' });
  });

  it('is "expired" when the link info says EXPIRED', () => {
    expect(classifyReviewLinkState({ loading: false, error: null, info: { ...baseInfo, status: 'EXPIRED' } })).toEqual({ kind: 'expired' });
  });

  it('is "consumed" when the link info says CONSUMED', () => {
    expect(classifyReviewLinkState({ loading: false, error: null, info: { ...baseInfo, status: 'CONSUMED' } })).toEqual({ kind: 'consumed' });
  });

  it('is "revoked" when the link info says REVOKED', () => {
    expect(classifyReviewLinkState({ loading: false, error: null, info: { ...baseInfo, status: 'REVOKED' } })).toEqual({ kind: 'revoked' });
  });

  it('is "ready" with the info attached when the link is ACTIVE', () => {
    expect(classifyReviewLinkState({ loading: false, error: null, info: baseInfo })).toEqual({ kind: 'ready', info: baseInfo });
  });

  it('prefers info over a stale error once the link has loaded (e.g. after a retry)', () => {
    const error = new ApiError(500, 'HTTP_ERROR', 'boom');
    expect(classifyReviewLinkState({ loading: false, error, info: baseInfo })).toEqual({ kind: 'ready', info: baseInfo });
  });
});

describe('REVIEW_LINK_MESSAGES', () => {
  it('gives every terminal/error state a plain-English title and a next step', () => {
    for (const kind of ['invalid', 'expired', 'consumed', 'revoked', 'network'] as const) {
      const msg = REVIEW_LINK_MESSAGES[kind];
      expect(msg.title.length).toBeGreaterThan(0);
      expect(msg.body.length).toBeGreaterThan(0);
    }
  });
});
