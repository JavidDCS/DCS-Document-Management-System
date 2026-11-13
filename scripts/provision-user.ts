import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = 'javidfazil3030@gmail.com';
  const name = 'Javid Fazil';

  const user = await prisma.user.upsert({
    where: { email },
    update: { status: 'ACTIVE' },
    create: {
      email,
      name,
      status: 'ACTIVE',
    },
  });

  await prisma.userRole.upsert({
    where: {
      userId_role: {
        userId: user.id,
        role: 'SUPER_ADMIN',
      },
    },
    update: {},
    create: {
      userId: user.id,
      role: 'SUPER_ADMIN',
    },
  });

  console.log(`✅ Successfully provisioned ${email} as SUPER_ADMIN (User ID: ${user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
