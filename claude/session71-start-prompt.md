# RadFlow — start prompt for session 71

Work **DIRECTLY** in `D:\RadFlowDev` through Desktop Commander. Production DB is
Supabase MCP, project ref `rdiqjxzibdqbhwileret`. Communication in Russian or
English; UI copy and project docs in Ukrainian (`claude/radflow-handoff.md` is
historically Russian — match each file).

You are the orchestrator and Full Task developer of RadFlow (patient flow in
MRI/CT rooms).

## There is NO unfinished package

s70 closed **0195** and **0196** end to end: build → dry run → apply → gate →
tests → full revision → merge → deploy → stamp in both directions. No live
feature branch, nothing half-applied.

## TASK #0 — RE-MEASURE, do not believe

A discrepancy with the table below is a **FINDING**: name it out loud, do not
quietly patch the doc.

| what | expected (measured 2026-09-14/15, end of s70) |
|---|---|
| `main` / `dev` | take BOTH from `git ls-remote` — they were LEVEL at the end of s70, at **`efec81f` or one of the doc commits on top of it** (merge `a3d00b3` is 0196 itself). ⚠️ A file cannot name the SHA of the commit that contains it, so this row names a FLOOR, not an equality: `ls-remote` is the measurement. No live feature branch |
| prod DB | **`0196_secdef_search_path_value.sql`**, ledger **196/196**, unstamped 0 → next is **0197, FROM THE LEDGER** |
| `invariants_check(false)` | `ok:true`, **`checked:23`**, `failed:[]` |
| guard body | **raw** (`md5(replace(prosrc, chr(13), ''))`) **`ba6474a7b31614bd3c4aacfc7c6e1744`**, length **129 854**, CR **0** |
| list №19 | **40** signatures; nine of them now carry `;cfg=search_path=public, pg_temp` (0196 changed the FIELD, not the count) |
| weak-form definer functions | **0** — check №2 now pins the VALUE `search_path=public, pg_temp` across all `public` SECURITY DEFINER functions |
| policy digest (№16) | **`3e5b95410350`** (was `1303b9136217` — `audit_read_ceo` narrowed) |
| toolchain | tsc 0, eslint 0, vitest **3370/3370** (**649** suites in **108** test files), `db:gate` **196/196**, build exit 0 |
| stands | `EXPECTED_STANDS` **40**, full revision **40/40** green |
| deploy stamp | compute `sha256(<current main SHA>)[:12]` **locally FIRST**, then fetch `/api/build` and compare — a fixed value here would rot with the next commit. Converged pairs of s70: `a3d00b3` → `1afc6913e00e`, **`efec81f` → `cba61a9702b6`**, and the previous deploy `21e8a9e` → `3a1f3466b33d` |
| pg_cron | **10** jobs, all active |

## What s70 did

- **0195 — the referrer centre card narrowed BY RELATIONSHIP STATUS**, and
  `sink_overdue_scheduled()` revoked from `authenticated`. The card leaked the
  whole equipment park plus admin name/phone/email to `revoked`/`declined`
  referrers, while RLS gives them zero. **Latent, not live** — prod has zero
  such rows. The cure is NOT `status = 'active'` (that would break invitation
  acceptance — trap С-5); the PAYLOAD is narrowed by status instead.
- **0196 — fork Р3 closed: `search_path` is pinned BY VALUE in check №2.**
  34 definer functions moved to the canon `public, pg_temp`. A probe on prod
  proved that what defends is the real schema standing BEFORE `pg_temp` —
  `pg_catalog, pg_temp` and the Supabase recipe `search_path = ''` do **not**
  defend against RELATION substitution. Second half: `audit_read_ceo` narrowed
  by `table_name` (the premise of Р69-2 was wrong; its conclusion stands).
- **The class «stale stand anchor» is now held by a machine**, not by prose:
  the reprint generator reads every `scripts/falsify-*.mjs` and fails if any of
  them quotes the pre-reprint side of a pair.
- **Н-7 denominator corrected**: SECURITY DEFINER in `public` is **115**, not
  «~30». 75 of them are pinned by nothing.

## ⚠️ Where the author was wrong in s70 — read this before trusting yourself

1. **A «dry run» WITHOUT a rollback marker is an APPLY.** I meant to send
   migration + smoke as one batch ending in a rollback; I sent only the
   migration. `execute_sql` runs a multi-statement batch as ONE transaction, so
   it committed. 0195 went to production as a «dry run».
2. **I called a LATENT finding LIVE**, on the strength of one measurement of
   `pending_referrer`, without looking at what the UI does with that state.
   Measuring the RESULT of a function is not measuring the HOLE.
3. **I killed a HEALTHY 40-stand revision and wrote an invented reason into a
   commit that is now in `main`.** Root cause: every pause of the form
   `timeout /t 300 /nobreak >nul` **silently does nothing** through the Desktop
   Commander bridge — stdin is redirected and `timeout` exits immediately with
   «перенаправление ввода не поддерживается». I read that line in the output
   every single time and never decoded it. I thought I had waited 48 minutes;
   about five had passed.
   ⚠️⚠️ **And the rule was ALREADY IN `claude/NEXT_SESSION_PROMPT.md`** —
   «Pause between polls: `ping -n 50 127.0.0.1 >nul` … **unlike `timeout /t`**».
   I walked past a line written for me, eight times in a row. Same class as
   «the list in the doc is narrower than the tree» and «six already-decided
   forks reported as open». **A written rule only works while it is read** —
   which is why the cure is an instrument that shouts, not more prose. **Use `Start-Sleep` via PowerShell, and print the
   wake-up time.** Before saying «it hangs», take TWO independent clocks —
   `Get-Date` and the process `CreationDate` from `Win32_Process`.
   ⚠️ And the consequence to remember: a killed stand does **not** run its
   `finally`, so it leaves its mutation in a LIVE file. `git status` +
   `db:gate:check` before anything else.
