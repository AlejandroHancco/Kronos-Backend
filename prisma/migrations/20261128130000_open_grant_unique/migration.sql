-- Como mucho una invitación de administrador abierta por (email, grupo).
-- Índice parcial: Prisma no puede expresarlo en schema.prisma (ver comentario en el modelo TeamAdminGrant).
-- Antes de crearlo, revoca duplicados abiertos que pudieran existir (se conserva el más antiguo).
UPDATE "platform"."team_admin_grants" g
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE g."claimedAt" IS NULL
  AND g."revokedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "platform"."team_admin_grants" o
    WHERE o.email = g.email
      AND o."teamId" = g."teamId"
      AND o."claimedAt" IS NULL
      AND o."revokedAt" IS NULL
      AND (o."createdAt", o.id) < (g."createdAt", g.id)
  );

CREATE UNIQUE INDEX "team_admin_grants_open_email_team_key"
  ON "platform"."team_admin_grants" (email, "teamId")
  WHERE "claimedAt" IS NULL AND "revokedAt" IS NULL;
