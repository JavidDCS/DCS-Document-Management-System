import { describe, expect, it, vi } from 'vitest';
import { codeChallengeFor, generateCodeVerifier, generateNonce, generateState, packOauthState, unpackOauthState } from '../src/modules/identity/googleLoginState.js';

describe('googleLoginState (signed OAuth state cookie)', () => {
  const secret = 'test-secret-at-least-32-bytes-long-0123456789';

  it('round-trips state, nonce and verifier', () => {
    const data = { state: generateState(), nonce: generateNonce(), verifier: generateCodeVerifier() };
    const packed = packOauthState(secret, data);
    expect(unpackOauthState(secret, packed)).toEqual(data);
  });

  it('rejects a tampered payload', () => {
    const packed = packOauthState(secret, { state: 's', nonce: 'n', verifier: 'v' });
    const [payload, mac] = packed.split('.');
    const tampered = `${Buffer.from(JSON.stringify({ state: 'attacker-state', nonce: 'n', verifier: 'v', exp: Date.now() + 60_000 })).toString('base64url')}.${mac}`;
    expect(payload).toBeDefined();
    expect(unpackOauthState(secret, tampered)).toBeNull();
  });

  it('rejects a value signed with a different secret', () => {
    const packed = packOauthState('a-different-secret-entirely-0123456789', { state: 's', nonce: 'n', verifier: 'v' });
    expect(unpackOauthState(secret, packed)).toBeNull();
  });

  it('rejects an expired cookie', () => {
    vi.useFakeTimers();
    try {
      const packed = packOauthState(secret, { state: 's', nonce: 'n', verifier: 'v' });
      vi.advanceTimersByTime(11 * 60_000); // past the 10-minute TTL
      expect(unpackOauthState(secret, packed)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects missing, malformed or empty cookie values', () => {
    expect(unpackOauthState(secret, undefined)).toBeNull();
    expect(unpackOauthState(secret, '')).toBeNull();
    expect(unpackOauthState(secret, 'not-two-parts')).toBeNull();
    expect(unpackOauthState(secret, 'a.b.c')).toBeNull();
  });

  it('codeChallengeFor is a deterministic S256 PKCE challenge of the verifier', () => {
    const verifier = generateCodeVerifier();
    expect(codeChallengeFor(verifier)).toBe(codeChallengeFor(verifier));
    expect(codeChallengeFor(verifier)).not.toBe(verifier);
  });
});
