/* Ф4-1 (с50) — «постраждалі» шукаються за ІНТЕРВАЛОМ, а не за точкою старта.
 *
 * Дефект. `entryInIncidentWindow` — єдиний предикат «кому дзвонити при простої»
 * для дошки (`QueueBoard.affectedIds`) і колл-листа (`CallListBoard.affectedToday`).
 * До с50 він питав лише, чи ПОЧИНАЄТЬСЯ слот усередині простою:
 *
 *     dt >= start && dt < end
 *
 * Живий гард БД питає інше — чи ПЕРЕТИНАЮТЬСЯ інтервали (сверено
 * `pg_get_functiondef`, а не за памʼяттю):
 *
 *     tstzrange(i.started_at, coalesce(i.blocked_until, 'infinity'))
 *       && tstzrange(new.scheduled_at, new.scheduled_at + make_interval(mins => duration_min))
 *
 * Ціна розбіжності клінічна: запис 11:45 тривалістю 30 хв при простої з 12:00
 * фізично заходить у простій, БД його зміну відібʼє кодом INCIDENT — а секція
 * писала «У вікні простою активних записів немає». Ніхто не дзвонить, пацієнт
 * приїжджає до апарата, що стоїть.
 *
 * ⚠️ Це ТОЙ САМИЙ клас, що U-33 (с49) закрив для `studyBlockedByFeed` — і обидві
 * функції лежать в ОДНОМУ файлі `lib/incidents.ts`. Асиметрія прожила сесію.
 *
 * ⚠️ Половина перевірок нижче навмисно вимагає ЗЕЛЕНОГО: правка без дефекту не
 * сміє червоніти. Саме вони доводять, що предикат не став надто широким —
 * інакше «полагодили» означало б «дзвонимо всім підряд».
 */
import { describe, it, expect } from "vitest";
import { entryInIncidentWindow, groupIncidentsByRoom, wallInstant, type IncidentLike } from "@/lib/incidents";

const DAY = "2026-09-07";
const iso = (t: string) => new Date(wallInstant(DAY, t)).toISOString();

/** Простій із заданим вікном. `to = null` → «до відновлення» (Infinity). */
const inc = (from: string, to: string | null): IncidentLike =>
  ({ room_id: "r1", started_at: iso(from), blocked_until: to ? iso(to) : null }) as IncidentLike;

