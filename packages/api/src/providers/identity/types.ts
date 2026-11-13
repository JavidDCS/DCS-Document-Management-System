/** What a successful, fully-verified external sign-in tells the app. Never trusted until the provider says so. */
export interface VerifiedIdentity {
  provider: 'GOOGLE';
  /** The provider's stable subject id ("sub"); the only thing ever matched after the first login. */
  subject: string;
  email: string;
  emailVerified: true;
  name?: string | undefined;
  /** Google Workspace "hd" claim; absent for a personal Google account. */
  hostedDomain?: string | undefined;
}

export type GoogleOidcFailureKind =
  /** Not configured (missing client id/secret/redirect URI). */
  | 'UNAVAILABLE'
  /** Google refused the authorization code (wrong/expired code, PKCE mismatch, bad client secret). */
  | 'TOKEN_REJECTED'
  /** The ID token did not pass verification (signature, iss, aud, exp, nonce, or email_verified). */
  | 'TOKEN_INVALID'
  /** Could not reach Google, or its response could not be parsed. */
  | 'UNKNOWN_OUTCOME';

export class GoogleOidcError extends Error {
  constructor(
    readonly kind: GoogleOidcFailureKind,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'GoogleOidcError';
  }
}
