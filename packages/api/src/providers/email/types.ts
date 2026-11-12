/**
 * Everything the platform needs from a mail provider. Domain code never talks to Gmail (or any other provider)
 * directly, so a central sender or SMTP relay could be added behind the same interface.
 */
export interface EmailProvider {
  readonly name: string;
  /** False when the provider is not configured (the UI then explains why sending is unavailable). */
  readonly available: boolean;
  /** The consent URL for the user (scope: send only, separate from login). */
  buildAuthUrl(input: { state: string; codeChallenge: string; loginHint: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ refreshToken: string }>;
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresInSeconds: number }>;
  revoke(refreshToken: string): Promise<void>;
  /** Sends a complete RFC 5322 message as the authorised mailbox. */
  send(accessToken: string, rawMessage: Buffer): Promise<{ providerMessageId: string }>;
}

export type EmailFailureKind =
  /** The user's authorisation is gone (revoked, expired): they must reconnect. */
  | 'AUTH_REVOKED'
  /** The provider throttled us; nothing was sent. */
  | 'RATE_LIMITED'
  /** The provider rejected the message; nothing was sent. */
  | 'REJECTED'
  /** We cannot know whether the provider accepted the message (timeout, 5xx, dropped connection). Never retried. */
  | 'UNKNOWN_OUTCOME';

export class EmailProviderError extends Error {
  constructor(
    readonly kind: EmailFailureKind,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}
