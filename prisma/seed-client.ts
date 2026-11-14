import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// Prisma 7 requires a driver adapter. Same wiring as libs/database PrismaService.
// Tables are qualified by the models' @@schema("platform"), no extra option needed.
export function createSeedClient() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  return { prisma, pool };
}
