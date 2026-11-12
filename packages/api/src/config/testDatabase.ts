/**
 * Automated tests never touch the development database. They use DATABASE_URL_TEST only, and its
 * database name must end in "_test" and differ from DATABASE_URL.
 */
export function requireTestDatabaseUrl(testUrl: string | undefined, devUrl: string | undefined): string {
  if (!testUrl) {
    throw new Error('DATABASE_URL_TEST is required to run tests (a database whose name ends in "_test"). Tests never use DATABASE_URL.');
  }
  if (!/\/[^/?]*_test(\?|$)/.test(testUrl)) {
    throw new Error('DATABASE_URL_TEST must point at a database whose name ends in "_test".');
  }
  if (devUrl && testUrl === devUrl) {
    throw new Error('DATABASE_URL_TEST must not be the same as DATABASE_URL.');
  }
  return testUrl;
}
