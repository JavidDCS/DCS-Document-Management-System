import { prisma } from '../src/db/prisma.js';
import { verifyAuditChain } from '../src/modules/audit/index.js';

/**
 * Usage: npm run audit:verify [-- --anchor <headHash>]
 * Exit code 0 = chain intact, 1 = tampering detected, 2 = could not run. Prints only ids and hashes.
 * Store the printed head hash somewhere outside the database (the "anchor") and pass it next time.
 */
async function main() {
  const i = process.argv.indexOf('--anchor');
  const anchorHash = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && !(anchorHash && /^[0-9a-f]{64}$/.test(anchorHash))) {
    console.error('--anchor must be a 64-character lowercase hex hash');
    return 2;
  }

  const result = await verifyAuditChain(prisma, anchorHash ? { anchorHash } : {});
  console.log(`entries checked: ${result.checked}`);
  console.log(`head hash: ${result.headHash ?? '(empty chain)'}`);
  if (result.ok) {
    console.log('audit chain: OK');
    return 0;
  }
  console.error(`audit chain: TAMPERING DETECTED (${result.failure?.reason}, entry ${result.failure?.entryId ?? 'n/a'})`);
  return 1;
}

main()
  .then((code) => prisma.$disconnect().finally(() => process.exit(code)))
  .catch(async (err) => {
    console.error('audit verification could not run:', (err as Error).message);
    await prisma.$disconnect();
    process.exit(2);
  });
