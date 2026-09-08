# Session 61 — opening prompt (English, owner's message format)

Rewritten at the end of session 60 (2026-09-08), after packages 41–45 and the test-data seed.
⚠️ The previous edition of this file was written at the end of session 59 and described the
state BEFORE session 60 (0180, vitest 2869, 29 stands). It was stale, not wrong-by-intent —
but a stale opening prompt costs the next session a reconciliation paragraph, so it is
replaced wholesale. The numbers below are EXPECTATIONS — the new session verifies them by
query. `main`/`dev`: take the hashes from `git ls-remote`.

Continuing development and production of the RadFlow SaaS. You are the orchestrator and Full
Task developer. Communication in Russian, UI copy in Ukrainian, project docs in Ukrainian.
Work DIRECTLY in `D:\RadFlowDev` via Desktop Commander; prod DB — Supabase MCP
(`rdiqjxzibdqbhwileret`).

AUTHORITY IS EXPANDED, and I confirm it now: you edit code/tests/SQL/docs yourself, create
append-only migrations and apply them to prod, run safe prod SQL, commit, push, merge, deploy,
read prod logs, do live checks. Applying SQL is yours, but with MANDATORY verification:
"Success" is not proof — verify the body md5 without CR, the ledger row, `invariants_check(false)`
and the smoke pins after every apply; and if you apply a guard reprint through a body-rebuilding
DO block instead of the literal file, verify the WHOLE catalog row, not just `prosrc`.

SAFEGUARDS ARE NOT CANCELLED IN ANY DEGREE: two independent review rounds with DIFFERENT lenses
on everything sensitive, and you validate subagent conclusions personally. Falsification of
guards — a NAMED red test and a GREEN baseline; live prod check in BOTH directions by
measurement; prod data only by an explicit list of ids with before-images; secrets and PII go
NOWHERE; `npm audit fix --force` is FORBIDDEN; dev and prod are ONE DB; never ask for passwords.
Ask me when a decision is irreversible and touches live patients, when it is a product decision
rather than an engineering one, or when access is needed. Compose a plan and AGREE THE FIRST
PACKAGE WITH ME BEFORE CODING. If a package is product-facing, show me the texts before they land.

TASK #0 before any edit: `select now()`, `git ls-remote origin main dev`, `git status`,
`maintenance_runs` overnight, `select max(name) from public.migration_ledger`,
`select public.invariants_check(false)`, `npm run db:gate`, and the deploy stamp
`GET https://rad-flow-tau.vercel.app/api/build`.

Expected: prod DB at **0183**, ledger **183/183**, invariants **ok / 22 / []**, next migration
**0184**; vitest **2931** (101 files), tsc 0, eslint 0; guard body md5 without CR
`3ac1aa3c88230816b8cf5ade32c1305d`, length **96322**, normalized pin g
`00d9ad82253bc2588b9f0cb70444a5b9`; `EXPECTED_STANDS` **33**; `main` `d5714f4` with deploy stamp
`cda0815f210b`, `dev` `7e1fcac`.

⚠️ The deploy stamp is now a TWO-DIRECTION instrument and must be used as one: compute
`sha256(<full 40-char SHA of main>)[:12]` YOURSELF first, then fetch `/api/build` and compare.
In session 60 it matched on the nose three times (`e749d66→0c835d40a3d5` before the merge,
`ae6a2e4→92d934266e6d` after, `d5714f4→cda0815f210b` after the docs merge). A stamp that equals
the PREVIOUS head means the build has not landed yet — that is a real answer, not a failure.

⚠️ The nightly `invariants_check` at 03:50 on 09.09 is the FIRST on the 0183 body. Check it
reports `ok:true, checked:22, failed:[]`. DO NOT TRUST THE DOCS — verify by query; a discrepancy
is a finding, name it.

## What session 60 did

**Packages 41–44** (carried over from 59): RF-01 closed via 0181, deploy-stamp instrument
(`/api/build`), RF-02 tail via 0182 (invite TTL), and a docs truth-up.

