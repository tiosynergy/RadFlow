/* ===== RadFlow — «стінний» час → РЕАЛЬНИЙ інстант (фаза 3, пакет 2) =====

   Навіщо цей файл існує. Модель часу продукту (канон 0035) зберігає розклад
   у «стінних» хвилинах: 08:00 — це 08:00 на годиннику клініки, без зони.
   REST v1 так їх назовні й віддає, разом із `timezone`, лишаючи конверсію
   консюмеру. FHIR так не вміє: `Slot.start`/`Slot.end` — це `instant`,
   тобто АБСОЛЮТНИЙ момент з офсетом. Отже конверсію, від якої v1 ухилився,
   робить фасад.

   У lib/incidents.ts уже є зворотний напрям (реальний інстант → стінний час:
   `wallMinOfInstant`, `wallInstantOf`). Цей модуль — його ІНВЕРСІЯ, і він
   свідомо збудований ПОВЕРХ `wallInstantOf`, а не паралельно йому: два
   незалежні механізми конверсії зон розійшлися б на першому ж переході DST,
   і розбіжність вилізла б у проді як «слот на годину не там».

   Головна пастка, заради якої тут стільки коду: доба переходу НЕ дорівнює
   1440 хвилинам. В Europe/Kyiv в останню неділю березня доба має 23 години,
   у жовтні — 25. Тому кожна межа інтервалу конвертується ОКРЕМО зі свого
   стінного часу; обчислити початок і додати `(end - start) * 60000` не
   можна — саме так зʼявляється зсув на годину, який виглядає як дрібниця,
   а означає пацієнта, що приїхав не в ту годину. */

import { wallInstantOf } from "@/lib/incidents";

/** Як розвʼязано стінний час, якого в календарі немає або який трапляється двічі. */
export type WallResolution = "exact" | "gap" | "ambiguous";

export interface WallInstant {
  /** РЕАЛЬНИЙ момент (мс від епохи). */
  ms: number;
  resolution: WallResolution;
}

/** «Стінний» відбиток моменту `ms` у зоні `tz`, закодований як псевдо-UTC —
    той самий фрейм, що `wallInstant(date, time)` у lib/incidents.ts. */
function wallFrameOf(ms: number, tz: string): number {
  const w = wallInstantOf(new Date(ms).toISOString(), tz);
  // wallInstantOf повертає null лише на невалідному ISO; ms тут завжди валідний.
  return w ?? ms;
}

/** Офсет зони (хвилини на схід від UTC) у момент `ms`. */
function offsetMinutesAt(ms: number, tz: string): number {
  return Math.round((wallFrameOf(ms, tz) - ms) / 60000);
}

/** Стінний час (дата + хвилини доби) у зоні клініки → РЕАЛЬНИЙ інстант.

    `minOfDay` може дорівнювати 1440 — це «кінець доби», тобто 00:00
    наступного дня (v1 кодує кінець вікна саме так, щоб вікно до півночі не
    схлопувалось у нуль). Арифметика це переживає без окремої гілки.

    Розвʼязання країв DST:
    - `gap` — стінного часу не існує (в Києві 03:00–03:59 в останню неділю
      березня). Повертаємо момент переходу: зсув уперед на довжину провалу.
      Так само чинить java.time.ZonedDateTime — вигадувати свою поведінку в
      медичному розкладі не варто.
    - `ambiguous` — стінний час трапляється двічі (жовтень). Беремо ПЕРШЕ
      входження, тобто ще за літнім офсетом. Це теж канон ZonedDateTime і
      єдиний варіант, за якого послідовні слоти доби лишаються зростаючими. */
export function wallToInstant(dateKey: string, minOfDay: number, tz: string): WallInstant {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return { ms: NaN, resolution: "exact" };
  const target =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + minOfDay * 60000;

  /* Кандидати. Наївне двокрокове наближення тут НЕ працює: восени обидва
     кроки сходяться до ДРУГОГО входження неоднозначної години, і перше
     (ще за літнім офсетом) не породжується взагалі — неоднозначність
     лишається непоміченою. Тому беремо офсети зони по ОБИДВА боки від
     приблизного моменту: якщо перехід поруч, вони різні, і кандидатів два. */
  const approx = target - offsetMinutesAt(target, tz) * 60000;
  const SIX_H = 6 * 3600000;
  const offsets = Array.from(
    new Set([offsetMinutesAt(approx - SIX_H, tz), offsetMinutesAt(approx + SIX_H, tz)])
  );
  const candidates = Array.from(new Set(offsets.map((o) => target - o * 60000)));
  const valid = candidates.filter((t) => wallFrameOf(t, tz) === target);

  if (valid.length === 1) return { ms: valid[0], resolution: "exact" };
  if (valid.length > 1) return { ms: Math.min(...valid), resolution: "ambiguous" };
  /* Жодного валідного кандидата — стінного часу не існує (провал). Більший
     кандидат тлумачить час за СТАРИМ офсетом, що й дає зсув уперед рівно на
     довжину провалу: 03:30 → 04:30. */
  return { ms: Math.max(...candidates), resolution: "gap" };
}

/** `instant` за R4: завжди UTC із суфіксом Z і секундами.

    FHIR дозволяє і локальний офсет (`+03:00`), і Z. Обираємо Z СВІДОМО:
    офсет клініки все одно відомий партнеру з `Location`/`timezone`, а
    єдиний формат прибирає цілий клас помилок порівняння на боці RIS. */
export function toFhirInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Стінний інтервал доби → пара FHIR-instant.

    Кожна межа конвертується ОКРЕМО — у цьому весь сенс функції. На добі
    переходу інтервал 08:00–20:00 триває 11 або 13 реальних годин, і
    додавання хвилин до початку дало б неправильний кінець. */
export function wallIntervalToInstants(
  dateKey: string,
  startMin: number,
  endMin: number,
  tz: string
): { start: string; end: string; resolution: WallResolution } {
  const s = wallToInstant(dateKey, startMin, tz);
  const e = wallToInstant(dateKey, endMin, tz);
  const resolution: WallResolution =
    s.resolution !== "exact" ? s.resolution : e.resolution;
  return { start: toFhirInstant(s.ms), end: toFhirInstant(e.ms), resolution };
}