describe("entryInIncidentWindow: перетин інтервалів, а не точка старта", () => {
  it("ЗАПИС, ЩО ЗАХОДИТЬ У ПРОСТІЙ, — постраждалий (сам дефект Ф4-1)", () => {
    // 11:45 + 30 хв = 11:45–12:15, простій 12:00–13:00 → перетин 15 хвилин.
    // Стара реалізація давала false: старт 11:45 < 12:00.
    expect(entryInIncidentWindow(DAY, "11:45", 30, inc("12:00", "13:00"))).toBe(true);
  });

  it("запис, що ЗАКІНЧУЄТЬСЯ до простою, — НЕ постраждалий", () => {
    // 11:00 + 30 хв = 11:00–11:30, простій з 12:00. Зелена половина.
    expect(entryInIncidentWindow(DAY, "11:00", 30, inc("12:00", "13:00"))).toBe(false);
  });

  it("дотик кінцем до початку простою перетином НЕ є (межі `[)`, як у tstzrange)", () => {
    // 11:30 + 30 хв = рівно 11:30–12:00, простій з 12:00.
    expect(entryInIncidentWindow(DAY, "11:30", 30, inc("12:00", "13:00"))).toBe(false);
  });

  it("старт рівно на початку простою — постраждалий", () => {
    expect(entryInIncidentWindow(DAY, "12:00", 30, inc("12:00", "13:00"))).toBe(true);
  });

  it("старт рівно в момент кінця простою — НЕ постраждалий", () => {
    expect(entryInIncidentWindow(DAY, "13:00", 30, inc("12:00", "13:00"))).toBe(false);
  });

  it("простій без blocked_until тягнеться в нескінченність", () => {
    expect(entryInIncidentWindow(DAY, "23:00", 30, inc("12:00", null))).toBe(true);
    // …але запис, що закінчився ДО його початку, все одно не постраждалий.
    expect(entryInIncidentWindow(DAY, "11:00", 30, inc("12:00", null))).toBe(false);
  });

  it("невідома тривалість → дефолт 30 хв (свідомо ШИРШЕ сервера)", () => {
    // Сервер при duration_min is null запис пропускає зовсім; тут — навпаки,
    // бо зайвий дзвінок дешевший за пацієнта у зламаному апараті.
    expect(entryInIncidentWindow(DAY, "11:45", null, inc("12:00", "13:00"))).toBe(true);
    expect(entryInIncidentWindow(DAY, "11:45", 0, inc("12:00", "13:00"))).toBe(true);
    // Але дефолт не робить постраждалим того, хто далеко: 11:00 + 30 = 11:30.
    expect(entryInIncidentWindow(DAY, "11:00", null, inc("12:00", "13:00"))).toBe(false);
  });

  it("порожні вхідні дані — не постраждалий, а не виняток", () => {
    expect(entryInIncidentWindow(DAY, "11:45", 30, null)).toBe(false);
    expect(entryInIncidentWindow(null, "11:45", 30, inc("12:00", "13:00"))).toBe(false);
    expect(entryInIncidentWindow(DAY, null, 30, inc("12:00", "13:00"))).toBe(false);
  });

  it("нечитаний started_at → «не знаємо» НЕ стає «не постраждав»", () => {
    const broken = { room_id: "r1", started_at: "не дата", blocked_until: null } as unknown as IncidentLike;
    expect(entryInIncidentWindow(DAY, "11:45", 30, broken)).toBe(true);
  });

  /* ⚠️ `started_at` у проді НЕ вирівняний на хвилину: аварійна зупинка пише
     `(now() at time zone tz) at time zone 'utc'` з мікросекундами, і 5 із 6
     простоїв у проді мають дробові секунди. Сітка нижче будує простої рівно на
     хвилинах, тож САМА вона цього класу не бачить — правку «а давайте
     округлимо до хвилин, як у CollisionPanel» вона не почервонила б (ревʼю
     с50). Тому дві точки з секундами — окремо. */
  it("частки секунди в started_at не округлюються", () => {
    const withSec = (t: string, ms: number): IncidentLike =>
      ({ room_id: "r1", started_at: new Date(wallInstant(DAY, t) + ms).toISOString(), blocked_until: null }) as IncidentLike;
    // Простій почався о 12:00:40. Запис 11:31 + 30 хв = до 12:01 → перетин є.
    expect(entryInIncidentWindow(DAY, "11:31", 30, withSec("12:00", 40_000))).toBe(true);
    // Запис 11:30 + 30 хв = рівно до 12:00:00, а простій — з 12:00:40.
    // Округлення початку простою вниз до 12:00 зробило б це `true`.
    expect(entryInIncidentWindow(DAY, "11:30", 30, withSec("12:00", 40_000))).toBe(false);
  });

  /* Колл-лист тягне записи `.gte(scheduled_date, today)` БЕЗ верхньої межі, а
     простій «до відновлення» не має кінця — тож сюди законно приходить пацієнт
     на три тижні вперед. Сітка живе в межах однієї доби й цього не перевіряє. */
  it("працює через межу доби, а не лише всередині одного дня", () => {
    const longInc: IncidentLike =
      ({ room_id: "r1", started_at: iso("12:00"), blocked_until: null }) as IncidentLike;
    expect(entryInIncidentWindow("2026-09-21", "09:00", 30, longInc)).toBe(true);
    // А простій із кінцем того ж дня наступних діб уже не тримає.
    const sameDay: IncidentLike =
      ({ room_id: "r1", started_at: iso("12:00"), blocked_until: iso("13:00") }) as IncidentLike;
    expect(entryInIncidentWindow("2026-09-21", "09:00", 30, sameDay)).toBe(false);
    // …і день ДО простою теж не тримає.
    expect(entryInIncidentWindow("2026-09-01", "12:30", 30, longInc)).toBe(false);
  });
});

/* Дзеркало серверної семантики — перевіряється НЕЗАЛЕЖНОЮ побудовою, а не тією
   самою формулою (інакше тест був би тавтологією). Еталон: похвилинний скан —
   запис постраждалий тоді й лише тоді, коли хоч одна його хвилина лежить
   усередині простою. Це те саме, що `&&` для діапазонів `[)` на хвилинній
   сітці, але виведене іншим способом. */
