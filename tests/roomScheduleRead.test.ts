/* U-13 — «не читали = не знаємо» для графіка кабінету.
 *
 * Дефект заміряний на проді (с49): кабінет 09:00–22:00 сім днів, рядок якого
 * перестав читатись, малювався сіткою 08:00–18:00 — вигадана година 08:00–09:00,
 * якої в кабінету немає, і чотири зниклі робочі години 18:00–22:00. Без банера.
 * Передумова теж заміряна: RLS 0139 віддає направнику 0 рядків І NULL-помилку.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readRoomScheduleRow, roomSchedulesById, roomScheduleReadError } from "@/lib/roomSchedule";
import { roomScheduleFor } from "@/lib/schedule";
import { codeOf } from "./helpers/codeOf";

describe("readRoomScheduleRow — три відповіді maybeSingle, а не дві", () => {
  it("помилка читання → не знаємо (reason: error)", () => {
    expect(readRoomScheduleRow({ data: null, error: { message: "network" } }))
      .toEqual({ known: false, reason: "error" });
  });

  it("рядка немає (RLS сховала кабінет або його видалили) → не знаємо, ХОЧ ПОМИЛКИ НЕМАЄ", () => {
    /* Саме цей випадок два екрани й пропускали: `if (res.error) throw` його не
       ловить, бо error === null. Заміряно на проді під реальним направником. */
    expect(readRoomScheduleRow({ data: null, error: null }))
      .toEqual({ known: false, reason: "missing" });
  });

  it("рядок є, schedule є → знаємо", () => {
    const sched = { start: "09:00", end: "22:00", days: [1, 1, 1, 1, 1, 1, 1] };
    expect(readRoomScheduleRow({ data: { schedule: sched }, error: null }))
      .toEqual({ known: true, schedule: sched });
  });

  it("рядок є, schedule = null → ЗНАЄМО: це легітимний дефолт, а не незнання", () => {
    /* Межа правила названа вголос: якби `null` у рядку теж означав «не знаємо»,
       кабінет без власного графіка став би незаписуваним назавжди. */
    expect(readRoomScheduleRow({ data: { schedule: null }, error: null }))
      .toEqual({ known: true, schedule: null });
  });

  it("відповіді немає взагалі → не знаємо (fail-closed)", () => {
    expect(readRoomScheduleRow(null)).toEqual({ known: false, reason: "error" });
    expect(readRoomScheduleRow(undefined)).toEqual({ known: false, reason: "error" });
  });

  it("причина доїжджає в текст помилки — у логах видно, ЩО саме сталось", () => {
    expect(roomScheduleReadError("missing").message).toMatch(/RLS or deleted/);
    expect(roomScheduleReadError("error").message).toMatch(/read failed/);
    expect(roomScheduleReadError("missing").message)
      .not.toBe(roomScheduleReadError("error").message);
  });

  /* ⚠️ Знайдено ревʼю сторожів (BLOCKER 1). Найдешевший спосіб повернути дефект
     У ВСІХ семи місцях одразу — дописати правилу НЕОБОВʼЯЗКОВИЙ прапорець:

        readRoomScheduleRow(res, { missingIsDefault: true })

     Усі тести вище кличуть функцію з ОДНИМ аргументом і лишаються зеленими,
     статичні сторожі бачать той самий `readRoomScheduleRow(` — і «невидимий
     кабінет» знову стає «звичайним днем». Пінимо арність: більше одного
     параметра тут не буває за побудовою. */
  it("у правила рівно один параметр — мʼякого режиму не існує", () => {
    expect(readRoomScheduleRow.length, "у readRoomScheduleRow зʼявився другий параметр").toBe(1);
    expect(roomSchedulesById.length, "у roomSchedulesById зʼявився третій параметр").toBe(2);
  });
});

