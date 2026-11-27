# Platform superadmin (gestión de grupos y sus administradores)

## Intent
Today research groups (`platform.teams`) and their admins can only be created with SQL
(`deploy/sql/bootstrap-team.sql`). The owner wants a **platform superadmin**: one person above
all groups who, from the same login but a **different dashboard**, creates research groups and
names their administrators. Group admins keep accepting members exactly as today.

## Goals
- A superadmin flag at platform level, independent of teams and projects.
- Superadmin dashboard (`/platform`): list groups, create a group (name + join code), name and
  remove group admins by email.
- Naming an admin by email works whether or not that person already has an account.
- The notification email grants nothing by itself.

## Non-goals
- The superadmin does **not** see or edit any group's projects, devices, measurements, members'
  data or activity ("solo gestión"). No impersonation, no cross-team access.
- No UI or API to make someone superadmin. No multi-team membership.
- No group deletion/renaming in this iteration (builder may add rename if trivial; not required).

## Anti-goals (failure even if it "works")
- Any link, token or email content that, in the wrong hands, grants a role.
- A web path (API or UI) that can produce a superadmin.
- Breaking the current per-project permission system or the existing onboarding flow
  (verify email → join team → pending → approved).
- A group left with no admin.

## Constraints
- Backend: NestJS monorepo, Prisma 7 (`schema "platform"`), migrations must replay on an empty
  DB (`ADD … IF NOT EXISTS` style is not needed for new objects, but keep them idempotent-safe).
- Auth: two kinds of sessions reach the API through `CombinedAuthGuard` — own JWT (password
  accounts, `provider = 'password'`) and Supabase (Google, `provider = 'google'`). `req.user.id`
  is the DB `users.uuid`. Both flows call `GET /auth/me` right after login (frontend
  `PrivateRoute`), which returns `AuthService.getProfile`.
- Users identified by **email** across Supabase and DB (Supabase ids ≠ `users.uuid`).
- One team per user in practice (`teamMember.findFirst`).
- Email via `MailService.send` (Brevo). Without `BREVO_API_KEY` it only logs.
- Permissions cache in Redis (`permissions:<userId>:*`, TTL 300 s): invalidate with
  `PermissionsService.invalidateUserCache` whenever team role changes.
- Team ADMIN already maps to the "Administrador de Equipo" global role in
  `PermissionsService.getGlobalRoleIds`; nothing to change there.

## Approaches (picked: 1)
1. **Flag on `User` + table of pending admin grants** *(chosen)*. `users.isPlatformAdmin`
   (default false, only set by SQL). New table of "email → team admin" grants, claimed when a
   user with that verified email is seen by the API. New superadmin-only API + `/platform` page.
   Simple, isolated from per-project permissions, easy to audit.
2. Reuse the existing "Super Administrador" role as a global role: requires a new global role
   assignment (roles are tied to projects today) and changes to permission resolution used by
   the whole app. More risk for little gain. Rejected.
3. Store superadmin in Supabase `app_metadata`: password accounts don't go through Supabase;
   splits the source of truth. Rejected.

## Design (decided with the owner)

### Data
- `User.isPlatformAdmin Boolean @default(false)`.
- `TeamAdminGrant` (`platform.team_admin_grants`): `id`, `email` (lower-cased), `teamId` → Team,
  `invitedById` → User, `createdAt`, `claimedAt?`, `claimedById?` → User, `revokedAt?`.
  At most one open grant (not claimed, not revoked) per (email, team).
- **The superadmin is a dedicated account (decided by the owner)**, e.g. `admin@kronos.local`
  (owner may pick another address; recommended a non-existent domain so no email can ever reach
  a stranger), with a password, not a member of any group.
- It is created **only on the server** with a CLI script run inside the api container, e.g.
  `docker exec -it vm-app-http-api-1 npx tsx prisma/create-platform-admin.ts <email>`:
  prompts for the password twice **without echo** (never passed as an argument or env var),
  validates it with the same password rules as registration, stores the bcrypt hash like
  `/auth/register`, sets `provider = 'password'`, `emailVerified = true`,
  `isPlatformAdmin = true`. Re-running it for an existing email resets the password and keeps
  the flag (password recovery path). This is the only way to create a superadmin; the app never
  sends email to this account.

### Claiming a grant (the security core)
- A grant is applied **only** for a user whose `emailVerified = true` and whose
  `users.email` matches the grant email (case-insensitive).
