/**
 * Піни пакета 0206 (с84, контур платформи): три таблиці deny-all
 * (`platform_operators`, `platform_accounts`, `platform_log`), функція
 * `platform_clinic_stats()` лише для service_role, передрук сторожа (№23 —
 * шість ключів із дайджестами, заміряними на проді; №24 — оператор без профілю
 * не сирота; два абзаци; самопін №25) і код контуру (`lib/platformContract.ts`,
 * `lib/platformClaim.ts`, маршрути, консоль).
 *
 * ЩО ТРИМАЄ ЦЕЙ ТЕСТ (статично, з ТЕКСТУ файлів):
 *  • файл міграції: один заголовок передруку, пін = тілу, `checked` 26, begin /
 *    commit по одному, леджер останній, ВІДКАТ у кінці, жодного `raise notice`;
 *  • тіло сторожа: код без коментарів = код 0205 + РІВНО сім рядків (шість рядків
 *    №23 з дайджестами генератора і одна умова №24); список №23 відсортований,
 *    90 ключів; перевірки №1–№22, №25, №26 байт у байт ті самі;
 *  • DDL: три таблиці з RLS, revoke від public/anon/authenticated, CHECK статусу =
 *    `CLINIC_STATUSES`, CHECK ПДн = `PLATFORM_LOG_FORBIDDEN_KEYS`, форма action =
 *    регулярці контракту; функція INVOKER (без `security definer`), EXECUTE лише
 *    service_role; `clinics` DDL не торкається (пін `k:clinics` у tzKyivPhase2);
 *  • фраги: маркери відкату, бюджет часу зовні блоку, lock_timeout, search_path;
 *    накат без поведінкової проби, сухий прогін і фальсифікація — з нею; відкат
 *    відмовляє на непорожніх таблицях і знімає рядок леджера ДО повного сторожа;
 *  • смоук: один блок, 26, SMOKE_OK / SMOKE_SKIP, без commit;
 *  • контракт: дії журналу проходять CHECK форми, статуси входу ⊂ статусів,
 *    claim-модуль без імпортів (edge), types.ts знає нові таблиці й функцію;
 *  • AGENTS.md описує контур (розділ «Платформа»).
 *  НЕ тримає поведінки в живій базі — її доводять сухий прогін, смоук і
 *  фальсифікація (протокол — `docs/audit/PR-0206-platform-operators.md`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { guardBodyOf, pinFor } from "../scripts/migration-gate-lib.mjs";
import {
  CLINIC_STATUSES, LOGIN_BLOCKED_STATUSES, PLATFORM_ACTIONS, PLATFORM_ACTION_LABEL, PLATFORM_LOG_FORBIDDEN_KEYS, PLATFORM_LOG_DETAIL_KEYS, projectLogDetails,
  PLAN_MAX, STATUS_REASON_MAX, ACCOUNT_NOTES_MAX, OPERATOR_NAME_MAX,
} from "../lib/platformContract";

const MIGDIR = "supabase/migrations";
const MIG_FILE = "0206_platform_operators.sql";
const PREV_FILE = "0205_new_user_name_trim.sql";
const read = (p: string) => readFileSync(p, "utf8").replace(/\r/g, "");
const MIG = read(resolve(MIGDIR, MIG_FILE));
const PREV = read(resolve(MIGDIR, PREV_FILE));
const APPLY = read("scripts/frag/0206_apply.sql");
const DRYRUN = read("scripts/frag/0206_dryrun.sql");
const ROLLBACK = read("scripts/frag/0206_rollback.sql");
const FALSIFY = read("scripts/frag/0206_falsify.sql");
const SMOKE = read("supabase/smoke/0206_platform_operators_smoke.sql");
const GEN = read("scripts/build-0206-reprint.mjs");
const TYPES = read("supabase/types.ts");
const AGENTS = read("AGENTS.md");

const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const PRE_MD5 = "49cf5fb8af00195f1e656740248d8e43";
const PRE_LEN = 179066;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const TABLES = ["platform_operators", "platform_accounts", "platform_log"];
const FN_REGPROC = "public.platform_clinic_stats()";

/** Дайджести — з ГЕНЕРАТОРА (єдине місце, де вони записані руками після заміру). */
const NEW23: Array<[string, string]> = [...GEN.matchAll(/^\s+\["(([kt]):platform_[a-z]+)", "(\d+:[0-9a-f]{12})"\],$/gm)]
  .map((m) => [m[1], m[3]]);
