// build-0196-reprint.mjs — збирає supabase/migrations/0196_secdef_search_path_value.sql
// і scripts/frag/0196_{apply,dryrun,rollback}.sql. Канон 0185/0190…0194: тіло
// сторожа (126 КБ) у прод НЕ пересилається — його редагує сама БД підстановками,
// а результат звіряється з md5, порахованим ТУТ із файла.
//
// ЩО РОБИТЬ ПАКЕТ (розвилка Р3, рішення власника 14.09 — «пін ЗНАЧЕННЯ в №2»):
//   1. 34 SECURITY DEFINER функції переводяться на `search_path = public, pg_temp`;
//   2. перевірка №2 з «search_path Є» стає «search_path ДОРІВНЮЄ канону», і
//      називає порушника ПОВНИМ підписом, а не голим proname;
//   3. політика `audit_read_ceo` звужується за `table_name`;
//   4. у списку №19 оновлюються 9 рядків `;cfg=` і в №16 — дайджест політики.
//
// ⚠️ ЧОМУ САМЕ `public, pg_temp`, А НЕ `""` І НЕ `public`. ЗАМІРЯНО на проді,
//    у відкоченій транзакції, тимчасовою таблицею `cities` поверх справжньої:
//      real=[Андріївка]
//      weak(public)=[ПІДМІНА-TEMP]        <- тимчасова виграє
//      empty("")=[ПІДМІНА-TEMP]           <- тимчасова виграє
//      strong(public,pg_temp)=[Андріївка] <- справжня виграє
//      (pg_catalog,pg_temp)=[ПІДМІНА-TEMP] <- теж програє
//      (pg_temp,public)=[ПІДМІНА-TEMP]     <- теж програє
//    Тобто захищає НЕ «наявність pg_temp у списку», а те, що СПРАВЖНЯ схема
//    стоїть ПЕРЕД pg_temp. Рецепт Supabase `search_path = ''` від підміни
//    таблиць не боронить узагалі — він лише ЗМУШУЄ все кваліфікувати.
//
// ⚠️ ЖИВОЇ ДІРИ НЕМАЄ, і це заміряно з ЗЕЛЕНОЮ БАЗОЮ: механічний пошук
//    неквалiфікованих посилань на таблиці по ВСІХ 115 тілах дав НУЛЬ, а сам
//    пошук перевірено — `from profiles` ловиться, `from public.profiles` ні,
//    `update queue_entries` ловиться (34 відношення в public). Плюс через
//    PostgREST клієнт не може виконати `CREATE TEMP TABLE`. Але властивість
//    «усе квалiфіковано» не тримає НІЩО: ні тест, ні перевірка. Пакет робить
//    її структурною, а не ритуальною.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

const SRC_MIG = "supabase/migrations/0194_gcal_blind_disable.sql";
const DST_MIG = "supabase/migrations/0196_secdef_search_path_value.sql";
const PRE_MD5 = "af390d6f00d8ef711a85e8f54e0f987b";
const PRE_LEN = 126449;

const OPEN = "\nas $function$";
const CLOSE = "\n$function$;";

function split(file) {
  const txt = readFileSync(file, "utf8").replace(/\r/g, "");
  const a = txt.indexOf(OPEN);
  const b = txt.indexOf(CLOSE, a);
  if (a < 0 || b < 0) throw new Error(`${file}: не знайдено межі тіла`);
  if (txt.indexOf(OPEN, a + 1) >= 0) throw new Error(`${file}: \`as $function$\` не один`);
  if (txt.indexOf(CLOSE, b + 1) >= 0) throw new Error(`${file}: \`$function$;\` не один`);
  const ddl0 = txt.indexOf("create or replace function public.invariants_check");
  if (ddl0 < 0) throw new Error(`${file}: не знайдено DDL сторожа`);
  return {
    head: txt.slice(0, ddl0),
    prologue: txt.slice(ddl0, a + OPEN.length),
    body: txt.slice(a + OPEN.length, b + 1),
    tail: txt.slice(b + CLOSE.length),
  };
}

