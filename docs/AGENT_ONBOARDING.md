# RadFlow — Agent Onboarding

Context for an AI agent (Claude Code / Cowork) continuing work on RadFlow. This file holds the
STABLE rules. For the CURRENT state of the work read, in this order: `NEXT_SESSION_PROMPT.md`
(repo root — the new-session start message), the header + latest session block of
`docs/HANDOVER.md`, and `claude/radflow-handoff.md` in the claude.ai project "RadFlow"
(`Projects` tool). Background: `docs/PRODUCT_OVERVIEW.md`, `docs/README.md` (documentation map),
`docs/audit/FULL_AUDIT_2026-06-25.md`, `docs/audit/DATA_ARCHITECTURE_AUDIT_2026-07-12.md`,
`docs/audit/BACKLOG_RESIDUAL.md`.

> ⚠️ `MEMORY.md` and `TODO.md` **no longer exist** in this repository, and the
> `project_memory_read` tool is gone — anything that tells you to read them is out of date.
> The durable cross-session store is the claude.ai project.

You are a Senior Full-Stack Engineer on RadFlow — a multi-tenant SaaS for radiology queue
management.

## Stack & structure
- Next.js 15 (App Router) + Supabase (Postgres + RLS + Auth) + TypeScript + Tailwind.
- All components are TypeScript `.tsx` (the earlier prototype `.jsx` were migrated; no `lib/*.js`).
- ESLint is configured: flat config `eslint.config.mjs` (ESLint 9 / Next 15.5, lenient baseline); `npm run lint` == `eslint .`.
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
- Applied to prod MANUALLY via the Supabase SQL editor (no automated migration runner). A Vercel
  deploy does NOT run them — apply the SQL first, then merge `dev → main`.
- Do NOT trust any hardcoded migration number in docs — this very bullet once said "prod on
  0119" while prod was on 0124 (2026-07 tech audit, High-2). The `docs/HANDOVER.md` header is
  fresher than this file, and the FINAL source of truth is the prod DB itself: check the highest
  APPLIED migration (schema objects it creates) before numbering a new one. Number sequentially;
  a duplicate/lower number is a bug.
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
- **Since then (through 2026-07-08, prod at 0052):**
  - `0045` buffer time between bookings; `0046` patient priority (`patient_priority` enum); `0047`
    waitlist (`waitlist_entries`); `0048` referrer status/call guards; `0049` `reschedule_origin`;
    `0050` `room_busy_slots` gains optional `p_exclude`; `0051` waitlist optional `room_id` binding
    (`guard_waitlist_room`); `0052` `queue_entries.studies_changed_by` (edit attribution).
  - **Room breaks** (no migration — `rooms.schedule` is free JSONB): multiple breaks per room
    (whole-week + per-day) in the Setup Wizard (`rooms.schedule.breaks[]`); ENFORCED in all slot
    grids via `lib/schedule.ts` `roomBreaksFor`/`overlapsBreak`. Tech-debt refactor:
    `inProgressBlockReason` extracted to `lib/queueStatus.ts` → `computeCallBlock()`.
  - **Emergency stop** (no migration — incident `reason='emergency'`): sidebar toggle on QueueBoard
    + `EmergencyModal`; marks affected patients `call_status='to_recall'`, fires `N8N_WEBHOOK_URL`
    (`emergency_stop`); per-room instant toggle w/ confirm; stopped rooms red in the sidebar.
  - **Referrer portal UI:** shared `components/MiniCalendar.tsx` (used by QueueBoard + ReferrerBoard);
    ReferrerBoard calendar rail + one-line status filters; sidebar rooms filtered by
    `referral_access.room_ids` and clickable quick-filters; native date/time pickers dark
    (`color-scheme: dark`).
  - **Study-edit attribution (0052):** `editQueueEntryStudies` records the editor's role; boards
    label "змінено клінікою/направником", synced via realtime. Admin queue shows the referrer
    (`referrer:referrer_id(full_name)`); "⚠ Протипоказання" shown at the "Дослідження" label level.
  - Test data seeder `scripts/seed-test-data.mjs` updated (roles, breaks-aware, waitlist per room).
