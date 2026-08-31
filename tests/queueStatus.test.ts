import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { isLate, needsClarification, computeCallBlock, collisionFor, lateCallClash, callWindowEndMin, CALL_WINDOW_CLOCK_SLACK_MS, SAFETY_UNKNOWN_REASON, type CollisionEntry } from "@/lib/queueStatus";
import { setClinicTz, wallInstant } from "@/lib/incidents";
import { codeOf } from "./helpers/codeOf";

/* Час у RadFlow — «настінний» (wall-as-UTC, міграції 0035/0059). Фіксуємо зону
   клініки, щоб wallMinOfInstant не залежав від зони машини, де йдуть тести. */
beforeAll(() => setClinicTz("UTC"));

const DAY = new Date(2026, 6, 13);                    // 13.07.2026 (локальна дата дошки)
const NOW = wallInstant("2026-07-13", "10:30");       // «зараз» = 10:30 у зоні клініки

describe("isLate — пацієнт не прийшов понад буфер", () => {
  it("scheduled + минуло більше за буфер → true", () => {
    expect(isLate("scheduled", DAY, "10:00", 5, NOW)).toBe(true);
  });
  it("у межах буфера → false", () => {
    expect(isLate("scheduled", DAY, "10:28", 5, NOW)).toBe(false);
  });
  it("waiting (пацієнт уже прийшов) → ніколи не «запізнення»", () => {
    expect(isLate("waiting", DAY, "09:00", 5, NOW)).toBe(false);
  });
});

describe("needsClarification — час минув, а пацієнта не провели", () => {
  it("scheduled у минулому → true", () => {
    expect(needsClarification("scheduled", DAY, "09:00", NOW)).toBe(true);
  });
  it("майбутній слот → false", () => {
    expect(needsClarification("scheduled", DAY, "11:00", NOW)).toBe(false);
  });
  it("термінальний статус → false", () => {
    expect(needsClarification("done", DAY, "09:00", NOW)).toBe(false);
  });
});

describe("computeCallBlock — чому не можна викликати в кабінет", () => {
  const P = { id: "b", room_id: "r1", duration_min: 30, buffer_time_min: 5 };

  it("запис не на сьогодні", () => {
    expect(computeCallBlock(P, [], { notToday: true, nowMs: NOW })).toEqual({ code: "wrong_day" });
  });
  it("кабінет заблоковано (поломка/ТО)", () => {
    expect(computeCallBlock(P, [], { roomBlocked: true, nowMs: NOW })).toEqual({ code: "room_blocked" });
  });
  it("кабінет зачинено за графіком", () => {
    expect(computeCallBlock(P, [], { schedClosed: true, nowMs: NOW })).toEqual({ code: "room_closed" });
  });
  it("кабінет зайнятий іншим пацієнтом", () => {
    const entries = [{ id: "a", room_id: "r1", status: "in_progress", scheduled_time: "10:00" }];
    expect(computeCallBlock(P, entries, { nowMs: NOW })).toEqual({ code: "room_busy" });
  });
  /* 0077: кінець робочого дня більше НЕ блокує виклик — центр має добити день.
     Це попередження, яке оператор підтверджує (confirmable: true). Дошки саме за
     цим прапорцем відрізняють «показати діалог» від «заблокувати кнопку». */
  it("дослідження не влізе до кінця графіка → ПІДТВЕРДЖУВАНЕ, не блок", () => {
    const r = computeCallBlock(P, [], { schedEnd: "10:45", nowMs: NOW });
    expect(r).toMatchObject({ code: "sched_overrun", durationMin: 30, end: "10:45", confirmable: true });
  });

  /* Порядок перевірок — частина безпеки. Якщо кінець дня повертався б РАНІШЕ за
     накладення, оператор підтвердив би «так, поза графіком» і завів пацієнта
     поверх наступного запису: підтвердження не лікує чужу бронь. */
  it("накладення ПЕРЕВАЖАЄ кінець дня (жорсткий блок, не підтвердження)", () => {
    const entries = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "11:00", patient_name: "Іваненко І." }];
    const r = computeCallBlock(P, entries, { schedEnd: "10:45", nowMs: NOW });
    expect(r).toMatchObject({ code: "clash", time: "11:00" });
    expect(r?.confirmable).toBeFalsy();
  });

  it("простій кабінету підтвердженням не обходиться", () => {
    const r = computeCallBlock(P, [], { roomBlocked: true, schedEnd: "10:45", nowMs: NOW });
    expect(r).toMatchObject({ code: "room_blocked" });
    expect(r?.confirmable).toBeFalsy();
  });
  it("виклик зараз наїде на наступний запис", () => {
    // Зараз 10:30 + 30 хв + 5 буфер = до 11:05 → налазить на 11:00.
    const entries = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "11:00", patient_name: "Іваненко І." }];
    expect(computeCallBlock(P, entries, { nowMs: NOW })).toMatchObject({ code: "clash", time: "11:00" });
  });
  it("усе гаразд → null", () => {
    expect(computeCallBlock(P, [], { schedEnd: "18:00", nowMs: NOW })).toBeNull();
  });
  it("lateCallClash не бачить конфлікту, якщо наступний далеко", () => {
    const entries = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "14:00" }];
    expect(lateCallClash(P, entries, NOW)).toBeNull();
  });
});

