-- Reconciles objects that existed only in hand-edited databases so that a fresh
-- `prisma migrate deploy` matches schema.prisma. Idempotent on databases that
-- already have them.

-- AlterTable (column used by scheduled measurements; never created by a migration)
ALTER TABLE "scheduled_jobs" ADD COLUMN IF NOT EXISTS "executionIndex" INTEGER NOT NULL DEFAULT 1;

-- Align activity FKs with schema.prisma (ON UPDATE CASCADE)
ALTER TABLE "activity_events" DROP CONSTRAINT IF EXISTS "activity_events_teamId_fkey";
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "activity_event_recipients" DROP CONSTRAINT IF EXISTS "activity_event_recipients_eventId_fkey";
ALTER TABLE "activity_event_recipients" ADD CONSTRAINT "activity_event_recipients_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "activity_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "activity_event_recipients" DROP CONSTRAINT IF EXISTS "activity_event_recipients_userId_fkey";
ALTER TABLE "activity_event_recipients" ADD CONSTRAINT "activity_event_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid") ON DELETE CASCADE ON UPDATE CASCADE;