const WHERE24_NEW = "   where not exists (select 1 from public.profiles p where p.id = u.id)\n     and not exists (select 1 from public.platform_operators o where o.id = u.id)\n     and u.created_at < now() - interval '15 minutes';\n";

const RP_NEW = guardBodyOf(MIG) as string;
const RP_OLD = guardBodyOf(PREV) as string;
const PIN = pinFor(RP_NEW) as string;

const list23 = (body: string) => {
  const open = "  ), expd(key, dig) as (values\n";
  let a = -1;
  for (let i = body.indexOf(open); i >= 0; i = body.indexOf(open, i + 1)) {
    if (body.startsWith("      ('e:", i + open.length)) { expect(a, "список №23 знайдено двічі").toBe(-1); a = i; }
  }
  expect(a, "список №23 (ключі e:) не знайдено").toBeGreaterThan(-1);
  const b = body.indexOf("\n  )\n  select array_agg(x.what order by x.what) into v_tmp", a);
  expect(b).toBeGreaterThan(a);
  return [...body.slice(a + open.length, b + 1).matchAll(/^ {6}\('([a-z]:[a-z_]+)','(\d+:[0-9a-f]{12})'\),?$/gm)].map((m) => [m[1], m[2]] as [string, string]);
};

describe("0206 — файл міграції", () => {
  it("генератор записав шість дайджестів, і саме вони стоять у тілі", () => {
    expect(NEW23.map(([k]) => k)).toEqual([
      "k:platform_accounts", "k:platform_log", "k:platform_operators",
      "t:platform_accounts", "t:platform_log", "t:platform_operators",
    ]);
    for (const [k, d] of NEW23) expect(RP_NEW, `у тілі немає рядка ${k}`).toContain(`      ('${k}','${d}'),\n`);
  });
  it("один заголовок передруку, пін = тілу, 0205 на диску — те тіло, від якого рахувались якорі", () => {
    expect((MIG.match(/^create or replace function public\.invariants_check/gm) || []).length).toBe(1);
    expect(MIG.indexOf("create or replace function public.invariants_check"))
      .toBe(MIG.search(/^create or replace function public\.invariants_check/m));
    expect(pinFor(RP_OLD)).toBe(PRE_PIN);
    const pins = [...MIG.matchAll(/comment on function public\.invariants_check\(boolean\) is '(guard_body_md5=[0-9a-f]{32};len=\d+)';/g)].map((m) => m[1]);
    expect(pins).toEqual([PIN]);
    expect(PIN).not.toBe(PRE_PIN);
    expect([...RP_NEW].length, "символи поза BMP — length PG ≠ JS").toBe(RP_NEW.length);
  });
  it("код без коментарів = код 0205 + рівно сім рядків (№23 ×6, №24 ×1)", () => {
    const o = codeOf(RP_OLD).split("\n"), n = codeOf(RP_NEW).split("\n");
    expect(n.length - o.length).toBe(7);
    const added = n.filter((l) => !o.includes(l));
    const removed = o.filter((l) => !n.includes(l));
    expect(removed).toEqual([]);
    expect(added.sort()).toEqual([
      ...NEW23.map(([k, d]) => `      ('${k}','${d}'),`),
      "     and not exists (select 1 from public.platform_operators o where o.id = u.id)",
    ].sort());
    expect(count(RP_NEW, WHERE24_NEW)).toBe(1);
    expect(count(RP_NEW, "\n  v_n := v_n + 1;\n")).toBe(26);
    expect(count(RP_OLD, "\n  v_n := v_n + 1;\n")).toBe(26);
  });
  it("список №23: 90 ключів, старі на місці, відсортований", () => {
    const o = list23(RP_OLD), n = list23(RP_NEW);
    expect(o).toHaveLength(84);
    expect(n).toHaveLength(90);
    for (const row of o) expect(n).toContainEqual(row);
    expect(n.map(([k]) => k)).toEqual([...n.map(([k]) => k)].sort());
  });
  it("перевірки №1–№22, №25, №26 — байт у байт ті самі (змінились лише №23 і №24)", () => {
    const cut = (body: string, from: string, to: string) => body.slice(body.indexOf(from), body.indexOf(to));
    expect(cut(RP_NEW, "  -- 1. ", "  -- 23. ")).toBe(cut(RP_OLD, "  -- 1. ", "  -- 23. "));
    expect(cut(RP_NEW, "  -- 25. ", "$function$")).toBe(cut(RP_OLD, "  -- 25. ", "$function$"));
    expect(count(RP_NEW, "'check', 'guard_fn_bodies'")).toBe(1);
  });
  it("форма файла: begin/commit по одному, леджер останній, ВІДКАТ у кінці, гучність, без зірочки-слеша в рядкових коментарях", () => {
    expect(count(MIG, "\nbegin;\n")).toBe(1);
    expect(count(MIG, "\ncommit;\n")).toBe(1);
    const tail = MIG.slice(MIG.lastIndexOf("insert into public.migration_ledger (name)"));
    expect(tail.startsWith(`insert into public.migration_ledger (name)\nvalues ('${MIG_FILE}')\non conflict (name) do nothing;\n\ncommit;\n`)).toBe(true);
    expect(MIG.indexOf("=== ВІДКАТ ===")).toBeGreaterThan(MIG.indexOf("\ncommit;\n"));
    expect(/raise (notice|warning)/i.test(codeOf(MIG)), "тихий сторож у коді файла (проза сторожа цитує raise notice — тому код без коментарів)").toBe(false);
    expect(/raise exception '0206: сторож перевірив % замість 26'/.test(codeOf(MIG))).toBe(true);
    expect(MIG.split("\n").filter((l) => /^\s*--/.test(l)).some((l) => l.includes("*" + "/"))).toBe(false);
    for (const t of ["$pre$", "$chk$", "$post$"]) expect(count(MIG, t), `тег ${t}`).toBe(2);
    for (const t of ["$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$q$", "$smoke$"]) expect(MIG.includes(t), `тег фрагмента ${t} у файлі`).toBe(false);
    /* порядок: предстан → DDL → функція → передрук → пін → $chk$ → $post$ → леджер */
    const seq = ["do $pre$", "create table if not exists public.platform_operators", "create table if not exists public.platform_accounts",
      "create table if not exists public.platform_log", "enable row level security", "revoke all on table",
      "create or replace function public.platform_clinic_stats()", "grant execute on function public.platform_clinic_stats() to service_role;",
      "create or replace function public.invariants_check", "comment on function public.invariants_check(boolean) is", "do $chk$", "do $post$",
      "insert into public.migration_ledger (name)"];
    let last = -1;
    for (const s of seq) { const i = MIG.indexOf(s); expect(i, `зник крок «${s}»`).toBeGreaterThan(last); last = i; }
    expect(count(MIG, "  v_res := public.invariants_check(false);")).toBe(1);
  });
  it("№24: виняток для операторів стоїть у запиті, а не лише у прозі; умова 15 хвилин збережена", () => {
    const q = codeOf(RP_NEW);
    expect(count(q, "and not exists (select 1 from public.platform_operators o where o.id = u.id)")).toBe(1);
    expect(count(q, "and u.created_at < now() - interval '15 minutes';")).toBe(1);
  });
});

