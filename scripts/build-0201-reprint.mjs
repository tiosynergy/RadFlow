// build-0201-reprint.mjs — збирає supabase/migrations/0201_pin_gated_rpcs_role_surface.sql
// і scripts/frag/0201_{apply,dryrun,rollback,falsify}.sql.
//
// ЩО РОБИТЬ ПАКЕТ (рішення власника 15.09, `docs/audit/DECISIONS-2026-09-15-s74.md`):
//   Р74-1(б) — шістнадцять підписів у список №19 `guard_fn_bodies`: усі
//            definer-функції, доступні `authenticated` і поза списком, що НЕСУТЬ
//            ВЛАСНИЙ ГЕЙТ. Список 43 -> 59.
//   Р74-2(б) — нова перевірка №26 `role_surface`: поверхня КЛІЄНТСЬКИХ ролей поза
//            прямими грантами (членства, атрибути, налаштування, ACL схем і бази,
//            default ACL). `checked` 25 -> 26.
//   Одна перепечатка, одна ревізія (так рекомендував пакет розвилок с74).
//   Даних пакет не чіпає.
//
// ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК (урок с73/с74): `latestReprint()` у тестах бере тіло
//    з ОСТАННЬОГО файла, де рядок ПОЧИНАЄТЬСЯ з create-or-replace сторожа.
// ⚠️ ДЖЕРЕЛО — 0200 (остання перепечатка; генератор асертить, що після неї
//    нічого сторожа не передруковує і номер 0201 вільний).
//
// ⚠️ РЯДКИ ОБОХ ПІНІВ ЗНЯТІ НА ПРОДІ, а не пораховані тут — генератор не бачить БД.
//    • 16 рядків №19 — формулою `cur` самої №19 (замір 15.09, с74; перевантажень
//      немає, same_name = 1 у всіх шістнадцяти);
//    • 62 ключі №26 — тим самим запитом, що стає тілом перевірки (замір 15.09).
//    №19: фрагмент накату ПЕРЕД передруком проганяє 16 рядків через ТОЙ САМИЙ
//    вирізаний `cur`. №26: сухий прогін кличе сам сторож на новому тілі і вимагає
//    зелену `role_surface`; передумова фальсифікації звіряє Q26 — той самий
//    рядок-константа, чиє входження в тіло асертиться. Дрейф між заміром і накатом
//    зупиняє прогін, а не кладе сторожа, червоного з першої секунди.
//
// ⚠️ ФАЛЬСИФІКАЦІЯ №26 СПРОЄКТОВАНА ЗА ЗОНДАМИ, а не за документацією (15.09,
//    усі зонди — у транзакціях, відкочених `raise`, від ролі postgres):
//    • `alter role authenticated bypassrls` → 42501 «reserved role» (supautils).
//      Гілку `r:` фальсифікуємо через НОВУ клієнтську роль (`new:r:`);
//    • `grant set on parameter …` → 42501, `pg_parameter_acl` порожній — гілки `p:`
//      немає взагалі (фальсифікувати нічим; межа названа в прозі №26);
//    • `alter role … set "request.jwt.claim.sub"` і `alter database … set` для
//      session_replication_role / request.jwt.* / safeupdate.enabled → 42501;
//      зате `alter role authenticated set session_replication_role = replica` і
//      `alter role authenticator set pgrst.db_schemas` — ПРОХОДЯТЬ (їх ловить `g:`);
//    • `revoke` від НЕ-грантора — тиша в самому Postgres (гранти supabase_admin
//      від postgres не зняти), тож `missing:` фальсифікуємо гранту postgres;
//    • решта мутацій проходить і дає рівно ті 22 порушники, що асертить falsify
//      (зонд PROBE5 тим самим запитом на мутованому стані).
//
// ⚠️ РЕВʼЮ с74 (дві лінзи) змінило пакет, і кожну знахідку перевірено запитом:
//    замикання клієнтських ролей (транзитивність), синтетичний ключ глобального
//    default ACL без PUBLIC, DISTINCT у дайджесті прав, `quote_ident` бази в `g:`,
//    розширене виключення спостережуваності в `g:`, паритет `referral_center_card`
//    з файлом 0195, звірка стендових якорів за ЛІТЕРАЛАМИ, строгий вердикт
//    фальсифікації з передумовою. Протокол — `docs/audit/PR-0201-gated-rpcs-role-surface.md`.
//
// ⚠️ ПІСЛЯ `npm run db:gate` ЦЕЙ ГЕНЕРАТОР НЕ ЗАПУСКАТИ: він перезаписує файл
//    міграції, чий md5 уже в леджері. Захист: якщо файл уже є і його зміст
//    ІНШИЙ, генератор відмовляється без `--force`.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const count = (s, needle) => s.split(needle).length - 1;
const FORCE = process.argv.includes("--force");

const MIGDIR = "supabase/migrations";
const SRC_NAME = "0200_pin_desk_and_waitlist_rpcs.sql";
const SRC_MIG = `${MIGDIR}/${SRC_NAME}`;
const DST_NAME = "0201_pin_gated_rpcs_role_surface.sql";
const DST_MIG = `${MIGDIR}/${DST_NAME}`;
const PREV_LEDGER = SRC_NAME;
const PRE_MD5 = "00146b182c9a366094678ccdb10f35aa";
const PRE_LEN = 140268;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const PRE_CHECKED = 25;
const NEW_CHECKED = 26;

