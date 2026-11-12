import type { PrismaClient } from '@prisma/client';
import type { EmailListItem, EmailStatus } from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';

export function registerReportsRoutes(secure: SecureRouter, _ctx: AppContext, db: PrismaClient) {
  secure.get(
    '/reports/summary',
    can('reports:read'),
    asyncHandler(async (_req, res) => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const documentsActive = await db.document.count({ where: { isActive: true, archiveStatus: 'LIVE' } });
      const documentsInactive = await db.document.count({ where: { isActive: false, archiveStatus: 'LIVE' } });
      const versionsPending = await db.documentVersion.count({ where: { scanStatus: 'PENDING' } });
      const versionsQuarantined = await db.documentVersion.count({ where: { scanStatus: 'QUARANTINED' } });
      const emailsSent30d = await db.emailMessage.count({ where: { status: 'SENT', sentAt: { gte: thirtyDaysAgo } } });
      const emailsFailed30d = await db.emailMessage.count({ where: { status: 'FAILED', createdAt: { gte: thirtyDaysAgo } } });
      const usersActive = await db.user.count({ where: { status: 'ACTIVE' } });
      const recentEmailRows = await db.emailMessage.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: { select: { name: true } },
          _count: { select: { recipients: true, attachments: true } },
        },
      });

      const recentEmails: EmailListItem[] = recentEmailRows.map((m) => ({
        id: m.id,
        status: m.status as EmailStatus,
        subject: m.subject,
        from: m.fromAddress,
        sentAt: m.sentAt?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
        recipientCount: m._count.recipients,
        attachmentCount: m._count.attachments,
        senderName: m.sender.name,
      }));

      res.json({
        data: {
          documentsActive,
          documentsInactive,
          versionsPending,
          versionsQuarantined,
          emailsSent30d,
          emailsFailed30d,
          usersActive,
          recentEmails,
        },
      });
    })
  );
}
