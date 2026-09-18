// build-0202-reprint.mjs — збирає supabase/migrations/0202_tz_kyiv_no_catalog_scan.sql
// і scripts/frag/0202_{apply,dryrun,rollback,falsify}.sql.
//
// ЩО РОБИТЬ ПАКЕТ (рішення власника Р74-3(а), 15.09,
// `docs/audit/DECISIONS-2026-09-15-s74.md`; замір — `DECISIONS-PACKET-2026-09-15-s74.md`
// і `docs/audit/PERF-2026-09-12-pg-timezone-names.md` §7б) — ФАЗА 2 ТАЙМЗОН:
//   1. ДАНІ: єдиний центр на legacy-аліасі `Europe/Kiev` переїздить на канонічний
//      `Europe/Kyiv`. За явним id і з до-образом (правило прод-даних): рядків із
//      `Europe/Kiev` мусить бути РІВНО один і саме цей; інакше — стоп.
//   2. CHECK `clinics_timezone_chk` (0192) звужується до ('Europe/Kyiv', 'UTC'):
//      аліас більше не може повернутись записом. Дайджест `k:clinics` у №23 —
//      передрук.
//   3. ШІСТЬ функцій позбуваються скану `pg_timezone_names` (замір с74: холодний
//      скан 795–950 мс НА ВИКЛИК, у двох рядкових тригерах `queue_entries` — на
//      КОЖЕН запис; ~90 % вартості запису в чергу). Скан ВАЛІДУВАВ назву зони і
//      падав на 'UTC'; з 0192 назву стереже CHECK на ЗАПИСІ, а після п.2 обидва
//      дозволені імені гарантовано є в tzdata Postgres — валідувати на читанні
//      більше нічого. Форма правки — `coalesce(c.timezone, 'UTC')` замість
//      підзапиту, рівно одне влучання на функцію; решта тіла дослівна.
//        • у №19: `emergency_stop_rpc`, `queue_set_status_rpc`, `submit_incident_rpc`,
//          `room_busy_slots` — чотири рядки списку отримують нові md5 (склад 59
//          той самий);
//        • поза №19 (прийнятий ризик, рішення 13.09): `check_no_overlap`,
//          `check_not_in_past` — рядкові тригери; їхні визначення тримає №17,
//          тіла — ніхто. Це межа, названа в прозі й показана у фальсифікації.
//   4. Передрук сторожа: 4 md5 №19 + `k:clinics` №23 + проза. `checked` 26 -> 26.
//
// ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК з 0201 (`latestReprint()` у тестах бере ОСТАННІЙ
//    файл, де рядок ПОЧИНАЄТЬСЯ з create-or-replace сторожа).
//
// ⚠️ ТЕКСТИ ШЕСТИ ФУНКЦІЙ — З РЕПОЗИТОРІЮ, і генератор доводить паритет із продом:
//    нормалізований md5 (формула `cur` №19) тексту з файла міграції = md5 на проді
//    (замір 16.09) у ПʼЯТИ з шести. `emergency_stop_rpc` на проді лежить зі
//    СКОРОЧЕНИМИ коментарями (клас 0195/0201: чернетка через execute_sql) — код
//    тотожний (звірено diff-ом без коментарів), і 0202 перестворює її повним
//    текстом 0168. Відкат повертає САМЕ прод-текст (`scripts/frag/
//    0202_prev_emergency_stop_rpc.body.sql`, md5 ac62900b…), інакше сторож 0201
//    після відкату червонів би `body:`.
//
// ⚠️ GOOGLE CALENDAR: `clinics.timezone` їде в поле `timeZone` події дзеркала
//    (`lib/googleCalendarBackup.ts`). Передумова пакета — зонд
//    `scripts/gcal-tz-probe.mjs` у календарі власника: Google приймає
//    `Europe/Kyiv` і дає той самий офсет, що `Europe/Kiev`. Протокол —
//    `docs/audit/PR-0202-tz-kyiv-no-catalog-scan.md`. Відбиток події зони не
//    містить: наявні події в Google лишаються з `Europe/Kiev`, доки запис не
//    зміниться; нові — з `Europe/Kyiv`. Той самий офсет, той самий час.
//
// ⚠️ ПІСЛЯ `npm run db:gate` ЦЕЙ ГЕНЕРАТОР НЕ ЗАПУСКАТИ: він перезаписує файл
//    міграції, чий md5 уже в леджері. Без `--force` відмовляється, якщо зміст інший.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const count = (s, needle) => s.split(needle).length - 1;
const FORCE = process.argv.includes("--force");

const MIGDIR = "supabase/migrations";
const SRC_NAME = "0201_pin_gated_rpcs_role_surface.sql";
const SRC_MIG = `${MIGDIR}/${SRC_NAME}`;
const DST_NAME = "0202_tz_kyiv_no_catalog_scan.sql";
const DST_MIG = `${MIGDIR}/${DST_NAME}`;
const PREV_LEDGER = SRC_NAME;
const PRE_MD5 = "f0134c6203dacab659fd85648c5e9aa9";
const PRE_LEN = 164374;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const CHECKED = 26;

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

