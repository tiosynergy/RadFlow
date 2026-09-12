# RadFlow — start prompt for session 65

Work **DIRECTLY** in `D:\RadFlowDev` through Desktop Commander. Production DB is
Supabase MCP, project ref `rdiqjxzibdqbhwileret`. Communication in Russian or
English; UI copy and project docs in Ukrainian (`claude/radflow-handoff.md` is
historically Russian — match each file).

You are the orchestrator and Full Task developer of RadFlow (patient flow in
MRI/CT rooms).

## ✅ The s63 blocker is CLOSED — do not redo it, verify it

Session 64 merged `dev` → `main` (24 commits, `--no-ff`, ort, no conflicts,
44 files), pushed and deployed. Order kept: gate → clean tree → **full revision
37/37 green** → merge → `db:gate:check` 189/189 + `npm run build` exit 0 → push
→ deploy → stamp in both directions → live write check on the new build.

So `main` no longer stops at 0185, and the four applied migrations 0186–0189
have their files on `main`. Keep it that way: **the gate is symmetric**, a ledger
row with no file on disk fails the production build exactly as loudly as a file
with no ledger row.

## TASK #0 — RE-MEASURE, do not believe

A discrepancy with the table below is a **FINDING**: name it out loud, do not
quietly patch the doc.

⚠️ **Every body md5 here NAMES ITS RECIPE.** Two recipes are in use, and in s63
they sat side by side unlabelled:
* **raw** — `md5(replace(prosrc, chr(13), ''))`;
* **normalized** — `md5(btrim(regexp_replace(replace(prosrc, chr(13), ''), '[[:space:]]+', ' ', 'g')))`.

