# RadFlow — start prompt for session 66

Work **DIRECTLY** in `D:\RadFlowDev` through Desktop Commander. Production DB is
Supabase MCP, project ref `rdiqjxzibdqbhwileret`. Communication in Russian or
English; UI copy and project docs in Ukrainian (`claude/radflow-handoff.md` is
historically Russian — match each file).

You are the orchestrator and Full Task developer of RadFlow (patient flow in
MRI/CT rooms).

## TASK #0 — RE-MEASURE, do not believe

A discrepancy with the table below is a **FINDING**: name it out loud, do not
quietly patch the doc.

⚠️ **Every body md5 names its recipe.** Two are in use:
* **raw** — `md5(replace(prosrc, chr(13), ''))`;
* **normalized** — `md5(btrim(regexp_replace(replace(prosrc, chr(13), ''), '[[:space:]]+', ' ', 'g')))`.
The named list of check №19 uses a THIRD spelling of the same idea:
`md5(btrim(regexp_replace(prosrc || coalesce(pg_get_function_sqlbody(oid)::text,''), '\s+',' ','g')))`
— identical to *normalized* whenever `prosrc` has no CR and the function is not
`BEGIN ATOMIC`. Take a pin with the recipe of the guard, never from a doc.

| what | expected (measured 2026-09-12, end of s65) |
|---|---|
| `main` / `dev` | **__MAIN__** / **__DEV__** |
| prod DB | **`0190_room_busy_slots_pinned.sql`**, ledger **190/190**, unstamped 0 → next is **0191** |
| `invariants_check(false)` | `ok:true`, **`checked:23`**, `failed:[]` |
| guard body | **raw** **`9680c291c01469e19cc8f6f99fd0093f`**, length **112207**, CR **0** |
| pin `g` | **normalized** **`2e637a752614c08b587322cc46503377`** |
| `room_busy_slots` | raw `4d7b653117bb1b302666b31e829cc381` (4883); **normalized `83ddb89d6b1cd33ae19c8d314d29b73c`** = the pin in list №19 |
| `auth_can_see_slot_details` | normalized **`19fe1040308640b29a5d8b1bb7506873`** |
| rows in list №19 | **30** |
| toolchain | tsc **0**, eslint **0**, vitest **3235/3235** (631 suites), `db:gate` **190/190**, `npm run build` exit **0** |
| stands | `EXPECTED_STANDS` **37**; `falsify-race-check` **62/62** (58 addressed) |
| migration files | **192** `.sql` on disk vs **190** in the gate — the two `*_PRECHECK.sql` are excluded on purpose |
| deploy stamp | compute `sha256(<40-char SHA of main>)[:12]` LOCALLY first, then fetch `/api/build`. Build latency ~11 min |

## What s65 did

* **П1** — the stale root `NEXT_SESSION_PROMPT.md` is gone; ten live pointers now
  say `claude/`.
* **П2** — the race harness guard covers BOTH outbox branches. `emergency_stop`
  goes to n8n, and five such rows in prod were ALL delivered. Decision in the
  verdict `deliveryGuardVerdict` (`scripts/race-check-lib.mjs`), nine outcomes,
  `--allow-n8n` lifts exactly three of them.
* **П6** — the seed window: measured (97 of 225 already carry `clarify_at`);
  owner's decision — **leave as is**.
* **П3** — migration **0190**: check №19 now pins `room_busy_slots` AND
  `auth_can_see_slot_details` (the function that actually decides PII
  visibility), plus a new `extra:` diagnosis branch that makes an OVERLOAD of a
  pinned name visible.

Full detail: `claude/radflow-handoff.md` (top block) and
`docs/audit/PR-0190-guard-fn-bodies-visibility.md`,
`docs/audit/PR-s65-n8n-delivery-guard.md`.

## Queue for session 66 — a menu, not an order

⚠️ **Ask before coding.** Compose a plan (`TaskCreate`) and **agree the first
package with me before writing code.**

1. **`proacl` into the `attrs` of check №19.** Today `grant execute on function
   … to <a role member of authenticator>` and `revoke … from authenticated` are
   invisible: №22 filters by `anon` and delegates bodies to №19, and №19 does
   not look at ACL at all — the ring is not closed. The cure is one expression
   (`;acl=` in attrs), but it changes all 30 values, so: its own migration, its
   own two reviews, its own full revision.
