-- AlterEnum (the new value is not used in this migration, so it is safe inside a transaction)
ALTER TYPE "platform"."ScheduledJobStatus" ADD VALUE IF NOT EXISTS 'missed';

-- AlterTable: seriesStartAt is added nullable, backfilled, then made required
ALTER TABLE "platform"."scheduled_jobs" ADD COLUMN     "delaySeconds" INTEGER,
ADD COLUMN     "finishedAt" TIMESTAMPTZ(6),
ADD COLUMN     "missReason" VARCHAR(40),
ADD COLUMN     "reservedSeconds" INTEGER NOT NULL DEFAULT 600,
ADD COLUMN     "seriesStartAt" TIMESTAMPTZ(6),
ADD COLUMN     "startedAt" TIMESTAMPTZ(6),
ADD COLUMN     "toleranceMinutes" INTEGER NOT NULL DEFAULT 5;

-- Backfill: the grid origin of each existing series
UPDATE "platform"."scheduled_jobs"
SET "seriesStartAt" = "startAt" - ("executionIndex" - 1) * COALESCE("intervalMinutes", 0) * interval '1 minute';

ALTER TABLE "platform"."scheduled_jobs" ALTER COLUMN "seriesStartAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "scheduled_jobs_status_startAt_idx" ON "platform"."scheduled_jobs"("status", "startAt");