describe("0206 — DDL пакета", () => {
  const ddl = codeOf(MIG.slice(0, MIG.indexOf("create or replace function public.invariants_check")));
  it("три таблиці: RLS увімкнено, revoke від public/anon/authenticated, жодної політики", () => {
    for (const t of TABLES) {
      expect(ddl).toContain(`create table if not exists public.${t} (`);
      expect(ddl).toContain(`alter table public.${t}`);
    }
    expect(count(ddl, "enable row level security;")).toBe(3);
    expect(ddl).toContain("revoke all on table public.platform_operators, public.platform_accounts, public.platform_log from public, anon, authenticated;");
    expect(/create policy/i.test(ddl)).toBe(false);
    expect(/alter table public\.clinics/i.test(codeOf(MIG)), "clinics DDL не торкається (пін k:clinics у tzKyivPhase2)").toBe(false);
  });
  it("CHECK статусу = CLINIC_STATUSES; CHECK ПДн журналу = PLATFORM_LOG_FORBIDDEN_KEYS; форма action; межі = контракту", () => {
    expect(ddl).toContain(`constraint platform_accounts_status_chk check (status in (${CLINIC_STATUSES.map((s) => `'${s}'`).join(", ")}))`);
    expect(ddl).toContain(`constraint platform_log_no_pii_chk check (not (details ?| array[${PLATFORM_LOG_FORBIDDEN_KEYS.map((k) => `'${k}'`).join(", ")}]))`);
    expect(ddl).toContain("constraint platform_log_action_chk check (action ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' and char_length(action) <= 64)");
    expect(ddl).toContain(`constraint platform_accounts_plan_chk check (plan is null or char_length(plan) <= ${PLAN_MAX})`);
    expect(ddl).toContain(`constraint platform_accounts_status_reason_chk check (status_reason is null or char_length(status_reason) <= ${STATUS_REASON_MAX})`);
    expect(ddl).toContain(`constraint platform_accounts_notes_chk check (notes is null or char_length(notes) <= ${ACCOUNT_NOTES_MAX})`);
    expect(ddl).toContain(`constraint platform_operators_full_name_chk check (char_length(full_name) <= ${OPERATOR_NAME_MAX})`);
    expect(ddl).toContain("status            text not null default 'trial',");
  });
  it("оператор — акаунт auth без профілю: FK на auth.users, без clinic_id, без user_role", () => {
    const op = ddl.slice(ddl.indexOf("create table if not exists public.platform_operators ("), ddl.indexOf("create table if not exists public.platform_accounts ("));
    expect(op).toContain("id          uuid primary key references auth.users(id) on delete cascade,");
    expect(op).not.toMatch(/clinic_id|user_role|profiles/);
    expect(codeOf(MIG)).not.toMatch(/alter type user_role/i);
  });
  it("слід переживає видалення центру й оператора: on delete set null на FK журналу й обліку", () => {
    expect(count(ddl, "references public.platform_operators(id) on delete set null")).toBe(5);
    expect(ddl).toContain("clinic_id          uuid references public.clinics(id) on delete set null,");
    expect(ddl).toContain("clinic_id         uuid primary key references public.clinics(id) on delete cascade,");
  });
  it("функція статистики: INVOKER, stable, search_path, EXECUTE лише service_role; пацієнтських колонок не віддає", () => {
    const fn = ddl.slice(ddl.indexOf("create or replace function public.platform_clinic_stats()"), ddl.indexOf("grant execute on function public.platform_clinic_stats() to service_role;"));
    expect(fn).not.toMatch(/security definer/i);
    expect(fn).toMatch(/\nstable\n/);
    expect(fn).toContain("set search_path = public, pg_temp");
    expect(fn).toContain(`revoke all on function ${FN_REGPROC} from public, anon, authenticated;`);
    expect(fn).not.toMatch(/patient_name|patient_phone|patient_email|patient_dob|studies|referrer_private|doctors/);
    expect(ddl).toContain(`grant execute on function ${FN_REGPROC} to service_role;`);
  });
});