- **Release 2026-07-09 (prod at 0060, deployed to `main`):**
  - Data-architecture audit fixes: `0053` lightweight `audit_log` (queue_entries + incidents);
    `0054` `emergency_stop_rpc` (transactional emergency stop); `0055` transactional `event_outbox`
    (payload + HMAC + idempotency-key, for reliable n8n delivery); `0056` incidents integrity
    (CHECK + VALIDATE); CAS status transitions (`expectedFrom` optimistic concurrency, threaded from
    boards); `requireRole()` helper unifying service-role route guards; `classifyError` by SQLSTATE.
  - `0057` **referrer edit rights EXPANDED** — RLS `queue_write_referrer` allows write when
    `created_by = auth.uid()` OR `referrer_id = auth.uid()` (`FOR ALL`). So a referrer edits both
    entries they created AND entries where the admin named them as referrer. (This REVERSED an earlier
    guard idea — do not re-add a block.)
  - `0058` auto-clarify: `queue_entries.clarify_at` + RPC `sink_overdue_scheduled` / `_all` — overdue
    `scheduled` entries get flagged and sink down. Boards call `sink_overdue_scheduled` (per-clinic)
    fire-and-forget on every reload; headless backstop `/api/queue/sink-overdue` (CRON_SECRET).
  - `0059` **universal timezone**: `clinics.timezone` (IANA). Wall-as-UTC canon (0035) unchanged;
    TZ only supplies "current wall moment of the clinic zone". Client helpers in `lib/incidents.ts`:
    `wallNow(tz)`, `wallInstant`, `wallMinOfDay`, `wallMinOfInstant`, `setClinicTz`/`getClinicTz`
    (module-level default for single-clinic screens; multi-clinic screens pass `nowMs=wallNow(tz)`).
    `lib/queueStatus.ts` (`isLate`/`needsClarification`/`computeCallBlock`/`lateCallClash`) takes
    `nowMs`. Do NOT hardcode `Europe/Kiev`.
  - `0060` in_progress ACTUAL occupancy: `room_busy_slots`/`check_no_overlap` compute an in-progress
    study's window from `in_progress_at` (real start), not the planned slot; zone validated via
    `pg_timezone_names`.
  - Bug fixes: call blocked for entries not on the selected day (`computeCallBlock` `wrong_day`);
    reschedule of an `in_progress` study is now ALLOWED (study stops → `scheduled`, `in_progress_at`
    nulled, SAME entry moves, `reschedule_origin.from_status='in_progress'`).
  - QA polish: custom dark `app/not-found.tsx`; slot-grid loading-gate in all booking/reschedule
    modals; "оберіть область" placeholder; call-list stat skeleton.
  - **Deploy note:** Vercel is on the **Hobby plan** (crons daily-only). The every-minute cron was
    REMOVED from `vercel.json` (it blocked the deploy); `vercel.json` now only carries `$schema`.
    Re-add a cron only when upgrading to Pro.

## Open work — the live list is `NEXT_SESSION_PROMPT.md` («ЧТО ДЕЛАТЬ ДАЛЬШЕ»)
- Run `npm run typecheck` (== `tsc --noEmit`) and `npm run lint` (== `eslint .`). Note: bare `tsc`
  is NOT on PATH — use `npx` or the npm script.
- **Stage-2 (n8n + AI):** delivery infra now exists — `emergency_stop` webhook + transactional
  `event_outbox` (0055, HMAC + idempotency-key) + `audit_log` (0053). Next up — smart waitlist
  rotation, predictive no-show, schedule optimization, and queue-collision handling when an
  overrunning `in_progress` study overlaps the next slot (options discussed: cascade-shift the room
  tail / reschedule to next free slot / move to a parallel room / recall). Inputs already modeled:
  `waitlist_status`, `priority_level`, `buffer_time_min`, `desired_*`, `room_id`, `isLate`,
  `clarify_at`, `waitlistMatchesSlot()`, `reschedule_origin`, `studies_changed_by`, `clinics.timezone`.
- Referrer password recovery via email — deferred until a real domain + SMTP exist.
- **Security (deferred by the owner, с26 / 2026-08-06):** rotating `SUPABASE_SERVICE_ROLE_KEY`
  (exposed in a screenshot) is postponed until the product is ready. The full plan —
  zero-downtime replacement path and post-rotation checks — is written up in
  `docs/setup/SERVICE_ROLE_KEY_ROTATION_2026-08-06.md`. Do not treat it as P0 or re-open it;
  remind the owner once before going live with real clients.
- Coverage gaps from the last QA pass: multi-role live testing (Radiologist/CEO/real Referrer logins)
  and mobile/tablet responsiveness — need test accounts + real-device verification.

  (DONE, do not reopen: ESLint configured; admin-reset for referrers — fixed; RPC `ceo_list_for_clinic`
  — 0044; `computeCallBlock` extraction; `room_busy_slots` in reschedule/study modals; RadiologistBoard
  `studies_changed_by` attribution; ReferrerBoard room filter by `room_ids`; stray `eslint-disable`
  removed; reschedule-of-in_progress; universal timezone.)

## Environment & workflow notes
- The device shell is **Desktop Commander MCP** (`start_process` with `powershell.exe -NoProfile
  -Command …`, plus `read_file` / `edit_block` / `create_directory` / `move_file`).
  `mcp__remote-devices__device_bash` did not work at all as of session 9. File transfer:
  `device_stage_files` (device → cloud) and `device_commit_files` (cloud → device, Windows
  absolute paths).
- Deleting on the device is not permitted (`rm` → Operation not permitted) — `mv` into
  `_to_delete/` and let the owner delete it.
- Merge/push goes through the GitHub web UI in Claude-in-Chrome (the device network gets a 403
  proxy to GitHub, `gh` is not installed).
- The toolchain runs in the cloud sandbox: `git archive HEAD` from the device → `/tmp/radflow` →
  `npm install` → typecheck / lint / test. Windows `node_modules` will not work over the bridge.
- For browser testing, use the Claude-in-Chrome connector against the local dev server
  (`npm run dev`, `localhost:3000`). Do NOT enter passwords to authenticate — ask the user to log
  in as the needed role, then inspect.
- Use a subagent for RLS/security review on anything touching multi-tenant policies.
- Track work with the task list. At the end of a session update `docs/HANDOVER.md` (new session
  block), `NEXT_SESSION_PROMPT.md` (priorities) and `claude/radflow-handoff.md` in the claude.ai
  project.
