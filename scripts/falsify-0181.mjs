// ============================================================
//  Стенд фальсифікації пакета 41 (с59): RF-01 — джерело кейса під гардом.
//
//  Головне питання стенда: чи тримає СТАТИЧНИЙ сторож №19 те, що 0181 до
//  нього додала. Міграція має ТРИ рубежі, і в них РІЗНІ сторожі:
//    • тригер `guard_radiologist_scope` і дві case-RPC — стереже сама БАЗА
//      (перевірка №19 у `invariants_check`) плюс DO-асерти в тілі міграції;
//    • список підписів №19 у ФАЙЛІ передруку — стереже `npm test`
//      (`tests/guardFnBodiesInvariant.test.ts`), і ось ЦЕ фальсифікує стенд.
//
//  ⚠️ ЧЕСНО ПРО МЕЖУ, і вона названа тут, а не сховано в звіті: значення
//     дайджестів (16fab10b… для гарда, aa3cf7cd… і 0f7f9aaa… для RPC) НЕ
//     пінить жоден тест — їх стереже жива база, бо тест не має до неї
//     доступу. Підміна ЗНАЧЕННЯ дайджеста в файлі лишиться зеленою в
//     `npm test` і почервонить `invariants_check` на проді. Позиції N1/N2
//     нижче це ПОКАЗУЮТЬ (вони помічені `green: true` саме тому, а не тому,
//     що це безпечно) — щоб наступна сесія не вирішила, ніби тести тут
//     сторожать більше, ніж сторожать.
//
//  ⚠️ Правлю БОЙОВІ файли (міграцію і спек) → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//  ⚠️ Міграція вже накатана і заштампована `db:gate`: стенд ОБОВʼЯЗКОВО
//     відновлює файл, інакше наступний `db:gate:check` побачить md5-дрейф.
//
//  Запуск: node scripts/falsify-0181.mjs   Звіт: falsify-0181.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

/* ⚠️ ОСТАННІЙ передрук, а не 0181 дослівно. Мутації цього стенда стріляють
   у блок №19, а статичні сторожі читають ФАЙЛ ОСТАННЬОГО передруку
   (`latestReprint()`): щойно наступна міграція передрукує `invariants_check`,
   правка в 0180 перестала б бути тим текстом, який тести читають, — стенд
   зазеленів би МОВЧКИ. Той самий урок, що з56 виучила на falsify-0166. */
function latestReprint() {
  const dir = "supabase/migrations";
  let best = "";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const txt = readFileSync(`${dir}/${f}`, "utf8");
    const at = txt.search(/^create or replace function public\.invariants_check/m);
    if (at < 0) continue;
    if (txt.indexOf("\n$function$;", at) < 0) continue;
    best = dir + "/" + f;
  }
  if (!best) { console.error("НЕ ЗНАЙДЕНО жодного передруку invariants_check"); process.exit(2); }
  return best;
}
const FILES = { mig: latestReprint(), spec: "tests/guardFnBodiesInvariant.test.ts" };
const SPECS = [
  "tests/guardFnBodiesInvariant.test.ts",
  "tests/invariantsCheckedPins.test.ts",
  "tests/invariantsFailLoud.test.ts",
  "tests/guardTriggersInvariant.test.ts",
];
const OUT = "falsify-0181.md";
const REPORT = ".falsify-0181.json";

