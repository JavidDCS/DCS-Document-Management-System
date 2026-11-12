export const MIN_PASSWORD_LENGTH = 12;
/** bcrypt only uses the first 72 BYTES; longer passwords are rejected, never silently truncated. */
export const MAX_PASSWORD_BYTES = 72;

/** Passwords of 12+ characters that still appear in every breach list (lower-case, letters and digits only). */
const COMMON = new Set([
  'password1234', 'password12345', 'password123456', 'passw0rd1234', 'p@ssword1234', 'qwertyuiop12', 'qwertyuiop123',
  'qwerty123456', 'qwertyuiopas', 'asdfghjkl123', 'asdfghjklqwe', 'zxcvbnm12345', '123456789012', '1234567890123',
  '12345678901234', '123456123456', '111111111111', '000000000000', 'abcdefghijkl', 'abcdefghijklm', 'abcd12345678',
  'abc123456789', 'iloveyou1234', 'iloveyou12345', 'letmein12345', 'welcome12345', 'welcome12345!', 'administrator',
  'administrator1', 'administrator123', 'changeme1234', 'changeme12345', 'changemenow', 'adminadmin12', 'admin1234567',
  'admin12345678', 'superadmin12', 'superadmin123', 'monkey123456', 'dragon123456', 'football1234', 'baseball1234',
  'sunshine1234', 'princess1234', 'trustno1trustno1', 'whatever1234', 'summer202012', 'winter202012', 'spring202012',
  'autumn202012', 'january2026', 'february2026', 'march2026march', 'decirclesolar', 'decirclesolar1', 'decirclesolar123',
  'decirclesolar2026', 'solarsolar123', 'solar1234567', 'company12345', 'companyname1', 'passwordpassword', 'passwordqwerty',
  'qwertyqwerty', 'aaaaaaaaaaaa', 'a1b2c3d4e5f6', 'test12345678', 'testtesttest', 'default12345', 'master123456',
  'login1234567', 'secret123456', 'secretsecret', 'temp12345678', 'temporary1234', 'temppassword1',
]);

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Normalises for dictionary and similarity checks: lower-case, letters and digits only. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Returns human-readable problems; an empty array means the password is acceptable.
 * Used by the API (authoritative) and the web form (convenience). No composition rules: length wins.
 */
export function checkPasswordPolicy(password: string, ctx: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (bytes(password) > MAX_PASSWORD_BYTES) problems.push(`Use at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} plain characters).`);
  if (/^\s|\s$/.test(password)) problems.push('Remove leading and trailing spaces.');
  if (new Set(password).size < 5) problems.push('Use more different characters.');

  const flat = squash(password);
  if (COMMON.has(flat) || COMMON.has(password.toLowerCase())) problems.push('This password is too common.');

  const local = ctx.email ? squash(ctx.email.split('@')[0] ?? '') : '';
  if (local.length >= 4 && flat.includes(local)) problems.push('Do not include your email name in the password.');
  const name = ctx.name ? squash(ctx.name) : '';
  if (name.length >= 4 && flat.includes(name)) problems.push('Do not include your name in the password.');

  const repeated = /^(.)\1+$/.test(password);
  const keyboardRun = password.length <= 14 && /^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(password);
  if (repeated || keyboardRun) {
    problems.push('Avoid sequences and repeated characters.');
  }
  return problems;
}

export { bytes as utf8ByteLength };
