/* U-18 + U-17 (аудит 2026-08-27, закрито в с49) — «не читали» ≠ «все гаразд».
 *
 * ── U-18. `studiesRoomMismatch` у `app/queue/actions.ts` читав кабінет так:
 *     const { data } = await supabase.from("rooms").select("modality")…
 *     return !studiesMatchModality(studies, data?.modality ?? null);
 * `error` не звʼязували ВЗАГАЛІ. А `studiesMatchModality` свідомо поблажлива до
 * `null` — кабінет `OTHER` не має каталогу областей. Отже збій читання приходив
 * тим самим значенням, що й «кабінет без каталогу», і читався як «розбіжності
 * немає». Заміряно на проді 2026-08-30: `rooms.modality` NOT NULL, рядків із
 * `null` — 0; чужою клінікою рядок читається як 0 рядків БЕЗ помилки.
 *
 * ⚠️ ЧОГО ЦЕ НЕ КОШТУВАЛО — і це головна правка ревʼю р2. Перша редакція цього
 * файлу стверджувала, що користувач діставав «сиру помилку тригера». Неправда:
 * `classifyError` і `mapBookingError` ловлять `MODALITY_MISMATCH` і віддають ТОЙ
 * САМИЙ дружній текст. Видимий наслідок дефекту дорівнював нулю.
 * Втрачалось інше: прикладна перевірка МОВЧКИ переставала існувати, і
 * правильність трималась на одному тригері 0088 — глибина оборони тихо ставала
 * глибиною в один шар. Тому лікування — не «відмовити», а зробити зникнення
 * рубежу ВИДИМИМ; відмова лишилась тільки там, де запис і так не пройде.
 *
 * ── U-17. У `emergencyStop` було `const { data: incs }` і далі `incs ?? []`:
 * збій читання давав НУЛЬ подій журналу про зупинку, яка вже сталася і
 * закомічена в RPC. Заміряно: конкурентне зняття аварії дає 0 рядків БЕЗ
 * помилки — тобто гілка була досяжна мовчки.
 *
 * ⚠️ Чому тести ПОВЕДІНКОВІ, а не регулярки по файлу (ревʼю р2): поки рішення
 * жило всередині серверної дії, пін «виклик і розбір на сусідніх рядках» не
 * ловив найдешевшу диверсію — зайвий `return` МІЖ розбором і гілкою рішення.
 * Рішення винесені в чисті `modalityVerdict` / `stoppedIncidentsGap`, і така
 * вставка стала неможливою за побудовою.
 *
 * ⚠️ U-56 (0168): блок про `incidentGapCode` звідси ПІШОВ разом із самою
 * функцією. Вона обирала код між трьома причинами неповного журналу аварійної
 * зупинки, поки id-шники читались ОКРЕМИМ запитом; тепер їх віддає сама
 * `emergency_stop_rpc`, і причина лишилась одна — контрактна. Наступниця
 * (`stoppedIncidentsGap` + `readStoppedIncidents`, `lib/incidents.ts`) має свій
 * файл тестів `tests/stoppedIncidents.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";
import {
  readRoomModality, studiesMatchModality, modalityVerdict,
} from "@/lib/studies";

const ACTIONS = "app/queue/actions.ts";
const code = codeOf(readFileSync(resolve(process.cwd(), ACTIONS), "utf8"));

describe("readRoomModality — чотири відповіді, а не дві", () => {
  it("помилка читання → не знаємо (reason: error)", () => {
    expect(readRoomModality({ data: null, error: { message: "boom" } }))
      .toEqual({ known: false, reason: "error" });
    /* Помилка ПЕРЕВАЖАЄ над даними: PostgREST може віддати і те, і те. */
    expect(readRoomModality({ data: { modality: "MRI" }, error: { message: "boom" } }))
      .toEqual({ known: false, reason: "error" });
  });

  it("відповіді немає взагалі → не знаємо (а не throw)", () => {
    expect(readRoomModality(null)).toEqual({ known: false, reason: "error" });
    expect(readRoomModality(undefined)).toEqual({ known: false, reason: "error" });
  });

  it("порожній рядок (RLS сховала кабінет або його видалили) → missing", () => {
    expect(readRoomModality({ data: null, error: null }))
      .toEqual({ known: false, reason: "missing" });
  });

  it("порожнє значення в ПРОЧИТАНОМУ рядку → empty, а не missing", () => {
    /* Колонка NOT NULL (заміряно), тож `null` звідси означає зміну схеми, а не
       кабінет без каталогу — той приходить рядком 'OTHER'.
       ⚠️ Причина саме `empty` (ревʼю р1): рядок ПРОЧИТАНО, тож порада «оновіть
       форму» була б неправдою — оновлення нічого не змінить. */
    for (const m of [null, undefined, ""]) {
      expect(readRoomModality({ data: { modality: m }, error: null }))
        .toEqual({ known: false, reason: "empty" });
    }
  });

  it("значення прочитано → знаємо", () => {
    expect(readRoomModality({ data: { modality: "MRI" }, error: null }))
      .toEqual({ known: true, modality: "MRI" });
    /* OTHER — ЛЕГІТИМНЕ значення, а не незнання: кабінет без каталогу. */
    expect(readRoomModality({ data: { modality: "OTHER" }, error: null }))
      .toEqual({ known: true, modality: "OTHER" });
  });
});

