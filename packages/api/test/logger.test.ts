import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, REDACTED, redactString, redactValue } from '../src/utils/logger.js';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

afterEach(() => vi.restoreAllMocks());

describe('redactString', () => {
  it('redacts JWTs and bearer tokens', () => {
    expect(redactString(`token is ${JWT}`)).not.toContain('eyJ');
    expect(redactString('Authorization: Bearer abc.DEF-123_xyz')).not.toContain('abc.DEF');
  });

  it('redacts credentials inside connection URLs', () => {
    const out = redactString('connect postgresql://admin:hunter2@db.internal:5432/x failed');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('admin');
    expect(redactString('https://user:pa55@example.com/x')).not.toContain('pa55');
  });

  it('redacts password/secret/key assignments', () => {
    for (const s of ['password=hunter2', 'secret: "abc123"', 'api_key=XYZ789', 'SECRET_KEY=abc']) {
      const out = redactString(s);
      expect(out).toContain(REDACTED);
      expect(out).not.toMatch(/hunter2|abc123|XYZ789|=abc$/);
    }
  });

  it('redacts bcrypt hashes', () => {
    const hash = '$2b$12$' + 'a'.repeat(53);
    expect(redactString(`hash ${hash}`)).not.toContain('$2b$');
  });

  it('redacts signed-URL query parameters and OAuth codes', () => {
    const out = redactString('GET /f?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAXXXX&code=4/0Abc&state=st8&ok=1');
    expect(out).not.toMatch(/deadbeef|AKIAXXXX|4\/0Abc|st8/);
    expect(out).toContain('ok=1');
  });

  it('leaves ordinary text alone', () => {
    expect(redactString('Document uploaded by user 42')).toBe('Document uploaded by user 42');
  });
});

describe('redactValue', () => {
  it('masks sensitive keys at any depth, case-insensitively', () => {
    const out = redactValue({
      headers: { Authorization: 'Bearer abc', Cookie: 'sid=1', 'set-cookie': 'a=b', 'X-CSRF-Token': 't', accept: 'json' },
      body: { email: 'a@b.test', Password: 'x', newPassword: 'y', refreshToken: 'z', apiKey: 'k', client_secret: 's' },
      nested: [{ privateKey: 'pk' }],
    }) as any;
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.Cookie).toBe(REDACTED);
    expect(out.headers['set-cookie']).toBe(REDACTED);
    expect(out.headers['X-CSRF-Token']).toBe(REDACTED);
    expect(out.headers.accept).toBe('json');
    expect(out.body.Password).toBe(REDACTED);
    expect(out.body.newPassword).toBe(REDACTED);
    expect(out.body.refreshToken).toBe(REDACTED);
    expect(out.body.apiKey).toBe(REDACTED);
    expect(out.body.client_secret).toBe(REDACTED);
    expect(out.nested[0].privateKey).toBe(REDACTED);
    expect(out.body.email).toBe('a@b.test');
  });

  it('survives circular references, bigint, dates and errors', () => {
    const a: any = { n: 1n, d: new Date('2026-01-01T00:00:00Z') };
    a.self = a;
    const out = redactValue({ a, err: new Error('failed postgresql://u:pw123@h/db') }) as any;
    expect(out.a.self).toBe('[Circular]');
    expect(out.a.n).toBe('1');
    expect(out.a.d).toBe('2026-01-01T00:00:00.000Z');
    expect(out.err.message).not.toContain('pw123');
    expect(out.err.stack).toBeUndefined();
  });
});

describe('Logger', () => {
  it('redacts message and extra arguments in output', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = new Logger('info');
    log.info(`login with ${JWT}`, { password: 'hunter2', note: 'password=hunter2' });
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).not.toMatch(/hunter2|eyJ/);
    expect(line).toContain('[INFO]');
  });

  it('respects the log level', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new Logger('error');
    log.info('hidden');
    log.error('shown');
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
