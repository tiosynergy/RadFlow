// build-0206-reprint.mjs — збирає supabase/migrations/0206_platform_operators.sql
// і scripts/frag/0206_{apply,dryrun,rollback,falsify}.sql.
//
// ЩО РОБИТЬ ПАКЕТ (с84, контур платформи — оператор RadFlow керує центрами як
// клієнтами, а не пацієнтами як записами):
//   1. ТРИ НОВІ ТАБЛИЦІ, усі deny-all RLS (RLS увімкнено, жодної політики) і БЕЗ
//      грантів клієнтським ролям (`revoke all … from public, anon, authenticated`):
//        • `platform_operators` — оператори платформи: акаунт `auth.users` БЕЗ
//          профілю (не в `user_role`, без центру), `email`, `full_name`, `active`;
//        • `platform_accounts` — обліковий запис центру як клієнта: `status`
//          (trial / active / suspended / archived — CHECK), причина і час зміни,
//          `plan`, `paid_until`, `notes` (ручний контур без платіжного провайдера);
//        • `platform_log` — журнал дій оператора (без ПДн: CHECK на ключі details).
//      Читає і пише ТІЛЬКИ серверний шар під service_role після гейта
//      `requirePlatformOperator` (lib/platformAuth.ts); у браузер service-role не
//      потрапляє. Клієнтські ролі не бачать таблиць узагалі (ні через RLS, ні
//      через гранти) — №22 нових ключів не отримує.
//   2. Функція `platform_clinic_stats()` — агрегати по центрах (штат, кабінети,
//      записи за 30 днів, інтеграції), SECURITY INVOKER, EXECUTE лише service_role
//      (в `f:` №22 не потрапляє: не definer; `auth_*` не зветься — №19 не вимагає).
//   3. Передрук сторожа: №23 — шість нових ключів `t:`/`k:` (84 → 90) з дайджестами,
//      заміряними на проді у відкоченій транзакції; №24 — оператори НЕ сироти
//      (акаунт без профілю за задумом); два абзаци прози; №25 — самопін.
//      `checked` 26. №14 / №16 / №17 / №19 / №22 / №26 — без змін (генератор
//      доводить: код тіла без коментарів відрізняється від 0205 рівно сімома
//      рядками — шість рядків списку №23 і один рядок умови №24).
//   Даних не змінює: рядків у нових таблицях після накату НУЛЬ (статус центру без
//   рядка = trial; перший оператор — роутом /api/platform/bootstrap).
//
// ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК з 0205 якірними вставками (канон build-0203/0204/0205):
//    `latestReprint()` у тестах і стендах бере ОСТАННІЙ файл, де рядок
//    ПОЧИНАЄТЬСЯ з create-or-replace сторожа.
//
// ⚠️ ПОРЯДОК У НАКАТІ: передрук сторожа → пін → ПОВНИЙ сторож ДО DDL (≈9 с;
//    зеленим, крім названого №13 і рівно шести `missing:` №23) → DDL (три таблиці,
//    індекси, RLS, revoke, функція) → запити №3/№22/№23/№24 дослівно → ПОВНИЙ
//    сторож ПІСЛЯ DDL (зелений, крім №13) → леджер. Замки лише на НОВІ обʼєкти
//    (живих таблиць DDL не торкається; FK на `clinics` і `auth.users` беруть
//    SHARE ROW EXCLUSIVE на мілісекунди).
//
// ⚠️ ПІСЛЯ `npm run db:gate` ЦЕЙ ГЕНЕРАТОР НЕ ЗАПУСКАТИ: він перезаписує файл
//    міграції, чий md5 уже в леджері. Без `--force` відмовляється, якщо зміст інший.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const count = (s, needle) => s.split(needle).length - 1;
const FORCE = process.argv.includes("--force");

const MIGDIR = "supabase/migrations";
const SRC_NAME = "0205_new_user_name_trim.sql";
const SRC_MIG = `${MIGDIR}/${SRC_NAME}`;
const DST_NAME = "0206_platform_operators.sql";
const DST_MIG = `${MIGDIR}/${DST_NAME}`;
const PREV_LEDGER = SRC_NAME;
/** Прод 08.10 (замір с84 17:38 UTC): тіло сторожа = тіло у файлі 0205. */
const PRE_MD5 = "49cf5fb8af00195f1e656740248d8e43";
const PRE_LEN = 179066;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const CHECKED = 26;
/** Перевірки, червоні на проді ДО пакета не з його вини (замір 08.10: лише №13). */
const KNOWN_RED = ["gcal_sync_overdue"];

const OPEN = "\nas $function$";
const CLOSE = "\n$function$;";
const REPRINT_RE_G = /^create or replace function public\.invariants_check/gm;
const GUARD_PIN_RE =
  /comment on function public\.invariants_check\(boolean\) is '(guard_body_md5=[0-9a-f]{32};len=\d+)';/g;

function split(file) {
  const txt = readFileSync(file, "utf8").replace(/\r/g, "");
  const heads = txt.match(REPRINT_RE_G) || [];
  if (heads.length !== 1) throw new Error(`${file}: заголовків передруку ${heads.length}, а треба 1`);
  const ddl0 = txt.search(/^create or replace function public\.invariants_check/m);
  const a = txt.indexOf(OPEN, ddl0);
  const b = txt.indexOf(CLOSE, a);
  if (a < 0 || b < 0) throw new Error(`${file}: не знайдено межі тіла`);
  if (txt.indexOf(OPEN, a + 1) >= 0) throw new Error(`${file}: \`as $function$\` не один`);
  if (txt.indexOf(CLOSE, b + 1) >= 0) throw new Error(`${file}: \`$function$;\` не один`);
  return {
    raw: txt,
    head: txt.slice(0, ddl0),
    prologue: txt.slice(ddl0, a + OPEN.length),
    body: txt.slice(a + OPEN.length, b + 1),
    tail: txt.slice(b + CLOSE.length),
  };
}