**Package 45 — RF-03, first half (0183).** `sched_referrer_read` handed a referrer the WHOLE
`schedule_overrides` row, and the entire hourly schedule of the day lives in one JSONB column
`rooms`: RLS cuts ROWS, not values inside them, so a grant on ONE room showed the hours of ALL.
Measured on prod with a rolled-back probe: a referrer granted exactly «КТ Суприя 32» saw TWO
keys in the 2026-08-09 row. Fix: definer RPC `sched_override_read(p_clinic, p_date)` filters
`rooms` by `auth_referrer_visible_rooms()`, and the policy is dropped. The branch is on
"staff of THIS clinic", NOT on the role name — `auth_role() = 'referrer'` would have made any
FUTURE role a silent full reader. Guard reprint: №16 64→63 policies, №19 26→27 function bodies,
`checked` unchanged at 22.

**Test-data seed** (`docs/audit/SEED-2026-09-08-test-data.md`): 228 entries, 12 cases, 29
`source='seed'` services across six active rooms, window 2026-09-09…15, tag
`note LIKE '%[seed-2026-09-08]%'`.

**RF-08 CLOSED by the owner** — leaked-password protection is on; verified by a fresh security
advisor scan, not by report.

## MAIN LESSONS OF SESSION 60 — every one of them cost something

1. **A reprint breaks stands pinned to the previous edition SILENTLY, and the full revision is
   the only thing that catches it.** Both red stands in the revision were 0183's own doing:
   `falsify-0181` A7 lost anchor UNIQUENESS (the formula
   `p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text,'')` now also lives in 0183's §3.3
   assert — and it MUST, otherwise the assert proves nothing), and `falsify-0182` T2 lost its
   anchor entirely.
2. **An anchor into a migration's HEADER is doomed by construction.** `file: "mig"` is not
   "my migration", it is `latestReprint()` — always the newest. Anchor into the guard BODY
   instead: reprints carry the body forward verbatim.
3. **A hard-killed stand does NOT run `finally`.** When the machine died mid-revision, a live
   mutation was left in the working tree: `app/waitlist/actions.ts` had `{` replaced by
   `if (input.sourceEntryId) {`, narrowing the clock-skew guard to one branch. Had it been
   committed, the guard would have silently stopped working on the ordinary path. **Check
   `git status` before AND after every revision** — this is why the rule exists.
4. **An empty vitest report under load reads as red and proves nothing.** `falsify-u55` came back
   red with N15 "no report" and N16 "wrong red"; re-run alone on a quiet machine it was 24/24.
   That revision took 88 min for 19 stands against 58 min for 33 — u55 alone went 550 s vs 76 s.
   Before believing a red stand, re-run it alone.
5. **My estimate for RF-03 was short three times, and every correction came from a grep, not
   from thinking.** "Three client call sites" was four — `BookingModal` is rendered by
   `ReferralPortal` (line 2501). "Remove the dead subscription" was wrong — `app/referral/page.tsx:67`
   lets `admin` onto that screen too, and `sched_staff_read` is alive for him.
6. **Introducing a catalog for a modality that was in the "legacy" state closes the escape and
   can break existing rows.** CT/US had 0 services but 23 region names already in use; the names
   were taken `INSERT … SELECT DISTINCT` from live `studies` so they matched byte for byte.
   Mammography was the one place where names had to be invented — and they were shown to the
   owner before they landed.
7. **Re-stamping an applied migration is legitimate ONLY with a measured basis.** After fixing
   false prose in 0183's "ПІСЛЯ НАКАТУ" section, `db:gate` caught the md5 drift. The basis was
   measured, not asserted: the builder reproduces the file at exactly the ledger's md5, and the
   diff was confined to lines after `commit;`. Then `md5 = null` + re-gate.
8. **A guard that is green with the safety off is a guard that is off.** `schedOverrideDoor`'s
   first edition read the whole migration text, so `-- drop policy …` in the ROLLBACK comment
   satisfied it. The stand caught it (A7). Parse only lines that actually execute.

## Queue for session 61 — a menu, not an order

