/* Аудит с46, U-5 — «✓ Слот вільний» на даних, яких немає.
 *
 * Що було зламано (перевірено особисто по коду, не зі слів субагента):
 *  • екрани бронювання ХОВАЛИ сітку при збої — це вже було правильно;
 *  • але блок підтвердження стояв ПОЗА тією умовою, тож при обраному часі екран
 *    показував червоний банер «показати вільний час не можемо» і зелене
 *    «✓ Слот вільний» одночасно;
 *  • `valid` не містив ні busyError, ні schedErr → кнопка лишалась активною;
 *  • через prefill досяжний шлях, де ПЕРША загрузка впала і spans справді
 *    порожні — тоді «вільний» стверджувалось на нулях, а не на застарілому.
 *
 * Третій екран того ж класу (RescheduleModal) знайшло ревʼю цього пакета.
 *
 * Чому тест такий, а не компонентний: компонентних тестів у проєкті немає
 * (`vitest.config.ts` — environment: "node"). Тому правило винесене в
 * `lib/availabilityTrust.ts` і перевіряється поведінково, а те, що екрани реально
 * ним КОРИСТУЮТЬСЯ, тримають сторожі внизу. Вони читають код без коментарів
 * (`codeOf`) — інакше знайшли б «✓ Слот вільний» у поясненні поруч із правкою.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { slotDataMissLabel, slotDataTrusted, slotDataFromSingleSource, type SlotDataState } from "@/lib/availabilityTrust";
import { codeOf } from "./helpers/codeOf";

const ok: SlotDataState = { busyFailed: false, schedFailed: false, loading: false };
const st = (p: Partial<SlotDataState>): SlotDataState => ({ ...ok, ...p });

describe("slotDataTrusted — коли можна стверджувати «слот вільний»", () => {
  it("усе завантажилось → вірити можна", () => {
    expect(slotDataTrusted(ok)).toBe(true);
    expect(slotDataMissLabel(ok)).toBeNull();
  });

  /* Ключовий випадок U-5: саме тут екран малював зелене підтвердження. */
  it("зайнятість не завантажилась → НЕ вірити", () => {
    expect(slotDataTrusted(st({ busyFailed: true }))).toBe(false);
    expect(slotDataMissLabel(st({ busyFailed: true }))).toBe("Зайнятість кабінету");
  });

  it("графік не завантажився → НЕ вірити", () => {
    expect(slotDataTrusted(st({ schedFailed: true }))).toBe(false);
    expect(slotDataMissLabel(st({ schedFailed: true }))).toBe("Графік кабінету");
  });

  /* Порожній масив spans під час польоту — це «не знаємо», а не «вільно».
     Саме цей шлях досяжний через prefill: модалка відкрита з передзаповненим
     слотом, перший запит ще не відповів, roomBusy = [] → «вільний» на нулях. */
  it("запит ще в польоті → НЕ вірити (spans поки що порожні)", () => {
    expect(slotDataTrusted(st({ loading: true }))).toBe(false);
    expect(slotDataMissLabel(st({ loading: true }))).toBe("Перевіряємо зайнятість…");
  });

  it("обидва збої → одна причина, а не дві плашки", () => {
    expect(slotDataMissLabel(st({ busyFailed: true, schedFailed: true }))).toBe("Зайнятість і графік кабінету");
  });

  /* Порядок — не косметика: якщо попередній запит УПАВ, а новий уже в польоті,
     оператору треба причина, а не спінер. Перевіряємо КОЖНУ пару окремо: з
     одним лише busyFailed-кейсом підняття `loading` між busyFailed і schedFailed
     лишало б усі тести зеленими (ревʼю с46 р2, F8). */
  it("збій ПЕРЕВАЖАЄ політ: зайнятість + loading", () => {
    expect(slotDataMissLabel(st({ busyFailed: true, loading: true }))).toBe("Зайнятість кабінету");
  });
  it("збій ПЕРЕВАЖАЄ політ: графік + loading", () => {
    expect(slotDataMissLabel(st({ schedFailed: true, loading: true }))).toBe("Графік кабінету");
  });
  it("збій ПЕРЕВАЖАЄ політ: обидва + loading", () => {
    expect(slotDataMissLabel(st({ busyFailed: true, schedFailed: true, loading: true })))
      .toBe("Зайнятість і графік кабінету");
  });

  it("slotDataFromSingleSource ставить один прапорець в обидві причини", () => {
    expect(slotDataFromSingleSource(true, false)).toEqual({ busyFailed: true, schedFailed: true, loading: false });
    expect(slotDataMissLabel(slotDataFromSingleSource(true, false))).toBe("Зайнятість і графік кабінету");
    expect(slotDataTrusted(slotDataFromSingleSource(false, false))).toBe(true);
    expect(slotDataTrusted(slotDataFromSingleSource(false, true))).toBe(false);
  });

  it("вхід не мутується", () => {
    const input = st({ busyFailed: true, loading: true });
    const copy = { ...input };
    slotDataMissLabel(input);
    slotDataTrusted(input);
    expect(input).toEqual(copy);
  });
});

