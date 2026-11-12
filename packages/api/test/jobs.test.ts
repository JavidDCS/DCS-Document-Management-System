import { afterAll, describe, expect, it } from 'vitest';
import { backoffMs, enqueueJob, JobRunner } from '../src/modules/jobs/jobs.js';
import { skipDb, testPrisma } from './helpers/db.js';

describe('backoff', () => {
  it('doubles from 5 seconds and caps at one hour', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5000, 10_000, 20_000, 40_000]);
    expect(backoffMs(30)).toBe(3_600_000);
  });
});

describe.skipIf(skipDb)('background jobs (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  afterAll(() => prisma.$disconnect());
  const cfg = { JOBS_MAX_ATTEMPTS: 3, JOBS_LEASE_MS: 60_000, JOBS_POLL_INTERVAL_MS: 250 };
  const type = () => `test_${Math.random().toString(36).slice(2, 8)}`;
  const key = () => `k-${Math.random().toString(36).slice(2)}`;
  const row = (id: string) => prisma.backgroundJob.findUniqueOrThrow({ where: { id } });
  const make = async (t: string, over: object = {}) => {
    const dedupeKey = key();
    await enqueueJob(prisma, { type: t, payload: { n: 1 }, dedupeKey, ...over });
    return prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey } });
  };
  const runnerFor = (t: string, handler: (j: any) => Promise<void>) => new JobRunner(prisma, cfg).register(t, handler);
  /** Only jobs of this type are due, so other suites' jobs do not interfere. */
  const only = async (t: string) => {
    await prisma.backgroundJob.updateMany({ where: { type: { not: t }, status: 'PENDING' }, data: { availableAt: new Date(Date.now() + 3_600_000) } });
  };

  it('runs a job once and marks it DONE', async () => {
    const t = type();
    await only(t);
    const job = await make(t);
    const seen: unknown[] = [];
    const runner = runnerFor(t, async (j) => void seen.push(j.payload));
    expect(await runner.runOnce()).toBe(true);
    expect(seen).toEqual([{ n: 1 }]);
    expect(await row(job.id)).toMatchObject({ status: 'DONE', attempts: 1, lockedUntil: null });
    expect(await runner.runOnce()).toBe(false);
  });

  it('enqueueing the same dedupe key twice creates one job', async () => {
    const t = type();
    const dedupeKey = key();
    await enqueueJob(prisma, { type: t, payload: {}, dedupeKey });
    await enqueueJob(prisma, { type: t, payload: {}, dedupeKey });
    expect(await prisma.backgroundJob.count({ where: { dedupeKey } })).toBe(1);
  });

  it('creates no job when the surrounding transaction rolls back', async () => {
    const dedupeKey = key();
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueJob(tx, { type: type(), payload: {}, dedupeKey });
        throw new Error('business change failed');
      })
    ).rejects.toThrow();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey } })).toBe(0);
  });

  it('does not run a job before it is due', async () => {
    const t = type();
    await only(t);
    await make(t, { delayMs: 3_600_000 });
    expect(await runnerFor(t, async () => undefined).runOnce()).toBe(false);
  });

  it('retries a failing job with backoff, then succeeds', async () => {
    const t = type();
    await only(t);
    const job = await make(t);
    let calls = 0;
    const runner = runnerFor(t, async () => {
      if (++calls < 2) throw new Error('temporary failure token=abc123secret');
    });
    await runner.runOnce();
    const after1 = await row(job.id);
    expect(after1).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(after1.availableAt.getTime()).toBeGreaterThan(Date.now() + 3000);
    expect(after1.lastError).toContain('temporary failure');
    expect(after1.lastError).not.toContain('abc123secret'); // secrets are redacted from stored errors
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { availableAt: new Date() } });
    await runner.runOnce();
    expect(await row(job.id)).toMatchObject({ status: 'DONE', attempts: 2 });
  });

  it('parks a job as DEAD after the maximum attempts and calls the dead-letter hook once', async () => {
    const t = type();
    await only(t);
    const job = await make(t);
    const dead: string[] = [];
    const runner = runnerFor(t, async () => {
      throw new Error('always broken');
    }).setDeadLetterHook((j, e) => void dead.push(`${j.type}:${e}`));
    for (let i = 0; i < 3; i++) {
      await runner.runOnce();
      await prisma.backgroundJob.update({ where: { id: job.id }, data: { availableAt: new Date() } }).catch(() => undefined);
    }
    expect(await row(job.id)).toMatchObject({ status: 'DEAD', attempts: 3 });
    expect(dead).toEqual([`${t}:always broken`]);
    expect(await runner.runOnce()).toBe(false); // a DEAD job is never picked up again
  });

  it('fails (and eventually dead-letters) a job with no registered handler', async () => {
    const t = type();
    await only(t);
    const job = await make(t);
    await new JobRunner(prisma, { ...cfg, JOBS_MAX_ATTEMPTS: 1 }).runOnce();
    const r = await row(job.id);
    expect(r.status).toBe('DEAD');
    expect(r.lastError).toContain('No handler');
  });

  it('reclaims a job whose worker died (expired lease)', async () => {
    const t = type();
    await only(t);
    const job = await make(t);
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'PROCESSING', attempts: 1, lockedUntil: new Date(Date.now() - 1000) } });
    let ran = false;
    await runnerFor(t, async () => void (ran = true)).runOnce();
    expect(ran).toBe(true);
    expect(await row(job.id)).toMatchObject({ status: 'DONE', attempts: 2 });
  });

  it('does not take a job that another worker still holds', async () => {
    const t = type();
    await only(t);
    const job = await make(t);
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'PROCESSING', attempts: 1, lockedUntil: new Date(Date.now() + 60_000) } });
    expect(await runnerFor(t, async () => undefined).runOnce()).toBe(false);
  });

  it('gives every job to exactly one of several concurrent workers', async () => {
    const t = type();
    await only(t);
    const ids = await Promise.all(Array.from({ length: 12 }, () => make(t).then((j) => j.id)));
    const handled: string[] = [];
    const worker = () => runnerFor(t, async (j) => void handled.push(j.id)).drain();
    await Promise.all([worker(), worker(), worker(), worker()]);
    expect(handled.sort()).toEqual([...ids].sort());
    expect(await prisma.backgroundJob.count({ where: { type: t, status: 'DONE' } })).toBe(12);
  });

  it('start/stop runs due jobs in the background', async () => {
    const t = type();
    await only(t);
    const job = await make(t);
    const runner = runnerFor(t, async () => undefined);
    runner.start();
    for (let i = 0; i < 40 && (await row(job.id)).status !== 'DONE'; i++) await new Promise((r) => setTimeout(r, 100));
    await runner.stop();
    expect((await row(job.id)).status).toBe('DONE');
  });
});