const S94 = split(SRC_MIG);
if (md5(S94.body) !== PRE_MD5 || S94.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0194 дав ${md5(S94.body)} / ${S94.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}

// ---------------------------------------------------------------------------
// ПАРА 1 — ПРЕДИКАТ №2. Було «search_path Є», стало «search_path ДОРІВНЮЄ».
// ⚠️ І порушник називає себе ПОВНИМ підписом: `proname` на перевантаженні не
//    сказав би, ЯКА саме функція винна. У public перевантажень сьогодні нуль
//    (заміряно; зелена база — той самий запит без фільтра схеми знаходить
//    pg_catalog.min з 22 підписами), але пін не має тримати на цьому.
// ---------------------------------------------------------------------------
const SQL_FROM =
  "  select array_agg(pr.proname order by pr.proname) into v_tmp\n"
  + "    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace\n"
  + "   where n.nspname = 'public' and pr.prosecdef\n"
  + "     and (pr.proconfig is null or pr.proconfig::text not like '%search_path%');\n";

const SQL_TO =
  "  select array_agg(pr.oid::regprocedure::text order by pr.oid::regprocedure::text)\n"
  + "    into v_tmp\n"
  + "    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace\n"
  + "   where n.nspname = 'public' and pr.prosecdef\n"
  + "     and array_to_string(array(select cfg from unnest(pr.proconfig) cfg\n"
  + "                                where cfg like 'search_path=%' order by 1), '|')\n"
  + "         is distinct from 'search_path=public, pg_temp';\n";

// ---------------------------------------------------------------------------
// ПАРА 2 — ПРОЗА №2. Називає ЗАМІР, а не намір.
// ---------------------------------------------------------------------------
const PROSE_FROM =
  "  -- 2. search_path прибитий у КОЖНОЇ security definer функції: інакше виклик\n"
  + "  --    із підміненим search_path веде функцію до чужих таблиць.\n";

const PROSE_TO =
  "  -- 2. search_path у КОЖНОЇ security definer функції дорівнює КАНОНУ\n"
  + "  --    `public, pg_temp`. До 0196 тут перевірялась лише НАЯВНІСТЬ рядка\n"
  + "  --    `search_path`, тож `alter function … set search_path = pg_temp, public`\n"
  + "  --    проходив повз усі 23 перевірки (замір с67 — розвилка Р3).\n"
  + "  --\n"
  + "  --    ⚠️ ЧОМУ РІВНІСТЬ, А НЕ «чи є pg_temp у списку». ЗАМІРЯНО 14.09 на\n"
  + "  --       проді, у відкоченій транзакції, тимчасовою таблицею `cities`\n"
  + "  --       поверх справжньої:\n"
  + "  --         real=[Андріївка]\n"
  + "  --         search_path=public            -> ПІДМІНА-TEMP\n"
  + "  --         search_path=\"\"                -> ПІДМІНА-TEMP\n"
  + "  --         search_path=pg_catalog,pg_temp-> ПІДМІНА-TEMP\n"
  + "  --         search_path=pg_temp,public    -> ПІДМІНА-TEMP\n"
  + "  --         search_path=public, pg_temp   -> Андріївка\n"
  + "  --       Postgres шукає ВІДНОШЕННЯ в тимчасовій схемі ПЕРШОЮ, якщо\n"
  + "  --       `pg_temp` не виписаний у шляху явно. Отже боронить не згадка\n"
  + "  --       `pg_temp`, а те, що СПРАВЖНЯ схема стоїть ПЕРЕД нею. Рецепт\n"
  + "  --       `search_path = ''` від підміни таблиць НЕ боронить — він лише\n"
  + "  --       змушує все кваліфікувати, і ця властивість не була запінена\n"
  + "  --       нічим.\n"
  + "  --\n"
  + "  --    ⚠️ ДО 0196 у проді було 34 функції зі слабкою формою (28 із\n"
  + "  --       `public`, 6 із `\"\"`), з них 12 кликав `authenticated`, 6 —\n"
  + "  --       `anon`. Живої діри не було: механічний пошук неквалiфікованих\n"
  + "  --       посилань по всіх 115 тілах дав НУЛЬ (зелена база на самому\n"
  + "  --       пошуку: `from profiles` ловиться, `from public.profiles` ні).\n"
  + "  --       0196 робить цю властивість структурною.\n"
  + "  --\n"
  + "  --    ЧОТИРИ МЕЖІ, НАЗВАНІ НАВМИСНО (усі знайдені ревʼю до накату):\n"
  + "  --      1. Перевірка читає `proconfig`, а не тіло. Функція з каноном у\n"
  + "  --         `proconfig` може перекинути шлях ЗСЕРЕДИНИ —\n"
  + "  --         `perform set_config('search_path', 'pg_temp, public', true)` —\n"
  + "  --         і №2 лишиться зеленою. Для 36 функцій це ловить пін ТІЛА в\n"
  + "  --         №19; для решти 79 не ловить ніщо.\n"
  + "  --      2. Фільтр `nspname = 'public'`. SECURITY DEFINER в іншій схемі\n"
  + "  --         невидимий №2 узагалі. Сьогодні таких три, усі чужі\n"
  + "  --         (`pgbouncer.get_auth`, `vault.create_secret`,\n"
  + "  --         `vault.update_secret`), клієнтським ролям недоступні.\n"
  + "  --      3. Стиль посилань у тілі: після 0196 неквалiфіковане посилання\n"
  + "  --         безпечне ЗА ПОБУДОВОЮ шляху, але сам стиль не пасе ніхто.\n"
  + "  --      4. ШІСТЬ функцій ішли з `search_path = \"\"` і на цьому переході\n"
  + "  --         ВТРАЧАЮТЬ те єдине, що порожній шлях справді давав: примус\n"
  + "  --         кваліфікувати ФУНКЦІЇ та ОПЕРАТОРИ. Тепер `public` — кандидат,\n"
  + "  --         а правило перевантажень «точний збіг типів» порядок шляху\n"
  + "  --         ігнорує. Сьогодні це закрито тим, що `CREATE` на схему\n"
  + "  --         `public` є ЛИШЕ у `postgres` (заміряно: anon, authenticated,\n"
  + "  --         service_role — false), і жодна з 23 перевірок цю привілею НЕ\n"
  + "  --         пасе. Для ВІДНОШЕНЬ і ТИПІВ перехід навпаки звужує: `pg_temp`\n"
  + "  --         їде з неявного першого місця на явне останнє.\n"
  + "  --    ⚠️ Дубль `search_path` у `proconfig` дав би скалярному підзапиту\n"
  + "  --       21000 і БЕЗІМЕННОГО порушника `raised:…`; тому тут\n"
  + "  --       `array_to_string(array(... order by 1), '|')` — дубль стає\n"
  + "  --       значенням, що не дорівнює канону, і порушник називає СЕБЕ.\n";

// ---------------------------------------------------------------------------
// ПАРА 3 — 9 рядків `;cfg=` у списку №19. ЗАМІНА ОДНОРІДНА, тому очікуваних
// влучань не одне, а ДЕВʼЯТЬ, і це записано числом, а не «усі».
// Арифметика знята з прода: `;cfg=search_path=public;acl=` — 9,
// `;cfg=search_path=public, pg_temp;acl=` — 31, разом 40 = увесь список.
// ⚠️ Пін ГЕНЕРУЄТЬСЯ, а не переписується рукою: правило с69 «пін, який людина
//    мусить передруковувати, протухає за побудовою».
// ---------------------------------------------------------------------------
const CFG_FROM = ";cfg=search_path=public;acl=";
const CFG_TO = ";cfg=search_path=public, pg_temp;acl=";

// ---------------------------------------------------------------------------
// ПАРА 4 — дайджест політики `audit_read_ceo` у списку №16.
// ⚠️ ЯКІР МУСИТЬ НЕСТИ МІСЦЕ, А НЕ ЛИШЕ ЗНАЧЕННЯ: `imp_events_read_ceo` має
//    ТОЧНО ТОЙ САМИЙ дайджест `1303b9136217` (вирази збігаються — заміряно),
//    тож заміна по одному дайджесту зачепила б ДВІ політики замість однієї.
// Новий дайджест ЗГЕНЕРОВАНО зондом на проді, і рецепт має зелену базу:
// той самий вираз відтворив старе значення `1303b9136217` байт у байт.
// ---------------------------------------------------------------------------
const DIG_FROM = "('audit_log','audit_read_ceo','1303b9136217')";
const DIG_TO = "('audit_log','audit_read_ceo','3e5b95410350')";

// ⚠️ ВИПРАВЛЕНО ПІСЛЯ РЕВʼЮ (до накату). Перша редакція робила ОДНОРІДНУ
//    заміну `;cfg=search_path=public;acl=` з очікуванням 9 влучань. Уперед це
//    працює, а НАЗАД — ні: у новому тілі зворотний якір
//    `;cfg=search_path=public, pg_temp;acl=` трапляється 40 разів (9 щойно
//    переведених + 31 споконвіку канонічний), тож відкат падав би на
//    перевірці якоря, а підняти число до 40 означало б збрехати про 31
//    функцію, яка слабкою ніколи не була. Тобто міграція була в один бік.
//    Лікування — те саме, що вже застосоване до дайджесту: ЯКІР НЕСЕ МІСЦЕ.
//    Кожен рядок береться ЦІЛКОМ, разом із власним підписом і власним md5
//    тіла, тому унікальний в обидва боки. Рядки ВИТЯГУЮТЬСЯ з тіла, а не
//    переписуються рукою.
const ROW_RE = /\('([a-zA-Z_0-9]+\([^)]*\))','([0-9a-f]{32})','([^']*;cfg=search_path=public;acl=[^']*)'\)/g;
const CFG_PAIRS = [];
for (const m of S94.body.matchAll(ROW_RE)) {
  const row = m[0];
  if (row.split(CFG_FROM).length - 1 !== 1) {
    throw new Error(`рядок ${m[1]}: ${CFG_FROM} трапляється не один раз`);
  }
  CFG_PAIRS.push([row, row.replace(CFG_FROM, CFG_TO), `№19 рядок ${m[1]}`, 1]);
}
if (CFG_PAIRS.length !== 9) {
  throw new Error(`список №19: витягнуто ${CFG_PAIRS.length} слабких рядків, а заміряно 9`);
}

const PAIRS = [
  [SQL_FROM, SQL_TO, "предикат №2: рівність значення + підпис у offender", 1],
  [PROSE_FROM, PROSE_TO, "проза №2: замір пʼяти форм search_path + чотири межі", 1],
  ...CFG_PAIRS,
  [DIG_FROM, DIG_TO, "список №16: дайджест audit_read_ceo", 1],
];

// Виконавчий порядок — АСЕРТОМ (урок 0193): жодна `to` не має нести чужу `from`.
for (let i = 0; i < PAIRS.length; i++) {
  for (let j = 0; j < PAIRS.length; j++) {
    if (i === j) continue;
    if (PAIRS[i][1].includes(PAIRS[j][0])) {
      throw new Error(`ПОРЯДОК: «${PAIRS[i][2]}».to несе «${PAIRS[j][2]}».from`);
    }
  }
}

let NEW_BODY = S94.body;
for (const [from, to, lbl, want] of PAIRS) {
  const hits = NEW_BODY.split(from).length - 1;
  if (hits !== want) throw new Error(`ЯКІР «${lbl}»: ${hits} влучань у тілі 0194, а треба ${want}`);
  NEW_BODY = NEW_BODY.split(from).join(to);
}
const NEW_MD5 = md5(NEW_BODY);
const NEW_LEN = NEW_BODY.length;
if (NEW_MD5 === PRE_MD5) throw new Error("тіло не змінилось");

// ⚠️ БАЗИСИ НА ЗМІСТ, а не лише на md5.
const count = (s, sub) => s.split(sub).length - 1;
const CHECKS = [
  ["checked НЕ мінявся", count(NEW_BODY, "v_n := v_n + 1;"), 23],
  ["слабких ;cfg= не лишилось", count(NEW_BODY, CFG_FROM), 0],
  ["сильних ;cfg= рівно 40", count(NEW_BODY, CFG_TO), 40],
  ["новий дайджест політики один", count(NEW_BODY, "3e5b95410350"), 1],
  // ⚠️ Дайджест `1303b9136217` ділять ПʼЯТЬ політик — усі з виразом
  //    `clinic_id IN (SELECT auth_ceo_clinics())`: audit_read_ceo,
  //    imp_events_read_ceo, queue_ceo_read, rooms_ceo_read, waitlist_ceo_read.
  //    Заміна по голому значенню зачепила б усі пʼять — саме тому якір несе
  //    МІСЦЕ (таблиця+політика). Після заміни одного рядка лишається 4.
  //    Перша редакція цього файла чекала 1 і впала тут — число було ВГАДАНЕ.
  ["старий дайджест лишився у 4 інших політик", count(NEW_BODY, "1303b9136217"), 4],
  ["новий предикат №2 на місці", count(NEW_BODY, "is distinct from 'search_path=public, pg_temp'"), 1],
  ["старий предикат №2 зник", count(NEW_BODY, "not like '%search_path%'"), 0],
  ["offender №2 — підпис", count(NEW_BODY, "pr.oid::regprocedure::text"), 2],
  ["audit_read_ceo згаданий один раз", count(NEW_BODY, "audit_read_ceo"), 1],
];
for (const [lbl, got, want] of CHECKS) {
  if (got !== want) throw new Error(`ЗМІСТ: «${lbl}» — ${got}, а треба ${want}`);
}

// ---------------------------------------------------------------------------
// ⚠️ БАЗИС ЗВОРОТНОГО ХОДУ — саме його бракувало першій редакції, і саме тому
//    вона випустила блокер: дев'ять змістових перевірок дивились УПЕРЕД і
//    жодна — НАЗАД. Прикладаємо зворотні пари до нового тіла і вимагаємо тіло
//    0194 байт у байт. Поки цього немає, «відкат» — текст, а не шлях.
//    Побічний виграш: число влучань для відкату тепер ЗАМІРЯНЕ, а не
//    скопійоване з накату.
// ---------------------------------------------------------------------------
const rWant = [];
{
  let back = NEW_BODY;
  for (let i = PAIRS.length - 1; i >= 0; i--) {
    const [from, to, lbl] = PAIRS[i];
    const hits = back.split(to).length - 1;
    if (hits !== 1) {
      throw new Error(`ЗВОРОТНИЙ ЯКІР «${lbl}»: ${hits} влучань у новому тілі, а треба рівно 1`);
    }
    rWant[i] = hits;
    back = back.split(to).join(from);
  }
  if (md5(back) !== PRE_MD5 || back.length !== PRE_LEN) {
    throw new Error(`ЗВОРОТНИЙ ХІД дав ${md5(back)} / ${back.length}, а 0194 це ${PRE_MD5} / ${PRE_LEN}`);
  }
}

// ---------------------------------------------------------------------------
// ⚠️ ЯКОРІ СТЕНДІВ — МЕХАНІЧНО, А НЕ ПРОЗОЮ. Урок с70, і він коштував
//    пʼятдесятихвилинної ревізії.
//    Пакети 0193 і 0194 несли в шапці рядок «ПЕРЕВІРЕНО І ЧИСТО: сім
//    повнорядкових якорів у стендах цілять у список №19, якого цей пакет НЕ
//    ЧІПАЄ» — тобто перевірку робила ЛЮДИНА і записувала висновок словами.
//    Для 0193/0194 це було правдою (вони №19 не чіпали). 0196 чіпає девʼять
//    його рядків, автор ту саму перевірку НЕ зробив — і два протухлі якорі
//    (`falsify-0181` B1 і B3) знайшла повна ревізія: 39/40, один червоний.
//    Стенд при цьому спрацював як задуманий: «ЯКІР НЕ УНІКАЛЬНИЙ (0)» —
//    ГОЛОСНО, а не тихим зеленінням.
//    Тепер це робить машина: жоден стенд не має містити ДОМІГРАЦІЙНИЙ текст
//    рядка, який пакет міняє. Якщо містить — його треба переякорити НА `to`,
//    і збірка про це скаже до накату, а не через 50 хвилин.
{
  const standDir = "scripts";
  const stands = readdirSync(standDir).filter((f) => /^falsify-.*\.mjs$/.test(f));
  if (stands.length < 30) {
    throw new Error(`ЯКОРІ: знайдено лише ${stands.length} стендів — очікувалось ≥30, перевірка була б вакуумною`);
  }
  const stale = [];
  for (const f of stands) {
    const txt = readFileSync(`${standDir}/${f}`, "utf8").replace(/\r/g, "");
    for (const [from, , lbl] of PAIRS) {
      // Цікавлять лише ПОВНОРЯДКОВІ якорі списку — короткі префікси (як у B2)
      // передрук переживають, і чіпати їх не треба.
      if (from.length > 60 && txt.includes(from)) stale.push(`${f} <- «${lbl}»`);
    }
  }
  if (stale.length) {
    throw new Error(
      "ЯКОРІ СТЕНДІВ ПРОТУХНУТЬ ПІСЛЯ НАКАТУ — переякорити на `to` ДО прогону:\n  "
      + stale.join("\n  ")
      + "\n(це та сама причина, через яку с70 отримав 39/40 і червоний falsify-0181)",
    );
  }
  console.log(`  якорі стендів: ${stands.length} файлів перевірено, протухлих 0`);
}

// ---------------------------------------------------------------------------
// 34 функції, які пакет переводить на канон. Список ЗНЯТИЙ ЗАПИТОМ із прода
// 14.09 і зафіксований тут поіменно: якщо в проді їх виявиться інше число,
// накат ЗУПИНИТЬСЯ (асерт у фрагменті), а не тихо зробить «скільки є».
// ⚠️ Підписи — `pg_get_function_identity_arguments`, тобто рівно те, що
//    розуміє `alter function`.
// ---------------------------------------------------------------------------
const WEAK = [
  "audit_log_retention(p_pii_days integer, p_meta_days integer, p_limit integer)",
  "audit_log_retention_daily()",
  "auth_can_refer(c uuid)",
  "auth_ceo_clinics()",
  "auth_clinic_id()",
  "auth_is_ceo_of(c uuid)",
  "auth_is_referrer()",
  "auth_referrer_clinics()",
  "ceo_list_for_clinic(p_clinic uuid)",
  "check_case_distinct_room()",
  "check_case_no_time_overlap()",
  "check_service_room_override()",
  "clinic_deletion_execute(p_request uuid, p_token text)",
  "delete_clinic_member(target uuid)",
  "event_outbox_retention(p_delivered_days integer, p_pii_days integer, p_dead_days integer, p_limit integer)",
  "fn_audit()",
  "gcal_connection_secret_cleanup()",
  "gcal_secret_delete(p_id uuid)",
  "gcal_secret_get(p_id uuid)",
  "gcal_secret_store(p_secret text, p_description text)",
  "gcal_secret_update(p_id uuid, p_secret text)",
  "guard_call_status_change()",
  "guard_priority_change()",
  "guard_referrer_doctor()",
  "guard_status_change_referrer()",
  "guard_waitlist_room()",
  "mark_changes_seen(p_ids uuid[])",
  "outbox_retention_daily()",
  "rl_check(p_key text, p_max integer, p_window_seconds integer)",
  "search_cities(q text)",
  "search_clinics(q text)",
  "search_referrers(q text)",
  "sink_overdue_scheduled()",
  "sink_overdue_scheduled_all()",
];
if (WEAK.length !== 34) throw new Error(`WEAK: ${WEAK.length} підписів, а заміряно 34`);

// ── SQL-літерал із подвоєнням лапок (дольські лапки тут небезпечні: у прозі є
//    і `$`, і довільні символи) ────────────────────────────────────────────────
const q = (s) => "'" + s.replace(/'/g, "''") + "'";
const arr = (xs) => xs.map(q).join(",\n    ");

const fromArr = arr(PAIRS.map((p) => p[0]));
const toArr = arr(PAIRS.map((p) => p[1]));
const lblArr = arr(PAIRS.map((p) => p[2]));
const wantArr = PAIRS.map((p) => p[3]).join(", ");
const weakArr = arr(WEAK);

// Зворотні пари для відкату — ті самі, дзеркально.
const rFromArr = arr(PAIRS.map((p) => p[1]));
const rToArr = arr(PAIRS.map((p) => p[0]));

const BODY_CORE = `
declare
  v_def   text;
  v_body  text;
  v_src   text;
  v_head  text;
  v_new   text;
  v_i     int;
  v_hits  int;
  v_n     int;
  v_res   jsonb;
  v_dig   text;
  v_sig   text;
  v_from  constant text[] := array[
    ${fromArr}
  ];
  v_to    constant text[] := array[
    ${toArr}
  ];
  v_lbl   constant text[] := array[
    ${lblArr}
  ];
  v_want  constant int[] := array[${wantArr}];
  v_weak  constant text[] := array[
    ${weakArr}
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- ⚠️ search_path сесії ФІКСУЄМО (знахідка ревʼю до накату): дайджест №16
  --    рахується через \`pg_get_expr\`, а той квалiфікує імена за видимістю в
  --    ПОТОЧНОМУ шляху. Заміряно: під \`pg_catalog\` той самий вираз дає
  --    \`73ff677d6a26\` замість \`1303b9136217\`. Без цього рядка накат міг би
  --    впасти хибно-червоним на чужому налаштуванні ролі.
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0196: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0195_referral_card_scope.sql') then
    raise exception '0196: попередника 0195 у леджері немає';
  end if;
  if exists (select 1 from public.migration_ledger where name = '0196_secdef_search_path_value.sql') then
    raise exception '0196: уже накочено';
  end if;
  if (select count(*) from public.migration_ledger) <> 195 then
    raise exception '0196: у леджері % рядків замість 195', (select count(*) from public.migration_ledger);
  end if;
`;

const BODY_ALTERS = `
  -- ── 1. Стан ДО: рівно 34 слабкі функції, і рівно ті, що названі ──────────
  select count(*) into v_n
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and array_to_string(array(select cfg from unnest(pr.proconfig) cfg
                                where cfg like 'search_path=%' order by 1), '|')
         is distinct from 'search_path=public, pg_temp';
  if v_n <> 34 then
    raise exception '0196: у проді % слабких функцій замість 34 — стан не той, що заміряно', v_n;
  end if;
  foreach v_sig in array v_weak loop
    if not exists (
      select 1 from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
       where n.nspname = 'public' and pr.prosecdef
         and pr.proname || '(' || pg_get_function_identity_arguments(pr.oid) || ')' = v_sig
    ) then
      raise exception '0196: названої функції % у проді немає або вона не definer', v_sig;
    end if;
  end loop;

  -- ── 2. Переводимо всі 34 на канон ────────────────────────────────────────
  foreach v_sig in array v_weak loop
    execute format('alter function public.%s set search_path = public, pg_temp', v_sig);
  end loop;

  select count(*) into v_n
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and array_to_string(array(select cfg from unnest(pr.proconfig) cfg
                                where cfg like 'search_path=%' order by 1), '|')
         is distinct from 'search_path=public, pg_temp';
  if v_n <> 0 then
    raise exception '0196: після alter лишилось % слабких функцій', v_n;
  end if;

`;

// ---------------------------------------------------------------------------
// ⚠️ ПОЛІТИКА ЙДЕ ОСТАННЬОЮ — ЗНАХІДКА ДРУГОГО РЕВʼЮ, ЗАМІРЯНА ОСОБИСТО.
//    `alter policy` бере на таблицю **AccessExclusiveLock** і тримає його до
//    commit. У першій редакції він стояв ПЕРЕД передруком сторожа і перед
//    `invariants_check`, тобто замок висів увесь цей час. Замір:
//      alter_policy_locks=[AccessExclusiveLock] | invariants_check=9065 ms
//    А `fn_audit()` висить тригером на ШЕСТИ таблицях (`queue_entries`,
//    `waitlist_entries`, `profiles`, `incidents`, `referral_access`,
//    `ceo_access`), тож на цей час ставав би ВЕСЬ запис продукту. У ролі
//    `authenticated` `statement_timeout = 8s` — тобто запис користувача не
//    чекав би, а ПАДАВ.
//    Тепер порядок: 34 alter -> передрук сторожа -> політика -> леджер ->
//    commit, а `invariants_check` виконується ОКРЕМИМ запитом після commit.
//    Вікно замка стискається з ~9 с до одиниць мілісекунд.
// ---------------------------------------------------------------------------
const BODY_POLICY = `
  -- ── 5. Політика audit_read_ceo: журнал звужується до таблиць, які CEO
  --      читає й напряму. ⚠️ Замір 14.09 спростував посилку п.1 рішення Р69-2
  --      («журнал віддає рівно те, що видно прямо»): CEO бачив через журнал
  --      queue_entries 433 проти 297 прямо, incidents 11 проти 0,
  --      referral_access 3 проти 0, profiles 3 проти 1. Сам ВИСНОВОК Р69-2
  --      (CEO бачить PII пацієнтів) не переглядається.
  execute $pol$
    alter policy audit_read_ceo on public.audit_log
      using ((clinic_id in (select public.auth_ceo_clinics()))
             and table_name in ('queue_entries', 'waitlist_entries', 'ceo_access'))
  $pol$;

  select substr(md5(coalesce(p.cmd,'') || '|' || coalesce(p.permissive,'') || '|'
           || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
           || coalesce(regexp_replace(p.qual, '\\s+', ' ', 'g'), '') || '|'
           || coalesce(regexp_replace(p.with_check, '\\s+', ' ', 'g'), '')), 1, 12)
    into v_dig
    from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'audit_log'
     and p.policyname = 'audit_read_ceo';
  if v_dig is distinct from '3e5b95410350' then
    raise exception '0196: дайджест політики став %, а сторож чекає 3e5b95410350', v_dig;
  end if;
`;

const BODY_GUARD = `
  -- ── 3. Передрук сторожа підстановками ────────────────────────────────────
  --      Тіло (${PRE_LEN} Б -> ${NEW_LEN} Б) у прод НЕ шлемо: БД редагує своє
  --      власне, а md5 звіряється з порахованим із файла міграції.
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0196: invariants_check(p_write boolean) не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '${PRE_MD5}' then
    raise exception '0196: у проді не 0194 (%) — передрук наосліп заборонено', md5(v_src);
  end if;
  if length(v_src) <> ${PRE_LEN} then
    raise exception '0196: довжина тіла % замість ${PRE_LEN}', length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if v_def is distinct from v_head || v_body || '$function$' || chr(10) then
    raise exception '0196: склейка не відтворює functiondef';
  end if;

  v_new := v_src;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> v_want[v_i] then
      raise exception '0196: якір «%» трапляється % раз(ів), а треба %',
        v_lbl[v_i], v_hits, v_want[v_i];
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  if md5(v_new) is distinct from '${NEW_MD5}' or length(v_new) <> ${NEW_LEN} then
    raise exception '0196: підстановки дали % / %, а файл каже ${NEW_MD5} / ${NEW_LEN}',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  -- ── 4. ЗАПИТОМ, а не «успішно» ───────────────────────────────────────────
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from '${NEW_MD5}' then
    raise exception '0196: у БД лягло % замість ${NEW_MD5}', md5(v_src);
  end if;

`;

// ⚠️ \`invariants_check\` СВІДОМО ВИНЕСЕНО З ТРАНЗАКЦІЇ (знахідка ревʼю 2).
//    Заміряно: один його виклик — 9065 мс. Тримати під ним AccessExclusiveLock
//    на \`audit_log\` означало б покласти запис у шість таблиць на дев'ять
//    секунд при \`statement_timeout = 8s\` у \`authenticated\`. Перевірка робиться
//    ОКРЕМИМ запитом після commit — і це не послаблення: у транзакції лишились
//    звірки md5 тіла, довжини та дайджесту політики, тобто все, що доводить
//    саме цей пакет.
const BODY_TAIL = `
  -- ── 6. Рядок леджера — УСЕРЕДИНІ блоку, щоб БД і леджер не розʼїхались,
  --      якщо файл виконають не цілком (знахідка ревʼю 2).
  insert into public.migration_ledger(name) values ('0196_secdef_search_path_value.sql');

  raise notice 'APPLY_OK 0196: guard % len % | policy % | weak 34->0',
    md5(v_new), length(v_new), v_dig;
end;
`;

const DRY_TAIL = `
  insert into public.migration_ledger(name) values ('0196_secdef_search_path_value.sql');
  raise exception 'DRYRUN_0196_ROLLBACK guard % len % policy %', md5(v_new), length(v_new), v_dig;
end;
`;

// ⚠️ ПОРЯДОК: alters -> ПЕРЕДРУК -> ПОЛІТИКА -> леджер -> commit.
//    Найважчий замок (AccessExclusiveLock на audit_log) береться ОСТАННІМ і
//    живе одиниці мілісекунд, а не 9 секунд.
const APPLY = `-- НЕ РЕДАГУВАТИ РУКАМИ. Згенеровано scripts/build-0196-reprint.mjs.
-- Накат 0196. Від ролі postgres. Тіло сторожа НЕ пересилається — БД редагує
-- своє власне підстановками, md5 пораховано з файла міграції.
--
-- ⚠️ ВИКОНУВАТИ ЦІЛКОМ, ОДНИМ ЗАПИТОМ. Рядок леджера лежить УСЕРЕДИНІ блоку
--    саме тому, що частковий прогін розвів би БД і леджер.
--
-- ⚠️ ПІСЛЯ COMMIT — ОКРЕМИМ ЗАПИТОМ (у транзакцію він не входить навмисно:
--    заміряно 9065 мс, а під ним висів би замок на audit_log):
--      select public.invariants_check(false);
--      -- очікування: checked 23; ok:false з ЄДИНИМ порушником ledger_md5
--      --             (md5 ФАЙЛА реєструє \`npm run db:gate\`).
do $apply$${BODY_CORE}${BODY_ALTERS}${BODY_GUARD}${BODY_POLICY}${BODY_TAIL}$apply$;
`;

const DRYRUN = `-- НЕ РЕДАГУВАТИ РУКАМИ. Згенеровано scripts/build-0196-reprint.mjs.
-- СУХИЙ прогін 0196: усе те саме, що накат, але з \`raise exception\` у кінці —
-- транзакція відкочується.
-- ⚠️ КРИТЕРІЙ ПРОХОДУ — текст помилки \`DRYRUN_0196_ROLLBACK\`, а НЕ «успішно».
--    Побачили будь-яке \`0196: …\` — не пройшли, і текст називає який саме асерт.
-- ⚠️ І ГОЛОВНЕ, ЧОГО КОШТУВАВ ПАКЕТ 0195: сухий прогін БЕЗ цього маркера —
--    це НАКАТ. Батч транзакційний (заміряно), тож відкат дає рівно ця помилка.
-- ⚠️ СУХИЙ ПРОГІН НЕ БЕЗКОШТОВНИЙ, і це заміряно: \`alter policy\` бере
--    AccessExclusiveLock на \`audit_log\`. Тут він стоїть ПЕРЕДОСТАННІМ, як і в
--    накаті, тож вікно — одиниці мілісекунд; але це все одно запис у шість
--    аудитованих таблиць. Гнати в те саме вікно, що й накат.
do $dry$${BODY_CORE}${BODY_ALTERS}${BODY_GUARD}${BODY_POLICY}${DRY_TAIL}$dry$;
`;
if (!DRYRUN.includes("DRYRUN_0196_ROLLBACK")) {
  throw new Error("DRYRUN зібрано без маркера відкату — це був би накат");
}
if (DRYRUN.includes("APPLY_OK")) {
  throw new Error("DRYRUN лишив APPLY_OK — підстановка кінцівки не спрацювала");
}

// Відкат мусить повернути КОЖНІЙ функції ЇЇ власне значення, а не одне спільне:
// у 28 було `public`, у 6 (секретних + mark_changes_seen) — `""`.
const WEAK_EMPTY = [
  "gcal_connection_secret_cleanup()",
  "gcal_secret_delete(p_id uuid)",
  "gcal_secret_get(p_id uuid)",
  "gcal_secret_store(p_secret text, p_description text)",
  "gcal_secret_update(p_id uuid, p_secret text)",
  "mark_changes_seen(p_ids uuid[])",
];
const WEAK_PUBLIC = WEAK.filter((s) => !WEAK_EMPTY.includes(s));
if (WEAK_EMPTY.length !== 6 || WEAK_PUBLIC.length !== 28) {
  throw new Error(`відкат: ${WEAK_PUBLIC.length} + ${WEAK_EMPTY.length}, а заміряно 28 + 6`);
}

const ROLLBACK = `-- НЕ РЕДАГУВАТИ РУКАМИ. Згенеровано scripts/build-0196-reprint.mjs.
-- ВІДКАТ 0196.
do $back$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_i int; v_hits int; v_res jsonb; v_sig text;
  v_from constant text[] := array[
    ${rFromArr}
  ];
  v_to   constant text[] := array[
    ${rToArr}
  ];
  v_lbl  constant text[] := array[
    ${lblArr}
  ];
  v_want constant int[] := array[${rWant.join(", ")}];
  v_pub  constant text[] := array[
    ${arr(WEAK_PUBLIC)}
  ];
  v_emp  constant text[] := array[
    ${arr(WEAK_EMPTY)}
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Той самий фікс шляху, що й у накаті: інакше звірка дайджесту політики
  -- залежала б від налаштування ролі оператора.
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0196-відкат: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0196_secdef_search_path_value.sql') then
    raise exception '0196-відкат: рядка 0196 у леджері немає — відкочувати нічого';
  end if;

  foreach v_sig in array v_pub loop
    execute format('alter function public.%s set search_path = public', v_sig);
  end loop;
  foreach v_sig in array v_emp loop
    execute format('alter function public.%s set search_path = ''''', v_sig);
  end loop;

  execute $pol$
    alter policy audit_read_ceo on public.audit_log
      using (clinic_id in (select public.auth_ceo_clinics()))
  $pol$;
`;

const ROLLBACK_TAIL_SQL = `
  if (select substr(md5(coalesce(p.cmd,'') || '|' || coalesce(p.permissive,'') || '|'
        || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
        || coalesce(regexp_replace(p.qual, '\\s+', ' ', 'g'), '') || '|'
        || coalesce(regexp_replace(p.with_check, '\\s+', ' ', 'g'), '')), 1, 12)
        from pg_policies p
       where p.schemaname='public' and p.tablename='audit_log'
         and p.policyname='audit_read_ceo') is distinct from '1303b9136217' then
    raise exception '0196-відкат: дайджест політики не повернувся до 1303b9136217';
  end if;

  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0196-відкат: invariants_check не знайдено — відкочувати нічого';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '${NEW_MD5}' then
    raise exception '0196-відкат: у проді не 0196 (%) — відкат наосліп заборонено', md5(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);

  v_new := v_src;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> v_want[v_i] then
      raise exception '0196-відкат: якір «%» трапляється % раз(ів), а треба %',
        v_lbl[v_i], v_hits, v_want[v_i];
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  if md5(v_new) is distinct from '${PRE_MD5}' or length(v_new) <> ${PRE_LEN} then
    raise exception '0196-відкат: зворотні пари дали % / %, а 0194 це ${PRE_MD5} / ${PRE_LEN}',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from '${PRE_MD5}' then
    raise exception '0196-відкат: у БД лягло % замість ${PRE_MD5}', md5(v_src);
  end if;

  delete from public.migration_ledger where name = '0196_secdef_search_path_value.sql';

  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0196-відкат: сторож перевірив % замість 23', v_res->>'checked';
  end if;

  raise notice 'ROLLBACK_OK 0196: guard % len % | ledger %',
    md5(v_new), length(v_new), (select count(*) from public.migration_ledger);
end;
$back$;

-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: усі асерти вище — УСЕРЕДИНІ тієї самої
--    транзакції. Після commit виконати ОКРЕМИМ запитом:
--      select md5(replace(p.prosrc, chr(13), '')) as guard,
--             length(replace(p.prosrc, chr(13), '')) as len
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname='public' and p.proname='invariants_check'
--         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
--      -- очікування: ${PRE_MD5} / ${PRE_LEN}
--      select count(*) from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
--       where n.nspname='public' and pr.prosecdef
--         and coalesce((select cfg from unnest(pr.proconfig) cfg
--                        where cfg like 'search_path=%'), '')
--             is distinct from 'search_path=public, pg_temp';
--      -- очікування: 34 (слабка форма повернулась — саме це відкат і робить)
--
-- ⚠️ ЩО ПОВЕРТАЄ ВІДКАТ: 34 definer-функції знову стоять у формі, де тимчасова
--    схема викликача виграє в справжньої, а CEO знову читає через журнал
--    інциденти й гранти направників, яких політики йому не дають.
`;

const MIG_HEAD = `-- ============================================================================
--  RadFlow — Міграція 0196: search_path у definer-функцій пінується ЗНАЧЕННЯМ,
--  а не наявністю; журнал аудиту для CEO звужується за таблицями.
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0195.
--  Даних НЕ змінює. \`checked\` лишається 23 — нової перевірки не додаємо,
--  розширюємо №2. Список №19 НЕ росте: у 9 його рядках міняється лише поле
--  \`;cfg=\` (40 підписів як були, так і лишились).
--
--  ⚠️ ФАЙЛ — КАНОН, але в прод іде \`scripts/frag/0196_apply.sql\`: тіло сторожа
--     (${PRE_LEN} Б -> ${NEW_LEN} Б) не пересилається, БД редагує своє власне
--     підстановками, а md5 звіряється з порахованим ТУТ. Файл потрібен гейту
--     (він пінить md5 ФАЙЛА) і тестам (вони читають диск, а не \`prosrc\`).
--
--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ (знахідка другого ревʼю). У ньому ТРИ
--     верхньорівневі стейтменти — 34 \`alter function\`, передрук сторожа,
--     \`alter policy\` — тобто ТРИ транзакції. Обрив між другим і третім лишає
--     нового сторожа зі СТАРОЮ політикою: №16 чекатиме дайджест
--     \`3e5b95410350\`, а в базі буде \`1303b9136217\`. Обрив між першим і
--     другим лишає нові функції зі старим сторожем: №19 дасть 9 порушників.
--     Атомарний шлях один — фрагмент \`0196_apply.sql\`, весь одним запитом.
--
--  РОЗВИЛКА Р3 — РІШЕННЯ ВЛАСНИКА 14.09: «пін ЗНАЧЕННЯ в перевірці №2».
--  Заміряно в с67: \`alter function … set search_path = pg_temp, public\` на
--  definer-функції ПОЗА списком №19 був невидимий усім 23 перевіркам.
--
--  ⚠️ ЗАМІР, ЩО ЗМІНИВ ФОРМУ ЛІКУВАННЯ. Зонд на проді (відкочена транзакція,
--     тимчасова таблиця \`cities\` поверх справжньої):
--       real=[Андріївка]
--       search_path=public             -> ПІДМІНА-TEMP
--       search_path=""                 -> ПІДМІНА-TEMP
--       search_path=pg_catalog,pg_temp -> ПІДМІНА-TEMP
--       search_path=pg_temp,public     -> ПІДМІНА-TEMP
--       search_path=public, pg_temp    -> Андріївка
--     Тобто боронить НЕ згадка \`pg_temp\`, а те, що справжня схема стоїть ПЕРЕД
--     нею. Рецепт Supabase \`search_path = ''\` від підміни ВІДНОШЕНЬ не
--     боронить узагалі — він лише змушує все кваліфікувати.
--     Тому канон ОДИН: \`public, pg_temp\`, без іменованих винятків (список
--     винятків без гілки \`extra:\` не має замикання — урок с65).
--
--  СТАН ДО ПАКЕТА (запитом): 115 definer-функцій, з них 81 на каноні, 28 на
--  \`public\`, 6 на \`""\`. Слабких — 34; 12 із них кличе \`authenticated\`, 6 —
--  \`anon\`. Живої діри НЕ було: неквалiфікованих посилань на таблиці по всіх
--  115 тілах — НУЛЬ (зелена база на самому пошуку є). 0196 робить цю
--  властивість структурною, а не ритуальною.
--
--  ДРУГА ЧАСТИНА — політика \`audit_read_ceo\`. Замір 14.09 спростував посилку
--  п.1 рішення Р69-2 («журнал віддає CEO рівно те, що той і так читає прямо»).
--  ⚠️ КЛЮЧ ДО ЧИСЕЛ (без нього їх не перевірити): ліворуч —
--     \`count(distinct row_id)\` в \`audit_log\` під предикатом CEO, тобто СУТНОСТІ;
--     праворуч — РЯДКИ, які CEO читає прямо під своїми політиками.
--    queue_entries 433 сутності через журнал проти 297 рядків прямо
--    incidents 11 проти 0 · referral_access 3 проти 0 · profiles 3 проти 1
--  (зелена база: waitlist прямо 6 = еталон 6). \`fn_audit\` пише рядок ЦІЛКОМ
--  (\`to_jsonb(old/new)\`), а політика не була звужена ні за \`table_name\`, ні
--  за роллю. ВИСНОВОК Р69-2 (CEO бачить PII пацієнтів) НЕ переглядається —
--  виправляється його посилка. Рішення власника с70: звузити за \`table_name\`.
--
--  ⚠️ ЧОГО ЦЕ ЗВУЖЕННЯ НЕ РОБИТЬ, і це треба сказати прямо, бо інакше
--     наступний читач вирішить, що журнал тепер дорівнює прямому читанню.
--     НЕ ДОРІВНЮЄ. Воно прибирає ТРИ таблиці з шести (−25 рядків incidents,
--     −58 profiles, −22 referral_access для єдиного активного CEO: 2291 -> 2186).
--     По тих трьох, що лишились, журнал і далі ширший за пряме читання:
--     433 сутності \`queue_entries\` проти 297 у таблиці (136 ВИДАЛЕНИХ записів),
--     18 \`waitlist_entries\` проти 6 (12 видалених), \`ceo_access\` 2 проти 1.
--     Причина структурна: журнал зберігає рядки, яких у таблиці вже немає.
--     Зрівняти можна лише предикатом \`exists (… where q.id = row_id)\` на кожен
--     рядок — це окреме рішення з власною ціною, і в цей пакет воно не входить.
--
--  ⚠️ FORCE RLS на \`audit_log\` НЕ додається, і це замір, а не лінь: у
--     \`postgres\` \`rolbypassrls = true\`, тож forced RLS для нього — no-op.
-- ============================================================================
`;

const ALTERS = WEAK.map((s) => `alter function public.${s} set search_path = public, pg_temp;`).join("\n");

const MIG_ALTERS = `
-- ── 1. 34 definer-функції на канон ──────────────────────────────────────────
${ALTERS}

-- ── 2. Передрук сторожа ─────────────────────────────────────────────────────
`;

// ⚠️ Політика — ПІСЛЯ сторожа, тим самим порядком, що у фрагменті: вона бере
//    AccessExclusiveLock на audit_log, і цей замок має жити якнайменше.
const MIG_POLICY = `
-- ── 3. Журнал аудиту для CEO — лише таблиці, які він читає й напряму ────────
alter policy audit_read_ceo on public.audit_log
  using ((clinic_id in (select public.auth_ceo_clinics()))
         and table_name in ('queue_entries', 'waitlist_entries', 'ceo_access'));
`;

const MIG_TAIL = `
-- ============================================================================
-- === ВІДКАТ ===
--
-- Виконувати \`scripts/frag/0196_rollback.sql\` (він несе зворотні пари і
-- повертає КОЖНІЙ функції ЇЇ власне колишнє значення: 28 на \`public\`, 6 на
-- \`""\`). ⚠️ Перевіряти відкат ОКРЕМИМ запитом, після commit.
--
-- ⚠️ ЩО ПОВЕРТАЄ ВІДКАТ: 34 функції знову у формі, де тимчасова схема
--    викликача виграє в справжньої, і CEO знову читає через журнал інциденти
--    й гранти направників, яких політики йому не дають.
--
-- -- ⚠️ ДРУГИЙ РІВЕНЬ: рядок леджера знімає сам фрагмент відкату.
-- -- delete from public.migration_ledger where name = '0196_secdef_search_path_value.sql';
-- ============================================================================
`;

const MIG = MIG_HEAD + MIG_ALTERS + S94.prologue + NEW_BODY + "$function$;\n" + MIG_POLICY + MIG_TAIL;

writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0196_apply.sql", APPLY);
writeFileSync("scripts/frag/0196_dryrun.sql", DRYRUN);
writeFileSync("scripts/frag/0196_rollback.sql", ROLLBACK + ROLLBACK_TAIL_SQL);

console.log("0196 зібрано.");
console.log(`  сторож:  ${PRE_MD5} / ${PRE_LEN}  ->  ${NEW_MD5} / ${NEW_LEN}`);
console.log(`  checked: 23 -> 23 (нової перевірки не додаємо)`);
console.log(`  пін №19: 40 -> 40 (міняється поле ;cfg= у 9 рядках)`);
console.log(`  політика audit_read_ceo: 1303b9136217 -> 3e5b95410350`);
console.log(`  функцій на канон: ${WEAK.length} (${WEAK_PUBLIC.length} з public, ${WEAK_EMPTY.length} з "")`);
console.log(`  пар підстановки: ${PAIRS.length} (кожна з очікуванням 1 влучання)`);
console.log(`  базиси: витяг 0194 · ${CHECKS.length} змістових перевірок нового тіла ·`);
console.log(`          ЗВОРОТНИЙ ХІД (зворотні пари -> ${PRE_MD5} / ${PRE_LEN}) — усі зелені`);
