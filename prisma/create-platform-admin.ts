import * as bcrypt from 'bcrypt';
import { createSeedClient } from './seed-client';
import { readHidden, validatePassword } from './password-prompt';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new Error(
      'Uso: npx tsx prisma/create-platform-admin.ts <email>',
    );
  }

  const password = await readHidden('Contraseña: ');
  const invalid = validatePassword(password);
  if (invalid) throw new Error(invalid);
  const confirm = await readHidden('Repite la contraseña: ');
  if (confirm !== password) throw new Error('Las contraseñas no coinciden.');

  const { prisma, pool } = createSeedClient();
  try {
    const hash = await bcrypt.hash(password, 10);
    await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { email },
        select: { uuid: true },
      });
      if (existing) {
        const memberships = await tx.teamMember.count({
          where: { userId: existing.uuid },
        });
        if (memberships > 0) {
          throw new Error(
            'Ese usuario pertenece a un grupo (team_members). Quítalo del grupo primero.',
          );
        }
      }
      await tx.user.upsert({
        where: { email },
        create: {
          email,
          name: 'Superadministrador',
          provider: 'password',
          emailVerified: true,
          isPlatformAdmin: true,
          password: hash,
        },
        update: {
          password: hash,
          provider: 'password',
          emailVerified: true,
          isPlatformAdmin: true,
          passwordChangedAt: new Date(),
        },
      });
    });
    console.log(`Superadministrador listo: ${email}`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
