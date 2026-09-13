# RadFlow — start prompt for session 67

Work **DIRECTLY** in `D:\RadFlowDev` through Desktop Commander. Production DB is
Supabase MCP, project ref `rdiqjxzibdqbhwileret`. Communication in Russian or
English; UI copy and project docs in Ukrainian (`claude/radflow-handoff.md` is
historically Russian — match each file).

You are the orchestrator and Full Task developer of RadFlow (patient flow in
MRI/CT rooms).

## ⚠️ THERE IS AN UNFINISHED PACKAGE ON A BRANCH — READ THIS FIRST

Branch **`s66/0191-fn-bodies-acl`** carries migration **0191**, fully built,
**dry-run GREEN on production**, and **NOT APPLIED**. `dev` and `main` do not
contain it, and that is deliberate: the gate is symmetric, so a migration file
with no ledger row gives «ЗУПИНЕНО — розходження диск ↔ леджер (1)» and the
production build goes red. **Measured, not assumed.**

Finishing it is the obvious first package. The order is NOT negotiable:

1. `git checkout s66/0191-fn-bodies-acl`
2. **Full revision of all 37 stands on a CLEAN tree** — it needs no database and
   must run BEFORE the point of no return (canon 0190). ⚠️ `db:gate` is RED on
   this branch until the apply; that is expected and the stands do not depend
   on it. ~50 min; touch nothing while it runs.
3. Re-run the dry run `scripts/frag/0191_dryrun.sql` — production may have moved.
4. Apply `scripts/frag/0191_apply.sql`.
5. Verify BY SEPARATE QUERIES: body `08014663728435627d2e993fa5ffbc77` / 116213,
   ledger 191, `invariants_check` ok / checked 23, list = 33 rows.
6. `npm run db:gate` (otherwise the ledger row stays without an md5), `npm test`.
7. merge → push → deploy → stamp in BOTH directions.
8. Rollback if needed: `scripts/frag/0191_rollback.sql` (generated, with the same
   asserts) + delete the migration file + re-run `db:gate` + drop the three
   signatures from `PINNED`.

Detail: `docs/audit/PR-s66-0191-fn-bodies-acl.md`.

## TASK #0 — RE-MEASURE, do not believe

A discrepancy with the table below is a **FINDING**: name it out loud, do not
quietly patch the doc.

| what | expected (measured 2026-09-13, end of s66) |
|---|---|
| `main` / `dev` | take BOTH from `git ls-remote`; plus the live branch `s66/0191-fn-bodies-acl` |
| prod DB | **`0190_room_busy_slots_pinned.sql`**, ledger **190/190** → next is **0191** (built, not applied) |
| `invariants_check(false)` | `ok:true`, **`checked:23`**, `failed:[]` |
| guard body | raw **`9680c291c01469e19cc8f6f99fd0093f`**, length **112207**, CR **0** |
| list №19 | **30** signatures (33 after 0191) |
| toolchain on `dev` | tsc 0, eslint 0, vitest **3235/3235** (631 suites), `db:gate` **190/190**, build exit 0 |
| deploy stamp | compute `sha256(<40-char SHA of main>)[:12]` LOCALLY first, then fetch `/api/build`. Latency ~11 min |

## What s66 did

* **П1 (in `main`)** — the smoke `supabase/smoke/room_busy_slots_scope_smoke.sql`
  stopped being vacuous in four places. It ran GREEN for sessions while printing
  `e-out(hidden=0)`: the out-of-grant room was picked by `limit 1` with no
  ordering and happened to be EMPTY. Now: busiest out-of-grant room-day with the
  anti-vacuum as an ASSERT (`сховано=6`), every non-(admin,radiologist) role
  instead of one, a new `f2` branch (service_role **with** `sub` — the only thing
  that falsifies the режим-A factor), and a new `l` branch exercising `p_exclude`
  in three directions.
* **П2 (on the branch)** — 0191, above.
* **Two docs that lied were fixed**, one of them written by s66 itself.

## ⚠️ Two mistakes of s66, both the same shape

1. «There is no behavioural stand for the acl branch» — FALSE. The smoke existed.
   Came from searching `scripts/falsify-*.mjs` and not `supabase/smoke/`.
