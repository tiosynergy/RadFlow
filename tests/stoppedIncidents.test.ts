/* U-56 (с49) — журнал аварійної зупинки більше не тримається на ДРУГОМУ читанні.
 *
 * ЧОМУ ЦЕ БУВ БОРГ. `emergency_stop_rpc` створює інциденти всередині своєї
 * транзакції, але id-шників не віддавала. Тому `emergencyStop` читав їх окремим
 * запитом одразу після успіху — і саме на цьому читанні U-17 знайшов єдиний
 * fail-open, наслідок якого пишеться в БД, а не показується на екрані: збій
 * читання давав НУЛЬ подій журналу про зупинку, яка вже сталася і закомічена.
 * U-17 зробив втрату гучною. 0168 прибрав саму залежність.
 *
 * ЩО ЛИШИЛОСЬ. Біда КОНТРАКТНА, а не мережева: нова збірка може опинитись перед
 * СТАРОЮ базою (відкат міграції під задеплоєним кодом), або майбутня міграція
 * перепише ключ у `jsonb_build_object`. Тоді поля немає або воно не читається —
 * і мовчазний `?? []` дав би рівно ту саму втрату, з іншого боку.
 *
 * ⚠️ Тести ПОВЕДІНКОВІ (виклик), а не регулярки по тексту дії: пін «розбір і
 * гілка на сусідніх рядках» не ловить найдешевшу диверсію — зайвий `return`
 * МІЖ ними (урок U-13/U-18). Статичні піни живуть окремо і стережуть інше:
 * що другого читання в дії справді НЕМАЄ (`tests/roomModalityRead.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { readStoppedIncidents, stoppedIncidentsGap } from "@/lib/incidents";

const MIG_DIR = "supabase/migrations";
const MIG_0168 = "0168_emergency_stop_returns_incident_ids.sql";

describe("readStoppedIncidents — «немає поля» ≠ «немає інцидентів»", () => {
  it("поля немає взагалі → absent, а не «порожньо»", () => {
    /* Головний випадок: стара база під новою збіркою. */
    expect(readStoppedIncidents(undefined))
      .toEqual({ incidents: [], absent: true, dropped: 0, roomless: 0 });
    expect(readStoppedIncidents(null).absent).toBe(true);
  });

  it("не масив → absent, а не «порожньо»", () => {
    /* `"[]"` окремо від `{}`: якщо клієнт колись віддасть jsonb рядком,
       порожній масив і рядок «[]» мусять розрізнятись. */
    expect(readStoppedIncidents({}).absent).toBe(true);
    expect(readStoppedIncidents("[]").absent).toBe(true);
    expect(readStoppedIncidents(0).absent).toBe(true);
  });

  it("порожній масив — ЗАКОННА відповідь «створювати не було чого»", () => {
    /* Так виглядає зупинка кабінетів, у яких уже був активний простій:
       `on conflict do nothing` не створює нічого. Це не втрата. */
    expect(readStoppedIncidents([]))
      .toEqual({ incidents: [], absent: false, dropped: 0, roomless: 0 });
  });

  it("пара розбирається як є", () => {
    expect(readStoppedIncidents([{ id: "i1", roomId: "r1" }, { id: "i2", roomId: "r2" }]))
      .toEqual({
        incidents: [{ id: "i1", roomId: "r1" }, { id: "i2", roomId: "r2" }],
        absent: false, dropped: 0, roomless: 0,
      });
  });

  it("зіпсований елемент відкидається, РЕШТА лишається", () => {
    /* ⚠️ Ревʼю U-56 спіймало першу редакцію: там перший непридатний елемент
       повертав `null` на весь масив. При зупинці двадцяти кабінетів один
       битий елемент коштував би всіх девʼятнадцяти подій — лікування дорожче
       за хворобу. Тепер відкинуте рахується, а решта пишеться. */
    const r = readStoppedIncidents([
      { id: "i1", roomId: "r1" }, { roomId: "r2" }, { id: "", roomId: "r3" },
      { id: 42, roomId: "r4" }, null, { id: "i5", roomId: "r5" },
    ]);
    expect(r.incidents).toEqual([{ id: "i1", roomId: "r1" }, { id: "i5", roomId: "r5" }]);
    expect(r.dropped).toBe(4);
    expect(r.absent).toBe(false);
  });

  it("кабінет без roomId подію НЕ скасовує, але й не підміняється порожнім рядком", () => {
    /* Асиметрія навмисна: `entityId` тримає id інциденту, а `roomId` іде в
       `details`. Подія без деталі корисна; події без сутності не буває.
       ⚠️ Але `""` у журналі виглядав би як «кабінет відомий, ось він», і
       запит «які кабінети зупиняли» тихо згрупував би всі аварії під ним. */
    const r = readStoppedIncidents([{ id: "i1" }, { id: "i2", roomId: "" }]);
    expect(r.incidents).toEqual([{ id: "i1", roomId: null }, { id: "i2", roomId: null }]);
    expect(r.roomless).toBe(2);
    expect(r.dropped).toBe(0);
  });
});