/* M-2 аудиту 2026-08-23: дошка тримає рівно одну добу, а вікно виклику
   рахується від «зараз». Запис наступної доби lateCallClash не побачить
   НІКОЛИ (його немає в масиві) — тож про сам факт «вікно за північчю» треба
   сказати вголос, інакше оператор бачить дозволену дію, яку відхилить БД. */
describe("computeCallBlock — вікно виклику за північ (M-2)", () => {
  const P = { id: "b", room_id: "r1", duration_min: 30, buffer_time_min: 5 };
  const at = (t: string) => wallInstant("2026-07-13", t);
  // U-70: предикат живе в мілісекундах, тож і входи мусять бути мілісекундними —
  // на посекундній сітці ні кламп, ні значення слака не розрізняються.
  const atMs = (t: string, ms: number) => wallInstant("2026-07-13", t) + ms;

  it("23:40 + 30 хв + 5 буфер → next_day до 00:15, підтверджуване", () => {
    const r = computeCallBlock(P, [], { schedEnd: "23:59", nowMs: at("23:40") });
    expect(r).toMatchObject({ code: "next_day", durationMin: 30, end: "00:15", confirmable: true });
  });

  /* ⚠️ ПОСИЛКА ЗМІНЕНА В U-70 (знахідка U-67а), і це не «підганяння тесту».
     Раніше тут стояло `toBeNull()`: 23:25 + 30 + 5 = 24:00 рівно, «кабінет
     звільняється на межі, за добу не виходимо». Але серверне `now()`
     мікросекундне — о 23:25:00.xxx вікно гарда тягнеться до 00:00:00.xxx, і
     запис завтра на 00:00 він ВІДХИЛИТЬ (`ACTUAL_OVERLAP`). Тобто мовчання на
     цій межі було fail-open: дошка показувала дозволену дію, яку БД відбиває,
     а записів завтрашньої доби вона не бачить за побудовою.
     Тепер предикат рахується в мілісекундах із двостороннім слаком і на межі
     ПОПЕРЕДЖАЄ. Ціна — зайвий діалог рівно в цю мить; вона названа в коді. */
  it("рівно 24:00 — межа, і саме тут попереджаємо (U-67а)", () => {
    const r = computeCallBlock(P, [], { schedEnd: "23:59", nowMs: at("23:25") });
    expect(r).toMatchObject({ code: "next_day", confirmable: true });
    // Кламп: вікно закінчується в першу хвилину нової доби, а не «-1:-1».
    expect(r).toMatchObject({ end: "00:00" });
  });

  it("на дві хвилини раніше межі північ не турбує", () => {
    // 23:23 + 35 = 23:58 — до півночі ще дві хвилини навіть зі слаком.
    expect(computeCallBlock(P, [], { schedEnd: "23:59", nowMs: at("23:23") })).toBeNull();
  });

  /* ⚠️ ВХІД, ЩО СПРАВДІ ДОХОДИТЬ ДО КЛАМПА (знахідка ревʼю Б по U-70, H-4).
     Тест «рівно 24:00» вище дає на вході клампа РІВНО 0 — тобто мутація
     `Math.max(0, x)` → `x` лишала б його зеленим, і обіцянка коментаря
     («без клампа приїхало б відʼємне число, slotFmt(-1) дав би -1:-1»)
     не перевірялась узагалі. Тут вікно закінчується о 23:59:59, тобто
     хвилинний аргумент дорівнює −1, і попередження існує ЛИШЕ завдяки слаку. */
  it("вікно кінчається за секунду до півночі: попереджаємо, і підпис не «-1:-1»", () => {
    const r = computeCallBlock(P, [], { schedEnd: "23:59", nowMs: atMs("23:24", 59_000) });
    expect(r, "секунда до півночі — сервер уже за межею, а дошка мовчить").toMatchObject({ code: "next_day" });
    expect(r, "кламп знято — підпис поїхав у відʼємні хвилини").toMatchObject({ end: "00:00" });
  });

  /* ⚠️ ЗНАЧЕННЯ СЛАКА в предикаті півночі (знахідка ревʼю Б по U-70, H-5).
     Усі тести вище лишились би зеленими і зі слаком 0, і зі слаком 60 000:
     жоден не стоїть на самій межі `24:00 − слак`. Ці три входи розрізняють і
     ЧИСЛО, і оператор порівняння. Межі рахуються з КОНСТАНТИ — інакше правка
     слака зробила б тест червоним без дефекту. */
  it("предикат півночі стоїть саме на «кінець + слак > 24:00»", () => {
    const edge = 24 * 3600000 - 35 * 60000 - CALL_WINDOW_CLOCK_SLACK_MS;   // «зараз», за якого кінець+слак = 24:00 РІВНО
    const nowAt = (msOfDay: number) => wallInstant("2026-07-13", "00:00") + msOfDay;
    expect(computeCallBlock(P, [], { schedEnd: "23:59", nowMs: nowAt(edge) }), "межа стала включною (`>` → `>=`)")
      .toBeNull();
    expect(computeCallBlock(P, [], { schedEnd: "23:59", nowMs: nowAt(edge + 1) }), "слак у предикаті меншає або зник")
      .toMatchObject({ code: "next_day" });
    expect(computeCallBlock(P, [], { schedEnd: "23:59", nowMs: nowAt(edge - 1) }), "слак у предикаті виріс")
      .toBeNull();
  });

  it("за північ виводить САМ буфер — випадок, який графік не ловить", () => {
    // 23:26 + 30 = 23:56 (у графіку до 23:59, sched_overrun мовчить), а з
    // буфером 15 кабінет зайнятий до 00:11 — саме та сліпа зона.
    // Буфер узято з дозволених CHECK-ом значень (0045: 0/5/10/15), інакше тест
    // упав би на чесній правці формули під normBuffer.
    const r = computeCallBlock({ ...P, buffer_time_min: 15 }, [], { schedEnd: "23:59", nowMs: at("23:26") });
    expect(r).toMatchObject({ code: "next_day", end: "00:11" });
  });

  it("тривалість не задана → дефолт 30 хв, той самий і у вікні, і в тексті", () => {
    // Дефолт живе у двох місцях (computeCallBlock і callWindowEndMin); розійдуться
    // — діалог покаже одну тривалість, а кабінет займе інша.
    const r = computeCallBlock({ ...P, duration_min: null }, [], { nowMs: at("23:40") });
    expect(r).toMatchObject({ code: "next_day", durationMin: 30, end: "00:15" });
  });

  it("callWindowEndMin: хвилини від 00:00 ПОТОЧНОЇ доби, значення > 1440 — норма", () => {
    expect(callWindowEndMin({ duration_min: 30, buffer_time_min: 5 }, at("23:40"))).toBe(24 * 60 + 15);
    expect(callWindowEndMin({ duration_min: 30, buffer_time_min: 5 }, NOW)).toBe(10 * 60 + 30 + 35);
    // буфер 0 — саме нуль, а не дефолт 5 (?? проти ||)
    expect(callWindowEndMin({ duration_min: 30, buffer_time_min: 0 }, NOW)).toBe(10 * 60 + 60);
  });

  it("накладення на СЬОГОДНІШНІЙ запис важливіше за північ (жорсткий блок)", () => {
    const entries = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "23:50", patient_name: "Іваненко І." }];
    const r = computeCallBlock(P, entries, { schedEnd: "23:59", nowMs: at("23:40") });
    expect(r).toMatchObject({ code: "clash", time: "23:50" });
    expect(r?.confirmable).toBeFalsy();
  });

  it("простій кабінету північчю не підмінюється", () => {
    expect(computeCallBlock(P, [], { roomBlocked: true, nowMs: at("23:40") })).toMatchObject({ code: "room_blocked" });
  });

  it("північ ПЕРЕВАЖАЄ кінець графіка: обидва підтверджувані, але про північ ніде більше не сказано", () => {
    const r = computeCallBlock(P, [], { schedEnd: "20:00", nowMs: at("23:40") });
    expect(r).toMatchObject({ code: "next_day" });
  });

  it("запис без кабінету за північ нічого не займає", () => {
    expect(computeCallBlock({ ...P, room_id: null }, [], { nowMs: at("23:40") })).toBeNull();
  });

  it("вдень північ не турбує", () => {
    expect(computeCallBlock(P, [], { schedEnd: "18:00", nowMs: NOW })).toBeNull();
  });
});