describe("entryInIncidentWindow: збіг із похвилинним еталоном", () => {
  /* ⚠️ Еталон БЕЗ дефолту тривалості — навмисно (ревʼю с50). Перша редакція
     повторювала тут `durMin > 0 ? durMin : 30`, тобто правило РЕАЛІЗАЦІЇ. Поки
     в сітці всі тривалості додатні, гілка мертва й нешкідлива; але щойно хтось
     допише в перелік нуль, еталон погодився б із реалізацією ЗА ПОБУДОВОЮ і
     мовчки пропустив би розбіжність. Еталон приймає вже вирішену тривалість, а
     дефолт перевіряється окремим точковим тестом вище. */
  const ref = (startMin: number, durMin: number, incFrom: number, incTo: number | null) => {
    for (let m = startMin; m < startMin + durMin; m++) {
      if (m >= incFrom && (incTo === null || m < incTo)) return true;
    }
    return false;
  };
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  it("сходиться на сітці стартів × тривалостей × вікон простою", () => {
    const windows: Array<[number, number | null]> = [
      [12 * 60, 13 * 60],          // звичайне вікно
      [12 * 60, 12 * 60 + 5],      // коротке
      [12 * 60, null],             // до відновлення
      [8 * 60, 20 * 60],           // весь день
    ];
    let checked = 0;
    for (const [from, to] of windows) {
      for (let start = 8 * 60; start <= 19 * 60; start += 5) {
        for (const dur of [5, 15, 20, 30, 45, 60, 90]) {
          // Еталон дефолту не має — сітка зобовʼязана давати додатні значення.
          expect(dur, "сітка не сміє подавати нульову тривалість").toBeGreaterThan(0);
          const got = entryInIncidentWindow(
            DAY, hhmm(start), dur,
            inc(hhmm(from), to === null ? null : hhmm(to))
          );
          expect(got, `старт ${hhmm(start)} +${dur} хв проти простою ${hhmm(from)}–${to === null ? "∞" : hhmm(to)}`)
            .toBe(ref(start, dur, from, to));
          checked++;
        }
      }
    }
    // Сторож самого сторожа: якщо сітка згорнеться в нуль, тест лишиться
    // зеленим і нічого не доведе (урок «зелений ноль», с50, фаза 2).
    expect(checked).toBeGreaterThan(500);
  });
});

/* Ф4-6 (с50) — простоїв на кабінет буває КІЛЬКА, і мапа «один на кабінет»
 * мовчки губила решту вікон.
 *
 * Перевіряється ВИКЛИКОМ, а не піном по тексту: стенд фальсифікації показав,
 * що пін типу мапи (`Record<string, IncidentRow[]>`) мутацію «останній затирає
 * попередніх» НЕ червонить — тип при ній не змінюється. Регексп по коду в цьому
 * проєкті не сторож; сторож — виклик.
 */
describe("groupIncidentsByRoom: кабінет тримає ВСІ свої простої", () => {
  const at = (room: string, t: string) => ({ room_id: room, started_at: iso(t), id: room + t });

  it("два простої одного кабінета не затирають один одного", () => {
    const g = groupIncidentsByRoom([at("r1", "09:00"), at("r1", "15:00")]);
    expect(g.r1).toHaveLength(2);
    expect(g.r1.map((i) => i.id)).toEqual(["r109:00", "r115:00"]);
  });

  it("порядок надходження збережено (він недетермінований у PostgREST)", () => {
    const g = groupIncidentsByRoom([at("r1", "15:00"), at("r1", "09:00")]);
    expect(g.r1.map((i) => i.id)).toEqual(["r115:00", "r109:00"]);
  });

  it("кабінети не змішуються", () => {
    const g = groupIncidentsByRoom([at("r1", "09:00"), at("r2", "10:00"), at("r1", "11:00")]);
    expect(g.r1).toHaveLength(2);
    expect(g.r2).toHaveLength(1);
    expect(Object.keys(g).sort()).toEqual(["r1", "r2"]);
  });

  it("порожній і невизначений вхід дають порожню мапу, а не виняток", () => {
    expect(groupIncidentsByRoom([])).toEqual({});
    expect(groupIncidentsByRoom(null)).toEqual({});
    expect(groupIncidentsByRoom(undefined)).toEqual({});
  });

  it("рядок без кабінету пропускається, а не створює ключ undefined", () => {
    const g = groupIncidentsByRoom([{ room_id: "" }, at("r1", "09:00")] as Array<{ room_id: string }>);
    expect(Object.keys(g)).toEqual(["r1"]);
  });
});