/** Код без коментарів — той самий вирізувач, що в `tests/guardFnBodiesInvariant.test.ts`. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const exoticWs = (s) => [...s].some((ch) => {
  const c = ch.codePointAt(0);
  return c === 0x09 || c === 0x0b || c === 0x0c || c === 0x0d || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200b) || c === 0x2028 || c === 0x2029 || c === 0x202f
    || c === 0x205f || c === 0x3000 || c === 0xfeff;
});

// ---------------------------------------------------------------------------
// 1. БАЗИСИ ДЖЕРЕЛА. Кожен — числом.
// ---------------------------------------------------------------------------
const SRC = split(SRC_MIG);
if (md5(SRC.body) !== PRE_MD5 || SRC.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0205 дав ${md5(SRC.body)} / ${SRC.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}
if (SRC.head + SRC.prologue + SRC.body + "$function$;" + SRC.tail !== SRC.raw) {
  throw new Error("СКЛЕЙКА ЗЛАМАНА: 0205 не збирається назад побайтово");
}
{
  const pins = [...SRC.raw.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PRE_PIN) {
    throw new Error(`ПІН 0205 у файлі ${JSON.stringify(pins)}, а в проді ${PRE_PIN}`);
  }
}
{
  const later = readdirSync(MIGDIR)
    .filter((f) => f.endsWith(".sql") && f > SRC_NAME && f !== DST_NAME).sort();
  if (later.length) throw new Error(`після 0205 на диску вже є ${later.join(", ")} — номер 0206 зайнятий чи черга зсунулась`);
}

// ---------------------------------------------------------------------------
// 2. DDL ПАКЕТА — єдине джерело для файлу міграції, фрагів і дайджестів №23.
//    Дайджести ЗАМІРЯНО на проді 09.10 (с84, 06:30 UTC) у відкоченій транзакції
//    саме з цим текстом DDL: сторож після нього назвав РІВНО шість `new:` (нижче)
//    і нічого більше (№22 — жодного ключа, №3 — RLS увімкнено, ACL функції —
//    postgres + service_role). Правиш DDL — переміряй і перепиши NEW23.
// ---------------------------------------------------------------------------
const TABLES = ["platform_operators", "platform_accounts", "platform_log"];
const FN = "platform_clinic_stats";
const FN_REGPROC = "public.platform_clinic_stats()";
const FN_ACL = "postgres=X/postgres,service_role=X/postgres";
const STATUSES = ["trial", "active", "suspended", "archived"];
const PII_KEYS = ["patient_name", "patient_phone", "patient_email", "patient_dob", "name", "phone", "email", "dob", "password", "token", "note", "notes", "studies"];

const DDL_TABLES = (ifNotExists) => {
  const ine = ifNotExists ? "if not exists " : "";
  return [
    `create table ${ine}public.platform_operators (`,
    "  id          uuid primary key references auth.users(id) on delete cascade,",
    "  email       text not null,",
    "  full_name   text not null default '',",
    "  active      boolean not null default true,",
    "  created_at  timestamptz not null default now(),",
    "  created_by  uuid references public.platform_operators(id) on delete set null,",
    "  disabled_at timestamptz,",
    "  note        text,",
    "  constraint platform_operators_email_key unique (email),",
    "  constraint platform_operators_email_chk check (char_length(email) between 3 and 254 and email = lower(btrim(email))),",
    "  constraint platform_operators_full_name_chk check (char_length(full_name) <= 200),",
    "  constraint platform_operators_note_chk check (note is null or char_length(note) <= 2000)",
    ");",
    "",
    `create table ${ine}public.platform_accounts (`,
    "  clinic_id         uuid primary key references public.clinics(id) on delete cascade,",
    "  status            text not null default 'trial',",
    "  status_reason     text,",
    "  status_changed_at timestamptz,",
    "  status_changed_by uuid references public.platform_operators(id) on delete set null,",
    "  plan              text,",
    "  paid_until        date,",
    "  notes             text,",
    "  created_at        timestamptz not null default now(),",
    "  updated_at        timestamptz not null default now(),",
    "  updated_by        uuid references public.platform_operators(id) on delete set null,",
    `  constraint platform_accounts_status_chk check (status in (${STATUSES.map((s) => `'${s}'`).join(", ")})),`,
    "  constraint platform_accounts_status_reason_chk check (status_reason is null or char_length(status_reason) <= 500),",
    "  constraint platform_accounts_plan_chk check (plan is null or char_length(plan) <= 80),",
    "  constraint platform_accounts_notes_chk check (notes is null or char_length(notes) <= 4000)",
    ");",
    "",
    `create table ${ine}public.platform_log (`,
    "  id                 uuid primary key default gen_random_uuid(),",
    "  occurred_at        timestamptz not null default now(),",
    "  operator_id        uuid references public.platform_operators(id) on delete set null,",
    "  action             text not null,",
    "  clinic_id          uuid references public.clinics(id) on delete set null,",
    "  clinic_name        text,",
    "  target_operator_id uuid references public.platform_operators(id) on delete set null,",
    "  details            jsonb not null default '{}'::jsonb,",
    "  constraint platform_log_action_chk check (action ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' and char_length(action) <= 64),",
    "  constraint platform_log_clinic_name_chk check (clinic_name is null or char_length(clinic_name) <= 200),",
    `  constraint platform_log_no_pii_chk check (not (details ?| array[${PII_KEYS.map((k) => `'${k}'`).join(", ")}])),`,
    "  constraint platform_log_details_size_chk check (pg_column_size(details) <= 8192)",
    ");",
    `create index ${ine}platform_log_clinic_idx on public.platform_log (clinic_id, occurred_at desc);`,
    `create index ${ine}platform_log_occurred_idx on public.platform_log (occurred_at desc);`,
    "",
    "alter table public.platform_operators enable row level security;",
    "alter table public.platform_accounts  enable row level security;",
    "alter table public.platform_log       enable row level security;",
    "revoke all on table public.platform_operators, public.platform_accounts, public.platform_log from public, anon, authenticated;",
  ].join("\n");
};

const FN_STMT = [
  `create or replace function ${FN_REGPROC.replace("()", "")}()`,
  "returns table (",
  "  clinic_id uuid, staff_n int, admins_n int, referrers_n int, ceos_n int,",
  "  rooms_n int, rooms_active_n int, services_n int,",
  "  entries_total bigint, entries_30d bigint, last_activity_at timestamptz,",
  "  integration_keys_n int, webhooks_n int, gcal_status text",
  ")",
  "language sql",
  "stable",
  "set search_path = public, pg_temp",
  "as $$",
  "  select c.id,",
  "         (select count(*) from public.profiles p where p.clinic_id = c.id)::int,",
  "         (select count(*) from public.profiles p where p.clinic_id = c.id and p.role = 'admin')::int,",
  "         (select count(*) from public.referral_access r where r.clinic_id = c.id and r.status = 'active')::int,",
  "         (select count(*) from public.ceo_access a where a.clinic_id = c.id and a.status = 'active')::int,",
  "         (select count(*) from public.rooms r where r.clinic_id = c.id)::int,",
  "         (select count(*) from public.rooms r where r.clinic_id = c.id and r.active)::int,",
  "         (select count(*) from public.services s where s.clinic_id = c.id and s.active)::int,",
  "         (select count(*) from public.queue_entries q where q.clinic_id = c.id),",
  "         (select count(*) from public.queue_entries q where q.clinic_id = c.id and q.scheduled_date >= current_date - 30),",
  "         (select max(q.updated_at) from public.queue_entries q where q.clinic_id = c.id),",
  "         (select count(*) from public.integration_keys k where k.clinic_id = c.id and k.active and k.revoked_at is null)::int,",
  "         (select count(*) from public.integration_webhooks w where w.clinic_id = c.id and w.enabled)::int,",
  "         (select g.status from public.google_calendar_connections g where g.clinic_id = c.id)",
  "    from public.clinics c;",
  "$$;",
].join("\n");
const FN_ACL_DDL = [
  `revoke all on function ${FN_REGPROC} from public, anon, authenticated;`,
  `grant execute on function ${FN_REGPROC} to service_role;`,
].join("\n");
const FN_BODY_MD5 = (() => {
  const a = FN_STMT.indexOf("\nas $$") + "\nas $$".length;
  const b = FN_STMT.lastIndexOf("\n$$;");
  return md5(FN_STMT.slice(a, b + 1));
})();

/** Дайджести №23 для нових обʼєктів — ЗАМІРЯНО на проді (див. шапку розділу 2). */
const NEW23 = [
  ["k:platform_accounts", "8:e27d5034f4e4"],
  ["k:platform_log", "8:3c2b9b4b1a90"],
  ["k:platform_operators", "7:609ad073e819"],
  ["t:platform_accounts", "11:d09157fb92f7"],
  ["t:platform_log", "8:0a75467baf7d"],
  ["t:platform_operators", "8:5129903d70f7"],
];
for (const [k, d] of NEW23) {
  if (!/^[kt]:platform_[a-z]+$/.test(k) || !/^\d+:[0-9a-f]{12}$/.test(d)) throw new Error(`NEW23: ключ/дайджест не за формою: ${k} ${d}`);
}
const NEW23_OFFENDERS = NEW23.map(([k, d]) => `new:${k}->${d}`);

// ---------------------------------------------------------------------------
// 3. ПРАВКИ ТІЛА СТОРОЖА: рядки списку №23, умова №24, два абзаци прози.
// ---------------------------------------------------------------------------
const row23 = (key, dig) => `      ('${key}','${dig}'),\n`;
const K_ANCHOR = row23("k:patient_cases", "4:882687b5af46");
const T_ANCHOR = row23("t:patient_cases", "15:7cb038adcad8");
const K_ROWS = NEW23.filter(([k]) => k.startsWith("k:")).map(([k, d]) => row23(k, d)).join("");
const T_ROWS = NEW23.filter(([k]) => k.startsWith("t:")).map(([k, d]) => row23(k, d)).join("");
const P23_ANCHOR = "  --         PG17 мовчки повернув привілей MAINTAIN, і ніхто не помітив (№22).\n";
const PROSE23_0206 = [
  "  --     ⚠️ 0206 (с84, контур платформи) ДОДАЛА ШІСТЬ КЛЮЧІВ (84 → 90):",
  "  --        `t:`/`k:` для `platform_operators` (оператори RadFlow — акаунти",
  "  --        `auth.users` БЕЗ профілю і без `user_role`), `platform_accounts`",
  "  --        (обліковий запис центру як клієнта: статус trial / active / suspended /",
  "  --        archived, тариф, оплачено до, нотатки — ручний контур без платіжного",
  "  --        провайдера) і `platform_log` (журнал дій оператора без ПДн — CHECK на",
  "  --        ключі details). Усі три — deny-all RLS без жодної політики і без",
  "  --        грантів клієнтським ролям, тож №22 ключів не отримує; читає і пише",
  "  --        лише серверний шар під service_role після гейта `requirePlatformOperator`.",
  "  --        Функція `platform_clinic_stats()` — SECURITY INVOKER, EXECUTE лише",
  "  --        service_role: у `f:` №22 не потрапляє (не definer), в №19 не стоїть",
  "  --        (не `auth_*`; агрегати без ПДн). Дайджести заміряно на проді у",
  "  --        відкоченій транзакції з тим самим DDL (генератор build-0206-reprint).",
].join("\n") + "\n";
const WHERE24_OLD = "   where not exists (select 1 from public.profiles p where p.id = u.id)\n     and u.created_at < now() - interval '15 minutes';\n";
const WHERE24_NEW = "   where not exists (select 1 from public.profiles p where p.id = u.id)\n     and not exists (select 1 from public.platform_operators o where o.id = u.id)\n     and u.created_at < now() - interval '15 minutes';\n";
const P24_ANCHOR = "  --        сьогодні має грант.\n";
const PROSE24_0206 = [
  "  --     ⚠️ 0206 (с84): ОПЕРАТОР ПЛАТФОРМИ — акаунт `auth.users` БЕЗ профілю за",
  "  --        задумом (він не в `user_role`, центру не має; `auth_role()` і",
  "  --        `auth_clinic_id()` для нього NULL, RLS віддає нуль рядків, усі",
  "  --        definer-функції для `authenticated` відмовляють так само, як сироті).",
  "  --        Без винятку кожен оператор читався б як сирота. Виняток — рядок у",
  "  --        `platform_operators`, включно з вимкненими (`active = false` не",
  "  --        робить акаунт сиротою — він облікований і помітний у консолі).",
  "  --        Акаунт, створений роутом операторів, у якого insert рядка впав і",
  "  --        компенсуючий deleteUser не дійшов, лишається сиротою і червонить цю",
  "  --        перевірку — так і має бути (той самий клас, що й `managed=true`).",
].join("\n") + "\n";

const PAIRS = [
  [K_ANCHOR, K_ANCHOR + K_ROWS, "№23: три ключі k:platform_* після k:patient_cases"],
  [T_ANCHOR, T_ANCHOR + T_ROWS, "№23: три ключі t:platform_* після t:patient_cases"],
  [P23_ANCHOR, P23_ANCHOR + PROSE23_0206, "проза №23: абзац 0206"],
  [WHERE24_OLD, WHERE24_NEW, "№24: оператори платформи — не сироти"],
  [P24_ANCHOR, P24_ANCHOR + PROSE24_0206, "проза №24: абзац 0206"],
];

