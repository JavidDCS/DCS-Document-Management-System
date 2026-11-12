import type { RequestHandler, Router } from 'express';
import type { Permission } from '@dcs-docs/shared';
import { requirePermission, requireRecentAuth, type Authenticator } from './guards.js';

/**
 * Every route declares who may call it. There is no way to attach a route without an access declaration, so a
 * forgotten permission check is impossible, and a test compares this registry with the router to prove it.
 */
export type Access =
  /** No sign-in needed (login, CSRF token, refresh). `reason` is mandatory documentation. */
  | { kind: 'public'; reason: string }
  /** Any signed-in user (own account actions). */
  | { kind: 'authenticated'; allowMustChangePassword?: boolean }
  /** Signed in and holding `permission`; `reauth` also requires a recent password check. */
  | { kind: 'permission'; permission: Permission; reauth?: boolean };

export interface RouteSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  access: Access;
}

export interface GuardDeps {
  authenticate?: Authenticator;
  reauthMaxAgeSeconds: number;
}

export class SecureRouter {
  readonly registry: RouteSpec[] = [];

  constructor(
    readonly router: Router,
    private readonly guards: GuardDeps
  ) {}

  private chain(access: Access): RequestHandler[] {
    if (access.kind === 'public') return [];
    const authenticate = this.guards.authenticate;
    if (!authenticate) throw new Error('Protected route registered but no authenticator is configured');
    if (access.kind === 'authenticated') return [authenticate({ allowMustChangePassword: access.allowMustChangePassword ?? false })];
    const guards = [authenticate({ allowMustChangePassword: false }), requirePermission(access.permission)];
    if (access.reauth) guards.push(requireRecentAuth(this.guards.reauthMaxAgeSeconds));
    return guards;
  }

  private add(method: RouteSpec['method'], path: string, access: Access, handlers: RequestHandler[]) {
    if (handlers.length === 0) throw new Error(`Route ${method.toUpperCase()} ${path} has no handler`);
    this.registry.push({ method, path, access });
    this.router[method](path, ...this.chain(access), ...handlers);
  }

  get(path: string, access: Access, ...handlers: RequestHandler[]) {
    this.add('get', path, access, handlers);
  }
  post(path: string, access: Access, ...handlers: RequestHandler[]) {
    this.add('post', path, access, handlers);
  }
  put(path: string, access: Access, ...handlers: RequestHandler[]) {
    this.add('put', path, access, handlers);
  }
  patch(path: string, access: Access, ...handlers: RequestHandler[]) {
    this.add('patch', path, access, handlers);
  }
  delete(path: string, access: Access, ...handlers: RequestHandler[]) {
    this.add('delete', path, access, handlers);
  }
}

export const PUBLIC = (reason: string): Access => ({ kind: 'public', reason });
export const AUTHENTICATED: Access = { kind: 'authenticated' };
export const can = (permission: Permission, opts: { reauth?: boolean } = {}): Access => ({
  kind: 'permission',
  permission,
  ...(opts.reauth ? { reauth: true } : {}),
});
