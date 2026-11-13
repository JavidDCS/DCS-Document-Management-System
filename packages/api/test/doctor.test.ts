import { describe, expect, it } from 'vitest';
import { formatBox, formatFriendlyError, translateError } from '@dcs-docs/shared';

describe('Doctor & Friendly Error Formatter Coverage', () => {
  it('translates P1000 database password incorrect into plain English', () => {
    const err = { code: 'P1000', message: 'Authentication failed against database server' };
    const res = translateError(err);
    expect(res.title).toBe('Database Authentication Failed');
    expect(res.whatHappened).toContain('PostgreSQL rejected the username or password');
    expect(res.howToFix).toContain('DATABASE_URL');
  });

  it('translates P2002 duplicate unique value into plain English', () => {
    const err = { code: 'P2002', meta: { target: ['phone'] }, message: 'Unique constraint failed on phone' };
    const res = translateError(err);
    expect(res.title).toContain('Duplicate Record Conflict (phone)');
    expect(res.whatHappened).toContain('A record with this phone already exists in the database.');
    expect(res.howToFix).toContain('Provide a different phone, or update the existing record');
  });

  it('translates P2025 record not found into plain English', () => {
    const err = { code: 'P2025', message: 'An operation failed because it depends on one or more records that were required but not found.' };
    const res = translateError(err);
    expect(res.title).toBe('Record Not Found For Update or Delete');
    expect(res.whatHappened).toContain('The record you tried to update or delete was not found in the database.');
    expect(res.howToFix).toContain('Check that the record exists and that you are using the correct unique ID.');
  });

  it('translates ECONNREFUSED into plain English', () => {
    const err = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' };
    const res = translateError(err);
    expect(res.title).toBe('Database Service Stopped');
    expect(res.whatHappened).toContain('The database service is stopped or port 5432 is unreachable on 127.0.0.1.');
    expect(res.howToFix).toContain('Start the PostgreSQL service in Windows Services');
  });

  it('translates Zod validation errors into plain English', () => {
    const zodError = {
      name: 'ZodError',
      issues: [
        { code: 'invalid_type', path: ['contactName'], message: 'Invalid input: expected string, received undefined' },
        { code: 'too_small', path: ['password'], message: 'Too small' },
      ],
    };
    const res = translateError(zodError);
    expect(res.title).toBe('Request Validation Failed');
    expect(res.details).toContain("Field 'contactName' is required but was received empty.");
    expect(res.details).toContain("Field 'password' is too short or below the required minimum.");
  });

  it('renders a formatted ASCII box matching exact specifications', () => {
    const box = formatBox({
      title: 'ERROR: Duplicate Lead Phone Number',
      fields: [
        { label: 'What happened', value: 'A lead with phone "9876543210" already exists in the database' },
        { label: 'File', value: 'src/modules/leads/leads.service.ts (Line 42)' },
        { label: 'How to fix it', value: 'Check if this lead was already added, or update the number.' },
      ],
      severity: 'error',
      width: 80,
    });

    expect(box).toContain('┌');
    expect(box).toContain('ERROR: Duplicate Lead Phone Number');
    expect(box).toContain('What happened');
    expect(box).toContain('9876543210');
    expect(box).toContain('How to fix it');
    expect(box).toContain('└');
  });
});