describe("roomSchedulesById — спискова форма, де відсутній кабінет просто зникає", () => {
  const rows = [{ id: "a", schedule: { end: "22:00" } }, { id: "b", schedule: null }];

  it("усі запитані кабінети прийшли → знаємо", () => {
    const r = roomSchedulesById({ data: rows, error: null }, ["a", "b"]);
    expect(r).toEqual({ known: true, byId: { a: { end: "22:00" }, b: null } });
  });

  it("один кабінет НЕ прийшов → не знаємо, хоч ні помилки, ні null немає", () => {
    /* Найтихіша форма дефекту: `byId["c"] === undefined`, далі
       `roomScheduleFor(…, undefined)` — хардкод, і жодного сліду в коді. */
    expect(roomSchedulesById({ data: rows, error: null }, ["a", "b", "c"]))
      .toEqual({ known: false, reason: "missing" });
  });

  it("помилка читання → не знаємо", () => {
    expect(roomSchedulesById({ data: null, error: { message: "boom" } }, ["a"]))
      .toEqual({ known: false, reason: "error" });
  });

  it("нуль запитаних → знаємо порожнє (не плутати з «не прочитали»)", () => {
    expect(roomSchedulesById({ data: [], error: null }, [])).toEqual({ known: true, byId: {} });
  });

  it("перевірка ПО КЛЮЧАХ, а не по довжині — і по обидва боки", () => {
    /* ⚠️ Формулювання виправлене ревʼю: довжини брешуть у ДВА боки.
       (1) ДІРКА: чужий рядок у відповіді робить перевірку довжиною зеленою на
           неповних даних — wanted = [a, c], відповідь [a, b]: 2 = 2, `c` втрачено.
       (2) ХИБНА ТРИВОГА: дублікат у запиті — wanted = [a, a], відповідь [a]:
           1 ≠ 2, хоча прочитано все. Перевірка по ключах не має ні того, ні
           іншого, і саме це тут закріплено. */
    expect(roomSchedulesById({ data: [rows[0], rows[1]], error: null }, ["a", "c"]),
      "чужий рядок замаскував відсутній кабінет")
      .toEqual({ known: false, reason: "missing" });
    expect(roomSchedulesById({ data: [rows[0]], error: null }, ["a", "a"]),
      "дублікат у запиті дав хибну тривогу")
      .toEqual({ known: true, byId: { a: { end: "22:00" } } });
  });
});

describe("ціна помилки: що саме малює хардкод замість справжнього графіка", () => {
  /* Не декоративний тест: він фіксує ОБИДВА напрямки брехні, заміряні на проді.
     Кабінет ZZ ТЕСТ U-13 мав 09:00–22:00 сім днів. */
  const real = { start: "09:00", end: "22:00", days: [1, 1, 1, 1, 1, 1, 1], perDay: false };
  const monday = new Date("2026-08-31T00:00:00");
  const sunday = new Date("2026-08-30T00:00:00");

  it("прочитаний графік — справжні межі", () => {
    const s = roomScheduleFor(monday, "r1", null, real);
    expect([s.start, s.end, s.closed]).toEqual(["09:00", "22:00", false]);
  });

  it("НЕпрочитаний (null) — хардкод, який і вигадує, і ховає час", () => {
    const s = roomScheduleFor(monday, "r1", null, null);
    expect(s.start, "08:00 вигадано: кабінет починає о 09:00").toBe("08:00");
    expect(s.end, "18:00 замість 22:00 — чотири робочі години зникли").toBe("18:00");
  });

  it("…і закриває неділю кабінету, який працює сім днів", () => {
    expect(roomScheduleFor(sunday, "r1", null, real).closed).toBe(false);
    expect(roomScheduleFor(sunday, "r1", null, null).closed).toBe(true);
  });
});

/* ═══════ Сканер: КОЖЕН, хто читає rooms.schedule, іде через правило ═══════ */

/* Партнерські фасади читають графік ОДНОГО кабінету адмін-клієнтом і вже
   роблять рівно те, чого бракувало решті: `if (roomErr) → 500` І окрема гілка
   `if (!room …) → 404`. Правило там реалізоване руками й правильно.
   ⚠️ Ревʼю сторожів (MAJOR 7): «реалізоване правильно» було ОБІЦЯНКОЮ, яку
   ніщо не перевіряло — мутація `if (room && room.clinic_id !== clinicId)`
   зробила б гілку «0 рядків» недосяжною, і партнерський RIS отримав би те саме
   вигадане вікно 08:00–18:00, тільки зовнішнім каналом. Тепер обіцянка — тест. */
const INTEGRATION_ROUTES = [
  "app/api/integrations/v1/slots/route.ts",
  "app/fhir/R4/Slot/route.ts",
  "app/fhir/R4/Slot/[id]/route.ts",
];

describe("U-13: партнерські фасади самі відсікають «рядка немає»", () => {
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  it.each(INTEGRATION_ROUTES)("%s: гілка !room ціла", (file) => {
    const code = codeOf(src(file));
    expect(code, `${file}: помилку читання кабінету більше не перевіряють`)
      .toMatch(/if \(roomErr \|\| clinicErr\)/);
    /* Саме `!room ||`, а не `room &&`: перевіряємо, що ВІДСУТНІСТЬ рядка веде
       у відмову, а не лише чужа клініка. */
    expect(code, `${file}: «рядка немає» більше не веде у 404`)
      .toMatch(/if \(!room \|\| room\.clinic_id !== clinicId\)/);
  });
});

