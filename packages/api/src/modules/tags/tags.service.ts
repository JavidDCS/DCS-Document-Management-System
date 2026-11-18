import { Prisma, type PrismaClient } from '@prisma/client';
import type { TagDto } from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { HttpError } from '../../utils/httpError.js';
import { likeEscape } from '../../utils/like.js';
import { recordAudit } from '../audit/index.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

const toDto = (t: { id: string; name: string; createdAt: Date }): TagDto => ({ id: t.id, name: t.name, createdAt: t.createdAt.toISOString() });
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export class TagsService {
  constructor(private readonly db: PrismaClient) {}

  private audit(tx: Prisma.TransactionClient, actor: AuthContext, action: string, id: string, meta: RequestMeta, details: Record<string, unknown>) {
    return recordAudit(tx, {
      actorType: 'USER',
      actorUserId: actor.userId,
      action,
      resourceType: 'tag',
      resourceId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      details,
    });
  }

  async list(q?: string | { search?: string | undefined; sortBy?: 'name' | 'createdAt' | undefined; sortOrder?: 'asc' | 'desc' | undefined; limit?: number | undefined; offset?: number | undefined }): Promise<TagDto[]> {
    const search = typeof q === 'string' ? q : q?.search;
    const sortBy = typeof q === 'object' && q?.sortBy ? q.sortBy : 'name';
    const sortOrder = typeof q === 'object' && q?.sortOrder ? q.sortOrder : 'asc';
    const limit = typeof q === 'object' && q?.limit ? q.limit : 500;
    const offset = typeof q === 'object' && q?.offset ? q.offset : 0;
    const rows = await this.db.tag.findMany({
      where: search ? { name: { contains: likeEscape(search), mode: 'insensitive' } } : {},
      orderBy: [{ [sortBy]: sortOrder }, { id: 'asc' }],
      take: limit,
      skip: offset,
    });
    return rows.map(toDto);
  }

  async create(actor: AuthContext, name: string, meta: RequestMeta): Promise<TagDto> {
    try {
      return await this.db.$transaction(async (tx) => {
        const t = await tx.tag.create({ data: { name, createdById: actor.userId } });
        await this.audit(tx, actor, 'TAG_CREATED', t.id, meta, { name });
        return toDto(t);
      });
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, 'A tag with this name already exists', 'CONFLICT');
      throw err;
    }
  }

  async rename(actor: AuthContext, id: string, name: string, meta: RequestMeta): Promise<TagDto> {
    try {
      return await this.db.$transaction(async (tx) => {
        const cur = await tx.tag.findUnique({ where: { id } });
        if (!cur) throw new HttpError(404, 'Tag not found');
        const t = await tx.tag.update({ where: { id }, data: { name } });
        await this.audit(tx, actor, 'TAG_RENAMED', id, meta, { from: cur.name, to: name });
        return toDto(t);
      });
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, 'A tag with this name already exists', 'CONFLICT');
      throw err;
    }
  }

  async remove(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const cur = await tx.tag.findUnique({ where: { id } });
      if (!cur) throw new HttpError(404, 'Tag not found');
      await tx.tag.delete({ where: { id } });
      await this.audit(tx, actor, 'TAG_DELETED', id, meta, { name: cur.name });
    });
  }
}
