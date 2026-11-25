# Email verification (Brevo) + unified UI — Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** password users verify their email through a backend-issued link sent with Brevo; onboarding/admin screens share the app's theme.
**Spec:** `docs/superpowers/specs/2026-11-25-email-verification-and-ui-design.md` (binding: routes, messages, env vars, TTLs).

## Global Constraints
- Branch `feat/laas-platform` in both repos; never push (controller pushes).
- No `Co-Authored-By` or AI attribution lines in commits.
- Spanish user-facing messages exactly as in the spec.
- Node PATH: `export PATH="/c/Users/hhancco/AppData/Roaming/fnm/node-versions/v24.22.3/installation:$PATH"`.
- Backend: `npm run build`, `npx tsc --noEmit -p tsconfig.json` (0 errors), `npx jest` green. Frontend: `npx tsc --noEmit -p tsconfig.app.json && npx vite build`.

### Task 1 (backend): verification tokens, MailService, endpoints
Files: `prisma/schema.prisma` + migration `20261125130000_email_verification_tokens` (unqualified table names like the latest migrations; `CREATE TABLE IF NOT EXISTS` not needed), `apps/api/src/mail/{mail.module.ts,mail.service.ts,verification-email.ts}` + specs, `apps/api/src/auth/{email-verification.service.ts,auth.controller.ts,auth.service.ts,auth.module.ts}` + specs, `.env.example`, `deploy/single-vm/.env.example`, `deploy/vm-app/.env.example`.
- [ ] Specs first: token hashing (stored hash ≠ raw, SHA-256), TTL from env (default 24 h), verify success/expired/used/unknown (400 message), resend: already verified, <60 s → 429 message, invalidates previous + sends; register sends mail and still returns the JWT when sending throws; MailService posts to Brevo with `api-key` header and JSON body (fetch mocked), logs the link and does not call Brevo when `BREVO_API_KEY` is empty.
- [ ] Implement; throttle `verify-email` (10/min) and `resend-verification` (3/min) with `@Throttle`.
- [ ] Verify (build, tsc, jest); commit `feat: email verification with Brevo`.

### Task 2 (frontend): confirm/verify flow
Files: `src/pages/onboarding/ConfirmEmailPage.tsx` (new, public route `/confirm-email`), `src/pages/onboarding/VerifyEmailPage.tsx` (no Supabase; resend via `/auth/resend-verification`), `src/App.tsx` (route outside PrivateRoute), `src/api/client.ts` PUBLIC_ROUTES += `/auth/verify-email`.
- [ ] Implement per spec; 429 shown as a warning toast/message.
- [ ] Verify (tsc + vite build); commit `feat: confirm email page and backend resend`.

### Task 3 (frontend): unified styling + dead code removal
Files: `src/components/onboarding/OnboardingLayout.tsx` (new, mirrors LoginPage frame), the 6 onboarding pages (VerifyEmail, ConfirmEmail, JoinTeam, PendingApproval, Rejected, Banned), `src/pages/admin/TeamRequestsPage.tsx`, `src/components/DeviceFormModal.tsx`; delete unused files listed in the spec after confirming no importers (grep).
- [ ] Restyle with theme tokens + `Kronos*` components; no behavior changes.
- [ ] Verify (tsc + vite build; grep shows no `bg-slate-` left in src except intentional); commit `refactor: unify onboarding and admin screens with the app theme`.