describe("collisionFor — накладення (дослідження затягнулося)", () => {
  // A: слот 10:00, 60 хв + 5 буфер, ФАКТИЧНО заведений о 10:20 → кабінет вільний о 11:25.
  const RUN: CollisionEntry = {
    id: "a", room_id: "r1", status: "in_progress", scheduled_time: "10:00",
    duration_min: 60, buffer_time_min: 5, in_progress_at: "2026-07-13T10:20:00.000Z",
    patient_name: "Петренко І.",
  };
  const next = (time: string, id = "b"): CollisionEntry =>
    ({ id, room_id: "r1", status: "scheduled", scheduled_time: time, duration_min: 30, buffer_time_min: 5 });

  it("clash: кабінет НЕ встигає до слота Б", () => {
    const b = next("11:00");
    const c = collisionFor(b, [RUN, b], NOW);
    expect(c).toMatchObject({ zone: "clash", freeAt: "11:25", overlapMin: 25 });
    expect(c?.running.name).toBe("Петренко І.");
  });

  it("drift: кабінет відстає, але до слота Б встигає → тихий індикатор", () => {
    const b = next("11:30");
    expect(collisionFor(b, [RUN, b], NOW)).toMatchObject({ zone: "drift", driftMin: 20 });
  });

  it("немає дослідження в кабінеті → колізії немає", () => {
    const b = next("11:00");
    expect(collisionFor(b, [b], NOW)).toBeNull();
  });

  it("панель — лише в НАЙБЛИЖЧОГО запису кабінету", () => {
    const b = next("11:00"), c = next("12:00", "c");
    expect(collisionFor(b, [RUN, b, c], NOW)).not.toBeNull();
    expect(collisionFor(c, [RUN, b, c], NOW)).toBeNull();
  });

  it("протухлий ранковий запис (Запізнення) НЕ перехоплює панель", () => {
    // Регресія: раніше бралась просто найраніша активна запис — і панель із
    // абсурдним наїздом «на пів дня» вішалась на протухлу 09:00, а реальний
    // наступний пацієнт лишався без неї.
    const stale = next("09:00", "stale");
    const b = next("11:00");
    expect(collisionFor(stale, [RUN, stale, b], NOW)).toBeNull();
    expect(collisionFor(b, [RUN, stale, b], NOW)).toMatchObject({ zone: "clash" });
  });

  it("кабінет не може «звільнитися в минулому» (лікар не натиснув «Завершити»)", () => {
    // Старт 08:00, 60 хв → плановий кінець 09:00, але зараз уже 10:30.
    const long: CollisionEntry = { ...RUN, in_progress_at: "2026-07-13T08:00:00.000Z", scheduled_time: "08:00" };
    const b = next("10:30");
    const c = collisionFor(b, [long, b], NOW);
    expect(c).toMatchObject({ zone: "clash" }); // а не null через від'ємний overlap
    expect(c?.freeAt).toBe("10:35");            // «зараз» (10:30) + буфер 5
    expect(c?.running.remainMin).toBe(0);       // планова тривалість уже вичерпана
  });
});