| what | expected (measured 2026-09-12, after the merge) |
|---|---|
| `main` / `dev` | **`7dfdaf2`** / **`76db233`** + the s64 docs commits on top — ⚠️ expect `dev` to DIFFER; take the hashes from `git ls-remote`, not `git fetch`. That difference is not a finding |
| branches | ⚠️ `dev..main` ~21 (merge commits of `main`'s own history) → `--ff-only` will NOT work; merge with `--no-ff -F .commitmsg` |
| prod DB | **`0189_room_busy_slots_tz_once.sql`**, ledger **189/189**, unstamped 0 → next is **0190**, the number comes FROM THE LEDGER |
| `invariants_check(false)` | `ok:true`, **`checked:23`**, `failed:[]` |
| guard body | **raw** **`95b0b4d2ba635e85c335ff7615c3b0a3`**, length **111 592**, CR **0** |
| pin `g` | **normalized** guard body **`53440c9a5df574c64fe45824a4327c9f`** |
| `room_busy_slots` | **raw** **`4d7b653117bb1b302666b31e829cc381`** (4883 chars); **normalized** **`83ddb89d6b1cd33ae19c8d314d29b73c`** — check №19 needs the normalized one |
| toolchain | tsc **0**, eslint **0**, vitest **3213/3213** (630 suites), `db:gate` **189/189**, `npm run build` exit **0** |
| stands | `EXPECTED_STANDS` **37**, all green, ~50 min |
| migration files | **191** `.sql` on disk vs **189** in the gate — NOT a hole: the two `*_PRECHECK.sql` are excluded on purpose, and the gate's own code says so |
| deploy stamp | **`887f3738c8ee`** for `main = 7dfdaf2` — compute `sha256(<40-char SHA>)[:12]` LOCALLY first, then fetch `/api/build`. Build latency measured ~**11 min**, not "4–9" |

## Queue for session 65 — a menu, not an order

⚠️ **Ask before coding.** Compose a plan (`TaskCreate`) and **AGREE THE FIRST
PACKAGE WITH ME BEFORE WRITING CODE.** If a package is product-facing, show me
the texts before they land.

1. **Remove the stale root `NEXT_SESSION_PROMPT.md`** (needs the owner's OK).
   Two tracked copies exist: the root one (1016 lines, last touched by
   `6bfa74d`, the s60 docs — two editions stale) and `claude/NEXT_SESSION_PROMPT.md`
   (canon since s63). `docs/AGENT_ONBOARDING.md` still calls the root one
   canonical. In s64 this duplicate cost an hour: the owner saved into it while
   the revision was running, the tree check read that as an unrestored mutation,
   and the revision's own `git checkout --` discarded the edit. Cheap package:
   `git rm` + fix the pointer in `AGENT_ONBOARDING.md`.
2. **`assertNoLiveWebhook` does not cover the n8n branch.** The guard only looks
   at `integration_webhooks`, but `emergency_stop` travels via
   `N8N_WEBHOOK_URL`/`N8N_WEBHOOK_SECRET`. **Four such rows were actually
   delivered externally** during harness runs. The payloads carried fixtures
   only, but `lib/outbox.ts` states plainly that these payloads carry patient
   names and phones. Widen the guard; clean the harness's own `event_outbox`
   rows by an explicit id list with before-images.
3. **Pin `room_busy_slots` in check №19's named list** (`guard_fn_bodies`). It is
   SECURITY DEFINER and it decides who sees patient names, status and studies —
   and it is absent from the list, along with the other five tz functions.
   ⚠️ The `expd` value is the **normalized** md5 **`83ddb89d6b1cd33ae19c8d314d29b73c`**,
   NOT the raw `4d7b6531…`; taking the wrong recipe gives a pin that is red from
   birth. Touches `invariants_check` → reprint → full revision → two review rounds.
4. **`pg_timezone_names` phase 2 — needs the owner's decision first.** Five
   functions remain, two of them ROW triggers on `queue_entries`. Blocked on one
   question: `Europe/Kiev` is a legacy alias; if tzdata drops it, a trigger on
   `clinics` does not save us — it guards WRITES, while READS would start failing
   with `invalid value for parameter "TimeZone"`. Options in §7б of
   `docs/audit/PERF-2026-09-12-pg-timezone-names.md`.
5. **`auth_rls_initplan` — 15 policies.** The win is **not automatic**: the
   planner already folds `auth_clinic_id()` into an `Index Cond` without the
   wrapper. Measure per policy; do not trust the advisor's wording.
6. **Where does the `sink-overdue` cron actually live?** `maintenance_runs` has
   only ever carried three jobs (`invariants` 75, `audit-retention` 20,
   `outbox-retention` 19) — `sink-overdue` appears **zero** times. The «seed
   window» item rests on that cron stamping `clarify_at`: check the premise
   before acting on it.

## Closed — do not reopen

* **The merge / deploy / live write check** — done in s64, measured in both
  directions.
* **RF-05** — the schema-contract manifest is complete.
* **RF-08** — leaked-password protection is on.
* **RF-07** — deferral accepted in writing; s63 measured it to the end
  (`docs/audit/RF-07-2026-09-12-advisor-measure.md`).
* **Service-role key rotation** — the owner's decision, tied to the first real
  centre.

## Mines that have already gone off

⚠️ **`fn_audit` does NOT raise.** The claim "0187 made it loud, so it raises and
can fail a write" was in four docs and is **false**: it raises a `warning`, the
mode stays fail-open, and the function's own comment says «ПОВЕДІНКА НЕ
МІНЯЄТЬСЯ НІ НА БІТ». Measured: 76 audit rows across three tables since 0187,
no lost write. Corrected in the docs — do not let it grow back.

⚠️ **Two md5 recipes, one label.** See TASK #0. A raw md5 where a normalized one
is needed produces a guard that was never green.

⚠️ **Nothing may touch the tree while a revision runs** — including the owner
saving a doc. A stand snapshots the live files and the revision compares the
tree BY CONTENT between stands; a human edit is indistinguishable from an
unrestored mutation, and the automatic `git checkout --` will discard it.

⚠️ **`findstr /r "…$"` matches nothing on CRLF files** — the `$` anchor is dead,
so "zero matches" proves nothing. Give every search a GREEN BASELINE.

⚠️ **Measuring the wrong branch looks exactly like measuring the right one.**
Before writing a number down, name the CONDITION under which the measured code
runs, and check that it holds.

⚠️ **A before/after comparison on production can be VACUOUS and look green.**
Build the non-vacuity assertion INTO the guard.

⚠️ **`<>` against a possibly-NULL value is fail-open** — use `is distinct from`.

⚠️ **A pin behind a counter we ourselves move is not a pin.** Write stand
expectations WITHOUT numbers.

⚠️ **The scaffolding marker is `/* 0174 */`**, not your migration's number.

⚠️ **A "dry" run WITHOUT a rollback marker is an apply.**

⚠️ **Shift the clock BACKWARD, never +24 h** (token treated as expired → 429 →
401 → `/login`).

⚠️ **The clipboard is not a channel** — use a file (`D:\RadFlowDev-scratch\go.cmd`)
or console history.

## Safeguards — NOT relaxed in any degree

Two independent review rounds with **DIFFERENT lenses** on anything touching RLS,
grants, `SECURITY DEFINER`, triggers, authorization, service-role code or
production migrations — and you validate every subagent conclusion **personally**.
Falsification: a **NAMED red test plus a GREEN baseline**. Live production checks
in **BOTH directions**. Production data only by an **explicit id list with
before-images**. Secrets and PII go **NOWHERE**. `npm audit fix --force` is
**FORBIDDEN**. Dev and prod are **ONE DB**. **Never ask for passwords.**

⚠️ **"Success" is not proof.** After every apply, verify BY QUERY: the ledger row
and count, `invariants_check(false)`, the guard body md5 (naming the recipe) and
its length, the smoke pins. And run the **full test suite**.

## Where the detail lives

* `claude/radflow-handoff.md` — the durable state, freshest first. Opens with
  «СОСТОЯНИЕ НА КОНЕЦ с64».
* `claude/NEXT_SESSION_PROMPT.md` — the attachment: permanent working mode,
  environment traps, rules, tools. ⚠️ The copy in the repo ROOT is a stale s60
  edition — queue item 1.
* `docs/audit/RF-07-2026-09-12-advisor-measure.md`,
  `docs/audit/PERF-2026-09-12-pg-timezone-names.md`.
* `AGENTS.md` — the stable rules; the time canon and the 0122 trap.
