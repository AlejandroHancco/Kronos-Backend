-- AlterTable
ALTER TABLE "platform"."users" ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "platform"."team_admin_grants" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "invitedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(6),
    "claimedById" UUID,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "team_admin_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_admin_grants_email_idx" ON "platform"."team_admin_grants"("email");

-- AddForeignKey
ALTER TABLE "platform"."team_admin_grants" ADD CONSTRAINT "team_admin_grants_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "platform"."teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."team_admin_grants" ADD CONSTRAINT "team_admin_grants_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "platform"."users"("uuid") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."team_admin_grants" ADD CONSTRAINT "team_admin_grants_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "platform"."users"("uuid") ON DELETE SET NULL ON UPDATE CASCADE;