// ---------------------------------------------------------------------------
// 1. БАЗИСИ ДЖЕРЕЛА. Кожен — числом.
// ---------------------------------------------------------------------------
const SRC = split(SRC_MIG);
if (md5(SRC.body) !== PRE_MD5 || SRC.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0201 дав ${md5(SRC.body)} / ${SRC.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}
if (SRC.head + SRC.prologue + SRC.body + "$function$;" + SRC.tail !== SRC.raw) {
  throw new Error("СКЛЕЙКА ЗЛАМАНА: 0201 не збирається назад побайтово");
}
{
  const pins = [...SRC.raw.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PRE_PIN) {
    throw new Error(`ПІН 0201 у файлі ${JSON.stringify(pins)}, а в проді ${PRE_PIN}`);
  }
}
{
  const later = readdirSync(MIGDIR)
    .filter((f) => f.endsWith(".sql") && f > SRC_NAME && f !== DST_NAME).sort();
  if (later.length) throw new Error(`після 0201 на диску вже є ${later.join(", ")} — номер 0202 зайнятий чи черга зсунулась`);
}

// ---------------------------------------------------------------------------
// 2. ДАНІ І CHECK. До-образ знято 16.09 запитом: рівно ОДИН рядок на аліасі.
// ---------------------------------------------------------------------------
const CLINIC_ID = "c79588d6-c379-4949-9c23-a22c227a12e1";   // Medicom — тестовий центр власника
const TZ_FROM = "Europe/Kiev";
const TZ_TO = "Europe/Kyiv";
/** Рендер Postgres (`pg_get_constraintdef`) — ДО і ПІСЛЯ. Форма ДО знята з
    прода 16.09 і збігається з асертом 0192; форма ПІСЛЯ — той самий рендер на
    два елементи (сухий прогін звіряє його живим `pg_get_constraintdef`). */
const CON_NAME = "clinics_timezone_chk";
const CON_DEF_OLD = "CHECK ((timezone = ANY (ARRAY['Europe/Kyiv'::text, 'Europe/Kiev'::text, 'UTC'::text])))";
const CON_DEF_NEW = "CHECK ((timezone = ANY (ARRAY['Europe/Kyiv'::text, 'UTC'::text])))";
const CON_DDL_OLD = "check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'))";
const CON_DDL_NEW = "check (timezone in ('Europe/Kyiv', 'UTC'))";
/** Пʼять рядків `kon` для `clinics` — ті самі, що дайджестить гілка `k:` №23
    (замір 16.09; формула нижче відтворює заміряний `5:588baa1ac5d2`). */
const KON_LINES_OLD = [
  "clinics_max_cascade_chk:c:CHECK (((max_cascade_patients >= 1) AND (max_cascade_patients <= 100)))",
  "clinics_overlap_threshold_chk:c:CHECK ((((overlap_threshold_min >= 5) AND (overlap_threshold_min <= 120)) AND ((overlap_threshold_min % 5) = 0)))",
  "clinics_pkey:p:PRIMARY KEY (id)",
  "clinics_queue_delay_policy_chk:c:CHECK ((queue_delay_policy = ANY (ARRAY['manual'::text, 'cascade_shift'::text, 'reschedule_conflicts'::text])))",
  `${CON_NAME}:c:${CON_DEF_OLD}`,
];
const konDigest = (lines) => `${lines.length}:${md5([...lines].sort().join(",")).slice(0, 12)}`;
const DIG_OLD = "5:588baa1ac5d2";
if (konDigest(KON_LINES_OLD) !== DIG_OLD) throw new Error(`ФОРМУЛА k: не відтворює прод-дайджест ${DIG_OLD}: ${konDigest(KON_LINES_OLD)}`);
const KON_LINES_NEW = KON_LINES_OLD.map((l) => (l.startsWith(`${CON_NAME}:`) ? `${CON_NAME}:c:${CON_DEF_NEW}` : l));
const DIG_NEW = konDigest(KON_LINES_NEW);
if (DIG_NEW === DIG_OLD || !/^5:[0-9a-f]{12}$/.test(DIG_NEW)) throw new Error(`дайджест k:clinics ПІСЛЯ підозрілий: ${DIG_NEW}`);

// ---------------------------------------------------------------------------
// 3. ШІСТЬ ФУНКЦІЙ. Текст — з останнього визначення в репозиторії; паритет із
//    продом — нормалізованим md5 (замір 16.09). Одна підстановка на функцію.
// ---------------------------------------------------------------------------
const TZ_SCAN = "coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')";
const TZ_DIRECT = "coalesce(c.timezone, 'UTC')";
const norm = (s) => s.replace(/\s+/g, " ").trim();
/** Той самий вирізувач коментарів, що в `tests/guardFnBodiesInvariant.test.ts`. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const A_RPC = "secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres";
const A_TRG = "secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres";
const A_RBS = "secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres";

const NOTE_TRG = [
  "-- 0202: скан `pg_timezone_names` прибрано. Назву зони стереже CHECK",
  "--   `clinics_timezone_chk` на ЗАПИСІ ('Europe/Kyiv', 'UTC' — 0192, звужено 0202);",
  "--   обидва імені є в tzdata Postgres, валідувати на читанні нічого. Холодний скан",
  "--   коштував 795–950 мс на виклик (замір с74) — тут, у рядковому тригері, на",
  "--   КОЖЕН запис черги. Відкат на 'UTC' нижче лишається: клініки може не бути.",
];
const NOTE_RPC = [
  "-- 0202: скан `pg_timezone_names` прибрано — назву зони стереже CHECK",
  "--   `clinics_timezone_chk` на ЗАПИСІ ('Europe/Kyiv', 'UTC'), обидва імені є в",
  "--   tzdata Postgres. Холодний скан коштував 795–950 мс на виклик (замір с74).",
];
const NOTE_RBS = [
  "-- 0202: підзапит до `pg_timezone_names` прибрано і звідси — валідацію назви",
  "--   несе CHECK `clinics_timezone_chk` на записі ('Europe/Kyiv', 'UTC'). CTE",
  "--   лишається materialized з тієї ж причини, що в 0189 (одне обчислення).",
];

/** [fn, file, headRe, pinned, attrs, prodMd5, note, extraPairs] */
const FN_SPECS = [
  ["check_no_overlap", "0079_needs_reschedule_status.sql",
    /^create or replace function public\.check_no_overlap\(\)/m, false, A_TRG,
    "d2c71a4280b4d19f29982c42903d7b32", NOTE_TRG, []],
  ["check_not_in_past", "0079_needs_reschedule_status.sql",
    /^create or replace function public\.check_not_in_past\(\)/m, false, A_TRG,
    "2eb31b6cd4d200bfdda7299cffba54b2", NOTE_TRG, []],
  ["queue_set_status_rpc", "0136_radiologist_room_scope.sql",
    /^create or replace function public\.queue_set_status_rpc\(/m, true, A_RPC,
    "ef04f36d0d79727429074451cb6a4efb", NOTE_RPC, []],
  ["emergency_stop_rpc", "0168_emergency_stop_returns_incident_ids.sql",
    /^create function public\.emergency_stop_rpc\(/m, true, A_RPC,
    "ac62900bdcd7d5cd689f5aa9066d99b9", NOTE_RPC, []],
  ["submit_incident_rpc", "0110_fix_submit_incident_variable_conflict.sql",
    /^CREATE OR REPLACE FUNCTION public\.submit_incident_rpc\(/m, true, A_RPC,
    "3534d77cd3d27c72aa7d3d454d09aa86", NOTE_RPC, []],
  ["room_busy_slots", "0189_room_busy_slots_tz_once.sql",
    /^create or replace function public\.room_busy_slots\(/m, true, A_RBS,
    "83ddb89d6b1cd33ae19c8d314d29b73c", NOTE_RBS, [
      ["  --   клініку → рівно одне значення `c.timezone`. Валідація зони і відкат на\n  --   'UTC' — БЕЗ ЗМІН, переїхала тільки позиція обчислення.\n",
        "  --   клініку → рівно одне значення `c.timezone`. (0189: валідація зони і\n  --   відкат на 'UTC' без змін; 0202: валідацію через каталог прибрано.)\n",
        "room_busy_slots: проза 0189 про валідацію"],
    ]],
];
/** Прод-текст `emergency_stop_rpc` (скорочені коментарі) — для відкату. */
const ESR_PREV_BODY = readFileSync("scripts/frag/0202_prev_emergency_stop_rpc.body.sql", "utf8").replace(/\r/g, "");
if (md5(norm(ESR_PREV_BODY)) !== "ac62900bdcd7d5cd689f5aa9066d99b9") throw new Error("прод-текст emergency_stop_rpc у frag/ не збігається із заміром");

/** Витяг statement-а `create … function` з файла міграції: від заголовка до
    `<тег>;` включно. Тіло — між `as <тег>` і `<тег>;` (це і є prosrc). */
function cutStatement(file, headRe) {
  const txt = readFileSync(`${MIGDIR}/${file}`, "utf8").replace(/\r/g, "");
  const starts = [...txt.matchAll(new RegExp(headRe.source, "gm"))].map((m) => m.index);
  if (starts.length !== 1) throw new Error(`${file}: заголовків за ${headRe} — ${starts.length}, а треба 1`);
  const st = starts[0];
  const m = /\bas\s+(\$[a-z0-9_]*\$)\n/i.exec(txt.slice(st));
  if (!m) throw new Error(`${file}: не знайдено 'as $тег$'`);
  const tag = m[1];
  const bodyStart = st + m.index + m[0].length - 1;   // тіло починається з '\n'
  const end = txt.indexOf(`\n${tag};`, bodyStart);
  if (end < 0) throw new Error(`${file}: не знайдено кінець тіла ${tag};`);
  const stmt = txt.slice(st, end + tag.length + 2);
  const body = txt.slice(bodyStart, end + 1);
  if (count(stmt, tag) !== 2) throw new Error(`${file}: тег ${tag} у statement-і не двічі`);
  return { stmt, body, tag, header: txt.slice(st, bodyStart) };
}

const FNS = FN_SPECS.map(([fn, file, headRe, pinned, attrs, prodMd5, note, extra]) => {
  const old = cutStatement(file, headRe);
  const oldMd5 = md5(norm(old.body));
  if (fn !== "emergency_stop_rpc" && oldMd5 !== prodMd5) {
    throw new Error(`${fn}: текст ${file} дає ${oldMd5}, а на проді ${prodMd5} — паритету немає, пінити наосліп заборонено`);
  }
  // `create function` (0168 після drop) → `create or replace function`.
  let stmt = old.stmt.replace(/^create function public\./i, "create or replace function public.")
    .replace(/^CREATE OR REPLACE FUNCTION public\./, "create or replace function public.");
  if (!/^create or replace function public\./.test(stmt)) throw new Error(`${fn}: заголовок не create or replace`);
  if (count(stmt, TZ_SCAN) !== 1) throw new Error(`${fn}: скан pg_timezone_names трапляється ${count(stmt, TZ_SCAN)} раз(ів), а треба 1`);
  // нотатка — рядком вище, з відступом того самого рядка
  const lineStart = stmt.lastIndexOf("\n", stmt.indexOf(TZ_SCAN)) + 1;
  const indent = /^[ \t]*/.exec(stmt.slice(lineStart))[0];
  const noteText = note.map((l) => indent + l).join("\n") + "\n";
  stmt = stmt.slice(0, lineStart) + noteText + stmt.slice(lineStart);
  stmt = stmt.replace(TZ_SCAN, TZ_DIRECT);
  for (const [from, to, lbl] of extra) {
    if (count(stmt, from) !== 1) throw new Error(`${fn}: пара «${lbl}» — ${count(stmt, from)} влучань`);
    stmt = stmt.replace(from, to);
  }
  if (codeOf(stmt).includes("pg_timezone_names")) throw new Error(`${fn}: у КОДІ нового тексту лишився pg_timezone_names`);
  if (count(stmt, TZ_DIRECT) !== 1) throw new Error(`${fn}: coalesce(c.timezone, 'UTC') не рівно один`);
  if (!/set search_path (= public, pg_temp|to 'public', 'pg_temp')/i.test(stmt)) throw new Error(`${fn}: у заголовку немає search_path = public, pg_temp — cfg= у піні розʼїхався б`);
  if (!/security definer/i.test(stmt)) throw new Error(`${fn}: заголовок без security definer`);
  // тіло нового statement-а — між тим самим тегом
  const m = /\bas\s+(\$[a-z0-9_]*\$)\n/i.exec(stmt);
  const bodyStart = m.index + m[0].length - 1;
  const end = stmt.lastIndexOf(`\n${old.tag};`);
  const newBody = stmt.slice(bodyStart, end + 1);
  const newMd5 = md5(norm(newBody));
  if (newMd5 === prodMd5) throw new Error(`${fn}: md5 не змінився — підстановка порожня`);
  const prevStmt = fn === "emergency_stop_rpc"
    ? old.stmt.replace(/^create function public\./, "create or replace function public.").split(old.body).join(ESR_PREV_BODY)
    : old.stmt.replace(/^CREATE OR REPLACE FUNCTION public\./, "create or replace function public.");
  if (md5(norm(cutBodyOf(prevStmt, old.tag))) !== prodMd5) throw new Error(`${fn}: текст відкату не дає прод-md5`);
  // ⚠️ Єдиний тег для всіх шести: `$function$` (0110/0168) зіткнувся б із межами
  //    тіла сторожа (`split()` вимагає унікальних `as $function$` / `$function$;`).
  //    Тег не входить у prosrc, md5 не міняється; тіло тег не містить (асерт).
  // ⚠️ Лише літери в тезі: `tests/slotOccupancy.test.ts` читає тег регуляркою `\$([A-Za-z_]*)\$`.
  const TAG = "$fnbody$";
  const retag = (text) => {
    if (count(text, old.tag) !== 2) throw new Error(`${fn}: тег ${old.tag} не двічі перед заміною`);
    if (text.includes(TAG)) throw new Error(`${fn}: текст уже містить ${TAG}`);
    return text.split(old.tag).join(TAG);
  };
  const stmtT = retag(stmt), prevT = retag(prevStmt);
  if (md5(norm(cutBodyOf(stmtT, TAG))) !== newMd5 || md5(norm(cutBodyOf(prevT, TAG))) !== prodMd5) throw new Error(`${fn}: після заміни тега md5 поїхав`);
  return { fn, pinned, attrs, prodMd5, newMd5, stmt: stmtT, prevStmt: prevT, tag: TAG, oldRepoMd5: oldMd5 };
});
function cutBodyOf(stmt, tag) {
  const m = /\bas\s+(\$[a-z0-9_]*\$)\n/i.exec(stmt);
  const bodyStart = m.index + m[0].length - 1;
  const end = stmt.lastIndexOf(`\n${tag};`);
  return stmt.slice(bodyStart, end + 1);
}
for (const f of FNS) {
  if (count(f.stmt, f.tag) !== 2 || count(f.prevStmt, f.tag) !== 2) throw new Error(`${f.fn}: тег ${f.tag} не двічі`);
  for (const t of ["$p$", "$apply$", "$dryrun$", "$back$", "$falsify$", "$function$", "$data$"]) {
    if (f.stmt.includes(t) || f.prevStmt.includes(t)) throw new Error(`${f.fn}: текст містить чужий тег ${t}`);
  }
}
const PINNED_FNS = FNS.filter((f) => f.pinned);
if (PINNED_FNS.length !== 4) throw new Error("пінованих функцій мусить бути 4");
const SIG_OF = {
  emergency_stop_rpc: "emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)",
  queue_set_status_rpc: "queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)",
  submit_incident_rpc: "submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)",
  room_busy_slots: "room_busy_slots(p_room uuid, p_date date, p_exclude uuid)",
};
const rowText = (sig, body, attrs) => `      ('${sig}','${body}','${attrs}'),`;
/** Повний заголовок на проді (16.09): аргументи з DEFAULT-ами і тип результату.
    `create or replace` міняє DEFAULT-и МОВЧКИ (ревʼю с75, лінза А) — фрагмент
    звіряє їх ДО і ПІСЛЯ; identity-аргументи №19 дефолтів не несуть. */
const HEAD_OF = {
  check_no_overlap: ["", "trigger"],
  check_not_in_past: ["", "trigger"],
  queue_set_status_rpc: ["p_id uuid, p_status queue_status, p_expected queue_status DEFAULT NULL::queue_status, p_allowed queue_status[] DEFAULT NULL::queue_status[], p_note text DEFAULT NULL::text, p_set_note boolean DEFAULT false",
    "TABLE(updated boolean, current_status queue_status, previous_status queue_status, clinic_id uuid, referrer_id uuid)"],
  emergency_stop_rpc: ["p_room_ids uuid[], p_date date, p_note text DEFAULT NULL::text",
    "TABLE(stopped integer, affected integer, stopped_rooms uuid[], stopped_incidents jsonb, patients jsonb)"],
  submit_incident_rpc: ["p_room_id uuid, p_reason text, p_id uuid DEFAULT NULL::uuid, p_reason_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_blocked_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_auto_unblock boolean DEFAULT true",
    "TABLE(id uuid, status text, not_held integer)"],
  room_busy_slots: ["p_room uuid, p_date date, p_exclude uuid DEFAULT NULL::uuid",
    "TABLE(scheduled_time text, duration_min integer, buffer_time_min integer, start_min integer, end_study_min integer, end_min integer, status text, patient_name text, studies jsonb)"],
};

// ---------------------------------------------------------------------------
// 4. ПАРИ ПІДСТАНОВКИ В ТІЛІ СТОРОЖА. Код: 4 рядки №19 (md5) + 1 рядок №23 (k:clinics).
//    Проза: історія №19, абзац 0202 у №19, ремарка в №23. Кожна — рівно одне влучання.
// ---------------------------------------------------------------------------
const ROW_PAIRS = PINNED_FNS.map((f) => [
  rowText(SIG_OF[f.fn], f.prodMd5, f.attrs),
  rowText(SIG_OF[f.fn], f.newMd5, f.attrs),
  `№19: ${f.fn} md5 ${f.prodMd5.slice(0, 8)}… → ${f.newMd5.slice(0, 8)}…`,
]);
const KON_PAIR = [
  `      ('k:clinics','${DIG_OLD}'),`,
  `      ('k:clinics','${DIG_NEW}'),`,
  "№23: дайджест k:clinics (CHECK звужено)",
];
const HIST_FROM = "  --        0193 → 40, 0200 → 43, 0201 → 59), а заголовок ніхто не перечитував: 0192 оновила\n";
const HIST_TO = "  --        0193 → 40, 0200 → 43, 0201 → 59; 0202 → 59, чотири md5 передруковано без\n"
  + "  --        зміни складу), а заголовок ніхто не перечитував: 0192 оновила\n";
const P0201_END = "  --        ⚠️ Замір рядків 15.09: перевантажень немає; у\n"
  + "  --           `save_schedule_override` поле `cfg=` несе ще й\n"
  + "  --           `DateStyle=ISO, MDY` — це частина піна, а не шум.\n"
  + "  v_n := v_n + 1;\n";
const PROSE_0202 = [
  "  --     ⚠️ 0202 ПЕРЕДРУКУВАЛА ЧОТИРИ md5 БЕЗ ЗМІНИ СКЛАДУ (список так само 59):",
  "  --        `emergency_stop_rpc`, `queue_set_status_rpc`, `submit_incident_rpc`,",
  "  --        `room_busy_slots` позбулися підзапиту до `pg_timezone_names` —",
  "  --        назву зони з 0192 стереже CHECK на записі, а 0202 звузила його до",
  "  --        ('Europe/Kyiv', 'UTC'). Рішення власника Р74-3(а), 15.09; пакет —",
  "  --        `docs/audit/PR-0202-tz-kyiv-no-catalog-scan.md`. ⚠️ `emergency_stop_rpc`",
  "  --        на проді лежала зі скороченими коментарями (клас 0195); 0202",
  "  --        перестворює її повним текстом 0168 — код той самий.",
  "  --        ⚠️ МЕЖА, показана у фальсифікації 0202: рядкові тригери",
  "  --           `check_no_overlap` і `check_not_in_past` теж змінено, і їхніх тіл",
  "  --           у цьому списку НЕМАЄ (прийнятий ризик 13.09, розвилка 2) —",
  "  --           мутація тіла лишає сторожа зеленим. №17 тримає лише",
  "  --           ВИЗНАЧЕННЯ тригерів.",
  "  v_n := v_n + 1;",
].join("\n") + "\n";
const P23_FROM = "  --       k: таблиця     — CONSTRAINT-и (імʼя, тип, повний `constraintdef`);\n";
const P23_TO = "  --       k: таблиця     — CONSTRAINT-и (імʼя, тип, повний `constraintdef`);\n"
  + "  --                      ⚠️ 0202: `clinics_timezone_chk` звужено до\n"
  + "  --                      ('Europe/Kyiv', 'UTC') — дайджест `k:clinics` передруковано;\n";
const PAIRS = [
  ...ROW_PAIRS,
  KON_PAIR,
  [HIST_FROM, HIST_TO, "проза №19: історія росту"],
  [P0201_END, P0201_END.replace(/  v_n := v_n \+ 1;\n$/, "") + PROSE_0202, "проза №19: абзац 0202"],
  [P23_FROM, P23_TO, "проза №23: ремарка k:clinics"],
];

// ---------------------------------------------------------------------------
// 5. ХІД УПЕРЕД.
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
  // length() у PG рахує символи, .length у JS — одиниці UTF-16: поза BMP вони розходяться
  if ([...NEW_BODY].length !== NEW_LEN) throw new Error("тіло має символи поза BMP — length у PG і JS розійдуться");
}

// ---------------------------------------------------------------------------
// 6. ЗМІСТОВІ ПЕРЕВІРКИ.
// ---------------------------------------------------------------------------
const ROW_RE = /^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm;
const listOf = (body) => {
  const open = "with expd(fn, body, attrs) as (values";
  const a = body.indexOf(open);
  const b = body.indexOf("    ), cur as (", a);
  if (a < 0 || b < 0) throw new Error("список №19 не знайдено");
  return body.slice(a, b);
};
const sigsOf = (list) => (list.match(ROW_RE) || []).map((r) => r.slice(r.indexOf("('") + 2, r.indexOf("',")));
const OLD_SIGS = sigsOf(listOf(SRC.body));
const NEW_SIGS = sigsOf(listOf(NEW_BODY));
const OLD_CODE = codeOf(SRC.body).split("\n");
const NEW_CODE = codeOf(NEW_BODY).split("\n");
const STEP = /^  v_n := v_n \+ 1;$/gm;

const CHECKS = [
  ["склад №19 незмінний (59 підписів, та сама множина)", () =>
    OLD_SIGS.length === 59 && NEW_SIGS.length === 59 && OLD_SIGS.join("\n") === NEW_SIGS.join("\n")],
  ["код без коментарів: рівно 5 рядків змінено — 4 md5 №19 і 1 дайджест №23", () => {
    if (OLD_CODE.length !== NEW_CODE.length) return false;
    const diff = [];
    for (let i = 0; i < OLD_CODE.length; i++) if (OLD_CODE[i] !== NEW_CODE[i]) diff.push([OLD_CODE[i], NEW_CODE[i]]);
    const want = [...ROW_PAIRS, KON_PAIR].map(([f, t]) => [f, t]);
    return diff.length === 5 && want.every(([f, t]) => diff.some(([a, b]) => a === f && b === t));
  }],
  ["кожен новий md5 у списку рівно раз, старих немає", () =>
    PINNED_FNS.every((f) => count(NEW_BODY, `'${f.newMd5}'`) === 1 && count(NEW_BODY, `'${f.prodMd5}'`) === 0)],
  ["дайджест k:clinics: новий рівно раз, старого немає", () =>
    count(NEW_BODY, `'${DIG_NEW}'`) === 1 && count(NEW_BODY, `'${DIG_OLD}'`) === 0],
  ["число кроків `v_n := v_n + 1` те саме (checked 26)", () =>
    (SRC.body.match(STEP) || []).length === CHECKED && (NEW_BODY.match(STEP) || []).length === CHECKED],
  ["перевірка №26 і її 62 ключі не зачеплені", () =>
    count(NEW_BODY, "'check', 'role_surface'") === count(SRC.body, "'check', 'role_surface'")
    && NEW_BODY.slice(NEW_BODY.indexOf("with recursive cr(oid) as (")) === SRC.body.slice(SRC.body.indexOf("with recursive cr(oid) as ("))],
  ["проза 0202 названа в №19 і №23", () =>
    count(NEW_BODY, "0202 ПЕРЕДРУКУВАЛА ЧОТИРИ md5") === 1 && count(NEW_BODY, "0202: `clinics_timezone_chk` звужено") === 1],
  ["зворотний хід дає 0201 побайтово", () => {
    let back = NEW_BODY;
    for (const [from, to, lbl] of [...PAIRS].reverse()) {
      if (count(back, to) !== 1) throw new Error(`ЗВОРОТНИЙ ХІД «${lbl}»: ${count(back, to)} влучань`);
      back = back.split(to).join(from);
    }
    return back === SRC.body && md5(back) === PRE_MD5;
  }],
  ["перший рядок тіла і хвіст — як у 0201", () =>
    NEW_BODY.startsWith(SRC.body.slice(0, 200)) && NEW_BODY.endsWith(SRC.body.slice(-400))],
  ["шість функцій: у коді жодного pg_timezone_names, у кожній рівно один coalesce(c.timezone, 'UTC')", () =>
    FNS.every((f) => !codeOf(f.stmt).includes("pg_timezone_names") && count(f.stmt, TZ_DIRECT) === 1)],
  ["шість функцій: код без коментарів = старий код з однією підстановкою", () =>
    FNS.every((f) => norm(codeOf(f.prevStmt).replace(TZ_SCAN, TZ_DIRECT)) === norm(codeOf(f.stmt)))],
  ["чотири піновані: новий md5 ≠ прод-md5, рядок 0201 з прод-md5 і тими самими attrs існує", () =>
    PINNED_FNS.every((f) => f.newMd5 !== f.prodMd5 && count(SRC.body, rowText(SIG_OF[f.fn], f.prodMd5, f.attrs)) === 1)],
  ["до-образ: рівно один id, валідний uuid; зони різні; рендер CHECK узгоджений із DDL", () =>
    /^[0-9a-f-]{36}$/.test(CLINIC_ID) && TZ_FROM !== TZ_TO
    && CON_DEF_NEW.includes(`'${TZ_TO}'::text`) && !CON_DEF_NEW.includes(`'${TZ_FROM}'`)
    && CON_DDL_NEW.includes(`'${TZ_TO}'`) && !CON_DDL_NEW.includes(`'${TZ_FROM}'`)
    && CON_DEF_OLD.includes(`'${TZ_FROM}'::text`) && CON_DDL_OLD.includes(`'${TZ_FROM}'`)],
];
for (const [what, fn] of CHECKS) {
  if (!fn()) throw new Error(`ПЕРЕВІРКА НЕ ПРОЙШЛА: ${what}`);
}

// ---------------------------------------------------------------------------
// 7. ВИРАЗИ, ВИРІЗАНІ з тіла сторожа: `cur` №19 і `kon`/`konagg` №23.
// ---------------------------------------------------------------------------
const CUR_EXPR = (() => {
  const open = "    ), cur as (";
  const close = "\n    )\n    select";
  if (count(NEW_BODY, open) !== 1) throw new Error("якір `    ), cur as (` у тілі не 1");
  const a = NEW_BODY.indexOf(open);
  const b = NEW_BODY.indexOf(close, a);
  const label = NEW_BODY.indexOf("'check', 'guard_fn_bodies'", a);
  if (b < 0 || label < 0 || b > label) throw new Error("термінатор виразу cur не знайдено до мітки №19");
  return NEW_BODY.slice(a + open.length, b);
})();
for (const [lbl, re] of [
  ["джерело pg_proc", /from pg_proc p\n/],
  ["повний md5 нормалізованого тіла", /md5\(btrim\(regexp_replace\(/],
  ["поле ;acl=", /';acl='\s*\|\|\s*case when p\.proacl is null then '<default>'/],
  ["розширення по голому імені", /p\.proname = any \(select split_part\(e\.fn, '\(', 1\) from expd e\)/],
]) if (!re.test(CUR_EXPR)) throw new Error(`ВИРАЗ cur: немає «${lbl}»`);
if (/--|\/\*|\$/.test(CUR_EXPR)) throw new Error("ВИРАЗ cur містить коментар або долар");

/** Гілка `kon` + `konagg` №23 — дослівно з тіла (між `), kon as (` і `), enu as (`). */
const KON_EXPR = (() => {
  const open = "  ), kon as (";
  const close = "\n  ), enu as (";
  if (count(NEW_BODY, open) !== 1 || count(NEW_BODY, close) !== 1) throw new Error("якорі kon/enu у тілі не по одному");
  const a = NEW_BODY.indexOf(open);
  const b = NEW_BODY.indexOf(close, a);
  const label = NEW_BODY.indexOf("'check', 'schema_digest'", a);
  if (b < 0 || label < 0 || b > label) throw new Error("kon: термінатор не до мітки №23");
  return NEW_BODY.slice(a + open.length, b);
})();
for (const [lbl, re] of [
  ["pg_get_constraintdef", /pg_get_constraintdef\(co\.oid\)/],
  ["дайджест count:md5", /count\(\*\)::text \|\| ':'\n\s+\|\| substr\(md5\(string_agg\(line, ',' order by line\)\), 1, 12\) as dig/],
  ["конагрегат", /\), konagg as \(/],
]) if (!re.test(KON_EXPR)) throw new Error(`ВИРАЗ kon: немає «${lbl}»`);
if (/--|\/\*|\$/.test(KON_EXPR)) throw new Error("ВИРАЗ kon містить коментар або долар");
/** Живий дайджест `k:clinics` тим самим текстом: `with kon as (…), konagg as (…) select dig …`. */
const KON_LIVE = "  with kon as (" + KON_EXPR + "\n  )\n  select dig into v_dig from konagg where key = 'k:clinics';";

// ---------------------------------------------------------------------------
// 8. ЗВІРКА СТЕНДОВИХ ЯКОРІВ ЗА ЛІТЕРАЛАМИ (лексер із 0201, лінза Б с74).
// ---------------------------------------------------------------------------
function literalsOf(src) {
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
      if (plain) { const v = decode(raw); if (v.length >= 12) out.push(v); }
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

{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  if (stands.length < 30) throw new Error(`ЯКОРІ: лише ${stands.length} стендів — очікувалось ≥30`);
  const migs = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql") && f !== DST_NAME);
  const stale = [];
  const ambiguous = [];
  let checked = 0;
  for (const f of stands) {
    const txt = readFileSync(`scripts/${f}`, "utf8").replace(/\r/g, "");
    const named = migs.filter((m) => txt.includes(`${MIGDIR}/${m}`) && m !== SRC_NAME);
    for (const lit of new Set(literalsOf(txt))) {
      const before = count(SRC.body, lit);
      if (before === 0) continue;
      checked++;
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
  if (checked < 100) throw new Error(`ЯКОРІ: звірено лише ${checked} літералів — розбір стендів зламався`);
  if (stale.length) throw new Error(`ЯКОРІ ПРОТУХЛИ:\n  ${stale.join("\n  ")}`);
  console.log(`  якорі стендів: ${stands.length} файлів, ${checked} літералів у тілі сторожа, 0 протухлих`);
}

// ---------------------------------------------------------------------------
// 9. ФРАГМЕНТИ. Теги: $p$ — рядки підстановок; $fN$ — statement-и функцій;
//    блоки — $apply$/$dryrun$/$back$/$falsify$. Жоден текст не сміє нести чужий тег.
// ---------------------------------------------------------------------------
const FN_TAGS = FNS.map((_, i) => `$fx${"abcdef"[i]}$`);
for (const t of ["$p$", "$apply$", "$dryrun$", "$back$", "$falsify$", ...FN_TAGS]) {
  for (const [f, to, lbl] of PAIRS) {
    if ((f + to).includes(t)) throw new Error(`пара «${lbl}» містить тег ${t}`);
  }
  if (CUR_EXPR.includes(t) || KON_EXPR.includes(t)) throw new Error(`вираз cur/kon містить тег ${t}`);
  for (const fn of FNS) if (fn.stmt.includes(t) || fn.prevStmt.includes(t)) throw new Error(`${fn.fn}: statement містить тег ${t}`);
}
const q = (s) => `$p$${s}$p$`;
/** SQL-літерал з подвоєнням апострофів (рендер CHECK несе `'…'::text`). */
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const arr = (xs) => "array[\n" + xs.map((x) => `    ${q(x)}`).join(",\n") + "\n  ]";
const fnExec = (i, stmt) => `  execute ${FN_TAGS[i]}\n${stmt.replace(/;\s*$/, "")}\n${FN_TAGS[i]};`;

const PRE = (tag) => [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування",
  "  -- ролі оператора (урок 0196).",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  `    raise exception '${tag}: мусить іти від ролі postgres, а йде від %', current_user;`,
  "  end if;",
].join("\n");

const LEDGER_GUARDS = [
  `  if exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0202: рядок уже в леджері — повторний накат заборонено';",
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  "    raise exception '0202: у леджері немає 0201 — накат не в свою чергу';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${PREV_LEDGER}' then`,
  "    raise exception '0202: останній рядок леджера % — не 0201, черга зсунулась',",
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

/** Живі рядки шести функцій — ТИМ САМИМ виразом `cur`, вирізаним із тіла. */
const SIG6 = {
  ...SIG_OF,
  check_no_overlap: "check_no_overlap()",
  check_not_in_past: "check_not_in_past()",
};
const NAMES6_SQL = FNS.map((f) => `'${f.fn}'`).join(", ");
const liveRows = (tag, which, what) => [
  `  -- ── Живі рядки шести функцій ${what} — виразом \`cur\` №19, вирізаним з тіла ──`,
  "  -- ⚠️ плюс ПОВНИЙ заголовок (аргументи з DEFAULT-ами, тип результату): identity-",
  "  --    аргументи дефолтів не несуть, а `create or replace` міняє їх мовчки.",
  "  --    NULL-безпечно (`not exists … is not distinct from`), без фільтра prokind:",
  "  --    процедура з таким імʼям теж мусить стати порушником, а не випасти з NOT IN.",
  "  --    `prokind::text` обовʼязково: тип \"char\" у конкатенації дає 42725",
  "  --    «operator is not unique: text || \"char\"» — зловив сухий прогін 17.09.",
  "  select array_agg(x.txt order by x.txt) into v_bad from (",
  "    select 'head:' || p.proname || ':' || p.prokind::text || '->' || coalesce(pg_get_function_arguments(p.oid), '<null>')",
  "             || ' => ' || coalesce(pg_get_function_result(p.oid), '<null>') as txt",
  "      from pg_proc p where p.pronamespace = 'public'::regnamespace",
  `       and p.proname in (${NAMES6_SQL})`,
  "       and not exists (select 1 from (values",
  FNS.map((f) => `         ('${f.fn}', ${lit(HEAD_OF[f.fn][0])}, ${lit(HEAD_OF[f.fn][1])})`).join(",\n"),
  "       ) h(fn, args, res)",
  "        where h.fn = p.proname and p.prokind = 'f'",
  "          and h.args is not distinct from pg_get_function_arguments(p.oid)",
  "          and h.res is not distinct from pg_get_function_result(p.oid))) x;",
  "  if v_bad is not null then",
  `    raise exception '${tag}: заголовок функції ${what} не той, що на проді 16.09: %', v_bad;`,
  "  end if;",
  "  select count(*) into v_hits from pg_proc p",
  "   where p.pronamespace = 'public'::regnamespace",
  `     and p.proname in (${NAMES6_SQL});`,
  "  if v_hits <> 6 then",
  `    raise exception '${tag}: обʼєктів із шістьма іменами % замість 6 — перевантаження', v_hits;`,
  "  end if;",
  "  with expd(fn, body, attrs) as (values",
  FNS.map((f) => `      ('${SIG6[f.fn]}','${which === "old" ? f.prodMd5 : f.newMd5}','${f.attrs}')`).join(",\n"),
  "    ), cur as (" + CUR_EXPR,
  "    )",
  "  select array_agg(x.txt order by x.txt) into v_bad",
  "    from (",
  "      select 'missing:' || e.fn as txt from expd e",
  "       where not exists (select 1 from cur c where c.fn = e.fn)",
  "      union all",
  "      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn",
  "       where c.body <> e.body",
  "      union all",
  "      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn",
  "       where c.attrs <> e.attrs",
  "      union all",
  "      select 'extra:' || c.fn from cur c",
  "       where not exists (select 1 from expd e where e.fn = c.fn)",
  "    ) x;",
  "  if v_bad is not null then",
  `    raise exception '${tag}: живі рядки шести функцій ${what} не збіглися: %', v_bad;`,
  "  end if;",
].join("\n");

/** Доказ у ТІЙ САМІЙ транзакції, що назва зони, на яку переїздять дані, є в
    tzdata ЦЬОГО сервера і дає той самий настінний час, що назва, з якої
    їдуть. Порівняння двох РІЗНИХ імен (перша редакція порівнювала Kyiv із
    Kyiv — ревʼю с75, раунд 2): `at time zone` невідомої зони кидає 22023, а
    різний результат означає, що одне з імен — не Київ. */
const TZ_PROOF = (tag, tzNew, tzOld) => {
  if (tzNew === tzOld) throw new Error("TZ_PROOF: два імені мусять бути різними");
  return [
    `  -- ⚠️ ДОКАЗ, що '${tzNew}' є в tzdata ЦЬОГО сервера і = '${tzOld}', у ТІЙ САМІЙ`,
    "  --    транзакції (ревʼю с75): свіжі дистрибутиви виносять legacy-імена в",
    "  --    tzdata-legacy, а замір 16.09 — поза пакетом. Невідома зона кидає 22023.",
    `  if (now() at time zone '${tzNew}') is distinct from (now() at time zone '${tzOld}')`,
    `     or (now() at time zone '${tzNew}') is null then`,
    `    raise exception '${tag}: зона ${tzNew} на цьому сервері не дає той самий час, що ${tzOld} — стоп';`,
    "  end if;",
  ].join("\n");
};
const DATA_FWD = (tag) => [
  "  -- ── ДАНІ: один центр з аліаса на канонічну назву — за явним id і до-образом ──",
  TZ_PROOF(tag, TZ_TO, TZ_FROM),
  `  select array_agg(id order by id) into v_ids from public.clinics where timezone = '${TZ_FROM}';`,
  `  if v_ids is distinct from array['${CLINIC_ID}']::uuid[] then`,
  `    raise exception '${tag}: рядки на ${TZ_FROM} = % — не заміряний до-образ {${CLINIC_ID}}; стоп', v_ids;`,
  "  end if;",
  `  if exists (select 1 from public.clinics where timezone not in ('${TZ_FROM}', '${TZ_TO}', 'UTC')) then`,
  `    raise exception '${tag}: у clinics є зона поза списком 0192 — CHECK не тримає?';`,
  "  end if;",
  `  update public.clinics set timezone = '${TZ_TO}' where id = '${CLINIC_ID}' and timezone = '${TZ_FROM}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  `    raise exception '${tag}: оновлено % рядків clinics замість 1', v_rows;`,
  "  end if;",
  `  if exists (select 1 from public.clinics where timezone = '${TZ_FROM}') then`,
  `    raise exception '${tag}: після оновлення ще є ${TZ_FROM}';`,
  "  end if;",
].join("\n");

const CON_READ = "  select pg_get_constraintdef(co.oid) into v_con from pg_constraint co\n"
  + `   where co.conrelid = 'public.clinics'::regclass and co.conname = '${CON_NAME}';`;
const CON_COMMENT_NEW = [
  `comment on constraint ${CON_NAME} on public.clinics is`,
  "  'Список свідомий: властивості немає (підзапит у CHECK заборонений, '",
  "  'функція над pg_timezone_names не імутабельна). 0202: Europe/Kiev прибрано — '",
  "  'прод переїхав на Europe/Kyiv, а читання (тригери й RPC) більше не валідують '",
  "  'зону через каталог: назву стереже САМЕ цей CHECK. NULL цей CHECK НЕ ловить '",
  "  '(in (…) дає NULL) — його тримає not null. Новий пояс = міграція + передрук '",
  "  '№23 (k:clinics). 0192, 0202.';",
].join("\n");
const CON_COMMENT_OLD = [
  `comment on constraint ${CON_NAME} on public.clinics is`,
  "  'Список свідомий: властивості немає (підзапит у CHECK заборонений, '",
  "  'функція над pg_timezone_names не імутабельна). Europe/Kiev — живий '",
  "  'legacy-алиас прода, зганяння з нього — задача фази 2 таймзон, не CHECK-а. '",
  "  'NULL цей CHECK НЕ ловить (in (…) дає NULL) — його тримає not null. '",
  "  'Новий пояс = міграція + передрук №23 (k:clinics). 0192.';",
].join("\n");
const conDdl = (ddl) => `  alter table public.clinics drop constraint ${CON_NAME};\n  alter table public.clinics\n    add constraint ${CON_NAME}\n    ${ddl};`;
const CHECK_FWD = (tag) => [
  "  -- ── CHECK: аліас прибрано зі списку; рендер і дайджест k:clinics — ДО і ПІСЛЯ ──",
  CON_READ,
  `  if v_con is distinct from ${lit(CON_DEF_OLD)} then`,
  `    raise exception '${tag}: рендер ${CON_NAME} до правки = % — не форма 0192', coalesce(v_con, '(немає)');`,
  "  end if;",
  KON_LIVE,
  `  if v_dig is distinct from '${DIG_OLD}' then`,
  `    raise exception '${tag}: дайджест k:clinics до правки % ≠ ${DIG_OLD}', v_dig;`,
  "  end if;",
  conDdl(CON_DDL_NEW),
  "  " + CON_COMMENT_NEW.replace(/\n/g, "\n  "),
  CON_READ,
  `  if v_con is distinct from ${lit(CON_DEF_NEW)} then`,
  `    raise exception '${tag}: рендер ${CON_NAME} після правки = % — не очікувана форма', v_con;`,
  "  end if;",
  KON_LIVE,
  `  if v_dig is distinct from '${DIG_NEW}' then`,
  `    raise exception '${tag}: дайджест k:clinics після правки % ≠ ${DIG_NEW} — пін №23 розійшовся б', v_dig;`,
  "  end if;",
].join("\n");

const FUNCS_FWD = (tag) => [
  liveRows(tag, "old", "ДО (паритет із продом, замір 16.09)"),
  "",
  "  -- ── Шість функцій без скану каталогу: повний текст із репозиторію ──────────",
  "  -- ⚠️ `create or replace` зберігає власника, ACL і SET; `attrs` у рядках нижче",
  "  --    звіряються ПІСЛЯ — розбіжність зупиняє накат.",
  ...FNS.map((f, i) => fnExec(i, f.stmt)),
  "",
  liveRows(tag, "new", "ПІСЛЯ (md5 нових текстів із генератора)"),
].join("\n");

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

const DECL = (tag, fromXs, toXs, lblXs) => [
  "-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний",
  "--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.",
  "set statement_timeout = '5min';",
  `do $${tag}$`,
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[];",
  "  v_ids uuid[]; v_con text; v_dig text; v_qid uuid; v_plan jsonb; v_t text;",
  "  v_ms numeric[] := '{}'; v_trg numeric[] := '{}';",
  `  v_from constant text[] := ${arr(fromXs)};`,
  `  v_to   constant text[] := ${arr(toXs)};`,
  `  v_lbl  constant text[] := ${arr(lblXs)};`,
  "begin",
].join("\n");

const FWD = [PAIRS.map((p) => p[0]), PAIRS.map((p) => p[1]), PAIRS.map((p) => p[2])];
const BWD = [[...PAIRS].reverse().map((p) => p[1]), [...PAIRS].reverse().map((p) => p[0]),
  [...PAIRS].reverse().map((p) => `назад: ${p[2]}`)];

const LEDGER_INSERT = [
  "  insert into public.migration_ledger (name)",
  `  values ('${DST_NAME}');`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0202: рядок леджера не ліг (% рядків)', v_rows;",
  "  end if;",
].join("\n");

const READBACK = [
  "select md5(replace(p.prosrc, chr(13), '')) as guard_md5,",
  "       length(replace(p.prosrc, chr(13), '')) as guard_len,",
  "       obj_description(p.oid, 'pg_proc') as guard_pin,",
  "       (select count(*) from public.migration_ledger) as ledger_rows,",
  "       (select max(name) from public.migration_ledger) as ledger_last,",
  `       (select timezone from public.clinics where id = '${CLINIC_ID}') as clinic_tz,`,
  `       (select pg_get_constraintdef(co.oid) from pg_constraint co where co.conrelid = 'public.clinics'::regclass and co.conname = '${CON_NAME}') as con_def,`,
  "       -- ⚠️ рахуємо ТОЧНИЙ підзапит скану, не слово: нотатки 0202 і проза сторожа несуть `pg_timezone_names` у коментарях",
  `       (select count(*) from pg_proc f where f.pronamespace = 'public'::regnamespace and f.prosrc like ${lit("%" + TZ_SCAN + "%")}) as fns_with_scan`,
  "  from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  " where n.nspname = 'public' and p.proname = 'invariants_check'",
  "   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
].join("\n");

/** Замір: холостий update майбутнього запису під EXPLAIN ANALYZE (виконується і
    відкочується разом із блоком; даних не міняє — та сама форма, що зонд с74). */
const MEASURE = (label) => [
  "  select q.id into v_qid from public.queue_entries q",
  "   where q.status = 'scheduled' and q.scheduled_at > now() + interval '1 day'",
  "   order by q.scheduled_at limit 1;",
  "  -- ⚠️ замір допоміжний: помилка тригера на конкретному записі (OVERLAP тощо)",
  "  --    не сміє валити сухий прогін — у масиви лягає -2 (ревʼю с75, лінза Б)",
  "  if v_qid is not null then",
  "    for i in 1 .. 2 loop",
  "      begin",
  "        execute format('explain (analyze, format json) update public.queue_entries set duration_min = duration_min where id = %L', v_qid) into v_t;",
  "        v_plan := v_t::jsonb;",
  "        v_ms := v_ms || (v_plan->0->>'Execution Time')::numeric;",
  "        v_trg := v_trg || coalesce((select (t->>'Time')::numeric from jsonb_array_elements(v_plan->0->'Triggers') t",
  "                                      where t->>'Trigger Name' = 'trg_no_overlap'), -1);",
  "      exception when others then",
  "        v_ms := v_ms || -2::numeric; v_trg := v_trg || -2::numeric;",
  "      end;",
  "    end loop;",
  "  else",
  "    v_ms := v_ms || array[-3, -3]::numeric[]; v_trg := v_trg || array[-3, -3]::numeric[];",
  `    raise notice '0202-суха: ${label} — майбутнього scheduled-запису немає, замір пропущено (-3)';`,
  "  end if;",
].join("\n");

const BODY_FWD = (tag) => [
  PRE(tag),
  LEDGER_GUARDS,
  readGuard(tag, PRE_MD5, PRE_LEN, PRE_PIN, "0201"),
  "",
  DATA_FWD(tag),
  "",
  CHECK_FWD(tag),
  "",
].join("\n");

const APPLY = [
  "-- 0202 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0202-reprint.mjs`. Одним запитом,",
  "-- ОДНА транзакція: дані → CHECK → шість функцій → передрук сторожа → пін → леджер.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна (кілька верхньорівневих",
  "--    стейтментів = кілька транзакцій; обрив між ними лишає прод половинчастим).",
  "-- ⚠️ ТЕКСТ СЛАТИ ДОСЛІВНО: тіла шести функцій усередині $fx?$ і якорі всередині $p$",
  "--    входять у md5 — «прибрати рядки-коментарі» (як робили з 0201) зламає пост-",
  "--    перевірки, і накат зупиниться (fail-closed, дрейфу не буде, але й накату теж).",
  "-- ⚠️ БЛОКУВАННЯ: `alter table clinics` бере ACCESS EXCLUSIVE на clinics до кінця",
  "--    транзакції (секунди: шість create or replace + передрук + пін). Не поруч з",
  "--    іншим DDL; тихе вікно. Трафік читання clinics стоїть ці секунди.",
  DECL("apply", ...FWD),
  BODY_FWD("0202"),
  FUNCS_FWD("0202"),
  "",
  "  -- ── Передрук сторожа: 4 md5 №19, дайджест k:clinics №23, проза ────────────",
  substitute("0202", "v_from", "v_to", "v_lbl", NEW_MD5, NEW_LEN, "файл 0202"),
  "",
  pinBlock("0202", PIN),
  "",
  LEDGER_INSERT,
  "",
  "  raise notice 'APPLY_0202_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$apply$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN},`,
  `--   guard_pin = ${PIN}, ledger_rows = 202, ledger_last = ${DST_NAME},`,
  `--   clinic_tz = ${TZ_TO}, con_def = ${CON_DEF_NEW}, fns_with_scan = 0`,
  READBACK,
  "",
  "-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit. Не в 03:45–04:05 UTC.",
  "--      select public.invariants_check(false);",
  `--      -- очікування: checked ${CHECKED}; до \`npm run db:gate\` єдиний ОЧІКУВАНИЙ`,
  "--      -- порушник — `ledger_md5`.",
].join("\n");

const DRY_LABELS = "('guard_fn_bodies', 'guard_self_pin', 'schema_digest', 'secdef_search_path', 'guard_triggers', 'room_busy_service_role')";
const DRYRUN = [
  "-- 0202 DRY RUN — ЗГЕНЕРОВАНО `node scripts/build-0202-reprint.mjs`. Те саме, що",
  "-- APPLY, плюс ЗАМІР до/після і повний прогін сторожа; транзакція СВІДОМО",
  "-- валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ.",
  "-- ⚠️ Тег блоку — dryrun. Перед вставкою перевірити, що запит ПОЧИНАЄТЬСЯ з нього.",
  "-- ⚠️ БЛОКУВАННЯ: після `alter table clinics` ACCESS EXCLUSIVE на clinics тримається до",
  "--    кінця блоку — а тут ще шість create or replace, замір «після» і ПОВНИЙ прогін",
  "--    сторожа (≈10–15 с). Лише в тихе вікно; не поруч з деплоєм чи іншим DDL.",
  "-- ⚠️ ЗАМІР: холостий `update … set duration_min = duration_min` одного майбутнього",
  "--    запису під EXPLAIN ANALYZE, двічі ДО правки функцій і двічі ПІСЛЯ; усе",
  "--    відкочується. Перший прогін ДО — зазвичай холодний скан (сотні мс), другий —",
  "--    теплий (десятки); ПІСЛЯ обидва мусять бути одиниці мс. Чесна пара для",
  "--    порівняння — ДРУГИЙ до і ДРУГИЙ після (той самий бекенд).",
  DECL("dryrun", ...FWD),
  PRE("0202-суха"),
  LEDGER_GUARDS,
  readGuard("0202-суха", PRE_MD5, PRE_LEN, PRE_PIN, "0201"),
  "",
  "  -- ⚠️ замір ДО — перед DDL на clinics: інакше ACCESS EXCLUSIVE тримався б і",
  "  --    на час холодного скану (ревʼю с75)",
  MEASURE("до"),
  "",
  DATA_FWD("0202-суха"),
  "",
  CHECK_FWD("0202-суха"),
  "",
  FUNCS_FWD("0202-суха"),
  "",
  MEASURE("після"),
  "",
  substitute("0202-суха", "v_from", "v_to", "v_lbl", NEW_MD5, NEW_LEN, "файл 0202"),
  "",
  pinBlock("0202-суха", PIN),
  "",
  LEDGER_INSERT,
  "",
  "  v_res := public.invariants_check(false);",
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '0202-суха: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  if exists (select 1 from jsonb_array_elements(v_res->'failed') e",
  `              where e.value->>'check' in ${DRY_LABELS}) then`,
  "    raise exception '0202-суха: №2/№9/№17/№19/№23/№25 ЧЕРВОНА одразу після накату: %', v_res->'failed';",
  "  end if;",
  "",
  "  raise exception 'DRYRUN_0202_ROLLBACK guard=% len=% pin=% checked=% ok=% failed=% update_ms=% trg_no_overlap_ms=% (до1,до2,після1,після2)',",
  "    md5(v_src), length(v_src), v_pin_db, v_res->>'checked', v_res->>'ok', v_res->'failed', v_ms, v_trg;",
  "end;",
  "$dryrun$;",
  "",
  "-- ⚠️ `ledger_md5` у сухому прогоні червона ОЧІКУВАНО (штампує `npm run db:gate`).",
].join("\n");

const ROLLBACK = [
  "-- 0202 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0202-reprint.mjs`.",
  "-- Повертає: шість функцій до прод-текстів (emergency_stop_rpc — до тексту зі",
  "-- скороченими коментарями, бо саме його md5 пінить 0201), CHECK до списку 0192,",
  "-- центр до `Europe/Kiev`, тіло сторожа і самопін до 0201, знімає рядок леджера.",
  "-- ⚠️ Одна транзакція. Перевіряти ОКРЕМИМ запитом після commit.",
  DECL("back", ...BWD),
  PRE("0202-відкат"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0202-відкат: рядка 0202 у леджері немає — відкочувати нічого';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${DST_NAME}' then`,
  "    raise exception '0202-відкат: після 0202 уже накатано % — спершу відкотити його',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  readGuard("0202-відкат", NEW_MD5, NEW_LEN, PIN, "0202"),
  "",
  liveRows("0202-відкат", "new", "ДО відкату (тексти 0202)"),
  "",
  ...FNS.map((f, i) => fnExec(i, f.prevStmt)),
  "",
  liveRows("0202-відкат", "old", "ПІСЛЯ відкату (прод-тексти до 0202)"),
  "",
  "  -- ── CHECK назад до списку 0192 — ПЕРЕД даними: вузький CHECK 0202 не пропустив",
  "  --    би рядок на Europe/Kiev (перша редакція робила навпаки — знайшли обидві",
  "  --    лінзи ревʼю с75; саме це доводить R1 фальсифікації) ──",
  CON_READ,
  `  if v_con is distinct from ${lit(CON_DEF_NEW)} then`,
  `    raise exception '0202-відкат: рендер ${CON_NAME} = % — не форма 0202', coalesce(v_con, '(немає)');`,
  "  end if;",
  conDdl(CON_DDL_OLD),
  "  " + CON_COMMENT_OLD.replace(/\n/g, "\n  "),
  CON_READ,
  `  if v_con is distinct from ${lit(CON_DEF_OLD)} then`,
  `    raise exception '0202-відкат: рендер після відкату = % — не форма 0192', v_con;`,
  "  end if;",
  KON_LIVE,
  `  if v_dig is distinct from '${DIG_OLD}' then`,
  `    raise exception '0202-відкат: дайджест k:clinics % ≠ ${DIG_OLD}', v_dig;`,
  "  end if;",
  "  -- ── дані назад: аліас мусить бути в tzdata ЦЬОГО сервера, інакше відкат сам",
  "  --    створить падаючі читання (ревʼю с75, лінза Б) ──",
  TZ_PROOF("0202-відкат", TZ_FROM, TZ_TO),
  `  update public.clinics set timezone = '${TZ_FROM}' where id = '${CLINIC_ID}' and timezone = '${TZ_TO}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0202-відкат: повернуто % рядків clinics замість 1 (не той стан)', v_rows;",
  "  end if;",
  "",
  substitute("0202-відкат", "v_from", "v_to", "v_lbl", PRE_MD5, PRE_LEN, "0201"),
  "",
  pinBlock("0202-відкат", PRE_PIN),
  "",
  `  delete from public.migration_ledger where name = '${DST_NAME}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0202-відкат: знято % рядків леджера замість 1', v_rows;",
  "  end if;",
  "",
  "  raise notice 'ROLLBACK_0202_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$back$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${PRE_MD5}, guard_len = ${PRE_LEN},`,
  `--   guard_pin = ${PRE_PIN}, ledger_rows = 201, ledger_last = ${PREV_LEDGER},`,
  `--   clinic_tz = ${TZ_FROM}, con_def = ${CON_DEF_OLD}, fns_with_scan = 6`,
  READBACK,
  "",
  "-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: асерти — усередині транзакції. Після",
  "--    commit ОКРЕМИМ запитом читання назад вище і `select public.invariants_check(false);`",
  `--    (checked ${CHECKED}, без \`guard_fn_bodies\`/\`schema_digest\`). Git-частина — секція ВІДКАТ у міграції.`,
].join("\n");

// ── ФАЛЬСИФІКАЦІЯ ──────────────────────────────────────────────────────────
const WANT19 = PINNED_FNS.map((f) => `body:${SIG6[f.fn]}->`);
const WANT23 = `changed:k:clinics:${DIG_NEW}->${DIG_OLD}`;
for (const w of [...WANT19, WANT23]) if (/'/.test(w)) throw new Error(`WANT: лапка в ${w}`);
const NAMES4_SQL = PINNED_FNS.map((f) => `'${f.fn}'`).join(", ");

const FALSIFY = [
  "-- 0202 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0202-reprint.mjs`.",
  "-- Піни мусять ЛОВИТИ, а не лише лягти. Один прогін сторожа на всі мутації,",
  "-- транзакція СВІДОМО валиться в кінці. Предстан перевіряти ОКРЕМИМ запитом.",
  "-- ⚠️ ПЕРЕДУМОВА: 0202 у леджері, тіло/пін 0202, живі рядки шести функцій = нові",
  "--    md5, дайджест k:clinics = новий. Дрейф — стоп, а не хибний PASS.",
  "-- МУТАЦІЇ:",
  "--   R1  update clinics → Europe/Kiev за явним id → МУСИТЬ дати check_violation",
  "--       саме від clinics_timezone_chk (імʼя constraint-а, не клас помилки);",
  "--   R2  update clinics → UTC за явним id → проходить (законне значення), і",
  "--       повертається на Europe/Kyiv (до-образ 0202);",
  "--   M1–M4 тіло КОЖНОЇ з чотирьох пінованих — рядок коментаря → 4 × `body:`;",
  "--   M5  CHECK розширено назад до списку 0192 → №23 `changed:k:clinics:<нове>-><старе>`;",
  "--   B1  межа: тіло `check_no_overlap` теж мутовано — сторож НЕ червоніє (поза",
  "--       №19, прийнятий ризик 13.09). Вердикт ВИМАГАЄ цієї тиші: якщо колись її",
  "--       запінять — цей разовий фрагмент застаріє, і це буде видно.",
  "-- ⚠️ БЛОКУВАННЯ: DDL на clinics + повний прогін сторожа (≈10–15 с) під ACCESS",
  "--    EXCLUSIVE на clinics; лише в тихе вікно, не поруч з іншим DDL.",
  "-- ⚠️ other_failed СТРОГИЙ: будь-яка runtime-перевірка (cron_*, outbox_*, gcal_*,",
  "--    auth_orphan_accounts, server_now), червона в момент прогону, дасть FAIL не",
  "--    від пакета — прочитати other_failed і повторити, а не «підправити» вердикт.",
  "set statement_timeout = '5min';",
  "do $falsify$",
  "declare",
  "  v_res jsonb; v_off19 text[]; v_off23 text[]; v_miss text[]; v_extra text[]; v_other text[];",
  "  v_def text; v_n int := 0; v_fn record; v_hits int; v_bad text[]; v_con text; v_dig text; v_tz text;",
  "  v_r1 boolean := false; v_r2 boolean := false; v_b1 boolean;",
  `  v_want19 constant text[] := ${arr(WANT19)};`,
  `  v_want23 constant text := ${q(WANT23)};`,
  "begin",
  PRE("0202-фальсифікація"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0202-фальсифікація: 0202 не накатано — фальсифікувати нічого';",
  "  end if;",
  "  if (select md5(replace(p.prosrc, chr(13), '')) || '/' || length(replace(p.prosrc, chr(13), ''))",
  "             || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '(NULL)')",
  "        from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "       where n.nspname = 'public' and p.proname = 'invariants_check'",
  "         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')",
  `     is distinct from '${NEW_MD5}/${NEW_LEN}|${PIN}' then`,
  "    raise exception '0202-фальсифікація: у проді не тіло/пін 0202 — спершу розібратись';",
  "  end if;",
  liveRows("0202-фальсифікація", "new", "(передумова)"),
  KON_LIVE,
  `  if v_dig is distinct from '${DIG_NEW}' then`,
  `    raise exception '0202-фальсифікація: дайджест k:clinics % ≠ ${DIG_NEW} — передумова не виконана', v_dig;`,
  "  end if;",
  `  select timezone into v_tz from public.clinics where id = '${CLINIC_ID}';`,
  `  if v_tz is distinct from '${TZ_TO}' then`,
  `    raise exception '0202-фальсифікація: центр % на зоні %, а не ${TZ_TO}', '${CLINIC_ID}', v_tz;`,
  "  end if;",
  "",
  "  -- R1: аліас назад — CHECK мусить відкинути, і саме своїм імʼям",
  "  begin",
  `    update public.clinics set timezone = '${TZ_FROM}' where id = '${CLINIC_ID}';`,
  "    raise exception '0202-фальсифікація: R1 — CHECK ПРОПУСТИВ Europe/Kiev';",
  "  exception",
  "    when check_violation then",
  "      get stacked diagnostics v_con = constraint_name;",
  `      if v_con is distinct from '${CON_NAME}' then`,
  "        raise exception '0202-фальсифікація: R1 спрацював ЧУЖИМ constraint-ом «%»', v_con;",
  "      end if;",
  "      v_r1 := true;",
  "  end;",
  "  -- R2: законне значення проходить; повертаємо до-образ 0202",
  `  update public.clinics set timezone = 'UTC' where id = '${CLINIC_ID}';`,
  `  if (select timezone from public.clinics where id = '${CLINIC_ID}') <> 'UTC' then`,
  "    raise exception '0202-фальсифікація: R2 — законне UTC не пройшло';",
  "  end if;",
  `  update public.clinics set timezone = '${TZ_TO}' where id = '${CLINIC_ID}';`,
  "  v_r2 := true;",
  "",
  "  -- M1–M4 (+ B1): рядок коментаря в тіло — атрибути ті самі, червоніє лише body:",
  "  for v_fn in select p.oid, p.proname from pg_proc p",
  "               where p.pronamespace = 'public'::regnamespace",
  `                 and p.proname in (${NAMES4_SQL}, 'check_no_overlap') loop`,
  "    v_def := pg_get_functiondef(v_fn.oid);",
  "    if (length(v_def) - length(replace(v_def, 'AS $function$', ''))) / length('AS $function$') <> 1 then",
  "      raise exception '0202-фальсифікація: у визначенні % не рівно одне AS $function$', v_fn.oid::regprocedure;",
  "    end if;",
  "    execute replace(v_def, 'AS $function$', 'AS $function$' || chr(10) || '-- falsify 0202' || chr(10));",
  "    v_n := v_n + 1;",
  "  end loop;",
  "  if v_n <> 5 then",
  "    raise exception '0202-фальсифікація: мутовано % функцій замість 5', v_n;",
  "  end if;",
  "",
  "  -- M5: CHECK розширено назад — №23 мусить побачити дайджест 0192",
  conDdl(CON_DDL_OLD),
  "",
  "  v_res := public.invariants_check(false);",
  "  select array_agg(o.value order by o.value) into v_off19",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'guard_fn_bodies';",
  "  select array_agg(o.value order by o.value) into v_off23",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'schema_digest';",
  "  select array_agg(w) into v_miss from (",
  "    select w from unnest(v_want19) w",
  "     where not exists (select 1 from unnest(coalesce(v_off19, '{}')) o where starts_with(o, w))",
  "    union all",
  "    select v_want23 where not (v_want23 = any (coalesce(v_off23, '{}')))",
  "  ) m;",
  "  select array_agg(o) into v_extra from (",
  "    select o from unnest(coalesce(v_off19, '{}')) o",
  "     where not exists (select 1 from unnest(v_want19) w where starts_with(o, w))",
  "    union all",
  "    select o from unnest(coalesce(v_off23, '{}')) o where o <> v_want23",
  "  ) x;",
  "  -- B1: тиша про check_no_overlap — межа, а не пропуск",
  "  v_b1 := not exists (select 1 from unnest(coalesce(v_off19, '{}')) o where o like 'body:check_no_overlap%');",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_other",
  "    from jsonb_array_elements(v_res->'failed') e",
  "   where e.value->>'check' not in ('guard_fn_bodies', 'schema_digest', 'ledger_md5');",
  "",
  "  raise exception 'FALSIFY_0202_ROLLBACK verdict=% r1=% r2=% n19=% n23=% b1_silent=% missed=% extra=% other_failed=%',",
  "    case when v_r1 and v_r2 and v_b1 and v_miss is null and v_extra is null and v_other is null",
  "              and coalesce(array_length(v_off19, 1), 0) = 4",
  "              and coalesce(array_length(v_off23, 1), 0) = 1 then 'PASS' else 'FAIL' end,",
  "    v_r1, v_r2, coalesce(array_length(v_off19, 1), 0), coalesce(array_length(v_off23, 1), 0), v_b1,",
  "    v_miss, v_extra, v_other;",
  "end;",
  "$falsify$;",
  "",
  "-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився:",
  "--      select public.invariants_check(false);   -- guard_fn_bodies, schema_digest ВІДСУТНІ",
  `--      select timezone from public.clinics where id = '${CLINIC_ID}';   -- ${TZ_TO}`,
  `--      select pg_get_constraintdef(oid) from pg_constraint where conname = '${CON_NAME}';   -- ${CON_DEF_NEW}`,
  "--      select count(*) from pg_proc where prosrc like '%falsify 0202%';   -- 0",
].join("\n");

// ---------------------------------------------------------------------------
// 10. ФАЙЛ МІГРАЦІЇ.
//    ⚠️ Шапка НЕ сміє містити фразу create-or-replace сторожа одним рядком:
//       `tests/privilegeSurface.test.ts` шукає її `indexOf` БЕЗ якоря. Асерт нижче.
// ---------------------------------------------------------------------------
const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0202: фаза 2 таймзон — Europe/Kyiv замість legacy-аліаса,",
  "--  CHECK без аліаса, шість функцій без скану pg_timezone_names; передрук сторожа",
  "--  (4 md5 у №19, дайджест k:clinics у №23).",
  "--",
  "--  Максимальна ЗАСТОСОВАНА на момент написання — 0201.",
  `--  \`checked\` ${CHECKED} -> ${CHECKED}. Список №19: 59 -> 59 (чотири md5 нові). Дані: ОДИН рядок`,
  `--  clinics (id ${CLINIC_ID}): timezone ${TZ_FROM} -> ${TZ_TO}.`,
  "--",
  "--  ЗВІДКИ ПАКЕТ. Рішення власника Р74-3(а), 15.09 (`docs/audit/DECISIONS-2026-09-15-s74.md`),",
  "--  замір — `docs/audit/DECISIONS-PACKET-2026-09-15-s74.md` (Р74-3) і",
  "--  `docs/audit/PERF-2026-09-12-pg-timezone-names.md` §5–7:",
  "--   1. Холостий `update` одного запису черги коштував 795–938 мс, з них тригер",
  "--      `trg_no_overlap` 782–833 мс — холодний скан `pg_timezone_names` (функція,",
  "--      що на кожен виклик розбирає ~1200 записів tz-бази ОС). Той самий підзапит",
  "--      стояв у ШЕСТИ функціях: два рядкові тригери `queue_entries`",
  "--      (`check_no_overlap`, `check_not_in_past` — платить КОЖЕН запис), три RPC",
  "--      (`emergency_stop_rpc`, `queue_set_status_rpc`, `submit_incident_rpc`) і",
  "--      `room_busy_slots` (після 0189 — один скан на виклик).",
  "--   2. Підзапит ВАЛІДУВАВ назву зони і падав на 'UTC', якщо в `clinics.timezone`",
  "--      сміття. З 0192 сміття туди не запишеш: CHECK `clinics_timezone_chk`. Він",
  "--      допускав legacy-аліас `Europe/Kiev`, бо на ньому жив прод; цією міграцією",
  "--      прод переїздить на канонічний `Europe/Kyiv`, а аліас зі списку зникає.",
  "--      Обидва дозволені імені є в tzdata Postgres (`now() at time zone` обома —",
  "--      той самий час, замір 16.09). Валідувати на читанні більше нічого —",
  "--      `coalesce(c.timezone, 'UTC')` замість підзапиту, решта тіл дослівна.",
  "--   3. Google Calendar: `clinics.timezone` їде в поле `timeZone` події дзеркала.",
  "--      ПЕРЕДУМОВА — зонд `scripts/gcal-tz-probe.mjs` у календарі власника:",
  "--      Google приймає `Europe/Kyiv` з тим самим офсетом, що `Europe/Kiev`",
  "--      (протокол — `docs/audit/PR-0202-tz-kyiv-no-catalog-scan.md`). Відбиток",
  "--      події зони не містить: наявні події лишаються з `Europe/Kiev` до першої",
  "--      зміни запису, нові — з `Europe/Kyiv`; час той самий.",
  "--",
  "--  ⚠️ ПАРИТЕТ ТЕКСТІВ ІЗ ПРОДОМ (клас 0195/0201): пʼять із шести функцій у",
  "--     репозиторії дають ТОЙ САМИЙ нормалізований md5, що на проді (замір 16.09).",
  "--     `emergency_stop_rpc` на проді лежить зі скороченими коментарями (чернетка",
  "--     через execute_sql); код тотожний (diff без коментарів порожній). 0202",
  "--     перестворює її повним текстом 0168; відкат повертає САМЕ прод-текст",
  "--     (`scripts/frag/0202_prev_emergency_stop_rpc.body.sql`), бо його md5 пінить 0201.",
  "--",
  "--  ⚠️ МЕЖА, НАЗВАНА І ПОКАЗАНА: тіла `check_no_overlap` і `check_not_in_past` не",
  "--     пінить ніщо (прийнятий ризик 13.09, розвилка 2; №17 тримає лише визначення",
  "--     тригерів). Фальсифікація 0202 мутує `check_no_overlap` і ВИМАГАЄ тиші",
  "--     сторожа — щоб межа була видна, а не малась на увазі.",
  "--",
  "--  ⚠️ ЦІНА, названа заздалегідь:",
  "--     • новий часовий пояс = міграція + передрук №23 (як і з 0192); аліас",
  "--       `Europe/Kiev` записом більше не повернути;",
  "--     • правка будь-якої з чотирьох пінованих функцій — лише з передруком №19;",
  "--     • `room_busy_slots` та обидва тригери тепер ДОВІРЯЮТЬ значенню колонки:",
  "--       якщо хтось зніме CHECK і запише сміття, читання впаде з",
  "--       `invalid value for parameter \"TimeZone\"` замість тихого UTC. Зняття",
  "--       CHECK-а бачить №23 (`k:clinics`), значення поза списком — сам CHECK.",
  "--",
  "--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ — ні вставкою в SQL Editor, ні MCP",
  "--     `apply_migration`, ні `supabase db push`: тут кілька верхньорівневих",
  "--     стейтментів без запобіжників (до-образ, живі рядки, дайджест, черга",
  "--     леджера), обрив між ними лишає прод половинчастим. Шлях один —",
  "--     `scripts/frag/0202_apply.sql`, весь одним запитом.",
  "--",
  "--  ⚠️ «ДВА ЦЕНТРИ» У РІШЕННІ Р74-3 — це ОДИН рядок тут: другий центр живе на",
  "--     `UTC`, і його не чіпаємо (T8 стенда 0192 пояснює, чому). До-образ — рівно",
  `--     один id (${CLINIC_ID}), інший стан зупиняє накат.`,
  "--",
  "--  ПОРЯДОК:",
  `--   0. Зонд Google (\`node scripts/gcal-tz-probe.mjs --clinic ${CLINIC_ID} --yes\``,
  "--      з машини власника) → GCAL_TZ_PROBE PASS. ⚠️ FAIL (Google не приймає",
  "--      `Europe/Kyiv` або дає інший офсет) = ЦЕЙ пакет НЕ накатувати: повернутись",
  "--      до варіанта (б) розвилки Р74-3 (аліас лишається, скан прибрати — інша",
  "--      структура міграції, окремий генератор), рішення власника.",
  "--      Дерево чисте; `node scripts/build-0202-reprint.mjs` → `git diff --exit-code`;",
  "--      `npm test`, `npx tsc --noEmit`; повна ревізія `node scripts/falsify-all.mjs`.",
  "--      Усе — ДО проду.",
  "--   1. `scripts/frag/0202_dryrun.sql` (запит ПОЧИНАЄТЬСЯ з тегу dryrun) →",
  `--      DRYRUN_0202_ROLLBACK з checked=${CHECKED}, failed лише \`ledger_md5\`, і ЗАМІР`,
  "--      update_ms/trg_no_overlap_ms (до1, до2, після1, після2): «після» — одиниці мс.",
  "--   2. `scripts/frag/0202_apply.sql` — ОДРАЗУ після сухого прогону, без DDL і",
  "--      правок у дашборді між ними; була пауза — повторити крок 1. Читання назад:",
  `--      guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN}, ledger_rows = 202,`,
  `--      clinic_tz = ${TZ_TO}, fns_with_scan = 0. Помилка = НІЧОГО не закомічено.`,
  "--      Таймаут клієнта = не повторювати наосліп: спершу select читання назад;",
  "--      якщо там стан 0201 — перевірити в `pg_stat_activity`, що першого запиту",
  "--      вже немає, і лише тоді повторити (гарди леджера і предстану зупинять",
  "--      подвійний накат).",
  "--      ⚠️ Відрізок «накат → db:gate» не сміє перетнути 03:50 UTC (06:50 Київ).",
  `--   3. ОКРЕМИМ запитом \`select public.invariants_check(false);\` — checked ${CHECKED},`,
  "--      failed лише `ledger_md5`. ⚠️ Перевірки, що залежать від ДАНИХ і ЧАСУ",
  "--         (cron_*, outbox_*, gcal_*, ucm_orphan_markers, auth_orphan_accounts),",
  "--         можуть почервоніти не від пакета.",
  "--   4. `scripts/frag/0202_falsify.sql` → verdict=PASS (r1, r2, n19=4, n23=1,",
  "--      b1_silent). Після — окремим запитом: №19/№23 зелені, центр на Europe/Kyiv.",
  "--   5. `npm run db:gate` (ЛИШЕ з машини власника) → `invariants_check`: ok:true.",
  "--   6. git ОДНИМ заходом: гілка → dev → main → push → штамп деплою. Не закрили",
  "--      5–6 у цей захід — `scripts/frag/0202_rollback.sql`, а не «доробимо завтра».",
  "--   7. Аудит-док `docs/audit/PR-0202-tz-kyiv-no-catalog-scan.md` — ДО мержу.",
  "--   8. ⚠️ ПІСЛЯ КРОКУ 5 генератор НЕ ЗАПУСКАТИ (перезаписує файл із md5 у леджері).",
  "-- ============================================================================",
  "",
  "-- ── 1. Дані: один центр з аліаса на канонічну назву (явний id, до-образ) ─────",
  "do $data$",
  "declare v_ids uuid[]; v_rows int;",
  "begin",
  DATA_FWD("0202"),
  "end;",
  "$data$;",
  "",
  "-- ── 2. CHECK без аліаса (дайджест k:clinics у №23 передруковано нижче) ────────",
  conDdl(CON_DDL_NEW).replace(/^  /gm, ""),
  CON_COMMENT_NEW,
  "",
  "-- ── 3. Шість функцій без скану каталогу (повний текст із репозиторію) ─────────",
  ...FNS.map((f) => f.stmt),
  "",
  "-- ── 4. Передрук сторожа ─────────────────────────────────────────────────────",
].join("\n");

const MIG_TAIL = [
  "",
  `comment on function public.invariants_check(boolean) is '${PIN}';`,
  "",
  "insert into public.migration_ledger (name)",
  `values ('${DST_NAME}')`,
  "on conflict (name) do nothing;",
  "",
  "-- ============================================================================",
  "-- === ВІДКАТ ===",
  "--",
  "--  1. База: `scripts/frag/0202_rollback.sql` — шість функцій до прод-текстів,",
  `--     CHECK до списку 0192, центр ${CLINIC_ID} до ${TZ_FROM}, тіло сторожа до 0201`,
  `--     (${PRE_MD5} / ${PRE_LEN}), самопін 0201, рядок леджера знімається.`,
  "--     Перевіряти ОКРЕМИМ запитом після commit.",
  "--  2. Git — ОДНИМ кроком: видалити цей файл, `scripts/frag/0202_*.sql`,",
  "--     `scripts/build-0202-reprint.mjs`, `tests/tzKyivPhase2.test.ts`; повернути",
  "--     `tests/stoppedIncidents.test.ts` (пін 0168 знову чекає `[]`),",
  "--     `supabase/seed/seed_test_7days.sql` (fallback Europe/Kiev),",
  "--     `components/SetupWizard.tsx` і `lib/tzCanonical.ts` (нормалізація аліаса",
  "--     лишається безпечною і після відкату — можна не чіпати). `scripts/gcal-tz-probe.mjs`",
  "--     — зонд, лишається. `PINNED` у `guardFnBodiesInvariant.test.ts` не міняється.",
  "--     Нового стенда пакет НЕ заводить — фальсифікація разова, протокол у",
  "--     `docs/audit/PR-0202-tz-kyiv-no-catalog-scan.md`.",
  "--  ⚠️ Google: після відкату нові події дзеркала знову йдуть із Europe/Kiev —",
  "--     офсет той самий, часи не зсуваються.",
  "-- ============================================================================",
].join("\n");

const MIG = MIG_HEAD + "\n\n" + SRC.prologue + NEW_BODY + "$function$;\n" + MIG_TAIL + "\n";

{
  const heads = MIG.match(REPRINT_RE_G) || [];
  if (heads.length !== 1) throw new Error(`ФАЙЛ: заголовків передруку ${heads.length}, а треба 1`);
  const loose = MIG.indexOf("create or replace function public.invariants_check");
  const anchored = MIG.search(/^create or replace function public\.invariants_check/m);
  if (loose !== anchored) throw new Error(`ФАЙЛ: фраза create-or-replace сторожа вперше на ${loose}, а заголовок на ${anchored}`);
  const pins = [...MIG.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PIN) throw new Error(`ФАЙЛ: піни ${JSON.stringify(pins)}, а треба рівно ${PIN}`);
  if (count(MIG, OPEN) !== 1 || count(MIG, CLOSE) !== 1) throw new Error("ФАЙЛ: межі тіла не унікальні");
  for (const t of ["$apply$", "$dryrun$", "$back$", "$falsify$", ...FN_TAGS]) {
    if (MIG.includes(t)) throw new Error(`ФАЙЛ містить тег фрагмента ${t}`);
  }
  if (count(MIG, "pg_timezone_names") !== count(MIG_HEAD, "pg_timezone_names") + count(NEW_BODY, "pg_timezone_names") + count(MIG_TAIL, "pg_timezone_names")) throw new Error("ФАЙЛ: лічильник pg_timezone_names не сходиться");
  for (const f of FNS) if (codeOf(f.stmt).includes("pg_timezone_names")) throw new Error(`ФАЙЛ: ${f.fn} у коді має pg_timezone_names`);
  if (count(MIG, `'${CLINIC_ID}'`) < 2) throw new Error("ФАЙЛ: явний id центру не в даних");
  for (const fr of [APPLY, DRYRUN, ROLLBACK, FALSIFY]) {
    if (fr.includes("$p$$p$")) throw new Error("фрагмент має порожній рядок підстановки");
  }
  // ⚠️ фрагменти: тег блоку — перший непорожній рядок після шапки коментарів
  for (const [fr, tag] of [[APPLY, "$apply$"], [DRYRUN, "$dryrun$"], [ROLLBACK, "$back$"], [FALSIFY, "$falsify$"]]) {
    const stmts = fr.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    if (stmts[0] !== "set statement_timeout = '5min';" || stmts[1] !== `do ${tag}`) {
      throw new Error(`фрагмент ${tag}: перші стейтменти «${stmts[0]}», «${stmts[1]}»`);
    }
    if (count(fr, tag) !== 2) throw new Error(`фрагмент ${tag}: тег не двічі`);
  }
}

if (existsSync(DST_MIG)) {
  const old = readFileSync(DST_MIG, "utf8").replace(/\r/g, "");
  if (old !== MIG && !FORCE) {
    throw new Error(`${DST_MIG} уже є і його зміст ІНШИЙ. Якщо md5 файла вже в леджері — перезапис = дрейф = червона збірка. Свідомо: --force`);
  }
}
writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0202_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0202_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0202_rollback.sql", ROLLBACK + "\n");
writeFileSync("scripts/frag/0202_falsify.sql", FALSIFY + "\n");

{
  const back = split(DST_MIG);
  if (md5(back.body) !== NEW_MD5 || back.body.length !== NEW_LEN) {
    throw new Error(`ЗАПИСАНИЙ ФАЙЛ дає ${md5(back.body)} / ${back.body.length}, а зібрано ${NEW_MD5} / ${NEW_LEN}`);
  }
  if (back.prologue !== SRC.prologue) throw new Error("DDL сторожа у записаному файлі розʼїхався з 0201");
}

console.log("0202 зібрано.");
console.log(`  сторож:   ${PRE_MD5} / ${PRE_LEN}  ->  ${NEW_MD5} / ${NEW_LEN}`);
console.log(`  checked:  ${CHECKED};  список №19: ${OLD_SIGS.length} -> ${NEW_SIGS.length};  k:clinics ${DIG_OLD} -> ${DIG_NEW}`);
for (const f of FNS) console.log(`  ${f.pinned ? "№19 " : "    "}${f.fn}: ${f.prodMd5} -> ${f.newMd5}`);
console.log(`  пін:      ${PIN}`);
console.log(`  пар підстановки: ${PAIRS.length}; змістових перевірок: ${CHECKS.length}; зворотний хід -> 0201`);
console.log(`  файли: ${DST_MIG}, scripts/frag/0202_{apply,dryrun,rollback,falsify}.sql`);
