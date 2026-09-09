# Session 61 — SHORT opening prompt

> Condensed carry-over. Everything under ✅ was re-measured against prod and the remote on
> **2026-09-09 13:47 UTC**; the long form with the full history stays in
> `claude/session61-start-prompt.md` and is not repeated here.

---

Continuing development and production of the RadFlow SaaS. You are the orchestrator and Full Task developer. Communication in Russian, UI copy in Ukrainian, project docs in Ukrainian. Work DIRECTLY in `D:\RadFlowDev` via Desktop Commander; prod DB — Supabase MCP (`rdiqjxzibdqbhwileret`).

**Authority is expanded:** you edit code/tests/SQL/docs, create and apply append-only migrations to prod, run safe prod SQL, commit, push, merge, deploy, read prod logs, do live checks. "Success" is not proof — after every apply verify BY QUERY: the ledger row and count, `invariants_check(false)`, the guard body md5 without CR **and its length**, the smoke pins.

**Safeguards are not relaxed.** Two independent review rounds with DIFFERENT lenses on anything touching RLS, grants, `SECURITY DEFINER`, triggers, authorization, service-role code or production migrations — and you validate every subagent conclusion personally. Falsification: a NAMED red test plus a GREEN baseline. Live prod checks in BOTH directions. Prod data only by an explicit id list with before-images. Secrets and PII go NOWHERE. `npm audit fix --force` is FORBIDDEN. Dev and prod are ONE DB. Never ask for passwords. Agree the first package with me before coding; if it is product-facing, show me the texts before they land.

**TASK #0 — re-measure, do not trust this list:** `select now()`, `git ls-remote origin main dev`, `git status`, `maintenance_runs` overnight, `select max(name), count(*) from public.migration_ledger`, `select public.invariants_check(false)`, `npm run db:gate`, `GET https://rad-flow-tau.vercel.app/api/build`.

✅ **Verified on 09.09 13:47 UTC:**

* prod DB `0183_rf03_sched_override_read.sql`, ledger **183/183**, unstamped 0 → next migration **0184**
* `invariants_check(false)` → `ok:true, checked:22, failed:[]`; guard body md5-without-CR `3ac1aa3c88230816b8cf5ade32c1305d`, length **96322**
* **The 09.09 03:50 nightly run — the FIRST on the 0183 body — returned `ok:true, 22, []`.** The open question the previous prompt left is answered.
* `main` = `da14b83` ("Merge: документация сессии 60", 09.09 05:44 UTC), `dev` = `6bfa74d`, tree clean. ⚠️ Both differ from the long prompt (`d5714f4` / `7e1fcac`) — one docs merge landed after it was written. Not an anomaly.
* Live `/api/build` stamp `2dabc18ded1f`, and `sha256(<40-char SHA as ASCII text>)[:12]` reproduces it exactly — **the deploy has landed.** ⚠️ It is sha256 of the hex STRING, not of the 20 raw bytes (bytes give `862b49796bf1`). The long prompt says "compute it yourself" without saying which; this is which.
* 228 seed entries still carry the tag `[seed-2026-09-08]`.

⚠️ **From the docs, NOT re-verified (the handover session had no shell at the time):** vitest **2931** (101 files), tsc 0, eslint 0, `EXPECTED_STANDS` **33**.

**Full context — read, do not re-derive:** `claude/session61-start-prompt.md` (what session 60 did, eight lessons, standing costs), `claude/radflow-handoff.md` (top block), `docs/audit/PR-0183-rf03-sched-override-read.md`, `docs/audit/SEED-2026-09-08-test-data.md`.

**Queue, in order:**

1. **0183b — instant schedule updates for the referrer.** The deferred half of RF-03; 6–8 h for the whole of RF-03, of which 0183a is spent. Not "wire up markers" — **build** them: `change_marker_recipients` has no fan-out to a clinic's referrers, `schedule_overrides` has no emitter trigger, and a marker with no `useAckWhenVisible` is a defect by this project's own rule. Cost of not doing it, named in the code: the referrer is up to 30 s late on the existing `pollWhenSubscribedMs: 30_000` tick.
2. **The seed rots on 15.09 — six days out.** All 228 entries sit in the 09-09…15 window; past it, the `sink-overdue` cron stamps `clarify_at` on every one and the board fills with «потребує уточнення». Re-seed into a fresh window or clear it (§6 of the seed doc — three DELETEs by tag, rehearsed with rollback, invariants stayed green).
3. **14 MRI rows in Medicom** whose `region` resolves to no active visible service — editing them or moving them fails with `SERVICE_CLOSED` today.
4. **Named debts and forks Р1–Р5** — unchanged; they are listed in the long prompt.

**Traps that actually bite.** Any migration that creates a table, view, sequence or an anon-callable `SECURITY DEFINER` function must update check №22's key list IN THE SAME migration, or the nightly guard goes red with `new:`. Order: gate → commit → `falsify-all` (**33 stands**, ~60 min on a quiet machine / 88 under load; refuses a dirty tree; NO edits while ANY stand runs; **check `git status` before AND after** — a hard-killed stand does not run `finally` and leaves a live mutation behind) → merge → push → deploy → verify the stamp in BOTH directions. Run git ONLY from the Windows shell; Cyrillic commit and merge messages only via `-F <file>`.

⚠️ **Self-invalidating line, on purpose:** the docs commit that carries THIS file moves `main`
and therefore the `/api/build` stamp. So `2dabc18ded1f` above is the value as of 09.09 13:47 UTC,
before this file was committed — expect the live stamp to DIFFER, recompute
`sha256(<new main SHA as text>)[:12]` and compare. A stamp equal to the PREVIOUS head just means
the build has not landed yet; that is an answer, not a failure.