describe("0206 — фрагменти і смоук", () => {
  it("маркери, бюджет часу зовні блоку, lock_timeout, search_path", () => {
    expect(DRYRUN).toContain("DRYRUN_0206_ROLLBACK");
    expect(FALSIFY).toContain("FALSIFY_0206 verdict=PASS");
    for (const [n, f] of [["apply", APPLY], ["dryrun", DRYRUN], ["rollback", ROLLBACK], ["falsify", FALSIFY]] as const) {
      expect(f, n).toMatch(/^set statement_timeout = '5min';\ndo \$[a-z]+\$\n/m);
      expect(f, n).toContain("perform set_config('lock_timeout', '5s', true);");
      expect(f, n).toContain("perform set_config('search_path', 'public, pg_temp', true);");
      expect(/raise (notice|warning)/i.test(codeOf(f)), `${n}: тихий сторож`).toBe(false);
    }
  });
  it("накат: DDL ПЕРЕД передруком (ревʼю с84 A-1: нове №24 читає platform_operators), старий №23 називає рівно шість new:, повний сторож один; проба лише в dryrun/falsify", () => {
    expect(APPLY).not.toContain("insert into auth.users");
    expect(APPLY).toContain("(поведінкова проба — лише у dryrun і falsify: тут транзакція комітиться)");
    expect(DRYRUN).toContain("insert into auth.users");
    expect(FALSIFY).toContain("insert into auth.users");
    const newKeys = `array[${NEW23.map(([k, d]) => `'new:${k}->${d}'`).join(", ")}]::text[]`;
    for (const [n, f] of [["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      expect(f, `${n}: очікування new: зі заміряними дайджестами`).toContain(newKeys);
      const ddl = f.indexOf("create table public.platform_operators (");
      const red23 = f.indexOf(newKeys);
      const reprint = f.indexOf("execute v_head || v_new || '$function$';");
      const pin = f.indexOf("execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);");
      const full = f.indexOf("  v_res := public.invariants_check(false);");
      const ledger = f.indexOf("insert into public.migration_ledger (name)");
      expect(ddl > 0 && ddl < red23 && red23 < reprint && reprint < pin && pin < full && full < ledger, `${n}: порядок DDL → зріз старого №23 → передрук → пін → повний сторож → леджер`).toBe(true);
      expect(count(f, "  v_res := public.invariants_check(false);"), `${n}: повний сторож рівно один`).toBe(1);
      expect(f, `${n}: явний грант service_role`).toContain("grant select, insert, update, delete on table public.platform_operators, public.platform_accounts, public.platform_log to service_role;");
      expect(f, `${n}: позитивний асерт прав service_role`).toContain("select 'no_service_role:' || t || ':' || p");
    }
    /* KNOWN_RED генератора — лише №13: «полагодити» A-1 внесенням auth_orphan_accounts
       у допуск означало б осліпити сторож і після DDL. */
    expect(GEN).toContain('const KNOWN_RED = ["gcal_sync_overdue"];');
    expect(count(APPLY, "where e.value->>'check' not in ('gcal_sync_overdue');")).toBe(1);
    expect(MIG).toContain("where e.value->>'check' not in ('gcal_sync_overdue')\n     and not (e.value->>'check' = 'ledger_md5'");
  });
  it("запити №3/№22/№23/№24 у накаті — дослівно з тіла (не переписані)", () => {
    const body = RP_NEW;
    for (const label of ["tables_rls_enabled", "grant_digest", "schema_digest", "auth_orphan_accounts"]) {
      const mark = `'check', '${label}', 'offenders', to_jsonb(v_tmp)));`;
      const m = body.indexOf(mark);
      const ifAt = body.lastIndexOf("  if v_tmp is not null then\n", m);
      const beginAt = body.lastIndexOf("  /* 0174 */ begin\n", m);
      const q = body.slice(beginAt + "  /* 0174 */ begin\n".length, ifAt);
      expect(q.length).toBeGreaterThan(80);
      expect(count(APPLY, q), `№ ${label} у apply`).toBeGreaterThanOrEqual(1);
      expect(count(DRYRUN, q), `№ ${label} у dryrun`).toBeGreaterThanOrEqual(1);
    }
  });
  it("відкат: відмовляє на непорожніх таблицях і на живих auth-акаунтах операторів, знімає функцію й таблиці від залежних до базової, рядок леджера — ДО повного сторожа", () => {
    for (const t of TABLES) expect(ROLLBACK).toContain(`(select count(*) from public.${t}) > 0 then`);
    /* р2, L-6: передумова шукає акаунти операторів за МЕТАДАНИМИ, а не за рядком
       (FK з каскадом робив «рядок є» тотожним «таблиця не порожня»). */
    expect(ROLLBACK).toContain("where u.raw_user_meta_data->>'platform' = 'operator'");
    expect(ROLLBACK).toContain("or u.raw_app_meta_data->>'platform' = 'operator') then");
    expect(ROLLBACK).not.toContain("join public.platform_operators o on o.id = u.id");
    const order = ["drop function if exists public.platform_clinic_stats();", "drop table if exists public.platform_log;",
      "drop table if exists public.platform_accounts;", "drop table if exists public.platform_operators;",
      `delete from public.migration_ledger where name = '${MIG_FILE}';`, "  v_res := public.invariants_check(false);"];
    let last = -1;
    for (const s of order) { const i = ROLLBACK.indexOf(s); expect(i, s).toBeGreaterThan(last); last = i; }
    expect(count(ROLLBACK, "  v_res := public.invariants_check(false);")).toBe(1);
  });
  it("фальсифікація: проби A–D, кожна повертає стан назад", () => {
    expect(FALSIFY).toContain("alter table public.platform_log disable row level security;");
    expect(FALSIFY).toContain("alter table public.platform_log enable row level security;");
    expect(FALSIFY).toContain("grant select on table public.platform_accounts to authenticated;");
    expect(FALSIFY).toContain("revoke select on table public.platform_accounts from authenticated;");
    expect(FALSIFY).toContain("alter table public.platform_log add column probe_col text;");
    expect(FALSIFY).toContain("alter table public.platform_log drop column probe_col;");
    expect(FALSIFY).toContain("array['new:t:platform_accounts:authenticated->SELECT']::text[]");
    expect(codeOf(FALSIFY)).toContain("'changed:t:platform_log:8:0a75467baf7d->9:%'");
  });
  /* р2, M-1: проба ролей не вакуумна — перевіряє, що роль перемкнулась, і що текст
     відмови називає САМЕ обʼєкт; у falsify — червона базова лінія з грантом. */
  it("проба клієнтських ролей: перемикання перевірено, відмова названа, у falsify — E/F червоні", () => {
    for (const [n, f] of [["DRYRUN", DRYRUN], ["FALSIFY", FALSIFY], ["SMOKE", SMOKE]] as const) {
      expect(f, `${n}: перевірка, що роль справді перемкнулась`).toContain("if current_user <> v_role then");
      expect(f, `${n}: відмова на таблиці мусить назвати таблицю`).toContain("if position(v_tbl in v_msg) = 0 then");
      expect(f, `${n}: відмова на функції мусить назвати функцію`).toContain("if position('platform_clinic_stats' in v_msg) = 0 then");
      expect(f, `${n}: роль повертається до postgres`).toContain("if current_user <> 'postgres' then");
    }
    expect(FALSIFY).toContain("grant select on table public.platform_operators to anon;");
    expect(FALSIFY).toContain("grant execute on function public.platform_clinic_stats() to authenticated;");
    expect(FALSIFY).toContain("raise exception 'falsify: E — проба ролей НЕ почервоніла з грантом';");
    expect(FALSIFY).toContain("raise exception 'falsify: F — проба ролей НЕ почервоніла з грантом';");
    expect(FALSIFY).toContain("verdict=PASS probes=A,B,C,D,E,F");
    expect(DRYRUN).toContain("probes=24,chk,pii,action,acl,stats,cascade");
    /* E/F стоять ПІСЛЯ поведінкової проби D і перед вердиктом. */
    expect(FALSIFY.indexOf("-- ── E. червона базова лінія")).toBeGreaterThan(FALSIFY.indexOf("-- ── D. поведінка ──"));
    expect(FALSIFY.indexOf("verdict=PASS probes=A,B,C,D,E,F")).toBeGreaterThan(FALSIFY.indexOf("-- ── F. червона базова лінія"));
  });
  it("смоук: один блок, бюджет зовні, 26 перевірок, SMOKE_OK / SMOKE_SKIP, без commit, власний пробний центр, константи = файлу", () => {
    expect(count(SMOKE, "do $smoke$")).toBe(1);
    expect(SMOKE).toMatch(/^set statement_timeout = '5min';\ndo \$smoke\$/m);
    /* Три повні прогони сторожа (р2, L-7): зелена базова лінія; №24 з ОБОМА
       акаунтами без рядка (червона базова лінія); після рядка оператора — рівно другий. */
    expect(count(SMOKE, "  v_res := public.invariants_check(false);")).toBe(3);
    expect(SMOKE).toContain("SMOKE_FAIL(orphan): базова лінія");
    expect(count(SMOKE, "jsonb_build_object('managed', 'true', 'platform', 'operator'), now() - interval '1 hour')"), "метадані двох акаунтів мусять бути однакові").toBe(2);
    expect(SMOKE).toContain("insert into public.clinics (name) values ('Смоук 0206 ' || v_sfx) returning id into v_c;");
    expect(DRYRUN).toContain("insert into public.clinics (name) values ('Проба 0206 ' || v_sfx) returning id into v_c;");
    expect(SMOKE).toContain("if (v_res->>'checked')::int <> 26 then");
    expect(SMOKE).toContain("raise exception 'SMOKE_OK:");
    expect(SMOKE).toContain("raise exception 'SMOKE_SKIP:");
    expect(/^\s*commit;/m.test(SMOKE)).toBe(false);
    const m = PIN.match(/^guard_body_md5=([0-9a-f]{32});len=(\d+)$/)!;
    expect(SMOKE).toContain(`c_guard_md5 constant text := '${m[1]}';`);
    expect(SMOKE).toContain(`c_guard_len constant int := ${m[2]};`);
    for (const [k, d] of NEW23.filter(([k]) => ["t:platform_log", "k:platform_operators", "t:platform_accounts"].includes(k))) {
      expect(SMOKE).toContain(`(''${k}'',''${d}'')`);
    }
  });
});

describe("0206 — контракт і код контуру", () => {
  it("дії журналу проходять CHECK форми й мають підпис; статуси входу ⊂ статусів", () => {
    for (const a of PLATFORM_ACTIONS) {
      expect(a).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      expect(a.length).toBeLessThanOrEqual(64);
      expect(PLATFORM_ACTION_LABEL[a]).toBeTruthy();
    }
    for (const s of LOGIN_BLOCKED_STATUSES) expect(CLINIC_STATUSES).toContain(s);
    expect(LOGIN_BLOCKED_STATUSES).toEqual(["suspended", "archived"]);
    /* Кожну дію з контракту роути справді пишуть — інакше мітка в журналі мертва. */
    const routes = ["app/api/platform/bootstrap/route.ts", "app/api/platform/operators/route.ts",
      "app/api/platform/operators/[id]/active/route.ts", "app/api/platform/operators/[id]/password/route.ts",
      "app/api/platform/clinics/[id]/status/route.ts", "app/api/platform/clinics/[id]/account/route.ts",
      "app/api/platform/me/password/route.ts"].map(read).join("\n");
    for (const a of PLATFORM_ACTIONS) expect(routes, `дію ${a} ніхто не пише`).toContain(`"${a}"`);
  });
  it("claim-модуль — без імпортів (edge-рантайм middleware), прапорець лише маршрутизує", () => {
    const claim = read("lib/platformClaim.ts");
    expect(/^import /m.test(claim)).toBe(false);
    expect(claim).toContain('export const PLATFORM_HOME = "/platform";');
    const mw = read("lib/supabase/middleware.ts");
    expect(mw).toContain('import { isOperatorByClaim, PLATFORM_HOME } from "@/lib/platformClaim";');
    expect(mw).not.toMatch(/platformAuth|supabase\/admin/);
  });
  it("service-role у браузер не їде: консоль ходить лише у /api/platform/**", () => {
    const ui = read("components/PlatformConsole.tsx");
    expect(ui).toMatch(/^"use client";/);
    expect(ui).not.toMatch(/supabase\/admin|supabase\/client|SERVICE_ROLE/);
    const urls = [...ui.matchAll(/api<[^>]*>\(\s*`?["'`]?(\/api\/[a-z/${}._-]+)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(5);
    for (const u of urls) expect(u.startsWith("/api/platform/"), u).toBe(true);
  });
  it("с84: свій пароль — лише «Змінити» (на свій, з поточним); «Скинути» собі консоль не пропонує; пароль не зникає зі збоєм перечитування", () => {
    const ui = codeOf(read("components/PlatformConsole.tsx")).replace(/\s+/g, " ");
    /* На своєму рядку — «Змінити пароль»; «Скинути» — лише чужим активним. */
    expect(ui).toMatch(/\{r\.id === meId \? <button [^>]*onClick=\{\(\) => setOwnPwd\(true\)\}>Змінити пароль<\/button> : r\.active && <button [^>]*onClick=\{\(\) => setConfirm\(\{ kind: "password", row: r \}\)\}>Скинути пароль<\/button>\}/);
    expect(ui).toContain('api<{ ok: true }>("/api/platform/me/password", { method: "POST", body: JSON.stringify({ current_password: cur, new_password: next }) })');
    /* Картка помилки — лише без переліку; збій ПЕРЕчитування не ховає SecretBox. */
    const ops = ui.slice(ui.indexOf("function OperatorsView("), ui.indexOf("function OwnPasswordDialog("));
    expect(ops.length).toBeGreaterThan(1000);
    expect(ops).toContain("if (err && !rows && !secret) return");
    expect(ops, "перелік операторів знову ховає сторінку (і SecretBox) на будь-якій помилці").not.toMatch(/if \(err\) return/);
    /* 401 — один зрозумілий текст, а не серверне «Не авторизовано». */
    expect(ui).toContain('if (res.status === 401) return { ok: false, error: SESSION_GONE, status: 401 };');
    /* Сервер: собі не скидають; свій — через власну сесію (updateUser), не admin. */
    const reset = codeOf(read("app/api/platform/operators/[id]/password/route.ts")).replace(/\s+/g, " ");
    expect(reset).toContain("if (targetId.toLowerCase() === operator.id.toLowerCase()) {");
    expect(reset.indexOf("if (targetId.toLowerCase() === operator.id.toLowerCase()) {")).toBeLessThan(reset.indexOf('.from("platform_operators")'));
    const own = codeOf(read("app/api/platform/me/password/route.ts")).replace(/\s+/g, " ");
    expect(own).toContain("await supabase.auth.updateUser({ password: new_password, current_password })");
    expect(own).not.toMatch(/updateUserById|auth\.admin/);
    expect(own).toContain("await checkCurrentPassword(user.email, current_password, user.id)");
    expect(own.indexOf("await checkCurrentPassword(user.email, current_password, user.id)")).toBeLessThan(own.indexOf("auth.updateUser("));
    expect(own).toContain('rateLimit: { key: "platform:own_pwd", max: 5, windowSeconds: 900, onFailure: "closed" }');
  });
  it("types.ts знає три таблиці й функцію; сторінка /platform має свою назву вкладки", () => {
    for (const t of TABLES) expect(TYPES).toContain(`      ${t}: {`);
    expect(TYPES).toContain("      platform_clinic_stats: {");
    expect(read("app/platform/page.tsx")).toContain('export const metadata = { title: "Платформа — RadFlow" };');
  });
  it("ключі details журналу: один перелік на запис і читання, без перетину з ПДн-CHECK", () => {
    const known = [...PLATFORM_LOG_DETAIL_KEYS];
    const forbidden = new Set<string>(PLATFORM_LOG_FORBIDDEN_KEYS);
    expect(known.filter((k) => forbidden.has(k)), "відомий ключ journal-у заборонений CHECK-ом — запис упав би на кожній дії").toEqual([]);
    expect(known).toEqual(["from", "to", "reason", "fields", "plan", "paid_until", "bootstrap"]);
    /* Запис: platformLog перебирає САМЕ цей перелік (не свою копію); читання —
       обидва роути журналу йдуть через hydrateLogRows → projectLogDetails. */
    const auth = read("lib/platformAuth.ts");
    expect(auth).toContain("for (const k of PLATFORM_LOG_DETAIL_KEYS) {");
    expect(auth).toContain("details: projectLogDetails(r.details),");
    for (const f of ["app/api/platform/log/route.ts", "app/api/platform/clinics/[id]/route.ts"]) {
      const r = read(f);
      expect(r, `${f} читає журнал повз hydrateLogRows`).toContain("await hydrateLogRows(admin,");
      expect(r, `${f} тримає свою копію переліку колонок`).toContain(".select(PLATFORM_LOG_COLUMNS)");
    }
    expect(projectLogDetails({ from: "a", to: "b", leaked: 1, email: "x" })).toEqual({ from: "a", to: "b" });
    expect(projectLogDetails("рядок")).toEqual({});
    expect(projectLogDetails(["масив"])).toEqual({});
    expect(projectLogDetails(null)).toEqual({});
    /* Усе, що platformLogText уміє показати, — із цього ж переліку. */
    const contract = read("lib/platformContract.ts");
    const shown = [...contract.matchAll(/typeof d\.(\w+) === "string"|Array\.isArray\(d\.(\w+)\)/g)].map((m) => m[1] ?? m[2]);
    expect(shown.length).toBeGreaterThan(0);
    for (const k of shown) expect(known, `platformLogText читає ключ ${k}, якого немає в PLATFORM_LOG_DETAIL_KEYS`).toContain(k);
  });
  it("AGENTS.md описує контур платформи", () => {
    expect(AGENTS).toMatch(/## Контур платформ[иы] \(с84 \/ 0206\)/);
    expect(AGENTS).toContain("requirePlatformOperator");
    expect(AGENTS).toContain("platform_operators");
  });
});
