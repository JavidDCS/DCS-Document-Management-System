import type { ErrorCode } from '@dcs-docs/shared';

export interface FieldIssue {
  path: string;
  message: string;
}

/** An error whose message is safe to show to the client. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: ErrorCode | (string & {}) = defaultCode(status),
    public readonly details?: FieldIssue[]
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function defaultCode(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}
