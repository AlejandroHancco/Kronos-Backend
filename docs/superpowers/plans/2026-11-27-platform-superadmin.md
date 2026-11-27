# Platform Superadmin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated platform superadmin account that, from its own `/platform` dashboard, creates research groups and names/removes their admins by email, without seeing any group data.

**Architecture:** `users.isPlatformAdmin` flag (set only by a server CLI) + `team_admin_grants` table claimed on `GET /auth/me` when the user's verified email matches. A shared `TeamAdminService` owns "make/unmake team admin" (team role + project-role propagation + cache invalidation) for both the existing teams flow and the new platform flow. New `/platform/*` API behind a `PlatformAdminGuard`; new `/platform` page in the frontend.

**Tech Stack:** NestJS 11, Prisma 7 (`schema "platform"`, adapter-pg), Jest, React + Vite + TanStack Query, Kronos UI components.

**Spec:** `docs/superpowers/specs/2026-11-27-platform-superadmin-design.md`

## Global Constraints
- Superadmin is never created/changed through HTTP; only `prisma/create-platform-admin.ts` sets `isPlatformAdmin`.
- Grant email stored lower-cased; matching is case-insensitive; applied only if `emailVerified = true`.
- Notice email contains no token: text "Te nombraron administrador/a de <grupo> en KRONOS. Entra en <FRONTEND_URL> y regístrate o inicia sesión con este correo."
- 409 cases (Spanish messages): already APPROVED in another team; banned account; target is platform admin; last ADMIN; last open grant of a team with no admin; duplicate team code.
- Password via CLI: hidden prompt twice, ≥ 8 chars, ≤ 72 UTF-8 bytes, bcrypt cost 10 (same as `/auth/register`).
- Commits: no Co-Authored-By or any AI attribution lines.

## Review Focus
- Mixed-case email in grant vs account (`Maria@PUCP.edu.pe` vs `maria@pucp.edu.pe`) → still claimed. Test in Task 2.
- `/auth/me` called repeatedly → claim idempotent, no duplicate members, no repeated emails. Test in Task 2.
- Unverified password account with an open grant → not claimed until verified, then claimed on next `/auth/me`. Test in Task 2.
- Non-superadmin (team ADMIN) calling `/platform/teams` → 403. Test in Task 4.
- Demoting the last admin / revoking the only grant of an adminless team → 409, data unchanged. Test in Task 4.

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (model `User`, model `Team`, new model `TeamAdminGrant`)
- Create: `prisma/migrations/20261127120000_platform_admin/migration.sql`

**Interfaces:**
- Produces: `User.isPlatformAdmin: boolean`; `TeamAdminGrant { id: string; email: string; teamId: string; invitedById: string; createdAt: Date; claimedAt: Date | null; claimedById: string | null; revokedAt: Date | null }` mapped to `platform.team_admin_grants`, relations `team`, `invitedBy`, `claimedBy`; index on `email`.

- [ ] **Step 1:** Add `isPlatformAdmin Boolean @default(false)` to `User`; add `TeamAdminGrant` (`id String @id @default(uuid())`, relations with named relations `"GrantInvitedBy"` / `"GrantClaimedBy"`, `@@index([email])`, `@@map("team_admin_grants")`, `@@schema("platform")`) and back-relations on `User`/`Team`.
- [ ] **Step 2:** Write `migration.sql` by hand (local DB not available): `ALTER TABLE "platform"."users" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;`, `CREATE TABLE "platform"."team_admin_grants" (...)` with FKs (team ON DELETE CASCADE, users ON DELETE RESTRICT / SET NULL for claimedBy), index on `email`. Column names/types must match what `prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel prisma/schema.prisma --script` would emit; run that command to generate it if possible and paste the output.
- [ ] **Step 3:** Run `npx prisma generate && npx tsc --noEmit -p tsconfig.json` → no errors.
- [ ] **Step 4:** Commit `feat(db): platform admin flag and team admin grants`.

### Task 2: TeamAdminService (shared admin logic + grant claiming)

**Files:**
- Create: `apps/api/src/teams/team-admin.service.ts`, `apps/api/src/teams/team-admin.service.spec.ts`
- Modify: `apps/api/src/teams/teams.service.ts` (`updateMemberRole` uses `TeamAdminService.setTeamRole`; delete private `propagateRoleToProjects`), `apps/api/src/teams/teams.module.ts` (provide + export `TeamAdminService`; import `PermissionsModule` if needed)

**Interfaces:**
- Consumes: Task 1 models; `PermissionsService.invalidateUserCache(userId)`.
- Produces:
  - `setTeamRole(teamId: string, userId: string, role: 'ADMIN' | 'MEMBER'): Promise<void>` — upserts `TeamMember` (ADMIN ⇒ status APPROVED), propagates project roles (ADMIN → role id 2, MEMBER → 4) exactly like the old `propagateRoleToProjects`, invalidates cache.
  - `adminBlockReason(user: { uuid: string; banned: boolean; isPlatformAdmin: boolean }, teamId: string): Promise<string | null>` — `'cuenta suspendida'`, `'es superadministrador'`, `'ya pertenece a <team name>'` (APPROVED in another team), else null.
  - `claimPendingGrants(userId: string): Promise<number>` — number of grants applied.