// ---------------------------------------------------------------------------
// 4. ХІД УПЕРЕД.
// ---------------------------------------------------------------------------
let NEW_BODY = SRC.body;
for (const [from, to, lbl] of PAIRS) {
  const hits = count(NEW_BODY, from);
  if (hits !== 1) throw new Error(`ЯКІР «${lbl}»: ${hits} влучань, а треба 1`);
  NEW_BODY = NEW_BODY.split(from).join(to);
}
const NEW_MD5 = md5(NEW_BODY);
const NEW_LEN = NEW_BODY.length;
const PIN = `guard_body_md5=${NEW_MD5};len=${NEW_LEN}`;
if (!/^guard_body_md5=[0-9a-f]{32};len=[0-9]+$/.test(PIN)) throw new Error(`ПІН не за регуляркою №25: ${PIN}`);
{
  const want = PRE_LEN + PAIRS.reduce((s, [f, t]) => s + t.length - f.length, 0);
  if (NEW_LEN !== want) throw new Error(`ДОВЖИНА ${NEW_LEN}, а з пар виходить ${want}`);
  if ([...NEW_BODY].length !== NEW_LEN) throw new Error("тіло має символи поза BMP — length у PG і JS розійдуться");
  for (const [, t] of PAIRS) if (exoticWs(t)) throw new Error("вставка містить не-ASCII пробіл");
}

// ---------------------------------------------------------------------------
// 5. ЗМІСТОВІ ПЕРЕВІРКИ.
// ---------------------------------------------------------------------------
const ROW23_RE = /^ {6}\('([a-z]:[a-z_]+)','(\d+:[0-9a-f]{12})'\),?$/gm;
const list23 = (body) => {
  /* `expd(key, dig)` стоїть у №22, №23 і №26 — список №23 упізнаємо за першим
     ключем `e:` (енуми), якого в інших двох немає. */
  const open = "  ), expd(key, dig) as (values\n";
  const starts = [];
  for (let i = body.indexOf(open); i >= 0; i = body.indexOf(open, i + 1)) {
    if (body.startsWith("      ('e:", i + open.length)) starts.push(i);
  }
  if (starts.length !== 1) throw new Error(`список №23 (з ключами e:) знайдено ${starts.length} раз(ів), а треба 1`);
  const a = starts[0];
  const b = body.indexOf("\n  )\n  select array_agg(x.what order by x.what) into v_tmp", a);
  if (b < 0) throw new Error("кінець списку №23 не знайдено");
  return body.slice(a + open.length, b + 1);
};
const OLD_CODE = codeOf(SRC.body);
const NEW_CODE = codeOf(NEW_BODY);
const EXPECTED_CODE = (() => {
  let c = OLD_CODE;
  const sub = (f, t, lbl) => { if (count(c, f) !== 1) throw new Error(`КОД: якір «${lbl}» не один`); c = c.split(f).join(t); };
  sub(K_ANCHOR, K_ANCHOR + K_ROWS, "k:");
  sub(T_ANCHOR, T_ANCHOR + T_ROWS, "t:");
  sub(WHERE24_OLD, WHERE24_NEW, "№24");
  return c;
})();
const CHECKS = [
  ["№23: 84 → 90 ключів, усі старі на місці, нові рівно NEW23, список відсортований", () => {
    const o = [...list23(SRC.body).matchAll(ROW23_RE)].map((m) => [m[1], m[2]]);
    const n = [...list23(NEW_BODY).matchAll(ROW23_RE)].map((m) => [m[1], m[2]]);
    if (o.length !== 84 || n.length !== 90) return false;
    const added = n.filter(([k]) => !o.some(([k2]) => k2 === k));
    if (JSON.stringify(added) !== JSON.stringify(NEW23)) return false;
    if (o.some(([k, d]) => !n.some(([k2, d2]) => k2 === k && d2 === d))) return false;
    const keys = n.map(([k]) => k);
    return JSON.stringify(keys) === JSON.stringify([...keys].sort());
  }],
  ["№24: нова умова рівно одна, стара зникла", () =>
    count(NEW_BODY, WHERE24_NEW) === 1 && count(NEW_BODY, WHERE24_OLD) === 0 && count(NEW_BODY, "public.platform_operators o where o.id = u.id") === 1],
  ["код без коментарів: рівно сім змінених рядків (№23 ×6, №24 ×1)", () => {
    if (NEW_CODE !== EXPECTED_CODE) return false;
    const a = OLD_CODE.split("\n"), b = NEW_CODE.split("\n");
    return b.length - a.length === 7;
  }],
  ["абзаци 0206 — по одному, у своїх перевірках, перед кроком лічильника", () => {
    if (count(NEW_BODY, PROSE23_0206) !== 1 || count(NEW_BODY, PROSE24_0206) !== 1) return false;
    const a23 = NEW_BODY.indexOf(PROSE23_0206) + PROSE23_0206.length;
    const a24 = NEW_BODY.indexOf(PROSE24_0206) + PROSE24_0206.length;
    return NEW_BODY.startsWith("  v_n := v_n + 1;\n  -- ⚠️ МАРКЕР РИШТУВАНЬ НИЖЧЕ", a23)
      && NEW_BODY.startsWith("  v_n := v_n + 1;\n  /* 0174 */ begin\n  select array_agg(u.id::text", a24);
  }],
  ["теги фрагментів у тілі відсутні", () =>
    !/\$(fxa|back|apply|dryrun|falsify|pre|chk|post|p|q|smoke|probe)\$/.test(NEW_BODY)],
  ["самопін №25 у тілі — регулярка та сама", () =>
    NEW_BODY.includes("guard_body_md5=") && count(NEW_BODY, "guard_body_md5=") === count(SRC.body, "guard_body_md5=")],
  ["лічильник перевірок не змінився (26)", () =>
    count(NEW_BODY, "\n  v_n := v_n + 1;\n") === CHECKED && count(SRC.body, "\n  v_n := v_n + 1;\n") === CHECKED],
  ["проза не містить заборонених для тестів фраз", () => {
    const prose = PROSE23_0206 + PROSE24_0206;
    return !/exception when others then|\/\* 0174 \*\/|'check', '|\*\//.test(prose);
  }],
];
for (const [lbl, fn] of CHECKS) {
  if (!fn()) throw new Error(`ПЕРЕВІРКА НЕ ПРОЙШЛА: ${lbl}`);
}

// ---------------------------------------------------------------------------
// 6. ЗАПИТИ ПЕРЕВІРОК, ВИРІЗАНІ з тіла ДОСЛІВНО: №3, №22, №23, №24.
//    Форма кожної (0174): `v_n := v_n + 1;` → `/* 0174 */ begin` → ЗАПИТ →
//    `if v_tmp is not null then` → мітка. Вирізаємо ЗАПИТ між `begin` і `if`.
// ---------------------------------------------------------------------------
const cutCheck = (body, label) => {
  const mark = `'check', '${label}', 'offenders', to_jsonb(v_tmp)));`;
  if (count(body, mark) !== 1) throw new Error(`запит ${label}: мітка не одна`);
  const m = body.indexOf(mark);
  const ifAt = body.lastIndexOf("  if v_tmp is not null then\n", m);
  const beginAt = body.lastIndexOf("  /* 0174 */ begin\n", m);
  if (ifAt < 0 || beginAt < 0 || beginAt > ifAt) throw new Error(`запит ${label}: межі не знайдено`);
  const q = body.slice(beginAt + "  /* 0174 */ begin\n".length, ifAt);
  if (/\$|\/\* 0174 \*\/|v_n := v_n/.test(q) || q.indexOf("'check', '") >= 0) throw new Error(`запит ${label}: містить долар, маркер або мітку`);
  if (!/into v_tmp/.test(q)) throw new Error(`запит ${label}: не пише в v_tmp`);
  return q;
};
const Q3 = cutCheck(NEW_BODY, "tables_rls_enabled");
const Q22 = cutCheck(NEW_BODY, "grant_digest");
const Q23 = cutCheck(NEW_BODY, "schema_digest");
const Q24 = cutCheck(NEW_BODY, "auth_orphan_accounts");
const Q23_OLD = cutCheck(SRC.body, "schema_digest");
const Q24_OLD = cutCheck(SRC.body, "auth_orphan_accounts");
if (!Q23.includes(K_ROWS) || !Q23.includes(T_ROWS) || Q23_OLD.includes(K_ROWS)) throw new Error("запит №23: нові рядки не там");
if (!Q24.includes(WHERE24_NEW) || !Q24_OLD.includes(WHERE24_OLD)) throw new Error("запит №24: умова не та");
if (cutCheck(SRC.body, "tables_rls_enabled") !== Q3 || cutCheck(SRC.body, "grant_digest") !== Q22) throw new Error("запити №3/№22 змінились, а не мали");

// ---------------------------------------------------------------------------
// 7. ЗВІРКА СТЕНДОВИХ ЯКОРІВ ЗА ЛІТЕРАЛАМИ (лексер із 0201…0205).
// ---------------------------------------------------------------------------
function literalsOf(src, spans = null) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prev = "";
  const decode = (raw) => raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === "u" && e[1] === "{") return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "" }[e] ?? e;
  });
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, raw = "";
      while (j < n && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") { raw += src[j] + src[j + 1]; j += 2; } else raw += src[j++]; }
      const v = decode(raw);
      if (v.length >= 12) out.push(v);
      if (spans) spans.push({ v, a: i, b: j + 1 });
      i = j + 1; prev = c; continue;
    }
    if (c === "`") {
      let j = i + 1, raw = "", plain = true;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") { raw += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") {
          plain = false; let depth = 1; j += 2;
          while (j < n && depth > 0) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
          continue;
        }
        raw += src[j++];
      }
      if (plain) { const v = decode(raw); if (v.length >= 12) out.push(v); if (spans) spans.push({ v, a: i, b: j + 1 }); }
      i = j + 1; prev = "`"; continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^\n".includes(prev))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      i = j + 1; prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
