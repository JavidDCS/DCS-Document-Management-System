export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export const REDACTED = '[REDACTED]';

/** Object keys whose values are never logged (case-insensitive, matched on the key name). */
const SENSITIVE_KEY = /(authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|signature|credential|session|csrf|refresh|code_verifier|^code$|^key$|master)/i;

/** Patterns redacted from any string, whatever it sits in. */
const SENSITIVE_PATTERNS: { pattern: RegExp; replace: string }[] = [
  { pattern: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/gi, replace: 'postgresql://[REDACTED_USER]:[REDACTED_PASSWORD]@' },
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/gi, replace: '[REDACTED_URL_CREDENTIALS]@' },
  { pattern: /bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replace: `Bearer ${REDACTED}` },
  { pattern: /eyJ[\w-]+\.[\w-]+\.[\w-]*/g, replace: REDACTED },
  { pattern: /\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}/g, replace: REDACTED },
  { pattern: /([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|signature|credential|access[_-]?key)[\w-]*)(["']?\s*[:=]\s*["']?)[^"'&,\s]+/gi, replace: `$1$2${REDACTED}` },
  { pattern: /([?&](?:X-Amz-[A-Za-z-]+|signature|sig|token|code|state)=)[^&\s]+/gi, replace: `$1${REDACTED}` },
];

export function redactString(input: string): string {
  let out = input;
  for (const { pattern, replace } of SENSITIVE_PATTERNS) out = out.replace(pattern, replace);
  return out;
}

const MAX_DEPTH = 6;

/** Deep copy that masks sensitive keys and scrubs strings. Safe for circular structures and Errors. */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1, seen);
  }
  return out;
}

function stringify(value: unknown): string {
  const safe = redactValue(value);
  return typeof safe === 'string' ? safe : JSON.stringify(safe);
}

export class Logger {
  private currentLevel: LogLevel;

  constructor(level: LogLevel = 'info') {
    this.currentLevel = level;
  }

  setLevel(level: LogLevel) {
    this.currentLevel = level;
  }

  getLevel(): LogLevel {
    return this.currentLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[this.currentLevel];
  }

  format(level: LogLevel, message: unknown, ...args: unknown[]): string {
    const extra = args.map(stringify).join(' ');
    return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${stringify(message)}${extra ? ` ${extra}` : ''}`;
  }

  error(message: unknown, ...args: unknown[]) {
    if (this.shouldLog('error')) console.error(this.format('error', message, ...args));
  }

  warn(message: unknown, ...args: unknown[]) {
    if (this.shouldLog('warn')) console.warn(this.format('warn', message, ...args));
  }

  info(message: unknown, ...args: unknown[]) {
    if (this.shouldLog('info')) console.info(this.format('info', message, ...args));
  }

  debug(message: unknown, ...args: unknown[]) {
    if (this.shouldLog('debug')) console.debug(this.format('debug', message, ...args));
  }
}

export const logger = new Logger('info');
