import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';

/**
 * The API returns JSON and file streams only, so its CSP forbids everything and framing.
 * (The web app's own CSP is set by the server that serves the SPA; see docs/architecture/05.)
 */
export function securityHeaders(opts: { cspReportUri?: string | undefined }): RequestHandler[] {
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
  if (opts.cspReportUri) directives['report-uri'] = [opts.cspReportUri];

  const helmetMw = helmet({
    contentSecurityPolicy: { useDefaults: false, directives },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    xContentTypeOptions: true,
  });

  const extra = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // Responses can contain confidential data: nothing is cached by browsers or proxies.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  };

  return [helmetMw, extra];
}