function compositesOf(src) {
  const spans = [];
  literalsOf(src, spans);
  const out = [];
  for (let k = 0; k < spans.length; k++) {
    let v = spans[k].v, b = spans[k].b;
    while (k + 1 < spans.length && /^\s*\+\s*$/.test(src.slice(b, spans[k + 1].a))) {
      k++; v += spans[k].v; b = spans[k].b;
    }
    if (v.length >= 12) out.push(v);
  }
  return out;
}
const STAND_LITERALS = new Set();
let STANDS_N = 0;
let STAND_LITS_CHECKED = 0;
{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  STANDS_N = stands.length;
  if (stands.length < 30) throw new Error(`ЯКОРІ: лише ${stands.length} стендів — очікувалось ≥30`);
  const migs = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql") && f !== DST_NAME);
  const stale = [];
  const ambiguous = [];
  for (const f of stands) {
    const txt = readFileSync(`scripts/${f}`, "utf8").replace(/\r/g, "");
    const named = migs.filter((m) => txt.includes(`${MIGDIR}/${m}`) && m !== SRC_NAME);
    for (const x of compositesOf(txt)) STAND_LITERALS.add(x);
    for (const lit of new Set(literalsOf(txt))) {
      const before = count(SRC.body, lit);
      if (before === 0) continue;
      STAND_LITS_CHECKED++;
      const after = count(NEW_BODY, lit);
      const broken = (before === 1 && after !== 1) || after === 0;
      if (!broken) continue;
      const livesInNamed = named.some((m) =>
        readFileSync(`${MIGDIR}/${m}`, "utf8").replace(/\r/g, "").includes(lit));
      const line = `${f} ← ${JSON.stringify(lit.slice(0, 70))} (${before} → ${after})`;
      if (livesInNamed) ambiguous.push(line); else stale.push(line);
    }
  }
  if (ambiguous.length) console.log(`  ⚠️ якорі, що живуть і в поіменній старій міграції (розібрати руками):\n    ${ambiguous.join("\n    ")}`);
  if (STAND_LITS_CHECKED < 100) throw new Error(`ЯКОРІ: звірено лише ${STAND_LITS_CHECKED} літералів — розбір стендів зламався`);
  if (stale.length) throw new Error(`ЯКОРІ ПРОТУХЛИ:\n  ${stale.join("\n  ")}`);
  console.log(`  якорі стендів: ${stands.length} файлів, ${STAND_LITS_CHECKED} літералів у тілі сторожа, 0 протухлих`);
}

// ---------------------------------------------------------------------------
// 8. ФРАГМЕНТИ. Спільні будівельні блоки (канон 0204/0205).
// ---------------------------------------------------------------------------
const q = (s) => `$q$${s}$q$`;
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const arr = (xs) => "array[\n" + xs.map((x) => `    ${q(x)}`).join(",\n") + "\n  ]";
const sqlArr = (xs) => `array[${xs.map(lit).join(", ")}]::text[]`;
const indent = (s, pad = "  ") => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");
const FRAG_TAGS = ["$q$", "$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$pre$", "$chk$", "$post$", "$smoke$"];
for (const [lbl, x] of [["Q3", Q3], ["Q22", Q22], ["Q23", Q23], ["Q24", Q24], ["Q23 ст", Q23_OLD], ["Q24 ст", Q24_OLD], ["DDL", DDL_TABLES(false)], ...PAIRS.map((p) => [p[2], p[0] + p[1]])]) {
  for (const t of FRAG_TAGS) if (x.includes(t)) throw new Error(`«${lbl}» містить тег ${t}`);
}
if (count(FN_STMT, "$$") !== 2 || FN_STMT.includes("$fxa$")) throw new Error("FN_STMT: теги тіла функції не ті");

const PRE = (tag) => [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування",
  "  -- ролі оператора (урок 0196).",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  `    raise exception '${tag}: мусить іти від ролі postgres, а йде від %', current_user;`,
  "  end if;",
].join("\n");

const LEDGER_GUARDS = (tag) => [
  `  if exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  `    raise exception '${tag}: рядок уже в леджері — повторний накат заборонено';`,
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  `    raise exception '${tag}: у леджері немає 0205 — накат не в свою чергу';`,
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${PREV_LEDGER}' then`,
  `    raise exception '${tag}: останній рядок леджера % — не 0205, черга зсунулась',`,
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
].join("\n");

const readGuard = (tag, wantMd5, wantLen, wantPin, what) => [
  "  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  if v_body is null then",
  `    raise exception '${tag}: invariants_check не знайдено';`,
  "  end if;",
  "  v_src := replace(v_body, chr(13), '');",
  `  if md5(v_src) is distinct from '${wantMd5}' or length(v_src) <> ${wantLen} then`,
  `    raise exception '${tag}: у проді не ${what} (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);`,
  "  end if;",
  "  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')",
  `     is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: самопін % не збігається з тілом ${what} — спершу розібратись',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

/** Передумови DDL: обʼєктів пакета ще НЕМАЄ (строгий предстан фрагів). */
const ABSENT = (tag) => [
  "  -- ── Передумови: обʼєктів пакета ще немає (накат не повторний) ──",
  ...TABLES.map((t) => `  if to_regclass('public.${t}') is not null then\n    raise exception '${tag}: таблиця public.${t} уже є — накат повторний або черга зсунулась';\n  end if;`),
  `  if to_regprocedure('${FN_REGPROC}') is not null then`,
  `    raise exception '${tag}: функція ${FN_REGPROC} уже є — накат повторний або черга зсунулась';`,
  "  end if;",
].join("\n");

/** Пост-асерти обʼєктів пакета: таблиці з RLS без політик і без клієнтських грантів, функція з ACL. */
const OBJECTS_ASSERT = (tag) => [
  "  -- ── Обʼєкти пакета: RLS увімкнено, політик немає, клієнтських грантів немає ──",
  "  select array_agg(x.txt order by x.txt) into v_bad",
  "    from (",
  `      select 'missing:' || t as txt from unnest(${sqlArr(TABLES)}) t where to_regclass('public.' || t) is null`,
  "      union all",
  "      select 'rls_off:' || c.relname from pg_class c",
  `       where c.relnamespace = 'public'::regnamespace and c.relname in (${TABLES.map(lit).join(", ")}) and not c.relrowsecurity`,
  "      union all",
  "      select 'policy:' || c.relname || '.' || p.polname from pg_policy p join pg_class c on c.oid = p.polrelid",
  `       where c.relnamespace = 'public'::regnamespace and c.relname in (${TABLES.map(lit).join(", ")})`,
  "      union all",
  "      select 'grant:' || c.relname || ':' || coalesce(r.rolname::text, 'PUBLIC') || ':' || a.privilege_type",
  "        from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a",
  "        left join pg_roles r on r.oid = a.grantee",
  `       where c.relnamespace = 'public'::regnamespace and c.relname in (${TABLES.map(lit).join(", ")})`,
  "         and coalesce(r.rolname::text, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')",
  "    ) x;",
  "  if v_bad is not null then",
  `    raise exception '${tag}: обʼєкти пакета не ті: %', v_bad;`,
  "  end if;",
  "  if not exists (",
  "    select 1 from pg_proc p join pg_language l on l.oid = p.prolang",
  `     where p.oid = to_regprocedure('${FN_REGPROC}')`,
  "       and not p.prosecdef and p.provolatile = 's' and l.lanname = 'sql'",
  "       and pg_get_userbyid(p.proowner) = 'postgres'",
  "       and p.proconfig = array['search_path=public, pg_temp']",
  `       and md5(replace(p.prosrc, chr(13), '')) = '${FN_BODY_MD5}'`,
  "  ) then",
  `    raise exception '${tag}: ${FN_REGPROC} не та (атрибути або md5 тіла ${FN_BODY_MD5})';`,
  "  end if;",
  `  if has_function_privilege('anon', '${FN_REGPROC}', 'EXECUTE')`,
  `     or has_function_privilege('authenticated', '${FN_REGPROC}', 'EXECUTE')`,
  "     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))) a",
  `                 where p.oid = to_regprocedure('${FN_REGPROC}') and a.grantee = 0) then`,
  `    raise exception '${tag}: ${FN_REGPROC} виконують anon/authenticated/PUBLIC — ACL не звужено';`,
  "  end if;",
  "  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate \"C\"), ',')",
  "    into v_acl from pg_proc p",
  `   where p.oid = to_regprocedure('${FN_REGPROC}');`,
  `  if v_acl is distinct from '${FN_ACL}' then`,
  `    raise exception '${tag}: ACL ${FN_REGPROC} = % замість ${FN_ACL}', v_acl;`,
  "  end if;",
  "  if (select count(*) from public.platform_clinic_stats()) <> (select count(*) from public.clinics) then",
  `    raise exception '${tag}: platform_clinic_stats() віддає не по рядку на центр';`,
  "  end if;",
].join("\n");

const fnExec = (tag, stmt) => `  execute ${tag}\n${stmt.replace(/;\s*$/, "")}\n${tag};`;

const substitute = (tag, fromVar, toVar, lblVar, wantMd5, wantLen, what) => [
  "  v_new := v_src;",
  `  for i in 1 .. array_length(${fromVar}, 1) loop`,
  `    v_hits := (length(v_new) - length(replace(v_new, ${fromVar}[i], ''))) / length(${fromVar}[i]);`,
  "    if v_hits <> 1 then",
  `      raise exception '${tag}: якір «%» трапляється % раз(ів), а треба 1', ${lblVar}[i], v_hits;`,
  "    end if;",
  `    v_new := replace(v_new, ${fromVar}[i], ${toVar}[i]);`,
  "  end loop;",
  `  if md5(v_new) is distinct from '${wantMd5}' or length(v_new) <> ${wantLen} then`,
  `    raise exception '${tag}: підстановка дала % / %, а ${what} це ${wantMd5} / ${wantLen}',`,
  "      md5(v_new), length(v_new);",
  "  end if;",
  "  execute v_head || v_new || '$function$';",
  "",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${wantMd5}' or length(v_src) <> ${wantLen} then`,
  `    raise exception '${tag}: у БД лягло % / % замість ${wantMd5} / ${wantLen}', md5(v_src), length(v_src);`,
  "  end if;",
].join("\n");

