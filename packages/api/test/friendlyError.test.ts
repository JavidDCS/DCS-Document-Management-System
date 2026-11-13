import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatBox, formatFriendlyError, redactSensitive, translateError } from '@dcs-docs/shared';

describe('friendly error formatter', () => {
  it('translates Prisma P2002 duplicate errors with target fields into plain English', () => {
    const prismaError = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: ['email'] },
      message: 'Unique constraint failed on the fields: (`email`)',
    };

    const translated = translateError(prismaError);
    expect(translated.title).toContain('Duplicate Record Conflict (email)');
    expect(translated.whatHappened).toBe('A record with this email already exists in the database.');
    expect(translated.howToFix).toContain('Provide a different email');

    const formatted = formatFriendlyError(prismaError);
    expect(formatted).toContain('🚨 ERROR: Duplicate Record Conflict (email)');
    expect(formatted).toContain('What happened');
    expect(formatted).toContain('How to fix it');
    expect(formatted).toContain('┌');
    expect(formatted).toContain('└');
  });

  it('translates Prisma P1000 database auth errors into plain English', () => {
    const error = { code: 'P1000', message: 'Authentication failed' };
    const translated = translateError(error);
    expect(translated.title).toBe('Database Authentication Failed');
    expect(translated.whatHappened).toContain('PostgreSQL rejected the username or password');
    expect(translated.howToFix).toContain('DATABASE_URL');
  });

  it('translates Prisma P1001 unreachable database into plain English', () => {
    const error = { code: 'P1001', message: 'Can not reach database server' };
    const translated = translateError(error);
    expect(translated.title).toBe('Database Server Unreachable');
    expect(translated.howToFix).toContain('5432');
  });

  it('translates ECONNREFUSED on port 5432 into plain English', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    (error as any).code = 'ECONNREFUSED';
    const translated = translateError(error);
    expect(translated.title).toBe('Database Service Stopped');
    expect(translated.whatHappened).toContain('port 5432 is unreachable');
    expect(translated.howToFix).toContain('PostgreSQL service');
  });

  it('translates EADDRINUSE into plain English', () => {
    const error = new Error('listen EADDRINUSE: address already in use :::7800');
    (error as any).code = 'EADDRINUSE';
    const translated = translateError(error);
    expect(translated.title).toContain('Port Already In Use');
    expect(translated.whatHappened).toContain('7800');
    expect(translated.howToFix).toContain('API_PORT');
  });

  it('translates Zod validation errors into plain English sentences', () => {
    const schema = z.object({
      name: z.string().min(3),
      email: z.string().email(),
    });

    const result = schema.safeParse({ name: 'a' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const translated = translateError(result.error);
      expect(translated.title).toBe('Request Validation Failed');
      expect(translated.details).toContain("Field 'name'");
      expect(translated.details).toContain("Field 'email' is required but was received empty");
    }
  });

  it('redacts sensitive passwords and bearer tokens in formatted error boxes', () => {
    const raw = 'Failed to connect: postgresql://postgres:SecretPass123@localhost:5432/db with token Bearer abc.123.xyz';
    const clean = redactSensitive(raw);
    expect(clean).not.toContain('SecretPass123');
    expect(clean).toContain('postgresql://postgres:***@localhost:5432/db');
    expect(clean).toContain('Bearer [REDACTED]');
  });

  it('formats custom box borders cleanly with given width', () => {
    const box = formatBox({
      title: 'Test Box',
      fields: [
        { label: 'Key', value: 'Value' },
        { label: 'Description', value: 'This is a long description that should wrap cleanly without overflowing borders.' },
      ],
      width: 70,
    });
    expect(box).toContain('┌');
    expect(box).toContain('└');
    expect(box).toContain('Key');
    expect(box).toContain('Value');
  });
});