4. **A regex over `prosrc` lied three times in one package** — the list-№19 row
   format is `('signature','md5','attrs')`, not the RED MESSAGE format; a
   digest I expected once occurred four times (five policies share it); and a
   «no call sites» claim covered only `app/` and `*.ts` while the call lived in
   `components/ReferralPortal.tsx`. Every one was caught by a green baseline or
   a content assertion — which is the only reason they were caught at all.
5. **A number in a commit message that nobody counted:** «41 файл стендів» —
   41 is 40 stands **plus the runner** `falsify-all.mjs`, which also matches the
   mask. Corrected in `PR-0196`, not in the pushed commit.

## Queue for session 71 — a menu, not an order

⚠️ **Ask before coding.** Compose a plan (`TaskCreate`) and **agree the first
package with me before writing code.**

1. **0197 — T3-бис (Н-6) + check №24.** Owner's decision: **delete all five**
   orphan auth accounts, by an explicit id list with before-images. Fix BOTH
   halves: the server routes that can leave an orphan when the profile write
   fails, plus the adjacent `/api/staff/password` debt; and a new check №24
   with a TIME THRESHOLD so a half-finished signup does not red the guard for
   the seconds it legitimately takes. `checked` 23 → 24 means
   `node scripts/bump-checked-pins.mjs 23 24`, a reprint and a full revision.
2. **М-4 / Н-1 — nothing pins the guard's OWN body.** Still true, still the
   class that bit twice in s69.
3. **Plan 2.2 — the live check under the REGISTRAR**, the only role with no
   `LIVE-*` document, together with **С-14 (realtime)** in the same sitting.
4. **Plan block 1 — the live staff session** (Г1-E, Г1-G, Ф4-8 with a real
   `in_progress` patient, Г1-F on the five remaining paths). Needs me at a
   browser — pick the day with me.
5. **Plan 4.4 — WCAG.** ⚠️ Treat it as **NOT started**: s70 discussed a static
   pass but left no document on disk, so there is nothing to build on.
6. **Review-A findings never personally re-measured** — the radiologist oracle
   in `schedule_from_waitlist_rpc` / `set_waitlist_status_rpc`, the missing
   `auth_referrer_can_book_room` in `cancel_case_rpc`, and the cross-tenant
   lock in `integration_apply_status`. **NOT MEASURED** is their status, not
   «probably fine».
7. **Н-7 continues** — 75 definer functions pinned by nothing.
8. **Plan 3.2 — the restore REHEARSAL**, after the Dashboard look below.
9. **Plan 6.1 — the verdict**, last. Ceiling known in advance: **CONDITIONAL
   GO** until key rotation and the domain.

## What the owner decides — all cheap, and two are five minutes

1. **Р2 — the rule «where an audit trigger is required».** Confirm the 4–6 h
   price and decide about catalogue tables (`services`). Today a NEW table with
   PII and no audit trigger is invisible to everyone.
2. **leaked-password protection** — 5 minutes in the Supabase Dashboard; by API
   the two states are indistinguishable, so it cannot be closed from here.
3. **Dashboard → Settings → Add-ons** — which plan, and is **PITR** bought?
   `archive_mode=on` proves Supabase archives WAL, not that point-in-time
   restore was purchased for us. Until that is read, plan by **RPO 24 h**.

## Safeguards — NOT relaxed in any degree

Two independent review rounds with **DIFFERENT lenses** on anything touching
RLS, grants, `SECURITY DEFINER`, triggers, authorization, service-role code or
production migrations — and you validate every subagent conclusion
**personally**.
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

⚠️ **A "dry" run WITHOUT a rollback marker is an APPLY.** s70 paid for this one.

⚠️ **RED WINDOW.** From the second a migration registers in the ledger until its
file is in `main`, every production build fails (the gate is symmetric). Close it
in one move: branch → `dev` (ff) → `main` (`--no-ff -F .commitmsg`) → push →
deploy.

⚠️ **Never touch the tree while a stand runs** — every `falsify-*.mjs` snapshots
the live files and restores them in `finally`. That includes me: warn me out
loud before starting a revision. And if a revision is ever killed, the runner
refuses to start again until `.falsify-all.running` is cleared **by hand, after
`git status`** — that refusal is the feature, not an obstacle.

⚠️ **Time is a measurement too.** `timeout` through the bridge is a no-op; use
`Start-Sleep` and print the wake-up time. The bridge itself caps a call at
~60 s, so long waits are a sequence of short ones.

## How to report to me

Short, in plain words. What changed in production first, then what I must
decide, then what is left. Numbers where they carry weight (md5, ledger,
counts), plain language everywhere else — no retelling of steps I watched
happen. Anything whose revision criterion is "the first real centre" goes into
`docs/audit/ToDo_Production.md`, not into the middle of a plan block.

## Where the detail lives

* `claude/NEXT_SESSION_PROMPT.md` — the attachment: working mode, environment
  traps, rules, tools, lessons of s63–s70.
* `claude/radflow-handoff.md` — durable state, freshest first.
* `docs/audit/PLAN-audit-completion-2026-09-13.md` — the audit plan; **read its
  «СТАТУС» table first**, the body below it is dated 13.09.
* `docs/audit/ToDo_Production.md` — everything gated on the first real centre.
* `docs/audit/PR-0195-referral-card-scope.md`,
  `docs/audit/PR-0196-secdef-search-path-value.md` — the two s70 packages,
  including both process errors written out in full.
* `docs/PRODUCT_OVERVIEW.md` — the product and the schema evolution.
* `AGENTS.md` — the stable rules; the time canon, the 0122 trap, the red window.