const pinBlock = (tag, wantPin) => [
  "  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────",
  "  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);",
  `  if v_pin_db is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: пін із БД (%) розійшовся з піном із файлу (${wantPin})', v_pin_db;`,
  "  end if;",
  "  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then",
  `    raise exception '${tag}: пін не ліг — у коментарі %',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const KNOWN_RED_SQL = `(${KNOWN_RED.map(lit).join(", ")})`;
const SENTINEL_CALL = "  v_res := public.invariants_check(false);";
/** ПОВНИЙ сторож: мусить бути зеленим, крім названого №13. */
const SENTINEL = (tag, what) => [
  `  -- ── ПОВНИЙ сторож ${what} (≈9 с) ──`,
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '${tag}: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL};`,
  "  if v_failed is not null then",
  `    raise exception '${tag}: сторож ${what} червоний: % — %', v_failed, v_res->'failed';`,
  "  end if;",
].join("\n");
/** ПОВНИЙ сторож ПІСЛЯ передруку, але ДО DDL: №23 мусить назвати РІВНО шість `new:`. */
const SENTINEL_PRE_DDL = (tag) => [
  "  -- ── ПОВНИЙ сторож ДО DDL (≈9 с; замків на таблиці ще немає): зелений, крім",
  "  --    №13 і №23, а №23 називає РІВНО шість нових ключів — доказ, що список",
  "  --    №23 у новому тілі живий і що DDL нижче дасть саме ці дайджести ──",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '${tag}: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL} and e.value->>'check' <> 'schema_digest';`,
  "  if v_failed is not null then",
  `    raise exception '${tag}: до DDL сторож червоний не від пакета: % — %', v_failed, v_res->'failed';`,
  "  end if;",
  "  select array_agg(o.value order by o.value collate \"C\") into v_off23",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'schema_digest';",
  `  if v_off23 is distinct from ${sqlArr(NEW23.map(([k]) => `missing:${k}`))} then`,
  `    raise exception '${tag}: №23 до DDL мусить назвати рівно шість missing:, а назвав % — список №23 не живий?', v_off23;`,
  "  end if;",
].join("\n");
/** ПОВНИЙ сторож ПІСЛЯ накату, але ДО db:gate (фальсифікація): №7 `ledger_md5`
 *  законно червоний з offender-ом РІВНО самої 0206 (md5 ще не проштамповано). */
const SENTINEL_PRE_GATE = (tag, what) => [
  `  -- ── ПОВНИЙ сторож ${what} (≈9 с): зелена базова лінія ДО проб; ledger_md5 —`,
  "  --    лише з offender-ом самої 0206 (db:gate ще не штампував) ──",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '${tag}: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL}`,
  "     and not (e.value->>'check' = 'ledger_md5'",
  `              and e.value->'offenders' = jsonb_build_array('${DST_NAME}'));`,
  "  if v_failed is not null then",
  `    raise exception '${tag}: сторож ${what} червоний: % — %', v_failed, v_res->'failed';`,
  "  end if;",
].join("\n");

/** Запит перевірки ДОСЛІВНО з тіла (мілісекунди). */
const Q_ASSERT = (tag, lbl, qtext, what) => [
  `  -- ── ${lbl} ${what}: запит вирізано ДОСЛІВНО з тіла ──`,
  qtext,
  "  if v_tmp is not null then",
  `    raise exception '${tag}: ${lbl} ${what} червоний: %', v_tmp;`,
  "  end if;",
].join("\n");
const Q_EXPECT_RED = (tag, lbl, qtext, wantArr, what) => [
  `  -- ── ${lbl} ${what}: запит вирізано ДОСЛІВНО з тіла; мусить назвати РІВНО очікуване ──`,
  qtext,
  `  if v_tmp is distinct from ${wantArr} then`,
  `    raise exception '${tag}: ${lbl} ${what} мусив назвати ${wantArr.replace(/'/g, "''")}, а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');`,
  "  end if;",
].join("\n");

const DECL = (tag, fromXs, toXs, lblXs, extra = []) => [
  "-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний",
  "--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.",
  "set statement_timeout = '5min';",
  `do $${tag}$`,
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];",
  "  v_failed text[]; v_acl text; v_off23 text[];",
  ...extra,
  `  v_from constant text[] := ${arr(fromXs)};`,
  `  v_to   constant text[] := ${arr(toXs)};`,
  `  v_lbl  constant text[] := ${arr(lblXs)};`,
  "begin",
].join("\n");

const FWD = [PAIRS.map((p) => p[0]), PAIRS.map((p) => p[1]), PAIRS.map((p) => p[2])];
const BWD = [[...PAIRS].reverse().map((p) => p[1]), [...PAIRS].reverse().map((p) => p[0]),
  [...PAIRS].reverse().map((p) => `назад: ${p[2]}`)];

const LEDGER_INSERT = (tag) => [
  "  insert into public.migration_ledger (name)",
  `  values ('${DST_NAME}');`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  `    raise exception '${tag}: рядок леджера не ліг (% рядків)', v_rows;`,
  "  end if;",
].join("\n");

/** Поведінкова проба (усе відкочується ззовні): оператор без профілю — не сирота;
 *  статус поза CHECK відмовляє; ПДн у details журналу відмовляє; функція статистики
 *  віддає рядок на кожен центр. */
const BEHAVIOR_PROBE = (tag) => [
  "  -- ── Поведінка: три рядки auth.users (managed — тригер профілю не створює):",
  "  --    двоє «старі» (created_at −1 год), один із них стає оператором; третій",
  "  --    свіжий. Запит №24 дослівно: мусить назвати РІВНО старого БЕЗ рядка. ──",
  "  v_u1 := gen_random_uuid(); v_u2 := gen_random_uuid(); v_u3 := gen_random_uuid();",
  "  v_sfx := replace(gen_random_uuid()::text, '-', '');",
  "  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data, created_at) values",
  "    (v_u1, 'op1.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',",
  "     jsonb_build_object('managed', 'true', 'platform', 'operator'), now() - interval '1 hour'),",
  "    (v_u2, 'op2.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',",
  "     jsonb_build_object('managed', 'true'), now() - interval '1 hour'),",
  "    (v_u3, 'op3.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',",
  "     jsonb_build_object('managed', 'true'), now());",
  "  if exists (select 1 from public.profiles where id in (v_u1, v_u2, v_u3)) then",
  `    raise exception '${tag}: managed-акаунт отримав профіль від тригера';`,
  "  end if;",
  "  insert into public.platform_operators (id, email, full_name, active)",
  "    values (v_u1, 'op1.' || v_sfx || '@radflow.test', 'Проба Оператор', false);",
  Q24,
  "  if v_tmp is distinct from array[v_u2::text || '@' || to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD')]::text[] then",
  `    raise exception '${tag}: №24 мусив назвати рівно старий акаунт без рядка оператора, а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');`,
  "  end if;",
  "  -- CHECK статусу: значення поза переліком — відмова 23514",
  "  begin",
  "    insert into public.platform_accounts (clinic_id, status) select id, 'paid' from public.clinics limit 1;",
  `    raise exception '${tag}: CHECK статусу пропустив ''paid''';`,
  "  exception when check_violation then null;",
  "  end;",
  "  -- CHECK ПДн у журналі: ключ phone у details — відмова 23514",
  "  begin",
  "    insert into public.platform_log (operator_id, action, details) values (v_u1, 'probe.pii', jsonb_build_object('phone', '+380'));",
  `    raise exception '${tag}: CHECK ПДн журналу пропустив ключ phone';`,
  "  exception when check_violation then null;",
  "  end;",
  "  -- CHECK форми дії журналу: без крапки — відмова",
  "  begin",
  "    insert into public.platform_log (operator_id, action) values (v_u1, 'noDot');",
  `    raise exception '${tag}: CHECK форми action пропустив ''noDot''';`,
  "  exception when check_violation then null;",
  "  end;",
  "  -- Штатний запис: статус, журнал, функція статистики",
  "  insert into public.platform_accounts (clinic_id, status, status_reason, status_changed_at, status_changed_by, plan, paid_until)",
  "    select id, 'suspended', 'проба', now(), v_u1, 'проба', current_date from public.clinics order by created_at limit 1;",
  "  insert into public.platform_log (operator_id, action, clinic_id, clinic_name, details)",
  "    select v_u1, 'clinic.status_changed', id, name, jsonb_build_object('from', 'trial', 'to', 'suspended') from public.clinics order by created_at limit 1;",
  "  if (select count(*) from public.platform_clinic_stats()) <> (select count(*) from public.clinics)",
  "     or exists (select 1 from public.platform_clinic_stats() where staff_n is null or rooms_n is null or entries_total is null) then",
  `    raise exception '${tag}: platform_clinic_stats() — не по рядку на центр або NULL у лічильниках';`,
  "  end if;",
  "  -- Каскад: видалення оператора лишає журнал (operator_id → NULL), не ламає облік",
  "  delete from public.platform_operators where id = v_u1;",
  "  if (select count(*) from public.platform_log where action = 'clinic.status_changed' and operator_id is null) <> 1",
  "     or (select status_changed_by from public.platform_accounts where status = 'suspended' and status_reason = 'проба') is not null then",
  `    raise exception '${tag}: on delete set null на operator_id / status_changed_by не спрацював';`,
  "  end if;",
].join("\n");
const PROBE_DECL = ["  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_sfx text;"];

/** Тіло накату — спільне для apply і dryrun. */
const FORWARD = (tag) => [
  PRE(tag),
  LEDGER_GUARDS(tag),
  readGuard(tag, PRE_MD5, PRE_LEN, PRE_PIN, "0205"),
  ABSENT(tag),
  "",
  "  -- ── 1. Передрук сторожа: шість ключів №23, умова №24, два абзаци ──────────",
  substitute(tag, "v_from", "v_to", "v_lbl", NEW_MD5, NEW_LEN, "файл 0206"),
  "",
  pinBlock(tag, PIN),
  "",
  SENTINEL_PRE_DDL(tag),
  "",
  "  -- ── 2. DDL пакета: три таблиці, індекси, RLS, revoke, функція статистики ──",
  indent(DDL_TABLES(false)),
  fnExec("$fxa$", FN_STMT),
  indent(FN_ACL_DDL),
  OBJECTS_ASSERT(tag),
  "",
  Q_ASSERT(tag, "№3", Q3, "після DDL"),
  Q_ASSERT(tag, "№22", Q22, "після DDL"),
  Q_ASSERT(tag, "№23", Q23, "після DDL"),
  Q_ASSERT(tag, "№24", Q24, "після DDL"),
  "",
  SENTINEL(tag, "після DDL"),
  "",
  BEHAVIOR_PROBE(tag),
  "",
  LEDGER_INSERT(tag),
].join("\n");

