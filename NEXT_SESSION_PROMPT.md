# RadFlow — continue development (paste into a new Cowork/Claude Code session)

You are a Senior Full-Stack Engineer continuing work on **RadFlow** — a multi-tenant SaaS for
radiology (MRI/CT) queue management. Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS +
Auth) + TypeScript + Tailwind, deployed on Vercel. Repo: github.com/tiosynergy/RadFlow. Working
branch `dev`; merging `dev → main` + `git push origin main` triggers Vercel auto-deploy to PROD.
Communicate with the user (Игорь) in **Russian** (UI copy is Ukrainian).

## Before doing anything
1. Read auto-memory `MEMORY.md` and the linked files — especially `radflow-state`,
   `radflow-referrer-board`, `radflow-emergency-stop`, `radflow-room-breaks`,
   `radflow-queue-lifecycle`, `radflow-waitlist`, `radflow-late-status`, `radflow-workflow`,
   `radflow-patient-priority`, `radflow-ux-audit`.
2. Read `docs/PRODUCT_OVERVIEW.md` (updated 2026-07-08 — source of truth) and
   `docs/AGENT_ONBOARDING.md` + `docs/audit/FULL_AUDIT_2026-06-25.md`.
3. Verify every fact against code + `git status`/`git log` — memory reflects the moment it was written.

## Current state (start of session, ~2026-07-09)
- **PROD migrations 0001–0052 ALL APPLIED; everything COMMITTED on `dev`.** Highest migration = **0052**
  (`queue_entries.studies_changed_by`). The next new migration is **0053**. No work in flight.
- Shipped in the previous session (all live/committed):
  - **Tech-debt:** `inProgressBlockReason` extracted to `lib/queueStatus.ts` → `computeCallBlock()`
    (shared by QueueBoard + RadiologistBoard).
  - **room_busy_slots** RPC now used by RescheduleModal/StudyEditModal (migration 0050 added
    optional `p_exclude`); removed the RLS-blind direct `queue_entries` reads for referrers.
  - **Waitlist optional room binding** — migration 0051 (`waitlist_entries.room_id` + guard trigger
    `guard_waitlist_room`), room-aware candidate matching, `WaitlistModal` room selector.
  - **ESLint** set up: `eslint.config.mjs` (flat, ESLint 9 / Next 15.5, lenient baseline,
    `next lint`→`eslint .`, `docs/**` ignored). One stray warning in `lib/useRealtimeRefetch.ts`.
  - **Room breaks** (no migration — `rooms.schedule` is free JSONB): multiple breaks per room
    (whole-week + per-day) in the Setup Wizard (`rooms.schedule.breaks[]`, legacy single-lunch
    auto-migrated by `lib/schedule.normalizeRoomSchedule`); ENFORCED in Booking/Reschedule/Referral
    slot grids + StudyEdit duration cap (`roomBreaksFor`/`overlapsBreak`); interval validation.
  - **Emergency stop (Аварійна зупинка)** (no migration — incident `reason='emergency'`): sidebar
    toggle on QueueBoard + `EmergencyModal`; blocks one/several/all rooms "until clarified", marks
    today's affected patients `call_status='to_recall'`, fires `N8N_WEBHOOK_URL` (`emergency_stop`
    event, best-effort). Per-room instant toggle via `ConfirmDialog`, "all" view → multi-select
    modal (nothing preselected); stopped rooms are red in the sidebar; referrer booking blocked by
    the existing incident mechanism; `BreakdownModal` shows an "Розблокувати" banner for it.
  - **Referrer portal UI:** `MiniCalendar` extracted to a shared `components/MiniCalendar.tsx`
    (used by QueueBoard + ReferrerBoard); ReferrerBoard got a calendar rail + status filters in one
    line (7 cols); sidebar rooms are filtered by `referral_access.room_ids` and are clickable
    quick-filters (`focus` prop → board); native date/time pickers dark (`color-scheme: dark` in `:root`).
  - **studies_changed_by (migration 0052):** `editQueueEntryStudies` records the editor's role;
    both boards label edits "змінено клінікою/направником", synced via realtime. Admin queue shows
    the referrer (`referrer:referrer_id(full_name)`, fallback `doctor`); "⚠ Протипоказання" shown at
    the "Дослідження" label level in all boards.
  - `scripts/seed-test-data.mjs` updated (roles: 5–7 admin + 3–5 referrer/day; breaks-aware; waitlist
    3–5 per room). DESTRUCTIVE for one clinic; Игорь runs `node scripts/seed-test-data.mjs "<clinic>"`.

## Suggested next steps / open backlog
- **Stage-2: n8n + AI-agent automation.** First live hook already ships (emergency `emergency_stop`
  webhook). Next: smart waitlist rotation, predictive no-show, schedule optimization. Inputs modeled:
  `waitlist_status`, `priority_level`, `buffer_time_min`, `desired_*`, `room_id`, `isLate`,
  `waitlistMatchesSlot()`, `reschedule_origin`, `studies_changed_by`, emergency incidents.
- **Polish / tech-debt:** RadiologistBoard "· змінено" lacks the `studies_changed_by` attribution
  (its select omits the column); ReferrerBoard's in-board room `<select>` still lists ALL clinic
  rooms (should filter by the referrer's `room_ids`, like the sidebar now does); stray unused
  `eslint-disable` in `lib/useRealtimeRefetch.ts`.
- Referrer password recovery via email — deferred until a real domain + SMTP exist.

## Conventions / rules
- Always TypeScript; Server Actions pattern (`app/queue/actions.ts`, `app/waitlist/actions.ts`).
  Multi-tenant isolation (clinic_id / RLS) is security-critical — **use a subagent for security/RLS
  review** on anything touching policies/triggers/RPC. Service-role routes must check caller auth first.
- Migrations: manual via Supabase SQL editor, **sequential numbering (next is 0053)**, idempotent
  (`do $$ … exception when duplicate_object …$$`, `if not exists`, `drop … if exists`); update
  `supabase/types.ts` on schema changes.
- Realtime via `lib/useRealtimeRefetch.ts` (TD-3); wrap client reloads in try/catch.
- UI: Ukrainian copy, dark Apple-HIG tokens, Unicode glyphs (no emoji on dense screens, no icon libs),
  `.req` red required labels, `useModalA11y` for modals, ≥40px touch targets.

## Environment & workflow (important)
- **Cowork Linux sandbox is unreliable for the toolchain:** in-sandbox `tsc`/`npm run build`/`node`
  can hit truncated/stale file mounts (false errors); Grep may mangle `//`/`/*` — verify with Read.
  File tools (Read/Edit/Write) are ground truth. Игорь's local `npm run typecheck` + `npm run build`
  are authoritative. Git and deploys are run **locally by Игорь** (get explicit go-ahead before a
  `dev→main` push). `.git/index.lock` can go stale — Игорь removes it from PowerShell.
- Migrations applied to PROD manually by Игорь via the Supabase SQL editor.
- Dev server: **http**://localhost:3000. For browser testing use the Claude-in-Chrome connector;
  Игорь logs in per role (he never shares passwords), then you inspect. One Supabase session per
  browser profile — use a second browser/incognito to test two roles at once.
- Track work with the task list; keep the MEMORY.md files, `docs/PRODUCT_OVERVIEW.md` and
  `docs/AGENT_ONBOARDING.md` in sync when product behavior changes.

Start by reading memory + `git status`, then ask Игорь what to tackle next (Stage-2 automation,
the tech-debt polish, or a new feature).
