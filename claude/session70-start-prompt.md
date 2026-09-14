# RadFlow — start prompt for session 70

Work **DIRECTLY** in `D:\RadFlowDev` through Desktop Commander. Production DB is
Supabase MCP, project ref `rdiqjxzibdqbhwileret`. Communication in Russian or
English; UI copy and project docs in Ukrainian (`claude/radflow-handoff.md` is
historically Russian — match each file).

You are the orchestrator and Full Task developer of RadFlow (patient flow in
MRI/CT rooms).

## There is NO unfinished package

s69 closed **0193** and **0194** end to end: build → dry run → apply → gate →
tests → merge → deploy → live check in both directions. No live feature branch,
nothing half-applied. `dev` and `main` are level at **`ca1b560`** and production
serves that commit (stamp verified, see below).

## TASK #0 — RE-MEASURE, do not believe

A discrepancy with the table below is a **FINDING**: name it out loud, do not
quietly patch the doc.

| what | expected (measured 2026-09-14, end of s69) |
|---|---|
| `main` / `dev` | take BOTH from `git ls-remote` — level at `ca1b560` at end of session. No live feature branch |
| prod DB | **`0194_gcal_blind_disable.sql`**, ledger **194/194**, unstamped 0 → next is **0195, FROM THE LEDGER** |
| `invariants_check(false)` | `ok:true`, **`checked:23`**, `failed:[]` |
| guard body | **raw** (`md5(replace(prosrc, chr(13), ''))`) **`af390d6f00d8ef711a85e8f54e0f987b`**, length **126 449**, CR **0** |
| list №19 | **40** signatures, `;acl=` in every row. 33 (0191) → 38 (0192) → 40 (0193: `waitlist_candidates_for_slot`, `waitlist_counts`) |
| toolchain | tsc 0, eslint 0, vitest **3367/3367** (**649** suites in **108** test files), `db:gate` **194/194**, build exit 0 |
| stands | `EXPECTED_STANDS` **40**, full revision 40/40 green |
| deploy stamp | `sha256(ca1b560ec3f2a3da9f46e0237f9878ec9f16e42d)[:12]` = **`40a95aa0dbae`**, and `/api/build` returned exactly that — converged in both directions |
| pg_cron | **10** jobs, all active (`invariants` 03:50 UTC writes to `maintenance_runs`) |

## What s69 did — two LIVE findings, and both on the READING path

- **`0193` — I-8 (High, was LIVE).** `waitlist_candidates_for_slot` is SECURITY
  DEFINER, owner `postgres`, `returns setof public.waitlist_entries` — the whole
  row: name, phone, DOB, indications, contraindications. Its entire
  authorization was «authenticated» and «not a referrer»; the radiologist passes
  both, and `auth_radiologist_room_ok` was not in the function at all. Measured
  on prod both ways: **through RLS he reads 0, through the RPC he got 1.** Cure:
  one conjunct in `where`, verbatim the shape of policy `waitlist_select`; same
  in `waitlist_counts`; both bodies into list №19.
  ⚠️ **Why it was missed three times:** the boundary was NAMED by name in the
  0136 header and handed to 0137 — which closed table reads with a policy and
  never re-read the DEFINER half. DEFINER-**write** is covered by trigger
  `a00_radiologist_scope`; DEFINER-**read** is covered by NOTHING (reads have no
  triggers, and DEFINER bypasses policies).