/* ===== Аудит с46, U-6 — виклик пацієнта на невідомих даних про простої =====
   Правило «не знаємо про простої/графіки → не заводимо пацієнта в кабінет»
   існувало ЛИШЕ в дошці радіолога, окремим `if` до computeCallBlock. Дошка
   черги (реєстратор/адмін), яка викликає пацієнтів найчастіше, того гейта не
   мала взагалі: `incidentsErr || overridesErr` вимикав тільки «＋ Новий запис».
   Тобто дві копії одного продуктового правила розійшлись. Тепер правило одне —
   код safety_unknown усередині computeCallBlock, і обидві дошки читають його. */
describe("computeCallBlock — safety_unknown (простої/графіки не завантажились)", () => {
  const P = { id: "b", room_id: "r1", duration_min: 30, buffer_time_min: 5 };

  it("дані про простої ненадійні → жорсткий блок", () => {
    expect(computeCallBlock(P, [], { safetyUnknown: true, schedEnd: "18:00", nowMs: NOW }))
      .toEqual({ code: "safety_unknown" });
  });

  /* Порядок — суть правки, і перевіряти його треба з УВІМКНЕНИМИ конкурентами.
     Перша версія цього тесту передавала `roomBlocked: false, schedClosed: false`
     — обидві гілки інертні, тож перенос гейта нижче лишав тест зеленим, тобто
     сам порядок не сторожився взагалі (ревʼю с46 р2, F3; той самий клас, що
     «фікстура з самих цифр» у с45). */
  it("випереджає room_blocked і room_closed (вони пораховані з порожнього списку)", () => {
    expect(computeCallBlock(P, [], { safetyUnknown: true, roomBlocked: true, schedClosed: true, nowMs: NOW }))
      .toEqual({ code: "safety_unknown" });
  });

  it("НЕ зʼїдає чужу причину, коли даним віримо", () => {
    expect(computeCallBlock(P, [], { safetyUnknown: false, roomBlocked: true, nowMs: NOW }))
      .toEqual({ code: "room_blocked" });
  });

  /* Як і stuckUnknown (ревʼю с24, L3): без кабінету простій блокувати нічого не
     може, а текст «дані про простої» був би брехнею. */
  it("на записі БЕЗ кабінету мовчить", () => {
    const noRoom = { id: "b", room_id: null, duration_min: 30, buffer_time_min: 5 };
    expect(computeCallBlock(noRoom, [], { safetyUnknown: true, schedEnd: "18:00", nowMs: NOW })).toBeNull();
  });

  /* А от «не на сьогодні» від простоїв не залежить — ця причина точніша, і
     вона лишається вище. Дошка радіолога до с46 казала тут «дані не оновились»;
     після переїзду гейта в спільну функцію повідомлення стало чеснішим. */
  it("НЕ перебиває wrong_day — та причина від простоїв не залежить", () => {
    expect(computeCallBlock(P, [], { safetyUnknown: true, notToday: true, nowMs: NOW }))
      .toEqual({ code: "wrong_day" });
  });

  it("дані надійні → гейт мовчить (не блокує здоровий виклик)", () => {
    expect(computeCallBlock(P, [], { safetyUnknown: false, schedEnd: "18:00", nowMs: NOW })).toBeNull();
  });
});