/* ===== Сторожі підключення (JSX тестами не покрити) =====
   Переписані після ревʼю р2: перша версія перевіряла `toContain("slotDataTrusted")`,
   що задовольнялося САМИМ РЯДКОМ ІМПОРТУ. Заміна `const availTrusted = true`
   лишала всі сторожі зеленими і повертала дефект цілком. Тепер сторожимо
   ВИКЛИК і ПРИВʼЯЗКУ до живих прапорців. */
const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

type Screen = {
  name: string;
  code: string;
  /** Дослівні прив'язки стану до живих прапорців компонента. */
  bindings: string[];
  /** Виклики правила, які цей екран мусить робити. */
  calls: string[];
  /** Як саме гаситься кнопка збереження в цьому екрані. */
  validGuard: string[];
  /** Чи є на екрані блок «✓ Слот вільний». */
  hasConfirm: boolean;
};

const SCREENS: Screen[] = [
  {
    name: "BookingModal", code: src("components/BookingModal.tsx"),
    bindings: ["busyFailed: busyError", "schedFailed: schedErr", "loading: slotsLoading"],
    calls: ["slotDataMissLabel(availState)", "slotDataTrusted(availState)"],
    validGuard: ["avail: !!availMiss", "avail: availMiss ||"], hasConfirm: true,
  },
  {
    name: "ReferralPortal", code: src("components/ReferralPortal.tsx"),
    bindings: ["slotDataFromSingleSource(slotsErr, slotsLoading)"],
    calls: ["slotDataMissLabel(availState)", "slotDataTrusted(availState)"],
    validGuard: ["avail: !!availMiss", "avail: availMiss ||"], hasConfirm: true,
  },
  {
    name: "RescheduleModal", code: src("components/RescheduleModal.tsx"),
    bindings: ["busyFailed: busyError", "schedFailed: schedErr", "loading: slotsLoading"],
    calls: ["slotDataTrusted(availState)", "slotDataFooterText(availState)"],
    validGuard: ["&& availTrusted"], hasConfirm: false,
  },
];

for (const screen of SCREENS) {
  describe(screen.name + " — правило справді підключене", () => {
    it("кличе спільне правило, а не просто імпортує його", () => {
      expect(screen.code).toContain('from "@/lib/availabilityTrust"');
      for (const c of screen.calls) {
        expect(screen.code).toContain(c);
        // ≥2 входження = імпорт І виклик. Рівно одне означає «імпорт є, виклику немає».
        const fn = c.slice(0, c.indexOf("("));
        expect(screen.code.split(fn).length - 1).toBeGreaterThanOrEqual(2);
      }
    });

    /* Розмити гейт дешевше, ніж прибрати: `availTrusted = slotDataTrusted(...)
       || !!prefill` проходить усі перевірки вище і повертає рівно той prefill-шлях,
       який U-5 назвав головним (ревʼю с46 р3, F4). Диз'юнкції в цьому
       присвоєнні бути не може. */
    it("availTrusted не розмито диз'юнкцією", () => {
      expect(screen.code).not.toMatch(/availTrusted\s*=\s*[^;\n]*\|\|/);
    });

    /* Найдешевша майбутня «правка», яка повертає дефект, — обнулити вхід
       (`loading: false`, бо «кнопка моргає»). Прив'язуємось до живих прапорців. */
    it("стан зібраний із живих прапорців компонента", () => {
      for (const b of screen.bindings) expect(screen.code).toContain(b);
    });

    it("недовірені дані гасять кнопку збереження", () => {
      for (const g of screen.validGuard) expect(screen.code).toContain(g);
    });
  });
}