const MUTATIONS = [
  {
    /* САМА правка пакета 41, половина 1: рядок RPC зник зі списку №19. */
    /* ⚠️ Якір — ПОВНИЙ рядок списку, тож кожен передрук, який змінює текст
       рядка, його протухлює. 0191 дописала в `attrs` секцію `;acl=` — md5 тіла
       не зрушив, зрушив саме рядок. Протухлий якір дає «ЯКІР НЕ УНІКАЛЬНИЙ (0)»
       і ЧЕРВОНИЙ стенд, а не тихе зеленіння, — і це єдине, що тут рятує. */
    id: "A1", file: "mig", green: false,
    expect: /add_case_step_rpc/,
    what: "рядок add_case_step_rpc прибрано зі списку №19",
    from: "      ('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),\n",
    to: "",
  },
  {
    id: "A2", file: "mig", green: false,
    expect: /case_from_entry_rpc/,
    what: "рядок case_from_entry_rpc прибрано зі списку №19",
    from: "      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),\n",
    to: "",
  },
  {
    /* Головний пін пакета: сам ГАРД. Ревʼю показало, що RPC — не єдиний
       письменник, тож зникнення саме цього рядка мусить червоніти. */
    id: "A3", file: "mig", green: false,
    expect: /guard_radiologist_scope/,
    what: "підпис guard_radiologist_scope() перейменовано в списку №19",
    from: "      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5',",
    to: "      ('guard_radiologist_scope_v2()','16fab10b6de82574e5f103fd0e40d8d5',",
  },
  {
    /* Регресія 0179: рядок, доданий попереднім пакетом, теж мусить триматись. */
    id: "A4", file: "mig", green: false,
    expect: /ceo_list_for_clinic/,
    what: "рядок ceo_list_for_clinic (0179) прибрано зі списку №19",
    from: "      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c',",
    to: "      ('ceo_list_for_clinic_x(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c',",
  },
  {
    /* ДРУГИЙ бік тесту «пінів рівно стільки»: список у ФАЙЛІ цілий, а всох
       список у ТЕСТІ. Без цієї позиції тест доводив би лише один напрям. */
    id: "A5", file: "spec", green: false,
    expect: /пінів рівно стільки/,
    what: "обидва підписи case-RPC прибрано з PINNED у самому тесті",
    edits: [
      { file: "spec", from: '  "add_case_step_rpc(p_case_id uuid, p_step jsonb)",\n', to: "" },
      { file: "spec", from: '  "case_from_entry_rpc(p_entry_id uuid, p_step jsonb)",\n', to: "" },
    ],
  },
  {
    /* Урок с56, який 0180 повторив у гілці f:: усічений md5 перебирається. */
    id: "A6", file: "mig", green: false,
    expect: /дайджест ПОВНИЙ/,
    what: "дайджест тіл у №19 усічено до 12 hex",
    from: "             md5(btrim(regexp_replace(",
    to: "             substr(md5(btrim(regexp_replace(",
  },
  {
    /* BEGIN ATOMIC живе не в prosrc — знахідка с56. */
    id: "A7", file: "mig", green: false,
    expect: /sqlbody/,
    what: "тіло беруть лише з prosrc, sqlbody відкинуто",
    /* ⚠️ ЯКІР РОЗШИРЕНО РЕВІЗІЄЮ с60. Був голий вираз
       `p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, '')` — і
       0183 зробила його НЕУНІКАЛЬНИМ (2 збіги): та сама формула стоїть тепер
       і в асерті §3.3 самої міграції, який звіряє тіло нової RPC з піном у
       №19. Це не дефект 0183 — навпаки, формула там мусить бути ДОСЛІВНО та
       сама, інакше асерт нічого не доводить. Тому якір тепер тягне ще й
       хвіст `as body,`, який є ЛИШЕ всередині №19. */
    from: "                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),\n                   '\\s+', ' ', 'g'))) as body,",
    to: "                   p.prosrc || coalesce('', ''),\n                   '\\s+', ' ', 'g'))) as body,",
  },
  {
    /* Мітка перевірки — рівно одна: подвоєння ламає розбір offenders. */
    id: "A8", file: "mig", green: false,
    expect: /мітка перевірки/,
    what: "мітку guard_fn_bodies продубльовано",
    from: "'check', 'guard_fn_bodies', 'offenders'",
    to: "'check', 'guard_fn_bodies', 'dup', jsonb_build_object('check', 'guard_fn_bodies'), 'offenders'",
  },
  /* ---------------- B: внесок 0191 — ПРАВА і ЗНАЧЕННЯ search_path ----------
     ⚠️ Ці чотири позиції додано в с67 РЕВІЗІЄЮ, а не автором 0191. До них
     ревізія друкувала 37/37 зелених на гілці, весь продуктовий внесок якої
     не фальсифікувала жодна мутація: три нових піни і поле `;acl=` не
     згадувались у жодному зі стендів (замірено пошуком із зеленим базисом —
     `acl=` знаходився, `auth_can_refer` не знаходився ніде). Єдиним доказом,
     що нові піни ловлять, був разовий зонд усередині накату. Канон проекту:
     «новий гард без названого червоного тесту і зеленого базису — не
     зроблений». ---------------------------------------------------------- */
  {
    /* Перший із трьох вирішувачів направниківського доступу. Зникнення рядка
       мусить назвати ПІДПИС, а не лише зрушити лічильник. */
    id: "B1", file: "mig", green: false,
    expect: /auth_can_refer/,
    what: "рядок auth_can_refer прибрано зі списку №19 (новий пін 0191)",
    from: "      ('auth_can_refer(c uuid)','0a178709faea2ab0bb55fbb098001bf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),\n",
    to: "",
  },
  {
    /* Другий вирішувач, і ФОРМА ЯКОРЯ тут інша навмисно: префікс до md5
       переживає передрук, який змінює хвіст `attrs` (саме на цьому в с67
       протухли чотири якорі A1/A2 та сусідніх стендів). Перейменування
       замість видалення — щоб довести НАЗВАНИЙ напрямок: підпис у списку
       більше не той, хоча довжина списку не зрушила. */
    id: "B2", file: "mig", green: false,
    expect: /auth_referrer_visible_rooms/,
    what: "підпис auth_referrer_visible_rooms() перейменовано в списку №19",
    from: "      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4',",
    to: "      ('auth_referrer_visible_rooms_v2()','5f3226aad0599e94feb5b5e1ecfbbbf4',",
  },
  {
    /* ⚠️ САМЕ ТА мутація, яку файл тесту називає прозою на своєму місці, але
       якої не робив НІХТО: `;acl=` зникає з ОДНОГО літерала, а вираз у `cur`
       лишається цілим. Список 33 рядки, підписи ті самі, формат не поїхав —
       зрушує тільки те, що поле є не в КОЖНОМУ рядку. */
    id: "B3", file: "mig", green: false,
    expect: /КОЖНОМУ рядку/,
    what: "`;acl=` прибрано з ОДНОГО літерала (вираз у cur цілий)",
    from: "      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),",
    to: "      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),",
  },
  {
    /* ⚠️ Доводить, що зняття БЛОКОВИХ коментарів у `CODE`
       (tests/guardFnBodiesInvariant.test.ts) працює. Якби воно не працювало,
       вираз лишився б «видимим» тесту, і пін на `collate "C"` та дві гілки
       був би задоволений ЗАКОМЕНТОВАНИМ кодом — тобто брехнею. Урок с65 №7.

       ⚠️⚠️ ТРИ ПОПЕРЕДНІ РЕДАКЦІЇ ЦІЄЇ ПОЗИЦІЇ БУЛИ ХИБНІ, і дві з них
       виглядали як робочі:
       1) коментувала ДУБЛЬ рядка, лишаючи оригінал на місці — мутація просто
          не мутувала (спіймано автором до прогону);
       2) ставила ЗАКРИВАЧ блокового коментаря МІЖ `end` і ` as attrs` — тоді
          третій асерт тесту падав від розриву дослівного літерала, а не від
          зняття коментарів. Заміряно ревʼю: зі ЗНЯТИМ зняттям коментарів
          стенд лишався 12/12 зеленим, тобто фікс Ф-1 був гардом без
          червоного тесту;
       3) цей самий коментар цитував закривач ДОСЛІВНО — і закрив сам себе.
          `SyntaxError`, стенд помер за 0 с. Пастка названа в AGENTS.md, і я
          вскочив у неї, поки її ж описував. Тут її не цитують символами.
       Тепер закривач стоїть ПІСЛЯ `as attrs`: усі ТРИ асерти піна цілком
       лежать усередині коментаря. Зі зняттям коментарів — червоно; БЕЗ нього
       — зелено, і стенд скаже «СТОРОЖ НЕ ТРИМАЄ». Саме це й робить позицію
       фальсифікацією зняття, а не сусідства тексту.
       Заміряно 13.09 зондом (база / мутант × зняття ON / OFF):
       база зелена в обидва боки; мутант ЧЕРВОНИЙ лише при ON. */
    id: "B4", file: "mig", green: false,
    expect: /ДВІ гілки/,
    what: "вираз `;acl=` загорнуто в блоковий коментар (пін не має його бачити)",
    from: "               || ';acl='   || case when p.proacl is null then '<default>'\n                                    else coalesce((select string_agg(t, ',' order by t collate \"C\")\n                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs",
    to: "               /* || ';acl='   || case when p.proacl is null then '<default>'\n                                    else coalesce((select string_agg(t, ',' order by t collate \"C\")\n                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs */\n               || '' as attrs",
  },
  /* ---- B5-B13: ТРИ НАЗВАНІ МЕЖІ аудиту 0191, закриті в с68 ---------------
     ⚠️ І ОДРАЗУ ПРО РОЗМІР РОБОТИ, бо перша редакція цієї шапки казала, що всі
     три — «місця, про які прямо сказано: тут сторожа немає». Це завищення, і
     ревʼю показало його цитатою з самого аудиту. Насправді три різні речі:
       • МЕЖА 4 (B8/B9/B10) — сторожа в `npm test` не було ЗОВСІМ. Але й тут не
         «ніхто ніде»: ручний смоук h2 `invariants_watch_smoke.sql` вихолощений
         гейт ловить двома `SMOKE_FAIL`. Перенесено з ручного смоука в `npm test`.
       • МЕЖА 6 (B5) — сторож БУВ (`it.each(PINNED)` + два лічильники), не було
         ФАЛЬСИФІКАЦІЇ. Аудит так і пише: «Борг дешевий: ще одна мутація виду
         B1». Зате це ЄДИНА з трьох, чия мутація мовчить і на проді, і в h2.
       • МЕЖА 7 (B6/B7/B13) — сторож був у СПИСКУ, але не у ВИРАЗІ, і на проді
         правка голосна (33 рядки `attrs:`). Перенесено місце лову з
         після-накату в `npm test`.
     Тобто «закрито три межі» ≠ «закрито три дірки»: дірка була одна. */
  {
    /* ⚠️ МЕЖА 6, і вона НАЙДОРОЖЧА з трьох (замір нижче). Третій вирішувач
       направниківського доступу був єдиним із трьох БЕЗ названого червоного
       тесту на ПІДПИС: B3 вище править саме цей рядок, але червоніє на ПОЛІ
       (`;acl=` не в кожному рядку), а не на імені.
       ⚠️ ЧОМУ ЦЕ ДОРОЖЧЕ ЗА B8, хоч перша редакція пакета твердила навпаки.
       Знятий зі списку підпис зникає і з `cur` — вона будується по іменах зі
       `expd` (`p.proname = any (select split_part(e.fn,'(',1) from expd e)`),
       тож гілка `missing:` його не бачить (немає в `expd`), гілка `extra:` не
       бачить (немає в `cur`), і `invariants_check` вертає ok:true. Смоук h2
       теж мовчить: він зондує `guard_waitlist_room`. Отже ЄДИНИЙ сторож
       випалого підпису — `npm test`, і до с68 у нього не було фальсифікації.
       ⚠️ ФОРМА ЯКОРЯ — як у B2, а НЕ як у B1, хоч аудит просив «виду B1»
       (знахідка ревʼю). Повний рядок списку має ТРИ незалежні тригери
       протухання: новий md5 тіла, будь-яке нове поле `attrs` (рівно це зробила
       0191, дописавши `;acl=`) і будь-який `grant`/`revoke` на цю функцію —
       тобто зміну в БД, не пов'язану з передруком. Префікс до md5 має один.
       Перейменування замість видалення ще й точніше: довжина списку не
       рухається, тож червоніє саме пін ПІДПИСУ. */
    id: "B5", file: "mig", green: false,
    expect: /підпис auth_referrer_clinics\(\)/,
    what: "підпис auth_referrer_clinics() перейменовано в списку №19 (межа 6)",
    from: "      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731',",
    to: "      ('auth_referrer_clinics_v2()','ef77618a170ca3065c2d1673a3a13731',",
  },
  {
    /* ⚠️ МЕЖА 7. Замірено в с67: зняти складання `;cfg=` у `cur` — і не
       червоніє ЖОДЕН тест, хоч це поле і є єдиний сторож ЗНАЧЕННЯ
       `search_path` (№2 вимагає лише наявності підрядка, №22 `proconfig` не
       читає), тобто весь сенс 0191. Причина: пін робив `toContain(';cfg=')`
       по всьому блоку, а `;cfg=` стоїть у кожному з 33 літералів списку.
       ⚠️ ЧЕСНО: на проді мутація ГОЛОСНА — 33 рядки `attrs:`. Ціна не «дірка
       в сторожі», а МІСЦЕ ЛОВУ: було після накату (червоне вікно, рядок у
       леджері), стало в `npm test` до нього.
       ⚠️ ЯКІР БЕЗ ВИРІВНЮВАННЯ (знахідка ревʼю). Перша редакція брала цілий
       рядок разом із його пʼятнадцятьма ведучими пробілами — а стовпчик `||` у
       цьому виразі вирівняний РУКАМИ під найдовшу мітку `';owner='`. Додати
       сьоме поле з довшою міткою = переформатувати блок = вбити якір. Беремо
       найкоротший унікальний фрагмент (замір: `';cfg='` у файлі один раз). */
    id: "B6", file: "mig", green: false,
    expect: /поле ;cfg=/,
    what: "мітку `;cfg=` у виразі cur перейменовано (значення search_path не збирається)",
    from: "|| ';cfg='",
    to: "|| ';cfgX='",
  },
  {
    /* Друга форма межі 7, і вона потрібна окремо: ПЕРШЕ поле складається без
       ведучого `||` (`'secdef=' || …`), тож його регулярка інша, ніж у решти
       пʼяти. Перейменування замість зняття — щоб SQL лишився валідним і було
       видно, що пін тримає САМЕ це поле, а не «щось поїхало».
       Ведучі пробіли з якоря зняті — з тієї ж причини, що в B6. */
    id: "B7", file: "mig", green: false,
    expect: /поле secdef=/,
    what: "поле `secdef=` у виразі cur перейменовано на `sdef=`",
    from: "'secdef=' || p.prosecdef::text",
    to: "'sdef=' || p.prosecdef::text",
  },
  {
    /* ⚠️ МЕЖА 4, сегмент «гейт». Порушники збираються у `v_tmp` і
       викидаються: `invariants_check` вертає ok:true, `checked:23`,
       `failed:[]`, і ВЕСЬ `npm test` лишався зеленим.
       ⚠️ ПОПРАВКА ПІСЛЯ РЕВʼЮ: перша редакція писала тут «ніхто ніде цього не
       бачить» — НЕПРАВДА. Крок h2 `supabase/smoke/invariants_watch_smoke.sql`
       зондує `guard_waitlist_room()` живим `alter function … set search_path`
       і при вихолощеному гейті дає два іменованих `SMOKE_FAIL h2`. Сторож був,
       просто РУЧНИЙ, і саме тому «найдорожча з трьох» — не ця межа, а 6 (B5).
       ⚠️ Якір несе МІТКУ перевірки, бо сам гейт `if v_tmp is not null then`
       дослівно однаковий у 22 з 23 перевірок (замір; №9
       `orphan_broom_no_hardcode` працює через `if exists (…)` і в `v_tmp` не
       пише). Без мітки якір був би неунікальним, і стенд відхилив би позицію. */
    id: "B8", file: "mig", green: false,
    expect: /гейт стоїть на ЗІБРАНИХ/,
    what: "гейт звіту №19 підмінено на константу (`if false then`)",
    from: "  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'guard_fn_bodies', 'offenders', to_jsonb(v_tmp)));",
    to: "  if false then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'guard_fn_bodies', 'offenders', to_jsonb(v_tmp)));",
  },
  {
    /* Другий бік межі 4: вердикт лишається червоним, а журнал — порожнім. Це
       не косметика звіту: саме з `offenders` пишеться наступна міграція
       (рядок `body:<підпис>-><новий md5>`), тобто це єдиний канал, яким
       сторож каже, ЩО поїхало. Червоне без імені = зупинка без діагнозу. */
    id: "B9", file: "mig", green: false,
    expect: /звіт несе САМ масив/,
    what: "`offenders` отримує порожній масив замість зібраного v_tmp",
    from: "'check', 'guard_fn_bodies', 'offenders', to_jsonb(v_tmp)));",
    to: "'check', 'guard_fn_bodies', 'offenders', to_jsonb(array[]::text[])));",
  },
  /* ---- B10-B13: чотири позиції, які НАЗВАЛО РЕВʼЮ с68 --------------------
     Усі чотири — мутації, що проходили повз пакет у його ПЕРШІЙ редакції,
     тобто повз щойно доданих одинадцять тестів. Кожна знайдена ревʼю, не
     автором; кожна тут відтворена як названа. */
  {
    /* ⚠️ ТРЕТІЙ сегмент межі 4, і це САМА мутація, яку аудит назвав дослівно:
       «`where x.txt not like 'attrs:%'` вирізає весь приріст цієї міграції».
       Перша редакція пакета закрила гейт і журнал, оголосила межу 4 закритою —
       і лишила цю мутацію зеленою. Замір ревʼю: 108/108 зелених.
       ⚠️ Де її ловлять, точно: у `npm test` — ніде (до цього пакета), на проді
       — `invariants_check` лишається ok:true. Ручний h2 її ловить, бо чекає
       НАЯВНОСТІ рядка `attrs:guard_waitlist_room()`, а умова саме гілку
       `attrs:` і вирізає. Тобто профіль той самий, що в B8: тихо у вердикті й
       у тестах, гучно лише в ручному смоуку.
       ⚠️ Якір несе попередній рядок, бо `      ) x;` у файлі 13 разів. */
    id: "B10", file: "mig", green: false,
    expect: /гілка auth_trigger дослівна/,
    what: "до під-селекта №19 дописано `where x.txt not like 'attrs:%'` (межа 4, сегмент `) x;`)",
    from: "               || ' handle_new_user()/O'\n      ) x;",
    to: "               || ' handle_new_user()/O'\n      ) x where x.txt not like 'attrs:%';",
  },
  {
    /* Третя ФОРМА регулярки полів: `';owner='` — єдине поле, у якого в
       передруку рівно один пробіл до `||` (воно найдовше, під нього і
       вирівняний стовпчик). Ревʼю назвало це «гард без названого червоного
       тесту»: із шести полів фальсифіковано було три (`;cfg=` B6, `secdef=`
       B7, `;acl=` B4). Тепер чотири. ⚠️ Лишаються `;vol=` і `;lang=` — борг
       названий тут і в шапці тесту, бо їхня форма дослівно збігається з
       формою `;cfg=`, яку B6 уже фальсифікує. */
    id: "B11", file: "mig", green: false,
    expect: /поле ;owner=/,
    what: "мітку `;owner=` у виразі cur перейменовано",
    from: "|| ';owner='",
    to: "|| ';own='",
  },
  {
    /* ⚠️ Ця позиція існує тому, що ревʼю знайшло НЕПАДАБЕЛЬНИЙ пін. Доки
       термінатором вирізу `CUR` був рядок збирача, мутація в самому збирачі
       вбивала виріз → `throw` на збірці набору → червоне БЕЗ імен → стенд
       казав «СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)», тобто вказував не
       туди. Термінатор зміщено на `)\n    select`, і тепер пін падає по імені.
       Сама втрата `order by` — не косметика: без неї порядок порушників
       залежить від плану, і дифф журналу між двома прогонами перестає читатись.
       ⚠️ Якір несе НАСТУПНІ рядки: `into v_tmp` у файлі 21 раз. */
    id: "B12", file: "mig", green: false,
    expect: /збирач №19 детермінований/,
    what: "зі збирача №19 знято `order by x.txt` (журнал стає невідтворюваним)",
    from: "    select array_agg(x.txt order by x.txt) into v_tmp\n      from (\n        -- функції з таким підписом більше немає",
    to: "    select array_agg(x.txt) into v_tmp\n      from (\n        -- функції з таким підписом більше немає",
  },
  {
    /* ⚠️ ДІРКА В САМОМУ ФІКСІ Ф-1 (с66), знайдена ревʼю с68. Фільтр коментарів
       знімає рядкові ЛИШЕ на початку рядка, тож ХВОСТОВИЙ коментар виживає:
       поле прибирається з виразу, а його текст лишається в кінці рядка — і всі
       шість полевих регулярок бачать закоментований текст і лишаються
       ЗЕЛЕНИМИ. Тобто B4 і B6 обходяться заміною блокового коментаря на
       рядковий. Ловить новий асерт «виріз cur не містить коментарних
       маркерів». ⚠️ Цей якір ЗАЛЕЖИТЬ від вирівнювання (він і є той рядок),
       і це свідомо: позиція стріляє саме в нього. */
    id: "B13", file: "mig", green: false,
    expect: /коментарних маркерів/,
    what: "поле `;cfg=` знято з виразу, а його текст лишено ХВОСТОВИМ коментарем",
    from: "               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')\n",
    to: "               || '' -- || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')\n",
  },
  /* ---------------- N: НАЗВАНІ ДІРКИ (тести їх НЕ ловлять) ---------------- */
  {
    /* ⚠️ Це НЕ «безпечна правка». Значення дайджеста стереже ЖИВА БАЗА:
       `invariants_check` дасть body:guard_radiologist_scope()->16fab10b…
       Тест доступу до бази не має і лишиться зеленим — і саме це тут
       зафіксовано, щоб наступна сесія не вважала №19 повністю статичним. */
    id: "N1", file: "mig", green: true,
    what: "ЗНАЧЕННЯ дайджеста гарда підмінено (ловить лише прод, не npm test)",
    from: "('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5',",
    to: "('guard_radiologist_scope()','00000000000000000000000000000000',",
  },
  {
    id: "N2", file: "mig", green: true,
    what: "ЗНАЧЕННЯ дайджеста add_case_step_rpc підмінено (те саме — лише прод)",
    from: "('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8',",
    to: "('add_case_step_rpc(p_case_id uuid, p_step jsonb)','00000000000000000000000000000000',",
  },
  /* ---------------- T: позитивні контролі ---------------- */
  {
    id: "T1", file: "mig", green: true,
    what: "коментар про походження пінів 0181 переписано",
    from: "  --        Тому головний пін тут — саме ГАРД, а RPC — другий рубіж.",
    to: "  --        Тому головний пін тут — саме ГАРД (RPC — другий рубіж).",
  },
];

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