describe("stoppedIncidentsGap — коли журнал виходить неповним", () => {
  const read = (o: Partial<ReturnType<typeof readStoppedIncidents>>) => ({
    incidents: [], absent: false, dropped: 0, roomless: 0, ...o,
  });

  it("поля немає → absent_in_rpc", () => {
    expect(stoppedIncidentsGap(read({ absent: true }), 3)).toBe("incidents_absent_in_rpc");
    expect(stoppedIncidentsGap(read({ absent: true }), 0)).toBe("incidents_absent_in_rpc");
  });

  it("елементи не читаються → malformed, а НЕ absent", () => {
    /* ⚠️ Ревʼю U-56: перша редакція злила ці дві причини в один код із текстом
       «стара база?». Перейменований ключ у майбутній міграції давав би цей
       текст на СВІЖІЙ базі, і черговий, побачивши 0168 у леджері, вирішив би,
       що бреше лог. Причини різні — і фікси в них різні. */
    expect(stoppedIncidentsGap(read({ dropped: 1, incidents: [{ id: "i", roomId: "r" }] }), 2))
      .toBe("incidents_malformed_in_rpc");
  });

  it("причина переважає над симптомом: битий елемент дає malformed, не short", () => {
    /* `dropped > 0` майже завжди тягне за собою і «менше, ніж зупинили».
       Назвати треба ПРИЧИНУ, інакше лог указує на наслідок. */
    expect(stoppedIncidentsGap(read({ dropped: 1 }), 5)).toBe("incidents_malformed_in_rpc");
  });

  it("менше, ніж зупинили → short_in_rpc", () => {
    expect(stoppedIncidentsGap(read({ incidents: [] }), 3)).toBe("incidents_short_in_rpc");
    expect(stoppedIncidentsGap(read({
      incidents: [{ id: "a", roomId: "r" }, { id: "b", roomId: "r" }],
    }), 3)).toBe("incidents_short_in_rpc");
  });

  it("події є, але без кабінету → no_room_in_rpc", () => {
    /* Найтихіша з чотирьох бід: довжина правильна, gap мовчав би, і журнал
       назавжди дістав би N подій «зупинив кабінет» без кабінету. */
    expect(stoppedIncidentsGap(read({
      incidents: [{ id: "a", roomId: null }], roomless: 1,
    }), 1)).toBe("incidents_no_room_in_rpc");
  });

  it("усе на місці → мовчимо", () => {
    expect(stoppedIncidentsGap(read({
      incidents: [{ id: "a", roomId: "r" }, { id: "b", roomId: "r2" }],
    }), 2)).toBeNull();
    expect(stoppedIncidentsGap(read({}), 0)).toBeNull();
    /* Більше, ніж зупинили, — не привід кричати: дублікати неможливі
       (частковий унікальний індекс `incidents_one_active_per_room`, 0017). */
    expect(stoppedIncidentsGap(read({
      incidents: [{ id: "a", roomId: "r" }, { id: "b", roomId: "r2" }],
    }), 1)).toBeNull();
  });
});

