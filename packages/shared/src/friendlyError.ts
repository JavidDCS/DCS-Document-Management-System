/**
 * Friendly Error Formatter
 * Translates cryptic database, validation, and runtime errors into clear, plain-English terminal boxes.
 */

export interface FriendlyErrorData {
  title: string;
  whatHappened: string;
  details?: string;
  file?: string;
  howToFix: string;
  severity?: 'error' | 'warning' | 'info';
}

export interface BoxOptions {
  title: string;
  fields: { label: string; value: string }[];
  severity?: 'error' | 'warning' | 'info';
  width?: number;
}

const REDACT_PATTERNS: { pattern: RegExp; replace: string }[] = [
  { pattern: /postgres(?:ql)?:\/\/([^:\s/]+):[^@\s]+@/gi, replace: 'postgresql://$1:***@' },
  { pattern: /\bhttps?:\/\/[^:\s/]+:[^@\s/]+@/gi, replace: 'http://[REDACTED_AUTH]@' },
  { pattern: /bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replace: 'Bearer [REDACTED]' },
  { pattern: /eyJ[\w-]+\.[\w-]+\.[\w-]*/g, replace: '[REDACTED_JWT]' },
  { pattern: /\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}/g, replace: '[REDACTED_BCRYPT]' },
  { pattern: /([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|signature|credential|access[_-]?key)[\w-]*)(["']?\s*[:=]\s*["']?)[^"'&,\s]+/gi, replace: '$1$2***' },
  { pattern: /([?&](?:X-Amz-[A-Za-z-]+|signature|sig|token|code|state|password|secret)=)[^&\s]+/gi, replace: '$1***' },
];

export function redactSensitive(input: string): string {
  let out = input;
  for (const { pattern, replace } of REDACT_PATTERNS) {
    out = out.replace(pattern, replace);
  }
  return out;
}

const IS_COLOR_SUPPORTED =
  typeof process !== 'undefined' &&
  Boolean(process.stdout?.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
  white: '\x1b[37m',
};

