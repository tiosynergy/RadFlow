# RadFlow — continue development (paste into a new Cowork/Claude Code session)

You are a Senior Full-Stack Engineer continuing work on **RadFlow** — a multi-tenant SaaS for
radiology (MRI/CT) queue management. Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS +
Auth) + TypeScript + Tailwind, deployed on Vercel. Repo: github.com/tiosynergy/RadFlow. Working
branch `dev`; merging `dev → main` triggers Vercel auto-deploy to PROD (live at
https://rad-flow-tau.vercel.app). Communicate with the user (Игорь) in **Russian** (UI copy is Ukrainian).

## Before doing anything
1. Read auto-memory `MEMORY.md` and the linked files — especially `radflow-state` (deploy facts),
   `radflow-workflow`, `radflow-referrer-board`, `radflow-emergency-stop`, `radflow-room-breaks`,
   `radflow-queue-lifecycle`, `radflow-waitlist`, `radflow-late-status`, `radflow-patient-priority`,
   `radflow-ux-audit`, `radflow-buffer-time`.
2. Read `docs/PRODUCT_OVERVIEW.md` (updated 2026-07-09 — source of truth) and
   `docs/AGENT_ONBOARDING.md`; audits in `docs/audit/` (latest: `DATA_ARCHITECTURE_AUDIT_2026-07-08.md`
   + `BACKLOG_RESIDUAL.md`, plus `FULL_AUDIT_2026-06-25.md`).
3. Verify every fact against code + `git status`/`git log` — memory reflects the moment it was written.

## Current state (start of session, ~2026-07-09, post-release)
- **PROD migrations 0001–0060 ALL APPLIED (verified 2026-07-09).** `dev` was merged into `main` (PR #3)
  and deployed to PROD; smoke-test passed (board loads, console clean, custom 404 live, TZ/occupancy
  correct). Highest migration = **0060** (`in_progress_actual_occupancy`). The next new migration is **0061**.
- **Uncommitted on `dev`:** only the documentation refresh (`docs/PRODUCT_OVERVIEW.md`,
  `docs/AGENT_ONBOARDING.md`, `README.md`, `docs/README.md`) — commit with a `docs:` message. All code
  + migrations + `vercel.json` cron removal are already committed and deployed.
- **Deploy env note:** Vercel is on the **Hobby plan** → cron jobs are daily-only. The every-minute
  cron was removed from `vercel.json` (it blocked the deploy); `vercel.json` now carries only `$schema`.
  The `/api/queue/sink-overdue` route stays (CRON_SECRET-protected) for manual/n8n use; boards call
  `sink_overdue_scheduled` on every reload anyway. Re-add a cron only if upgrading to Pro.

## Shipped in the previous session (release 0053–0060, all live on PROD)
- **Data-architecture audit fixes:** `0053` lightweight `audit_log` (queue_entries + incidents);
  `0054` `emergency_stop_rpc` (transactional emergency stop); `0055` transactional `event_outbox`
  (payload + HMAC + idempotency-key — reliable n8n delivery); `0056` incidents integrity (CHECK +
  VALIDATE); **CAS status transitions** (`expectedFrom` optimistic concurrency, threaded from boards);
  unified `requireRole()` service-role guard; `classifyError` by SQLSTATE.
- **`0057` referrer edit rights EXPANDED** — RLS `queue_write_referrer` allows write when
  `created_by = auth.uid()` **OR** `referrer_id = auth.uid()` (`FOR ALL`). A referrer edits both entries
  they created AND entries where the admin named them as referrer. (This REVERSED an earlier block idea
  — do NOT re-add a guard blocking it.)
- **`0058` auto-clarify:** `queue_entries.clarify_at` + RPC `sink_overdue_scheduled`/`_all` — overdue
  `scheduled` entries get flagged and sink down the queue (boards fire it per-clinic on reload).
- **`0059` universal timezone:** `clinics.timezone` (IANA). Wall-as-UTC canon (0035) unchanged; TZ only
  supplies "current wall moment of the clinic zone". Client helpers in `lib/incidents.ts`: `wallNow(tz)`,
  `wallInstant`, `wallMinOfDay`, `wallMinOfInstant`, `setClinicTz`/`getClinicTz`. `lib/queueStatus.ts`
  (`isLate`/`needsClarification`/`computeCallBlock`/`lateCallClash`) takes `nowMs`. **Do NOT hardcode
  `Europe/Kiev`** — multi-clinic screens pass `nowMs = wallNow(entryClinicTz)`.
- **`0060` in_progress ACTUAL occupancy:** `room_busy_slots`/`check_no_overlap` compute a running
  study's window from `in_progress_at` (real start), not the planned slot; zone validated via
  `pg_timezone_names`.
- **Bug fixes:** call blocked for entries not on the selected day (`computeCallBlock` → `wrong_day`);
  reschedule of an `in_progress` study is now ALLOWED (study stops → `scheduled`, `in_progress_at`
  nulled, SAME entry moves, `reschedule_origin.from_status='in_progress'`).
- **QA polish:** custom dark `app/not-found.tsx` (404 → "← До дошки черги"); slot-grid loading-gate in
  all booking/reschedule modals; "оберіть область" placeholder before a study is chosen; call-list stat
  skeleton; `reload()` sink RPC made fire-and-forget.
- **Earlier polish (also done, do not reopen):** RadiologistBoard `studies_changed_by` attribution;
  ReferrerBoard in-board room filter by `room_ids`; stray `eslint-disable` removed.

## Suggested next steps / open backlog
- **🔐 Rotate `SUPABASE_SERVICE_ROLE_KEY`** — it was exposed in a screenshot. Reset in Supabase, update
  the Vercel env var, redeploy. (Prohibited for the agent to do directly — guide Игорь; he does it.)
- **Queue-collision handling** (discussed, not built): when an overrunning `in_progress` study overlaps
  the next slot, offer an *assisted* panel — options are cascade-shift the room tail / reschedule to the
  next free slot / move to a parallel room / recall. Detection already exists (`lateCallClash`,
  actual-occupancy). Needs: a collision-detection UI panel + a server action to shift the room's tail.
  Open rules to confirm with Игорь: (a) delta absorbed silently by buffer, (b) shift only B vs whole
  tail, (c) what to do with entries pushed past the room's closing time.
- **Stage-2: n8n + AI automation.** Delivery infra now exists (`event_outbox` 0055 + `audit_log` 0053 +
  `emergency_stop` webhook). Next: smart waitlist rotation, predictive no-show, schedule optimization.
  Inputs modeled: `waitlist_status`, `priority_level`, `buffer_time_min`, `desired_*`, `room_id`,
  `isLate`, `clarify_at`, `waitlistMatchesSlot()`, `reschedule_origin`, `studies_changed_by`, `clinics.timezone`.
- **QA coverage gaps:** multi-role live testing (Radiologist / CEO / real Referrer logins) and
  mobile/tablet responsiveness — need test accounts + real-device verification.
- Referrer password recovery via email — deferred until a real domain + SMTP exist.

## Conventions / rules
- Always TypeScript; Server Actions pattern (`app/queue/actions.ts`, `app/waitlist/actions.ts`).
  Multi-tenant isolation (clinic_id / RLS) is security-critical — **use a subagent for security/RLS
  review** on anything touching policies/triggers/RPC. Service-role routes must check caller auth first
  (`requireRole()`).
- Migrations: manual via Supabase SQL editor, **sequential numbering (next is 0061)**, idempotent
  (`do $$ … exception when duplicate_object …$$`, `if not exists`, `drop … if exists`); update
  `supabase/types.ts` on schema changes. Apply SQL to PROD **before** merging `dev→main` (the deploy
  doesn't run migrations).
- Realtime via `lib/useRealtimeRefetch.ts` (TD-3); wrap client reloads in try/catch.
- Time: never hardcode a timezone — use `wallNow(tz)` / `clinics.timezone`; wall-as-UTC model (0035).
- UI: Ukrainian copy, dark Apple-HIG tokens, Unicode glyphs (no emoji on dense screens, no icon libs),
  `.req` red required labels, `useModalA11y` for modals, ≥40px touch targets.

## Environment & workflow (important)
- **Cowork Linux sandbox is unreliable for the toolchain and for reading files:** the bash mount can
  serve **stale/truncated** copies (seen this session — a fresh Edit wasn't reflected in `grep`), and
  `tsc`/`npm run build`/`node` hit false errors. **File tools (Read/Edit/Write) are ground truth** —
  trust Read over bash `cat`/`grep`. Игорь's local `npm run typecheck` + `npm run build` are authoritative.
- Git and deploys are run **locally by Игорь** (get explicit go-ahead before a `dev→main` merge/deploy).
  `.git/index.lock` can go stale — Игорь removes it from PowerShell.
- Migrations applied to PROD manually by Игорь via the Supabase SQL editor.
- Dev server: **http**://localhost:3000. For browser testing use the Claude-in-Chrome connector; Игорь
  logs in per role (never shares passwords), then you inspect. One Supabase session per browser profile —
  use a second browser/incognito to test two roles at once. **Never enter passwords** to authenticate.
- Track work with the task list; keep the MEMORY.md files, `docs/PRODUCT_OVERVIEW.md` and
  `docs/AGENT_ONBOARDING.md` in sync when product behavior changes.

Start by reading memory + `git status`, then ask Игорь what to tackle next (rotate the leaked key,
Stage-2 automation, queue-collision handling, or the QA coverage gaps).