/* Сторожі підключення U-6: сама по собі гілка safety_unknown нічого не блокує,
   поки дошка не ПЕРЕДАЄ прапорець. Саме на цьому кроці правило й розійшлося:
   safetyErr у дошці черги існував, але до computeCallBlock не доїжджав.
   JSX компонентними тестами не покрити (environment: "node"), тож тут —
   статичні сторожі по коду без коментарів. */
const BOARDS: Array<[string, string]> = [
  ["QueueBoard", codeOf(readFileSync(resolve(process.cwd(), "components/QueueBoard.tsx"), "utf8"))],
  ["RadiologistBoard", codeOf(readFileSync(resolve(process.cwd(), "components/RadiologistBoard.tsx"), "utf8"))],
];

describe.each(BOARDS)("%s — гейт safety_unknown підключений", (_name, src) => {
  // Терпимо до форматування (перенос рядка prettier'ом не має червонити).
  it("передає safetyErr у computeCallBlock", () => {
    expect(src).toMatch(/safetyUnknown:\s*safetyErr\b/);
  });

  /* Прибрати гейт помітно, ослабити — ні. Обидва способи, знайдені ревʼю р3
     (F4), лишали всі 1373 тести зеленими:
       • `safetyUnknown: safetyErr && false` — прапорець мертвий;
       • `const safetyErr = incidentsErr && overridesErr` — гейт спрацьовує лише
         коли впали ОБИДВА завантажувачі, тобто U-6 повертається для одиночного
         збою, який і є найчастішим. Пінуємо саму деривацію. */
  it("гейт не ослаблено на місці", () => {
    expect(src).toMatch(/const safetyErr = incidentsErr \|\| overridesErr\b/);
    expect(src).not.toMatch(/safetyUnknown:\s*safetyErr\s*&&/);
  });

  /* `toContain("SAFETY_UNKNOWN_REASON")` задовольнявся САМИМ ІМПОРТОМ — можна
     було видалити гілку в inProgressBlockReason, і сторож лишався зеленим
     (ревʼю с46 р2, F4). Сторожимо саму гілку. */
  it("показує причину блокування, а не мовчазний null", () => {
    expect(src).toContain('r.code === "safety_unknown"');
    expect(src.split("SAFETY_UNKNOWN_REASON").length - 1).toBeGreaterThanOrEqual(2); // імпорт + вживання
    // Текст живе в lib/: копія в компоненті означала б, що правило знову роздвоїлось.
    expect(src).not.toContain(SAFETY_UNKNOWN_REASON);
  });

  /* Діалог підтвердження («поза графіком», «за північ») міг провисіти хвилини.
     За цей час міг упасти рефетч простоїв, кабінет — заблокувати, інший пацієнт
     — зайти. Оператор підтверджував ТЕ, ЩО ЙОМУ ПОКАЗАЛИ, тож жорсткі блоки
     перечитуються в момент кліку (ревʼю с46 р3, F5). */
  it("підтвердження виклику перечитує жорсткі блоки в момент кліку", () => {
    expect(src).toMatch(/const rNow = callBlockOf\(a\.p\);[\s\S]{0,300}rNow && !rNow\.confirmable/);
  });

  /* Вирізаємо БЛОК аргументів кожного виклику і перевіряємо всередині. Підрахунок
     «викликів стільки ж, скільки прапорців» цього не гарантував: другий виклик
     міг отримати `safetyUnknown: false`, і 2 === 2 лишалось зеленим (F5). */
  it("КОЖЕН виклик computeCallBlock отримує живий прапорець", () => {
    const blocks = [...src.matchAll(/computeCallBlock\([\s\S]*?\n\s*\}\);/g)].map((m) => m[0]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b).toMatch(/safetyUnknown:\s*safetyErr\b/);
  });
});