function c(color: keyof typeof COLORS, text: string): string {
  return IS_COLOR_SUPPORTED ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Wraps text to maximum width, breaking on spaces */
export function wrapText(text: string, maxWidth: number): string[] {
  if (!text) return [];
  const clean = redactSensitive(text);
  const lines: string[] = [];

  for (const rawLine of clean.split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let current = words[0]!;
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!;
      if (current.length + 1 + word.length <= maxWidth) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }

  return lines;
}

/**
 * Formats a clean ASCII box with borders and fields
 */
export function formatBox(options: BoxOptions): string {
  const width = Math.max(options.width ?? 80, 60);
  const innerWidth = width - 2; // Subtract left and right borders

  const borderChar = options.severity === 'warning' ? 'yellow' : options.severity === 'info' ? 'cyan' : 'red';
  const icon = options.severity === 'warning' ? '⚠️ ' : options.severity === 'info' ? 'ℹ️ ' : '🚨';
  const prefix = options.severity === 'warning' ? 'WARNING' : options.severity === 'info' ? 'INFO' : 'ERROR';

  const titleText = `${icon} ${prefix}: ${options.title}`;
  const clampedTitle = titleText.length > innerWidth - 2 ? `${titleText.slice(0, innerWidth - 5)}...` : titleText;

  const topBorder = c(borderChar, `┌${'─'.repeat(innerWidth)}┐`);
  const midBorder = c(borderChar, `├${'─'.repeat(innerWidth)}┤`);
  const botBorder = c(borderChar, `└${'─'.repeat(innerWidth)}┘`);

  const titlePadded = clampedTitle + ' '.repeat(Math.max(0, innerWidth - 2 - stripAnsi(clampedTitle).length));
  const titleLine = `${c(borderChar, '│')} ${c('bold', titlePadded)} ${c(borderChar, '│')}`;

  const bodyLines: string[] = [];

  // Determine longest label for alignment
  const maxLabelLen = Math.min(
    Math.max(...options.fields.map((f) => f.label.length), 14),
    20
  );
  const labelPrefixLen = maxLabelLen + 3; // "Label : "
  const valueWidth = innerWidth - 2 - labelPrefixLen;

  for (const field of options.fields) {
    if (!field.value) continue;
    const valueLines = wrapText(field.value, valueWidth);
    const labelHeader = `${field.label.padEnd(maxLabelLen)} : `;

    for (let i = 0; i < valueLines.length; i++) {
      const lineVal = valueLines[i]!;
      const fullContent =
        i === 0
          ? `${c('yellow', labelHeader)}${lineVal}`
          : `${' '.repeat(labelPrefixLen)}${lineVal}`;
      const visibleLength = (i === 0 ? labelHeader.length : labelPrefixLen) + lineVal.length;
      const padding = ' '.repeat(Math.max(0, innerWidth - 2 - visibleLength));

      bodyLines.push(`${c(borderChar, '│')} ${fullContent}${padding} ${c(borderChar, '│')}`);
    }
  }

  return ['', topBorder, titleLine, midBorder, ...bodyLines, botBorder, ''].join('\n');
}

/**
 * Extracts the top source code file and line number from an error stack trace.
 */
function extractSourceLocation(stack?: string): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split('\n');
  for (const line of lines) {
    // Look for lines containing project files (excluding node_modules and internal node)
    if (line.includes('packages/') || line.includes('src/') || line.includes('scripts/')) {
      if (!line.includes('node_modules')) {
        const match = line.match(/(?:at\s+.*?\s+\(?|\()([^()]+:\d+:\d+)\)?/);
        if (match?.[1]) {
          return match[1].replace(/\\/g, '/').replace(/^.*?(packages\/|scripts\/|src\/)/, '$1');
        }
      }
    }
  }
  return undefined;
}

/**
 * Translates Zod validation issues into plain-English sentences
 */
function translateZodIssues(issues: Array<{ code?: string; path?: (string | number)[]; message?: string; expected?: string; received?: string; keys?: string[] }>): string[] {
  return issues.map((i) => {
    const rawPath = i.path ? i.path.filter((p) => typeof p === 'string' || typeof p === 'number').join('.') : '';
    const fieldName = rawPath ? `'${rawPath}'` : 'This field';
    const msg = i.message || '';

    if (i.code === 'invalid_type') {
      if (msg.includes('received undefined') || i.received === 'undefined' || (i as any).input === undefined) {
        return `Field ${fieldName} is required but was received empty.`;
      }
      if (msg.includes('received null') || i.received === 'null') {
        return `Field ${fieldName} cannot be null.`;
      }
      return `Field ${fieldName} expects ${i.expected ?? 'a valid value'}, but received an incompatible type.`;
    }
    if (i.code === 'too_small') {
      return `Field ${fieldName} is too short or below the required minimum.`;
    }
    if (i.code === 'too_big') {
      return `Field ${fieldName} exceeds the maximum allowed length or limit.`;
    }
    if (i.code === 'invalid_string' || i.code === 'invalid_format') {
      return `Field ${fieldName} has an invalid format (${msg || 'please check formatting'}).`;
    }
    if (i.code === 'unrecognized_keys' && i.keys) {
      return `Unexpected field(s) received: ${i.keys.map((k) => `'${k}'`).join(', ')}. Only defined fields are accepted.`;
    }
    return `Field ${fieldName}: ${msg || 'invalid input'}.`;
  });
}

/**
 * Translates any error into plain, simple English with actionable fix instructions.
 */
export function translateError(err: unknown, context?: { file?: string; route?: string; action?: string }): FriendlyErrorData {
  if (!err) {
    return {
      title: 'Unknown Error',
      whatHappened: 'An unexpected empty error was triggered.',
      howToFix: 'Check the calling function and ensure error details are provided.',
    };
  }

  const errorObj = err as Record<string, unknown>;
  const name = String(errorObj.name || (err instanceof Error ? err.constructor.name : 'Error'));
  const rawMessage = String(errorObj.message || err);
  const code = String(errorObj.code || '');
  const stack = err instanceof Error ? err.stack : typeof errorObj.stack === 'string' ? errorObj.stack : undefined;
  const detectedFile = context?.file || extractSourceLocation(stack);

  // 1. Prisma Database Errors
  if (code.startsWith('P') || name.includes('Prisma')) {
    switch (code) {
      case 'P1000':
        return {
          title: 'Database Authentication Failed',
          whatHappened: 'PostgreSQL rejected the username or password provided in your connection string.',
          details: 'Authentication error connecting to database server.',
          file: detectedFile,
          howToFix: 'Check your DATABASE_URL in the .env file. Ensure the username and password match your local PostgreSQL configuration.',
        };
      case 'P1001':
        return {
          title: 'Database Server Unreachable',
          whatHappened: 'The application cannot connect to the database server at the configured host and port.',
          details: 'Connection attempt failed or was refused.',
          file: detectedFile,
          howToFix: 'Verify PostgreSQL is running (e.g. check Windows Services or run Get-Service *postgres*) and listening on port 5432.',
        };
      case 'P1002':
        return {
          title: 'Database Connection Timed Out',
          whatHappened: 'The database server took too long to respond to the connection request.',
          file: detectedFile,
          howToFix: 'Check your network connection and ensure the database server is not overloaded.',
        };
      case 'P1003':
        return {
          title: 'Database Does Not Exist',
          whatHappened: 'The specific database name in your DATABASE_URL was not found on your PostgreSQL server.',
          file: detectedFile,
          howToFix: 'Connect to PostgreSQL via psql and create the missing database: CREATE DATABASE <database_name>;',
        };
      case 'P1008':
        return {
          title: 'Database Query Timed Out',
          whatHappened: 'A database query exceeded the maximum allowed execution time.',
          file: detectedFile,
          howToFix: 'Check table indexes, query complexity, or increase database timeout limits.',
        };
      case 'P1017':
        return {
          title: 'Database Connection Closed',
          whatHappened: 'The database server unexpectedly terminated the connection.',
          file: detectedFile,
          howToFix: 'Check PostgreSQL server error logs to see if the service restarted or exceeded maximum connections.',
        };
      case 'P2000':
        return {
          title: 'Input Value Too Long for Database Column',
          whatHappened: 'The provided data exceeds the maximum character length permitted by the database schema column.',
          file: detectedFile,
          howToFix: 'Shorten the input text to fit within the column length requirements.',
        };
      case 'P2001':
        return {
          title: 'Requested Record Not Found',
          whatHappened: 'The database record you were searching for does not exist.',
          file: detectedFile,
          howToFix: 'Verify that the ID or query criteria provided is correct.',
        };
      case 'P2002': {
        const meta = errorObj.meta as { target?: string[] | string } | undefined;
        const target = Array.isArray(meta?.target) ? meta.target.join(', ') : meta?.target ? String(meta.target) : 'a unique field';
        return {
          title: `Duplicate Record Conflict (${target})`,
          whatHappened: `A record with this ${target} already exists in the database.`,
          details: `Unique constraint violated on field(s): ${target}`,
          file: detectedFile,
          howToFix: `Provide a different ${target}, or update the existing record instead of creating a new one.`,
        };
      }
      case 'P2003':
        return {
          title: 'Foreign Key Constraint Violation',
          whatHappened: 'This operation failed because it references a related record that does not exist, or cannot be deleted due to existing references.',
          file: detectedFile,
          howToFix: 'Ensure the referenced item exists before linking, or remove dependent records before deleting.',
        };
      case 'P2021':
        return {
          title: 'Database Table Does Not Exist',
          whatHappened: 'A required table was not found in your PostgreSQL database.',
          details: rawMessage,
          file: detectedFile,
          howToFix: 'Deploy the database schema migrations by running: npm run prisma:deploy',
        };
      case 'P2022':
        return {
          title: 'Database Column Does Not Exist',
          whatHappened: 'A column queried by the application is missing from the database schema.',
          file: detectedFile,
          howToFix: 'Your code schema is newer than your database. Apply pending migrations with: npm run prisma:deploy',
        };
      case 'P2025':
        return {
          title: 'Record Not Found For Update or Delete',
          whatHappened: 'The record you tried to update or delete was not found in the database.',
          file: detectedFile,
          howToFix: 'Check that the record exists and that you are using the correct unique ID.',
        };
    }
  }

  // 2. System and Network Socket Errors
  if (code === 'ECONNREFUSED' || rawMessage.includes('ECONNREFUSED')) {
    const isPostgres = rawMessage.includes('5432') || rawMessage.includes('postgres');
    const isClamAv = rawMessage.includes('3310');
    return {
      title: isPostgres ? 'Database Service Stopped' : isClamAv ? 'ClamAV Service Not Found' : 'Connection Refused (ECONNREFUSED)',
      whatHappened: isPostgres
        ? 'The database service is stopped or port 5432 is unreachable on 127.0.0.1.'
        : isClamAv
          ? 'ClamAV antivirus daemon is enabled but not running on port 3310.'
          : 'A network connection attempt was refused by the target host and port.',
      details: redactSensitive(rawMessage),
      file: detectedFile,
      howToFix: isPostgres
        ? 'Start the PostgreSQL service in Windows Services or run: net start postgresql-x64-18'
        : isClamAv
          ? 'Start ClamAV, or set MALWARE_SCAN_ENABLED=false in your .env file for local offline development.'
          : 'Check if the target server process is running and that its port is listening.',
    };
  }

  if (code === 'EADDRINUSE' || rawMessage.includes('EADDRINUSE')) {
    const portMatch = rawMessage.match(/:\s*(\d+)/) || rawMessage.match(/port\s*(\d+)/i);
    const port = portMatch?.[1] ? `port ${portMatch[1]}` : 'the designated port';
    return {
      title: `Port Already In Use (${port})`,
      whatHappened: `Another application or dev server is already listening on ${port}.`,
      details: redactSensitive(rawMessage),
      file: detectedFile,
      howToFix: `Stop the process currently occupying ${port}, or adjust API_PORT or WEB_PORT in your .env file.`,
    };
  }

  if (code === 'ENOENT' || rawMessage.includes('ENOENT')) {
    return {
      title: 'File or Directory Not Found',
      whatHappened: 'The application tried to open or modify a file or folder that does not exist on disk.',
      details: redactSensitive(rawMessage),
      file: detectedFile,
      howToFix: 'Verify the file path exists, or ensure necessary directories (like storage roots) are created.',
    };
  }

  if (code === 'EACCES' || code === 'EPERM' || rawMessage.includes('EACCES') || rawMessage.includes('EPERM')) {
    return {
      title: 'Operating System Permission Denied',
      whatHappened: 'The operating system blocked the application from reading, writing, or executing the requested resource.',
      details: redactSensitive(rawMessage),
      file: detectedFile,
      howToFix: 'Check file and folder permissions, or run the terminal with appropriate privileges.',
    };
  }

  // 3. Zod Validation Errors
  if (name === 'ZodError' || Array.isArray(errorObj.issues)) {
    const issues = (errorObj.issues as unknown[]) || [];
    const plainIssues = translateZodIssues(issues as Parameters<typeof translateZodIssues>[0]);
    return {
      title: 'Request Validation Failed',
      whatHappened: `Received ${plainIssues.length} invalid or missing field${plainIssues.length > 1 ? 's' : ''} in the request.`,
      details: plainIssues.map((p, idx) => `${idx + 1}. ${p}`).join('\n'),
      file: detectedFile,
      howToFix: 'Review the field requirements above and submit the request with valid values.',
    };
  }

  // 4. JWT & Auth Errors
  if (name === 'TokenExpiredError' || rawMessage.includes('jwt expired')) {
    return {
      title: 'Authentication Session Expired',
      whatHappened: 'The access token provided has expired.',
      file: detectedFile,
      howToFix: 'Request a new access token via your refresh cookie or sign in again.',
    };
  }

  if (name === 'JsonWebTokenError' || rawMessage.includes('invalid signature') || rawMessage.includes('jwt malformed')) {
    return {
      title: 'Invalid Authentication Token',
      whatHappened: 'The authentication token signature is invalid, corrupted, or signed with an unrecognized key.',
      file: detectedFile,
      howToFix: 'Clear cookies and sign in again. Verify JWT_ACCESS_SECRET has not changed.',
    };
  }

  // 5. Generic Fallback
  return {
    title: name !== 'Error' ? name : 'Application Error',
    whatHappened: redactSensitive(rawMessage || 'An unexpected error occurred during execution.'),
    details: context?.action ? `Triggered during action: ${context.action}` : undefined,
    file: detectedFile,
    howToFix: 'Check the error message and file location above. Inspect application logs for further trace.',
  };
}

/**
 * Returns a fully formatted friendly error box string
 */
export function formatFriendlyError(err: unknown, context?: { file?: string; route?: string; action?: string; width?: number }): string {
  const data = translateError(err, context);
  const fields: { label: string; value: string }[] = [
    { label: 'What happened', value: data.whatHappened },
  ];

  if (data.details) {
    fields.push({ label: 'Details', value: data.details });
  }

  const location = data.file || context?.route;
  if (location) {
    fields.push({ label: 'File / Route', value: location });
  }

  fields.push({ label: 'How to fix it', value: data.howToFix });

  return formatBox({
    title: data.title,
    fields,
    severity: data.severity || 'error',
    width: context?.width,
  });
}

/**
 * Directly prints the formatted friendly error box to the terminal
 */
export function printFriendlyError(err: unknown, context?: { file?: string; route?: string; action?: string }): void {
  const box = formatFriendlyError(err, context);
  console.error(box);
}
