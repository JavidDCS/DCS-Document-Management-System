import { Prisma, type PrismaClient } from '@prisma/client';
import { logger, redactString } from '../../utils/logger.js';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface EnqueueInput {
  type: string;
  payload: Record<string, unknown>;
  /** One row per business action: enqueueing the same key again is a no-op. */
  dedupeKey: string;
  delayMs?: number;
}

/** Write inside the caller's transaction so the job exists if and only if the business change committed. */
export async function enqueueJob(db: Tx, job: EnqueueInput): Promise<void> {
  try {
    await db.backgroundJob.create({
      data: {
        type: job.type,
        payload: job.payload as Prisma.InputJsonObject,
        dedupeKey: job.dedupeKey,
        availableAt: new Date(Date.now() + (job.delayMs ?? 0)),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
    throw err;
  }
}

export interface JobContext {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
}

export type JobHandler = (job: JobContext) => Promise<void>;

export interface JobsConfig {
  JOBS_MAX_ATTEMPTS: number;
  JOBS_LEASE_MS: number;
  JOBS_POLL_INTERVAL_MS: number;
}

/** Delay before retry n (1-based): 5s, 10s, 20s ... capped at 1 hour. */
export const backoffMs = (attempt: number) => Math.min(5000 * 2 ** (attempt - 1), 3_600_000);

/**
 * Runs jobs from the background_jobs table: claims one row at a time with `FOR UPDATE SKIP LOCKED`, holds a lease
 * (a crashed worker's job is picked up again when the lease expires), retries with exponential backoff and parks a
 * job as DEAD after the maximum attempts (reported through `onDead`). Handlers must be idempotent.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private readonly handlers = new Map<string, JobHandler>();
  private onDead: (job: JobContext, error: string) => Promise<void> | void = () => undefined;

  constructor(
    private readonly db: PrismaClient,
    private readonly cfg: JobsConfig
  ) {}

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  setDeadLetterHook(hook: (job: JobContext, error: string) => Promise<void> | void): this {
    this.onDead = hook;
    return this;
  }

  private async claim(): Promise<JobContext | null> {
    const rows = await this.db.$queryRaw<{ id: string; type: string; payload: Record<string, unknown>; attempts: number }[]>`
      UPDATE background_jobs
         SET status = 'PROCESSING',
             attempts = attempts + 1,
             locked_until = now() + (${this.cfg.JOBS_LEASE_MS}::int * interval '1 millisecond')
       WHERE id = (
         SELECT id FROM background_jobs
          WHERE (status = 'PENDING' AND available_at <= now())
             OR (status = 'PROCESSING' AND locked_until < now())
          ORDER BY available_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1)
      RETURNING id, type, payload, attempts`;
    const r = rows[0];
    return r ? { id: r.id, type: r.type, payload: r.payload, attempt: r.attempts, maxAttempts: this.cfg.JOBS_MAX_ATTEMPTS } : null;
  }

  /** Processes at most one due job. Returns true if one was handled (successfully or not). */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
      await handler(job);
      await this.db.backgroundJob.update({ where: { id: job.id }, data: { status: 'DONE', processedAt: new Date(), lockedUntil: null, lastError: null } });
    } catch (err) {
      const message = redactString(err instanceof Error ? err.message : String(err)).slice(0, 1000);
      if (job.attempt >= job.maxAttempts) {
        await this.db.backgroundJob.update({ where: { id: job.id }, data: { status: 'DEAD', lockedUntil: null, lastError: message, processedAt: new Date() } });
        logger.error('Job moved to dead letter', { jobId: job.id, type: job.type, attempts: job.attempt });
        try {
          await this.onDead(job, message);
        } catch (hookErr) {
          logger.error('Dead-letter hook failed', hookErr);
        }
      } else {
        await this.db.backgroundJob.update({
          where: { id: job.id },
          data: { status: 'PENDING', lockedUntil: null, lastError: message, availableAt: new Date(Date.now() + backoffMs(job.attempt)) },
        });
        logger.warn('Job failed, will retry', { jobId: job.id, type: job.type, attempt: job.attempt, error: message });
      }
    }
    return true;
  }

  /** Test helper: processes jobs until none are due. */
  async drain(limit = 100): Promise<number> {
    let n = 0;
    while (n < limit && (await this.runOnce())) n++;
    return n;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      this.running = true;
      try {
        while (!this.stopped && (await this.runOnce())) {
          /* keep going while there is work */
        }
      } catch (err) {
        logger.error('Job runner error', err);
      } finally {
        this.running = false;
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.cfg.JOBS_POLL_INTERVAL_MS);
    };
    this.timer = setTimeout(tick, 250);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }
}
