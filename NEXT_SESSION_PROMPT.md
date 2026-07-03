# RadFlow — continue development (paste into a new session)

You are a Senior Full-Stack Engineer continuing work on **RadFlow** — a multi-tenant SaaS for
radiology (MRI/CT) queue management. Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS +
Auth) + TypeScript + Tailwind, deployed on Vercel. Repo: github.com/tiosynergy/RadFlow. Working
branch `dev`; merging `dev → main` + `git push origin main` triggers Vercel auto-deploy to PROD.
Communicate with the user (Игорь) in **Russian**.

## Before doing anything
1. Read the auto-memory: `MEMORY.md` and the linked files — especially `radflow-state`,
   `radflow-open-items`, `radflow-workflow`, `radflow-buffer-time`, `radflow-patient-priority`,
   `radflow-ux-audit`, `cities-directory`.
2. Read `docs/PRODUCT_OVERVIEW.md` (source of truth for the product as built) and
   `docs/audit/FULL_AUDIT_2026-06-25.md`.
3. Verify current facts against the code + `git status`/`git log` before assuming state — memory
   reflects what was true when written.

## Current state (as of 2026-07-03)
- Highest migration in **repo**: **0046**. PROD (applied manually via Supabase SQL editor) was last
  confirmed at **0043**. **PENDING manual apply to PROD, in order: 0044 (ceo_list_rpc), 0045 (buffer
  time), 0046 (patient priority).** Confirm with Игорь which are already applied.
- Code for 0045/0046 is on `dev`, **commit + push may still be pending** — check `git status`.
- `npm run typecheck` (== `tsc --noEmit`) was green locally. `npm run build` is run locally by Игорь
  (does not complete in the Cowork Linux sandbox — memory limits).

## What was built most recently
- **Buffer time (migration 0045)**: per-record `queue_entries.buffer_time_min` (default 5, values
  0/5/10/15). Effective room occupancy = `duration_min + buffer_time_min` everywhere occupancy is
  computed (overlap trigger `check_no_overlap`, slot grids, `hasSlotClash`, `room_busy_slots` RPC,
  CEO load, radiologist overtime timer). NOT counted in incident/ТО window checks (decision). Helper:
  `lib/studies.ts` (`BUFFER_DEFAULT`, `BUFFER_OPTIONS`, `normBuffer`).
- **Patient priority (migration 0046)**: enum `patient_priority` = `cito` | `urgent` | `planned`
  (machine-readable codes for future n8n/AI). Column `queue_entries.priority_level` (NOT NULL DEFAULT
  'planned'). Mandatory on new booking for everyone who books. Legacy `cito` boolean is now a mirror
  of `priority_level='cito'` via trigger `sync_cito_from_priority`. Queue order everywhere:
  cito → urgent → planned. Change-after-create allowed only for admin (inline row + PatientEditModal)
  and owner-referrer (portal), enforced in app action `setQueuePriority` AND DB trigger
  `guard_priority_change` (service-role/no-JWT allowed for automation). Helper: `lib/priority.ts`.

## Immediate next steps (confirm with Игорь first)
1. Apply pending migrations to PROD in order (idempotent): 0044 → 0045 → 0046.
2. Deploy code + migrations **together** (behavior-changing: old prod frontend won't know the new
   mandatory priority field / buffer semantics). Get explicit go-ahead before `dev → main` push.
3. After apply: browser-test in the roles that changed (admin/registrar booking with priority +
   buffer, referrer portal, radiologist board, call-list). Ask Игорь to `npm run dev`
   (http://localhost:3000 or :3001 — note **http**) and log in per role; inspect via Claude-in-Chrome
   (he does NOT share passwords).

## Open backlog / future direction
- **n8n + AI-agent automation (Stage 2)** is the strategic goal; `priority_level` and
  `buffer_time_min` were designed as integration-friendly inputs for it (see the Perplexity research:
  smart waitlist rotation, predictive no-show/cancellation, schedule optimization, KPI dashboard).
  When starting this, external/direct DB writers must send exact enum literals or route through
  normalization; legacy flows writing bare `cito` are now no-ops (write `priority_level`).
- Referrer password recovery via email — DEFERRED until real domain + SMTP.
- Optional hardening: normalize priority for external writers; revisit whether existing dense
  back-to-back bookings need re-spacing after the buffer backfill (documented caveat).

## Working conventions / rules
- Always TypeScript. Prefer Server Components + Server Actions (`app/queue/actions.ts` is the
  reference pattern). Follow existing patterns in `lib/supabase` and `app/api` before inventing new.
- Maintain multi-tenant isolation (clinic_id / RLS) — security-critical. Two client types: RLS-bound
  (`lib/supabase/{client,server}.ts`) vs service-role `admin.ts` (bypasses RLS — every route using it
  must check caller auth/role first). Use a **subagent for RLS/security review** on anything touching
  multi-tenant policies, triggers, or RPC grants.
- Migrations: applied to PROD manually (no runner). Always check the highest existing number and
  number sequentially. Keep idempotent (`do $$ … exception when duplicate_object …$$`,
  `create … if not exists`, `drop … if exists` before create). Update `supabase/types.ts` when schema
  changes.
- Realtime: shared hook `lib/useRealtimeRefetch.ts`. Wrap client-side reload functions in try/catch
  for transient "Failed to fetch".
- Add proper error handling, loading states, optimistic updates. Add red-asterisk required-field
  labels (`.req` span) for new mandatory inputs.
- Track work with the task list; keep `MEMORY.md` and the linked memory files updated as facts change.

## Environment gotchas
- **The Cowork Linux sandbox mount can get out of sync / truncate individual files mid-write** (hit on
  `lib/studies.ts`), making in-sandbox `tsc` intermittently unreliable. The **file tools (Read/Edit)
  read the real on-disk file** — trust them as ground truth; treat Игорь's local `npm run typecheck`
  as authoritative. Prefer file tools over shell for file ops.
- Git and migrations are run locally by Игорь; get explicit go-ahead before any prod deploy. Stale
  `.git/index.lock` — have him remove it from PowerShell (sandbox can't).

Start by reading the memory + `docs/PRODUCT_OVERVIEW.md`, run `git status`/`git log` and check which
migrations are live, then tell Игорь the current open items and what you'd tackle first.
