export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'CSRF_FAILED',
  'REAUTH_REQUIRED',
  'ACCOUNT_LOCKED',
  'PASSWORD_CHANGE_REQUIRED',
  'PASSWORD_POLICY',
  'ORIGIN_NOT_ALLOWED',
  'BAD_REQUEST',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every error response from the API has exactly this shape. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | (string & {});
    message: string;
    requestId: string;
    /** Field-level validation problems only; never stack traces, SQL or internal detail. */
    details?: { path: string; message: string }[];
  };
}
