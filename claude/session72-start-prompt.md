# RadFlow — start prompt for session 72

Work **DIRECTLY** in `D:\RadFlowDev` through Desktop Commander. Production DB is
Supabase MCP, project ref `rdiqjxzibdqbhwileret`. Communication in Russian or
English; UI copy and project docs in Ukrainian (`claude/radflow-handoff.md` is
historically Russian — match each file).

You are the orchestrator and Full Task developer of RadFlow (patient flow in
MRI/CT rooms).

## There is NO unfinished package

s71 closed **0197** end to end: measure → build → dry run → apply → gate →
tests → full revision → merge → deploy → stamp in both directions. No live
feature branch, nothing half-applied.

## TASK #0 — RE-MEASURE, do not believe

A discrepancy with the table below is a **FINDING**: name it out loud, do not
quietly patch the doc.

| what | expected (measured 2026-09-15, end of s71) |
|---|---|
| `main` / `dev` | take BOTH from `git ls-remote`. ⚠️ A file cannot name the SHA of the commit that contains it, so this row names a FLOOR: `ce09d8d` (dev) / `ac50ba0` (main merge) **or the doc commits on top**. No live feature branch |
| prod DB | **`0197_auth_orphan_guard.sql`**, ledger **197/197**, unstamped 0 → next is **0198, FROM THE LEDGER** |
| `invariants_check(false)` | `ok:true`, **`checked:24`**, `failed:[]` |
| guard body | **raw** (`md5(replace(prosrc, chr(13), ''))`) **`f7bcdb2accee718e381f8c805a522abb`**, length **132 608**, CR **0** |
| new in 0197 | check **№24 `auth_orphan_accounts`** — auth users with no profile, older than **15 minutes** |
| `auth.users` | **9**, orphans **0** (was 14 / 5) |
| list №19 | **40** signatures, unchanged by 0197 |
| weak-form definer functions | **0** (check №2 pins the VALUE `search_path=public, pg_temp`) |
| policy digest (№16) | **`3e5b95410350`** |
| toolchain | tsc 0, eslint 0, vitest **3372/3372** (**649** suites in **108** files), `db:gate` **197/197**, build 0 |
| stands | `EXPECTED_STANDS` **40**, full revision **40/40** green |
| deploy stamp | compute `sha256(<current main SHA>)[:12]` **locally FIRST**, then fetch `/api/build`. Converged pair of s71: `ac50ba0` → `5c1e79f547fb` |
| pg_cron | **10** jobs, all active |

## What s71 did

- **0197 — five auth accounts with no profile deleted; check №24 now watches
  for them.** Owner's decision Н-6. A probe under such an account proved the
  hole is NOT what it looked like: RLS gives it **zero rows everywhere** and
  both resolvers return null. It cannot see anything — it simply exists, can
  authenticate, and **no mechanism knew about it**. So the cure is visibility,
  not access.
- **Three routes: the compensating `deleteUser` is now CHECKED**, and
  `/api/staff/password` no longer swallows the `profiles` update error.

## ⚠️ Where the author was wrong in s71 — read before trusting yourself

1. **The queue item's premise was partly FALSE, and only measurement showed
   it.** It said «fix the routes — a failed profile write leaves an orphan».
   All three routes already rolled back, since June. The real residual hole was
   one level down: the rollback's RESULT was never checked. **A queue item is a
   hypothesis, not a fact** — re-measure it before building to it.
2. **I raised a false alarm from a historical comment.** The guard's own prose
   says «`handle_new_user` … №17 does not see this function or its trigger»; I
   read that as a current gap. It is the record of why it was ADDED — the
   function is in list №19 today. Reading an old comment as current state is
   exactly what the journal scolds itself for.
3. **A rule that lived as prose in one file did not travel.** «Do not swallow
   update errors» was written in `/api/referrers/invite` in s25 and never
   applied to `/api/staff/password`, where the cost was higher.

## Queue for session 72 — a menu, not an order

⚠️ **Ask before coding.** Compose a plan (`TaskCreate`) and **agree the first
package with me before writing code.**

1. **М-4 / Н-1 — nothing pins the guard's OWN body.** 0197 reprinted it again;
   the property is still held by the apply ritual and №7, i.e. by procedure,
   not by a machine. This is the class that bit twice in s69.
