import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  zUuid, zDateKey, zTime, zSlotTime, zDuration, zBuffer, zStudies, zRoomIdsGrant, zIdList, zOptText, zOptEmail,
  zOptDob, zOptAge, zOptWeight,
} from "@/lib/validation";
import { SLOT_STEP, slotFmt } from "@/lib/slots";

/* Валідація на межі (M-12). Тести фіксують саме ті випадки, через які раніше
   сміття доїжджало до БД, і ті канони, які НЕ можна зламати (0061 room_ids). */

describe("zTime — формат «HH:MM» (M-1)", () => {
  it("приймає рівно HH:MM", () => {
    expect(zTime.safeParse("08:05").success).toBe(true);
    expect(zTime.safeParse("23:59").success).toBe(true);
    expect(zTime.safeParse("00:00").success).toBe(true);
  });
  /* Саме через це існував «запис-привид»: scheduled_time — вільний text, "8:5"
     зберігався і ставав 08:05 у scheduled_at, але ключа "8:5" немає в сітці слотів. */
  it("відхиляє «8:5», «25:00», «12:60» і сміття", () => {
    for (const bad of ["8:5", "8:05", "25:00", "12:60", "12:5a", "", "1200"]) {
      expect(zTime.safeParse(bad).success, bad).toBe(false);
    }
  });
});

/* Техаудит 2026-07-27, High-1: '09:03' проходив zTime і через Server Action
   давав off-grid запис — «є», займає час, але не видимий у жодній клітинці
   сітки SlotPicker. zSlotTime — лише для часу СЛОТА (не для годин роботи).
   Дзеркало в БД — guard_slot_grid (0125); зміна кроку сітки = міняти всі три
   (SLOT_STEP, zSlotTime, тригер). */
