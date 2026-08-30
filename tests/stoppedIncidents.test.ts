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

  /** Міграції, новіші за `after`, у тексті яких згадується RPC аварійної зупинки. */
  const mentionsAfter = (after: string) =>
    readdirSync(resolve(process.cwd(), MIG_DIR))
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f > after)
      .filter((f) => /emergency_stop_rpc/.test(
        readFileSync(resolve(process.cwd(), MIG_DIR, f), "utf8")));

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
