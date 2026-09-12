# RadFlow — attachment for the next session (session 65)

> **This file is the ATTACHMENT.** The owner pastes
> `claude/session65-start-prompt.md` as the first message and attaches this
> file. Session-specific part rewritten at the end of session 64 (2026-09-12);
> the permanent part below is carried unchanged.
>
> ⚠️ **The two must come from the same end-of-session edit.** Session 59 opened
> on a pasted text one package older than its attachment; session 60 hit the
> same class from the other side — the start-prompt file still described the
> pre-session state and had to be rewritten wholesale, not patched. **A start
> prompt is only as good as its last rewrite — check its own date line before
> you paste it.**
>
> ⚠️ **HISTORY HAS MOVED.** Editions of this file up to session 60 carried the
> per-session tables and lessons of sessions 57–60 inline; they had grown to
> duplicate `claude/radflow-handoff.md`, which is the history file. From this
> edition on, this attachment carries **current state + permanent rules** only.
> Everything older lives in `claude/radflow-handoff.md`, freshest block first.
>
> ⚠️ **DO NOT TRUST THIS FILE.** Everything below is what SHOULD come out, not
> the source of truth. Verify by query and by command (TASK #0). **A
> discrepancy is a FINDING — name it, do not silently patch the doc.**

You are continuing development and production of the **RadFlow** SaaS (patient
flow in MRI/CT rooms). You are the orchestrator and Full Task developer.
**Communication in Russian or English. UI copy in Ukrainian. Project docs in
Ukrainian** (`claude/radflow-handoff.md` is historically Russian — match each
file). Work **DIRECTLY** in `D:\RadFlowDev` through Desktop Commander; the
production DB is Supabase MCP, project ref `rdiqjxzibdqbhwileret`.

---

## AUTHORITY IN THIS SESSION — EXPANDED

You may, on your own: edit code, tests, SQL and docs; create append-only
migrations and **apply them to production**; run safe production SQL; create and
remove synthetic production data; commit, push, **create and merge PRs**,
**deploy**; read production logs; do live browser checks.

The old rule "merge/push/apply is done by the owner" is **CANCELLED**. If you
find it in the docs as a live rule, fix it in place (`docs/HANDOVER.md` and the
old audits keep it as history — leave those alone).

### ⚠️ APPLYING SQL — apply automatically, but verify the Results

"Success" is not proof. After EVERY apply, verify by measurement: the function
body (`md5(replace(prosrc, chr(13), ''))` against the md5 of the file's body —
the SQL Editor brings CRLF) **and its length**, the ledger row and count,
`invariants_check(false)`, the smoke pins. In session 56 "Success. No rows
returned" hid TWO discrepancies. And run the **full test suite** — in session 62
that is what found what neither review round saw.

## SAFEGUARDS — NOT CANCELLED IN ANY DEGREE

- **Two independent review rounds with DIFFERENT lenses** on anything that
  touches RLS, grants, `SECURITY DEFINER`, triggers, authorization, service-role
  code, integration contracts, concurrency or production migrations. **You
  validate subagent conclusions personally.** Proven lens pairs: "falsification:
  which mutation leaves this pin green" × "operational risk and operator
  experience"; "what breaks for the next person" × "did the author overstate his
  own measurements". ⚠️ Session 63 is the case for the second pair: the
  falsification lens found that my own before/after comparison was VACUOUS and
  that my headline measurement had been taken on the wrong branch, while the
  access-surface lens came back clean. One lens would have shipped the lie.
- **Falsifying a guard requires a NAMED red test and a GREEN baseline.**
- **Live production check in BOTH directions, by measurement.** If there is
  nothing to check on, say so plainly instead of faking a check.
- **Production data only by an explicit list of ids** with before-images.
- **Secrets and PII go NOWHERE** — not into a report, not into a log, not into a
  subagent prompt.
- **`npm audit fix --force` is FORBIDDEN.** dev and prod are **ONE DB**.
- **Never ask for passwords.**

### When to ask the owner anyway

- the decision is **irreversible** and touches live patients;
- it is a **product** decision rather than an engineering one;
- you need credentials or access you do not have.

---

## ✅ STATE OF PLAY — after s65 (12.09.2026)

s65 shipped three packages: the stale root `NEXT_SESSION_PROMPT.md` is gone;
the race-harness guard now covers BOTH outbox branches (`emergency_stop` goes
to n8n, and five such rows in prod were ALL delivered); migration **0190** makes
check №19 cover the PII-visibility PATH — `room_busy_slots` **and**
`auth_can_see_slot_details` (the function that actually decides), plus an
`extra:` branch that makes an OVERLOAD of a pinned name visible. Full revision
37/37 green after the reprint.

⚠️ **Two reviews with different lenses are not a ritual.** The first edition of
the delivery guard passed its own ten tests and four mutations and carried THREE
independent ways to turn a refusal into permission; the first edition of 0190
pinned the caller and left the decider. Neither was caught by re-running tests.

### The s64 block below stays as the merge-blocker archaeology



`dev` → `main` was merged in s64: `main` = **`7dfdaf2`**, and production serves
it (`/api/build` → **`887f3738c8ee`** = `sha256(7dfdaf29…)[:12]`, computed
locally BEFORE fetching). Order kept: gate → clean tree → full revision 37/37
green → merge (`--no-ff`, ort, no conflicts) → `db:gate:check` 189/189 and
`npm run build` exit 0 → push → deploy → stamp in both directions. The live
write check on the new build passed in both directions — detail in the s64 block
of `claude/radflow-handoff.md`.

⚠️ **The gate is symmetric** (`scripts/migration-gate-lib.mjs:82-88`): a ledger
row with no file on disk fails the build exactly as loudly as a file with no
ledger row. That is WHY an unmerged branch carrying applied migrations blocks
production. Keep `main` and the ledger in step — do not let four migrations pile
up on `dev` again.

⚠️ **The old claim that 0187 made `fn_audit` RAISE is FALSE** (s64 finding).
It raises a **`warning`**; the failure mode stays **fail-open** and the business
write is never rolled back — the function's own comment says «ПОВЕДІНКА НЕ
МІНЯЄТЬСЯ НІ НА БІТ». Measured: **76** audit rows across three tables since 0187
was applied, not one lost write. Do not resurrect the "the DB is ahead of the
code and writes may fail" story; that risk never existed.

---

## TASK #0 — before any edit

Run all of it, in this order, and compare against the table below:

```
select now();                                        -- server clock
git ls-remote origin refs/heads/main refs/heads/dev  -- NOT git fetch
git status                                           -- tree must be clean
select id, job, ran_at, result from public.maintenance_runs
  where ran_at > now() - interval '30 hours' order by ran_at desc;
select max(name), count(*) from public.migration_ledger;
select public.invariants_check(false);
npm run db:gate:check
```

…plus the **deploy stamp** of `/api/build`.

### Expected state (measured 2026-09-12, END OF SESSION 65) — START HERE

⚠️ **Every body md5 below NAMES ITS RECIPE** (s64 finding: two md5 taken with
two different recipes sat side by side unlabelled, and the unlabelled one is the
input to queue item 2). The two recipes are:
* **raw** — `md5(replace(prosrc, chr(13), ''))`;
* **normalized** — `md5(btrim(regexp_replace(replace(prosrc, chr(13), ''), '[[:space:]]+', ' ', 'g')))`.

| what | expected |
|---|---|
| `main` / `dev` | take BOTH from `git ls-remote` — s65 merged `dev` → `main` at the end of the session, and the docs commit of this handover lands on `dev` after it. A difference here is not a finding |
| branches | ⚠️ `dev..main` is large (merge commits of `main`'s own history), so `--ff-only` will NOT work — merge with `--no-ff -F .commitmsg` |
| prod DB | **`0190_room_busy_slots_pinned.sql`**, ledger **190/190**, unstamped 0 |
| **next migration** | **0191** — the number comes FROM THE LEDGER, never from the folder |
| `invariants_check(false)` | `ok:true`, **`checked:23`**, `failed:[]` |
| guard body | **raw** **`9680c291c01469e19cc8f6f99fd0093f`**, length **112 207**, CR **0**; **normalized** = pin `g` **`2e637a752614c08b587322cc46503377`** |
| `room_busy_slots` body | **raw** **`4d7b653117bb1b302666b31e829cc381`** (4883 chars); **normalized** **`83ddb89d6b1cd33ae19c8d314d29b73c`** — the latter is the pin in list №19 |
| `auth_can_see_slot_details` | **normalized** **`19fe1040308640b29a5d8b1bb7506873`** — pinned by 0190; it is the function that DECIDES PII visibility |
| list №19 | **30** signatures (was 28), plus the new `extra:` branch for overloads |
| toolchain | tsc **0**, eslint **0**, vitest **3235/3235** (631 suites), `db:gate` **190/190**, `npm run build` exit **0** |
| stand revision | `EXPECTED_STANDS` **37**, all 37 green, **3041 s ≈ 51 min** (s65 measurement) |
| migration files | **192** `.sql` on disk vs **190** in the gate — NOT a hole: `0064_PRECHECK.sql` and `0066_PRECHECK.sql` are excluded by the gate on purpose, and its own code says so |
| deploy stamp | compute `sha256(<40-char SHA of main>)[:12]` LOCALLY first, then fetch `GET /api/build`. ⚠️ Build latency measured at **~11 min** in s64, not the "4–9" the older docs claim |

⚠️ **The guard body grew by 615 chars in 0190** (111 592 → 112 207): two pin
rows plus the `extra:` branch. In s64 the length stayed the same while the md5
changed (an equal-length md5 substitution) — both shapes are normal, so compare
BOTH numbers and never infer "nothing changed" from the length alone.

### How to take the deploy stamp

The prod URL is **`https://rad-flow-tau.vercel.app`**. `GET /api/build` returns
`{stamp, reason, env}` where `stamp = sha256(VERCEL_GIT_COMMIT_SHA)[:12]`.

⚠️ **It is a TWO-DIRECTION instrument — use it as one.** Compute
`sha256(<full 40-char SHA of main>)[:12]` YOURSELF first, then fetch. A stamp
equal to the PREVIOUS head means the build has not landed yet: that is a real
answer, not a failure. It says WHICH commit is served, NOT that the build is
healthy — that stays with live checks.

⚠️ **Measure it from the owner's machine or with a unique cache-buster** — the
container's `WebFetch` cache outlives the session (s61 finding). Build latency
was **~11 minutes** in s64 (measured end to end), and 4–9 minutes before that —
so a stamp still showing the PREVIOUS head at minute 8 is normal, not a failure.

⚠️ The older `/login` buildId fingerprint method is **dead** — it was
one-directional, it could not be reproduced across two sessions, and `/login`
carries no buildId at all on this application. The archaeology is in
`claude/radflow-handoff.md` and `docs/audit/PR-42-deploy-stamp.md`; do not
resurrect it.

⚠️ **Which browser lands where.** `lib/supabase/middleware.ts` sends a logged-in
user from `/login` to `/queue` UNCONDITIONALLY; `app/queue/page.tsx` then routes
by role (radiologist → `/radiologist`, referrer → `/referral`, ceo → `/ceo`), and
only **admin / registrar** stay on `/queue`. So the landing page tells you the
ROLE of the live session, nothing more. **There are two Chromes on the account** —
do not treat either as canonical. Byte counts must not be compared between
browsers.

⚠️ **The eslint gate runs with `--max-warnings 0`.** Clean up scratch files.

⚠️⚠️ **RUN THE FULL STAND REVISION ONLY ON A CLEAN TREE, AND TOUCH NOTHING
WHILE IT RUNS.** Session 58 knew this rule and broke it anyway: an edit to
`claude/radflow-handoff.md` while `falsify-all.mjs` was running was read as "a
stand failed to restore the live files", the revision stopped on the first stand
and the edit was reverted with `git checkout --`. An hour of run time and the
text, gone. Write the docs before or after — never in parallel.

---

## WHAT SESSION 63 DID — packages 51–63, migrations 0186–0189

Full detail with the measurements: `claude/radflow-handoff.md` (top block),
`docs/audit/RF-07-2026-09-12-advisor-measure.md`,
`docs/audit/PERF-2026-09-12-pg-timezone-names.md`.

| package | what |
|---|---|
| **51** | race harness scenario `stop` — emergency stops crossing each other. Run on prod: PASS, no deadlock, 23505 to the third |
| **52** | cheap tech-debt batch: two items fixed, two **re-estimated** (the doc's estimate was wrong) |
| **53** | scenario `case` UNBLOCKED — a series of rounds instead of one shot. Run on prod: PASS, the decisive ordering 1 in 8 |
| **54** | a room's schedule refreshes while the modal is open (+stand `falsify-sched-refetch`) |
| **55** | a dead stand revision now leaves a loud trace instead of a quiet zero |
| **56** | sixth harness scenario — overlap ACROSS the day boundary |
| **57** | **0186** — `claim_token` declared dead without a `DROP` |
| **58** | three stands were measuring with NO baseline — fixed |
| **59** | **0187** — `fn_audit` no longer swallows errors silently |
| **60** | **0188** — the dead GIN `cities_label_trgm` dropped: `cities` indexes 14 MB → 7552 kB, `public` indexes 17 MB → 11 MB |
| **61** | `stop --with-case` — emergency stop over REAL case steps |
| **61b** | the token guard became FAIL-CLOSED — found by a LIVE run, not by review |
| **62** | `case` — the vacuum was found INSIDE the decisive ordering |
| **63** | the Г1-F refusal in the waitlist became VISIBLE (the toast drowned under the overlay: z-index 100 vs 200) |
| **RF-07** | measured to the end and left DEFERRED |
| **0189** | `room_busy_slots` — the timezone is resolved once per query instead of per row |

**Production data changed in s63, by explicit id list:** two waitlist test rows
deleted — `09fe3a92-0e5a-4adb-b719-ec0ed48a6922` and
`2f61467e-1c2a-46f9-9061-fc49e2e223bc`, both `waiting`,
`desired_date_from = 2026-09-11`.

## LESSONS OF SESSION 63 — each one cost something

1. **Measuring the wrong branch looks exactly like measuring the right one.**
   The `×110` for 0189 was measured honestly — on a shape that does not exist in
   the hot path (the tz subquery sits in the `in_progress` branch of a `CASE`,
   and `CASE` short-circuits). A probe on live data: **94 rows → 0 tz calls**.
   **Before writing a number down, name the CONDITION under which the measured
   code runs, and check that it holds.**
2. **A before/after comparison on production can be VACUOUS and look green.**
   Zero `in_progress` rows meant the changed branch ran neither before nor
   after. Cure: a synthetic guard with a BUILT-IN non-vacuity assertion
   (`v_cover = 0` → raise) plus a `raise warning` when live rows of the needed
   shape do not exist. **A guard that cannot tell it checked nothing is worse
   than none.**
3. **A regex over `prosrc` inside its own migration is a tautology** — it matches
   text the same migration just wrote, and it can be fed from a COMMENT. Partial
   cure: strip comments before matching. Real cure: the named list of check №19.
4. **`<>` against a possibly-NULL value is fail-open.** `if v_md5 <> '…'` yields
   NULL when `prosrc is null`, and `if NULL` is false. Use `is distinct from`.
5. **A test-data prefix must be CHECKED, not remembered.** A residue check ran
   `patient_name like 'ГОНКА%'` while the fixtures are named `ТЕСТ Гонка с38` —
   "0 rows" proved nothing.
6. **A guard that prints its diagnosis and carries on is not a guard.** The JWT
   check logged "does not look like a JWT" and still went to the network. Now
   fail-closed, before the client is created.
7. **A test pinned to a PHRASE goes red on its own comment.** The first pin
   required the absence of a phrase, and my explanatory comment quoted it. Pin
   BEHAVIOUR, after stripping comments.
8. **DevTools "Request conditions" is URLPattern, not a substring.**
9. **Shifting the clock FORWARD by +24 h kills the session** (token treated as
   expired → refresh → 429 → 401 → `/login`). Shift BACKWARD.
10. **The clipboard is not a channel** — the owner copies my own command block
    back. Use a file or console history.

### Added by session 65

11. **A green test set and a green stand do not mean the guard guards.** The
    first edition of the delivery guard passed its own ten tests and four
    mutations and carried THREE ways to turn a refusal into permission. What
    found them was two reviews with DIFFERENT lenses, not a third run.
12. **Before explaining why your trick is safe, look for that trick in your own
    file.** Client-side filtering after a `select` without a limit is named as a
    hole 800 lines above in `race-check.mjs` — and I wrote it anyway, with a
    comment claiming the opposite.
13. **"Not delivered" is not proof of silence** — a POSITIVE marker is required.
    Absence of evidence to the contrary is not evidence.
14. **An evidence window wider than the retention horizon is a relaxation
    disguised as caution**: it can only add rows that cannot carry the evidence.
15. **Pinning the caller and leaving the decider = closing the door and leaving
    the window.** Ask "who ACTUALLY decides?" before writing the pin.
16. **A named list without an `extra:` branch has no closure** — it guards the
    named bodies, not the absence of new doors (an overload walks past).
17. **A pin an honest comment can break is noise; a pin a comment can satisfy is
    a lie.** Both cure the same way: read the CODE, not the text.
18. **`tsc` catches what vitest does not** — the "broken facts" test did not
    compile because a JSDoc type promised numbers are always numbers.
19. **One source is not a conclusion** — «`sink-overdue` is nowhere» rested on
    `maintenance_runs`, where that job simply never writes.

---

## QUEUE FOR SESSION 66 — a menu, not an order

⚠️ **Ask before coding.** Compose a plan (`TaskCreate`) and **AGREE THE FIRST
PACKAGE WITH ME BEFORE WRITING CODE.** If a package is product-facing, show me
the texts before they land.

**Closed in s64:** merge `dev` → `main`, deploy, live write check.
**Closed in s65:** the root `NEXT_SESSION_PROMPT.md` duplicate (`git rm`, ten
live pointers moved to `claude/`); the n8n branch of the harness delivery guard;
the pin of `room_busy_slots` in check №19 — **and of
`auth_can_see_slot_details`, the function that actually decides PII
visibility**, plus an `extra:` branch against overloads (migration 0190).
Do not redo any of it — verify it (TASK #0).

**Answered by measurement in s65, so do not re-open it as a question:**
`sink-overdue` is NOT missing. It is **pg_cron jobid 1**, `*/5 * * * *`, active,
`select public.sink_overdue_scheduled_all();`, 288 successful runs in 24 h. It
simply never writes to `maintenance_runs` — only three jobs log there. The
seed-window item rests on it, and the premise HOLDS.
**Owner's decision on the seed window (s65): leave as is** — 97 of 225 entries
already carry `clarify_at`.
**Owner's decision on `event_outbox` (s65): do NOT delete the four harness rows
(id 60–63)** — they are the evidence that the n8n branch is live; retention
removes them ~10.10.

1. **`proacl` into the `attrs` of check №19.** `grant execute on function … to
   <a role member of authenticator>` and `revoke … from authenticated` are
   invisible today: №22 filters by `anon` and delegates bodies to №19, and №19
   does not look at ACL at all — the ring is not closed. The cure is one
   expression (`;acl=` in attrs), but it changes all 30 values: its own
   migration, its own two reviews, its own full revision.
3. **The five definer functions that decide or return PII and are pinned by
   nothing:** `emergency_stop_rpc` (returns `patient_name` and `patient_phone`),
   `queue_set_status_rpc`, `submit_incident_rpc`, `check_no_overlap`,
   `check_not_in_past` (the last two are ROW triggers on `queue_entries` and are
   absent from the list of №17 as well). ⚠️ This is an OWNER'S decision, not
   leftover tz-debt: the intersection of "slow because of tz" and "decides
   access" is accidental.
4. **`pg_timezone_names` phase 2 — owner's decision first.** Five functions
   remain, two of them ROW triggers on `queue_entries`, so every write pays at
   least two scans. Blocked on: `Europe/Kiev` is a legacy alias; if tzdata drops
   it, a trigger on `clinics` does not save us — it guards WRITES while READS
   would start failing. Options in §7б of the PERF audit doc.
5. **`auth_rls_initplan` — 15 policies**, separate from RF-07. The win is **not
   automatic**: measured that the planner already folds `auth_clinic_id()` into
   an `Index Cond` without the wrapper. Measure per policy.
6. **The seed window — CLOSED BY THE OWNER'S DECISION (s65): leave as is.**
   Measured 12.09: the window is 10–16.09 and **97 of 225** entries already
   carry `clarify_at` (10.09 — 32/32, 11.09 — 36/36, 12.09 — 29/29). Re-seeding
   is a treadmill: the cron stamps every slot as it passes, not "after the
   window". Do not re-open without the owner.
6b. **`docs/README.md` says «9 кронов на 2026-08-24»; `cron.job` has 10** (ids
   1, 3, 4, 5, 6, 10, 11, 12, 13, 17). Cheap and worth doing: find which one
   appeared and fix the registry. ⚠️ `docs/ops-cron.md` is a LIVE doc pinned by
   `invariantsCheckedPins` (`LIVE_DOCS`) — it must not lie.
6c. **A behavioural stand for the acl branch of `room_busy_slots`.** 0190 pins
   the CURRENT body, not its correctness: had prod already been hollowed out,
   the pin would have cemented that. There is no `falsify-0190.mjs`.
6d. **`assertNoLiveDelivery` does not cover `cleanup`** — that command runs
   before the guard in `main()`, and DELETE of entries emits
   `integration.appointment.deleted` via 0145. The boundary is named in the code.
7. **14 existing MRI rows in Medicom have an unresolvable `region`.** Editing
   `studies` or moving them fails with `SERVICE_CLOSED` today. Two also have
   `room_id IS NULL`.
8. **Advisor noise that needs a DECISION, not a fix:** `pg_trgm` and `pg_net` sit
   in schema `public` (WARN); 12 tables have RLS on with no policies (INFO —
   `migration_ledger`, `rate_limits`, `event_outbox` and friends, where "no
   policies" means "no client sees it", which is the intent).

## FORKS Р1–Р5 — these cannot start without the owner's decision

Full text with the measurements: `claude/plan-s57.md` §3. **Р6 is DONE.**

| # | fork | what has been measured so we do not decide blind |
|---|---|---|
| **Р1** | the CASE path for Г1-F — duplicate the clock guard on the server? | Case steps are captured by `buildPayload()` long before submission, so a naive claim would go stale and the guard would reject HONEST work. Needs a claim taken at submit time, ~2 h |
| **Р2** | the rule "where an audit trigger is required" (the named boundary of 0173) | Today the list says "these six must exist", not "audit must exist everywhere it is needed". A NEW table with PII and no audit trigger is invisible to everyone |
| **Р3** | extend list №19 to the 38 schedule trigger functions? | A trigger function body is touched by 8 of the last 30 migrations vs 4 of 30 for the current list — twice as many 1100-line reprints. Two named candidates: `update_patient_details(uuid,jsonb,jsonb)` and `tg_change_markers_queue()` |
| **Р4** | Playwright / E2E by role | The project has no browser test at all, **by design**. This is the decision to create the first one |
| **Р5** | `user_change_markers` → `REPLICA IDENTITY FULL` | Both sides measured. Today a DELETE never reaches the subscriber and the dot clears by a 60-second reconciliation. With FULL it clears in <1 s, but on DELETE `apply_rls` evaluates no RLS at all — content does not leak (payload trimmed to PK), the FACT and the TIME do. ⚠️ Check №21 holds the exception assertively, so on the day of the switch the guard itself goes red and demands the exception be removed. By design |

## NAMED DEBTS — open, each with the place it lives

- **`room_busy_slots` and the five other tz functions are absent from check
  №19's named list** — queue item «Pin `room_busy_slots`». ⚠️ Use the
  **normalized** md5 `83ddb89d…`, not the raw `4d7b6531…` (s64 finding).
- **`assertNoLiveWebhook` covers only `integration_webhooks`** — queue item
  «`assertNoLiveWebhook` does not cover the n8n branch».
- **`lib/importantEvents.ts` PII key list has no `password`/`pw`** — it mirrors
  the DB CHECK of 0128/0160, so it needs a migration, not a one-line edit.
- **`/api/staff/password` ignores the `profiles.update` error after the auth
  write** — on that failure the response carries a token that is not in the DB.
- **Guard №15 (g2) boundary:** a definer RPC `returns jsonb` built with
  `to_jsonb(p)` and no `invite_token` in its body is not caught.
- **Live browser check of the CEO card** under an admin — still not done.
- **The second half of U-59 (modal overlay)** — the flag already exists
  (`anyModalOpen`, `QueueBoard.tsx:1589`); what is missing is a fourth `ackGate`
  input `overlayShown` with outcome `hold` plus one prop into the row.
- **`incidentCount` in the staff sidebar** is still a two-state falsy gate.
- **The `services` surface** is the only permanently-visible one without a
  `refreezeKey`.
- **`Sidebar` reads `loadWaitCount` twice on mount.**
- **`room_id` in `queue_reschedule_rpc`** — the second half of the U-66 finding;
  same class in **`updateWaitlistEntry`**.
- **No consolidated list of the visibility columns of `queue_entries`**
  (`{referrer_id, clinic_id, room_id, created_by, case_id}`).
- **The "assigned" event reuses `referral.patient_data_changed`.**
- **The body of `tg_change_markers_queue`** is pinned by nothing — adjacent to Р3.
- **The stand runs only `vitest`, not `tsc`/`build`** — a mutation that breaks
  TYPES but not syntax passes through esbuild. ⚠️ This debt fired twice live in
  s62 (TS1501, TS1127): `tsc` named the exact place, vitest only said "the file
  fell over".

### Decisions already made — do not reopen

Branch protection on `main` stays OFF; the service-role key rotation is tied to
the first real centre (so the audit verdict stays at CONDITIONAL GO); the
DEFERRED day-shift window on the boards is not a problem; the `returned` banner
texts and the short `CLOCK_SKEW_MSG` are approved; the two test `queue_entries`
from 31.08 are the owner's own; the U-59 background semantics and the U-60
unknown-badge look are approved and shipped; RF-09d variant A; `claim_token` is
out of scope of RF-09; **RF-07 deferral accepted in writing**
(`docs/audit/DECISIONS-2026-09-09.md`), and s63 measured it to the end.

---

# PERMANENT PART

(Working mode, environment traps, rules, tools. Carried from session to session
until the owner decides otherwise.)

## WORKING MODE: DIRECTLY IN THE PROJECT FOLDER (the owner's requirement)

Work **DIRECTLY in `D:\RadFlowDev`** — not through file uploads, not through
clones, not "I'll prepare the text and you paste it". Read, write and edit in
place through Desktop Commander.

**Use EVERYTHING that is connected: MCP connectors, skills, plugins.** First
thing, look at what is actually available in the session. Proven in combat:

- **Desktop Commander MCP** — files and processes on the owner's machine:
  `read_file` (offset/length; a negative offset reads the tail), `edit_block`
  (ALWAYS after a read), `write_file` (in chunks, `mode` EXPLICIT — otherwise it
  refuses on an existing file), `start_search`, `start_process` (shell, git, npm,
  node).
- **Supabase MCP** — the production DB, `execute_sql`, ref `rdiqjxzibdqbhwileret`.
  A dry-run of a migration against live data is the canon (SMOKE_OK inside the
  error text means success). ⚠️ `execute_sql` runs as an independent session with
  no `auth.uid()`, so RPCs requiring an authenticated context behave differently
  than the app would. To exercise a definer RPC's own gate, set
  `request.jwt.claims` with `set_config(…, true)` and restore it.
- **The cloud container (`Bash`)** — a clean environment: clone from GitHub +
  `npm ci` + the full gate in **~2 minutes**. Also convenient for `sleep` while
  waiting for long background runs on the owner's machine.
- **Two independent subagents** — the two review rounds per package (canon).
  They read the code straight out of `D:\RadFlowDev` through Desktop Commander,
  so give them the DC tool list in the prompt and DIFFERENT lenses. ⚠️ Demand
  the format "SCENARIO / HARM / CURE" and an explicit "NOT VERIFIED" wherever
  they did not read to the end. ⚠️ And if you hand a reviewer an ABRIDGED copy of
  the artefact, say so in the prompt — in s63 a review copy with stubbed guard
  bodies made the reviewer open with "these guards do not exist", which was true
  of the copy and false of the file.
- **Claude Projects** (`project_read` / `project_write`) — copies of the handoff
  and the key docs, visible to the owner across Claude products. ⚠️ The canon is
  the REPOSITORY; Projects is a copy. `project_write` replaces a doc whole, so a
  6900-line file like `claude/radflow-handoff.md` cannot be patched there
  cheaply — expect the Projects copy of that one to lag.
- Also: the built-in browser, **Claude in Chrome** (live UI checks), Figma,
  Google Drive, n8n, Lovable.

## ENVIRONMENT TRAPS (verified, sessions 43–64)

### Around stands and long runs

⚠️ **Any edit in the repository while ANY stand is running is silently rolled
back.** A stand snapshots the live files on start and restores them in
`finally` — not just `falsify-all`, every `falsify-*.mjs`. While a stand is
running, do not touch the tree at all. ⚠️ **This includes the OWNER** (s64): he
saved the root `NEXT_SESSION_PROMPT.md` mid-revision, the between-stand tree
check read it as an unrestored mutation, the revision stopped at stand 8 of 37
and its own `git checkout --` discarded his edit. Warn him out loud before
starting a revision — and remember that the writer is not always a stand.
⚠️ **`falsify-all.mjs` REFUSES to start on a dirty tree.** **The order is: gate →
commit → revision on a clean tree.** Or `--allow-dirty` if you deliberately
measure the working copy.
⚠️ **A full revision takes 40–50 min** (s64: 50 min for all 37, `falsify-u72`
alone 471 s). Plan it as background work, not as a step.
⚠️ **A stand that is red with an EMPTY facts table "did not finish"** — that is
not "the guard does not hold". Run that stand separately before believing it.
⚠️ **A TOOL TIMEOUT DOES NOT CANCEL THE COMMAND.** `start_process` returning
"Device did not respond within 60s" means the process is STILL RUNNING. After any
timeout: `tasklist /fi "imagename eq node.exe"` first, then decide.
⚠️ **Restarting Desktop Commander kills its whole child process tree** and leaves
the live file MUTATED. If the bridge has been dropping, use a one-shot scheduler
task: `schtasks /create /tn <name> /tr "<bat>" /sc once /st <time> /f` then
`schtasks /run /tn <name>`; delete it afterwards.
⚠️ **`taskkill /F` on the runner kills the child stand too**, and its signal
handlers do NOT run. After stopping a run: `git status`, and if a live file is
dirty, `git diff` then `git checkout --` on exactly that file.
⚠️ **A hard-killed stand does NOT run `finally`** — check `git status` before AND
after every revision. The marker `.falsify-all.running` (package 55) survives a
kill precisely so this is visible.

### Around the shell (all of these have cost real time)

⚠️ **Background launch that does not hit the 60-second bridge cap:**
`start /B cmd /c <file>.cmd`. ⚠️ The form `start "" /b cmd /c …` DOES NOT WORK
inside `cmd /c "…"` (nested quotes). **Give every poll a green baseline: if the
marker file does not exist AND the output files do not exist either, the job
never started.**
⚠️ **Pause between polls: `ping -n 50 127.0.0.1 >nul`** — it stays inside the
bridge window (~55 s), unlike `timeout /t`. Two `ping`s in one command already
give "Device did not respond within 60s".
⚠️ **PowerShell `>` writes UTF-16, and `node -e` with Cyrillic output falls
apart** — a report you need to READ must be written by node itself
(`writeFileSync(…, "utf8")`) and read with `read_file`.
⚠️ **`node -e` and nested quotes inside `cmd /c "…"` break** — a script is ALWAYS
a file. Same for `findstr`, which also does not see Cyrillic; `start_search`
handles Cyrillic reliably.
⚠️ **`git commit -m` with Cyrillic and brackets breaks** — the message goes in a
file (`-F .commitmsg`, which is in `.gitignore`). `echo` does not write UTF-8:
create the message file with `write_file`. ⚠️ `-m` and `-F` cannot be combined.
⚠️ **`git merge --ff-only` fails** when `main` has merge commits — use `--no-ff -F`.
⚠️ **`%ERRORLEVEL%` inside a chain joined by `&` expands BEFORE the run** — check
through `&&` / `||`.
⚠️ **`head` and `tail` do not exist in this shell.** The tail of a file is
`read_file` with a negative `offset`.
⚠️ **Node output redirected to a file is block-buffered (~4 KB)** — track progress
by `git status`, not by the tail of the log.
⚠️ **Test output can exceed the token limit** — write to a log file and read the
tail; do not drag it into context.
⚠️ **A large `read_file` result is delivered in PARTS by the bridge** — when
joining parts, put a `\n` between them or bytes are lost at the seams.
`project_write` with `local_path` only takes files from the container's working
directory, and the call can hit a 30-second timeout and STILL have written —
verify with `project_read` before writing again.
⚠️ **The full gate on this machine takes 3–6 minutes**; on a clean clone in the
cloud ~2 min. A 37-mutation stand is ~3 minutes.
⚠️ **`supabase-js` captures `fetch` when the client is created.**
⚠️ **MCP tools are fixed at session START.**
⚠️ **A block comment cannot contain `*/`** — any "star + slash" inside a path
closes it, and the file fails BELOW the edit. And `{/* … */}` must not come
straight after `{cond && (`.

### Around SQL

⚠️ **`min()` is not defined for `uuid` in Postgres** — use
`(array_agg(x order by x))[1]`.
⚠️ **A `select count(*)` over a table written in the SAME statement sees the
snapshot from before the write.** A probe that counts its own side effects must
do the count in a SEPARATE statement, or it reports zero and looks green.
⚠️ **A `DO` block cannot roll itself back.** To measure something and leave no
trace, end the block with `raise exception` carrying the verdict in its message —
the whole statement rolls back and the numbers still reach you.
⚠️ **`set_config(name, NULL, true)` does not restore "unset"** for a custom GUC —
it resets to the reset value, which for a placeholder GUC is the empty string.

## READ FIRST (in this order)

1. **`AGENTS.md`** — the stable rules. "Конвенції коду" holds the time canon; the
   0122 trap is in the migrations section.
2. **`claude/radflow-handoff.md`** — the durable state, FRESHEST first. It opens
   with «СОСТОЯНИЕ НА КОНЕЦ с64»; below it, one block per session in reverse
   order.
3. **`claude/plan-s57.md`** — the live queue and the five forks with their
   measurements.
4. **`docs/HANDOVER.md`** — the operational handover (access, environments,
   runbooks). ⚠️ Historically it lied in places; §6 "why it is like this" is the
   valuable part. Check its own date line.
5. **`docs/PRODUCT_OVERVIEW.md`** — the product and the schema evolution. ⚠️ The
   paragraph marked ⛔ near the top is HISTORY (2026-07-18), not current state.
6. **`docs/audit/RADFLOW_DEEP_TECHNICAL_FUNCTIONAL_AUDIT_2026-08-27.md`** — the
   audit journal. **The verdict is not issued** and cannot go above CONDITIONAL
   GO until the key rotation.
7. **`docs/audit/RF-07-2026-09-12-advisor-measure.md`** and
   **`docs/audit/PERF-2026-09-12-pg-timezone-names.md`** — session 63's two
   measurement docs.
8. **`docs/ops-cron.md`** — the registry of the nightly jobs.

⚠️ **And do not lean on THIS file either.** Verify the hashes (`git ls-remote`)
and the PREMISES of the tasks (`select now()`).

## RULES THAT CANNOT BE BROKEN

- **You apply the migrations** (Supabase MCP `execute_sql`), with mandatory
  verification of the Results.
- The number comes from `select max(name) from public.migration_ledger`, **NEVER
  from the folder**.
- File + smoke + a `=== ВІДКАТ ===` section at the END + dry-run + a predecessor
  guard (`do $ledger$`) + two independent reviews.
- **Dry-run:** the body inside `do $$…$$` with NO inner commit; verify the fact of
  the rollback with a SEPARATE query. ⚠️ A "dry" run WITHOUT a rollback marker is
  an apply.
- **Smoke asserts only with `is distinct from`**; "RLS silently ate it" is only
  caught through `get diagnostics row_count`. A smoke checks the DELTA. ⚠️ A smoke
  against live production takes an AccessExclusiveLock — `set local lock_timeout`
  is mandatory on grants and policies.
- **A new invariant goes into `invariants_check()`**, not only into its own
  smoke. Edits to a migration file go in BEFORE `npm run db:gate`; never edit an
  already-applied migration — the gate stamps the md5 of the FILE.
- ⚠️ **The gate is SYMMETRIC.** A ledger row with no file on disk fails it just as
  loudly as a file with no ledger row (`migration-gate-lib.mjs:82-88`). That is
  why an unmerged branch carrying applied migrations blocks the production build.
- ⚠️ **After `drop`+`create`:** `revoke execute … from anon, public` + an EXPLICIT
  `grant … to <roles>` + **an ACL assertion in the SAME transaction** (the 0122
  trap). In the ROLLBACK section keep `delete from migration_ledger` commented at
  a SECOND level.
- ⚠️ **A migration that reprints `invariants_check` MUST be followed by a FULL
  revision** — it silently breaks every stand pinned to the reprint. And the
  standing price of a reprint that moves `checked`: nine smokes and two md5 pins
  (`node scripts/bump-checked-pins.mjs <old> <new>`).
- ⚠️ **A migration that adds a column, a constraint, an enum label or a partial
  unique index MUST update the key in `expd` of check №23** — a red
  `schema_digest` after your DDL is a forgotten ritual step, not a guard bug.
  Instrument: `node scripts/print-schema-digest.mjs`.
- **A comment in the code is not a source of truth about the server.** Read the
  function from the live DB (`pg_get_functiondef`) — and read it WHOLE.
  ⚠️ `pg_get_functiondef` renders the header differently from the file: compare
  only the body between `as $function$` and `$function$;`.
- **`security_invoker=true` on a VIEW is a LOCK. dev and prod are ONE DB.**
- **ONLY ONE PERSON RUNS THE GATE** (`.next` is shared).
- **Nested modals:** silence the parent `useModalA11y` with `active`.
- **Time:** any new comparison against a server moment, or any new display of
  time, uses `serverNow()`, not `Date.now()`. Any new frozen date derived from
  "today" goes through `lib/useFollowToday.ts` — never a private copy.

## TEST RULES

- **There are NO component tests, by design:** `vitest.config.ts` uses
  `environment: "node"` and TZ is pinned to `Europe/Kyiv` (deliberately NOT UTC —
  half of this project's time bugs are about a day shift and do not reproduce in
  UTC). Introducing a DOM test is fork Р4, not a detail.
- **Routes are tested BEHAVIOURALLY** (`tests/fixtures/fakeSupabase.ts`). **The
  double must stay hostile:** it throws on any unimplemented filter.
- **A regex over source code is NOT a guard.** Check by CALLING. A static pin is
  legitimate only where no behavioural instrument exists in principle — and then
  it must be NAMED as a boundary. ⚠️ Strip comments before matching, or the pin
  can be satisfied by a comment.
- ⚠️ **A regex without an anchor to the PLACE is not a guard.** If a substring can
  occur more than once in the file, the pin already lies.
- ⚠️ **A pin behind a counter we ourselves move is not a pin.** Write stand
  expectations WITHOUT numbers.
- **A fixture must DISTINGUISH two implementations**, otherwise the check is
  empty. **A tautological test looks like a guard** — mentally revert the fix and
  name what goes red.
- ⚠️ **A test that cannot tell it checked nothing is worse than no test.** Build
  the non-vacuity assertion INTO the test: name the condition the tested code
  needs, count how often it held, and raise when the count is zero.
- **A guard that searches for a NAME catches the import line.** Guard the CALL.
- **Two tests with the SAME name** destroy the requirement "name the one that
  went red".
- **Read falsification through the JSON reporter**, not the text.
- **A comment next to a guard describes what the guard DOES**, not what it was put
  there for.
- ⚠️ **`npm run lint` runs with `--max-warnings 0`** — any warning is red.
- **A new guard without a named red test and a green baseline is not done** — and
  that must be verified in the SAME commit, not in the revision.
- ⚠️ **The scaffolding marker is `/* 0174 */`, not your migration's number.** It
  names the CONVENTION; `tests/invariantsFailLoud.test.ts` counts lines by it.

## TOOLS (ready to use)

```
scripts\full-check.bat                  # the full gate in one background run
node scripts/falsify-all.mjs            # revision of ALL 37 stands (40-45 min, NOT a gate)
node scripts/falsify-all.mjs u70 u72    # only the named ones
node scripts/falsify-all.mjs --allow-dirty
node scripts/falsify-<stand>.mjs        # one stand (the list is in falsify-all.mjs)
node scripts/bump-checked-pins.mjs <old> <new>   # nine smokes + prose, after a reprint
node scripts/print-schema-digest.mjs [table]     # check No.23 keys
node scripts/secret-scan.mjs [--selftest]
node scripts/integration-admin.mjs list --clinic <uuid>
node scripts/race-check.mjs plan | run --run --n 4
node scripts/race-check.mjs stop --with-case --room2 <uuid>
npm run db:gate        # stamps md5      npm run db:gate:check   # verifies only
npm run build          # deploy gate + next build
select public.invariants_check(false);
```

`falsify-all` exits 1 if any stand is red, and **2** if the revision never
started (dirty tree without `--allow-dirty`, broken `git diff`). Inside it:
`EXPECTED_STANDS = 37`, a 45-min timeout per stand, tree comparison BY CONTENT
after every stand, a text parse of each stand's verdict as a backup channel, and
a floor on the number of addressed mutations — a stand that ran zero, or whose
summary is unrecognised, is RED.

⚠️ The race harness takes its user JWT through the child process env ONLY. **The
token is never printed, never logged, never pasted into the conversation.** It
lives about an hour.

⚠️ A live check must NOT be run from the container (the domain is not in the
allowlist) — use the owner's machine or Claude in Chrome.

## ORDER OF WORK

1. Read `claude/radflow-handoff.md` — the freshest state.
2. Verify it: `git ls-remote origin refs/heads/main refs/heads/dev` (⚠️ `git
   fetch` does NOT update remote-tracking), `git status`, the DB through
   `execute_sql`, `select now()`. **Do not trust the docs.**
3. Agree the direction with the owner, compose the task list (`TaskCreate`).
4. Work directly in `D:\RadFlowDev` — **one package at a time**, with the
   toolchain and two reviews between them.
   ⚠️ **Reviews go over ALREADY WRITTEN code, and your own fresh guard is as much
   a suspect as someone else's old one.** The lens of the second round is always
   "which mutation would leave this pin green", never "does it catch what I built
   it for".
5. **You commit, merge and deploy yourself.** After the deploy — a live check on
   production. Write the PR text anyway; it stays in `docs/audit/`.
   ⚠️ **Order around a revision:** gate → commit → `falsify-all` (it refuses to
   start on a dirty tree) → merge → push → deploy → measure the deploy stamp in
   BOTH directions.
6. At the end of the session update `claude/radflow-handoff.md`,
   `docs/PRODUCT_OVERVIEW.md`, `docs/HANDOVER.md`, `AGENTS.md` (if a new
   invariant appeared), `docs/ops-cron.md` (if the number of checks moved), this
   file and `claude/session<N+1>-start-prompt.md` — and the copies in Claude
   Projects.

---

## THE ONE THING TO CARRY FORWARD

Across sessions 50–63 the same mistake repeats in different costumes: **a
statement made after reading PART of the picture.** Eight times in session 50, a
scanner list falsified four times in session 55, a doc's list found stale for the
eighth time in session 57 — and in session 63 a performance number measured
honestly on the wrong branch. The mechanism never changes: a plausible claim,
verified in part, written down as fact.

Three habits that actually catch it, all cheap:

1. **Give every search a GREEN BASELINE.** "Found nothing" proves nothing until a
   line you know exists comes back by THAT SAME query.
2. **Count the load-bearing facts BY NAME and ask how many have a guard.**
   "Covered by pins" without a denominator is not a measurement.
3. **Before recording a number, name the CONDITION under which the measured code
   runs, and check that the condition held.** A measurement of the wrong branch
   looks exactly like a measurement of the right one.