for (const m of MUTATIONS) {
  const eds = editsOf(m);
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
  for (const e of eds) {
    if (!e.file || !FILES[e.file] || typeof e.from !== "string" || typeof e.to !== "string") {
      console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — правка без файлу з FILES або без from/to.`);
      process.exit(1);
    }
  }
}

/* Кількість адресних мутацій — КОНСТАНТА (урок U-80г). A1/A2 два нові рядки
   case-RPC, A3 сам гард, A4 регресія 0179, A5 другий бік лічильника пінів,
   A6 усічений md5, A7 sqlbody, A8 мітка.
   B1/B2/B3/B4 — внесок 0191 (с67): рядок `auth_can_refer` знято, підпис
   `auth_referrer_visible_rooms` перейменовано, `;acl=` знято з ОДНОГО
   літерала, вираз `;acl=` загорнуто в блоковий коментар.
   ⚠️ Позиції на лічильник `checked` тут НЕМАЄ навмисно, і це ЗАМІР, а не
   недогляд: асерт `(v_x ->> 'checked')::int` живе у СМОУКАХ, а у файлі
   міграції його немає взагалі (перевірено grep-ом) — мутація в `mig` була б
   протухлим якорем. Лічильник стереже `falsify-0166`.
   B5–B13 — три названі межі аудиту 0191, закриті в с68. B5 — межа 6 (підпис
   `auth_referrer_clinics`); B6/B7/B13 — межа 7 (поля `attrs` у виразі `cur`);
   B8/B9/B10 — межа 4 (гейт звіту, журнал, закриття під-селекта); B11 — третя
   форма полевої регулярки; B12 — детермінізм збирача.
   ⚠️ ПРОФІЛЬ ТИШІ, замірений, а не виведений (перша редакція цього абзацу
   твердила, що «лише B8 мовчала б і на проді», і це було неправдою):
     • мовчить УСЮДИ, крім `npm test` — B5. Знятий підпис зникає і зі `expd`, і
       з `cur`, тож жодна гілка звіту його не бачить, і h2 його не зондує;
     • мовчить у вердикті й у тестах, гучно лише в РУЧНОМУ смоуку h2 — B8, B10;
     • гучно на проді (33 рядки `attrs:`) — B6, B7, B13; їхня ціна — МІСЦЕ
       ЛОВУ (було після накату, стало до), а не наявність сторожа;
     • B9 — вердикт червоний, але без імен; B11/B12 — лише `npm test`.
   ⚠️ НАЗВАНИЙ БОРГ: із шести полевих пінів фальсифіковано ЧОТИРИ (`;cfg=` B6,
   `secdef=` B7, `;owner=` B11, `;acl=` B4). `;vol=` і `;lang=` — гарди без
   названого червоного тесту; їхня форма дослівно збігається з формою `;cfg=`,
   і саме тому позиції на них немає. Це борг, а не покриття.
   N1/N2 — НАЗВАНІ дірки (зелені навмисно), T1 — рефакторний контроль. */
const EXPECTED_RED = 21;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. Стенд НЕ прогнано.`);
  process.exit(1);
}

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [] }; }
  const red = [], all = [];
  for (const f of r.testResults || []) {
    for (const a of f.assertionResults || []) {
      const n = a.fullName || a.title;
      all.push(n);
      if (a.status !== "passed") red.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
try {
  const base = run();
  lines.push(`# Стенд фальсифікації пакета 41 — №19 і джерело кейса (RF-01)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const eds = editsOf(m).map((e) => ({ ...e, path: FILES[e.file], src: readFileSync(FILES[e.file], "utf8") }));
      const dead = eds.find((e) => e.src.split(e.from).length - 1 !== 1);
      if (dead) {
        const n = dead.src.split(dead.from).length - 1;
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}) у ${dead.path} | ⛔ відхилено |`);
        continue;
      }
      const cur = {};
      for (const e of eds) {
        const base2 = cur[e.path] ?? e.src;
        cur[e.path] = base2.replace(e.from, () => e.to);
      }
      for (const [p, txt] of Object.entries(cur)) writeFileSync(p, txt);
      const res = run();
      for (const e of eds) writeFileSync(e.path, e.src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const fact = gotRed ? res.red.map((t) => `«${t}»`).join("; ") : "усе зелене";
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ спек"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
      const want = wantRed ? `ЧЕРВОНЕ: ${m.expect.source}` : "ЗЕЛЕНЕ";
      lines.push(`| ${m.id} | ${m.what} | ${want} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
    ok: !(!verdict.ok),
    red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
  });
}
