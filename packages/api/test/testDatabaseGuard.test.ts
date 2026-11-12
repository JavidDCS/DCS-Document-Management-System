import { describe, expect, it } from 'vitest';
import { requireTestDatabaseUrl } from '../src/config/testDatabase.js';

describe('requireTestDatabaseUrl', () => {
  const dev = 'postgresql://u:p@h:5432/dcs_docs';
  const test = 'postgresql://u:p@h:5432/dcs_docs_test';

  it('returns a valid _test url', () => {
    expect(requireTestDatabaseUrl(test, dev)).toBe(test);
    expect(requireTestDatabaseUrl(`${test}?schema=public`, dev)).toContain('_test?');
  });

  it('refuses when missing', () => {
    expect(() => requireTestDatabaseUrl(undefined, dev)).toThrow(/DATABASE_URL_TEST is required/);
  });

  it('refuses a database not ending in _test', () => {
    expect(() => requireTestDatabaseUrl(dev, undefined)).toThrow(/_test/);
    expect(() => requireTestDatabaseUrl('postgresql://u:p@h:5432/dcs_docs_test_backup', undefined)).toThrow(/_test/);
  });

  it('refuses when identical to DATABASE_URL', () => {
    expect(() => requireTestDatabaseUrl(test, test)).toThrow(/same/);
  });

  it('never echoes the url in the error message', () => {
    try {
      requireTestDatabaseUrl('postgresql://secretuser:secretpass@h:5432/prod', undefined);
    } catch (e) {
      expect((e as Error).message).not.toContain('secretpass');
    }
  });
});