describe("modalityVerdict — рішення гейта, перевірене ВИКЛИКОМ", () => {
  const CT = [{ type: "КТ" }];

  it("розбіжність — це mismatch", () => {
    expect(modalityVerdict({ data: { modality: "MRI" }, error: null }, CT)).toBe("mismatch");
  });

  it("збіг і кабінет без каталогу — ok", () => {
    expect(modalityVerdict({ data: { modality: "CT" }, error: null }, CT)).toBe("ok");
    expect(modalityVerdict({ data: { modality: "OTHER" }, error: null }, CT)).toBe("ok");
    expect(modalityVerdict({ data: { modality: "MRI" }, error: null }, [])).toBe("ok");
    expect(modalityVerdict({ data: { modality: "MRI" }, error: null }, null)).toBe("ok");
  });

  it("зниклий рядок — gone (відмова: запис і так не пройде)", () => {
    expect(modalityVerdict({ data: null, error: null }, CT)).toBe("gone");
  });

  it("аномалія значення — empty (відмова)", () => {
    expect(modalityVerdict({ data: { modality: null }, error: null }, CT)).toBe("empty");
  });

  it("транзієнт — unreadable, і це НЕ mismatch і НЕ ok", () => {
    /* Ключове розрізнення пакета: раніше цей випадок був невідрізнимий від
       «розбіжності немає». Тепер він має власне імʼя, і місце виклику саме
       вирішує, що з ним робити. */
    expect(modalityVerdict({ data: null, error: { message: "boom" } }, CT)).toBe("unreadable");
    expect(modalityVerdict(null, CT)).toBe("unreadable");
    expect(modalityVerdict(undefined, CT)).toBe("unreadable");
  });

  it("незнання НІКОЛИ не дає ok — на жодному складі", () => {
    /* Антирегрес рівно на дефект: `ok` при незнанні і був «розбіжності немає». */
    for (const studies of [CT, [{ type: "МРТ" }], [], null, undefined, "сміття"]) {
      for (const res of [null, undefined,
                         { data: null, error: { message: "x" } },
                         { data: null, error: null },
                         { data: { modality: "" }, error: null }]) {
        expect(modalityVerdict(res as never, studies as never),
          `ok при незнанні: res=${JSON.stringify(res)}`).not.toBe("ok");
      }
    }
  });
});

describe("сам інваріант не пом'якшено і не посилено", () => {
  /* Антирегрес на «полікували читання, заразом зламали продукт».
     ⚠️ Перша редакція цих перевірок була ДЕКОРАТИВНОЮ, і спіймала це
     фальсифікація (N05): я підставляв `type: "КТ голови"` — це ОБЛАСТЬ, а поле
     `studies[].type` тримає МІТКУ модальності («КТ», «МРТ»). Невідому мітку
     `modalityCode` нормалізує в "OTHER", тож обидві перевірки проходили повз
     логіку. Мітки нижче — з реєстру MODALITIES. */
  it("OTHER і порожній склад — і далі без обмежень (дзеркало 0088)", () => {
    expect(studiesMatchModality([{ type: "КТ" }], "OTHER")).toBe(true);
    expect(studiesMatchModality([], "MRI")).toBe(true);
    expect(studiesMatchModality(null, "MRI")).toBe(true);
  });

  it("розбіжність і далі розбіжність, а збіг — збіг", () => {
    expect(studiesMatchModality([{ type: "КТ" }], "MRI")).toBe(false);
    expect(studiesMatchModality([{ type: "МРТ" }], "MRI")).toBe(true);
  });
});