const READBACK = [
  "select md5(replace(p.prosrc, chr(13), '')) as guard_md5,",
  "       length(replace(p.prosrc, chr(13), '')) as guard_len,",
  "       obj_description(p.oid, 'pg_proc') as guard_pin,",
  "       (select count(*) from public.migration_ledger) as ledger_rows,",
  "       (select max(name) from public.migration_ledger) as ledger_last,",
  `       (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in (${TABLES.map(lit).join(", ")}) and c.relrowsecurity) as tables_rls,`,
  `       (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate "C"), ',') from pg_proc f where f.oid = to_regprocedure('${FN_REGPROC}')) as fn_acl,`,
  "       (select count(*) from public.platform_operators) as operators,",
  "       (select count(*) from public.platform_accounts) as accounts,",
  "       (select count(*) from public.platform_log) as log_rows",
  "  from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  " where n.nspname = 'public' and p.proname = 'invariants_check'",
  "   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
].join("\n");

/** Те саме читання без лічильників таблиць пакета (після відкату їх немає). */
const READBACK_BACK = READBACK.split("\n")
  .filter((l) => !/from public\.platform_[a-z]+\) as /.test(l))
  .map((l) => l.replace(/\) as fn_acl,$/, ") as fn_acl"))
  .join("\n");

const RED_WINDOW = [
  "-- ⚠️ ЧЕРВОНЕ ВІКНО (AGENTS.md, «Миграции и БД»): з commit цього блоку і до пушу",
  "--    `main` з файлом 0206 падає КОЖНА прод-збірка (гейт: рядок леджера без файла",
  "--    на диску). У вікні: жодного Redeploy, нічого іншого в `main`. Закрити ОДНИМ",
  "--    заходом: `npm run db:gate` → `npm test` → гілка → dev → main → push → деплой;",
  "--    перевірка — `npm run db:gate:check` на `main` І на `dev`. Не закрили в цей",
  "--    захід — `scripts/frag/0206_rollback.sql`, а не «доробимо завтра». Ліміт",
  "--    03:50 UTC (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».",
].join("\n");

const APPLY = [
  "-- 0206 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0206-reprint.mjs`. Одним запитом,",
  "-- ОДНА транзакція: передрук сторожа (№23 ×6, №24, два абзаци) → пін → ПОВНИЙ",
  "-- сторож ДО DDL (№23 називає рівно шість missing:) → DDL (три таблиці, RLS,",
  "-- revoke, функція) → запити №3/№22/№23/№24 дослівно → ПОВНИЙ сторож → леджер.",
  "-- Поведінкової проби тут НЕМАЄ.",
  "-- ⚠️ ПОВЕДІНКОВА ПРОБА В APPLY ВИМКНЕНА СВІДОМО: ця транзакція КОМІТИТЬСЯ, і",
  "--    пробні рядки auth.users / platform_* лишились би в проді. Поведінку доводять",
  "--    dryrun (той самий текст + проба + raise = відкат) і falsify.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна (кілька верхньорівневих",
  "--    стейтментів; тут — суворий предстан, у файлі — ідемпотентний).",
  "-- ⚠️ ТЕКСТ СЛАТИ ДОСЛІВНО (краще — базою через net.http_get, AGENTS.md с79):",
  "--    якорі всередині $q$ входять у md5 — «прибрати рядки-коментарі» зламає",
  "--    пост-перевірки, і накат зупиниться.",
  RED_WINDOW,
  DECL("apply", ...FWD),
  FORWARD("apply").replace(BEHAVIOR_PROBE("apply"), "  -- (поведінкова проба — лише у dryrun і falsify: тут транзакція комітиться)"),
  "end",
  "$apply$;",
  "",
  "-- Контрольне читання ПІСЛЯ commit (окремим запитом):",
  "-- " + READBACK.split("\n").join("\n-- "),
  `-- Очікувано: guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN}, guard_pin = ${PIN},`,
  `--            ledger_last = ${DST_NAME}, tables_rls = 3, fn_acl = ${FN_ACL},`,
  "--            operators = 0, accounts = 0, log_rows = 0.",
].join("\n");

const DRYRUN = [
  "-- 0206 DRYRUN — ЗГЕНЕРОВАНО `node scripts/build-0206-reprint.mjs`. Те саме, що apply,",
  "-- плюс поведінкова проба (оператор без профілю не сирота для №24; CHECK статусу,",
  "-- ПДн і форми дії; функція статистики; каскади) і `raise` у кінці — усе",
  "-- відкочується. Очікуваний текст винятку починається з `DRYRUN_0206_ROLLBACK`.",
  "-- Будь-який інший текст — справжня відмова (передумова, якір, md5, сторож, DDL).",
  DECL("dryrun", ...FWD, PROBE_DECL),
  FORWARD("dryrun"),
  "",
  "  raise exception 'DRYRUN_0206_ROLLBACK guard=% len=% pin=% tables=% fn_acl=% probes=24,chk,pii,action,stats,cascade ledger_last=%',",
  "    md5(v_src), length(v_src), v_pin_db,",
  `    (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in (${TABLES.map(lit).join(", ")}) and c.relrowsecurity),`,
  `    (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate "C"), ',') from pg_proc f where f.oid = to_regprocedure('${FN_REGPROC}')),`,
  "    (select max(name) from public.migration_ledger);",
  "end",
  "$dryrun$;",
].join("\n");