/* Серверні СПИСКОВІ читання сторінок: `const { data: rooms } = await …` —
   `error` не звʼязаний УЗАГАЛІ, тож збій читання дає «у клініки немає
   кабінетів» замість помилки. Той самий клас («не читали = не знаємо»), але
   інша форма й інша правка (звʼязати error і чесно впасти), і робити її наосліп
   у цьому пакеті я не став: борг **U-48**. Перелічені поіменно — інакше сканер
   мовчав би про них, а це рівно та бухгалтерія, через яку U-13 і жив. */
/* ⚠️ Список ЗАМІРЯНИЙ (`scripts/scan-rooms-reads.mjs`), а не переказаний: ревʼю
   знайшло в першій редакції `app/staff/page.tsx`, який графік узагалі не читає,
   тобто був у списку дарма. Зайве імʼя тут не червонить тест — воно просто
   тихо розширює виняток, і саме так виняткові списки й гниють. */
const SERVER_LIST_READS = [
  "app/referral/page.tsx",
  "app/waitlist/page.tsx",
  "app/queue/page.tsx",
  "app/call-list/page.tsx",
  "app/radiologist/page.tsx",
  "app/services/page.tsx",
  "app/setup/page.tsx",
];

describe("U-13: жоден екран не розбирає відповідь сам", () => {
  /* ДВІ форми читання, і друга тихіша за першу:
       "one"  — `.eq(id).maybeSingle()`  → відсутній рядок = data:null;
       "many" — `.in("id", ids)`         → відсутній кабінет просто ЗНИКАЄ з
                масиву: ні помилки, ні null, і очима це не видно взагалі. */
  const CENSUS: Array<[file: string, form: "one" | "many"]> = [
    ["components/BookingModal.tsx", "one"],
    ["components/RescheduleModal.tsx", "one"],
    ["components/StudyEditModal.tsx", "one"],
    ["components/ReferralPortal.tsx", "one"],
    ["components/QuickRescheduleButton.tsx", "one"],
    ["components/CollisionPanel.tsx", "many"],
    /* ⚠️ Найдорожчий рядок перепису — і його в журналі U-13 не було зовсім.
       `app/queue/actions.ts` — СЕРВЕРНИЙ гейт «поза графіком чи ні», від якого
       залежить, чи взагалі створиться запис. Там теж стояло `if (roomErr) throw`
       і `room?.schedule ?? null`, тобто для направника з вузьким грантом сервер
       вирішував за вигаданим 08:00–18:00. Два виклики: offScheduleInfo і
       roomDayCtx. */
    ["app/queue/actions.ts", "one"],
  ];
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it.each(CENSUS)("%s: відповідь розбирає правило, а не сам екран", (file, form) => {
    const code = codeOf(src(file));
    expect(code, `${file}: більше немає читання rooms.schedule — сканер застарів`)
      .toMatch(/from\("rooms"\)\s*\.select\("(schedule|id, schedule)"\)/);
    /* Пінимо ВИКЛИК, а не імпорт: сторож, що шукає імʼя, ловить рядок імпорту
       (урок с46), і мутація «прибрати виклик, лишити імпорт» лишалась би зеленою. */
    const rule = form === "one" ? /readRoomScheduleRow\(/ : /roomSchedulesById\(/;
    expect(code, `${file}: відповідь розбирається на місці, а не правилом`).toMatch(rule);
    /* ⚠️ …але й самого виклику мало (ревʼю сторожів, MAJOR 4): імʼя можна
       ПЕРЕКРИТИ локальною обгорткою, яка кличе справжнє правило і пом'якшує
       його відповідь. Тому пінимо ІМПОРТ і забороняємо локальне оголошення. */
    expect(code, `${file}: правило більше не імпортується з lib`)
      .toMatch(/from "@\/lib\/roomSchedule"/);
    expect(code, `${file}: правило перекрите локальною обгорткою`)
      .not.toMatch(/(const|let|function)\s+(readRoomScheduleRow|roomSchedulesById)\b/);
  });

  /* ⚠️ ОКРЕМИЙ тест, а не третій `expect` у попередньому. Перший прогін
     фальсифікації дав «ЧЕРВОНИЙ НЕ ТОЙ» саме тому, що один `it` ніс ТРИ різні
     твердження: мутація привʼязки фарбувала тест із іменем про виклик, і стенд
     не міг сказати, що саме зламалось. Правило проєкту («назви, який саме
     почервонів») вимагає одне твердження — одне імʼя. */
  it.each(CENSUS)("%s: незнання ЗУПИНЯЄ потік у КОЖНОМУ місці виклику", (file) => {
    const code = codeOf(src(file));
    /* ⚠️ Пара «виклик + гейт» пінится ЗЛИТНО й СУСІДНІМИ рядками (ревʼю
       сторожів, BLOCKER 2 і 3):
         • BLOCKER 2 — правилу можна підсунути СИНТЕЗОВАНИЙ обʼєкт
           (`readRoomScheduleRow({ data: roomRes.data ?? { schedule: null }, … })`),
           і гілка «рядка немає» стає недосяжною. Тому аргумент — ГОЛЕ імʼя;
         • BLOCKER 3 — між викликом і гейтом можна вставити ранній
           `if (!roomRes.data) return null;`, і на серверному гейті це вже не
           «мовчазний дефолт», а fail-OPEN: `null` там означає «в межах
           графіка». Тому між ними не має бути НІЧОГО, крім пробілів. */
    const pair = /const (sched|read|sched0) = (readRoomScheduleRow|roomSchedulesById)\((\w+)[,)][^;]*;\s*\n\s*if \(!\1\.known\) throw roomScheduleReadError\(\1\.reason\);/g;
    const pairs = [...code.matchAll(pair)];
    expect(pairs.length, `${file}: немає жодної пари «виклик правила + гейт поруч»`)
      .toBeGreaterThan(0);
    /* І СТІЛЬКИ Ж, скільки викликів ОБОХ форм правила (ревʼю, MINOR 8: рахувати
       лише «свою» форму означало б пропустити негейтований виклик другої). */
    const calls = (code.match(/(readRoomScheduleRow|roomSchedulesById)\(/g) || []).length;
    expect(pairs.length, `${file}: викликів правила ${calls}, а гейтованих пар ${pairs.length}`)
      .toBe(calls);
    /* Аргумент правила — саме той біндер, у який лягла ВІДПОВІДЬ читання.
       Дві законні форми звʼязування (третьої в проєкті немає; зʼявиться —
       цей тест почервоніє, і це правильно):
         F1  const roomRes = await supabase.from("rooms")…
         F2  const [ov, inc, roomRes, busy] = await Promise.all([ …from("rooms")… ])
       ⚠️ Межа F2 названа вголос: перевіряється НАЯВНІСТЬ імені в деструктуризації
       Promise.all, що містить читання rooms, а не його позиція в масиві. Для
       порталу цього досить — читання rooms там одне. */
    for (const p of pairs) {
      const f1 = new RegExp("const " + p[3] + " = await supabase[\\s\\S]{0,160}?from\\(\"rooms\"\\)");
      const f2 = new RegExp("\\[[^\\]]*\\b" + p[3] + "\\b[^\\]]*\\]\\s*=\\s*await Promise\\.all\\(\\[[\\s\\S]{0,900}?from\\(\"rooms\"\\)");
      expect(f1.test(code) || f2.test(code),
        `${file}: правилу передали не результат читання rooms (${p[3]})`).toBe(true);
    }
  });

  it.each(CENSUS)("%s: старий тихий відкат не повернувся", (file) => {
    /* Найдешевший мовчазний відкат — саме він: тип той самий, tsc мовчить,
       сітка знову малює хардкод. Читаємо КОД, не коментарі (у правці стоїть
       пояснення, чому так робити не можна).
       ⚠️ Регексп розширений ревʼю (MAJOR 5): перша редакція вимагала закриту
       дужку ВПРИТУЛ перед `?.schedule` і не ловила ані `room?.schedule ?? null`
       (саме ця форма й стояла в найдорожчому файлі — app/queue/actions.ts), ані
       `?? undefined`, ані `|| null`. Пінимо КЛАС, а не написання. */
    expect(codeOf(src(file)), `${file}: повернувся тихий відкат на хардкод`)
      .not.toMatch(/\?\.\s*schedule\s*(\?\?|\|\|)/);
  });

  /* ⚠️ Список вище написаний РУКАМИ, а механізм «tsc перелічить місця» нового
     екрана не бачить (урок с47). Тому сканер сам знаходить усіх, хто читає
     `rooms` з колонкою `schedule`, і падає на незнайомому — так само, як
     `readErrorTrust` і сканер U-37. */
  it("новий читач rooms.schedule валить тест, а не проїжджає мовчки", () => {
    const roots = ["components", "app", "lib"];
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
        const p = dir + "/" + e.name;
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        const code = codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));
        /* Читання саме ГРАФІКА: `from("rooms")` із `schedule` у списку колонок.
           Читання назв/модальностей без графіка цього правила не потребує.
           ⚠️ Лапки БУДЬ-ЯКІ й пробіли вільні (ревʼю сторожів, MAJOR 6): перша
           редакція приймала лише подвійні лапки і `.select(` впритул, тож новий
           екран ховався від сканера одним `'rooms'` або переносом рядка — рівно
           той спосіб, який `readErrorTrust` у себе давно закрив (`TABLE_RE`). */
        if (/\.from\(\s*["'`]rooms["'`]\s*\)[\s\S]{0,160}?\.select\(\s*["'`][^"'`]*schedule[^"'`]*["'`]/.test(code)) found.push(p);
      }
    };
    roots.forEach(walk);
    const known = new Set(
      CENSUS.map(([f]) => f).concat(SERVER_LIST_READS).concat(INTEGRATION_ROUTES),
    );
    expect(found.filter((f) => !known.has(f)).sort(),
      "новий читач rooms.schedule: проведіть його через lib/roomSchedule або впишіть у борг")
      .toEqual([]);
    /* І навпаки: якщо файл із перепису перестав читати графік, перепис бреше. */
    expect(CENSUS.map(([f]) => f).filter((f) => !found.includes(f)),
      "файл із перепису більше не читає rooms.schedule").toEqual([]);
  });

  /* ⚠️ Кинути мало — треба довести кидок до СТАНУ ЕКРАНА (ревʼю сторожів,
     MINOR 9, і знахідка ревʼю коду). Мутація `setSchedErr(false)` у `catch`
     лишає гейт цілим, а сітка малюється з `roomSchedule === null`, тобто знову
     з хардкоду — і поруч світиться «✓ Слот вільний». Для двох модалок це давно
     пінить `readErrorTrust`; для BookingModal не пінило ніщо. */
  it("BookingModal: збій читання доводиться до стану екрана", () => {
    const code = codeOf(src("components/BookingModal.tsx"));
    expect(code, "catch більше не обнуляє прочитане і не піднімає schedErr")
      .toMatch(/catch \{[\s\S]{0,400}?setOverride\(null\); setRoomSchedule\(null\); setSchedErr\(true\);/);
    /* І банери про графік не стверджують нічого на недовірених даних. */
    expect(code, "банер «не працює» втратив гейт довіри")
      .toMatch(/\{availTrusted && roomId && roomSched\.closed &&/);
    expect(code, "банер «особливий графік» втратив гейт довіри")
      .toMatch(/\{availTrusted && roomId && !roomSched\.closed && roomSched\.custom &&/);
  });

  /* ⚠️ ЧЕСНА МЕЖА сканера, названа вголос (ревʼю сторожів, MAJOR 6). Він читає
     ЛІТЕРАЛИ. Читання, зібране з обчислених величин, він не побачить:
        const TBL = "rooms";              supabase.from(TBL)…
        const COLS = "id, schedule";      …select(COLS)
     Закривати це регекспом безглуздо — потрібен розбір типів. Замість
     мовчазної діри ставимо ЗАБОРОНУ на обчислені імена в тих файлах, де
     читання rooms взагалі є: у проєкті таких форм немає, і хай не зʼявляться
     непоміченими. Решта репозиторію лишається непокритою — це борг **U-51**. */
  it("у файлах із читанням rooms немає обчислених імен таблиці/колонок", () => {
    /* ⚠️ Перша редакція цієї перевірки була ЗАШИРОКА і червоніла на
       `app/referral/page.tsx`, де `.select(SERVICE_COLS)` читає services, а не
       rooms. Заборона стосується лише читань САМОЇ таблиці rooms: обчислене
       імʼя таблиці — скрізь (його сканер не бачить у принципі), обчислений
       список колонок — лише одразу за `from("rooms")`. */
    const bad: string[] = [];
    for (const f of [...CENSUS.map(([x]) => x), ...SERVER_LIST_READS, ...INTEGRATION_ROUTES]) {
      const code = codeOf(readFileSync(resolve(process.cwd(), f), "utf8"));
      if (/\.from\(\s*[A-Za-z_$][\w$]*\s*\)/.test(code)) bad.push(f + ": from(<змінна>)");
      if (/\.from\(\s*["'`]rooms["'`]\s*\)[\s\S]{0,60}?\.select\(\s*[A-Za-z_$][\w$]*\s*[,)]/.test(code)) {
        bad.push(f + ": rooms.select(<змінна>)");
      }
    }
    expect(bad, "обчислене імʼя таблиці/колонок — сканер такого читання не бачить").toEqual([]);
  });
});