describe("app/queue/actions.ts — гейт модальності", () => {
  const at = code.indexOf("async function modalityGate");
  const gate = at >= 0 ? code.slice(at, code.indexOf("\n}", at)) : "";

  it("старої функції-пастки більше немає", () => {
    /* Імʼя `studiesRoomMismatch` повертало BOOLEAN, тобто в самій сигнатурі не
       було місця для «не знаємо». Поки воно живе, дефект можна відновити одним
       викликом. */
    expect(code).not.toMatch(/studiesRoomMismatch/);
    expect(code).not.toMatch(/data\?\.modality\s*\?\?\s*null/);
  });

  it("читає САМЕ той кабінет і саме одним рядком", () => {
    /* ⚠️ Ревʼю р2: перша редакція мала `[^\n]*` замість ланцюжка фільтрів, і
       зеленими лишались `.eq("active", true)` (вимкнений кабінет → «не
       знайдено»), `.single()` замість `.maybeSingle()` (порожній рядок → чужа
       причина) і взагалі відсутність `.eq("id", …)`. */
    expect(gate.length, "тіла гейта не знайдено — тест застарів").toBeGreaterThan(100);
    expect(gate).toMatch(
      /const res = await supabase\.from\("rooms"\)\.select\("modality"\)\.eq\("id", roomId\)\.maybeSingle\(\);/,
    );
  });

  it("рішення НЕ дублюється в дії — гейт лише мапить вердикт", () => {
    /* Якби гілки жили тут, вони знову перевірялись би регулярками. Тіло гейта
       мусить бути тонким: одне читання, один switch, жодної власної логіки. */
    expect(gate).toMatch(/switch \(modalityVerdict\(res, studies\)\) \{/);
    expect(gate).not.toMatch(/readRoomModality|studiesMatchModality/);
    for (const v of ["mismatch", "gone", "empty", "unreadable"]) {
      expect(gate, `гілка ${v} зникла`).toMatch(new RegExp(`case "${v}":`));
    }
  });

  it("транзієнт НЕ рве потік, але й НЕ мовчить", () => {
    /* Головне рішення пакета після ревʼю р2. Відмова тут коштувала б
       користувачеві дії, нічого не додавши: тригер 0088 і так стереже. Але
       зникнення другого рубежу мусить бути видимим. */
    const un = gate.slice(gate.indexOf('case "unreadable":'));
    expect(un).toMatch(/logError\(\{/);
    expect(un).toMatch(/errorCode: "room_modality_unreadable"/);
    expect(un).toMatch(/return null;/);
    expect(un, "транзієнт знову відмовляє — це регрес, а не лікування")
      .not.toMatch(/ROOM_UNREADABLE_ERR|ROOM_GONE_ERR|MODALITY_MISMATCH_ERR/);
  });

  it("тексти відмов різні, і код не «forbidden»", () => {
    expect(code).toMatch(/const ROOM_UNREADABLE_ERR: QueueActionResult = \{\s*ok: false, error: "Не вдалося перевірити кабінет/);
    expect(code).toMatch(/const ROOM_GONE_ERR: QueueActionResult = \{\s*ok: false, error: "Кабінет не знайдено/);
    /* ⚠️ Ревʼю р2: перша редакція цього піна вимагала `", code:` в один рядок,
       і переніс коду на новий рядок обходив заборону. Дивимось у вікні. */
    expect(code, "ROOM_GONE_ERR із кодом forbidden — текст підмінить ReferralPortal")
      .not.toMatch(/"Кабінет не знайдено[\s\S]{0,160}?code: "forbidden"/);
  });
});

describe("app/queue/actions.ts — гейт кличуть усі шляхи запису", () => {
  /* ⚠️ Ревʼю р2: перша редакція рахувала входження і вимагала рівно 5. Такий
     сторож антикорельований із власною метою: шостий шлях БЕЗ гейта лишав
     число 5 (зелено), а шостий шлях З гейтом давав 6 і повідомлення «кличуть
     не в усіх пʼяти» — тобто брехню. Тепер перевіряємо ІМЕНА функцій. */
  const EXPECTED = [
    "rescheduleQueueEntry", "editQueueEntryStudies", "createBooking",
    "scheduleFromWaitlist", "createReferralBooking",
  ];

  /** У якій експортованій функції стоїть кожен виклик гейта. */
  function callersOf(re: RegExp): string[] {
    const out: string[] = [];
    for (const m of code.matchAll(re)) {
      const before = code.slice(0, m.index ?? 0);
      const fn = [...before.matchAll(/export async function (\w+)/g)].pop();
      out.push(fn ? fn[1] : "<поза експортованою дією>");
    }
    return [...new Set(out)].sort();
  }

  it("виклик стоїть рівно в тих діях, що пишуть кабінет і склад", () => {
    const callers = callersOf(/const mg = await modalityGate\(/g);
    expect(callers,
      "перелік дій із гейтом розійшовся: новий шлях запису або лишився без гейта, "
      + "або зʼявився і його треба внести сюди СВІДОМО, а не підправити число")
      .toEqual([...EXPECTED].sort());
  });

  it("кожен виклик негайно зупиняє потік", () => {
    /* Виклик без `return` — це обчислення, яке нічого не гейтить (урок U-13). */
    const calls = code.match(/const mg = await modalityGate\(/g) || [];
    const pairs = code.match(/const mg = await modalityGate\([^;]*\);\s*if \(mg\) return mg;/g) || [];
    expect(pairs.length, "є виклик гейта без негайного `return`").toBe(calls.length);
    expect(calls.length).toBeGreaterThanOrEqual(EXPECTED.length);
  });

  it("жоден виклик не сховано в мертву гілку", () => {
    /* `if (false) { … }` лишає текст на місці — саме цим класом проект уже
       обпікався (U-20/U-30/U-15). */
    expect(code).not.toMatch(/if \(false\)[\s\S]{0,200}?modalityGate/);
  });
});

describe("app/queue/actions.ts — слід аварійної зупинки (U-17)", () => {
  /* ⚠️ Вікно ОБМЕЖЕНЕ кінцем самої дії, а не «плюс N символів»: перша редакція
     брала 2500 символів і заїжджала в сусідню `resolveEmergency`, де
     `return { ok: false` є законно (той самий клас, що body-scoped сторож
     U-33). Придатність вікна перевіряє КОЖЕН тест нижче, а не сусідній — інакше
     видалення одного тесту зробило б решту вакуумними (ревʼю р2). */
  const at = code.indexOf("const stoppedCount");
  const end = code.indexOf("return { ok: true, stopped:", at);
  const block = at >= 0 && end > at ? code.slice(at, end) : "";
  const ok = () => expect(block.length,
    "вікно блоку аварійної зупинки порожнє — усі перевірки нижче були б вакуумними")
    .toBeGreaterThan(500);

  it("ДРУГОГО читання інцидентів більше немає — id-шники дає сама RPC", () => {
    ok();
    /* ⚠️ U-56 (0168): головний пін цього блоку перевернувся. Раніше він вимагав,
       щоб `error` другого читання ЗВʼЯЗАЛИ й подивились; тепер вимагає, щоб
       читання не було ВЗАГАЛІ — інакше пакет 0168 зробили наполовину: колонка
       є, а журнал і далі тримається на окремому запиті, який може не відбутись.

       ⚠️ Регулярка ШИРОКА навмисно (ревʼю U-56). Перша редакція вимагала
       `await supabase.from("incidents")` одним шматком — і не бачила
       багаторядкового стилю, який лежить у ЦЬОМУ Ж файлі
       (`incidentSpansFor`: `await supabase` ⏎ `.from("incidents")`). Тобто
       обійти головний пін пакета можна було копіпастом із сусідньої функції.
       Тепер дивимось на `.from(<будь-які лапки>incidents)` без огляду на
       приймач, перенос рядка й лапки.

       ⚠️ Названа межа: винести читання в НОВИЙ файл і викликати хелпер звідси
       цей пін не спіймає (тіло хелпера поза вікном), а `readErrorTrust` має
       поіменний `FILES`. Повне закриття коштувало б сканера імпортів; поки що
       межа названа тут, а не замовчана. */
    expect(block, "друге читання incidents повернулось — корінь U-56 знову на місці")
      .not.toMatch(/\.from\(\s*["'`]incidents["'`]\s*\)/);
    expect(block).toMatch(/const incs = readStoppedIncidents\(res\?\.stopped_incidents\);/);
  });

  it("очікувана кількість береться з того самого поля, що й звіт користувачу", () => {
    ok();
    /* ⚠️ Ревʼю U-56 (BLOCKER): перша редакція гейтила ВЕСЬ блок журналу на
       `res?.stopped_rooms ?? []` — полі, яке не розбиралось. Зникни воно
       (а після 0168 воно надлишкове), журнал вимкнувся б МОВЧКИ, а
       користувачеві й далі писали б «зупинено 3» із сусіднього `stopped`.
       Тому число одне на обидва звіти, і гейта-вимикача немає. */
    expect(block).toMatch(/const stoppedCount = typeof res\?\.stopped === "number" \? res\.stopped : 0;/);
    expect(block, "гілка журналу знову під гейтом сусіднього поля")
      .not.toMatch(/if \(stoppedRooms\.length > 0\)/);
    expect(block).toMatch(/stoppedIncidentsGap\(incs, stoppedCount\)/);
  });

  it("подія пишеться на КОЖЕН інцидент, із його id і його кабінетом", () => {
    ok();
    /* ⚠️ Ревʼю U-56: місце склейки не пінив ніхто. Дві мутації були зелені
       скрізь — переставити `entityId: inc.roomId` (журнал назавжди дістає id
       кабінетів у полі сутності) і `.slice(0, 1)` перед `.map` (одна подія
       замість N). */
    expect(block).toMatch(/await Promise\.all\(incs\.incidents\.map\(\(inc\) => emitImportantEvent\(\{/);
    expect(block).toMatch(/entityId: inc\.id,/);
    /* `details` — null, а не порожній рядок: подія без деталі чесна, подія з
       порожньою деталлю бреше, ніби кабінет відомий. */
    expect(block).toMatch(/details: inc\.roomId \? \{ roomId: inc\.roomId \} : null,/);
    expect(block, "список подій урізають перед відправкою").not.toMatch(/\.slice\(/);
  });

  it("вибір коду делеговано чистій функції, і лог стоїть ПРЯМО в гілці", () => {
    ok();
    expect(block).toMatch(/const gap = stoppedIncidentsGap\(incs, stoppedCount\);/);
    /* ⚠️ Ревʼю р2: пін «умова є» + «logError є» окремо дозволяв обгорнути виклик
       у ще одну умову (`if (process.env.X)`) — текст на місці, журнал мовчить.
       Тому вимагаємо, щоб `logError` був ПЕРШИМ оператором гілки. */
    expect(block, "logError більше не перший оператор гілки — його могли сховати за умовою")
      .toMatch(/if \(gap\) \{\s*logError\(\{/);
    expect(block).toMatch(/errorCode: gap,/);
  });

  it("імʼя події канонічне — інакше запит про пропуски журналу його не знайде", () => {
    ok();
    /* Пропуски журналу шукають одним запитом по `event = "important_event.skipped"`
       (так пишуть усі інші девʼять місць). Тип події місце має в `message`. */
    expect(block).toMatch(/event: "important_event\.skipped"/);
    expect(block).toMatch(/type=incident\.emergency_stop/);
  });

  it("дію користувача НЕ валить: зупинка вже закомічена в RPC", () => {
    ok();
    /* Повернути помилку тут означало б збрехати про зупинку, яка сталася. */
    expect(block).not.toMatch(/return \{ ok: false/);
  });

  it("подію-замінник НЕ вигадують", () => {
    ok();
    /* У журналі фіксований перелік сутностей; «події про клініку» серед них
       немає, і підсунути clinic_id під entityType "incident" означало б
       записати неправду в те саме місце, яке ми лагодимо. */
    expect(block).toMatch(/entityType: "incident"/);
    expect(block).not.toMatch(/entityType: "clinic"/);
    expect(block).not.toMatch(/entityId: clinicId/);
  });
});
