import { prisma } from '../src/db/prisma.js';
import { recordAudit } from '../src/modules/audit/index.js';

/**
 * Usage: npm run seed:integration-types -w packages/api
 * Ensures the two document types the Leads Manager integration refers to by key ("nda", "teaser") exist, so a
 * hand-off or the type-filtered document list has something real to point at. Idempotent: matched by key, skips
 * anything that already exists, safe to run repeatedly. Never touches an existing type's name or settings.
 */
const TYPES: { key: string; name: string }[] = [
  { key: 'nda', name: 'NDA' },
  { key: 'teaser', name: 'Teaser' },
];

async function main(): Promise<number> {
  for (const t of TYPES) {
    const existing = await prisma.documentType.findUnique({ where: { key: t.key } });
    if (existing) {
      console.log(`Skipped (already exists): ${t.key} -> "${existing.name}"`);
      continue;
    }
    const created = await prisma.documentType.create({ data: { key: t.key, name: t.name } });
    await recordAudit(prisma, {
      actorType: 'SYSTEM',
      action: 'DOCUMENT_TYPE_CREATED',
      resourceType: 'document_type',
      resourceId: created.id,
      details: { key: t.key, name: t.name, via: 'seed-integration-types-cli' },
    });
    console.log(`Created: ${t.key} ("${t.name}")`);
  }
  return 0;
}

main()
  .then((code) => prisma.$disconnect().finally(() => process.exit(code)))
  .catch(async (err) => {
    console.error('Seed failed:', (err as Error).message);
    await prisma.$disconnect();
    process.exit(1);
  });