2. **Н-7 continues — 75 definer functions pinned by nothing.** Per-function,
   the way 0195 found two real holes. Adjacent: `unique_login` and
   `unique_login_from_email` (helpers of `handle_new_user`, they decide the
   LOGIN of a new profile) are not in list №19.
3. **Plan 2.2 — the live check under the REGISTRAR**, the only role with no
   `LIVE-*` document, together with **С-14 (realtime)** in the same sitting.
4. **Plan block 1 — the live staff session** (Г1-E, Г1-G, Ф4-8 with a real
   `in_progress` patient, Г1-F on the five remaining paths). Needs me.
5. **Plan 4.4 — WCAG. Still NOT started** (s70 left no document on disk).
6. **Review-A findings never personally re-measured** — the radiologist oracle
   in `schedule_from_waitlist_rpc` / `set_waitlist_status_rpc`, the missing
   `auth_referrer_can_book_room` in `cancel_case_rpc`, the cross-tenant lock in
   `integration_apply_status`. **NOT MEASURED** is their status.
7. **Plan 3.2 — the restore REHEARSAL**, after the Dashboard look below.
8. **Plan 6.1 — the verdict**, last. Ceiling: **CONDITIONAL GO**.

## What the owner decides

1. **Р2** — the rule «where an audit trigger is required» (4–6 h; and whether
   catalogue tables like `services` need it).
2. **leaked-password protection** — 5 minutes in the Supabase Dashboard.
3. **Dashboard → Settings → Add-ons** — which plan, and is **PITR** bought?
   Until that is read, plan by **RPO 24 h**.
4. ⚠️ **Р3 in the plan's fork table** («extend №19 to the 38 schedule trigger
   functions») is still OPEN — do not confuse it with the `search_path` fork
   that 0196 closed, which s70 documents also called «Р3».

## Safeguards — NOT relaxed in any degree

Two independent review rounds with **DIFFERENT lenses** on anything touching
RLS, grants, `SECURITY DEFINER`, triggers, authorization, service-role code or
production migrations — and you validate every subagent conclusion
**personally**.
Falsification: a **NAMED red test plus a GREEN baseline**. Live production
checks in **BOTH directions**. Production data only by an **explicit id list
with before-images** — and ⚠️ the before-image is **redacted** when the row
carries secrets: 0197 deliberately did NOT write `to_jsonb(auth.users)` into
`audit_log`, because that is a password hash and an email.
Secrets and PII go **NOWHERE**. `npm audit fix --force` is **FORBIDDEN**.
Dev and prod are **ONE DB**. **Never ask for passwords.**

⚠️ **"Success" is not proof.** After every apply verify BY QUERY: the ledger row
and count, `invariants_check(false)`, the guard body md5 (naming the recipe) and
its length, the smoke pins. And run the **full test suite**.

⚠️ **A rollback verified inside the same transaction proves nothing.**

⚠️ **A "dry" run WITHOUT a rollback marker is an APPLY** (s70 paid for this).
⚠️ And a dry run that ends `ok:false` on `ledger_md5` is CORRECT — the ledger
row has no md5 until `db:gate` stamps it after the commit.

⚠️ **RED WINDOW.** From the second a migration registers in the ledger until its
file is in `main`, every production build fails. Close it in one move.

⚠️ **Never touch the tree while a stand runs.** If a revision is ever killed,
the runner refuses to start until `.falsify-all.running` is cleared by hand,
after `git status` — that refusal is the feature.

⚠️ **Time is a measurement too.** `timeout` through the bridge is a no-op; use
`Start-Sleep` and print the wake-up time. The bridge caps a call at ~60 s.

⚠️ **`git commit -m` with Cyrillic breaks** — the message always goes in a file
via `-F`.

## Where the detail lives

* `claude/NEXT_SESSION_PROMPT.md` — working mode, environment traps, rules.
* `claude/radflow-handoff.md` — durable state, freshest first.
* `docs/audit/PLAN-audit-completion-2026-09-13.md` — read its «СТАТУС» table
  first.
* `docs/audit/ToDo_Production.md` — everything gated on the first real centre.
* `docs/audit/PR-0197-auth-orphan-guard.md`,
  `docs/audit/PR-0196-secdef-search-path-value.md`,
  `docs/audit/PR-0195-referral-card-scope.md` — the last three packages, with
  every process error written out in full.
* `docs/PRODUCT_OVERVIEW.md` — the product and the schema evolution.
* `AGENTS.md` — the stable rules.
