# RadFlow — Agent Onboarding

Context for an AI agent (Claude Code / Cowork) continuing work on RadFlow. Read this first,
together with the memory files (`MEMORY.md`, and especially `TODO.md`),
`docs/PRODUCT_OVERVIEW.md`, and `docs/audit/FULL_AUDIT_2026-06-25.md`.

You are a Senior Full-Stack Engineer on RadFlow — a multi-tenant SaaS for radiology queue
management.

## Stack & structure
- Next.js 15 (App Router) + Supabase (Postgres + RLS + Auth) + TypeScript + Tailwind.
- Some components are still legacy `.jsx` from an earlier prototype.
- `app/` → routes + API route handlers (role-gated; see `middleware.ts` and `lib/supabase/middleware.ts`)
- `components/` → React components
- `lib/` → business logic + Supabase clients (`lib/supabase/{client,server,admin}.ts`)
- `supabase/migrations/` → schema + RLS (sequential numbered `.sql` files)
- `supabase/types.ts` → hand-maintained `Database` types (update when schema changes)

## Rules / conventions
- Always TypeScript. Prefer Server Components + Server Actions.
- Follow existing patterns in `lib/supabase` and `app/api` before inventing new ones.
- Maintain multi-tenant isolation (`clinic_id` / RLS) — critical and security-sensitive.
- Add proper error handling, loading states, optimistic updates.
- Realtime uses the shared hook `lib/useRealtimeRefetch.ts` (the "TD-3" pattern) — reuse it.
- Wrap client-side Supabase reload functions in `try/catch` so transient `Failed to fetch`
  (token refresh / network blips) don't crash to the Next error overlay.

## Auth & roles model (important)
- Roles enum: `admin`, `radiologist`, `registrar`, `referrer`, `ceo`.
- Clinic staff (admin/radiologist/registrar) have `profiles.clinic_id` set.
- Referrers and CEOs are GLOBAL accounts (`profiles.clinic_id = NULL`); their membership to
  clinics lives in access tables: `referral_access` (referrers) and `ceo_access` (CEOs), each a
  row per (user, clinic) with status. A user can hold a role AND extra grants (e.g. a radiologist
  who is also a CEO via `ceo_access` — role is not changed).
- SECURITY DEFINER helpers: `auth_clinic_id()`, `auth_is_admin()`, `auth_referrer_clinics()`,
  `auth_can_refer(c)`, `auth_ceo_clinics()`, `auth_is_ceo_of(c)`.
- Two client types: RLS-bound (`lib/supabase/server.ts` / `client.ts`) vs service-role admin
  client (`lib/supabase/admin.ts`) which BYPASSES RLS — every route using it MUST check the
  caller's auth/role itself first.
- RLS read policies for global users are added as separate PERMISSIVE policies that OR with the
  base `clinic_id` policy. `profiles_referrer_linked_read` / `profiles_ceo_linked_read` carry a
  role guard (`role='referrer'` / `role='ceo'`) as a deliberate isolation boundary — don't remove it.

## Account creation & password flow
- Admin creates radiologist/referrer/CEO accounts (no password set at creation).
- User sets their own password at `/set-password?token=…` (one-time `profiles.invite_token`,
  consumed on use). `/set-password` resolves the token via GET and shows the account's login.
- Admin can reset/set passwords via `/api/staff/password` (authorizes radiologists by `clinic_id`,
  CEOs via active `ceo_access`, and REFERRERS via active `referral_access`). The old `clinic_id`
  403 bug for global referrers is FIXED: the route fetches the target with the service-role client
  and authorizes by the access grant, not the profile's `clinic_id`.

## Migrations
- Applied to prod MANUALLY via the Supabase SQL editor (no automated migration runner).
- Prod is currently at **0044** (highest local migration; `0044_ceo_list_rpc.sql` applied
  2026-06-30). ALWAYS check the highest existing migration number before adding a new one and
  number it sequentially (a duplicate/lower number is a bug).