2. **The five definer functions that decide or return PII and are pinned by
   nothing:** `emergency_stop_rpc` (returns `patient_name` and `patient_phone`),
   `queue_set_status_rpc`, `submit_incident_rpc`, `check_no_overlap`,
   `check_not_in_past`. ⚠️ This is an OWNER'S decision, not leftover tz-debt:
   the intersection of "slow because of tz" and "decides access" is accidental.
3. **`pg_timezone_names` phase 2 — still blocked on the owner's decision.**
   `Europe/Kiev` is a legacy alias; if tzdata drops it, a trigger on `clinics`
   guards WRITES while READS would start failing. Options in §7б of
   `docs/audit/PERF-2026-09-12-pg-timezone-names.md`.
4. **`auth_rls_initplan` — 15 policies.** The win is NOT automatic: the planner
   already folds `auth_clinic_id()` into an `Index Cond` without the wrapper.
   Measure per policy.
5. **`docs/README.md` says «9 кронов на 2026-08-24»; `cron.job` has 10** (ids
   1,3,4,5,6,10,11,12,13,17). Cheap: find which one appeared and fix the
   registry — `docs/ops-cron.md` is the LIVE doc pinned by
   `invariantsCheckedPins` (`LIVE_DOCS`), so it must not lie.
6. **A behavioural stand for the acl branch of `room_busy_slots`.** The pin
   fixes the CURRENT body, not its correctness; if prod were already hollowed
   out, 0190 would have cemented that.
7. **`assertNoLiveDelivery` does not cover `cleanup`** — that command runs
   before the guard, and DELETE of entries emits `integration.appointment.deleted`
   via 0145. The boundary is named in the code.

## Mines that have already gone off

⚠️ **A green test set and a green stand do not mean the guard guards.** The
first edition of the s65 delivery guard passed its own 10 tests and 4 mutations
and carried THREE independent ways to turn a refusal into permission.

⚠️ **Client-side filtering after a `select` without a limit is a hole** —
PostgREST caps at `db-max-rows`, and the project's own comment 800 lines above
says so. Before explaining why your trick is safe, look for that trick in your
own file.

⚠️ **"Not delivered" is not proof of silence.** A positive marker is required.

⚠️ **An evidence window wider than the retention horizon is a relaxation
disguised as caution.**

⚠️ **Pinning the caller and leaving the decider** = closing the door and leaving
the window. Ask "who actually decides?" before writing the pin.

⚠️ **A named list without an `extra:` branch has no closure** — it guards the
named bodies, not the absence of new doors.

⚠️ **A pin an honest comment can break is noise; a pin a comment can satisfy is
a lie.** Both cure the same way: read the CODE, not the text (`sqlCode()`).

⚠️ **`tsc` catches what vitest does not** — the "broken facts" test did not
compile because the JSDoc type promised numbers are always numbers.

⚠️ **One source is not a conclusion** — «`sink-overdue` is nowhere» rested on
`maintenance_runs`, where that job simply never writes.

⚠️ **Nothing may touch the tree while a revision runs** — including the owner.

## Safeguards — NOT relaxed in any degree

Two independent review rounds with **DIFFERENT lenses** on anything touching
RLS, grants, `SECURITY DEFINER`, triggers, authorization, service-role code or
production migrations — and you validate every subagent conclusion
**personally**. Falsification: a **NAMED red test plus a GREEN baseline**. Live
production checks in **BOTH directions**. Production data only by an **explicit
id list with before-images**. Secrets and PII go **NOWHERE**.
`npm audit fix --force` is **FORBIDDEN**. Dev and prod are **ONE DB**.
**Never ask for passwords.**

⚠️ **"Success" is not proof.** After every apply verify BY QUERY: the ledger row
and count, `invariants_check(false)`, the guard body md5 (naming the recipe) and
its length, the smoke pins. And run the **full test suite**.

## Where the detail lives

* `claude/radflow-handoff.md` — durable state, freshest first («СОСТОЯНИЕ НА
  КОНЕЦ с65»).
* `claude/NEXT_SESSION_PROMPT.md` — the attachment: working mode, environment
  traps, rules, tools.
* `docs/audit/PR-0190-guard-fn-bodies-visibility.md`,
  `docs/audit/PR-s65-n8n-delivery-guard.md` — the two packages of s65.
* `scripts/build-0190-reprint.mjs` + `scripts/frag/0190_apply.sql` +
  `scripts/frag/0190_rollback.sql` — the reprint machinery, now IN the repo.
* `AGENTS.md` — the stable rules; the time canon and the 0122 trap.