- **`0194` — I-7.** Check №13 filtered `where g.enabled`, while CHECK
  `gcal_enabled_invariant_chk` OBLIGES every failure path to clear `enabled` —
  so the fault removed the row from the guard's own field of view, and the queue
  mirror lay dead **11.5 days** at `ok:true`. Second branch added with no time
  threshold (owner's decision Р69-3). Proven with a **constructed** red baseline
  in a rolled-back transaction: the ready-made one vanished when the data was
  fixed.
- **Side finding, same class:** `supabase/smoke/gcal_pg_cron_smoke.sql` could
  not pass **since 0186** — its fixture depended on production having an
  unconnected clinic, and two body pins went stale **by construction** (a human
  had to retype them after every reprint). Fixture is now self-sufficient; run
  14.09: `SMOKE_OK ( a b c d e f f2 g-info g2-info )`.
- **Docs:** audit journal brought level (phases, 0192–0194, I-7/I-8), threat
  model `THREAT_MODEL_2026-09-14.md`, `RLS-SEMANTIC-2026-09-14.md`,
  `RUNBOOK_RESTORE.md`, **`docs/audit/ToDo_Production.md`** (new), Р69-*
  numbering collision fixed, advisors re-measured 14.09,
  `docs/PRODUCT_OVERVIEW.md` rewritten to 0194 (16 tables and five whole modules
  were missing from it).

## ⚠️ Where the author was wrong in s69 — read this before trusting yourself

1. **Twice I wrote a PARAPHRASE under the word «ЗАМІРЯНО».** The CHECK was
   quoted without the space after the comma and without `conname`. If a line
   says «measured», it must be the tool's output byte for byte, not my retyping
   of it.
2. **Three times I stated an occurrence count from memory instead of counting.**
   `invariants_check(false)` calls: said 3, real 2 (the third was in a comment →
   count on COMMENT-STRIPPED code). Probe asserts: said 7, real 9.
   `EXPECTED_RED`: said 21, real 22 — and that one was masked by a stale anchor,
   two errors cancelling each other until the anchor was fixed.
3. **Stale stand anchors after prose edits** — reported loudly («ЯКІР НЕ
   УНІКАЛЬНИЙ (0)»), which is the only reason the full-revision canon is
   affordable. Re-anchor, do not re-word the prose to fit.
4. **My own smoke had the defect it was testing for:** section f6 set
   `enabled = true` after f5 had nulled calendar/secret/role → `23514
   gcal_enabled_invariant_chk`. Restore from the before-image, and pick a fully
   configured row for a positive branch.
5. **I reported six ALREADY-DECIDED forks to the owner as «waiting for you».**
   The plan is dated 13.09 and predates his answers. **Grep `DECISIONS-*` before
   calling anything open** — and `PLAN-audit-completion-2026-09-13.md` now opens
   with a measured status table so this cannot repeat.
6. **I edited docs while the 40-stand revision was running.** It auto-reverts
   drifted files. Caught in time; the rule stands — **write docs before or
   after, never in parallel.**
7. **A claim about WHERE a smoke failed, made without running it.** I said
   `gcal_pg_cron_smoke` «falls over at the end on g/g2»; measurement showed it
   died at the fixture, before reaching them.

## What the owner decides — three cheap things, and one is five minutes

1. **Р3 — `search_path` for definer functions OUTSIDE list №19.** One word: pin
   the VALUE in check №2 (cheap, no reprint of №19) / extend the named list (a
   reprint each time) / a listless catalogue digest (the offender names itself).
   Blocks plan item 4.2.
2. **Р2 — the rule «where an audit trigger is required».** Confirm the 4–6 h
   price and decide whether catalogue tables (`services`) need the second rule.
   Today a NEW table with PII and no audit trigger is invisible to everyone.
3. **leaked-password protection** — 5 minutes in the Supabase Dashboard. By API
   the two states are indistinguishable (WARN on 07.09, absent on 13.09 and
   14.09), so this cannot be closed by measurement from here.
4. **Bonus, also 5 minutes, and it unblocks half of plan item 3.2:** Dashboard →
   Settings → Add-ons — which plan is this project on and is **PITR** bought?
   `archive_mode=on` proves Supabase archives WAL, NOT that point-in-time
   restore was purchased for us. Until that is read, plan by the worst case:
   **RPO 24 h**.

## Queue for session 70 — a menu, not an order

⚠️ **Ask before coding.** Compose a plan (`TaskCreate`) and **agree the first
package with me before writing code.**

1. **М-4 — nothing pins the guard's OWN body** (`ToDo_Production.md`, Н-1).
   `create or replace public.invariants_check` outside a migration is invisible
   to all 23 checks and to every test; today the property is held by the apply
   ritual and by №7 `ledger_md5` — procedure, not machine. This is the class
   that bit twice in s69, so it is first on the menu, not last.
2. **Р3 (`search_path` outside №19)** — one word from me, then 2–4 h.
3. **Plan 2.2 — the live check under the REGISTRAR**, the only role with no
   `LIVE-*` document, together with **С-14 (realtime)** in the same sitting.
4. **Plan block 1 — the live staff session** (Г1-E, Г1-G, Ф4-8 with a real
   `in_progress` patient, Г1-F on the five remaining paths). 6.5–8.5 h and it
   needs me at a browser, so pick the day with me.
5. **Plan 3.2 — the restore REHEARSAL** on a copy, after the Dashboard look
   above. Runbook already written 14.09; what is missing is that nobody has ever
   executed it.
6. **Grant hygiene С-6 / С-12 / С-13** from `RLS-SEMANTIC-2026-09-14.md`.
7. **Per-function audit of ~30 DEFINER functions** — the open tail of I-8 (Н-7).
   The question «does this function repeat the gates of the policies it
   bypasses» was answered BY GATE, not per body.
8. **Plan 4.4 — WCAG re-audit** (none since с47; keyboard and screen-reader
   checks never done).
9. **Plan 6.1 — the verdict**, last. Ceiling known in advance: **CONDITIONAL
   GO** until key rotation and the domain.

**Standing items, unchanged:** boundaries 1/2/3/5/8 of the 0191 audit (the
`;cfg=`/`secdef=`/`;vol=` expressions are pinned by no test; `auth_referrer_clinics()`
has no NAMED red test; an aclitem with GRANT OPTION would put `*/` inside a
pinned row); `auth_rls_initplan` on 15 policies (the win is NOT automatic);
`pg_timezone_names` phase 2 (blocked on the legacy alias `Europe/Kiev`);
14 Medicom MRI rows with an unresolvable `region`.
**Closed, do not re-open:** «`assertNoLiveDelivery` does not cover `cleanup`»
(done in s68, commit `346a887`); «`docs/README.md` says 9 crons» (both that file
and `docs/ops-cron.md` say 10, re-verified against `cron.job` on 14.09); Р4
(E2E — owner said no, 13.09); plan item 3.4 (CHECK on `clinics.timezone`, done
by 0192).

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

⚠️ **The two guard-design rules s69 paid for:**
- **Can the field a guard filters on survive the very failure it watches for?**
  If the failure clears that field, the guard is blind by construction (I-7).
  Sibling: a trigger guards writes, reads have no trigger (I-8).
- **A pin a human must retype after every reprint is stale by construction.**
  Generate it, or don't make it.

⚠️ **"Success" is not proof.** After every apply verify BY QUERY: the ledger row
and count, `invariants_check(false)`, the guard body md5 (naming the recipe) and
its length, the smoke pins. And run the **full test suite**.

⚠️ **A rollback verified inside the same transaction proves nothing** — take the
md5 again with a SEPARATE query.

⚠️ **RED WINDOW.** From the second a migration registers in the ledger until its
file is in `main`, every production build fails (the gate is symmetric). Close it
in one move: branch → `dev` (ff) → `main` (`--no-ff -F .commitmsg`) → push →
deploy.

⚠️ **Never touch the tree while a stand runs** — every `falsify-*.mjs` snapshots
the live files and restores them in `finally`. That includes me: warn me out
loud before starting a revision.

## How to report to me

Short, in plain words. What changed in production first, then what I must
decide, then what is left. Numbers where they carry weight (md5, ledger,
counts), plain language everywhere else — no retelling of steps I watched
happen. Anything whose revision criterion is "the first real centre" goes into
`docs/audit/ToDo_Production.md`, not into the middle of a plan block.

## Where the detail lives

* `claude/NEXT_SESSION_PROMPT.md` — the attachment: working mode, environment
  traps, rules, tools, lessons of s63–s69.
* `claude/radflow-handoff.md` — durable state, freshest first.
* `docs/audit/PLAN-audit-completion-2026-09-13.md` — the audit plan; **read its
  new «СТАТУС НА 14.09» table first**, the body below it is dated 13.09.
* `docs/audit/ToDo_Production.md` — everything gated on the first real centre.
* `docs/audit/PR-0194-gcal-blind.md`, `docs/audit/DECISIONS-2026-09-14-s69.md` —
  the last package and the owner's decisions behind it.
* `docs/PRODUCT_OVERVIEW.md` — the product and the schema evolution, level with
  0194.
* `AGENTS.md` — the stable rules; the time canon, the 0122 trap, the red window.