/* ===== U-67: накладення (clash) — жорсткий блок із названою причиною ===== */

/* Рішення власника (с50). До нього дошка черги трактувала clash як «override з
   попередженням»: `inProgressBlockReason` віддавав null, а `callPatient`
   перехоплював clash ПЕРЕД гілкою жорстких блоків і відкривав діалог
   «⚠ Викликати все одно».
   ⚠️ Той діалог був МЕРТВИЙ: `onConfirm` перечитує жорсткі блоки в момент
   кліку (ревʼю с46 р3, F5), а в clash `confirmable` хибний — тож підтвердження
   ЗАВЖДИ закінчувалось загальним тостом «Викликати зараз неможливо».
   Полагодити «як задумано» було неможливо без зміни БД: параметра override у
   `queue_set_status_rpc` немає, гілка (б) гарда 0129 підніме ACTUAL_OVERLAP
   незалежно від room_busy. Тепер обидві дошки поводяться однаково.
   Сторожі статичні (environment: "node", JSX компонентними тестами не
   покривається) — той самий прийом, що в таблиці BOARDS вище. */
describe.each(BOARDS)("%s — clash названий, а не «підтверджуваний»", (_name, src) => {
  it("inProgressBlockReason має гілку clash із причиною", () => {
    expect(src, "clash знову віддає null — кнопка мовчить").toMatch(/r\.code === "clash"/);
  });

  it("clash НЕ відкриває діалог підтвердження", () => {
    /* Головний пін. Поки clash перехоплювався окремо ПЕРЕД `!r.confirmable`,
       він відкривав діалог, який сам себе і скасовував. */
    expect(src, "clash знову веде в offCallAsk — діалог мертвий за побудовою")
      .not.toMatch(/setOffCallAsk\(\{[^}]*kind:\s*"clash"/);
    expect(src, 'у стані діалогу знову зʼявилась гілка kind: "clash"')
      .not.toMatch(/kind:\s*"clash";/);
  });

  it("порядок перевірок: жорсткі блоки — перед підтверджуваними", () => {
    /* `!r.confirmable` мусить стояти ДО гілок next_day / sched_overrun:
       інакше підтверджуваний код перехопить керування раніше за жорсткий. */
    const at = src.indexOf("!r.confirmable");
    const nd = src.indexOf('r.code === "next_day"');
    expect(at, "гілка жорстких блоків зникла").toBeGreaterThan(0);
    expect(nd, "гілка next_day зникла").toBeGreaterThan(0);
    expect(at, "підтверджувані коди перехоплюють раніше за жорсткі").toBeLessThan(nd);
  });
});
