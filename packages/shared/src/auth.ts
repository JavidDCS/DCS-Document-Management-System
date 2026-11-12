import { z } from 'zod';
import { ROLES, type Permission, type Role } from './permissions.js';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const loginSchema = z.strictObject({
  email: emailSchema,
  // Not policy-checked on login: an old or wrong password must simply fail, never reveal the policy.
  password: z.string().min(1).max(256),
});

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256), // policy enforced by the server with context (email, name)
});

export const reauthSchema = z.strictObject({ password: z.string().min(1).max(256) });

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const createUserSchema = z.strictObject({
  email: emailSchema,
  name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES),
});

export const setUserStatusSchema = z.strictObject({ status: z.enum(['ACTIVE', 'DEACTIVATED']) });

export const setUserRolesSchema = z.strictObject({
  roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length),
});

export const uuidParamSchema = z.strictObject({ id: z.uuid() });

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  roles: Role[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuthUser extends PublicUser {
  mustChangePassword: boolean;
  permissions: Permission[];
}

export interface LoginResponse {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: AuthUser;
}