- [ ] **Step 1: Failing tests** in `team-admin.service.spec.ts` (mocked prisma like `email-verification.service.spec.ts`):
  - `claims an open grant for a verified user, case-insensitively` — user `{ email: 'Maria@PUCP.edu.pe', emailVerified: true }`, grant `email: 'maria@pucp.edu.pe'` → `teamMember.upsert` with `role: 'ADMIN', status: 'APPROVED'`, grant updated with `claimedAt` and `claimedById`, `invalidateUserCache('u1')`, returns 1.
  - `does nothing for an unverified user` → returns 0, no upsert.
  - `is idempotent` — second call finds no open grants (query filters `claimedAt: null, revokedAt: null`) → returns 0.
  - `leaves the grant open when the user is APPROVED in another team` and `when the user is banned` → returns 0, grant not updated.
  - `deletes PENDING/REJECTED memberships in other teams when claiming` → `teamMember.deleteMany({ where: { userId, teamId: { not: teamId }, status: { in: ['PENDING','REJECTED'] } } })`.
  - `setTeamRole('t1','u1','MEMBER') upserts role 4 on the team projects and invalidates cache`.
- [ ] **Step 2:** Run `npx jest apps/api/src/teams/team-admin.service.spec.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the service; claim each grant in one `$transaction` (delete other non-approved rows, upsert member, mark grant), then project-role propagation + cache invalidation.
- [ ] **Step 4:** Refactor `TeamsService.updateMemberRole` to call `setTeamRole`; behaviour unchanged.
- [ ] **Step 5:** Run `npx jest --ci` → all pass.
- [ ] **Step 6:** Commit `feat(teams): shared team-admin service with grant claiming`.

### Task 3: Claim on profile read + `isPlatformAdmin` in `/auth/me`

**Files:**
- Modify: `apps/api/src/auth/auth.service.ts` (`getProfile`), `apps/api/src/auth/auth.module.ts` (import `TeamsModule` or provide `TeamAdminService`), `apps/api/src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `TeamAdminService.claimPendingGrants(userId)`.
- Produces: `getProfile` response gains `isPlatformAdmin: boolean`.

- [ ] **Step 1: Failing tests:** `getProfile calls claimPendingGrants before reading memberships` (call order) and `getProfile returns isPlatformAdmin`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: call `claimPendingGrants(uuid)` first (errors logged, never fail the request); add `isPlatformAdmin: true` to the `select`.
- [ ] **Step 4:** Run `npx jest --ci` → pass. Watch for a circular module import (Auth ↔ Teams); if it appears, move `TeamAdminService` into its own `TeamAdminModule` imported by both.
- [ ] **Step 5:** Commit `feat(auth): claim pending admin grants on /auth/me`.

### Task 4: Platform API

**Files:**
- Create: `apps/api/src/platform/platform.module.ts`, `platform.controller.ts`, `platform.service.ts`, `platform-admin.guard.ts`, `dto/create-team.dto.ts`, `dto/add-admin.dto.ts`, `admin-notice-email.ts`, `platform.service.spec.ts`, `platform-admin.guard.spec.ts`
- Modify: `apps/api/src/app.module.ts` (import `PlatformModule`)

