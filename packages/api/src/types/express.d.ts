import 'express-serve-static-core';
import type { Permission, Role } from '@dcs-docs/shared';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  status: 'INVITED' | 'ACTIVE';
  roles: Role[];
  permissions: Permission[];
  mustChangePassword: boolean;
  /** When the password was last typed in this session (re-authentication). */
  authTime: Date;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id: echoed from a valid X-Request-Id header or generated. Also written to audit entries. */
    id: string;
    /** Set by the authentication guard on every protected route; never trust anything else for identity. */
    auth?: AuthContext;
  }
}
