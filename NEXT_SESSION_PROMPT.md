# RadFlow — attachment for the next session (session 58)

> **This file is the ATTACHMENT.** The owner pastes
> `claude/session58-start-prompt.md` as the first message and attaches this
> file. Rewritten in English at the end of session 57 (2026-09-05); previous
> editions were Ukrainian and stacked history back to session 50 — that history
> now lives where it belongs, in `claude/radflow-handoff.md`.
>
> ⚠️ **DO NOT TRUST THIS FILE.** Everything below is what SHOULD come out, not
> the source of truth. In session 50 this file lied about its own state at
> session start. Verify by query and by command (TASK #0). **A discrepancy is a
> FINDING — name it, do not silently patch the doc.**

You are continuing development and production of the **RadFlow** SaaS (patient
flow in MRI/CT rooms). You are the orchestrator and Full Task developer.
**Communication in Russian. UI copy in Ukrainian. Project docs in Ukrainian**
(`claude/radflow-handoff.md` is historically Russian — match each file).
Work **DIRECTLY** in `D:\RadFlowDev` through Desktop Commander; the production
DB is Supabase MCP, project ref `rdiqjxzibdqbhwileret`.

---

## AUTHORITY IN THIS SESSION — EXPANDED

You may, on your own: edit code, tests, SQL and docs; create append-only
migrations and **apply them to production**; run safe production SQL; create and
remove synthetic production data; commit, push, **create and merge PRs**,
**deploy**; read production logs; do live browser checks.

The old rule "merge/push/apply is done by the owner" is **CANCELLED**. If you
find it in the docs as a live rule, fix it in place (`docs/HANDOVER.md` and the
old audits keep it as history — leave those alone).

### ⚠️ APPLYING SQL — the rule was refined in session 56 and is LIVE

The owner changed it twice in one session; the current edition is the last one:
**"apply automatically without me, but with MANDATORY verification of the
Results."**

So the apply is yours, and "Success" is not proof. After EVERY apply, verify by
measurement: the function body (`md5(replace(prosrc, chr(13), ''))` against the
md5 of the file's body — the SQL Editor brings CRLF), the ledger row (name,
`md5`, `applied_at`), `invariants_check(false)`, the smoke pins. In session 56
"Success. No rows returned" hid TWO discrepancies: a foreign md5 in the ledger
from an earlier edition of the file, and CRLF inside the body.

## SAFEGUARDS — NOT CANCELLED IN ANY DEGREE

- **Two independent review rounds with DIFFERENT lenses** on anything that
  touches RLS, grants, `SECURITY DEFINER`, triggers, authorization, service-role
  code, integration contracts, concurrency or production migrations. **You
  validate subagent conclusions personally.** Proven lens pairs: "what breaks
  for the next person" × "did the author overstate his own measurements";
  "operational risk and operator experience" × "falsification: where is the rule
  wrong and where would the guard stay green".
- **Falsifying a guard requires a NAMED red test and a GREEN baseline.**
  "Something somewhere went red" is not a verdict.
- **Live production check in BOTH directions, by measurement.** If there is
  nothing to check on, say so plainly instead of faking a check.
- **Production data only by an explicit list of ids** with before-images. **No
  mass deletions by a vague predicate.**
- **Secrets and PII go NOWHERE** — not into a report, not into a log, not into a
  subagent prompt.
- **`npm audit fix --force` is FORBIDDEN.** dev and prod are **ONE DB**.
- **Never ask for passwords.**

### When to ask the owner anyway

- the decision is **irreversible** and touches live patients;
- it is a **product** decision rather than an engineering one;
- you need credentials or access you do not have.

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

…plus the **deploy fingerprint** of `/login`.

### How to take the fingerprint (the method changed in session 56, confirmed in 57)

The prod URL is **`https://rad-flow-tau.vercel.app`** — it is written in
`AGENTS.md` and it also sits in `cron.job.command`. **Never ask the owner for
it again.**

The reliable channel is the **Next.js buildId in the RSC payload**. Measure it
from the browser **on the owner's machine** (Claude in Chrome), NOT with
`WebFetch` from the container — the container strips HTML comments:

```js
const r = await fetch("/login?cb=" + Date.now(), { cache: "no-store" });
const t = await r.text();
const b = (t.match(/\\"b\\":\\"([A-Za-z0-9_-]{15,30})\\"/) || [])[1];
```

⚠️ **BOTH browsers now carry a live RadFlow session** (measured 05.09): in the
owner's Chrome `/login` redirects to `/radiologist` (~20 000 bytes), in the
built-in browser to `/queue` (~96 900 bytes). The doc line "the built-in browser
is NOT authenticated in RadFlow", alive since session 43, is **no longer true** —
so live checks are feasible from either. The buildId is unaffected by any of
this, but **byte counts must not be compared between browsers.**
⚠️ **Claude in Chrome went unresponsive mid-session** (`CDP Runtime.evaluate
timed out`, four attempts across two tabs) while the built-in browser answered
immediately. Have both in mind; do not spend the session retrying one.
⚠️ A Vercel deploy takes ~2–3 min. For packages with no client code there is no
"the new bundle arrived" signal in principle — say so instead of inventing one.

### Expected state (measured 2026-09-05, end of session 57)

| what | expected |
|---|---|
| `main` / `dev` | **`81a7b46`** / **`608df9a`** (the session-57 docs, on top of `3c96898` / `2fd730f` and of `1dee210` / `f7d5e0f` from package 34), **plus the final docs commit of this handover on top** — take the hashes from `git ls-remote`, not from here. Tree clean |
| prod DB | **`0177_realtime_filter_premise.sql`**, ledger **177/177** |
| **next migration** | **0178** — the number comes FROM THE LEDGER, never from the folder. No named candidate: the queue is empty except the LOW batch and the owner's forks |
| `invariants_check()` | `ok:true`, **`checked:21`**, `failed:[]` |
| guard body | `md5(replace(prosrc, chr(13), ''))` = **`51abbdb14a75bf19a57d04ffa85477ea`**, length 74611, `cr_count 0` — byte-for-byte equal to the migration file |
| nightly jobs | `outbox-retention` 03:30, `audit-retention` 03:40, `invariants` 03:50 → `ok:true, checked:21, failed:[]`. The 05.09 run was the FIRST one with check №21 and it was clean |
| toolchain | tsc **0**, eslint **0**, vitest **2714/2714** (**91** files, ~20 s), `db:gate` **177/177** |
| stand revision | **25/25 green, 588 addressed** (`falsify-0166` 60/60; `falsify-u61` 19 addressed + 6 refactor). A full run takes **40–45 min** |
| `/login` fingerprint | chain measured on 05.09: `1KXTYxqAKBzhqunU7Gqbk` → `6B4LcEMX3j8kVL4iFwWbI` → **`hl0zFtCe7lUNp_Bql-tnn`**, HTTP 200 each time. ⚠️ **The terminal value cannot be recorded from inside the session that produces it** — writing it down requires a commit, and that commit deploys and changes it again. So expect at TASK #0 a value that DIFFERS from `hl0zFtCe7lUNp_Bql-tnn` by exactly one docs deploy. **What proves the deploy is the CHANGE, not the value** — if it equals `hl0zFtCe7lUNp_Bql-tnn`, the last docs deploy did not land |

⚠️ **The eslint gate runs with `--max-warnings 0`.** Any stray scratch file you
leave in the repo root (`.tmp-*.mjs` and friends) makes the gate RED for a
reason that has nothing to do with the package. Clean up after probes.

---

## WHAT SESSION 57 DID — eleven packages, four migrations, queue §2.4 emptied

`checked` 19 → **21**, stands 24 → **25**, tests 2553 → **2714**, addressed
mutations 545 → **588**. Full per-package detail with the measurements is in
`claude/radflow-handoff.md` (top block "СОСТОЯНИЕ НА КОНЕЦ с57" plus one block
per package); the PR docs are in `docs/audit/`.

| pkg | what | trail |
|---|---|---|
| 24 | **0174** — 18 of 19 checks wrapped in their own `exception`; the counter sits OUTSIDE the wrapper, so `checked` stays honest even when a check fell over. Before it, a failing check wrote NO row into `maintenance_runs` at all | `PR-0174-invariants-fail-loud.md` |
| 25 | the PROSE-channel debt closed | — |
| 26 | **RF-2 and RF-4 (code)** — the gate sits above the query, the role is not substituted | — |
| 27 | **0175** — no privilege-granting defaults in `profiles` (RF-4, schema). `checked` 19 → 20 | `PR-0175-profiles-no-default.md` |
| 28 | **U-65** — not a single realtime subscription without a clinic filter | `PR-U65-realtime-clinic-filter.md` |
| 29 | **U-66** — the fix was written and **WITHDRAWN** after measurement | `PR-U66-visibility-widening-update.md` |
| 30 | **0176** — U-66 closed by "narrow → data → widen": the link is written LAST | `PR-0176-visibility-widen-last.md` |
| 31 | **0177** — check №21 guards the premise realtime filtering rests on. `checked` 20 → 21 | `PR-0177-realtime-filter-premise.md` |
| 32 | **U-81** — one single verdict→exit-code linkage (`finishStand`), 105 tests | `PR-U81-stand-exit-code.md` |
| 33 | **U-62 part 1** — the hook's refetch policy extracted into `lib/realtimeRefetchPolicy.ts` | `PR-U62-refetch-policy.md` |
| 34 | **U-62 part 2** — idle work on mount (`skipInitial`). **U-62 fully closed** | `PR-U62-initial-load.md` |

## LESSONS OF SESSION 57 — each one cost a discarded edition of my own work

1. **A positional probe over someone else's function body is not a guard**
   (package 31). The first edition of check №21 pinned the body of
   `realtime.apply_rls` by the ORDER of markers. Measured on a copy of
   `prosrc`: the probe stayed **GREEN** both when the PK trim is moved out of
   the DELETE branch and when the delivery predicate is removed ENTIRELY — i.e.
   it was green on exactly the breakage it existed for. The cure is a
   **behavioural oracle** (call the stable `realtime.is_visible_through_filters`)
   plus ONE non-positional probe,
   `is_visible_through_filters\s*\(\s*old_columns`.
   ⚠️ A reviewer's alternative (`strpos(prosrc, 'is_visible_through_filters')
   = 0`) was REJECTED by my own measurement — a second occurrence of the name
   survives the mutation.
2. **A list without schema qualification is fail-open** (same package). The
   publication-configuration check compared BARE table names; measured:
   swapping `public.doctors` for `shadow.doctors` yields ZERO offenders. Same
   class as "a regex without an anchor to the PLACE".
3. **The guard over the guards is a suspect too** (package 32). Two editions of
   the `process.exitCode` pin were discarded and the STAND found both: a
   whole-file search went red on `falsify-0166` (which carries the linkage
   strings as mutation DATA) and killed two positive controls; stripping string
   literals with a regex lost the call in 2 files of 25, and a character scanner
   made it 6 of 25. That is precisely the trap named in the header of
   `tests/helpers/codeOf.ts`: "⚠️ Це НЕ токенізатор". The pin moved to the TAIL
   of the file (last 12 non-empty code lines) and holds in 25 of 25.

4. **A doc's list is a HYPOTHESIS, not a result — the eighth time this project**
   (package 32). `PR-U-74-falsify-verdict.md` said the linkage "lives in 20
   copies and is checked by nothing; the cure is a test for the presence of
   `process.exitCode`". Measured: **25** copies; `process.exitCode` was present
   in **all** of them (so the test the doc proposed would have been green from
   day one); and "checked by nothing" had been **false since session 52** —
   `falsify-all` computes `loudRed = status !== 0 || anchors || notHeld ||
   noRun || verdictRed`, and `verdictRed` parses the printed verdict as a backup
   channel. **Read the doc, then measure the claim before acting on it.**
5. **A product fix silently rots the anchors of OTHER stands** — it happened
   TWICE in one package (34): first `falsify-u61` N2, then the full revision
   found two more in `falsify-f4-portal` (M2 and G4). Nothing is visible to the
   eye: the code is correct, the tests are green, and the stand has stopped
   proving anything. **Only a FULL revision catches this.**
6. **Two different md5s are two different metrics** (package 30). After a deploy
   `md5(pg_get_functiondef(oid))` did not match the value recorded after the
   apply, and it looked like body drift; measuring both metrics side by side
   showed the recorded values were `md5(prosrc)` and matched byte-for-byte.
   **Always name an md5 together with the expression that produced it.**
7. **A fix can be correct and still make things worse** (package 29). Splitting
   the patch into "data → link" closes the leak only for `null → X`; for
   `X → Y` the first statement commits while `referrer_id` is still the OLD one,
   so the event with the NEW patient's data goes to the OLD referrer, who
   received nothing before the fix. The leak would have been MOVED to another
   person and to a more visible place. The code was withdrawn before it shipped
   — the second such withdrawal in the project (the first was the U-61
   migration, cancelled before apply).

---

## QUEUE FOR SESSION 58 — a menu, not an order

⚠️ **Ask before coding.** In session 52 the owner picked something other than
the top item three times running. Compose a plan (`TaskCreate`) and **AGREE THE
FIRST PACKAGE WITH ME BEFORE WRITING CODE.** If a package is product-facing,
show me the texts before they land.

Queue §2.4 of `claude/plan-s57.md` is **empty** — session 57 closed all of it.
What is left:

1. **LOW batch — U-59, U-60, U-75 (~2–3 h).** The only remaining engineering
   work that needs no decision from the owner. ⚠️ Note U-75 was already closed
   ONCE, differently, in session 52 (a literal `OVERLAYS` list would have been a
   SECOND copy of "what is open now" — the very thing the comment above
   `anyModalOpen` warns against); re-read that before planning it.

2. **Live checks** — the cheapest big one is a single run through
   `RescheduleModal` with a chosen slot (it closes the time node in one go);
   then Ф4-8 (timer ring and sound), Ф4-2 (call-window edges), the `cas`
   scenario, and Г1-F itself. ⚠️ **The status changed and this is a
   measurement, not a guess:** in the owner's Chrome a staff session is already
   live, so a run is feasible **without a single password** — but it means
   acting as the owner in production. Ask before every step that writes, and do
   nothing irreversible.
3. **The named debts below** — each is small, each has a place where it lives.

## FORKS Р1–Р5 — these cannot start without the owner's decision

Full text with the measurements: `claude/plan-s57.md` §3.

| # | fork | what has been measured so we do not decide blind |
|---|---|---|
| **Р1** | the CASE path for Г1-F — duplicate the clock guard on the server, as was done for the three creation paths? | The case steps are captured by `buildPayload()` long before submission, so a naive claim would go stale and the guard would reject HONEST work. Needs a different scheme (claim taken at submit time), ~2 h |
| **Р2** | the rule "where an audit trigger is required" (the named boundary of 0173) | Today the list says "these six must exist", not "audit must exist everywhere it is needed". A NEW table with PII and no audit trigger is invisible to everyone |
| **Р3** | extend list №19 to the 38 schedule trigger functions? | Cost measured: a trigger function body is touched by 8 of the last 30 migrations vs 4 of 30 for the current list — i.e. twice as many 1100-line reprints of the guard. ⚠️ Package 31 added two concrete named candidates, both measured: `update_patient_details(uuid,jsonb,jsonb)` (the only live defence against U-66, and NOT in list №19) and `tg_change_markers_queue()` (SECURITY DEFINER over a PII table, pinned by nothing). One line each — but it changes the semantics of №19 |
| **Р4** | Playwright / E2E by role | The project has no browser test at all, **by design** (`vitest.config.ts` says tests are pure functions from `lib/*`). This is the decision to create the first one — a new dependency and a change of approach |
| **Р5** | `user_change_markers` → `REPLICA IDENTITY FULL` | **Both sides measured.** Today it is the only one of the 11 published tables without FULL, so a DELETE of a marker NEVER reaches the subscriber and the unread dot is cleared by a 60-second reconciliation instead. With FULL the dot clears in <1 s, but a side channel opens: measured in the body of `apply_rls`, **on DELETE the function does not evaluate RLS at all** — the only boundary is the filter the CLIENT supplies. Content does not leak (the DELETE payload is trimmed to the PK); the FACT and the TIME do. Mitigation: the client never reads the payload (`onChange: () => void`, it re-selects under RLS). The same price is already accepted for ten other tables, but `user_change_markers` is the only one that ties a PERSON to an ENTITY. Technical cost: 261 rows / 344 kB, WAL growth is noise; but `alter table` takes ACCESS EXCLUSIVE and fail-CLOSED triggers on SEVEN hot tables write into it — apply only in its own short transaction with `lock_timeout`, outside the 03:20–03:55 window. ⚠️ Check №21 holds the exception **assertively**, so on the day of the switch the guard itself goes red and demands the exception be removed. That is by design |

## NAMED DEBTS — open, each with the place it lives

- **`room_id` in `queue_reschedule_rpc`** — the second half of the U-66 finding
  itself: the same "widening visibility in one UPDATE" class, not covered by
  0176. Same class again in **`updateWaitlistEntry`**.
- **No consolidated list of the visibility columns of `queue_entries`**
  (`{referrer_id, clinic_id, room_id, created_by, case_id}`). Until it exists,
  every new writer has to rediscover which columns move a row across a
  subscriber boundary.
- **The "assigned" event reuses `referral.patient_data_changed`** — the type
  says the wrong thing about what happened.
- **12 of the 25 stands still do not use `verdictOf`** — they carry their own
  `bad` counters. A separate debt descending from U-80б: unifying the VERDICT is
  not the same as unifying the LINKAGE (which U-81 did).
- **Subscriptions with a CONDITIONAL `router.refresh()`** did not get
  `skipInitial` — there the initial call is not always idle, and proving it
  needs its own measurement.
- **The body of `tg_change_markers_queue`** (SECURITY DEFINER over a PII table)
  is pinned by nothing — adjacent to fork Р3.
- ⚠️ **RF-1 is a DANGLING REFERENCE.** Measured: it occurs in exactly three
  places and all three are ENUMERATIONS (`claude/radflow-handoff.md`,
  `claude/session56-start-prompt.md`, the deep audit journal). Nowhere does
  anything say WHAT it is — RF-2 and RF-4 are described, RF-1 is not.
  **Question for the owner: is RF-1 a real debt whose description was lost, or
  a leftover of the numbering?** Work cannot be planned from a name with no
  content.

### There are NO open questions for the owner other than the forks and RF-1 above

Decisions already made — do not reopen them: branch protection on `main` stays
OFF for now; the service-role key rotation is tied to the first real centre with
real patients (so the audit verdict stays deliberately at CONDITIONAL GO); the
window of a DEFERRED day shift on the boards is not a problem; the `returned`
banner texts and the short `CLOCK_SKEW_MSG` are approved; the two test
`queue_entries` from 31.08 are the owner's own.

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
  error text means success).
- **The cloud container (`Bash`)** — a clean environment: clone from GitHub +
  `npm ci` + the full gate in **~2 minutes**. Also convenient for `sleep` while
  waiting for long background runs on the owner's machine.
- **Two independent subagents** — the two review rounds per package (canon).
  They read the code straight out of `D:\RadFlowDev` through Desktop Commander,
  so give them the DC tool list in the prompt and DIFFERENT lenses. ⚠️ Demand
  the format "SCENARIO / HARM / CURE" and an explicit "NOT VERIFIED" wherever
  they did not read to the end.
- **Claude Projects** (`project_read` / `project_write`) — the handoff and the
  key docs, visible to the owner across Claude products.
- Also: the built-in browser, **Claude in Chrome** (live UI checks — the
  built-in browser is NOT authenticated in RadFlow), Figma, Google Drive, n8n,
  Lovable.

## ENVIRONMENT TRAPS (verified, sessions 43–57)

### Around stands and long runs

⚠️ **Any edit in the repository while ANY stand is running is silently rolled
back.** A stand snapshots the live files on start and restores them in
`finally` — not just `falsify-all`, every `falsify-*.mjs`. An edit made while a
stand runs disappears without a trace; you can only notice by diffing the file
AFTER the run. While a stand is running, do not touch the tree at all.
⚠️ **`falsify-all.mjs` REFUSES to start on a dirty tree** — correct, but it
eats 20 minutes if you do not notice. **The order is: gate → commit → revision
on a clean tree.** Or `--allow-dirty` if you deliberately measure the working
copy.
⚠️ **A full revision takes 40–45 min; `falsify-u72` alone is 15–25 min.** Plan
it as background work, not as a step.
⚠️ **A stand that is red with an EMPTY facts table "did not finish"** — that is
not "the guard does not hold". The machine slows down 2–4× mid-session; run
that stand separately.
⚠️ **A TOOL TIMEOUT DOES NOT CANCEL THE COMMAND.** `start_process` returning
"Device did not respond within 60s" means the process is STILL RUNNING. Launch
the same thing again and two stands mutate the same live files, and the second
one reads a foreign mutation as "baseline is red". After any timeout:
`tasklist /fi "imagename eq node.exe"` first, then decide.
⚠️ **Restarting Desktop Commander kills its whole child process tree** and
leaves the live file MUTATED. A background launch via `Start-Process … -Hidden`
does not survive it. If the bridge has been dropping during the session, use a
one-shot scheduler task instead: `schtasks /create /tn <name> /tr "<bat>" /sc
once /st <time> /f` then `schtasks /run /tn <name>`; delete it afterwards.
⚠️ **`taskkill /F` on the runner kills the child stand too**, and its signal
handlers do NOT run — the live file stays mutated. After stopping a run:
`git status`, and if a live file is dirty, `git diff` (confirm it is a stand
mutation) then `git checkout --` on exactly that file.

### Around the shell (all of these have cost real time)

⚠️ **Background launch that does not hit the 60-second bridge cap:**
`start /B cmd /c <file>.cmd` — it returns instantly. ⚠️ **The form with an
empty title, `start "" /b cmd /c …`, DOES NOT WORK inside `cmd /c "…"`** (nested
quotes) — verified again in session 57: the launch silently did nothing and the
poll loop reported "still running" against files that were never created.
**Give every poll a green baseline: if the marker file does not exist AND the
output files do not exist either, the job never started.**
⚠️ **Pause between polls: `ping -n 50 127.0.0.1 >nul`** — it stays inside the
bridge window (~55 s), unlike `timeout /t` (which does not sleep at all when
input is redirected, and under `cmd /c` it always is). Two `ping`s in one
command already give "Device did not respond within 60s".
⚠️ **PowerShell `>` writes UTF-16, and `node -e` with Cyrillic output falls
apart** — a report you need to READ must be written by node itself
(`writeFileSync(…, "utf8")`) and read with `read_file`.
⚠️ **`node -e` and nested quotes inside `cmd /c "…"` break** — a script is
ALWAYS a file. Same for `findstr` (which also does not see Cyrillic).
⚠️ **`git commit -m` with Cyrillic and brackets breaks** — the message goes in a
file (`-F .commitmsg`, which is in `.gitignore`). ⚠️ `echo` does not write
UTF-8: create the message file with `write_file`, not `echo`.
⚠️ **`git merge --ff-only` fails** when `main` has merge commits — use
`--no-ff -F`.
⚠️ **`%ERRORLEVEL%` inside a chain joined by `&` expands BEFORE the run** —
check through `&&` / `||`.
⚠️ **`head` and `tail` do not exist in this shell.** The tail of a file is
`read_file` with a negative `offset`.
⚠️ **Node output redirected to a file is block-buffered (~4 KB)** — the log lags
several stands behind reality. Track progress by `git status` (which live file
is mutated right now), not by the tail of the log.
⚠️ **Test output can exceed the token limit** — write to a log file and read the
tail; do not drag it into context.
⚠️ **A large `read_file` result is delivered in PARTS by the bridge** — when
joining parts, put a `\n` between them or bytes are lost at the seams (found by
md5). `project_write` with `local_path` only takes files from the container's
working directory, and the call can hit a 30-second timeout and STILL have
written — verify with `project_read` before writing again.
⚠️ **The full gate on this machine takes 3–6 minutes**; on a clean clone in the
cloud ~2 min. A 37-mutation stand is ~3 minutes.
⚠️ **`supabase-js` captures `fetch` when the client is created.**
⚠️ **MCP tools are fixed at session START.**
⚠️ **A block comment cannot contain `*/`** — any "star + slash" inside a path
closes it, and the file fails BELOW the edit. And `{/* … */}` must not come
straight after `{cond && (`.

## READ FIRST (in this order)

1. **`AGENTS.md`** — the stable rules. "Конвенції коду" holds the time canon;
   the 0122 trap is in the migrations section.
2. **`claude/radflow-handoff.md`** — the durable state, FRESHEST first. It opens
   with "СОСТОЯНИЕ НА КОНЕЦ с57"; below it, one block per package and then
   sessions 56 → 43 in reverse order. A copy lives in Claude Projects.
3. **`claude/plan-s57.md`** — the live queue and the five forks with their
   measurements (§2 done, §3 forks, §6 findings of the planning itself).
4. ⛔ **`docs/HANDOVER.md` — NOT a source of truth** (it lies in places, e.g.
   "vitest — 59 tests"); §6 is valuable — it holds the "why it is like this".
5. **`docs/PRODUCT_OVERVIEW.md`** — the product and the schema evolution. §7 now
   covers 0170–0177, §8 the known defects and limits through session 57. ⚠️ The
   paragraph marked ⛔ near the top is HISTORY (2026-07-18), not current state.
6. **`docs/audit/RADFLOW_DEEP_TECHNICAL_FUNCTIONAL_AUDIT_2026-08-27.md`** — the
   audit journal. Phases 2, 4 and 6 are closed; the `cas` scenario and the live
   checks remain open tails; **the verdict is not issued** and cannot go above
   CONDITIONAL GO until the key rotation.
7. **The PR docs of session 57** (all in `docs/audit/`):
   `PR-0174-invariants-fail-loud.md`, `PR-0175-profiles-no-default.md`,
   `PR-U65-realtime-clinic-filter.md`, `PR-U66-visibility-widening-update.md`,
   `PR-0176-visibility-widen-last.md`, `PR-0177-realtime-filter-premise.md`,
   `PR-U81-stand-exit-code.md`, `PR-U62-refetch-policy.md`,
   `PR-U62-initial-load.md`.
8. **`docs/ops-cron.md`** — the registry of the nightly jobs (10 tasks;
   `invariants` runs `50 3 * * *` and now reports 21 checks).

⚠️ **And do not lean on THIS file either.** Verify the hashes (`git ls-remote`)
and the PREMISES of the tasks (`select now()`).

## RULES THAT CANNOT BE BROKEN

- **You apply the migrations** (Supabase MCP `execute_sql`), with mandatory
  verification of the Results.
- The number comes from `select max(name) from public.migration_ledger`, **NEVER
  from the folder**.
- File + smoke + a `=== ВІДКАТ ===` section at the END + dry-run + a predecessor
  guard (`do $ledger$`) + two independent reviews.
- **Dry-run:** the body inside `do $$…$$` with NO inner commit; verify the fact
  of the rollback with a SEPARATE query.
- **Smoke asserts only with `is distinct from`**; "RLS silently ate it" is only
  caught through `get diagnostics row_count`. A smoke checks the DELTA.
  ⚠️ A smoke against live production takes an AccessExclusiveLock — `set local
  lock_timeout` is mandatory on grants and policies.
- **A new invariant goes into `invariants_check()`**, not only into its own
  smoke. Edits to a migration file go in BEFORE `npm run db:gate`; never edit an
  already-applied migration — the gate stamps the md5 of the FILE.
- ⚠️ **After `drop`+`create`:** `revoke execute … from anon, public` + an
  EXPLICIT `grant … to <roles>` + **an ACL assertion in the SAME transaction**
  (the 0122 trap). In the ROLLBACK section keep `delete from migration_ledger`
  commented at a SECOND level.
- ⚠️ **A migration that reprints `invariants_check` MUST be followed by a FULL
  revision** — it silently breaks every stand pinned to the reprint. And the
  standing price of a reprint that moves `checked`: nine smokes and two md5 pins
  (`node scripts/bump-checked-pins.mjs <old> <new>`).
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
  `environment: "node"` and TZ is pinned to `Europe/Kyiv` (deliberately NOT UTC
  — half of this project's time bugs are about a day shift and do not reproduce
  in UTC). Introducing a DOM test is fork Р4, not a detail.
- **Routes are tested BEHAVIOURALLY** (`tests/fixtures/fakeSupabase.ts`). **The
  double must stay hostile:** it throws on any unimplemented filter.
- **A regex over source code is NOT a guard.** Check by CALLING. A static pin is
  legitimate only where no behavioural instrument exists in principle (usage
  sites inside components) — and then it must be NAMED as a boundary.
- ⚠️ **A regex without an anchor to the PLACE is not a guard.** If a substring
  can occur more than once in the file, the pin already lies — name WHICH one,
  and give each its own mutation.
- **A fixture must DISTINGUISH two implementations**, otherwise the check is
  empty. **A tautological test looks like a guard** — mentally revert the fix
  and name what goes red.
- **A guard that searches for a NAME catches the import line.** Guard the CALL.
- **Two tests with the SAME name** destroy the requirement "name the one that
  went red".
- **Read falsification through the JSON reporter**, not the text.
- **A comment next to a guard describes what the guard DOES**, not what it was
  put there for. Before writing "this mode is covered", run ONE probe that
  reproduces it.
- ⚠️ **`npm run lint` runs with `--max-warnings 0`** — any warning is red.
- **A new guard without a named red test and a green baseline is not done** —
  and that must be verified in the SAME commit, not in the revision.

## TOOLS (ready to use)

```
scripts\full-check.bat                  # the full gate in one background run
node scripts/falsify-all.mjs            # revision of ALL 25 stands (40-45 min, NOT a gate)
node scripts/falsify-all.mjs u70 u72    # only the named ones
node scripts/falsify-all.mjs --allow-dirty
node scripts/falsify-<stand>.mjs        # one stand (the list is in falsify-all.mjs)
node scripts/bump-checked-pins.mjs <old> <new>   # nine smokes + prose, after a reprint
node scripts/secret-scan.mjs [--selftest]
node scripts/integration-admin.mjs list --clinic <uuid>
node scripts/race-check.mjs plan | run --run --n 4   # cas has NEVER been run
npm run db:gate        # stamps md5      npm run db:gate:check   # verifies only
npm run build          # deploy gate + next build
select public.invariants_check();
```

`falsify-all` exits 1 if any stand is red, and **2** if the revision never
started (dirty tree without `--allow-dirty`, broken `git diff`). Inside it:
`EXPECTED_STANDS = 25`, a 45-min timeout per stand, tree comparison BY CONTENT
after every stand, a text parse of each stand's verdict as a backup channel, and
a floor on the number of addressed mutations — a stand that ran zero, or whose
summary is unrecognised, is RED.

⚠️ A live check must NOT be run from the container (the domain is not in the
allowlist) — use Claude in Chrome on the owner's machine.

## ORDER OF WORK

1. Read `claude/radflow-handoff.md` — the freshest state.
2. Verify it: `git ls-remote origin refs/heads/main refs/heads/dev` (⚠️ `git
   fetch` does NOT update remote-tracking), `git status`, the DB through
   `execute_sql`, `select now()`. **Do not trust the docs.**
3. Agree the direction with the owner, compose the task list (`TaskCreate`).
4. Work directly in `D:\RadFlowDev` — **one package at a time**, with the
   toolchain and two reviews between them.
   ⚠️ **Reviews go over ALREADY WRITTEN code, and your own fresh guard is as
   much a suspect as someone else's old one.** The lens of the second round is
   always "which mutation would leave this pin green", never "does it catch what
   I built it for".
5. **You commit, merge and deploy yourself.** After the deploy — a live check on
   production. Write the PR text anyway; it stays in `docs/audit/`.
   ⚠️ **Order around a revision:** gate → commit → `falsify-all` (it refuses to
   start on a dirty tree) → merge → push → deploy → measure the `/login`
   fingerprint in BOTH directions.
6. At the end of the session update `claude/radflow-handoff.md`,
   `docs/PRODUCT_OVERVIEW.md` (§7/§8), `AGENTS.md` (if a new invariant
   appeared), `docs/ops-cron.md` (if the number of checks moved), this file and
   `claude/session<N+1>-start-prompt.md` — and the copies in Claude Projects.

---

## THE ONE THING TO CARRY FORWARD

Across sessions 50–57 the same mistake repeats in different costumes: **a
statement made after reading PART of the picture.** Eight times in session 50, a
scanner list falsified four times in session 55, a doc's list found stale for
the eighth time in session 57. The mechanism never changes — a plausible claim,
verified in part, written down as fact.

Two habits that actually catch it, both cheap:

1. **Give every search a GREEN BASELINE.** "Found nothing" proves nothing until
   a line you know exists comes back. Four sessions "could not find" the prod
   URL that sat in 30 files of the repository.
2. **Count the load-bearing facts BY NAME and ask how many have a guard.**
   "Covered by pins" without a denominator is not a measurement.