const ROLLBACK = [
  "-- 0206 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0206-reprint.mjs`. Знімає функцію",
  "-- і три таблиці пакета (ВІДМОВЛЯЄ, якщо в них уже є рядки — дані операторів не",
  "-- викидаються мовчки; спершу вивантажити і спорожнити руками за явним списком),",
  "-- повертає тіло сторожа до 0205 (ті самі якорі назад), самопін 0205, знімає рядок",
  "-- леджера. ОДНА транзакція.",
  DECL("back", ...BWD),
  PRE("back"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception 'back: рядка 0206 у леджері немає — відкочувати нічого';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${DST_NAME}' then`,
  "    raise exception 'back: останній рядок леджера % — не 0206, черга зсунулась',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  readGuard("back", NEW_MD5, NEW_LEN, PIN, "0206"),
  "",
  "  -- ── 1. Обʼєкти пакета: лише порожні (дані не викидаємо мовчки) ──",
  ...TABLES.map((t) => [
    `  if to_regclass('public.${t}') is not null and (select count(*) from public.${t}) > 0 then`,
    `    raise exception 'back: у public.${t} є рядки — відкат зупинено, спершу вивантажити і спорожнити за явним списком';`,
    "  end if;",
  ].join("\n")),
  `  drop function if exists ${FN_REGPROC};`,
  "  drop table if exists public.platform_log;",
  "  drop table if exists public.platform_accounts;",
  "  drop table if exists public.platform_operators;",
  "",
  "  -- ── 2. Тіло сторожа 0205 назад (якорі у зворотному порядку) ──",
  substitute("back", "v_from", "v_to", "v_lbl", PRE_MD5, PRE_LEN, "файл 0205"),
  "",
  pinBlock("back", PRE_PIN),
  "",
  Q_ASSERT("back", "№23", Q23_OLD, "після відкату"),
  Q_ASSERT("back", "№24", Q24_OLD, "після відкату"),
  "",
  "  -- ── Рядок леджера — ДО повного сторожа (ревʼю с83, лінза A, High): відкат",
  "  --    передбачено для вікна «накат → db:gate», коли md5 рядка 0206 ще NULL, і №7",
  "  --    `ledger_md5` з ним у леджері був би червоним. Після зняття рядка сторож",
  "  --    перевіряє вже КІНЦЕВИЙ стан — той, що лишиться після commit. ──",
  `  delete from public.migration_ledger where name = '${DST_NAME}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception 'back: рядок леджера не знято (% рядків)', v_rows;",
  "  end if;",
  "",
  SENTINEL("back", "після відкату"),
  "end",
  "$back$;",
  "",
  "-- Контрольне читання ПІСЛЯ commit (окремим запитом):",
  "-- " + READBACK_BACK.split("\n").join("\n-- "),
  `-- Очікувано: guard_md5 = ${PRE_MD5}, guard_len = ${PRE_LEN}, guard_pin = ${PRE_PIN},`,
  `--            ledger_last = ${PREV_LEDGER}, tables_rls = 0, fn_acl = NULL.`,
].join("\n");

const FALSIFY = [
  "-- 0206 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0206-reprint.mjs`. Запускати ПІСЛЯ",
  "-- накату (леджер на 0206). ОДНА транзакція, у кінці `raise` — усе відкочується.",
  "-- Спершу — ПОВНИЙ сторож (зелена базова лінія; ledger_md5 лише з offender-ом 0206,",
  "-- бо db:gate ще попереду), потім проби (кожен запит — ДОСЛІВНО з тіла сторожа):",
  "--   A. RLS знято з platform_log → №3 мусить назвати РІВНО platform_log; назад — зелений;",
  "--   B. grant select на platform_accounts для authenticated → №22 мусить назвати РІВНО",
  "--      new:t:platform_accounts:authenticated->SELECT; revoke — зелений;",
  "--   C. колонка додана в platform_log → №23 мусить назвати changed:t:platform_log; drop — зелений;",
  "--   D. поведінка: оператор без профілю не сирота (№24), CHECK-и, функція, каскади.",
  "-- Очікуваний текст винятку починається з `FALSIFY_0206 verdict=PASS`.",
  "set statement_timeout = '5min';",
  "do $falsify$",
  "declare",
  "  v_tmp text[]; v_bad text[]; v_acl text; v_res jsonb; v_failed text[]; v_src text; v_def text; v_body text; v_head text;",
  ...PROBE_DECL,
  "begin",
  PRE("falsify"),
  `  if (select max(name) from public.migration_ledger) is distinct from '${DST_NAME}' then`,
  "    raise exception 'falsify: леджер не на 0206 — фальсифікувати нічого';",
  "  end if;",
  readGuard("falsify", NEW_MD5, NEW_LEN, PIN, "0206"),
  SENTINEL_PRE_GATE("falsify", "до проб"),
  "",
  "  -- ── A. RLS знято → №3 називає рівно platform_log ──",
  "  alter table public.platform_log disable row level security;",
  Q_EXPECT_RED("falsify", "№3", Q3, sqlArr(["platform_log"]), "без RLS на platform_log"),
  "  alter table public.platform_log enable row level security;",
  Q_ASSERT("falsify", "№3", Q3, "після повернення RLS"),
  "",
  "  -- ── B. грант клієнтській ролі → №22 називає рівно новий ключ ──",
  "  grant select on table public.platform_accounts to authenticated;",
  Q_EXPECT_RED("falsify", "№22", Q22, sqlArr(["new:t:platform_accounts:authenticated->SELECT"]), "з грантом authenticated"),
  "  revoke select on table public.platform_accounts from authenticated;",
  Q_ASSERT("falsify", "№22", Q22, "після revoke"),
  "",
  "  -- ── C. форма таблиці змінена → №23 називає changed:t:platform_log ──",
  "  alter table public.platform_log add column probe_col text;",
  Q23,
  "  if v_tmp is null or array_length(v_tmp, 1) <> 1 or v_tmp[1] not like 'changed:t:platform_log:8:0a75467baf7d->9:%' then",
  "    raise exception 'falsify: C — №23 мусив назвати рівно changed:t:platform_log:8:0a75467baf7d->9:…, а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');",
  "  end if;",
  "  alter table public.platform_log drop column probe_col;",
  Q_ASSERT("falsify", "№23", Q23, "після drop column"),
  "",
  "  -- ── D. поведінка ──",
  BEHAVIOR_PROBE("falsify"),
  "",
  "  raise exception 'FALSIFY_0206 verdict=PASS probes=A,B,C,D guard=%', md5(v_src);",
  "end",
  "$falsify$;",
].join("\n");

// ---------------------------------------------------------------------------
// 9. КАНОНІЧНИЙ ФАЙЛ МІГРАЦІЇ (ідемпотентний предстан, без тегів фрагментів).
// ---------------------------------------------------------------------------
const MIG_PRE = [
  "do $pre$",
  "declare v_src text;",
  "begin",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  "    raise exception '0206: мусить іти від ролі postgres, а йде від %', current_user;",
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  "    raise exception '0206: у леджері немає 0205 — накат не в свою чергу';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) not in",
  `     ('${PREV_LEDGER}', '${DST_NAME}') then`,
  "    raise exception '0206: останній рядок леджера % — не 0205/0206, черга зсунулась',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) not in ('${PRE_MD5}', '${NEW_MD5}') then`,
  "    raise exception '0206: тіло сторожа % — ні 0205, ні 0206; правка наосліп заборонена', md5(v_src);",
  "  end if;",
  "end",
  "$pre$;",
].join("\n");

const MIG_CHK = [
  "do $chk$",
  "declare v_res jsonb; v_failed text[];",
  "begin",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '0206: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  -- ідемпотентно: ledger_md5 допустима лише з offender-ом самої 0206 (повторний прогін до db:gate)",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL}`,
  "     and not (e.value->>'check' = 'ledger_md5'",
  `              and e.value->'offenders' = jsonb_build_array('${DST_NAME}'));`,
  "  if v_failed is not null then",
  "    raise exception '0206: після передруку і DDL сторож червоний: % — %', v_failed, v_res->'failed';",
  "  end if;",
  "end",
  "$chk$;",
].join("\n");

const MIG_POST = [
  "do $post$",
  "declare v_acl text; v_src text; v_bad text[];",
  "begin",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${NEW_MD5}' or length(v_src) <> ${NEW_LEN}`,
  "     or obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')",
  "        is distinct from 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src) then",
  "    raise exception '0206: тіло сторожа або самопін не ті: % / %', md5(v_src), length(v_src);",
  "  end if;",
  OBJECTS_ASSERT("0206"),
  "end",
  "$post$;",
].join("\n");

const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0206: контур платформи — оператор RadFlow керує центрами",
  "--  як клієнтами (с84). Три таблиці deny-all, функція статистики, передрук",
  "--  сторожа (№23 — шість ключів, №24 — оператори не сироти, самопін №25).",
  "--",
  "--  Максимальна ЗАСТОСОВАНА на момент написання — 0205.",
  `--  \`checked\` ${CHECKED} -> ${CHECKED}. №23 — 84 → 90 ключів (t:/k: для трьох нових таблиць), абзац;`,
  "--  №24 — акаунти з рядком у `platform_operators` не сироти, абзац; №25 — самопін.",
  "--  №14 / №16 / №17 / №19 / №22 / №26 — без змін (генератор доводить: код тіла без",
  "--  коментарів відрізняється від 0205 рівно сімома рядками). Даних не змінює.",
  "--",
  "--  ЗВІДКИ ПАКЕТ — рішення власника (с84, 08.10): «окремий контур платформи — людина",
  "--   RadFlow, яка керує центрами як клієнтами, а не пацієнтами як записами; оператор",
  "--   не входить у user_role, це окремий акаунт без clinic_id; у браузер service-role",
  "--   не віддавати; білінгу ще немає — ручний контур без платіжного провайдера;",
  "--   статуси центру від нього не залежать, але оператор може їх змінювати».",
  "--",
  "--  ЩО ЗМІНЮЄТЬСЯ:",
  "--   1. `platform_operators` — оператор: `id` = `auth.users.id` (акаунт БЕЗ профілю",
  "--      і без `user_role`; `app_metadata.platform = 'operator'` лише для маршрутизації",
  "--      в middleware, авторизація — РЯДОК цієї таблиці на сервері), `email`,",
  "--      `full_name`, `active`, `created_by`, `disabled_at`, `note`.",
  "--   2. `platform_accounts` — обліковий запис центру як клієнта (один на центр, рядка",
  "--      може не бути = trial): `status` trial / active / suspended / archived",
  "--      (CHECK), `status_reason`, `status_changed_at/_by`, `plan`, `paid_until`,",
  "--      `notes`, `updated_at/_by`. Єдине застосування статусу в коді цього пакета —",
  "--      `/api/auth/login` відмовляє у вході персоналу центру зі статусом",
  "--      suspended / archived (живі сесії і глобальні акаунти не чіпає — названо в ToDo).",
  "--   3. `platform_log` — журнал дій оператора: `action` за формою `a.b`, `clinic_id`",
  "--      (on delete set null — слід переживає видалення центру) + `clinic_name`",
  "--      знімком, `target_operator_id`, `details` без ПДн (CHECK на ключі, ≤8 КБ).",
  "--   4. Усі три: RLS увімкнено, жодної політики, `revoke all … from public, anon,",
  "--      authenticated` — клієнтські ролі таблиць не бачать; №22 ключів не отримує.",
  "--   5. `platform_clinic_stats()` — SECURITY INVOKER, EXECUTE лише service_role:",
  "--      штат / адміни / направники / керівники / кабінети / послуги / записи",
  "--      (усього і за 30 днів) / остання активність / інтеграції — по рядку на центр.",
  "--   6. Передрук сторожа: №23 (шість ключів, дайджести заміряно на проді у",
  "--      відкоченій транзакції), №24 (виняток для операторів), два абзаци, №25.",
  "--",
  "--  ⚠️ ЦІНА І НАСЛІДКИ, названі заздалегідь:",
  "--     • оператор — акаунт `authenticated` без профілю: RLS віддає йому нуль рядків,",
  "--       definer-функції для `authenticated` відмовляють (`auth_role()` NULL) — усі",
  "--       читання контуру йдуть під service_role ПІСЛЯ гейта `requirePlatformOperator`;",
  "--     • перший оператор — роутом `/api/platform/bootstrap` під CRON_SECRET, лише поки",
  "--       таблиця порожня (потім роут інертний: 409);",
  "--     • відкат ВІДМОВЛЯЄ, якщо в таблицях пакета є рядки (дані не викидаються мовчки);",
  "--     • `tests/tzKyivPhase2.test.ts` пінить `k:clinics` — тому статус центру живе в",
  "--       ОКРЕМІЙ таблиці, а `clinics` DDL не торкається (і адмін центру не може",
  "--       виставити собі статус через `clinics_update`).",
  "--",
  "--  ЯК НАКОЧУВАТИ (канон 0203/0204/0205):",
  "--   1. `node scripts/build-0206-reprint.mjs` → цей файл + `scripts/frag/0206_*.sql`.",
  "--   2. Тимчасова гілка на GitHub ЛИШЕ з фрагами → `net.http_get` → sha256 =",
  "--      контейнер → `scripts/frag/0206_dryrun.sql` (виняток `DRYRUN_0206_ROLLBACK …`).",
  "--   3. `scripts/frag/0206_apply.sql` (commit) → контрольне читання.",
  "--   4. `scripts/frag/0206_falsify.sql` (виняток `FALSIFY_0206 verdict=PASS …`).",
  "--   5. `supabase/smoke/0206_platform_operators_smoke.sql` → `SMOKE_OK`.",
  "--   6. `npm run db:gate` (ЛИШЕ з машини власника) → `invariants_check`: failed лише",
  `--      ${KNOWN_RED.join(", ")} (або порожньо).`,
  "--   7. git ОДНИМ заходом: гілка → dev → main → push → штамп деплою; вікно",
  "--      закрите, коли `npm run db:gate:check` зелений на `main` І на `dev`. Не",
  "--      закрили 6–7 у цей захід — `scripts/frag/0206_rollback.sql`, а не",
  "--      «доробимо завтра».",
  "--   8. ⚠️ ПІСЛЯ КРОКУ 6 генератор НЕ ЗАПУСКАТИ (перезаписує файл із md5 у леджері).",
  "-- ============================================================================",
  "",
  "begin;",
  "",
  "-- ── 0. Предстан (ідемпотентний: 0205 або вже 0206) ─────────────────────────",
  MIG_PRE,
  "",
  "-- ── 1. Три таблиці контуру платформи: deny-all RLS, без клієнтських грантів ──",
  DDL_TABLES(true),
  "",
  "-- ── 2. Функція статистики по центрах (INVOKER, лише service_role) ──────────",
  FN_STMT,
  "",
  FN_ACL_DDL,
  "",
  "-- ── 3. Передрук сторожа: №23 (шість ключів), №24 (оператори не сироти), абзаци ──",
  "",
].join("\n");