2. «Both referrer-branch deciders are pinned by nothing, they could be rewritten
   at 23 green checks» — FALSE. Check **№22 `grant_digest`** holds their bodies
   (it filters definer functions by `anon` reachability; all three have a PUBLIC
   grant, and it pins the FULL raw md5). Came from reading list №19 and not the
   neighbouring check in the same file.

**One source is not a conclusion.** Both were found by the reviews, not by the
author, and both were already written down before being checked.

## ⚠️ A real, measured finding that is still OPEN

```
alter function public.auth_can_refer(uuid) set search_path = pg_temp, public
→ NONE of the 23 checks goes red
```
For a SECURITY DEFINER function this is a textbook escalation vector. №2 requires
only the PRESENCE of the substring `search_path`, №22 does not read `proconfig`
at all, and the VALUE is guarded by `cfg=` in the `attrs` of list №19 — which
these functions were outside of. 0191 closes it for three of them. **Every other
definer function outside list №19 is still open**, and that is an owner-sized
question, not a detail.

## Queue for session 67 — a menu, not an order

⚠️ **Ask before coding.** Compose a plan (`TaskCreate`) and **agree the first
package with me before writing code.**

1. **Finish 0191** (above) — revision, apply, merge, deploy.
2. **`search_path` value for definer functions outside list №19.** The measured
   hole above. Options: widen №2 to pin the VALUE for all definer functions
   (cheap, no reprint of №19), or extend the named list (a reprint each time).
3. **The report path of №19 is not pinned by any test** — `) x;` → exception
   handler → `if v_tmp is not null`. A mutation `where x.txt not like 'attrs:%'`
   deletes the whole gain of 0191 and leaves `guardFnBodiesInvariant` green.
4. **`auth_rls_initplan` — 15 policies.** The win is NOT automatic.
5. **`docs/README.md` says «9 кронов»; `cron.job` has 10** (ids 1,3,4,5,6,10,11,
   12,13,17). Cheap; `docs/ops-cron.md` is a LIVE doc pinned by
   `invariantsCheckedPins`, so it must not lie.
6. **`assertNoLiveDelivery` does not cover `cleanup`** — that command runs before
   the guard, and DELETE of entries emits `integration.appointment.deleted`.
7. **Five definer functions that decide or return PII and are pinned by nothing:**
   `emergency_stop_rpc`, `queue_set_status_rpc`, `submit_incident_rpc`,
   `check_no_overlap`, `check_not_in_past`. Owner's decision.
8. **`pg_timezone_names` phase 2** — still blocked on the owner's decision.

## Safeguards — NOT relaxed in any degree

Two independent review rounds with **DIFFERENT lenses** on anything touching
RLS, grants, `SECURITY DEFINER`, triggers, authorization, service-role code or
production migrations — and you validate every subagent conclusion
**personally**. ⚠️ s66 is the case for that last word twice over: both reviews
were right and the author was wrong, and both times the proof was a MEASUREMENT
(a probe in a rolled-back transaction), not an argument.
Falsification: a **NAMED red test plus a GREEN baseline**. Live production
checks in **BOTH directions**. Production data only by an **explicit id list
with before-images**. Secrets and PII go **NOWHERE**.
`npm audit fix --force` is **FORBIDDEN**. Dev and prod are **ONE DB**.
**Never ask for passwords.**

⚠️ **"Success" is not proof.** After every apply verify BY QUERY: the ledger row
and count, `invariants_check(false)`, the guard body md5 (naming the recipe) and
its length, the smoke pins. And run the **full test suite**.

⚠️ **A rollback verified inside the same transaction proves nothing** — take the
md5 again with a SEPARATE query.

## Where the detail lives

* `claude/radflow-handoff.md` — durable state, freshest first («СОСТОЯНИЕ НА
  КОНЕЦ с66»).
* `claude/NEXT_SESSION_PROMPT.md` — the attachment: working mode, environment
  traps, rules, tools.
* `docs/audit/PR-s66-rbs-scope-smoke.md` — package 1.
* `docs/audit/PR-s66-0191-fn-bodies-acl.md` — package 2, with the exact order
  for finishing it.
* `docs/audit/PR-0190-guard-fn-bodies-visibility.md` — ⚠️ its boundary №4 was
  corrected in s66; §4б carries the measured `search_path` finding.
* `AGENTS.md` — the stable rules; the time canon and the 0122 trap.