- Keep migrations idempotent (`do $$ … exception when duplicate_object …$$`, `create … if not
  exists`, `drop policy if exists` before `create policy`).

## Recently built/changed (verify with git before assuming current)
- Required-field labels render in red across all forms/modals (`.req` span + `.fld-lab:has(.req)` CSS).
- `/set-password` shows the account login (GET token resolver on `/api/account/set-password`).
- Full CEO ("Керівник") management: migration `0040_ceo_global.sql` (`ceo_access` table,
  `auth_ceo_clinics`/`auth_is_ceo_of`, RLS), APIs `/api/ceo/{grant,revoke,delete}`, admin UI
  `components/CeoManager.tsx` + `app/ceo-admin/page.tsx`, sidebar link, and a multi-clinic
  `CeoDashboard` (clinic switcher + "Всі центри" aggregate) at `app/ceo/page.tsx`. Cross-role
  users (e.g. radiologist with a CEO grant) get a "Дашборд CEO" link via
  `components/CeoDashboardLink.tsx`. Security-reviewed and live-tested in the browser.
- `CeoDashboard.reload` hardened with `try/catch/finally`.
- Account security (migration `0032`): one-time `invite_token` for set-password (CRIT-1) and
  `email_for_login` EXECUTE revoked from anon (CRIT-2). Both old blockers are CLOSED.
- City directory (migrations `0042`/`0043`): КАТОТТГ picker `components/CitySelect.tsx` + RPC
  `search_cities`; referrer carries a city.
- **RPC `ceo_list_for_clinic`** (migration `0044`): security-definer, admin-of-clinic gated;
  `CeoManager.reload` now calls it. Returns the FULL CEO membership (incl. cross-role / cross-clinic
  members hidden by `profiles_ceo_linked_read`'s `role='ceo'` guard) WITHOUT exposing `invite_token`
  of non-`ceo`-role accounts. Type added to `supabase/types.ts`. Security-reviewed (no blockers).
- **UX-audit P0/P1/P2 implemented** (accessibility, WCAG 2.1 AA target; see `PRODUCT_OVERVIEW.md`
  §4.11): global `:focus-visible`; removed `zoom` + 11px font floor + AA contrast tokens; density
  control (Компактно/Звичайно/Просторо — `components/DensityToggle.tsx` export `DensityControl`,
  `html[data-density]`, `localStorage['rf-density']`, lives in the LEFT sidebar); non-colour status
  glyphs + calendar shapes (1.4.1); `prefers-reduced-motion`; modal focus-trap/Esc/restore via
  `lib/useModalA11y.ts` on all 8 modals + stronger `.btn:disabled`; registrar hotkeys
  (`e.code`: n / `/` / r / 1–9 / `` ` ``); board skeleton; contextual help `components/HelpTip.tsx`;
  inline block reasons. Live-tested in browser. P1.2 (undo) intentionally skipped.

## Open work — see `TODO.md` for the live list
- Commit pending changes; run `npm run typecheck` (== `tsc --noEmit`) and `npm run lint`. Note:
  bare `tsc` is NOT on PATH — use `npx` or the npm script. `next lint` is deprecated and ESLint
  isn't configured yet (separate task).
- Referrer password recovery via email — deferred until a real domain + SMTP exist.
- ESLint not configured yet (`next lint` deprecated) — separate task.

  (DONE, do not reopen: admin-reset for referrers — fixed; RPC `ceo_list_for_clinic` — shipped in 0044.)

## Environment & workflow notes
- The isolated Linux sandbox/bash may be unavailable (disk space) — prefer file tools.
- For browser testing, use the Claude-in-Chrome connector against the local dev server
  (`npm run dev`, `localhost:3000`). Do NOT enter passwords to authenticate — ask the user to log
  in as the needed role, then inspect.
- Use a subagent for RLS/security review on anything touching multi-tenant policies.
- Track work with the task list; keep `MEMORY.md` / `TODO.md` updated as facts and items change.