**(1) 0183b — give the referrer instant schedule updates back.** This is the named, deferred
half of RF-03, and the cost is MEASURED, not guessed: it is not "wire up markers", it is
**build** them.
* `change_marker_recipients` has NO fan-out to a clinic's referrers at all — the referrer branch
  addresses ONE `p_referrer` and only for `scope_kind in ('entry','access')`. A new scope kind
  plus a fan-out over active `referral_access`, filtered by room grants, is needed.
* `schedule_overrides` has no emitter trigger (`rooms` has only the purge trigger — the earlier
  claim that room config emits markers was wrong; measured).
* A marker with no `useAckWhenVisible` is a DEFECT by this project's own rule, written into
  `change_marker_recipients` itself: "крапка, що запалюється й не гасне ніколи". `ReferralPortal`
  has two acks (`referral_access` entity, `waitlist` surface) — neither covers a schedule surface.
* It touches the SHARED function every marker emitter depends on, and it is pinned by check №19.
* Honest estimate: 6–8 h for the whole of RF-03, of which 0183a is spent. Take it on a fresh head.
* Current cost of NOT doing it, named in the code and the PR doc: the referrer learns about a
  schedule override on the existing `pollWhenSubscribedMs: 30_000` tick — up to 30 s late.

**(2) The seed will rot on 2026-09-15.** All 228 entries sit in the 09-09…15 window. Once that
window is in the past, the `sink-overdue` cron (every 5 min) stamps `clarify_at` on every one of
them and the board fills with "потребує уточнення". Not harmful, but noisy. Either re-seed into a
fresh window or clear it — cleanup is §6 of the seed doc, three DELETEs by the tag, and it was
rehearsed with a rollback (invariants stayed green).

**(3) 14 existing MRI rows in Medicom have a `region` that resolves to no active visible
service** (e.g. «Головний мозок», «Черевна порожнина», names with «(GE Signa, Закревського)»).
They predate the seed. Editing `studies` or moving them to another room fails with
`SERVICE_CLOSED` today. Either add the names to the catalog or migrate `studies` to canonical
names.

**(4) Named debts, unchanged:** `waitlist_entries.claim_token` dead since 0100; the PII key list
in `lib/importantEvents.ts` lacks `password`/`pw` (mirror of the DB CHECK — needs a migration);
`/api/staff/password` ignores the `profiles.update` error after the auth write; `fn_audit`
swallows every error; 37 Medicom services with no room; service-role key rotation. Five forks
still wait on the owner: Р1–Р5.

**(5) Advisor noise worth a decision, not a fix:** `pg_trgm` and `pg_net` sit in schema `public`
(WARN), and 12 tables have RLS on with no policies (INFO — `migration_ledger`, `rate_limits`,
`event_outbox` and friends; "no policies" there means "no client sees it", which is the intent).

## Standing costs and order

⚠️ Any migration that creates a table, view, sequence or an anon-callable SECURITY DEFINER
function must update check №22's key list IN THE SAME MIGRATION — otherwise the nightly guard
goes red with `new:`. If the object needs no client grants,
`revoke all … from public, anon` + an explicit `grant execute … to authenticated` in the same
migration (0183 §1 is the worked example, and package 43's three offenders are why).

Order: gate → commit → falsify-all (**33 stands**; ~60 min on a quiet machine, 88 min under load;
refuses a dirty tree; NO edits while ANY stand runs; one-shot `schtasks`; poll and give every poll
a green baseline) → merge → push → deploy → measure the fingerprint in BOTH directions.

⚠️ Run git ONLY from the Windows shell (Desktop Commander). PowerShell mangles inline JS and
`%ERRORLEVEL%` — put scripts in files under `C:\Users\Public`, never in the repo root (eslint runs
`--max-warnings 0`). Cyrillic commit and merge messages only via `-F <file>`; `git merge -m "…"`
through a nested-quote cmd wrapper WILL be parsed as a branch name (it was, in session 60).
The desktop bridge dropped four times during this session — long runs must go through `schtasks`,
which survives a session drop but not the machine sleeping.