/* Головний сторож пакета: блок підтвердження мусить стояти ПІД гейтом.
   Форму IIFE навмисно НЕ фіксуємо (ревʼю р2, F7: попередня версія падала від
   перестановки конʼюнктів і від переносу рядка) — перевіряємо, що між
   найближчим `{time &&` і словами «✓ Слот вільний» стоїть availTrusted.
   Плюс рахуємо входження: другий, негейтований блок нижче по файлу перша
   версія сторожа пропускала, бо indexOf брав тільки перше (F6). */
for (const screen of SCREENS.filter((s) => s.hasConfirm)) {
  describe(screen.name + " — «✓ Слот вільний» під гейтом", () => {
    it("підтвердження одне і воно гейтоване", () => {
      const all = [...screen.code.matchAll(/✓ Слот вільний/g)].map((m) => m.index as number);
      expect(all.length).toBe(1);
      for (const ix of all) {
        const gate = screen.code.lastIndexOf("{time &&", ix);
        expect(gate).toBeGreaterThan(-1);
        expect(screen.code.slice(gate, ix)).toContain("availTrusted");
      }
    });
  });
}

/* RescheduleModal блоку підтвердження не має — там єдина точка твердження це
   кнопка. Якщо він колись зʼявиться, цей тест почервоніє і змусить перевести
   екран у hasConfirm, а не мовчки лишити блок без гейта. */
describe("RescheduleModal — блоку підтвердження немає", () => {
  it("немає «✓ Слот вільний»", () => {
    const rm = SCREENS.find((s) => s.name === "RescheduleModal");
    expect(rm?.code).not.toContain("✓ Слот вільний");
  });
});

/* ===== Вхід у бронювання і перенос на дошці черги =====
   Окремий канал від U-5: `incidents` приходять у BookingModal і RescheduleModal
   ПРОПОМ із дошки, тож власні прапорці модалок про цей збій нічого не знають.
   Правило живе на дошці — і мусить бути ОДНЕ на всі входи. Ревʼю р3 (F1)
   показало, чому: гейт стояв на кнопці топбара і на хоткеї, а пункт сайдбара
   «Новий запис» відкривав модалку — при тому, що банер уже стверджував
   «заблоковано». Копія правила відстала рівно так само, як у U-6. */
describe("QueueBoard — бронювання і перенос за одним гейтом", () => {
  const board = src("components/QueueBoard.tsx");

  it("openBooking гейтований і є єдиним входом у модалку", () => {
    expect(board).toMatch(/function openBooking\(\)\s*\{\s*if \(safetyErr\)/);
    // setModalOpen(true) лишається ТІЛЬКИ всередині openBooking.
    expect(board.split("setModalOpen(true)").length - 1).toBe(1);
    expect(board).toContain("onNew={openBooking}");
    expect(board).toContain("onClick={openBooking}");
    /* Хоткей кличе той самий вхід через ref — інакше `openBooking` довелося б
       класти в масив залежностей ефекту (перепідписка слухача на кожен рендер)
       або глушити exhaustive-deps на масиві з двадцяти залежностей, ховаючи
       МАЙБУТНІ пропуски там, де пропуск дає хоткей зі старим станом. */
    expect(board).toMatch(/code === "KeyN"[^\n]*openBookingRef\.current\(\)/);
  });

  /* Ref мусить оновлюватися на КОЖЕН рендер. Присвоєння лише при створенні
     (`useRef(openBooking)` без рядка нижче) законсервувало б перше замикання —
     і хоткей N назавжди лишився б із «дані в порядку» з першого рендера, тобто
     повернув би U-6 саме там, звідки його прибрали. */
  it("ref хоткея тримає СВІЖУ функцію, а не перше замикання", () => {
    expect(board).toMatch(/const openBookingRef = useRef\(openBooking\);\s*\n\s*openBookingRef\.current = openBooking;/);
  });

  it("перенос гейтований у самому openReschedule (покриває всіх викликачів)", () => {
    const m = board.match(/const openReschedule = \(p: QEntry\) => \{[\s\S]*?\n  \};/);
    expect(m).not.toBeNull();
    expect(m?.[0]).toContain("if (safetyErr)");
    expect(board.split("setReschedFor(p)").length - 1).toBe(1);
  });

  it("текст блокування спільний, а не скопійований у компонент", () => {
    expect(board).toContain("SAFETY_BOOKING_BLOCKED");
    expect(board).not.toContain("Дані про простої та графіки не завантажились");
  });
});