const OPEN = "\nas $function$";
const CLOSE = "\n$function$;";
/** Та сама регулярка, що в `scripts/migration-gate-lib.mjs` і тестах. */
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
// 1. БАЗИСИ ДЖЕРЕЛА. Кожен — числом, а не «схоже на те».
// ---------------------------------------------------------------------------
const SRC = split(SRC_MIG);
if (md5(SRC.body) !== PRE_MD5 || SRC.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0200 дав ${md5(SRC.body)} / ${SRC.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}
if (SRC.head + SRC.prologue + SRC.body + "$function$;" + SRC.tail !== SRC.raw) {
  throw new Error("СКЛЕЙКА ЗЛАМАНА: 0200 не збирається назад побайтово");
}
{
  const pins = [...SRC.raw.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PRE_PIN) {
    throw new Error(`ПІН 0200 у файлі ${JSON.stringify(pins)}, а в проді ${PRE_PIN}`);
  }
}
// Після 0200 на диску немає нічого, крім самого 0201.
{
  const later = readdirSync(MIGDIR)
    .filter((f) => f.endsWith(".sql") && f > SRC_NAME && f !== DST_NAME).sort();
  if (later.length) throw new Error(`після 0200 на диску вже є ${later.join(", ")} — номер 0201 зайнятий чи черга зсунулась`);
}

// ---------------------------------------------------------------------------
// 2. ШІСТНАДЦЯТЬ РЯДКІВ №19. Зняті на проді формулою `cur` (див. шапку).
//    Порядок у списку косметичний — тест і сторож звіряють МНОЖИНИ, — тож усі
//    стають одразу після трьох рядків 0200 (`set_waitlist_status_rpc`): там
//    стендових якорів немає (замір с74 перед 0200; звірка розділу 8 повторює).
//    Групи — як у рішенні Р74-1: гейт admin/desk (12), хелпери (2), uid (2).
// ---------------------------------------------------------------------------
const A_STD = "cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres";
const NEW_ROWS = [
  // гейт auth_is_admin() / auth_is_desk()
  ["cancel_case_rpc(p_case_id uuid)", "ad0a4f2c7d1e475a806c10d575f7fede",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  ["ceo_kpi_rooms(p_from date, p_to date, p_clinics uuid[])", "dcceffc8c656b8fd1b62c2b71350b14b",
    `secdef=true;vol=s;owner=postgres;lang=sql;${A_STD}`],
  ["ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[])", "416da7521b1c99740f6a7646ff8d526e",
    `secdef=true;vol=s;owner=postgres;lang=sql;${A_STD}`],
  ["ceo_kpi_totals(p_from date, p_to date, p_clinics uuid[])", "123af77cd8f5fe2a9512c12c2ff3bb7b",
    `secdef=true;vol=s;owner=postgres;lang=sql;${A_STD}`],
  ["delete_clinic_member(target uuid)", "6d369ff76b71637902998e275a0b7c64",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  ["incident_resolve_rpc(p_id uuid)", "11bf2e9447c4f7226bde73b577832ba9",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  ["queue_apply_delay_plan_rpc(p_room uuid, p_source uuid, p_delay_min integer, p_strategy text, p_plan jsonb, p_expected jsonb, p_reason text)",
    "c1d43e9c53e291846c7b0456d4793060",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  ["queue_confirm_calls_rpc(p_ids uuid[])", "fa043199612d4151bd447818036fa89c",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  ["queue_set_call_rpc(p_id uuid, p_call call_status, p_allowed queue_status[])", "45f823a84cfb8d26e21e147071744008",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  ["save_schedule_override(p_override_date date, p_all_closed boolean, p_label text, p_rooms jsonb, p_expected_updated_at text)",
    "b78fbf0e96d2589d6c8ba3b50fc3a3ad",
    "secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp,DateStyle=ISO, MDY;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres"],
  ["search_referrers(q text)", "213e5b9809aa4da3ad82644e6244a78e",
    `secdef=true;vol=s;owner=postgres;lang=sql;${A_STD}`],
  ["services_import_rpc(p_rows jsonb, p_room_id uuid)", "f714153329d653601a913405872ac7ad",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  // хелпери направника й радіолога
  ["create_case_rpc(p_case jsonb, p_steps jsonb)", "22387332147a71748de09d74ed1d9d1b",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  ["queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status, p_reason text, p_off_schedule boolean, p_studies jsonb)",
    "3382aa484125730aad7c329ca7f99ac8",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  // лише auth.uid()
  ["mark_changes_seen(p_ids uuid[])", "ba45fd7da3e25f018b076ed4ba95f4e8",
    `secdef=true;vol=v;owner=postgres;lang=plpgsql;${A_STD}`],
  ["referral_center_card(p_access_id uuid)", "a2be8c18cb183d5d4221b3af9a62671d",
    `secdef=true;vol=s;owner=postgres;lang=sql;${A_STD}`],
];
const NEW_NAMES = NEW_ROWS.map(([fn]) => fn.slice(0, fn.indexOf("(")));
if (NEW_ROWS.length !== 16 || new Set(NEW_NAMES).size !== 16) throw new Error("РЯДКИ №19: мусить бути 16 різних імен");
for (const [fn, body, attrs] of NEW_ROWS) {
  if (/'/.test(fn + body + attrs)) throw new Error(`РЯДОК ${fn}: одинарна лапка зламала б літерал`);
  if (!/^[0-9a-f]{32}$/.test(body)) throw new Error(`РЯДОК ${fn}: md5 не 32 hex`);
  if (!attrs.includes(";acl=")) throw new Error(`РЯДОК ${fn}: без ;acl=`);
  if (!/^[A-Za-z0-9_]+\([^)]*\)$/.test(fn)) throw new Error(`РЯДОК ${fn}: підпис не в формі ROW_RE тесту`);
}
const rowText = ([fn, body, attrs]) => `      ('${fn}','${body}','${attrs}'),`;

// ---------------------------------------------------------------------------
// 2-біс. ПАРИТЕТ `referral_center_card` З ФАЙЛОМ 0195 (знахідка ревʼю с74, лінза Б).
//    На проді тіло цієї функції — БЕЗ КОМЕНТАРІВ (0195 лягла на прод чернеткою
//    через execute_sql, PR-0195 §5): код тотожний файлу, коментарі — ні. №19
//    коментарі НЕ знімає свідомо, тож пін з прода (0fcc…) дав би `body:` на
//    будь-якій базі, зібраній міграціями. Джерело істини — репозиторій: 0201
//    перестворює функцію ДОСЛІВНО текстом 0195 і пінить його md5. Код, ACL,
//    власник і SET не змінюються (`create or replace`).
// ---------------------------------------------------------------------------
const RCC_SRC_MIG = `${MIGDIR}/0195_referral_card_scope.sql`;
const RCC_PROD_MD5 = "0fcc204d27444abb26f7d3a90cffc91f";   // замір 15.09, тіло без коментарів
const RCC_FILE_MD5 = "a2be8c18cb183d5d4221b3af9a62671d";   // той самий код із коментарями 0195
const RCC_STMT = (() => {
  const txt = readFileSync(RCC_SRC_MIG, "utf8").replace(/\r/g, "");
  // Якір на ПОЧАТОК РЯДКА: у секції відкату 0195 те саме визначення стоїть
  // закоментованим (`-- create or replace …`).
  const heads = [...txt.matchAll(/^create or replace function public\.referral_center_card\(p_access_id uuid\)$/gm)];
  if (heads.length !== 1) throw new Error(`0195: визначень referral_center_card ${heads.length}, а треба 1`);
  const a = heads[0].index;
  const b = txt.indexOf("\n$$;\n", a);
  if (b < 0) throw new Error("0195: кінець визначення referral_center_card не знайдено");
  const stmt = txt.slice(a, b + 4);   // до `$$;` включно
  const body = stmt.slice(stmt.indexOf("as $$") + 5, stmt.lastIndexOf("$$;"));
  const norm = md5(body.replace(/\s+/g, " ").trim());
  if (norm !== RCC_FILE_MD5) throw new Error(`0195: нормалізований md5 тіла ${norm}, а пін ${RCC_FILE_MD5}`);
  if (/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(body)) {
    throw new Error("0195: у тілі не-ASCII пробіли — JS \\s і PG \\s розійшлися б");
  }
  for (const want of ["security definer", "set search_path = public, pg_temp", "stable", "language sql", "returns jsonb"]) {
    if (!stmt.includes(want)) throw new Error(`0195: у визначенні немає «${want}» — attrs розійшлися б`);
  }
  if (/\$rcc\$/.test(stmt)) throw new Error("0195: текст містить тег $rcc$");
  return stmt;
})();
if (NEW_ROWS.find(([fn]) => fn.startsWith("referral_center_card("))[1] !== RCC_FILE_MD5) {
  throw new Error("РЯДОК referral_center_card: пін мусить бути md5 ФАЙЛА 0195");
}
const ADD = NEW_ROWS.map(rowText).join("\n") + "\n";

const ANCHOR_WAITLIST =
  "      ('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)','1e04ab4ebb01c08a23d1280b29465d55','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),\n";

// ---------------------------------------------------------------------------
// 3. ПРОЗА №19 і №22. Кожна фраза, яку 0201 робить НЕПРАВДОЮ, міняється в тому
//    ж пакеті (урок прози №19: «0192 оновила сусідній рядок і проминула цей»).
// ---------------------------------------------------------------------------
const PROSE_COUNT_FROM = "ЩО ПІНИМО (сьогодні 43 підписи; ключ";
const PROSE_COUNT_TO = "ЩО ПІНИМО (сьогодні 59 підписів; ключ";

// «…сюди НЕ входять — і не входять нікуди більше.» — після 0201 для клієнтських
// ролей це неправда.
const NOWHERE_FROM = "  --        нікуди більше.\n";
const NOWHERE_TO = [
  "  --        нікуди більше. ⚠️ Так було до 0201: для КЛІЄНТСЬКИХ ролей їх тепер",
  "  --        тримає №26 `role_surface` (членства, атрибути, налаштування, ACL",
  "  --        схем і бази, default ACL) — сюди, у №19, вони як і раніше не входять.",
].join("\n") + "\n";

const ANCHOR_PROSE_END =
  "  --        РІШЕННЯ ВЛАСНИКА 15.09 (стартовий промпт с74).\n"
  + "  v_n := v_n + 1;\n";
const PROSE_0201 = [
  "  --     ⚠️ 0201 ДОДАЛА ШІСТНАДЦЯТЬ — решту definer-функцій, доступних",
  "  --        `authenticated` і поза списком, що НЕСУТЬ ВЛАСНИЙ ГЕЙТ. Список став",
  "  --        59. Рішення власника Р74-1(б), 15.09",
  "  --        (`docs/audit/DECISIONS-2026-09-15-s74.md`); пакет —",
  "  --        `docs/audit/PR-0201-gated-rpcs-role-surface.md`.",
  "  --        • гейт `auth_is_admin()`/`auth_is_desk()` (12): `cancel_case_rpc`,",
  "  --          `ceo_kpi_rooms`, `ceo_kpi_studies`, `ceo_kpi_totals`,",
  "  --          `delete_clinic_member`, `incident_resolve_rpc`,",
  "  --          `queue_apply_delay_plan_rpc`, `queue_confirm_calls_rpc`,",
  "  --          `queue_set_call_rpc`, `save_schedule_override`,",
  "  --          `search_referrers`, `services_import_rpc`;",
  "  --        • хелпери направника й радіолога (2): `create_case_rpc`,",
  "  --          `queue_reschedule_rpc`;",
  "  --        • лише `auth.uid()` (2): `mark_changes_seen`,",
  "  --          `referral_center_card` — остання ЄДИНА тримає видимість картки",
  "  --          центру направнику, і її тіло міняла 0195. ⚠️ На проді воно лежало",
  "  --          БЕЗ коментарів файла 0195 (чернетка через execute_sql, PR-0195 §5);",
  "  --          0201 перестворює функцію дослівно текстом 0195 і пінить ЙОГО md5 —",
  "  --          інакше база, зібрана міграціями, червоніла б `body:` з першого дня.",
  "  --        Вихолощений гейт у будь-якій із них — ТИХА ескалація (у своєму",
  "  --        центрі або по чужому кейсу), бо RLS усередині SECURITY DEFINER не діє.",
  "  --        ⚠️ ПОЗА СПИСКОМ лишаються `search_cities` і `search_clinics` (гейта",
  "  --           за роллю в тілі немає — лише фільтр видимості довідника) та",
  "  --           `integration_apply_status` (недоступна `authenticated`). Це межа,",
  "  --           названа рішенням.",
  "  --        ⚠️ ЦІНА та сама, що в абзаці 0200, тепер ще на шістнадцять функцій",
  "  --           (разом із 0200 — девʼятнадцять):",
  "  --           будь-яка правка цих шістнадцяти — тіло, `grant`/`revoke`,",
  "  --           `alter function`, імʼя параметра — лише разом із передруком.",
  "  --        ⚠️ Замір рядків 15.09: перевантажень немає; у",
  "  --           `save_schedule_override` поле `cfg=` несе ще й",
  "  --           `DateStyle=ISO, MDY` — це частина піна, а не шум.",
].join("\n") + "\n";

// №2: «…`CREATE` на схему public є ЛИШЕ у postgres … жодна з 23 перевірок цю
//      привілею НЕ пасе.» — після 0201 для клієнтських ролей пасе №26.
const P2_FROM = "  --         service_role — false), і жодна з 23 перевірок цю привілею НЕ\n"
  + "  --         пасе. Для ВІДНОШЕНЬ і ТИПІВ перехід навпаки звужує: `pg_temp`\n";
const P2_TO = "  --         service_role — false), і жодна з 23 перевірок цю привілею НЕ\n"
  + "  --         пасе (так було до 0201: для anon, authenticated і PUBLIC її тепер\n"
  + "  --         пасе №26, ключ `n:public:*`; для service_role — як і раніше, ніхто).\n"
  + "  --         Для ВІДНОШЕНЬ і ТИПІВ перехід навпаки звужує: `pg_temp`\n";

// №25: «До 0198 це була єдина річ у схемі, яку не тримало НІЩО:» — ревʼю 0201
//      показало, що не єдина.
const P25_FROM = "  --     До 0198 це була єдина річ у схемі, яку не тримало НІЩО:\n";
const P25_TO = "  --     До 0198 це була єдина річ у схемі, яку не тримало НІЩО (0201: НЕ\n"
  + "  --     єдина — межі 1–2 аудиту 0191 теж не тримало ніщо, див. №26):\n";

// абзац 0200: «чи пінити решту — окреме рішення власника» — вирішено в 0201.
const P0200_FROM = "  --           власником; чи пінити решту — окреме рішення власника, як і\n";
const P0200_TO = "  --           власником; чи пінити решту — окреме рішення власника (вирішено:\n"
  + "  --           0201, шістнадцять), як і\n";

// №22: «ЛИШЕ схема public … дефолтний ACL … поза цим сторожем і поза 0166;»
const G22_FROM = "  --         роздає arwdDxtm — це поза цим сторожем і поза 0166;\n";
const G22_TO = [
  "  --         роздає arwdDxtm — це поза цим сторожем і поза 0166 (0201: USAGE",
  "  --         схем і сам default ACL для клієнтських ролей пінить №26",
  "  --         `role_surface`; ОБʼЄКТИ поза `public` — як і раніше, ніхто);",
].join("\n") + "\n";

{
  const inProse = new Set([...PROSE_0201.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => NEW_NAMES.includes(n)));
  if (inProse.size !== 16) throw new Error(`ПРОЗА 0201 називає ${inProse.size} із 16 функцій списку`);
}
for (const [nm, txt] of [["PROSE_0201", PROSE_0201], ["NOWHERE_TO", NOWHERE_TO], ["G22_TO", G22_TO],
  ["P2_TO", P2_TO], ["P25_TO", P25_TO], ["P0200_TO", P0200_TO]]) {
  for (const l of txt.split("\n").filter(Boolean)) {
    if (!l.startsWith("  --")) throw new Error(`ПРОЗА ${nm}: рядок не коментар: ${l}`);
  }
}

// ---------------------------------------------------------------------------
// 4. ПЕРЕВІРКА №26 `role_surface`. Ключі зняті на проді ТИМ САМИМ запитом
//    (`Q26` нижче), що стає її тілом. Порядок — `collate "C"`, як у заміру.
// ---------------------------------------------------------------------------
const TBL_PUB = "DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE";
const TBL_ALL = "DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE";
const SEQ = "SELECT,UPDATE,USAGE";
const M_CLIENT = "grantor=supabase_admin,admin=false,inherit=false,set=true";
const M_ADMIN = "grantor=supabase_admin,admin=true,inherit=true,set=true";
const R_NOLOGIN = "super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false";
const R_AUTHENTICATOR = "super=false,createrole=false,createdb=false,bypassrls=false,inherit=false,login=true,replication=false";
const ROLE_ROWS = [
  ["b:PUBLIC", "CONNECT,TEMPORARY"],
  ["d:postgres:public:S:anon", SEQ],
  ["d:postgres:public:S:authenticated", SEQ],
  ["d:postgres:public:f:anon", "EXECUTE"],
  ["d:postgres:public:f:authenticated", "EXECUTE"],
  ["d:postgres:public:r:anon", TBL_PUB],
  ["d:postgres:public:r:authenticated", TBL_PUB],
  ["d:postgres:storage:S:anon", SEQ],
  ["d:postgres:storage:S:authenticated", SEQ],
  ["d:postgres:storage:f:anon", "EXECUTE"],
  ["d:postgres:storage:f:authenticated", "EXECUTE"],
  ["d:postgres:storage:r:anon", TBL_ALL],
  ["d:postgres:storage:r:authenticated", TBL_ALL],
  ["d:supabase_admin:graphql:S:anon", SEQ],
  ["d:supabase_admin:graphql:S:authenticated", SEQ],
  ["d:supabase_admin:graphql:f:anon", "EXECUTE"],
  ["d:supabase_admin:graphql:f:authenticated", "EXECUTE"],
  ["d:supabase_admin:graphql:r:anon", TBL_ALL],
  ["d:supabase_admin:graphql:r:authenticated", TBL_ALL],
  ["d:supabase_admin:graphql_public:S:anon", SEQ],
  ["d:supabase_admin:graphql_public:S:authenticated", SEQ],
  ["d:supabase_admin:graphql_public:f:anon", "EXECUTE"],
  ["d:supabase_admin:graphql_public:f:authenticated", "EXECUTE"],
  ["d:supabase_admin:graphql_public:r:anon", TBL_ALL],
  ["d:supabase_admin:graphql_public:r:authenticated", TBL_ALL],
  ["d:supabase_admin:public:S:anon", SEQ],
  ["d:supabase_admin:public:S:authenticated", SEQ],
  ["d:supabase_admin:public:f:anon", "EXECUTE"],
  ["d:supabase_admin:public:f:authenticated", "EXECUTE"],
  ["d:supabase_admin:public:r:anon", TBL_ALL],
  ["d:supabase_admin:public:r:authenticated", TBL_ALL],
  ["g:authenticator:*", "session_preload_libraries=supautils, safeupdate"],
  ["m:anon:authenticator", M_CLIENT],
  ["m:anon:postgres", M_ADMIN],
  ["m:authenticated:authenticator", M_CLIENT],
  ["m:authenticated:postgres", M_ADMIN],
  ["m:authenticator:postgres", M_ADMIN],
  ["m:authenticator:supabase_storage_admin", M_CLIENT],
  ["m:service_role:authenticator", M_CLIENT],
  ["n:auth:anon", "USAGE"],
  ["n:auth:authenticated", "USAGE"],
  ["n:extensions:anon", "USAGE"],
  ["n:extensions:authenticated", "USAGE"],
  ["n:graphql:anon", "USAGE"],
  ["n:graphql:authenticated", "USAGE"],
  ["n:graphql_public:anon", "USAGE"],
  ["n:graphql_public:authenticated", "USAGE"],
  ["n:information_schema:PUBLIC", "USAGE"],
  ["n:net:PUBLIC", "USAGE"],
  ["n:net:anon", "USAGE"],
  ["n:net:authenticated", "USAGE"],
  ["n:pg_catalog:PUBLIC", "USAGE"],
  ["n:public:PUBLIC", "USAGE"],
  ["n:public:anon", "USAGE"],
  ["n:public:authenticated", "USAGE"],
  ["n:realtime:anon", "USAGE"],
  ["n:realtime:authenticated", "USAGE"],
  ["n:storage:anon", "USAGE"],
  ["n:storage:authenticated", "USAGE"],
  ["r:anon", R_NOLOGIN],
  ["r:authenticated", R_NOLOGIN],
  ["r:authenticator", R_AUTHENTICATOR],
];
const KIND_COUNTS = { b: 1, d: 30, g: 1, m: 7, n: 20, r: 3 };
{
  const keys = ROLE_ROWS.map(([k]) => k);
  if (new Set(keys).size !== keys.length) throw new Error("КЛЮЧІ №26: є дублікати");
  if (keys.length !== 62) throw new Error(`КЛЮЧІ №26: ${keys.length}, а замір дав 62`);
  const sorted = [...keys].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1));
  if (sorted.join("\n") !== keys.join("\n")) throw new Error("КЛЮЧІ №26: порядок не collate C (як у заміру)");
  for (const [kind, n] of Object.entries(KIND_COUNTS)) {
    const got = keys.filter((k) => k.startsWith(kind + ":")).length;
    if (got !== n) throw new Error(`КЛЮЧІ №26: гілка ${kind}: ${got}, а замір дав ${n}`);
  }
  if (keys.some((k) => !/^[bdgmnr]:/.test(k))) throw new Error("КЛЮЧІ №26: невідомий префікс");
  for (const [k, d] of ROLE_ROWS) if (/'/.test(k + d)) throw new Error(`КЛЮЧ ${k}: одинарна лапка`);
}
const ROLE_EXPD = ROLE_ROWS.map(([k, d]) => `      ('${k}','${d}')`).join(",\n");

/** Налаштування ролі, які НЕ є поверхнею: таймаути (тюнінг) і спостережуваність /
 *  тюнінг зі списку supautils `privileged_role_allowed_configs` (замір 15.09).
 *  Небезпечні з того ж списку — `pgrst.*`, `safeupdate.enabled`,
 *  `session_replication_role` — СВІДОМО лишаються в `g:`. */
const G_EXCLUDE_RE = "^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|idle_session_timeout|transaction_timeout|deadlock_timeout|wal_compression|log_[a-z_]+|track_[a-z_]+|(pgaudit|auto_explain|pg_stat_statements|plan_filter|pg_net)[.][a-z0-9_.]+)$";
if (/'|\\/.test(G_EXCLUDE_RE)) throw new Error("G_EXCLUDE_RE: лапка або бекслеш зламали б літерал");
const PV = "(select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v";
const AGG = "string_agg(distinct v.pv collate \"C\", ',' order by v.pv collate \"C\")";

/** Запит перевірки №26 — ОДИН текст і в тілі сторожа, і в живій звірці накату. */
const Q26 = [
  "  with recursive cr(oid) as (",
  "    -- клієнтські ролі: `authenticator` і ТРАНЗИТИВНО всі ролі, членом яких він",
  "    -- є (ким може стати і що успадковує), крім `service_role`; хардкоду імен",
  "    -- немає. Сьогодні це рівно anon, authenticated, authenticator.",
  "    select r.oid",
  "      from pg_roles r",
  "     where r.rolname = 'authenticator'",
  "    union",
  "    select m.roleid",
  "      from pg_auth_members m",
  "      join cr on cr.oid = m.member",
  "      join pg_roles g on g.oid = m.roleid",
  "     where g.rolname <> 'service_role'",
  "  ), cur as (",
  "    -- m: членство, де ХОЧ ОДИН бік клієнтський; PG16+ дає кілька грантів на",
  "    --    пару — тому агрегат, а не рядок",
  "    select 'm:' || pg_get_userbyid(m.roleid) || ':' || pg_get_userbyid(m.member) as key,",
  "           string_agg('grantor=' || pg_get_userbyid(m.grantor)",
  "                      || ',admin=' || m.admin_option::text",
  "                      || ',inherit=' || m.inherit_option::text",
  "                      || ',set=' || m.set_option::text,",
  "                      '|' order by pg_get_userbyid(m.grantor) collate \"C\") as dig",
  "      from pg_auth_members m",
  "     where m.roleid in (select oid from cr) or m.member in (select oid from cr)",
  "     group by m.roleid, m.member",
  "    union all",
  "    -- r: атрибути самої ролі",
  "    select 'r:' || r.rolname,",
  "           'super=' || r.rolsuper::text || ',createrole=' || r.rolcreaterole::text",
  "           || ',createdb=' || r.rolcreatedb::text || ',bypassrls=' || r.rolbypassrls::text",
  "           || ',inherit=' || r.rolinherit::text || ',login=' || r.rolcanlogin::text",
  "           || ',replication=' || r.rolreplication::text",
  "      from pg_roles r",
  "     where r.oid in (select oid from cr)",
  "    union all",
  "    -- g: налаштування ролі (у будь-якій базі), КРІМ таймаутів і спостережуваності",
  "    select 'g:' || pg_get_userbyid(s.setrole) || ':'",
  "           || coalesce((select quote_ident(d.datname) from pg_database d where d.oid = s.setdatabase), '*'),",
  "           string_agg(c.cfg, '|' order by c.cfg collate \"C\")",
  "      from pg_db_role_setting s",
  "      cross join lateral unnest(s.setconfig) c(cfg)",
  "     where s.setrole in (select oid from cr)",
  `       and split_part(c.cfg, '=', 1) !~* '${G_EXCLUDE_RE}'`,
  "     group by s.setrole, s.setdatabase",
  "    union all",
  "    -- n: ACL КОЖНОЇ схеми (крім тимчасових і toast) для клієнта або PUBLIC",
  "    select 'n:' || n.nspname || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,",
  `           ${AGG}`,
  "      from pg_namespace n",
  "      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n'::\"char\", n.nspowner))) a",
  `      cross join lateral ${PV}`,
  "     where n.nspname !~ '^pg_(toast|temp_|toast_temp_)'",
  "       and (a.grantee = 0 or a.grantee in (select oid from cr))",
  "     group by n.nspname, a.grantee",
  "    union all",
  "    -- d: default ACL, і в схемі, і глобальний (`defaclnamespace = 0` → `*`);",
  "    --    імʼя схеми — сире, як у n: (regnamespace::text залежить від",
  "    --    quote_all_identifiers сесії)",
  "    select 'd:' || pg_get_userbyid(d.defaclrole) || ':'",
  "           || case when d.defaclnamespace = 0 then '*'",
  "                   else coalesce((select dn.nspname::text from pg_namespace dn where dn.oid = d.defaclnamespace), '?') end",
  "           || ':' || d.defaclobjtype::text || ':'",
  "           || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,",
  `           ${AGG}`,
  "      from pg_default_acl d",
  "      cross join lateral aclexplode(d.defaclacl) a",
  `      cross join lateral ${PV}`,
  "     where a.grantee = 0 or a.grantee in (select oid from cr)",
  "     group by d.defaclrole, d.defaclnamespace, d.defaclobjtype, a.grantee",
  "    union all",
  "    -- d: СИНТЕТИЧНИЙ ключ — глобальний default ACL для f/T БЕЗ PUBLIC. Вбудований",
  "    --    дефолт цих типів дає PUBLIC право, тож такий рядок — ОБМЕЖЕННЯ. Його",
  "    --    зняття видаляє рядок (ACL знову дорівнює вбудованому) і мусить дати",
  "    --    `missing:`, а не тишу.",
  "    select 'd:' || pg_get_userbyid(d.defaclrole) || ':*:' || d.defaclobjtype::text || ':PUBLIC', '<none>'",
  "      from pg_default_acl d",
  "     where d.defaclnamespace = 0",
  "       and d.defaclobjtype in ('f', 'T')",
  "       and not exists (select 1 from aclexplode(d.defaclacl) x where x.grantee = 0)",
  "    union all",
  "    -- b: ACL поточної бази (CREATE тут = право створювати схеми)",
  "    select 'b:' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,",
  `           ${AGG}`,
  "      from pg_database db",
  "      cross join lateral aclexplode(coalesce(db.datacl, acldefault('d'::\"char\", db.datdba))) a",
  `      cross join lateral ${PV}`,
  "     where db.datname = current_database()",
  "       and (a.grantee = 0 or a.grantee in (select oid from cr))",
  "     group by a.grantee",
  "  ), expd(key, dig) as (values",
  ROLE_EXPD,
  "  )",
  "  select array_agg(x.what order by x.what) into v_tmp",
  "  from (",
  "    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what",
  "      from cur c join expd e on e.key = c.key",
  "     where c.dig is distinct from e.dig",
  "    union all",
  "    select 'new:' || c.key || '->' || coalesce(c.dig, '<null>')",
  "      from cur c",
  "     where not exists (select 1 from expd e where e.key = c.key)",
  "    union all",
  "    select 'missing:' || e.key",
  "      from expd e",
  "     where not exists (select 1 from cur c where c.key = e.key)",
  "  ) x;",
].join("\n") + "\n";

const CHECK26_PROSE = [
  "  -- 26. ПОВЕРХНЯ КЛІЄНТСЬКИХ РОЛЕЙ ПОЗА ПРЯМИМИ ГРАНТАМИ (0201, Р74-2(б)).",
  "  --     `;acl=` у №19 і дайджест №22 бачать лише ПРЯМІ гранти на обʼєкти",
  "  --     `public`. Членства, ACL схем і бази, default ACL, атрибути й",
  "  --     налаштування ролей до 0201 не ПІНИЛА жодна перевірка (№15/№18/№22",
  "  --     читають членство лише щоб знайти клієнтські ролі; №15(b) — лише",
  "  --     TRUNCATE у default ACL схеми public); успадковане право бачили",
  "  --     тільки окремі has_*_privilege-гілки №15 і №18 на названих привілеях",
  "  --     (і `f:` №22 — лише для `anon`). Кожен обхід заміряно 15.09 зондом у",
  "  --     відкоченій транзакції від ролі `postgres`:",
  "  --       ПРОХОДИТЬ:",
  "  --       • `grant <роль> to authenticated` — клієнт успадковує чужі права;",
  "  --       • новий LOGIN-член `authenticated` — прямий SQL під клієнтською",
  "  --         роллю сам виставляє `request.jwt.claims`, тобто стає будь-ким;",
  "  --       • `alter role authenticated set session_replication_role = replica`",
  "  --         (supautils це дозволяє). ⚠️ Чи застосовує PostgREST цей параметр",
  "  --         (контекст superuser) у клієнтських сесіях — НЕ заміряно; якщо так,",
  "  --         це вимкнення звичайних тригерів, тобто гардів №17. Пінимо в будь-",
  "  --         якому разі;",
  "  --       • `alter role authenticator set pgrst.db_schemas = …` — інша",
  "  --         поверхня PostgREST;",
  "  --       • `grant create on schema public`, `grant create on database`,",
  "  --         `alter default privileges …` у схемі і глобально;",
  "  --       БЛОКУЄТЬСЯ (42501): `alter role authenticated bypassrls` (reserved",
  "  --       role, supautils); `grant set on parameter`; `alter role … set",
  "  --       \"request.jwt.claim.sub\"`; `alter database … set` для",
  "  --       session_replication_role, request.jwt.*, safeupdate.enabled.",
  "  --",
  "  --     Ключі (одне множинне порівняння, як у №22; `new:` / `missing:` /",
  "  --     `changed:` з очікуваним і фактичним):",
  "  --       m: роль:член               — членства, де хоч один бік клієнтський;",
  "  --                                    грантор і admin/inherit/set КОЖНОГО",
  "  --                                    гранта (PG16+ їх буває кілька на пару);",
  "  --       r: роль                    — super/createrole/createdb/bypassrls/",
  "  --                                    inherit/login/replication;",
  "  --       g: роль:база|*             — налаштування ролі, КРІМ таймаутів і",
  "  --                                    спостережуваності;",
  "  --       n: схема:грантей           — ACL усіх схем, крім toast і тимчасових;",
  "  --       d: власник:схема|*:тип:грантей — default ACL; для глобального рядка",
  "  --                                    f/T без PUBLIC — синтетичне `<none>`;",
  "  --       b: грантей                 — ACL поточної бази.",
  "  --     Грантей — клієнтська роль або PUBLIC (grantee = 0): грант на PUBLIC",
  "  --     дістається і anon, і authenticated, а `revoke … from anon` його не знімає.",
  "  --     Дайджест прав — DISTINCT і з `*` за grant option: другий грантор тієї ж",
  "  --     привілеї не червонить, а порядок детермінований (`collate \"C\"`).",
  "  --     Базис 15.09: 62 ключі (m 7, r 3, g 1, n 20, d 30, b 1).",
  "  --",
  "  --     ⚠️ РОЛІ НЕ ХАРДКОДОМ і ТРАНЗИТИВНО: `authenticator` і замикання ролей,",
  "  --        членом яких він є, без `service_role`. Нова клієнтська роль сама",
  "  --        дасть `new:m:<роль>:authenticator` і `new:r:`; роль, яку клієнт",
  "  --        успадковує через іншу, — теж (ревʼю с74: без замикання дрейф",
  "  --        уже запіненої проміжної ролі був невидимий).",
  "  --     ⚠️ ОБИДВА НАПРЯМКИ членства: `member` клієнтський — що клієнт",
  "  --        УСПАДКОВУЄ; `roleid` клієнтський — хто може СТАТИ клієнтом.",
  "  --     ⚠️ ПОЗА `g:` СВІДОМО (регулярка нижче): таймаути і",
  "  --        спостережуваність/тюнінг зі списку supautils (log_*, track_*,",
  "  --        pgaudit.*, auto_explain.*, pg_stat_statements.*, plan_filter.*,",
  "  --        pg_net.*, deadlock_timeout, wal_compression). Їх законно крутять —",
  "  --        той самий pgaudit для медичного аудиту, — а вічно червоний сторож",
  "  --        — знятий сторож (урок 0141). ⚠️ Виключення двобічне: і ВИМКНЕННЯ",
  "  --        (`pgaudit.log = none` на ролі) пройде мовчки — це межа. Небезпечні",
  "  --        з того ж списку (`pgrst.*`, `safeupdate.enabled`,",
  "  --        `session_replication_role`) лишаються в `g:`.",
  "  --",
  "  --     ⚠️ НАЗВАНІ МЕЖІ:",
  "  --       • `service_role` як ГРАНТЕЙ і як вершину замикання не пінимо (канон",
  "  --         0163): його поверхня — ротація ключа. Членство",
  "  --         `service_role ← authenticator` пінимо, бо член клієнтський;",
  "  --       • ДРУГИЙ ХІД «хто може стати клієнтом»: `grant",
  "  --         supabase_storage_admin to <роль>` не дає ключа (жоден бік не",
  "  --         клієнтський), хоча та роль може `SET ROLE authenticator`. Від",
  "  --         `postgres` недосяжно — ADMIN на `supabase_storage_admin` у нього",
  "  --         немає (замір 15.09);",
  "  --       • `grant set on parameter` (`pg_parameter_acl`) — поза: від",
  "  --         `postgres` не можна ні видати, ні відкликати, тож і фальсифікувати",
  "  --         гілку нічим. `r:` на відміну від неї фальсифікується: нова",
  "  --         клієнтська роль дає `new:r:`;",
  "  --       • налаштування БАЗИ для всіх ролей (`alter database … set`) — поза:",
  "  --         небезпечні параметри там від `postgres` заблоковано (див. вище),",
  "  --         а USERSET (`search_path`, навіть `role`) проходить, але PostgREST",
  "  --         ставить роль і шлях ЛОКАЛЬНО в кожному запиті, а без CREATE на схемі",
  "  --         (`n:`) тіньових обʼєктів клієнту не створити. Там же живе",
  "  --         `app.settings.jwt_exp`;",
  "  --       • мови, типи, FDW-сервери, великі обʼєкти — поза;",
  "  --       • ОБʼЄКТИ в схемах поза `public` (таблиці storage, функції graphql)",
  "  --         — як і раніше, ніхто: тут лише право на схему і дефолти для",
  "  --         МАЙБУТНІХ обʼєктів;",
  "  --       • `revoke` від НЕ-грантора — тиша в самому Postgres (замір 15.09:",
  "  --         `revoke usage on schema graphql_public from anon` від postgres не",
  "  --         знімає гранту supabase_admin), тож і ключ не змінюється — так і",
  "  --         мусить бути;",
  "  --       • платформа Supabase (грантор `supabase_admin`) може змінити свої",
  "  --         дефолти чи членства при оновленні, а ввімкнене в дашборді",
  "  --         розширення — додати схему з USAGE для `anon`. Перевірка",
  "  --         ПОЧЕРВОНІЄ, і це не шум, а сигнал: поверхня клієнта змінилась без",
  "  --         міграції. Порядок той самий, що для №22, — розібратись і",
  "  --         передрукувати;",
  "  --       • як і №25, ловить ДРЕЙФ, а не зловмисника з правами postgres.",
].join("\n") + "\n";

const CHECK26 = CHECK26_PROSE
  + "  v_n := v_n + 1;\n"
  + "  /* 0174 */ begin\n"
  + "  v_tmp := null;\n"
  + Q26
  + "  if v_tmp is not null then\n"
  + "    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n"
  + "      'check', 'role_surface', 'offenders', to_jsonb(v_tmp)));\n"
  + "  end if;\n"
  + "  /* 0174 */ exception when others then\n"
  + "  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n"
  + "  /* 0174 */     'check', 'role_surface', 'offenders',\n"
  + "  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));\n"
  + "  /* 0174 */ end;\n";

for (const bad of ["$q$", "$function$", "$p$", "$apply$", "$dryrun$", "$back$", "$falsify$", "*/ begin\n  --"]) {
  if (Q26.includes(bad) || PROSE_0201.includes(bad)) throw new Error(`№26/проза містить ${bad}`);
}
if (/\/\*|\*\//.test(Q26) || /\/\*|\*\//.test(CHECK26_PROSE)) throw new Error("№26: блочний коментар у запиті чи прозі зламав би вирізувачі тестів");
if (count(CHECK26, "exception when others then") !== 1) throw new Error("№26: обробник мусить бути рівно один (invariantsFailLoud)");

const TAIL_ANCHOR =
  "\n  v_res := jsonb_build_object(\n"
  + "    'ok',      jsonb_array_length(v_fail) = 0,\n";

const PAIRS = [
  [ANCHOR_WAITLIST, ANCHOR_WAITLIST + ADD, "16 рядків у список №19 після set_waitlist_status_rpc"],
  [PROSE_COUNT_FROM, PROSE_COUNT_TO, "лічильник у заголовку прози №19: 43 -> 59"],
  ["0193 → 40, 0200 → 43), а заголовок", "0193 → 40, 0200 → 43, 0201 → 59), а заголовок",
    "історія росту списку в прозі №19: + 0201 → 59"],
  [NOWHERE_FROM, NOWHERE_TO, "межа 0191 «не входять нікуди більше» — тепер №26"],
  [ANCHOR_PROSE_END,
    "  --        РІШЕННЯ ВЛАСНИКА 15.09 (стартовий промпт с74).\n"
    + PROSE_0201 + "  v_n := v_n + 1;\n",
    "абзац 0201 у прозі №19 перед кроком лічильника"],
  [G22_FROM, G22_TO, "межа №22 «лише public» — дефолти й USAGE тепер у №26"],
  [P2_FROM, P2_TO, "проза №2: CREATE на public тепер пасе №26"],
  [P0200_FROM, P0200_TO, "абзац 0200: «окреме рішення» — вирішено в 0201"],
  [P25_FROM, P25_TO, "проза №25: «єдина річ» — не єдина"],
  [TAIL_ANCHOR, "\n" + CHECK26 + TAIL_ANCHOR, "вставка перевірки №26 перед збіркою v_res"],
];
for (let i = 0; i < PAIRS.length; i++) {
  for (let j = i + 1; j < PAIRS.length; j++) {
    if (PAIRS[i][1].includes(PAIRS[j][0])) throw new Error(`ПОРЯДОК: «${PAIRS[i][2]}».to несе «${PAIRS[j][2]}».from`);
  }
}

// ---------------------------------------------------------------------------
// 5. ХІД УПЕРЕД. Кожна пара — рівно одне влучання.
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
if (!/^guard_body_md5=[0-9a-f]{32};len=[0-9]+$/.test(PIN)) {
  throw new Error(`ПІН не збігається з регуляркою перевірки №25: ${PIN}`);
}
{
  const want = PRE_LEN + PAIRS.reduce((s, [f, t]) => s + t.length - f.length, 0);
  if (NEW_LEN !== want) throw new Error(`ДОВЖИНА ${NEW_LEN}, а з пар виходить ${want}`);
}

// ---------------------------------------------------------------------------
// 6. ЗМІСТОВІ ПЕРЕВІРКИ. Кожна — з очікуваним ЧИСЛОМ.
// ---------------------------------------------------------------------------
/** Той самий вирізувач, що в `tests/guardFnBodiesInvariant.test.ts`. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const ROW_RE = /^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm;
const listOf = (body) => {
  const open = "with expd(fn, body, attrs) as (values";
  const close = "    ), cur as (";
  if (count(body, open) !== 1 || count(body, close) !== 1) throw new Error("межі списку №19 не унікальні");
  const a = body.indexOf(open);
  return body.slice(a + open.length, body.indexOf(close, a));
};
const sigsOf = (list) => (list.match(ROW_RE) || []).map((r) => r.slice(r.indexOf("('") + 2, r.indexOf("',")));

const OLD_SIGS = sigsOf(listOf(SRC.body));
const NEW_SIGS = sigsOf(listOf(NEW_BODY));
const WANT_SIGS = new Set([...OLD_SIGS, ...NEW_ROWS.map((r) => r[0])]);
const OLD_CODE = codeOf(SRC.body);
const NEW_CODE = codeOf(NEW_BODY);
/** Код №26 без коментарів — рівно те, що вставлено в код сторожа. */
const CHECK26_CODE = codeOf("\n" + CHECK26);
const STEP = /^  v_n := v_n \+ 1;$/gm;

const CHECKS = [
  ["у старому списку 43 підписи", OLD_SIGS.length, 43],
  ["жодного з шістнадцяти підписів (і жодного з імен) у старому СПИСКУ",
    NEW_ROWS.filter((r) => listOf(SRC.body).includes(`('${r[0].slice(0, r[0].indexOf("("))}(`)).length, 0],
  ["у новому списку 59 розпізнаних рядків", NEW_SIGS.length, 59],
  ["усі рядки нового списку розпізнано (формат не поїхав)",
    listOf(NEW_BODY).split("\n").filter((l) => l.trim().startsWith("('")).length, 59],
  ["множина = стара ∪ шістнадцять нових, без дублів", new Set(NEW_SIGS).size === WANT_SIGS.size
    && NEW_SIGS.length === WANT_SIGS.size && NEW_SIGS.every((s) => WANT_SIGS.has(s)) ? 1 : 0, 1],
  ["`;acl=` у КОЖНОМУ рядку нового списку",
    (listOf(NEW_BODY).match(/^ {6}\('[^']+','[0-9a-f]{32}','[^']*;acl=[^']*'\),?$/gm) || []).length, 59],
  ["кожен новий рядок трапляється в тілі рівно раз",
    NEW_ROWS.filter((r) => count(NEW_BODY, rowText(r)) === 1).length, 16],
  [`лічильник перевірок: було ${PRE_CHECKED}`, (codeOf(SRC.body).match(STEP) || []).length, PRE_CHECKED],
  [`лічильник перевірок: стало ${NEW_CHECKED} (у КОДІ, без коментарів)`, (NEW_CODE.match(STEP) || []).length, NEW_CHECKED],
  ["мітка №19 на місці рівно раз у звіті", count(NEW_CODE, "'check', 'guard_fn_bodies'"), 1],
  ["мітка №26: успіх + гілка винятку, і більше ніде", count(NEW_CODE, "'check', 'role_surface'"), 2],
  ["мітки №26 не було в 0200", count(SRC.body, "role_surface"), 0],
  ["№26 стоїть ОСТАННЬОЮ: після мітки №25 і перед збіркою v_res",
    NEW_CODE.lastIndexOf("'check', 'guard_self_pin'") < NEW_CODE.indexOf("'check', 'role_surface'")
    && NEW_CODE.lastIndexOf("'check', 'role_surface'") < NEW_CODE.indexOf("  v_res := jsonb_build_object(") ? 1 : 0, 1],
  ["обгорток 0174 = перевірок − 1 (tests/invariantsFailLoud)",
    NEW_BODY.split("\n").filter((l) => l === "  /* 0174 */ begin").length, NEW_CHECKED - 1],
  ["обробників = обгортки + 3 власні (tests/invariantsFailLoud)",
    count(NEW_BODY, "exception when others then"), (NEW_CHECKED - 1) + 3],
  ["Q26 у тілі рівно раз (жива звірка накату стріляє тим самим текстом)", count(NEW_BODY, Q26), 1],
  ["62 ключі №26 у тілі", (NEW_BODY.match(/^ {6}\('[bdgmnr]:[^']*','[^']*'\),?$/gm) || []).length, 62],
  ["хвіст збірки v_res лишився один", count(NEW_BODY, "  v_res := jsonb_build_object("), 1],
  ["заголовок прози каже 59", count(NEW_BODY, "ЩО ПІНИМО (сьогодні 59 підписів"), 1],
  ["заголовок прози більше не каже 43", count(NEW_BODY, "сьогодні 43 підписи"), 0],
  ["історія росту списку дописана", count(NEW_BODY, "0193 → 40, 0200 → 43, 0201 → 59)"), 1],
  ["межа 0191 більше не каже «нікуди» без застереження", count(NEW_BODY, "нікуди більше. ⚠️ Так було до 0201"), 1],
  ["межа №22 посилається на №26", count(NEW_BODY, "поза 0166 (0201: USAGE"), 1],
  // ⚠️ ГОЛОВНИЙ БАЗИС: у КОДІ (без коментарів) змінилось РІВНО дві речі —
  //    шістнадцять рядків списку і код №26. Проза сюди не входить за побудовою,
  //    а будь-яка випадкова правка виразу, гейта чи іншої гілки дала б тут 0.
  ["код без коментарів = код 0200 + 16 рядків + код №26, і більше нічого",
    count(NEW_CODE, ADD) === 1 && count(NEW_CODE, CHECK26_CODE) === 1
    && NEW_CODE.split(ADD).join("").split(CHECK26_CODE).join("") === OLD_CODE ? 1 : 0, 1],
  ["код №26 не порожній (антивакуум базису)", CHECK26_CODE.includes("from pg_auth_members m") && CHECK26_CODE.length > 5000 ? 1 : 0, 1],
];
for (const [lbl, got, want] of CHECKS) {
  if (got !== want) throw new Error(`ЗМІСТ: «${lbl}» — ${got}, а треба ${want}`);
}

// ⚠️ ЗВОРОТНИЙ ХІД має власний базис (урок 0196).
{
  let back = NEW_BODY;
  for (let i = PAIRS.length - 1; i >= 0; i--) {
    const [from, to, lbl] = PAIRS[i];
    const hits = count(back, to);
    if (hits !== 1) throw new Error(`ЗВОРОТНИЙ ЯКІР «${lbl}»: ${hits} влучань, а треба 1`);
    back = back.split(to).join(from);
  }
  if (md5(back) !== PRE_MD5 || back.length !== PRE_LEN) {
    throw new Error(`ЗВОРОТНИЙ ХІД дав ${md5(back)} / ${back.length}, а 0200 це ${PRE_MD5} / ${PRE_LEN}`);
  }
}

// ---------------------------------------------------------------------------
// 7. ВИРАЗ `cur` №19 — ВИРІЗАНИЙ із тіла сторожа, а не переписаний руками.
// ---------------------------------------------------------------------------
const CUR_EXPR = (() => {
  // ⚠️ Відступ ЧОТИРИ пробіли: `  ), cur as (` із двома стоїть у №22, №23 і
  //    тепер у №26. Виріз мусить закінчитись ДО мітки №19.
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
  ["мова з pg_language", /join pg_language l on l\.oid = p\.prolang/],
  ["повний md5 нормалізованого тіла", /md5\(btrim\(regexp_replace\(/],
  ["поле ;acl= з двома гілками", /';acl='\s*\|\|\s*case when p\.proacl is null then '<default>'/],
  ["розширення по голому імені зі expd", /p\.proname = any \(select split_part\(e\.fn, '\(', 1\) from expd e\)/],
]) {
  if (!re.test(CUR_EXPR)) throw new Error(`ВИРАЗ cur: немає «${lbl}» — виріз поїхав`);
}
if (/--|\/\*|\$/.test(CUR_EXPR)) throw new Error("ВИРАЗ cur містить коментар або долар — у фрагмент його так не вставити");

// ---------------------------------------------------------------------------
// 8. ЗВІРКА СТЕНДОВИХ ЯКОРІВ ЗА ЛІТЕРАЛАМИ (переписано після ревʼю с74, лінза Б).
//    Попередня евристика (вікна ±30 навколо зміни, з 0196) була майже сліпа:
//    12 із 15 зондів несли справжній `\n`, а в стендах якорі записані JS-рядками
//    з екранованим `\n`; пари-вставки давали НУЛЬ зондів. Тепер навпаки: з
//    кожного стенда витягуються й ДЕКОДУЮТЬСЯ рядкові літерали, і для кожного,
//    що трапляється в тілі 0200, звіряється число входжень у тілі 0201:
//      • було 1, стало не 1 → якір, на який стенд розраховує як на унікальний,
//        зламано (мутація не застосується або застосується не туди);
//      • було ≥1, стало 0 → якір зник.
//    ⚠️ Межа, названа: літерал, склеєний у стенді з частин через `+` чи
//       шаблон із `${…}`, звіряється лише по частинах. Для того і повна ревізія
//       `falsify-all.mjs`. Виняток як і раніше — стенд, що ПОІМЕННО читає
//       старий файл міграції, де цей текст живе й далі.
// ---------------------------------------------------------------------------
function literalsOf(src) {
  // Маленький лексер JS: коментарі, рядки, шаблони, regex-літерали. Регулярками
  // тут не можна — бектик чи апостроф у коментарі розсинхронізує все далі
  // (перша редакція цієї звірки на цьому й спіткнулась).
  const out = [];
  const n = src.length;
  let i = 0;
  let prev = "";   // останній значущий символ поза коментарями/рядками
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
    if (!/\s/.test(c)) prev = c; else if (c === "\n" && "});".includes(prev) === false) { /* лишаємо prev */ }
    i++;
  }
  return out;
}

{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  if (stands.length < 30) {
    throw new Error(`ЯКОРІ: лише ${stands.length} файлів за маскою falsify-*.mjs — очікувалось ≥30`);
  }
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
      // ⚠️ Стенд, що ПОІМЕННО читає стару міграцію, може цілити і в неї, і в
      //    передрук — статично не розрізнити (falsify-0166 робить обидва). Тому
      //    такий збіг не мовчить, а друкується для ручного розбору.
      if (livesInNamed) ambiguous.push(line); else stale.push(line);
    }
  }
  if (ambiguous.length) console.log(`  ⚠️ якорі, що живуть і в поіменній старій міграції (розібрати руками):\n    ${ambiguous.join("\n    ")}`);
  if (checked < 100) throw new Error(`ЯКОРІ: звірено лише ${checked} літералів, що живуть у тілі — розбір стендів зламався`);
  if (stale.length) throw new Error(`ЯКОРІ ПРОТУХЛИ:\n  ${stale.join("\n  ")}`);
  console.log(`  якорі стендів: ${stands.length} файлів, ${checked} літералів у тілі сторожа, 0 протухлих`);
}

// ---------------------------------------------------------------------------
// 9. ФРАГМЕНТИ. Долар-лапки: $p$ — рядки підстановок; блоки — $apply$/$dryrun$/
//    $back$/$falsify$. Жоден текст не сміє нести чужий тег.
// ---------------------------------------------------------------------------
for (const t of ["$p$", "$apply$", "$dryrun$", "$back$", "$falsify$"]) {
  for (const [f, to, lbl] of PAIRS) {
    if ((f + to).includes(t)) throw new Error(`пара «${lbl}» містить тег ${t} — змініть долар-лапки`);
  }
  if (CUR_EXPR.includes(t) || Q26.includes(t)) throw new Error(`вираз cur або Q26 містить тег ${t}`);
}
const q = (s) => `$p$${s}$p$`;
const arr = (xs) => "array[\n" + xs.map((x) => `    ${q(x)}`).join(",\n") + "\n  ]";

const PRE = [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування",
  "  -- ролі оператора (урок 0196).",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  "    raise exception '0201: мусить іти від ролі postgres, а йде від %', current_user;",
  "  end if;",
].join("\n");

const LEDGER_GUARDS = [
  `  if exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0201: рядок уже в леджері — повторний накат заборонено';",
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  "    raise exception '0201: у леджері немає 0200 — накат не в свою чергу';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${PREV_LEDGER}' then`,
  "    raise exception '0201: останній рядок леджера % — не 0200, черга зсунулась',",
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
  "  -- ⚠️ САМОПІН №25 мусить збігатися з тілом ДО правки. Якщо ні — на проді",
  "  --    вже дрейф, і чинити його цим пакетом не можна.",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')",
  `     is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: самопін % не збігається з тілом ${what} — спершу розібратись',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const EXPD_ROWS = NEW_ROWS.map(rowText).join("\n").replace(/,$/, "");
const NAMES_SQL = NEW_NAMES.map((n) => `'${n}'`).join(", ");
const LIVE_ROWS = [
  "  -- ── Живі рядки шістнадцяти функцій — ТИМ САМИМ виразом `cur`, вирізаним ──",
  "  --    генератором із тіла сторожа. Генератор БД не бачить, рядки зняті",
  "  --    заміром 15.09; `grant` чи правка тіла між заміром і накатом зупиняють",
  "  --    накат ТУТ, а не кладуть червоного сторожа.",
  "  select count(*) into v_hits",
  "    from pg_proc p",
  "   where p.pronamespace = 'public'::regnamespace",
  `     and p.proname in (${NAMES_SQL});`,
  "  if v_hits <> 16 then",
  "    raise exception '0201: обʼєктів із шістнадцятьма іменами % замість 16 — перевантаження дало б extra: одразу після накату', v_hits;",
  "  end if;",
  "  with expd(fn, body, attrs) as (values",
  EXPD_ROWS,
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
  "    raise exception '0201: живі рядки №19 не збіглися з піном — перезняти замір, а не накатувати: %', v_bad;",
  "  end if;",
].join("\n");

if (count(Q26, "into v_tmp") !== 1) throw new Error("Q26: `into v_tmp` не рівно один — живу звірку не зібрати");
const LIVE26 = [
  "  -- ── Жива поверхня клієнтських ролей — ТИМ САМИМ запитом, що лягає в №26 ──",
  "  --    (генератор асертить, що цей текст трапляється в новому тілі рівно раз).",
  "  --    Будь-яка зміна членств, ACL схем чи default ACL між заміром і накатом",
  "  --    зупиняє накат тут.",
  Q26.replace("into v_tmp", "into v_bad").replace(/\n$/, ""),
  "  if v_bad is not null then",
  "    raise exception '0201: жива поверхня клієнтських ролей не збіглася з піном №26 — перезняти замір: %', v_bad;",
  "  end if;",
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
  "  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції, інакше сторож червоніє ────────",
  "  -- ⚠️ Пін БЕРЕТЬСЯ З БД і лише потім звіряється з тим, що порахував",
  "  --    генератор: `length()` у Postgres рахує СИМВОЛИ, `.length` у JS —",
  "  --    одиниці UTF-16. Розбіжність ЗУПИНЯЄ накат (урок 0198).",
  "  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);",
  `  if v_pin_db is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: пін із БД (%) розійшовся з піном із файлу (${wantPin})', v_pin_db;`,
  "  end if;",
  "  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);",
  "  -- Читання НАЗАД: `comment on` мовчазний, «виконалось» — не доказ.",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then",
  `    raise exception '${tag}: пін не ліг — у коментарі %',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const DECL = (tag, fromXs, toXs, lblXs) => [
  `do $${tag}$`,
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_rcc text;",
  `  v_from constant text[] := ${arr(fromXs)};`,
  `  v_to   constant text[] := ${arr(toXs)};`,
  `  v_lbl  constant text[] := ${arr(lblXs)};`,
  "begin",
].join("\n");

const FWD = [PAIRS.map((p) => p[0]), PAIRS.map((p) => p[1]), PAIRS.map((p) => p[2])];
const BWD = [[...PAIRS].reverse().map((p) => p[1]), [...PAIRS].reverse().map((p) => p[0]),
  [...PAIRS].reverse().map((p) => `назад: ${p[2]}`)];

const LEDGER_INSERT = [
  "  -- ⚠️ БЕЗ `on conflict do nothing` (ревʼю с74, лінза А): рядок, вставлений",
  "  --    паралельною сесією між перевіркою і вставкою, мусить ВАЛИТИ накат.",
  "  insert into public.migration_ledger (name)",
  `  values ('${DST_NAME}');`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0201: рядок леджера не ліг (% рядків)', v_rows;",
  "  end if;",
].join("\n");

/** Читання назад ОКРЕМИМ стейтментом того ж запиту: `raise notice` через MCP
 *  не повертається, тож без цього «успіх» накату був би невидимий (ревʼю с74). */
const READBACK = [
  "select md5(replace(p.prosrc, chr(13), '')) as guard_md5,",
  "       length(replace(p.prosrc, chr(13), '')) as guard_len,",
  "       obj_description(p.oid, 'pg_proc') as guard_pin,",
  "       (select count(*) from public.migration_ledger) as ledger_rows,",
  "       (select max(name) from public.migration_ledger) as ledger_last",
  "  from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  " where n.nspname = 'public' and p.proname = 'invariants_check'",
  "   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
].join("\n");

const RCC_NORM = [
  "  select md5(btrim(regexp_replace(",
  "           p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),",
  "           '\\s+', ' ', 'g'))) into v_rcc",
  "    from pg_proc p",
  "   where p.oid = to_regprocedure('public.referral_center_card(uuid)');",
].join("\n");
const PARITY = [
  "  -- ── Паритет referral_center_card з файлом 0195 (розділ 2-біс генератора) ──",
  "  --    На проді тіло лежить без коментарів (0fcc…); перестворюємо ДОСЛІВНО",
  "  --    текстом 0195 і читаємо назад. Будь-яке інше тіло на проді — стоп.",
  RCC_NORM,
  `  if v_rcc is distinct from '${RCC_PROD_MD5}' then`,
  `    raise exception '0201: тіло referral_center_card на проді % — не заміряне 15.09 (${RCC_PROD_MD5}), паритет наосліп заборонено', coalesce(v_rcc, '(немає функції)');`,
  "  end if;",
  "  execute $rcc$" + RCC_STMT.replace(/;$/, "") + "\n$rcc$;",
  RCC_NORM,
  `  if v_rcc is distinct from '${RCC_FILE_MD5}' then`,
  `    raise exception '0201: після перестворення тіло referral_center_card % замість ${RCC_FILE_MD5}', v_rcc;`,
  "  end if;",
].join("\n");
if (count(PARITY, "$rcc$") !== 2) throw new Error("PARITY: тег $rcc$ не рівно двічі");

const BODY_FWD = [
  PRE,
  LEDGER_GUARDS,
  readGuard("0201", PRE_MD5, PRE_LEN, PRE_PIN, "0200"),
  "",
  PARITY,
  "",
  LIVE_ROWS,
  "",
  "  -- ⚠️ Живої звірки №26 тут НЕМАЄ свідомо: текст Q26 (≈8 КБ) подвоїв би вагу",
  "  --    фрагмента, який оператор несе в SQL-клієнт руками. Її роль виконують",
  "  --    сухий прогін (кличе САМ сторож і вимагає зелену `role_surface` на",
  "  --    новому тілі — хвилини до накату) і окремий `invariants_check` після",
  "  --    накату (крок 3). Передумова фальсифікації звіряє Q26 явно.",
  "",
  "  -- ── Передрук сторожа: + 16 рядків №19, + перевірка №26, + проза ─────────",
  substitute("0201", "v_from", "v_to", "v_lbl", NEW_MD5, NEW_LEN, "файл 0201"),
  "",
  pinBlock("0201", PIN),
  "",
  LEDGER_INSERT,
].join("\n");

const APPLY = [
  "-- 0201 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0201-reprint.mjs`. Одним запитом,",
  "-- ОДНА транзакція.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна: передрук і пін там — два",
  "--    верхньорівневі стейтменти, тобто дві транзакції; обрив між ними лишає",
  "--    нове тіло зі СТАРИМ піном, і №25 червоніє одразу (урок 0198).",
  DECL("apply", ...FWD),
  BODY_FWD,
  "",
  "  raise notice 'APPLY_0201_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$apply$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN},`,
  `--   guard_pin = ${PIN}, ledger_rows = 201, ledger_last = ${DST_NAME}`,
  READBACK,
  "",
  "-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit (≈9–15 с). Не поруч з",
  "--    іншим деплоєм чи DDL. І не в 03:45–04:05 UTC: там крон `invariants` пише",
  "--    результат із `ledger_md5` червоною, доки `npm run db:gate` не проштампував рядок.",
  "--      select public.invariants_check(false);",
  `--      -- очікування: checked ${NEW_CHECKED}; до \`npm run db:gate\` єдиний ОЧІКУВАНИЙ`,
  "--      -- порушник — `ledger_md5` (md5 файла ще не проштамповано).",
].join("\n");

const DRY_LABELS = "('guard_fn_bodies', 'guard_self_pin', 'role_surface')";
const DRYRUN = [
  "-- 0201 DRY RUN — ЗГЕНЕРОВАНО `node scripts/build-0201-reprint.mjs`. Те саме, що",
  "-- APPLY, але транзакція СВІДОМО валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ",
  "--    (урок 0195: execute_sql жене батч однією транзакцією).",
  "-- ⚠️ Тег блоку — dryrun, а не apply: більша частина тексту збігається з APPLY,",
  "--    і переплутаний файл закомітив би прод. Перед вставкою перевірити, що",
  "--    запит ПОЧИНАЄТЬСЯ з тегу dryrun.",
  DECL("dryrun", ...FWD),
  BODY_FWD,
  "",
  "  -- Сторожа кличемо ТУТ, бо прогін усе одно відкотиться: треба бачити",
  `  -- \`checked = ${NEW_CHECKED}\` і зелені №19, №25, №26 ДО того, як чіпати прод.`,
  "  v_res := public.invariants_check(false);",
  `  if (v_res->>'checked')::int <> ${NEW_CHECKED} then`,
  `    raise exception '0201-суха: сторож перевірив % замість ${NEW_CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  -- ⚠️ Окремо — що САМЕ №19, №25 і №26 зелені. «checked» означає лише",
  "  --    «перевірки виконались», а не «пін звівся».",
  "  if exists (select 1 from jsonb_array_elements(v_res->'failed') e",
  `              where e.value->>'check' in ${DRY_LABELS}) then`,
  "    raise exception '0201-суха: №19, №25 або №26 ЧЕРВОНА одразу після передруку: %', v_res->'failed';",
  "  end if;",
  "",
  "  raise exception 'DRYRUN_0201_ROLLBACK guard=% len=% pin=% checked=% ok=% failed=%',",
  "    md5(v_src), length(v_src), v_pin_db, v_res->>'checked', v_res->>'ok', v_res->'failed';",
  "end;",
  "$dryrun$;",
  "",
  "-- ⚠️ `ledger_md5` у сухому прогоні червона ОЧІКУВАНО: md5 рядка штампує",
  "--    `npm run db:gate` після коміту файла (так само в 0197, 0198, 0200).",
].join("\n");

const ROLLBACK = [
  "-- 0201 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0201-reprint.mjs`.",
  "-- Повертає тіло сторожа до 0200, ПОВЕРТАЄ самопін 0200 і знімає рядок леджера.",
  "--",
  "-- ⚠️ Пін НЕ знімається, а повертається: до 0201 він БУВ (0198/0200). Зняти",
  "--    його — зробити №25 червоною на гілці «пін ВІДСУТНІЙ».",
  "-- ⚠️ Одна транзакція: проміжний стан «тіло 0200, пін 0201» існує лише всередині",
  "--    неї і назовні не видний.",
  "-- ⚠️ `referral_center_card` НЕ повертається до тіла без коментарів: код",
  "--    тотожний, сторож 0200 її не пінить, а репозиторій — джерело істини.",
  DECL("back", ...BWD),
  PRE,
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0201-відкат: рядка 0201 у леджері немає — відкочувати нічого';",
  "  end if;",
  "  -- ⚠️ 0201 мусить бути ОСТАННІМ рядком: інакше відкат вирізав би рядок із",
  "  --    середини історії, а наступник міг на 0201 спиратися.",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${DST_NAME}' then`,
  "    raise exception '0201-відкат: після 0201 уже накатано % — спершу відкотити його',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  readGuard("0201-відкат", NEW_MD5, NEW_LEN, PIN, "0201"),
  "",
  substitute("0201-відкат", "v_from", "v_to", "v_lbl", PRE_MD5, PRE_LEN, "0200"),
  "",
  pinBlock("0201-відкат", PRE_PIN),
  "",
  `  delete from public.migration_ledger where name = '${DST_NAME}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0201-відкат: знято % рядків леджера замість 1', v_rows;",
  "  end if;",
  "",
  "  raise notice 'ROLLBACK_0201_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$back$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${PRE_MD5}, guard_len = ${PRE_LEN},`,
  `--   guard_pin = ${PRE_PIN}, ledger_rows = 200, ledger_last = ${PREV_LEDGER}`,
  READBACK,
  "",
  "-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: усі асерти вище — УСЕРЕДИНІ транзакції.",
  "--    Після commit ОКРЕМИМ запитом:",
  "--      select md5(replace(p.prosrc, chr(13), '')) as body, length(p.prosrc) as len,",
  "--             obj_description(p.oid, 'pg_proc') as pin",
  "--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "--       where n.nspname = 'public' and p.proname = 'invariants_check';",
  `--      -- очікування: body = ${PRE_MD5}, len = ${PRE_LEN}, pin = ${PRE_PIN}`,
  `--      select public.invariants_check(false);   -- checked ${PRE_CHECKED}`,
  "--    Git-частина — див. секцію ВІДКАТ у файлі міграції.",
].join("\n");

// ── ФАЛЬСИФІКАЦІЯ ─────────────────────────────────────────────────────────────
// №26: рівно ті 22 порушники, що дав зонд 15.09 тим самим запитом на
// мутованому стані (21 — зонд PROBE5; `missing:` замінено на відкликання ГРАНТУ
// САМОГО postgres: `revoke` від не-грантора в Postgres — тиша). Кожен рядок
// виведено з семантики PG ДО зонду, зонд лише підтвердив. Точні рядки, а не
// префікси: дайджест у `new:`/`changed:` — теж частина властивості.
const RN = R_NOLOGIN;
const WANT26 = [
  "changed:d:postgres:public:S:anon:SELECT,UPDATE,USAGE->UPDATE,USAGE",
  "changed:n:extensions:authenticated:USAGE->USAGE*",
  "changed:n:public:authenticated:USAGE->CREATE,USAGE",
  "missing:n:extensions:anon",
  "new:b:authenticated->CREATE",
  "new:d:postgres:*:T:PUBLIC->USAGE",
  "new:d:postgres:*:T:anon->USAGE",
  "new:d:postgres:*:f:PUBLIC-><none>",
  "new:g:anon:*->search_path=public",
  "new:g:authenticated:*->session_replication_role=replica",
  "new:m:authenticated:rf_falsify_0201c->grantor=postgres,admin=false,inherit=true,set=true",
  "new:m:rf_falsify_0201:authenticated->grantor=postgres,admin=false,inherit=true,set=true",
  "new:m:rf_falsify_0201:postgres->grantor=supabase_admin,admin=true,inherit=false,set=false",
  "new:m:rf_falsify_0201b:authenticator->grantor=postgres,admin=false,inherit=false,set=true",
  "new:m:rf_falsify_0201b:postgres->grantor=supabase_admin,admin=true,inherit=false,set=false",
  "new:m:rf_falsify_0201d:postgres->grantor=supabase_admin,admin=true,inherit=false,set=false",
  "new:m:rf_falsify_0201d:rf_falsify_0201->grantor=postgres,admin=false,inherit=true,set=true",
  "new:n:public:rf_falsify_0201d->CREATE",
  "new:n:storage:PUBLIC->USAGE",
  `new:r:rf_falsify_0201->${RN}`,
  `new:r:rf_falsify_0201b->${RN}`,
  `new:r:rf_falsify_0201d->${RN}`,
];
if (WANT26.length !== 22 || new Set(WANT26).size !== 22) throw new Error("WANT26: мусить бути 22 різні рядки");
const WANT19 = NEW_ROWS.map(([fn]) => `body:${fn}->`);
for (const w of [...WANT26, ...WANT19]) if (/'/.test(w)) throw new Error(`WANT: лапка в ${w}`);
const COLLATERAL_PREFIX = "profiles_column_not_granted:rf_falsify_0201b:";

const FALSIFY = [
  "-- 0201 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0201-reprint.mjs`.",
  "-- Піни мусять ЛОВИТИ, а не лише лягти. Один прогін сторожа на всі мутації,",
  "-- і транзакція СВІДОМО валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ і безумовний. Предстан перевіряти ОКРЕМИМ",
  "--    запитом після (див. кінець).",
  "-- ⚠️ ПЕРЕДУМОВА (ревʼю с74, лінза А): до мутацій — жива звірка №19 і №26 тими",
  "--    самими виразами, що в накаті. Інакше дрейф, що вже є на проді і збігся з",
  "--    рядком очікування, дав би хибний PASS.",
  "-- ⚠️ №19: шістнадцять мутацій ТІЛА — по одній на КОЖЕН новий рядок. Вердикт —",
  "--    рівно 16 порушників `body:`, жодного `attrs:`.",
  "-- ⚠️ №26: мутації всіх шести гілок і обох напрямків членства + ТРАНЗИТИВНА",
  "--    роль + негативні контролі (таймаут і log_* не мусять дати `g:`). Вердикт —",
  "--    РІВНО 22 порушники, дослівно.",
  "-- ⚠️ ПОБІЧНЕ ЧЕРВОНЕ ОЧІКУВАНЕ І ЗВУЖЕНЕ: нова роль `rf_falsify_0201b` (член",
  "--    authenticator) не читає колонок `profiles`, і №15 (f2) це помічає. Вердикт",
  `--    вимагає, щоб УСІ порушники priv_drift починались з \`${COLLATERAL_PREFIX}\``,
  "--    і був хоч один; інший справжній дрейф №15 у момент прогону — FAIL. До",
  "--    `db:gate` лишається ще `ledger_md5`; будь-що інше в other_failed — FAIL.",
  "-- ⚠️ БЛОКУВАННЯ: ~15 с тримаються AccessShare на таблицях, які читає сторож і",
  "--    валідатор SQL-функцій, і блокування рядків каталогу ролей/схем/бази. Не",
  "--    поруч з DDL чи деплоєм; трафік продукту (SELECT/DML, SET ROLE) не чекає.",
  "do $falsify$",
  "declare",
  "  v_res jsonb; v_off19 text[]; v_off26 text[]; v_offpd text[]; v_miss text[]; v_extra text[];",
  "  v_def text; v_n int := 0; v_other text[]; v_fn record; v_hits int; v_bad text[];",
  `  v_want19 constant text[] := ${arr(WANT19)};`,
  `  v_want26 constant text[] := ${arr(WANT26)};`,
  "begin",
  PRE.replaceAll("0201:", "0201-фальсифікація:"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0201-фальсифікація: 0201 не накатано — фальсифікувати нічого';",
  "  end if;",
  "  if (select md5(replace(p.prosrc, chr(13), '')) || '/' || length(replace(p.prosrc, chr(13), ''))",
  "             || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '(NULL)')",
  "        from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "       where n.nspname = 'public' and p.proname = 'invariants_check'",
  "         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')",
  `     is distinct from '${NEW_MD5}/${NEW_LEN}|${PIN}' then`,
  "    raise exception '0201-фальсифікація: у проді не тіло/пін 0201 — спершу розібратись';",
  "  end if;",
  "",
  "  -- ── ПЕРЕДУМОВА: жива поверхня = пін (обидва списки) ─────────────────────",
  LIVE_ROWS.replaceAll("'0201:", "'0201-фальсифікація:"),
  LIVE26.replaceAll("'0201:", "'0201-фальсифікація:"),
  "",
  "  -- M1–M16: тіло КОЖНОЇ з шістнадцяти змінено рядком коментаря (з переводом",
  "  --          рядка після — інакше коментар зʼїв би перший рядок тіла). Атрибути",
  "  --          ті самі (`create or replace` зберігає власника, ACL і SET), тож",
  "  --          червоніти мусить лише `body:`. Коментар — СВІДОМО: нормалізація",
  "  --          №19 коментарів не знімає (закоментований raise — зміна поведінки).",
  "  for v_fn in select p.oid from pg_proc p",
  "            where p.pronamespace = 'public'::regnamespace",
  `              and p.proname in (${NAMES_SQL}) loop`,
  "    v_def := pg_get_functiondef(v_fn.oid);",
  "    if (length(v_def) - length(replace(v_def, 'AS $function$', ''))) / length('AS $function$') <> 1 then",
  "      raise exception '0201-фальсифікація: у визначенні % не рівно одне AS $function$', v_fn.oid::regprocedure;",
  "    end if;",
  "    execute replace(v_def, 'AS $function$', 'AS $function$' || chr(10) || '-- falsify 0201' || chr(10));",
  "    v_n := v_n + 1;",
  "  end loop;",
  "  if v_n <> 16 then",
  "    raise exception '0201-фальсифікація: мутовано % функцій замість 16', v_n;",
  "  end if;",
  "",
  "  -- R1: клієнт УСПАДКОВУЄ чужу роль (member ∈ клієнтські) → m: і r: нової ролі.",
  "  create role rf_falsify_0201 nologin;",
  "  grant rf_falsify_0201 to authenticated;",
  "  -- R2: ТРАНЗИТИВНО — роль, яку клієнт успадковує через R1, і CREATE на схему",
  "  --     для неї. Без замикання `cr` (ревʼю с74) тут не було б жодного ключа.",
  "  create role rf_falsify_0201d nologin;",
  "  grant rf_falsify_0201d to rf_falsify_0201;",
  "  grant create on schema public to rf_falsify_0201d;",
  "  -- R3: новий LOGIN-член authenticated (roleid ∈ клієнтські).",
  "  create role rf_falsify_0201c login;",
  "  grant authenticated to rf_falsify_0201c;",
  "  -- R4: НОВА клієнтська роль — `authenticator` може нею стати. Дає `new:m:` і",
  "  --     `new:r:` (атрибути зарезервованих ролей від postgres не змінити —",
  "  --     42501 supautils), плюс автогрант CREATEROLE `… ← postgres`.",
  "  create role rf_falsify_0201b nologin;",
  "  grant rf_falsify_0201b to authenticator;",
  "  -- R5: налаштування ролі — звичайне і небезпечне (вимикає тригери-гарди).",
  "  alter role anon set search_path = public;",
  "  alter role authenticated set session_replication_role = replica;",
  "  -- R5-neg: таймаут і логування — поза `g:` свідомо; ключ authenticated мусить",
  "  --         нести ЛИШЕ session_replication_role.",
  "  alter role authenticated set statement_timeout = '9s';",
  "  alter role authenticated set log_min_duration_statement = 1000;",
  "  -- R6: ACL схем — CREATE, WITH GRANT OPTION, грантей PUBLIC, зникнення гранту.",
  "  grant create on schema public to authenticated;",
  "  grant usage on schema extensions to authenticated with grant option;",
  "  grant usage on schema storage to public;",
  "  revoke usage on schema extensions from anon;",
  "  -- R7: CREATE на базу.",
  "  execute format('grant create on database %I to authenticated', current_database());",
  "  -- R8: default ACL у схемі (зміна наявного ключа).",
  "  alter default privileges for role postgres in schema public revoke select on sequences from anon;",
  "  -- R9: ГЛОБАЛЬНИЙ default ACL (defaclnamespace = 0 → `*`), з PUBLIC у рядку.",
  "  alter default privileges for role postgres grant usage on types to anon;",
  "  -- R10: ГЛОБАЛЬНЕ ОБМЕЖЕННЯ без PUBLIC → синтетичний `<none>`.",
  "  alter default privileges for role postgres revoke execute on functions from public;",
  "",
  "  v_res := public.invariants_check(false);",
  "  select array_agg(o.value order by o.value) into v_off19",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'guard_fn_bodies';",
  "  select array_agg(o.value order by o.value) into v_off26",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'role_surface';",
  "  select array_agg(o.value order by o.value) into v_offpd",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'priv_drift';",
  "  select array_agg(w) into v_miss from (",
  "    select w from unnest(v_want19) w",
  "     where not exists (select 1 from unnest(coalesce(v_off19, '{}')) o where starts_with(o, w))",
  "    union all",
  "    select w from unnest(v_want26) w",
  "     where not exists (select 1 from unnest(coalesce(v_off26, '{}')) o where o = w)",
  "  ) m;",
  "  select array_agg(o) into v_extra from (",
  "    select o from unnest(coalesce(v_off19, '{}')) o",
  "     where not exists (select 1 from unnest(v_want19) w where starts_with(o, w))",
  "    union all",
  "    select o from unnest(coalesce(v_off26, '{}')) o",
  "     where not (o = any (v_want26))",
  "    union all",
  "    select 'priv_drift:' || o from unnest(coalesce(v_offpd, '{}')) o",
  `     where not starts_with(o, '${COLLATERAL_PREFIX}')`,
  "  ) x;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_other",
  "    from jsonb_array_elements(v_res->'failed') e",
  "   where e.value->>'check' not in ('guard_fn_bodies', 'role_surface', 'priv_drift', 'ledger_md5');",
  "",
  "  raise exception 'FALSIFY_0201_ROLLBACK verdict=% n19=% n26=% npd=% missed=% extra=% other_failed=%',",
  "    case when v_miss is null and v_extra is null and v_other is null",
  "              and coalesce(array_length(v_off19, 1), 0) = 16",
  `              and coalesce(array_length(v_off26, 1), 0) = ${WANT26.length}`,
  "              and coalesce(array_length(v_offpd, 1), 0) >= 1 then 'PASS' else 'FAIL' end,",
  "    coalesce(array_length(v_off19, 1), 0), coalesce(array_length(v_off26, 1), 0),",
  "    coalesce(array_length(v_offpd, 1), 0), v_miss, v_extra, v_other;",
  "end;",
  "$falsify$;",
  "",
  "-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився: доказ — сам сторож:",
  "--      select public.invariants_check(false);",
  `--      -- очікування: \`guard_fn_bodies\`, \`role_surface\`, \`priv_drift\` ВІДСУТНІ, checked ${NEW_CHECKED}`,
  "--      -- (до `npm run db:gate` у failed лишається лише `ledger_md5`).",
  "--      select count(*) from pg_roles where rolname like 'rf_falsify_0201%';   -- 0",
].join("\n");

// ---------------------------------------------------------------------------
// 10. ФАЙЛ МІГРАЦІЇ.
//    ⚠️ Шапка НЕ сміє містити фразу create-or-replace сторожа одним рядком:
//       `tests/privilegeSurface.test.ts` шукає її `indexOf` БЕЗ якоря. Асерт нижче.
// ---------------------------------------------------------------------------
const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0201: шістнадцять підписів у №19 guard_fn_bodies і нова",
  "--  перевірка №26 role_surface (поверхня клієнтських ролей поза прямими грантами).",
  "--",
  "--  Максимальна ЗАСТОСОВАНА на момент написання — 0200.",
  `--  Даних НЕ чіпає. \`checked\` ${PRE_CHECKED} -> ${NEW_CHECKED}. Список №19: 43 -> 59. Ключів №26: 62.`,
  "--  Єдина правка ПОЗА сторожем — паритет `referral_center_card` з файлом 0195",
  "--  (той самий код, повернуті коментарі; див. пункт 3 нижче).",
  "--",
  "--  ЗВІДКИ ПАКЕТ. Рішення власника 15.09 (`docs/audit/DECISIONS-2026-09-15-s74.md`):",
  "--   1. Р74-1(б) — пінити в №19 ВСІ definer-функції, доступні `authenticated` і",
  "--      поза списком, що несуть ВЛАСНИЙ гейт (16 із 18; дві пошукові гейта за",
  "--      роллю не мають). Вихолощений гейт у SECURITY DEFINER — тиха ескалація:",
  "--      RLS там не діє, а сторож лишався зеленим. Розбір —",
  "--      `docs/audit/PHASE3-2026-09-15-definer-pin-gap.md` і пакет розвилок",
  "--      `docs/audit/DECISIONS-PACKET-2026-09-15-s74.md`.",
  "--   2. Р74-2(б) — межі 1 і 2 аудиту 0191 (членство в ролях, `nspacl`, default",
  "--      privileges) закрити для КЛІЄНТСЬКИХ ролей. Ці каталоги не пінила жодна",
  "--      перевірка (крім №15(b) — лише TRUNCATE у default ACL схеми public). Зонди",
  "--      15.09 у відкочених транзакціях: від `postgres` ПРОХОДЯТЬ `grant <роль> to",
  "--      authenticated`, новий LOGIN-член `authenticated`, `alter role",
  "--      authenticated set session_replication_role = replica` (чи застосовує",
  "--      його PostgREST — не заміряно), CREATE на схему public і на базу,",
  "--      default ACL у схемі і глобальний. Деталі й межі — у прозі №26.",
  "--   3. Паритет `referral_center_card` (знахідка ревʼю с74): на проді її тіло",
  "--      лежало БЕЗ коментарів файла 0195 — 0195 лягла чернеткою через",
  "--      execute_sql (PR-0195 §5). Код тотожний, але №19 коментарів не знімає, і",
  "--      пін з прода червонив би `body:` на будь-якій базі, зібраній міграціями.",
  "--      Функцію перестворено ДОСЛІВНО текстом 0195; пін — md5 файла.",
  "--   Одна перепечатка на обидва рішення — одна ревізія стендів.",
  "--",
  "--  ⚠️ ЦІНА, названа заздалегідь:",
  "--     • №19 пінує ПОВНИЙ рядок — md5 тіла + `attrs` з `;acl=`. БУДЬ-ЯКА правка",
  "--       шістнадцяти функцій (тіло, `grant`, `revoke`, `alter function`, імʼя",
  "--       параметра) тепер іде в одній міграції з передруком сторожа. ⚠️ CI цього",
  "--       НЕ ловить — червоніє прод (правило 8 ритуалу №19 в AGENTS.md).",
  "--     • №26 червоніє на БУДЬ-ЯКІЙ зміні членств клієнтських ролей, ACL схем чи",
  "--       бази, default ACL, налаштувань ролі (крім таймаутів і спостережуваності)",
  "--       — у т.ч. від оновлення платформи чи розширення, ввімкненого в дашборді.",
  "--       Порядок як для №22: розібратись, передрукувати (ратчет №26 в AGENTS.md).",
  "--",
  "--  ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК. Зібрано `node scripts/build-0201-reprint.mjs` із",
  "--     0200. У КОДІ сторожа змінилось рівно два — шістнадцять рядків списку №19 і",
  "--     код №26; решта різниці — проза №2, №19, №22, №25. Базис у генераторі.",
  "--",
  "--  ⚠️ РЯДКИ ОБОХ ПІНІВ ЗНЯТІ НА ПРОДІ (крім `referral_center_card` — md5 файла",
  "--     0195). Шістнадцять рядків №19 фрагмент накату ПЕРЕД передруком проганяє",
  "--     через ТОЙ САМИЙ вираз `cur`; 62 ключі №26 звіряє сухий прогін самим",
  "--     сторожем на новому тілі. Дрейф між заміром і накатом зупиняє прогін, а не",
  "--     кладе червоного сторожа.",
  "--",
  "--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ — ні вставкою в SQL Editor, ні MCP",
  "--     `apply_migration`, ні `supabase db push`. У ньому немає ЖОДНОГО",
  "--     запобіжника (предстан тіла і самопіну 0200, живі рядки, паритет",
  "--     `referral_center_card`, черга леджера), а поза одним батчем передрук і",
  "--     самопін №25 — різні стейтменти: обрив між ними лишає нове тіло зі СТАРИМ",
  "--     піном. Шлях один — `scripts/frag/0201_apply.sql`, весь одним запитом.",
  "--",
  "--  ПОРЯДОК:",
  "--   0. Дерево чисте; `node scripts/build-0201-reprint.mjs` → `git diff",
  "--      --exit-code` (файли відповідають генератору); `npm test`,",
  "--      `npx tsc --noEmit`; повна ревізія `node scripts/falsify-all.mjs`.",
  "--      Усе це — ДО проду: червоне тут не лишає прод у половинчастому стані.",
  "--   1. `scripts/frag/0201_dryrun.sql` (запит ПОЧИНАЄТЬСЯ з тегу dryrun) →",
  `--      помилка DRYRUN_0201_ROLLBACK з checked=${NEW_CHECKED} і failed лише \`ledger_md5\`.`,
  "--   2. `scripts/frag/0201_apply.sql` — ОДРАЗУ після сухого прогону, без DDL і",
  "--      правок у дашборді між ними (жива звірка №26 є лише в сухому прогоні);",
  "--      була пауза чи будь-яка правка — повторити крок 1. Таблиця читання назад:",
  `--      guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN}, ledger_rows = 201.`,
  "--      Помилка = НІЧОГО не закомічено. Таймаут клієнта = накат НЕ повторювати",
  "--      наосліп: окремо виконати лише select читання назад із кінця фрагмента;",
  "--      якщо там стан 0200 — перевірити в `pg_stat_activity`, що першого запиту",
  "--      вже немає, і лише тоді повторити (повтор безпечний: гард леджера і",
  "--      звірка предстану зупинять подвійний накат).",
  "--      ⚠️ Відрізок «накат → db:gate» не сміє перетнути 03:50 UTC (06:50 Київ):",
  "--         крон `invariants` запише прогін із червоною `ledger_md5`.",
  `--   3. ОКРЕМИМ запитом \`select public.invariants_check(false);\` — checked ${NEW_CHECKED},`,
  "--      failed лише `ledger_md5` (це і є доказ коміту: до накату її немає).",
  "--      ⚠️ Кілька перевірок залежать від ДАНИХ і ЧАСУ (cron_*, outbox_*,",
  "--         gcal_*, ucm_orphan_markers) і можуть почервоніти не від пакета; №26",
  "--         — ще й від оновлення платформи між заміром і накатом.",
  "--   4. `scripts/frag/0201_falsify.sql` → verdict=PASS (n19=16, n26=22, npd≥1,",
  "--      other_failed порожній); після — окремим запитом `invariants_check(false)`:",
  "--      №19, №26, №15 знову зелені, і ролей `rf_falsify_0201%` немає.",
  "--   5. `npm run db:gate` (ЛИШЕ з машини власника) → повтор `invariants_check`:",
  "--      `ok:true`, `failed:[]`.",
  "--   6. git ОДНИМ заходом: гілка → dev → main → push → штамп деплою. До пушу",
  "--      в `main` кожна прод-збірка падає (рядок у леджері є, файла немає).",
  "--      Якщо кроки 5–6 не закрити в цей захід — `scripts/frag/0201_rollback.sql`",
  "--      і перевірка окремим запитом, а не «доробимо завтра».",
  "--   7. Аудит-док `docs/audit/PR-0201-gated-rpcs-role-surface.md` (протокол",
  "--      фальсифікації і читань назад) — ДО мержу: на нього посилається проза.",
  "--   8. ⚠️ ПІСЛЯ КРОКУ 5 генератор НЕ ЗАПУСКАТИ: він перезаписує файл, чий md5",
  "--      уже в леджері. Без `--force` генератор відмовиться сам, якщо зміст інший;",
  "--      з `--force` — захисту немає, дрейф зловить лише гейт збірки.",
  "-- ============================================================================",
  "",
  "-- ── Паритет referral_center_card з файлом 0195 — ДОСЛІВНО той самий текст ──",
  "--    (на проді до 0201 тіло лежало без коментарів; код тотожний, ACL,",
  "--    власник і SET при `create or replace` не змінюються).",
  RCC_STMT,
].join("\n");

const MIG_TAIL = [
  "",
  "-- ⚠️ Пін — НЕ прикраса: його читає перевірка №25 у тілі вище, і його ж звіряє",
  "--    `planGuardPin` у гейті кожної збірки.",
  `comment on function public.invariants_check(boolean) is '${PIN}';`,
  "",
  "insert into public.migration_ledger (name)",
  `values ('${DST_NAME}')`,
  "on conflict (name) do nothing;",
  "",
  "-- ============================================================================",
  "-- === ВІДКАТ ===",
  "--",
  "--  1. База: `scripts/frag/0201_rollback.sql` — тіло сторожа повертається до 0200",
  `--     (${PRE_MD5} / ${PRE_LEN}), САМОПІН повертається до 0200,`,
  "--     рядок леджера знімається. Перевіряти ОКРЕМИМ запитом після commit.",
  "--     `referral_center_card` лишається з коментарями 0195: код тотожний, а",
  "--     сторож 0200 її не пінить — відкочувати нічого.",
  "--  2. Git — ОДНИМ неподільним кроком: прибрати шістнадцять підписів з `PINNED` у",
  "--     `tests/guardFnBodiesInvariant.test.ts`, видалити",
  "--     `tests/roleSurfaceInvariant.test.ts`, повернути пін числа перевірок",
  `--     (\`node scripts/bump-checked-pins.mjs ${NEW_CHECKED} ${PRE_CHECKED}\` + \`docs/ops-cron.md\`), повернути`,
  "--     `tests/privilegeSurface.test.ts` (пін гілки (b)) і `AGENTS.md` (ратчет №26,",
  "--     число 59) І видалити цей файл. У будь-якому іншому порядку набір червоний.",
  "--  3. Разом із ним — `scripts/frag/0201_*.sql` і `scripts/build-0201-reprint.mjs`.",
  "--     Нового стенда пакет НЕ заводить (`EXPECTED_STANDS` не міняється):",
  "--     фальсифікацію зроблено разовим прогоном — протокол у",
  "--     `docs/audit/PR-0201-gated-rpcs-role-surface.md`.",
  "--  ⚠️ Між кроками 1 і 2 гейт червоний в обидва боки — закривати одним заходом.",
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
  for (const t of ["$apply$", "$dryrun$", "$back$", "$falsify$"]) {
    if (MIG.includes(t)) throw new Error(`ФАЙЛ містить тег фрагмента ${t}`);
  }
}

if (existsSync(DST_MIG)) {
  const old = readFileSync(DST_MIG, "utf8").replace(/\r/g, "");
  if (old !== MIG && !FORCE) {
    throw new Error(`${DST_MIG} уже є і його зміст ІНШИЙ. Якщо md5 файла вже в леджері — перезапис = дрейф = червона збірка. Свідомо: --force`);
  }
}
writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0201_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0201_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0201_rollback.sql", ROLLBACK + "\n");
writeFileSync("scripts/frag/0201_falsify.sql", FALSIFY + "\n");

// ⚠️ І ЗВОРОТНИЙ ХІД ПО ЗАПИСАНОМУ ФАЙЛУ (урок 0193).
{
  const back = split(DST_MIG);
  if (md5(back.body) !== NEW_MD5 || back.body.length !== NEW_LEN) {
    throw new Error(`ЗАПИСАНИЙ ФАЙЛ дає ${md5(back.body)} / ${back.body.length}, а зібрано ${NEW_MD5} / ${NEW_LEN}`);
  }
  if (back.prologue !== SRC.prologue) throw new Error("DDL сторожа у записаному файлі розʼїхався з 0200");
}

console.log("0201 зібрано.");
console.log(`  сторож:   ${PRE_MD5} / ${PRE_LEN}  ->  ${NEW_MD5} / ${NEW_LEN}`);
console.log(`  checked:  ${PRE_CHECKED} -> ${NEW_CHECKED};  список №19: ${OLD_SIGS.length} -> ${NEW_SIGS.length};  ключів №26: ${ROLE_ROWS.length}`);
console.log(`  пін:      ${PIN}`);
console.log(`  пар підстановки: ${PAIRS.length}; змістових перевірок: ${CHECKS.length}; зворотний хід -> 0200`);
console.log(`  файли: ${DST_MIG}, scripts/frag/0201_{apply,dryrun,rollback,falsify}.sql`);
