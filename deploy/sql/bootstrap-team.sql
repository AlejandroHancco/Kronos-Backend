-- Creates (or updates) a research group and makes an already-registered user its admin,
-- so others can join with the group's code and the admin can accept them.
-- Idempotent: re-running it renames the group / re-grants ADMIN, it never duplicates rows.
--
-- The admin must have signed up in the app first (the row in platform.users is created at
-- the first login). On the data VM:
--   docker exec -i vm-data-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -v team_name="GIOT" -v team_code="GIOT2026" -v admin_email="someone@pucp.edu.pe"' \
--     < bootstrap-team.sql
\set ON_ERROR_STOP on

SELECT EXISTS (SELECT 1 FROM platform.users WHERE email = :'admin_email') AS admin_exists \gset
\if :admin_exists
\else
  DO $$ BEGIN RAISE EXCEPTION 'Admin user not found: sign up in the app first, then re-run'; END $$;
\endif

BEGIN;

INSERT INTO platform.teams (id, name, code, "createdAt")
VALUES (gen_random_uuid()::text, :'team_name', :'team_code', now())
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO platform.team_members (id, "userId", "teamId", role, status, "createdAt")
SELECT gen_random_uuid()::text, u.uuid, t.id,
       'ADMIN'::platform."TeamRole", 'APPROVED'::platform."MemberStatus", now()
FROM platform.users u, platform.teams t
WHERE u.email = :'admin_email' AND t.code = :'team_code'
ON CONFLICT ("userId", "teamId") DO UPDATE
  SET role = 'ADMIN'::platform."TeamRole", status = 'APPROVED'::platform."MemberStatus";

COMMIT;

SELECT t.name AS team, t.code, u.email AS admin, m.role, m.status
FROM platform.team_members m
JOIN platform.teams t ON t.id = m."teamId"
JOIN platform.users u ON u.uuid = m."userId"
WHERE t.code = :'team_code' AND m.role = 'ADMIN';