describe("контракт 0168 — те, що обіцяє міграція, і те, що читає код", () => {
  const mig = readFileSync(resolve(process.cwd(), MIG_DIR, MIG_0168), "utf8");
  const types = readFileSync(resolve(process.cwd(), "supabase/types.ts"), "utf8");

  it("міграція віддає саме `stopped_incidents`, і саме як jsonb", () => {
    expect(mig).toMatch(/returns table\(stopped int, affected int, stopped_rooms uuid\[\],\s*\n?\s*stopped_incidents jsonb, patients jsonb\)/);
  });

  it("ключі елемента — `id` і `roomId`, як їх читає lib/incidents", () => {
    /* Розбіжність у ЛІТЕРАЛІ ключа не впаде ні в TS, ні в SQL. `roomId` →
       `room_id` дало б N подій без кабінету (тепер це хоч кричить кодом
       `no_room_in_rpc`), а `id` → щось інше — нуль подій. */
    expect(mig).toMatch(/jsonb_build_object\('id', id, 'roomId', room_id\)/);
  });

  /** Міграції, новіші за `after`, у КОДІ яких згадується RPC аварійної зупинки.
   *
   *  ⚠️ КОМЕНТАРІ ЗРІЗАЮТЬСЯ, і це не зручність, а урок с63 (№7), який цей
   *  пін спіймав на собі в с65. Міграція 0190 не чіпає `emergency_stop_rpc`
   *  ЖОДНИМ рядком коду — вона лише НАЗИВАЄ її в шапці, у списку definer-
   *  функцій, які повертають ПІБ і досі не піновані. Пін почервонів на
   *  чесному коментарі про сусідній борг, тобто карав за те, заради чого його
   *  й писали: за те, що ризик названо вголос.
   *  Симетрія тут повна: пін, який МОЖНА задовольнити коментарем, — брехня;
   *  пін, який коментар МОЖЕ зламати, — шум. Обидва лікуються одним — читати
   *  КОД, а не текст. Зелений базис нижче не постраждав: 0109 і 0168
   *  перевизначають функцію саме кодом.
   *
   *  ⚠️ З с68 ЗРІЗАЄТЬСЯ ЩЕ Й РЯДОК СПИСКУ ДАЙДЖЕСТІВ №19 — той самий клас,
   *  що вище, на поверх глибше. 0192 додала `emergency_stop_rpc` у СПИСОК
   *  перевірки №19: рядок
   *      ('emergency_stop_rpc(…)','ac62900b…','secdef=true;…')
   *  усередині тіла сторожа. Це не перевизначення функції — це ПІН на її
   *  тіло, тобто рівно те, чого цей describe і хотів для сусідніх definer-
   *  функцій. Голе імʼя червоніло на тому, що функцію взяли під дайджест.
   *
   *  ⚠️ ДВА НЕПРАВИЛЬНИХ ЛІКУВАННЯ, ОБИДВА ВІДКИНУТІ ЗАМІРОМ. Пишу їх тут,
   *  бо обидва виглядають очевидними і наступний піде по тих самих граблях.
   *
   *  (1) «зрізати ВСІ рядкові літерали» — літерал же ДАНІ, а не код. Зріз
   *      `/'(?:''|[^'])*'/` дав розсинхрон на **14 із 194** файлів міграцій:
   *      `--` усередині літерала зʼїдається ПЕРШИМ проходом разом із
   *      закривальною лапкою, далі пари зсуваються на одну, і зріз починає
   *      вигризати КОД. Тобто ліки тихо перетворювали сторожа на декорацію.
   *
   *  (2) «шукати не імʼя, а ОПЕРАТОР» (`create|drop|alter function`,
   *      `grant|revoke execute on function`). Виглядало строго кращим — і
   *      було ВУЖЧИМ за старий детектор саме на домашньому ідіомі цього
   *      репозиторію. ЗАМІР: `drop function if exists public.emergency_stop_rpc`
   *      трапляється в `0168_emergency_stop_returns_incident_ids.sql` ДВІЧІ
   *      (рядки 73 і 331) — тобто у файлі, чий контракт цей пін і стереже, —
   *      і жодна з тих двох форм під «оператор» не підпадала (`if exists`
   *      стоїть МІЖ `function` і іменем). Майбутня міграція, яка лише
   *      ВИДАЛЯЄ функцію, лишала б пін зеленим. Туди ж: `revoke all on
   *      function`, `grant execute on ROUTINE`, `alter function … rename to`,
   *      лапковані ідентифікатори і динамічний `format('create … %I')`.
   *
   *  ЛІКУВАННЯ, ЩО ЛИШИЛОСЬ — ВУЗЬКЕ ВИКЛЮЧЕННЯ ОДНІЄЇ ФОРМИ. Сітка лишається
   *  широкою (голе імʼя), а зрізається РІВНО рядок списку дайджестів, який
   *  розпізнається за формою, неможливою в жодному DDL:
   *      ('<імʼя>(<аргументи без дужок>)','<32 hex>','<attrs без лапок>')
   *  Це дешевше і безпечніше за обидва варіанти вище: лапки не парсяться
   *  (шаблон самообмежений), а все, що ловив старий детектор — `drop function
   *  if exists`, `revoke all`, `rename to`, динамічний SQL — ловиться далі.
   *  ⚠️ Ціна названа: якщо у майбутнього підпису в списку зʼявиться ВКЛАДЕНА
   *  дужка в аргументах, шаблон його не зріже і пін почервоніє. Це ГУЧНА і
   *  правильна відмова — тоді треба розширити шаблон, а не послаблювати пін.
   *  ⚠️ Зелений базис перезнято після заміни: детектор і далі знаходить усі
   *  реальні файли, серед них обидва з базису нижче (0109 і 0168).
   */
  const sqlCode = (txt: string) =>
    txt
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      // рядок списку дайджестів №19 — ДАНІ, не оператор (див. шапку)
      .replace(/\('[a-z_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\)/g, " ");
  const mentionsAfter = (after: string) =>
    readdirSync(resolve(process.cwd(), MIG_DIR))
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f > after)
      .filter((f) => /emergency_stop_rpc/.test(
        sqlCode(readFileSync(resolve(process.cwd(), MIG_DIR, f), "utf8"))));

  it("механізм піна робочий: до 0109 функцію справді чіпали пізніші міграції", () => {
    /* ⚠️ Без цієї половини наступний пін НЕ фальсифікується: «нічого не
       знайдено» — його ж і очікуваний результат, тож зламаний пошук (не той
       каталог, не та регулярка, не те порівняння) лишався б ЗЕЛЕНИМ і виглядав
       би доказом. Тут той самий пошук ганяється на порозі, де відповідь
       ВІДОМА і НЕ порожня (фальсифікація N27). */
    const known = mentionsAfter("0108");
    expect(known, "пошук по міграціях зламався — наступний пін вакуумний")
      .toContain("0109_case_status_serialization.sql");
    expect(known).toContain(MIG_0168);
  });

  it("ЖОДНА міграція, новіша за 0168, не перевизначає emergency_stop_rpc", () => {
    /* ⚠️ Головний пін цього describe, і він зʼявився з ревʼю. Решта пінів
       прибиті до тексту ВЖЕ НАКАТАНОГО файла, а накатані міграції не
       редагують — отже вони не можуть почервоніти від майбутньої зміни.
       Тим часом цю функцію перевизначали вже в 0054, 0073, 0076, 0083, 0109,
       0168: наступний `create or replace` із ключем `'room_id'` замість
       `'roomId'` (природна помилка — решта SQL оперує саме `room_id`) лишив
       би ВСІ тести зеленими, а журнал тихо втрачав би кабінети.
       Пастка 0122 — це рівно «пізніша міграція мовчки скасувала рішення
       попередньої»; тут ми робимо її неможливою мовчки. */
    expect(mentionsAfter(MIG_0168),
      "новіша міграція торкається emergency_stop_rpc — перевірте ключі "
      + "'id'/'roomId' і ACL, і оновіть цей пін свідомо").toEqual([]);
  });

  it("зріз рядка списку №19 не засліпив детектор на жодній формі DDL", () => {
    /* ⚠️ СИНТЕТИЧНИЙ КОНТРОЛЬ, доданий у с68 разом зі зрізом рядка списку.
       Пін вище доводить ВІДСУТНІСТЬ — а відсутність однаково добре доводить
       і ЗАСЛІПЛЕНИЙ детектор. Базис «до 0109» ганяє пошук на реальних
       файлах, але НОВОЇ дірки не побачив би: зріз, що звузив сітку, лишив би
       0109 і 0168 знайденими (у них є звичайний `create function`), а
       міграцію, яка робить із функцією ЩОСЬ ІНШЕ, проґавив би.
       ⚠️ КОЖЕН рядок нижче — це форма, на якій попередня редакція цього
       детектора (позитивний «оператор») РЕАЛЬНО падала, а не вигадка:
       `drop function if exists` стоїть у 0168 двічі, а `revoke all on
       function` і `on routine` — домашні ідіоми репозиторію.
       ⚠️ Тексти синтетичні: імʼя `probe_fn` у схемі не існує (звірено). */
    const asPin =
      "      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)',"
      + "'ac62900bdcd7d5cd689f5aa9066d99b9','secdef=true;vol=v'),";
    const asComment = "-- emergency_stop_rpc досі віддає ПІБ, і це названий борг";

    const seen = (txt: string) => /emergency_stop_rpc/.test(sqlCode(txt));

    // ДАНІ — не мусять бути видимі
    expect(seen(asPin), "пін у списку №19 — це ДАНІ, не операція").toBe(false);
    expect(seen(asComment), "чесний коментар про борг — не операція").toBe(false);

    // ОПЕРАЦІЇ — кожна мусить лишатись видимою
    const mustSee: readonly (readonly [string, string])[] = [
      ["create or replace", "create or replace function public.emergency_stop_rpc(p uuid[]) returns jsonb language sql as $probe_fn$ select 1 $probe_fn$;"],
      ["drop if exists (форма 0168)", "drop function if exists public.emergency_stop_rpc(uuid[], date, text);"],
      ["drop без public", "drop function emergency_stop_rpc(uuid[], date, text);"],
      ["revoke all on function", "revoke all on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;"],
      ["revoke execute", "revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon;"],
      ["grant on routine", "grant execute on routine public.emergency_stop_rpc(uuid[], date, text) to authenticated;"],
      ["alter ... rename to", "alter function public.old_stop_rpc(uuid[]) rename to emergency_stop_rpc;"],
      ["alter owner", "alter function public.emergency_stop_rpc(uuid[], date, text) owner to postgres;"],
      ["динамічний SQL", "execute 'create or replace function public.emergency_stop_rpc(p uuid[]) returns jsonb language sql as $q$ select 1 $q$';"],
    ];
    for (const [label, sql] of mustSee) {
      expect(seen(sql), `${label}: ця форма МУСИТЬ лишатись видимою детектору`).toBe(true);
    }

    /* І головне, і це НЕ тавтологія: перевизначення, що стоїть ПОРУЧ із
       піном, не маскується ним. Перевіряємо на формі, якої попередня
       редакція НЕ бачила взагалі, — тобто рядок падає, якщо зріз зʼїв
       більше, ніж рядок списку. */
    expect(seen(`${asPin}\n${asComment}\n${mustSee[1][1]}`),
      "видалення функції поруч із піном маскується — зріз зʼїв зайве")
      .toBe(true);
  });

  it("обидва агрегати впорядковані — відповідь відтворювана", () => {
    /* ⚠️ Ревʼю U-56 виправило первісне обґрунтування: пара кабінет↔інцидент
       лежить УСЕРЕДИНІ обʼєкта і від порядку не залежить. Порядок дає інше —
       відтворюваність відповіді й детермінований `roomIds` в `event_outbox`. */
    expect(mig).toMatch(/array_agg\(room_id order by room_id\)/);
    expect(mig).toMatch(/jsonb_agg\(jsonb_build_object\('id', id, 'roomId', room_id\)\s*\n?\s*order by room_id\)/);
  });

  it("revoke після drop+create на місці — інакше спрацює пастка 0122", () => {
    /* Заміряно на живій базі: drop+create БЕЗ revoke дає EXECUTE і `anon`,
       і PUBLIC (default ACL схеми public). Порядок важливий: revoke мусить
       стояти ПІСЛЯ create, інакше він відкликає право у ще не створеної.
       Пошук РЕГУЛЯРКОЮ, а не indexOf по літералу: інакше пін тримався б на
       кількості пробілів у вирівнюванні `grant  execute`. */
    const iCreate = mig.search(/create function public\.emergency_stop_rpc/);
    const iRevoke = mig.search(/revoke\s+execute on function public\.emergency_stop_rpc/);
    const iGrant = mig.search(/grant\s+execute on function public\.emergency_stop_rpc/);
    expect(iCreate, "create не знайдено").toBeGreaterThan(-1);
    expect(iRevoke, "revoke після drop+create загубився — пастка 0122").toBeGreaterThan(iCreate);
    expect(iGrant, "authenticated лишився б без EXECUTE").toBeGreaterThan(iRevoke);
    expect(mig.slice(iRevoke, iRevoke + 200)).toMatch(/from anon, public;/);
    expect(mig.slice(iGrant, iGrant + 200),
      "service_role більше не грантується явно — ACL знову заручник дефолту")
      .toMatch(/to authenticated, service_role;/);
  });

  it("ACL перевіряється В ТІЙ САМІЙ транзакції, а не лише смоуком", () => {
    /* Ревʼю U-56 (MAJOR): без ассерта міграція комітилась незалежно від того,
       яким ACL вийшов насправді, а доказ жив у файлі, який запускають руками.
       На середовищі з іншим default ACL пастка пережила б накат. */
    const acl = mig.slice(mig.indexOf("do $acl$"), mig.indexOf("$acl$;") + 6);
    expect(acl.length, "блоку-ассерта ACL немає").toBeGreaterThan(200);
    for (const probe of [
      /has_function_privilege\('anon'/, /a\.grantee = 0/,
      /has_function_privilege\('authenticated'/, /has_function_privilege\('service_role'/,
    ]) expect(acl, `ассерт втратив зонд ${probe}`).toMatch(probe);
    expect(mig.indexOf("do $acl$"), "ассерт стоїть ПІСЛЯ commit — він нічого не відкотить")
      .toBeLessThan(mig.indexOf("\ncommit;"));
  });

  it("згенеровані типи знають про нову колонку", () => {
    expect(types).toMatch(/stopped_incidents: Json;/);
  });
});