**Interfaces:**
- Consumes: `TeamAdminService` (Task 2), `MailService.send({ to, subject, text, html? })`, `CombinedAuthGuard`.
- Produces (HTTP, all behind `CombinedAuthGuard, PlatformAdminGuard`):
  - `GET /platform/teams` → `Array<{ id, name, code, createdAt, memberCount, admins: Array<{ userId, name, email }>, grants: Array<{ id, email, createdAt, status: 'pending' | 'pending_verification' | 'blocked', reason?: string }> }>`
  - `POST /platform/teams` `{ name: string (1–100, trimmed), code?: string (4–20, [A-Za-z0-9-]), adminEmail: string (IsEmail) }` → created team (same shape). Code generated as 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` when missing. Team + grant/admin created atomically.
  - `POST /platform/teams/:id/admins` `{ email }` → `{ status: 'admin' | 'pending' | 'pending_verification' }`
  - `DELETE /platform/teams/:id/admins/:userId` → 204
  - `DELETE /platform/grants/:id` → 204
- `PlatformAdminGuard.canActivate` reads `users.isPlatformAdmin` by `req.user.id`; false → `ForbiddenException('Solo el superadministrador')`.

- [ ] **Step 1: Failing tests** (`platform.service.spec.ts`, mocked prisma/mail/teamAdmin):
  - `addAdmin promotes a verified existing user immediately and sends the notice` → `setTeamRole(team,'u1','ADMIN')`, mail text contains group name and FRONTEND_URL, contains no `token`.
  - `addAdmin creates an open grant for an unknown email (lower-cased)` → returns `pending`; calling twice does not create a second open grant.
  - `addAdmin for an unverified account returns pending_verification`.
  - `addAdmin returns 409 when adminBlockReason is not null` (other team / banned / superadmin).
  - `removeAdmin refuses the last ADMIN (409)`; `removeAdmin demotes via setTeamRole(...,'MEMBER')`.
  - `revokeGrant refuses the last open grant of a team without admins (409)`.
  - `createTeam rejects a duplicate code with 409` (Prisma `P2002`).
  - Guard spec: `rejects a team ADMIN without isPlatformAdmin (403)`, `allows isPlatformAdmin`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement module, guard, DTOs (class-validator), service, controller, `buildAdminNoticeEmail(teamName: string, appUrl: string): { subject, text, html }`. A mail failure is logged and does not undo the assignment.
- [ ] **Step 4:** Run `npx jest --ci && npx tsc --noEmit -p tsconfig.json` → pass.
- [ ] **Step 5:** Commit `feat(platform): superadmin API for groups and their admins`.

### Task 5: Superadmin CLI

**Files:**
- Create: `prisma/create-platform-admin.ts`, `prisma/password-prompt.ts`
- Modify: `deploy/cicd/README.md` (section "Superadministrador")

**Interfaces:**
- Consumes: `createSeedClient()` from `prisma/seed-client.ts`.
- Produces: `npx tsx prisma/create-platform-admin.ts <email>`; `readHidden(prompt: string): Promise<string>` (raw-mode stdin, prints nothing per char, Ctrl+C aborts).

- [ ] **Step 1:** Implement: validate email arg; prompt twice; enforce ≥ 8 chars and ≤ 72 bytes; upsert user by lower-cased email with `name: 'Superadministrador'`, `provider: 'password'`, `emailVerified: true`, `isPlatformAdmin: true`, bcrypt(10); refuse if that user has any `team_members` row (message: remove it from its group first). Print only "Superadministrador listo: <email>".
- [ ] **Step 2:** Verify locally that it type-checks: `npx tsc --noEmit prisma/create-platform-admin.ts --esModuleInterop --skipLibCheck` (or via the project tsconfig) → no errors. Confirm `prisma/` is copied into the api image (Dockerfile `COPY --from=build /app/prisma ./prisma`) and `tsx` is a production dependency.
- [ ] **Step 3:** Document the command in `deploy/cicd/README.md`: `docker exec -it vm-app-http-api-1 npx tsx prisma/create-platform-admin.ts admin@kronos.local`.
- [ ] **Step 4:** Commit `feat(platform): CLI to create or reset the superadmin`.

### Task 6: Frontend `/platform`

**Files (KronosFrontend):**
- Create: `src/api/platform.api.ts`, `src/hooks/usePlatform.ts`, `src/pages/platform/PlatformPage.tsx`
- Modify: `src/App.tsx` (route `/platform` inside the private routes), `src/components/auth/PrivateRoute.tsx`, `src/pages/onboarding/JoinTeamPage.tsx`, `src/pages/onboarding/PendingApprovalPage.tsx`

**Interfaces:**
- Consumes: Task 4 HTTP API; `/auth/me` field `isPlatformAdmin`.
- Produces: hooks `usePlatformTeams()`, `useCreateTeam()`, `useAddTeamAdmin()`, `useRemoveTeamAdmin()`, `useRevokeGrant()` (TanStack Query, invalidate `['platform','teams']` on success).

- [ ] **Step 1:** `PrivateRoute`: after email verification, if `isPlatformAdmin` → render only for `/platform`, redirect every other private path (including onboarding paths) to `/platform`; non-superadmins hitting `/platform` → `/dashboard`.
- [ ] **Step 2:** `PlatformPage` (OnboardingLayout-like header, Kronos components): groups table (name, code with copy button, members, admins with remove action, invitations with status badge `pendiente` / `pendiente de verificación` / `bloqueada: <reason>` and revoke action); "Nuevo grupo" form (name, optional code, first admin email); per-group "Añadir admin" (email). Confirm dialogs for remove/revoke; API error messages inline (toast). Logout button.
- [ ] **Step 3:** Onboarding pages re-read `/auth/me` every 10 s (reuse the `VerifyEmailPage` polling pattern); when `teamStatus === 'APPROVED'` navigate to `/dashboard`.
- [ ] **Step 4:** `npx tsc --noEmit -p tsconfig.app.json && npx eslint src/pages/platform src/api/platform.api.ts src/hooks/usePlatform.ts` → no errors.
- [ ] **Step 5:** Commit `feat(platform): superadmin dashboard`.

### Task 7: Deploy and verify

- [ ] **Step 1:** Push backend (`feat/laas-platform` → `develop`) first, wait for the deploy (migration applied by the api on start); then frontend (`→ master`).
- [ ] **Step 2:** The owner runs the CLI on app (password typed by them):
  `ssh ubuntu@10.20.12.190` then `docker exec -it vm-app-http-api-1 npx tsx prisma/create-platform-admin.ts admin@kronos.local`.
- [ ] **Step 3:** Verify with the owner: superadmin login lands on `/platform`, lists GIOT; a team ADMIN gets 403 on `GET /platform/teams` (curl with their session is the owner's step; Claude checks via API logs); add-admin flow on a test email shows `pendiente`.
