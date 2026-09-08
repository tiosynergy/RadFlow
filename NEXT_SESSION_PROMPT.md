# RadFlow — attachment for the next session (session 60)

> **This file is the ATTACHMENT.** The owner pastes
> `claude/session60-start-prompt.md` as the first message and attaches this
> file. Session-specific part rewritten at the end of session 59 (2026-09-07);
> the permanent part below is carried unchanged. History lives in
> `claude/radflow-handoff.md`.
> ⚠️ Session 59 opened on a PASTED text one package older than its own
> attachment (0177/177/2763/26 vs 0178/178/2798/27) — the two must be from
> the same end-of-session edit. Check that before pasting.
>
> ⚠️ **DO NOT TRUST THIS FILE.** Everything below is what SHOULD come out, not
> the source of truth. Verify by query and by command (TASK #0). **A
> discrepancy is a FINDING — name it, do not silently patch the doc.**
> Session 58 found exactly such a lie in the previous edition of this file: the
> fingerprint rule (see below) would have made every session report a phantom
> incident.

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

### ⚠️ APPLYING SQL — apply automatically, but verify the Results

"Success" is not proof. After EVERY apply, verify by measurement: the function
body (`md5(replace(prosrc, chr(13), ''))` against the md5 of the file's body —
the SQL Editor brings CRLF), the ledger row, `invariants_check(false)`, the
smoke pins. In session 56 "Success. No rows returned" hid TWO discrepancies.

## SAFEGUARDS — NOT CANCELLED IN ANY DEGREE

- **Two independent review rounds with DIFFERENT lenses** on anything that
  touches RLS, grants, `SECURITY DEFINER`, triggers, authorization, service-role
  code, integration contracts, concurrency or production migrations. **You
  validate subagent conclusions personally.** ⚠️ Session 58 is the strongest
  case yet for this rule holding even on plain UI work: two rounds found FOUR
  ways past my own fresh pins, each leaving the whole package green, and the
  main one meant U-59 was not closed at all for the three busiest surfaces.
  Proven lens pairs: "falsification: which mutation leaves this pin green" ×
  "operational risk and operator experience"; "what breaks for the next person"
  × "did the author overstate his own measurements".
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

### How to take the fingerprint — CORRECTED IN SESSION 58

The prod URL is **`https://rad-flow-tau.vercel.app`** (also in `AGENTS.md` and
in `cron.job.command`). The channel is the Next.js **buildId** in the RSC
payload — measure it from a browser, NOT with `WebFetch` from the container
(the container strips HTML comments):

```js
const r = await fetch("/login?cb=" + Date.now(), { cache: "no-store" });
const t = await r.text();
const b = (t.match(/\\"b\\":\\"([A-Za-z0-9_-]{15,30})\\"/) || [])[1];
```

⛔ **THE FINGERPRINT IS A ONE-DIRECTION SIGNAL. Session 58 got this wrong TWICE
before measuring enough of it — do not repeat either mistake.** Four
measurements, all at `x-vercel-cache: MISS` and `age: 0`:

| when (UTC) | `main` | merge carried | fingerprint |
|---|---|---|---|
| 05.09 12:05 | `3c96898` | docs | `L5hONrcdRbznxb-qwKMum` |
| 06.09 11:39 (two instruments) | `27b8056` (+2 docs merges) | docs | `L5hONrcdRbznxb-qwKMum` — **unchanged for ~24 h** |
| 06.09 13:59 (+4 min) | `8382eeb` | **code** | `6w5PbW59Lb0Coh2XTeASf` — changed |
| 06.09 14:18 (+5 min) | `09ff11b` | docs | `2S_QeCfEd-xbLsmKC1VOX` — **changed**, stable over three reads from different edge nodes |
| 06.09 14:25 (+3 min) | `7edf276` | docs | still `2S_QeC…` — **the build had not landed yet** |
| 06.09 14:29 (+7 min) | `7edf276` | docs | `Dnmjxdw03-CgSJsXREkCm` — **changed** |

⚠️ **BUILD LATENCY IS 4 TO 7+ MINUTES, not the "2–3" the older docs claim.** At
the three-minute mark I nearly wrote down "no build". Measure no earlier than
8 minutes after the push, and preferably twice with a gap.

⚠️ **CORRECTED ON 06.09 FROM THE VERCEL DASHBOARD (session 58, third rewrite of
this rule — read this before you trust the table above).** The claim "on 05.09
two merges produced no build" is **REFUTED by the primary source**. The
Deployments list shows a deployment for EVERY commit, on `main` and on `dev`
alike, with no gaps:

* `81a7b46` — Production, Ready, 1m 2s, 05.09;
* `27b8056` — Production, Ready, 58s, **created 05.09 15:12:39 GMT+3**.

So the norm is not merely "every merge rebuilds" — **every merge did rebuild,
including both of the 05.09 docs merges.** What is left is a sharper anomaly:
`27b8056` had been built and Ready for ~20 hours by the time of the 06.09 11:39
measurement, and the fingerprint was nevertheless still the 05.09 12:05 value.
Build and fingerprint disagree; the dashboard is the primary source and wins.

Hypothesis tested and **falsified** on the spot: "the `rad-flow-tau.vercel.app`
alias was never moved to those builds". Their detail pages do not list that
domain — but neither does `eead31e`, which certainly served production two
hours earlier. Vercel's Domains block shows only the domains assigned **right
now**, so its absence on an old deployment proves nothing.

Still unexplained, and it is now a fingerprint-instrument question, not a
build question: how a live `/login` read at `x-vercel-cache: MISS`, `age: 0`
returned a 20-hour-old buildId. Until that is understood, treat the fingerprint
as stated below.

`next.config.mjs` sets no `generateBuildId` and `vercel.json` is empty, so the
buildId is random per build: a changed value means a build shipped.

**What follows, and only this:**

* "a docs commit does not rebuild" — **REFUTED** (that was session 58's own
  forty-minute-old rule, broken by the fourth measurement);
* "every push rebuilds" — **CONFIRMED at the dashboard on 06.09**: every commit
  on `main` and `dev`, docs commits included, has its own Ready deployment;
* **so the fingerprint is a reliable POSITIVE signal and an unreliable negative
  one.** Changed → a build arrived. Unchanged → **draw no conclusion**: on
  05.09 an unchanged fingerprint sat on top of two builds that had shipped.
  Do not declare an incident from it.

**Rule for TASK #0:** a changed fingerprint proves the deploy. An unchanged one
is a fact to record, not a diagnosis — and if your session ships code, use your
own push as the test (measure before and after).

⚠️ **Still unexplained (the dashboard answered half of it on 06.09):** the
05.09 pair DID build — see the correction above — so what is open is why the
`/login` fingerprint did not follow, and why the chain recorded at the end of
session 57 (`1KXTYxqAKBzhqunU7Gqbk` → `6B4LcEMX3j8kVL4iFwWbI` →
`hl0zFtCe7lUNp_Bql-tnn`) could not be reproduced — prod served none of those
last two values. Both are now suspicions about the INSTRUMENT (the regex over
the RSC payload of `/login`), not about the deploy pipeline. Next session: pin
the instrument by measuring the same commit twice from two different edges, and
cross-check the buildId against `/_next/static/<buildId>/_buildManifest.js`.

⚠️ **Which browser lands where — measured, and it is NOT what session 57 wrote.**
`lib/supabase/middleware.ts` sends a logged-in user from `/login` to `/queue`
UNCONDITIONALLY; `app/queue/page.tsx` then routes by role (radiologist →
`/radiologist`, referrer → `/referral`, ceo → `/ceo`), and only **admin /
registrar** stay on `/queue`. So the landing page tells you the ROLE of the live
session, nothing more. In session 58 both reachable instruments (Claude in
Chrome "Browser 1" and the built-in browser) held an **admin/registrar**
session — `/queue`, ~96 900 bytes. Session 57 recorded a radiologist session in
"the owner's Chrome"; **there are two Chromes on the account**, so do not treat
either as canonical. Byte counts must not be compared between browsers; the
buildId can.

⚠️ **Claude in Chrome went unresponsive mid-session in BOTH 57 and 58**
(`CDP Runtime.evaluate timed out`). The built-in browser IS authorized in
RadFlow now and did the whole job in 58 — prefer it, and if you use both, say
which instrument took which end.
⚠️ A Vercel deploy takes **4–9 min** after a push — measured in sessions 58
and 59 (59: +9 min for the code merge), and the "~2–3 min" in the older docs
is too optimistic to act on.

### Session 59 measurements (instrument pinned)

| when (UTC) | `main` | merge carried | fingerprint |
|---|---|---|---|
| 07.09 09:59 | `8cd4ce7` | docs | `MSywNHFc1NY8g-T_ezLt1` — differed from the s58 table, as predicted; `_buildManifest.js` for it → **200**, for the two previous ids → **404** |
| 07.09 11:45 (+9 min) | `f2013d6` | **code** (package 38 step 1) | `PcSts0KigRuth5_eho5UV` — changed |
| 07.09 (package 38, migration + docs merges) | `087dab0` + docs | migration 0179 + docs | `fctmkCrYxXlaq0MsPpG9o` → `f4suUurdNCq2L9CANWdJG` — changed after each |
| 07.09 14:58 push → 14:59 read (+1.5 min) | `41e7e5c` | **code** (package 39) | `oXDM3lxbUoAeFSj8Kx4qb` — differed from `f4suU…` (404) but TOO EARLY to be package 39: most likely the last docs commit of package 38, never re-measured |
| 07.09 15:02 (+4 min) | `41e7e5c` | **code** (package 39) | **`uh7QxBj9ypJ-9BrDkEwu4`** — changed again; `_buildManifest.js` for it → 200, for `oXDM…` and `f4suU…` → 404. Consistent with the 4–9 min build latency |
| 07.09 15:06 → docs merge | `8d9a53d` | docs (package 39) | `cjHcGeyPZ142wKCPKLmgt` — changed |
| 07.09 20:57 push → 21:06 read (+9 min) | `0da8a86` | **code + migration** (package 40) | **`sk6WLPyxCWYIN-GSgGAAE`** — changed; manifest 200 for it, 404 for `cjHcGeyP…`. Read at 20:58 (+1.5 min) it was still the OLD id — measure no earlier than 8 minutes, as the rule above says |

The manifest cross-check answers session 58's open instrument question:
the regex reads the buildId that production actually serves.

### Expected state (measured 2026-09-08, end of session 59, after package 43)

| what | expected |
|---|---|
| `main` / `dev` | **`65c096a`** / **`a1b1d17`**, plus the docs commit(s) on top — take the hashes from `git ls-remote` |
| prod DB | **`0182_rf02_invite_ttl.sql`**, ledger **182/182** |
| **next migration** | **0183** — the number comes FROM THE LEDGER |
| `invariants_check()` | `ok:true`, **`checked:22`**, `failed:[]` — 0182 did not touch the counter |
| guard body | md5 without CR **`c936ff4a209b852c7dc766448f99b4e7`**, length **95662**, CR 0; normalized pin g **`498f86f71c5f6a0cf6196bb384494d3b`** |
| toolchain | tsc **0**, eslint **0**, vitest **2912/2912**, `db:gate` **182/182** |
| stand revision | full run BEFORE the merge: **32 stands, 54 min, 32/32 green**. `EXPECTED_STANDS` **32** |
| deploy stamp | `GET /api/build` → `88320dc80fc4` for `main = 65c096a…` (expected value computed LOCALLY first — that is the whole point of the instrument) |

### Expected state (measured 2026-09-08, end of session 59, after package 41)

| what | expected |
|---|---|
| `main` / `dev` | **`5cad680`** (`--no-ff` merge) / **`4e2fed2`** (package 41), **plus the docs commit(s) of this handover on top** — take the hashes from `git ls-remote`. Tree clean |
| prod DB | **`0181_rf01_case_source_scope.sql`**, ledger **181/181**, file md5 `17f0b94460f65459e5d4b58a9ca80aa2` |
| **next migration** | **0182** — the number comes FROM THE LEDGER, never from the folder |
| `invariants_check()` | `ok:true`, **`checked:22`**, `failed:[]` — 0181 did NOT touch the counter, so `bump-checked-pins.mjs` was NOT run |
| guard body | `md5(replace(prosrc, chr(13), ''))` = **`19b47366fc60ce602f0642a1924ec779`**, length **95038**, CR 0. Normalized pin g = **`f157d9de47d29abdf24a96ce89b04b6e`**. Both taken from the FILE 0181 (instrument verified on 0180: it reproduces `c7670d89…`/`caecded8…`/94298) and from PROD after the apply — equal |
| nightly jobs | `outbox-retention` 03:30, `audit-retention` 03:40, `invariants` 03:50 — schedule verified BY QUERY against `cron.job` (id 13, `50 3 * * *`, active), 9 active jobs total. ✅ The 08.09 03:50 run is already checked: `maintenance_runs` id **113**, `ok:true, checked:22, failed:[]` — and it was the first nightly with `checked:22` at all (07.09 and 06.09 both 21) |
| toolchain | tsc **0**, eslint **0**, vitest **2876/2876**, `db:gate` **181/181** |
| stand revision | full run BEFORE the merge on a clean tree: **30 stands, 712 addressed, 67 min**, **30/30 green** (report `falsify-all.md`, 08.09 00:25 UTC). `EXPECTED_STANDS` **30** (new `falsify-0181`: 11 mutations, 8 addressed). ⚠️ It was launched through a one-shot `schtasks` task and finished AFTER the desktop bridge dropped — that is exactly why the task, not a foreground run, is the canon here |
| deploy fingerprint | ✅ **FIXED IN PACKAGE 42 — and it is now a TWO-DIRECTION signal.** `GET /api/build` returns `{stamp, reason, env}` where `stamp = sha256(VERCEL_GIT_COMMIT_SHA)[:12]`. Compute the expected value LOCALLY from the SHA you just pushed and compare — equal means THAT commit is live, not merely «something arrived». Measured 08.09 08:52 UTC on `main = 390e9f1…`: expected `2b6d33a49cc4`, prod returned `2b6d33a49cc4`, `reason: null`, `env: production`, `cache-control: no-store`. Build latency still 4–9 min. ⚠️ It says WHICH commit is served, NOT that the build is healthy — that stays with live checks |

#### ⚠️ TWO DOC LIES FOUND BY MEASUREMENT (session 59, package 41)

1. **`vitest 2869/2869` at commit `38ff249` is wrong.** Measured on `38ff249` itself
   (separate worktree, the 0181 file removed): **2873**. The number in the docs was taken
   BEFORE the docs commit, and several specs enumerate migration and doc files through
   `it.each`. After package 41: **2876**.
2. **The fingerprint instrument `/_next/static/<buildId>/_buildManifest.js` → 200 did not
   work on this application** — `/login` carries no buildId at all, `_buildManifest` never
   appears in the page, the id recorded at the end of package 40 is absent from what prod
   serves, and twelve candidate tokens probed as manifest paths all returned 404. ✅ **CLOSED
   by package 42**, which replaced it with `/api/build` — see the row above and
   `docs/audit/PR-42-deploy-stamp.md`. Keep the lesson: two consecutive sessions recorded a
   fingerprint number that neither could reproduce, because nobody pinned the INSTRUMENT.

### Expected state (measured 2026-09-07, end of session 59, after package 40)

| what | expected |
|---|---|
| `main` / `dev` | **`41e7e5c`** / **`6a7dcef`** (package 39), **plus the docs commit(s) of this handover on top** — take the hashes from `git ls-remote`. Tree clean |
| prod DB | **`0180_grant_digest.sql`**, ledger **180/180**, file md5 `71814091da891580734f8362faafe5ea` |
| **next migration** | **0181** — the number comes FROM THE LEDGER, never from the folder |
| `invariants_check()` | `ok:true`, **`checked:22`**, `failed:[]` — 0180 ADDED check №22 `grant_digest` (RF-04); `bump-checked-pins.mjs 21 22` rewrote nine smokes, and `docs/ops-cron.md` was fixed BY HAND (the bump script only walks `supabase/smoke`) |
| guard body | `md5(replace(prosrc, chr(13), ''))` = **`caecded86d138146d518fbbc1b71b740`**, length **94298**, CR 0. Normalized pin g = **`c7670d890ac9737cdcb0e0aade0e4957`**. Both taken from the FILE 0180 (instrument verified on 0179: it reproduces `71e552c2…`/`5e468b5e…`/80871) and from PROD after the apply — equal |
| nightly jobs | `outbox-retention` 03:30, `audit-retention` 03:40, `invariants` 03:50. ⚠️ The 08.09 03:50 run will be the FIRST nightly one on the 0180 body and the FIRST EVER for check №22 — check it reports `ok:true, checked:22, failed:[]` |
| toolchain | tsc **0**, eslint **0**, vitest **2869/2869** (+17 over package 39), `db:gate` **180/180**, build log `[migration-gate] OK: 180/180` — i.e. decision `run` on a machine WITH keys (RF-05: without keys `--build` is exit 1 unless `RADFLOW_GATE_NO_DB=1`; on Vercel nothing bypasses) |
| stand revision | full run after package 40: **29 stands, 704 addressed, 103 min**. 27/29 green in the batch; two (`falsify-0166`, `falsify-u30`) failed as «прогін не відбувся» — an EMPTY vitest report under machine load, not a guard failure — and were re-run INDIVIDUALLY: **60/60** and **15/15**, both positions red as designed. `EXPECTED_STANDS` **29**. ⚠️ Read a red stand with an empty facts table as «did not finish» and re-run it alone before believing it |
| `/login` fingerprint | **`sk6WLPyxCWYIN-GSgGAAE`** at 21:06Z (+9 min after the package-40 merge `0da8a86`); the docs commit(s) carrying this table will move it again — expect it to DIFFER; if it does not, record the fact and read the one-direction rule above |

### Expected state (measured 2026-09-06/07, end of session 58) — HISTORY

| what | expected |
|---|---|
| `main` / `dev` | **`7fd1581`** / **`1788dcd`** (packages 35–37), **plus the docs commit(s) of this handover on top** — take the hashes from `git ls-remote`. Tree clean |
| prod DB | **`0178_rf09_invite_token_grant.sql`**, ledger **178/178** |
| **next migration** | **0179** — the number comes FROM THE LEDGER, never from the folder |
| `invariants_check()` | `ok:true`, **`checked:21`**, `failed:[]` — 0178 EXTENDED the existing `priv_drift` check rather than adding one, so the number did NOT move and `bump-checked-pins.mjs` was not run |
| guard body | `md5(replace(prosrc, chr(13), ''))` = **`6ff5dd3db1681620ff6ccef18904e7f2`**, length **77313**. Normalized pin g = **`10b3204c97781909c3e53a3f901056ec`**. Both verified against the FILE and against PROD separately |
| nightly jobs | `outbox-retention` 03:30, `audit-retention` 03:40, `invariants` 03:50. ✅ **The 07.09 03:50 run is the FIRST nightly one on the 0178 body and it came back `ok:true, checked:21, failed:[]`** — the three new RF-09 branches raise no false alarm on the scheduled path, not just when called by hand |
| toolchain | tsc **0**, eslint **0**, vitest **2798/2798** (**94** files), `db:gate` **178/178** |
| stand revision | **27/27 green, 644 addressed**, a full run took **~44 min**. `EXPECTED_STANDS` **27**; new stand `falsify-rf09` — 28/28, 25 addressed, 3 positive controls. ⚠️ The first run was 26/27: the 0178 reprint made two anchors in `falsify-0166` non-unique (N17, N53) — re-anchored with a preceding line |
| `/login` fingerprint | **`vQtASefO7hWs9piyM8iv9`** — measured 07.09 09:44 UTC, twice, both at `x-vercel-cache: MISS`, `age: 0`. It moved from `XEfZ9gvV38zNgfK4T-Gfq` after the DOCS merge `4c5e21e` — one more data point for "every commit rebuilds" and against the refuted "a docs commit does not rebuild". ⚠️ The docs commit carrying this very table will move it again, so expect it to DIFFER; if it does not, record the fact and read the one-direction rule above instead of declaring an incident |

⚠️ **The eslint gate runs with `--max-warnings 0`.** Clean up scratch files.

⚠️⚠️ **RUN THE FULL STAND REVISION ONLY ON A CLEAN TREE, AND TOUCH NOTHING
WHILE IT RUNS.** Session 58 knew this rule and broke it anyway: I edited
`claude/radflow-handoff.md` while `falsify-all.mjs` was running. It checks the
tree between stands, saw a modified file, read it as "the stand failed to
restore the live files", **stopped the revision on the very first stand and
reverted my edit with `git checkout --`**. An hour of run time and the text of
the edit, gone. Write the docs before or after — never in parallel.

---

## WHAT SESSION 59 DID — TWO packages (38, 39): RF-09 closed on all four channels, RF-05 closed in code

Full detail with the measurements: `claude/radflow-handoff.md` (top block),
`docs/audit/PR-0179-rf09-definer-audit.md` (38) and
`docs/audit/PR-RF05-gate-fail-closed.md` (39).

| item | what |
|---|---|
| **Package 39 — RF-05** | `scripts/migration-gate.mjs` had TWO silent fail-opens (skip variable honoured everywhere incl. Vercel and via `.env.local`; `--build` without keys → soft skip, and CI passed on exactly that). Now a pure `gateEnvDecision` in `migration-gate-lib.mjs`: on Vercel (`VERCEL=1`) NOTHING bypasses (skip / `RADFLOW_GATE_NO_DB` / missing keys → exit 1, message names the variable set); outside Vercel skip only for `--build` with WARN «БЕЗ ЗВІРКИ»; no keys in `--build` → exit 1 unless `RADFLOW_GATE_NO_DB=1` is said explicitly (`gate.yml` does). Prod build unchanged (`OK: 179/179`). `AGENTS.md`/`ROLLBACK.md` no longer recommend a bypass that now kills the Vercel build. No migration |
| **Package 39 — audit event** | `/api/staff/password` emits `staff.access_changed` `{action: password_reset\|password_set, targetRole}` AFTER both writes, no token/password in details, `clinicId` = the admin's clinic (the CEO sees it via the grant). Titles «скинув/встановив пароль керівника / направника / співробітника» — approved by the owner. Found by the behavioural test: the route did not take `user` from the gate → `ReferenceError` on EVERY call |
| **Package 39 — reviews/stand** | 11 findings closed (one-line early `return` invisible to the pin; double could not fail GoTrue → `authUpdateError`; CEO grant gate had no negative tests — the RF-09 path itself; `VERCEL: ""` ≠ unset; docs recommending the bypass; title hid the target role), 1 rejected, 2 named debts (PII key list lacks `password`/`pw` — DB CHECK mirror, needs a migration; `profiles.update` error ignored after the auth write — pre-existing). `falsify-rf05` 28/28, 26 addressed; `EXPECTED_STANDS` **28**; tsc caught a spec type error vitest cannot see |
| **RF-09b** | `ceo_list_for_clinic` returns `null::text as invite_token`; its body is now in №19 (22 → 23). `CeoManager` follows the package-37 rule: `freshTokens` map from route responses, three card states, `forgetToken` on set/revoke/delete |
| **RF-09c** | `fn_audit` writes `before/after` without the `invite_token` key; the 4 historical rows cleaned by explicit ids with after-md5 pins inside the migration; №15 (g) — no non-empty token anywhere in `audit_log` |
| **RF-09d — NEW** | `/api/ceo/grant` returned the STORED token (or silently wrote a new one) for any EXISTING profile with `password_set=false` — an admin of clinic B with the login of an un-activated staff member of clinic A got the token silently, under service_role, past 0178 and 0179. Closed in code (owner's variant A): token only for an account created by this call; response +`ceo_id`, +`role`, +`password_set`. Behavioural test `tests/ceoGrantRoute.test.ts` on a double that now has `insert/update/auth.admin` and a query log |
| **№15 (g2)** | no SECURITY DEFINER function with client EXECUTE touches `invite_token` (result signature, arguments, BODY TEXT) or returns `profiles` whole; the one exception is `ceo_list_for_clinic`, whose body №19 pins. Named boundary: `returns jsonb` with `to_jsonb(p)` and no `invite_token` in the body is not caught |
| **product** | cross-role member (staff/referrer of another clinic with a CEO grant) without a password no longer gets a hint pointing at «Скинути пароль», which returns 403 for them — the route returns `role`, the hint and toast branch (review B) |
| stands | `falsify-rf09` 25 → 44 addressed; `EXPECTED_STANDS` stays **27**; full revision 27/27, 663 addressed, ~72 min |
| apply path | sections 1–3 verbatim via MCP; the 1400-line guard reprint through a DO block that rebuilds the body from the 0178 prosrc with five anchored replacements, md5 asserted equal to the file before and after `create or replace`, whole catalog row verified after apply. The 95 KB file was produced by two independent generators (python in the container, node on the owner's machine) with one md5 |
| `claim_token` | measured and EXCLUDED: a transient CAS marker (0089), read by nobody, only ever nulled by two RPCs, 0 rows with a value — a dead-column debt, not a security finding |

## LESSONS OF SESSION 59

1. **A guard branch that reads a SIGNATURE is not a guard over DATA.** The
   first (g2) checked `pg_get_function_result` for the word `invite_token`;
   `returns setof profiles` carries no column name at all. Both review rounds
   found it independently; the branch was widened to arguments, body text
   and `prorettype = profiles` before the apply — and the probe with
   `returns setof public.profiles` went red for `anon` too, because a new
   function gets EXECUTE for PUBLIC by default.
2. **A count pin on a list is a landmine for the next reprint.** The №19 test
   pinned "exactly 22 rows"; committing 0179 would have reddened the gate
   exactly when the ledger was already 179/179 and the file could not be
   withdrawn (symmetric gate). Review A caught it as a BLOCKER.
3. **The two lenses agree on the code and still find different things.**
   Falsification found the untested reactivation branch, the single-role
   fixture and the key-not-value assertion; operations found the hint that
   led the operator to a button returning 403. Neither would have found the
   other's.
4. **A hostile double that can only READ cannot test a route that WRITES.**
   It grew `insert`/`update`/`auth.admin` and a query log — and the log
   mattered at once: `seen` kept only the LAST query per table, so a dirty
   select made first was invisible.
5. **Pins by PRESENCE fell again** (comment-out, call in the error branch,
   `return null` before the node, `setFreshTokens({})` instead of the
   literal). Cure: strip comments, match inside the success-path WINDOW,
   forbid any `setFreshTokens` inside `reload()` — applied to all three
   managers, since package 37's pins had the same gap.
6. **"Success. No rows returned" was not the proof — and the first
   `invariants_check` after the apply was RED on `ledger_md5`,** exactly as
   it must be until `npm run db:gate` stamps the file. Read the failed list;
   do not read the colour.
7. **The pasted opening text and the attachment disagreed** — one package
   apart. The reconciliation cost a paragraph; the fix is a rule in the
   attachment header.

## WHAT SESSION 58 DID — THREE packages, one migration, the LOW batch emptied (HISTORY)

Full detail with the measurements: `claude/radflow-handoff.md` (top block),
`docs/audit/PR-U59-U60-ack-visibility.md`, `docs/audit/PR-RF01-RF08-remeasure.md`,
`docs/audit/PR-0178-rf09-invite-token.md`.

| item | what |
|---|---|
| **U-59** | ack no longer clears unread marks while the tab is in the background. The decision lives in `lib/ackVisibility.ts` (`ackGate`), the freeze arithmetic in `nextFreeze`, document visibility in `lib/useDocumentVisible.ts` behind an injectable host (so it is testable without DOM) |
| **U-60** | "zero" and "we don't know" are no longer the same pixel. `lib/sidebarBadge.ts`; unknown renders as a quiet grey `—`. ⚠️ Measured THREE places, not the one the doc named |
| **U-75** | **CLOSED WITH NO CODE** — its stated defect has been false since session 52 |
| **package 36 (Р6)** | RF-01 … RF-08 re-measured, no code. Two High are dead; three findings are partial; **one NEW High found — RF-09**. `docs/audit/PR-RF01-RF08-remeasure.md` |
| **package 37 (RF-09)** | migration **0178**: table-level SELECT on `profiles` revoked from `anon`/`authenticated`, column allow-list of 14 of 15 put back — without `invite_token`. Screens take the token from the issuing route's RESPONSE (`lib/inviteLink.ts`). ⚠️ **One channel of three — RF-09 is NOT closed**; see the queue below |
| stands | new `falsify-u59-u60` (33/33, 31 addressed) and `falsify-rf09` (28/28, 25 addressed, 3 positive controls); `EXPECTED_STANDS` 25 → **27** |
| **RF-1** | dug out and struck off — see below |
| deploy gate | ✅ verified from the BUILD LOG, not the doc: it runs for real in prod. Settings hold the keys with scope Production and Preview; `RADFLOW_SKIP_MIGRATION_GATE` exists nowhere |

## LESSONS OF SESSION 58 (HISTORY)

1. **A guard written in the same hour is exactly as much a suspect as someone
   else's old code.** Two review rounds found FOUR ways past my own fresh pins,
   each leaving every test green: the background flag folded in at the CALL
   SITE (`surfaceVisible: visible && documentVisible`); the visibility store
   with ZERO stand positions (three one-character edits silenced it while both
   lexical pins stayed green); success flags pinned by PRESENCE rather than
   PLACE (moving `set*Ok(true)` above the error branch brings U-60 back in all
   three places at once); and a value pin cut off mid-expression.
2. **The first edition closed U-59 where it almost never fires.** `hold` kept
   the freeze but not the KEY inside it, so a surface with `refreezeKey` that
   reloaded in the background came back with a stale key and refroze on the
   first run under a visible tab — clearing exactly what the person had not
   seen, ~200 ms after they switched back. And the comment claimed the opposite.
3. **The shorter the anchor, the less surface to go stale.** Re-anchoring
   another stand took TWO attempts: the first new anchor spanned six lines and
   broke on a comment inserted in the MIDDLE of the block.
4. **A doc's list is a HYPOTHESIS — the ninth and tenth time in this project.**
   U-75's stated defect was already cured, differently and better, in session
   52; U-60's "one place" was three.
5. ⚠️ **And the worst one was mine, not inherited: I rewrote the deploy
   fingerprint rule TWICE in one session.** First I refuted session 57's
   version from two measurements, wrote my own into five docs — and forty
   minutes later the third measurement broke it. That is exactly the failure
   this project keeps catching, committed by the person writing the warning
   about it. The cure is not a better rule but a smaller claim: the fingerprint
   is a positive signal, and "unchanged" is a fact, not a diagnosis.
6. ⚠️ **A GREEN BASELINE VALIDATES THE INSTRUMENT, NOT THE QUERY.** I reported
   RF-01 as still live because a search for `radiologist_rooms` in the policy
   text came back empty — and I had a green baseline (`auth_clinic_id` WAS
   found), so I trusted it. But the policy calls the helper
   `auth_radiologist_room_ok(room_id)`, not the table. The baseline proved the
   tool was reading the text; it proved nothing about my search term. Before
   writing "not found", find something that MUST be found **by that same
   query**, not by a neighbouring one.
7. ⚠️ **NINE ways past my own pins in one session — four in package 35, five
   in package 37.** The stand caught two of the five; review caught three, and
   every one of them left the WHOLE gate green: zeroing the token map inside
   `reload()` (the link vanishes a second after it is issued, because `reload()`
   fires on every tab focus); splitting `from("profiles")` from `.select()`
   through a variable, which blinds a lexical pin while its "at least one
   select exists" safety net stays satisfied by the OLD, clean query; and
   deleting the hint from the JSX while leaving the constant imported. The
   pattern across all nine: **pins that check PRESENCE rather than PLACE.**
8. ⚠️ **A pin that reddens on a benign refactor will be removed — so remove it
   yourself and replace it.** One package-37 pin went red when the column list
   was extracted into a named constant. That is lesson 0141 arriving in person:
   a permanently red check is a deleted check. It was replaced by a stricter one
   that accepts both forms, and a third positive control was added for exactly
   that shape. Also: a hard-coded count (`toBe(2)`) blocked the FIX for a third
   issuance path — count the paths, do not hard-code the number.
9. ⚠️ **A reprint of the guard breaks stands pinned to the previous edition, and
   it does it SILENTLY.** The full revision came back 26/27: migration 0178 made
   two anchors in `falsify-0166` non-unique — one because branch (f2) repeats an
   existing role subquery verbatim, the other because a short anchor matched as
   a SUBSTRING inside two new branches with deeper indentation (1 → 3). Both
   re-anchored with a preceding line. **Budget a full revision after every
   reprint, and expect to pay in re-anchoring.**
10. ⚠️ **And I broke a rule I had written down myself two hours earlier:** I
   edited `claude/radflow-handoff.md` while the revision was running.
   `falsify-all.mjs` read the modified file as "a stand failed to restore the
   live files", stopped on the first stand and reverted my edit with
   `git checkout --`. An hour of run time and the text, gone. Knowing a trap is
   not the same as respecting it while impatient.

---

## QUEUE FOR SESSION 60 — a menu, not an order

⚠️ **Ask before coding.** Compose a plan (`TaskCreate`) and **AGREE THE FIRST
PACKAGE WITH ME BEFORE WRITING CODE.** If a package is product-facing, show me
the texts before they land.

✅ **RF-09 is CLOSED on all four channels (0178 table ACL; 0179 definer-RPC and
audit trail; code for the issuing route). Item 1 below is HISTORY — kept for
the measurements it carries; the live queue starts at item 2.**

1. (HISTORY — session 58's wording) ⚠️⚠️ **RF-09 (High) — PARTIALLY CLOSED: one channel of three. Migration
   `0179` closes the other two, and it is the top of the queue.**
   Package 37 (`0178`) removed the TABLE-level SELECT grant on `profiles` from
   `anon` and `authenticated` and put back a column allow-list of 14 of 15
   columns, without `invite_token`. Measured live under the role, both ways:
   `select invite_token` → **42501**, `… where invite_token = 'zz'` → **42501**,
   `select id, login, role, password_set` → passes, `select *` → 42501 (the
   named cost; there is no such query anywhere in the tree).
   ⚠️ The measurement worth carrying forward: a column-level
   `revoke select (col)` ON TOP of a table grant does **nothing** —
   `has_column_privilege` stays true. Only «revoke ON TABLE + grant by column»
   removes access. That is also why the new guard branch tests
   `has_column_privilege` and not `has_table_privilege`.
   ⚠️ And UPDATE was never the hole: trigger `trg_guard_profile_privileges`
   (0064) rejects service-field writes with 42501. Package 36's wording
   ("`authenticated` also has UPDATE") is true of the grant and false of the fact.

   **The two channels still open, both confirmed by query against prod:**
   * **RF-09b — `ceo_list_for_clinic`**: SECURITY DEFINER, `EXECUTE` granted to
     `authenticated`, returns `invite_token` for `role='ceo'` accounts. A
     column grant does not constrain a definer function at all. Escalation: a
     CEO holding `ceo_access` on two clinics; the admin of clinic B reads their
     token and takes over an account that sees clinic A. Not burning: 1 active
     CEO grant, 0 CEOs with two clinics, 0 live tokens.
     ⚠️ This function is **absent** from check №19 `guard_fn_bodies` — the
     `auth_is_admin()` gate inside it can be removed and no invariant reddens.
   * **RF-09c — `audit_log`**: trigger `fn_audit` writes the whole `profiles`
     row. Measured: 74 rows, **4 with a non-NULL token**, 2 of them with a real
     `clinic_id` → visible to that clinic's admin and to any CEO with an active
     grant. Not exploitable today: those 4 values are dead because
     `set-password` also requires `password_set = false`, and all 9 profiles
     have `true`.
   ⚠️ And the comment on the new branch (f) claims more than the branch checks
   ("the token is not readable by client roles") — it only looks at the table's
   column ACLs. Said out loud on purpose. Full write-up:
   `docs/audit/PR-0178-rf09-invite-token.md`.
2. **The residues of the eight, now that they are measured.** In order of what
   the measurement says: `sched_referrer_read` leaks non-granted room ids,
   hours and closures to a referrer through the `rooms jsonb` column (RF-03);
   no regression check on grants, so one `GRANT` silently reopens RF-04;
   ~~the deploy gate has TWO fail-opens and CI relies on one of them (RF-05)~~
   — **CLOSED by package 39** (`gateEnvDecision`, no bypass on Vercel, CI
   skip explicit; `docs/audit/PR-RF05-gate-fail-closed.md`);
   leaked-password protection is still off — one switch, the cheapest item in
   the whole audit (RF-08); and `add_case_step_rpc` was not traced to the end
   (RF-01). ⚠️ RF-04 is now guarded for `profiles` only (0178 (f)/(f2)); the
   general "one GRANT reopens it" claim still stands for every other table.
   RF-08 re-measured 07.09 via `get_advisors`: still **WARN — disabled**.
3. **The second half of U-59 — "the surface is covered by a modal".** ⚠️ The
   cost was OVERSTATED by my own first comment and is now measured: the flag
   already exists (`anyModalOpen`, `QueueBoard.tsx:1589`) and its COMPLETENESS
   is already guarded by the session-52 test. What is missing is a fourth
   `ackGate` input `overlayShown` with outcome `hold` plus one prop into the
   row — on the order of ten lines. By frequency this is MORE common than a
   background tab: a registrar has a modal open a noticeable part of the shift.
4. **Live checks** — the cheapest big one is a single run through
   `RescheduleModal` with a chosen slot; then Ф4-8 (timer ring and sound),
   Ф4-2 (call-window edges), the `cas` scenario, and Г1-F itself. A staff
   session is live in both reachable browsers, so this needs no password — but
   it means acting as the owner in production. Ask before every step that
   writes, and do nothing irreversible.
5. **The named debts below.**

## FORKS Р1–Р5 — these cannot start without the owner's decision

Full text with the measurements: `claude/plan-s57.md` §3. **Р6 is DONE** (the
RF-01…RF-08 re-measure, package 36). Р1–Р5 unchanged by sessions 58 and 59.

✅ **Р6's one open question is now CLOSED — measured on the dashboard, 06.09,
Production deployment `36a9a42` (`AizJDW1o8…`), build log line 19:18:30.562:**

```
> node scripts/migration-gate.mjs --build && next build
[migration-gate] OK: 177/177 міграцій звірено з леджером.
```

**The gate runs for real in production.** That single line rules out both
failure modes at once: the soft-skip branch would have printed "немає
NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", and the bypass branch
would have printed "WARN: пропущено через RADFLOW_SKIP_MIGRATION_GATE=1".
Corroborated by Settings → Environment Variables: `SUPABASE_SERVICE_ROLE_KEY`
and `NEXT_PUBLIC_SUPABASE_URL` both exist with scope **Production and Preview**
(added 17.06), and a search for `RADFLOW` returns **No Results Found** in both
the Project and the Shared tab — the bypass variable does not exist anywhere.
The build's only warning is `npm warn allow-scripts` (esbuild, unrs-resolver),
unrelated to the gate.

⚠️ Re-measure this whenever the ledger count changes: the number in the log is
the assertion, and `OK: N/N` with the wrong N is still a green line.

| # | fork | what has been measured so we do not decide blind |
|---|---|---|
| **Р1** | the CASE path for Г1-F — duplicate the clock guard on the server? | The case steps are captured by `buildPayload()` long before submission, so a naive claim would go stale and the guard would reject HONEST work. Needs a claim taken at submit time, ~2 h |
| **Р2** | the rule "where an audit trigger is required" (the named boundary of 0173) | Today the list says "these six must exist", not "audit must exist everywhere it is needed". A NEW table with PII and no audit trigger is invisible to everyone |
| **Р3** | extend list №19 to the 38 schedule trigger functions? | A trigger function body is touched by 8 of the last 30 migrations vs 4 of 30 for the current list — twice as many 1100-line reprints. Two named candidates, both measured: `update_patient_details(uuid,jsonb,jsonb)` (the only live defence against U-66) and `tg_change_markers_queue()` (SECURITY DEFINER over a PII table) |
| **Р4** | Playwright / E2E by role | The project has no browser test at all, **by design**. This is the decision to create the first one |
| **Р5** | `user_change_markers` → `REPLICA IDENTITY FULL` | Both sides measured. Today a DELETE of a marker never reaches the subscriber and the dot clears by a 60-second reconciliation. With FULL it clears in <1 s, but on DELETE `apply_rls` evaluates no RLS at all — content does not leak (payload trimmed to PK), the FACT and the TIME do. ⚠️ Check №21 holds the exception assertively, so on the day of the switch the guard itself goes red and demands the exception be removed. That is by design |

## NAMED DEBTS — open, each with the place it lives

- ~~**No audit EVENT on password reset**~~ — **CLOSED by package 39** (event
  `staff.access_changed` / `password_reset|password_set`, after both writes).
  Two debts it left NAMED: `lib/importantEvents.ts` PII key list has no
  `password`/`pw` (it mirrors the DB CHECK of 0128/0160 — needs a migration,
  not a one-line edit); `/api/staff/password` ignores the `profiles.update`
  error after the auth write (pre-existing) — on that failure the response
  carries a token that is not in the DB.
- **`waitlist_entries.claim_token` is a dead column** since 0100 (the atomic
  RPC clears it and nobody reads it) — NOT a secret, measured in 59. Drop it
  or say why it stays.
- **`fn_audit` swallows every error** (`exception when others then null`) —
  a silently dead audit trail is invisible to every invariant. Adjacent to Р2.
- **Guard №15 (g2) boundary:** a definer RPC `returns jsonb` built with
  `to_jsonb(p)` and no `invite_token` in its body is not caught.
- **Live browser check of the CEO card** under an admin — still not done
  (37 and 38 both shipped on unit tests and stands only).
- **The second half of U-59 (modal overlay)** — cost corrected, see queue item 3.
- **`incidentCount` in the staff sidebar** is still a two-state falsy gate: its
  load state arrives as a finished number from `QueueBoard`
  (`liveIncidents.length`). NOT examined in package 35.
- **The `services` surface** is the only permanently-visible one without a
  `refreezeKey`: the freeze is taken once, so a marker that arrives later never
  clears until F5. Older than package 35 (from session 28).
- **`Sidebar` reads `loadWaitCount` twice on mount** — its own `useEffect` plus
  the initial `callAll` without `skipInitial`. Same class as U-62/Д5.
- **`room_id` in `queue_reschedule_rpc`** — the second half of the U-66 finding,
  not covered by 0176. Same class again in **`updateWaitlistEntry`**.
- **No consolidated list of the visibility columns of `queue_entries`**
  (`{referrer_id, clinic_id, room_id, created_by, case_id}`).
- **The "assigned" event reuses `referral.patient_data_changed`.**
- **12 of the 26 stands still do not use `verdictOf`** — descended from U-80б.
- **Subscriptions with a CONDITIONAL `router.refresh()`** did not get
  `skipInitial`.
- **The body of `tg_change_markers_queue`** is pinned by nothing — adjacent to Р3.
- **The stand runs only `vitest`, not `tsc`/`build`** — a mutation that breaks
  TYPES but not syntax passes through esbuild, so "the mutation broke the build"
  only catches syntax and crashes.

### Open questions for the owner: the five forks above, and nothing else

⚠️ **RF-1 is CLOSED as a question** (struck off — it never had a description).
But its dig opened Р6, which the owner has already approved and which is done.

Decisions made in session 59 — do not reopen: RF-09d variant A (the issuing
route returns a token ONLY for an account it created; an existing account
gets its link via «Скинути пароль»); `claim_token` is out of scope of RF-09;
the three CEO-card texts (foreign-role hint, foreign-role toast, build-skew
toast) are approved and shipped.

Decisions already made — do not reopen: branch protection on `main` stays OFF;
the service-role key rotation is tied to the first real centre with real
patients (so the audit verdict stays at CONDITIONAL GO); the DEFERRED day-shift
window on the boards is not a problem; the `returned` banner texts and the short
`CLOCK_SKEW_MSG` are approved; the two test `queue_entries` from 31.08 are the
owner's own; the U-59 background semantics (freeze survives the background) and
the U-60 unknown-badge look (quiet grey `—`) are approved and shipped.

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
7. **The PR doc of session 58:** `docs/audit/PR-U59-U60-ack-visibility.md` —
   U-59, U-60, why U-75 needed no code, the four ways review found past my own
   fresh pins, and the corrected deploy-fingerprint rule.
8. **The PR docs of session 57** (all in `docs/audit/`):
   `PR-0174-invariants-fail-loud.md`, `PR-0175-profiles-no-default.md`,
   `PR-U65-realtime-clinic-filter.md`, `PR-U66-visibility-widening-update.md`,
   `PR-0176-visibility-widen-last.md`, `PR-0177-realtime-filter-premise.md`,
   `PR-U81-stand-exit-code.md`, `PR-U62-refetch-policy.md`,
   `PR-U62-initial-load.md`.
9. **`docs/ops-cron.md`** — the registry of the nightly jobs (10 tasks;
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