const MIG_TAIL = [
  "",
  `comment on function public.invariants_check(boolean) is '${PIN}';`,
  "",
  "-- ── 4. ПОВНИЙ сторож після передруку і DDL (≈9 с; має бути зеленим, крім названого №13) ─",
  MIG_CHK,
  "",
  "-- ── 5. Пост-асерти: тіло сторожа, самопін, обʼєкти пакета, ACL функції ─────────",
  MIG_POST,
  "",
  "insert into public.migration_ledger (name)",
  `values ('${DST_NAME}')`,
  "on conflict (name) do nothing;",
  "",
  "commit;",
  "",
  "-- ============================================================================",
  "-- === ВІДКАТ ===",
  "--",
  "--  1. База: `scripts/frag/0206_rollback.sql` — знімає функцію і три таблиці (лише",
  `--     ПОРОЖНІ), тіло сторожа 0205 (${PRE_MD5} / ${PRE_LEN}), самопін 0205,`,
  "--     рядок леджера. Якщо в таблицях уже є рядки — спершу вивантажити і",
  "--     спорожнити за явним списком id. Перевіряти ОКРЕМИМ запитом після commit.",
  "--  2. Git — ОДНИМ кроком: видалити цей файл, `scripts/frag/0206_*.sql`,",
  "--     `scripts/build-0206-reprint.mjs`, `supabase/smoke/0206_platform_operators_smoke.sql`,",
  "--     `tests/platformOperators0206.test.ts`, контур `app/platform`, `app/api/platform`,",
  "--     `lib/platformAuth.ts`, `components/PlatformConsole.tsx`; гілки оператора в",
  "--     `middleware`, `/api/auth/login`, `LoginPage`; розділ у `AGENTS.md` і рядки в ToDo.",
  "-- ============================================================================",
].join("\n");

const MIG = MIG_HEAD + "\n" + SRC.prologue + NEW_BODY + "$function$;\n" + MIG_TAIL + "\n";

{
  const heads = MIG.match(REPRINT_RE_G) || [];
  if (heads.length !== 1) throw new Error(`ФАЙЛ: заголовків передруку ${heads.length}, а треба 1`);
  const loose = MIG.indexOf("create or replace function public.invariants_check");
  const anchored = MIG.search(/^create or replace function public\.invariants_check/m);
  if (loose !== anchored) throw new Error(`ФАЙЛ: фраза create-or-replace сторожа вперше на ${loose}, а заголовок на ${anchored}`);
  const pins = [...MIG.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PIN) throw new Error(`ФАЙЛ: піни ${JSON.stringify(pins)}, а треба рівно ${PIN}`);
  if (count(MIG, OPEN) !== 1 || count(MIG, CLOSE) !== 1) throw new Error("ФАЙЛ: межі тіла не унікальні");
  for (const t of ["$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$q$", "$smoke$"]) {
    if (MIG.includes(t)) throw new Error(`ФАЙЛ містить тег фрагмента ${t}`);
  }
  const tail = MIG.slice(MIG.lastIndexOf("insert into public.migration_ledger (name)"));
  if (!tail.startsWith(`insert into public.migration_ledger (name)\nvalues ('${DST_NAME}')\non conflict (name) do nothing;\n\ncommit;\n`)) {
    throw new Error("ФАЙЛ: рядок леджера не останній перед commit");
  }
  if (count(MIG, "\nbegin;\n") !== 1 || count(MIG, "\ncommit;\n") !== 1) throw new Error("ФАЙЛ: begin/commit не по одному");
  if (MIG.indexOf("=== ВІДКАТ ===") < 0 || MIG.indexOf("=== ВІДКАТ ===") < MIG.indexOf("\ncommit;\n")) throw new Error("ФАЙЛ: секція ВІДКАТ не в кінці");
  const chk = (() => {
    const txt = MIG;
    const ddl0 = txt.search(/^create or replace function public\.invariants_check/m);
    const a = txt.indexOf(OPEN, ddl0);
    const b = txt.indexOf(CLOSE, a);
    return txt.slice(a + OPEN.length, b + 1);
  })();
  if (md5(chk) !== NEW_MD5 || chk.length !== NEW_LEN) throw new Error("ФАЙЛ: тіло у файлі ≠ NEW_BODY");
  /* ⚠️ ЯКОРІ СТЕНДІВ У ФАЙЛІ (канон 0203/0204/0205): кожен літерал стенда, що живе в тілі,
     трапляється у файлі рівно стільки разів, скільки в тілі; і жоден
     УНІКАЛЬНИЙ у тілі рядок (≥ 24 знаки) не має копії поза тілом — стенди
     мутують файл останнього передруку ЦІЛКОМ і вимагають унікальності якоря. */
  {
    const dup = [];
    let n = 0;
    for (const x of STAND_LITERALS) {
      const inBody = count(NEW_BODY, x);
      if (!inBody) continue;
      n++;
      const inFile = count(MIG, x);
      if (inFile !== inBody) dup.push(`стенд ${JSON.stringify(x.slice(0, 70))}: тіло ${inBody}, файл ${inFile}`);
    }
    let lines = 0;
    for (const line of new Set(NEW_BODY.split("\n"))) {
      if (line.trim().length < 24 || count(NEW_BODY, line) !== 1) continue;
      lines++;
      if (count(MIG, line) !== 1) dup.push(`рядок ${JSON.stringify(line.trim().slice(0, 70))}: у файлі ${count(MIG, line)}`);
    }
    if (dup.length) throw new Error(`ФАЙЛ: текст тіла скопійовано поза тіло (стенди отримають «ЯКІР НЕ УНІКАЛЬНИЙ»):\n  ${dup.join("\n  ")}`);
    console.log(`  файл: ${n} якорів стендів і ${lines} унікальних рядків тіла — жодної копії поза тілом`);
  }
  // Урок с25: зірочка+слеш у рядковому коментарі шапки закриває блочний коментар достроково
  // (тут сам цей рядок — рядковий, щоб не повторити урок у генераторі).
  const STAR_SLASH = "*" + "/";
  if (MIG.split("\n").filter((l) => /^\s*--/.test(l)).some((l) => l.includes(STAR_SLASH))) throw new Error(`ФАЙЛ: ${STAR_SLASH} у рядковому коментарі`);
  if (exoticWs(MIG_HEAD) || exoticWs(MIG_TAIL)) throw new Error("ФАЙЛ: не-ASCII пробіл у шапці/хвості");
  /* tests/profilesDefaultsInvariant: рівно ОДНА міграція має містити цей текст — не ця. */
  if (/alter table public\.profiles alter column role\s+drop default;/.test(MIG)) throw new Error("ФАЙЛ: містить рядок, що дозволений лише одній міграції");
}

for (const [lbl, txt] of [["APPLY", APPLY], ["DRYRUN", DRYRUN], ["ROLLBACK", ROLLBACK], ["FALSIFY", FALSIFY]]) {
  for (const t of ["$pre$", "$chk$", "$post$"]) if (txt.includes(t)) throw new Error(`${lbl} містить тег файлу ${t}`);
  if (lbl !== "FALSIFY" && count(txt, "do $") !== 1) throw new Error(`${lbl}: do-блоків не один`);
  if (txt.split("\n").filter((l) => /^\s*--/.test(l)).some((l) => l.includes("*" + "/"))) throw new Error(`${lbl}: зірочка-слеш у рядковому коментарі`);
}
if (!APPLY.includes("$fxa$") || APPLY.includes(BEHAVIOR_PROBE("apply"))) throw new Error("APPLY: проба не вимкнена або функція не виконується");
if (!DRYRUN.includes("DRYRUN_0206_ROLLBACK") || !FALSIFY.includes("FALSIFY_0206 verdict=PASS")) throw new Error("фрагменти без маркерів відкату");
if (!ROLLBACK.includes("drop table if exists public.platform_operators;") || ROLLBACK.indexOf("drop table if exists public.platform_log;") > ROLLBACK.indexOf("drop table if exists public.platform_operators;")) throw new Error("ROLLBACK: порядок drop не від залежних до базової");

// ---------------------------------------------------------------------------
// 10. ЗАПИС.
// ---------------------------------------------------------------------------
if (existsSync(DST_MIG) && !FORCE && readFileSync(DST_MIG, "utf8") !== MIG) {
  throw new Error(`${DST_MIG} уже є і відрізняється — після db:gate перезапис заборонено (--force лише свідомо)`);
}
writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0206_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0206_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0206_rollback.sql", ROLLBACK + "\n");
writeFileSync("scripts/frag/0206_falsify.sql", FALSIFY + "\n");
console.log([
  `0206: ${DST_MIG} — ${MIG.length} символів`,
  `  сторож: ${PRE_MD5}/${PRE_LEN} → ${NEW_MD5}/${NEW_LEN}; пін ${PIN}`,
  `  №23: 84 → 90 ключів; №24: виняток для platform_operators; ${FN}: md5 тіла ${FN_BODY_MD5}`,
  `  стендів ${STANDS_N}, літералів звірено ${STAND_LITS_CHECKED}`,
  `  фраги: apply ${APPLY.length}, dryrun ${DRYRUN.length}, rollback ${ROLLBACK.length}, falsify ${FALSIFY.length}`,
].join("\n"));