- Where: one idempotent `claimPendingAdminGrants(userId)` called at the start of
  `AuthService.getProfile` (covers both login flows and email verification, since the frontend
  re-reads `/auth/me` after each). Cheap when there is nothing to claim.
- Effect: upsert `TeamMember(userId, teamId)` with `role = ADMIN, status = APPROVED`; mark the
  grant claimed; `invalidateUserCache(userId)`. If the user already is an APPROVED member of a
  **different** team, do not apply; leave the grant open (the dashboard shows it as blocked).
- The email is only a notice: "Te nombraron administrador/a de <grupo> en KRONOS. Entra en
  <APP_URL> y regístrate o inicia sesión con este correo." No token, no special link.

### Superadmin API (new controller, e.g. `/platform/*`)
All routes require an authenticated user with `isPlatformAdmin = true` (new guard; 403 otherwise).
- `GET /platform/teams` → groups with: name, code, createdAt, approved member count, admins
  (name/email), open grants (email, createdAt, blocked flag).
- `POST /platform/teams` `{ name, code? }` → create; code optional (generate a readable random
  one if missing), unique (409 on conflict), trimmed, sensible length/charset validation.
- `POST /platform/teams/:id/admins` `{ email }`:
  - If an account with that email exists, is verified and has no APPROVED membership in another
    team → make ADMIN now (same effect as claiming) and still send the notice.
  - If it exists and is an APPROVED member of another team → 409 with a clear message.
  - Otherwise create an open grant (idempotent) and send the notice.
- `DELETE /platform/teams/:id/admins/:userId` → demote to MEMBER (keeps membership).
  Refuse (409) if it is the team's last ADMIN. Invalidate cache.
- `DELETE /platform/grants/:id` → revoke an open grant.
- Superadmin does not get any new access to existing team/project routes.

### Profile
`GET /auth/me` also returns `isPlatformAdmin`.

### Frontend
- After login, `PrivateRoute`: if `isPlatformAdmin` → allow `/platform` and route `/`,
  `/dashboard` to `/platform`; skip team onboarding (join-team/pending) for them. Email
  verification still applies. Non-superadmins never see `/platform` (redirect to `/dashboard`).
- `/platform` page in the existing visual style (Kronos components): table of groups (name,
  code with copy, members, admins, pending invitations), "Nuevo grupo" form (name, optional
  code), per group "Añadir admin" (email) and remove-admin / revoke-invitation actions with
  confirmation, error messages from the API (409 cases) shown inline. Logout available.

## Rules settled after the builder check (Claude's calls unless noted)
- **Project roles follow the team role.** Making someone ADMIN (claim or direct) and demoting
  them reuse the existing `propagateRoleToProjects` logic of `TeamsService.updateMemberRole`
  (ADMIN → "Administrador de Equipo", demoted → "Operario" on the team's projects), extracted
  into a shared method, plus `invalidateUserCache`.
- **Creating a group asks for its first admin's email** in the same request (atomic: team +
  grant/admin). A group may have no *claimed* admin only while that grant is open; you cannot
  revoke the last open grant of a group with no admin, nor demote the last ADMIN (409).
- **Claim with other memberships:** APPROVED in another team → not applied, grant stays open
  and is shown as blocked ("ya pertenece a <grupo>"). PENDING/REJECTED rows in other teams are
  deleted by the claim (the person is becoming admin here). `users.banned = true` → not applied,
  shown as blocked ("cuenta suspendida"); the superadmin must resolve it manually.
- **Unverified password account:** `POST …/admins` creates an open grant (not 409); the
  dashboard shows it as "pendiente de verificación de correo". It is claimed automatically on
  the first `/auth/me` after verification.
- **Claim timing:** the frontend re-reads `/auth/me` on the onboarding pages (join-team,
  pending-approval) so a claim takes effect without a manual reload.

## Decisions marked as Claude's call (owner may correct)
- The superadmin belongs to no group (owner: dedicated account). The API refuses to name a
  platform admin as group admin (409), so the roles never mix; backend team/project routes need
  no extra guard because the superadmin has no membership. `/auth/me` returns
  `isPlatformAdmin: true` and the frontend sends them to `/platform`, skipping team onboarding.
- Removing an admin demotes to MEMBER instead of removing from the group.
- Grants do not expire; they can be revoked.

## Left to the builder
- Exact component layout, code generator format, validation limits, audit logging (optional),
  test strategy (unit tests for claim logic, guard and 409 rules are expected).
