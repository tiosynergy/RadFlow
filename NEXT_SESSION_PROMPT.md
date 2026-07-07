# RadFlow — continue development (paste into a new Cowork/Claude Code session)

You are a Senior Full-Stack Engineer continuing work on **RadFlow** — a multi-tenant SaaS for
radiology (MRI/CT) queue management. Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS +
Auth) + TypeScript + Tailwind, deployed on Vercel. Repo: github.com/tiosynergy/RadFlow. Working
branch `dev`; merging `dev → main` + `git push origin main` triggers Vercel auto-deploy to PROD.
Communicate with the user (Игорь) in **Russian** (UI copy is Ukrainian).

## Before doing anything
1. Read the auto-memory: `MEMORY.md` and linked files — especially `radflow-state`,
   `radflow-waitlist`, `radflow-late-status`, `radflow-workflow`, `radflow-buffer-time`,
   `radflow-patient-priority`, `radflow-ux-audit`.
2. Read `docs/PRODUCT_OVERVIEW.md` (updated 2026-07-04 — source of truth, includes waitlist §4.6
   and derived «Запізнення») and `docs/audit/FULL_AUDIT_2026-06-25.md`.
3. Verify facts against code + `git status`/`git log` — memory reflects the moment it was written.

## Current state (as of end of 2026-07-04 session)
- **PROD migrations: 0044–0047 APPLIED** (confirmed by Игорь). Highest in repo: **0047**
  (`waitlist_entries`). No pending migrations.
- **Large UNCOMMITTED package on `dev`** (built & mostly browser-tested 07-03/07-04):
  - **Лист очікування** (migration 0047 + `lib/waitlist.ts`, `app/waitlist/*`, `WaitlistBoard/
    WaitlistModal/WaitlistCandidatesModal`, sidebar live badge, referrer portal tab, candidate
    suggestions on cancel, «⏳ В лист очікування» from CancelledPanel, slot prefill, cabinet filter
    via modality, security-review fixes).
  - **Derived «Запізнення»** (`isLate`/`LATE_META` in `lib/queueStatus.ts`): badge everywhere,
    blocked direct call + decision panel (все ж прийшов / перенести / в лист / не відбулося),
    StatsBar counter+filter, call-list section «Запізнення сьогодні», referrer badge.
  - **`lateCallClash` guard**: calling a patient NOW must fit (now + duration + buffer) before the
    next active booking of the room — both QueueBoard and RadiologistBoard. Anti-overbooking audit
    passed; `editQueueEntryStudies` now classifies OVERLAP errors.
  - **Waitlist UX pass** (heuristic review): one primary action + «⋯» RowMenu, Undo toast
    (aria-live), per-row busy state, ≥40px touch targets via `::before`, 15px patient name,
    compact stat strip, dismissible hint (`rf_waitlist_hint_hidden`).
  - **Decision-point edits** (LAST CHANGES — **NOT yet browser-tested**, dev server died):
    clickable patient name (dotted underline → full edit modal) in waitlist row/card and referrer
    portal; card action group «Додати в чергу» + «✎ Редагувати» + «✕ Зняти з листа»; row buttons
    hidden while card expanded (no «Дія» duplication); new `components/ConfirmDialog.tsx` —
    confirm modal for «Зняти з листа» (waitlist board + referrer portal).
  - **`scripts/seed-test-data.mjs`** + npm script `seed:testdata` — wipes queue_entries +
    waitlist_entries of ONE clinic and seeds today+7 days (10–15 patients/day, no Sundays) + 5
    waitlist patients. Игорь ran it: multiple clinics in DB → script correctly aborted with the
    list; needs re-run as `npm run seed:testdata "<назва клініки>"` (his clinic is «Medicom»).

## Immediate next steps
1. Игорь restarts dev server — it was stuck on «missing required error components» (likely stale
   `.next`; files on disk verified syntactically fine). If a compile error appears in his
   terminal, fix it first.
2. Re-seed test data: `npm run seed:testdata "<точна назва>"`.
3. Browser-test the untested decision-point edits on /waitlist (admin) and referrer portal:
   name click → edit modal; expanded card shows Пріоритет | Додати в чергу / Редагувати / Зняти;
   row buttons hidden when expanded; «Зняти з листа» opens ConfirmDialog (also from «⋯» menu),
   confirm → Undo toast; restore works.
4. Then: local `npm run typecheck` + `npm run build` (by Игорь), commit the whole package on
   `dev`, get explicit go-ahead, deploy `dev → main`. Remind him to re-seed or clean test data
   as appropriate before/after deploy (seed script targets one clinic only).

## Open backlog
- n8n + AI-agent automation (Stage 2): smart waitlist rotation, predictive no-show, schedule
  optimization. `waitlist_status`, `priority_level`, `buffer_time_min`, `desired_*`, `isLate`
  formula and `waitlistMatchesSlot()` were all designed as its inputs.
- Optional: hard `room_id` binding for waitlist entries (patient tied to a specific apparatus).
- Referrer password recovery via email — deferred until real domain + SMTP.
- Sidebar waitlist badge counts clinic-wide for staff (RLS-scoped), fine; CEO boards don't show
  waitlist metrics yet (possible future KPI).

## Conventions / rules (unchanged + new gotchas)
- Always TypeScript; Server Actions pattern (`app/queue/actions.ts`, `app/waitlist/actions.ts`).
  Multi-tenant isolation (clinic_id / RLS) is security-critical — use a subagent review for
  anything touching policies/triggers/RPC. Service-role routes must check caller auth first.
- Migrations: manual via Supabase SQL editor, sequential numbering (next is 0048), idempotent;
  update `supabase/types.ts` on schema changes.
- Realtime via `lib/useRealtimeRefetch.ts`; wrap client reloads in try/catch.
- UI: Ukrainian copy, dark Apple-HIG tokens, Unicode glyphs (no emoji on dense screens, no icon
  libs), `.req` red required labels, `useModalA11y` for modals, ≥40px touch targets.
- **Env gotchas:** Cowork Linux sandbox mount can serve STALE/truncated files — in-sandbox `tsc`
  is unreliable; file tools (Read/Edit) are ground truth; Игорь's local `npm run typecheck` is
  authoritative. Grep tool output may mangle text (`//` shown as `\`) — verify with Read before
  concluding a file is broken. `npm run build` doesn't complete in sandbox. Git and deploys are
  run locally by Игорь (get explicit go-ahead). Dev server is **http**://localhost:3000 or
  :3001 — for browser testing ask Игорь to log in per role (he never shares passwords), then
  inspect via Claude-in-Chrome.
- Track work with the task list; update MEMORY.md files as facts change; keep
  `docs/PRODUCT_OVERVIEW.md` in sync when product behavior changes.

Start by reading memory + `git status`, ask Игорь whether the dev server is back up and whether
the seed ran, then finish step 3 (browser-test) before anything new.