describe("zSlotTime — слот на сітці 5 хв", () => {
  /* Звʼязка трьох констант «5» (ревʼю с15, Low-2): SLOT_STEP (сітка UI),
     zSlotTime (сервер) і guard_slot_grid 0125 (БД). Якщо SLOT_STEP стане
     некратним 5 (напр., 3) — SlotPicker почне видавати часи, які сервер і БД
     відкинуть, і першою це побачить реєстратура. Хай першим падає ЦЕЙ тест. */
  it("узгоджений із SLOT_STEP: перший крок сітки — валідний слот", () => {
    expect(SLOT_STEP % 5, "SLOT_STEP має лишатися кратним 5 (інакше міняй і zSlotTime, і тригер 0125)").toBe(0);
    expect(zSlotTime.safeParse(slotFmt(SLOT_STEP)).success).toBe(true);
  });
  it("приймає часи, кратні 5 хвилинам", () => {
    for (const ok of ["09:05", "00:00", "23:55", "12:30"]) {
      expect(zSlotTime.safeParse(ok).success, ok).toBe(true);
    }
  });
  it("відхиляє off-grid і сміття (зокрема 23:59 — валідний zTime, але не слот)", () => {
    for (const bad of ["09:03", "23:59", "12:01", "8:05", "09:05:00", ""]) {
      expect(zSlotTime.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("zDateKey — реальна дата", () => {
  it("приймає YYYY-MM-DD", () => {
    expect(zDateKey.safeParse("2026-07-13").success).toBe(true);
  });
  it("відхиляє неіснуючу дату й інші формати", () => {
    for (const bad of ["2026-02-31", "2026-13-01", "13.07.2026", "2026-7-1", ""]) {
      expect(zDateKey.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("zDuration / zBuffer — нормалізація, а не мовчазний клампінг сміття", () => {
  it("кратність 5 і межі [5,480]", () => {
    expect(zDuration.parse(30)).toBe(30);
    expect(zDuration.parse(47)).toBe(45);   // normDur округлює до кроку сітки
    expect(zDuration.parse(600)).toBe(480); // стеля = CHECK 0066
  });
  /* duration_min = 0 давав порожній tstzrange → check_no_overlap не спрацьовував
     → ДВОЙНА БРОНЬ. Нуль і від'ємні тепер не проходять межу взагалі. */
  it("0, від'ємні, NaN і рядки — відхиляє", () => {
    for (const bad of [0, -30, NaN, Infinity, "30", null, undefined]) {
      expect(zDuration.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
  it("буфер клампиться в 0/5/10/15", () => {
    expect(zBuffer.parse(5)).toBe(5);
    expect(zBuffer.parse(7)).toBe(5);
    expect(zBuffer.parse(60)).toBe(15);
    expect(zBuffer.safeParse(-5).success).toBe(false);
  });
});

describe("zStudies — невідомі ключі відкидаються (частина L-2)", () => {
  it("лишає лише відомі поля", () => {
    const out = zStudies.parse([{ type: "МРТ", region: "Головний мозок", contrast: true, dur: 60, price: 2400, injected: "<script>" }]);
    expect(out[0]).toEqual({ type: "МРТ", region: "Головний мозок", contrast: true, dur: 60, price: 2400 });
    expect("injected" in out[0]).toBe(false);
  });
  it("не масив — відхиляє", () => {
    expect(zStudies.safeParse({ type: "МРТ" }).success).toBe(false);
  });
});

describe("zRoomIdsGrant — канон 0061 (порожній масив ≠ «усі кабінети»)", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("null / відсутній = усі кабінети", () => {
    expect(zRoomIdsGrant.parse(null)).toBeNull();
    expect(zRoomIdsGrant.parse(undefined)).toBeNull();
  });
  /* Найдорожчий баг у цьому файлі: адмін знімав ВСІ галочки, щоб ЗАБРАТИ доступ,
     а [] нормалізувався в null → доступ ВІДКРИВАВСЯ до всіх кабінетів. */
  it("ПОРОЖНІЙ масив — помилка, а не «усі»", () => {
    expect(zRoomIdsGrant.safeParse([]).success).toBe(false);
  });
  it("непорожній масив UUID — підмножина (з dedupe)", () => {
    expect(zRoomIdsGrant.parse([id, id])).toEqual([id]);
  });
  it("не-масив і невалідні UUID — помилка, а не «усі»", () => {
    expect(zRoomIdsGrant.safeParse("all").success).toBe(false);
    expect(zRoomIdsGrant.safeParse(["not-a-uuid"]).success).toBe(false);
  });
});

describe("zIdList — масовий обдзвін", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  it("дедуплікує", () => {
    expect(zIdList.parse([id, id])).toEqual([id]);
  });
  it("невалідний id — відхиляє весь запит", () => {
    expect(zIdList.safeParse([id, "junk"]).success).toBe(false);
  });
  it("стеля 500", () => {
    expect(zIdList.safeParse(Array(501).fill(id)).success).toBe(false);
  });
});

/* Найдорожча властивість патч-схем: ВІДСУТНІЙ ключ має лишитись відсутнім.
   Якщо zod підставить undefined → null, патч ПІБ затре телефон, ДР і вагу. */
describe("патч-схеми: відсутній ключ ≠ null", () => {
  const sPatch = z.object({
    patient_name: z.string().trim().min(1).optional(),
    patient_phone: z.union([z.string().trim().max(32), z.null()]).optional(),
    patient_weight: z.union([z.number().min(0).max(400), z.null()]).optional(),
  });

  it("у результаті лише ті ключі, що були у вході", () => {
    const out = sPatch.parse({ patient_name: "Іваненко І." });
    expect(Object.keys(out)).toEqual(["patient_name"]);
    expect("patient_phone" in out).toBe(false);
  });

  it("явний null проходить (це «стерти значення»)", () => {
    const out = sPatch.parse({ patient_phone: null });
    expect(out.patient_phone).toBeNull();
  });

  it("невідомі ключі (status, room_id, scheduled_at) відкидаються", () => {
    const out = sPatch.parse({ patient_name: "І.", status: "done", room_id: "x", scheduled_at: "2020-01-01" }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["patient_name"]);
  });
});

/* Графік дня: «18:00–08:00» зберігався, і сітка слотів на цю дату просто зникала. */
describe("години графіка: start < end", () => {
  const sHours = z.object({ start: zTime, end: zTime }).refine((v) => v.start < v.end, "кінець пізніше за початок");

  it("нормальні години", () => {
    expect(sHours.safeParse({ start: "09:00", end: "15:00" }).success).toBe(true);
  });
  it("перевернуте вікно і порожні поля — відхиляє", () => {
    expect(sHours.safeParse({ start: "18:00", end: "08:00" }).success).toBe(false);
    expect(sHours.safeParse({ start: "09:00", end: "09:00" }).success).toBe(false);
    expect(sHours.safeParse({ start: "", end: "15:00" }).success).toBe(false);
  });
});

describe("пацієнт: ДР / вік / вага", () => {
  it("ДР: сміття не проходить (раніше booking приймав будь-який рядок ≤10)", () => {
    expect(zOptDob.parse("")).toBeNull();
    expect(zOptDob.parse(undefined)).toBeNull();
    expect(zOptDob.parse("1980-05-17")).toBe("1980-05-17");
    expect(zOptDob.safeParse("17.05.1980").success).toBe(false);
    expect(zOptDob.safeParse("1980-02-31").success).toBe(false);
  });
  it("вік і вага: межі", () => {
    expect(zOptAge.parse(null)).toBeNull();
    expect(zOptAge.parse(45)).toBe(45);
    expect(zOptAge.safeParse(5000).success).toBe(false);
    expect(zOptWeight.parse(72.5)).toBe(72.5);
    expect(zOptWeight.safeParse(9999).success).toBe(false);
  });
});

describe("zUuid / zOptText / zOptEmail", () => {
  it("uuid", () => {
    expect(zUuid.safeParse("11111111-2222-3333-4444-555555555555").success).toBe(true);
    expect(zUuid.safeParse("1234").success).toBe(false);
  });
  it("порожній рядок і undefined → null (як старе `x || null`)", () => {
    expect(zOptText(50).parse("")).toBeNull();
    expect(zOptText(50).parse(undefined)).toBeNull();
    expect(zOptText(50).parse("  текст  ")).toBe("текст");
    expect(zOptText(5).safeParse("занадто довгий").success).toBe(false);
  });
  it("email: порожній → null, некоректний → помилка, коректний → lowercase", () => {
    expect(zOptEmail.parse("")).toBeNull();
    expect(zOptEmail.parse("Likar@Clinic.UA")).toBe("likar@clinic.ua");
    expect(zOptEmail.safeParse("no-at-sign").success).toBe(false);
  });
});
