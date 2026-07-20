import { describe, it, expect } from "vitest";
import { modalityFromStudies, waitlistMatchesSlot, type FreedSlot } from "@/lib/waitlist";
import { studiesMatchModality } from "@/lib/studies";
import type { WaitlistEntry } from "@/supabase/types";

/* Покриття нових модальностей (УЗД / Рентген / Мамографія), яких бракувало після
   батчу 0087–0090. Складання підтверджувало лише коректність TypeScript, а не
   клінічну/операційну коректність нових потоків. Тут — чиста логіка lib/*:
   1) modalityFromStudies (пункт 1) — тип дослідження → код enum;
   2) studiesMatchModality — інваріант «тип ↔ модальність кабінету» (дзеркало
      SQL study_type_modality / триггера check_studies_match_room, 0088);
   3) waitlistMatchesSlot — підбір кандидата нового типу на слот своєї модальності.

   Пункт 8 (гонка двох адміністраторів за одного кандидата) — рівня БД: CAS
   waiting→scheduled + claim_token (0089) у scheduleFromWaitlist. Юніт-тестом
   чистої логіки не відтворюється; перевіряється дизайном 0089/0090 і живим
   двовкладковим прогоном. */

describe("modalityFromStudies — тип дослідження → код модальності", () => {
  it('УЗД → US (головний баг: раніше все не-КТ схлопувалось у MRI)', () => {
    expect(modalityFromStudies([{ type: "УЗД", region: "УЗД органів черевної порожнини" }])).toBe("US");
  });

  it("повна матриця укр. лейблів типу", () => {
    expect(modalityFromStudies([{ type: "МРТ" }])).toBe("MRI");
    expect(modalityFromStudies([{ type: "КТ" }])).toBe("CT");
    expect(modalityFromStudies([{ type: "УЗД" }])).toBe("US");
    expect(modalityFromStudies([{ type: "Рентген" }])).toBe("XRAY");
    expect(modalityFromStudies([{ type: "Мамографія" }])).toBe("MAMMO");
    expect(modalityFromStudies([{ type: "Інше" }])).toBe("OTHER");
  });

  it("приймає і код enum як type", () => {
    expect(modalityFromStudies([{ type: "US" }])).toBe("US");
    expect(modalityFromStudies([{ type: "XRAY" }])).toBe("XRAY");
    expect(modalityFromStudies([{ type: "MAMMO" }])).toBe("MAMMO");
  });

  it("порожньо / без type → MRI (безпечний дефолт, зворотна сумісність)", () => {
    expect(modalityFromStudies([])).toBe("MRI");
    expect(modalityFromStudies(null)).toBe("MRI");
    expect(modalityFromStudies(undefined)).toBe("MRI");
    expect(modalityFromStudies([{ region: "щось" }])).toBe("MRI");
  });

  it("бере ПЕРШЕ дослідження із заданим типом", () => {
    expect(modalityFromStudies([{ region: "без типу" }, { type: "УЗД" }])).toBe("US");
  });

  it("невідомий тип → OTHER", () => {
    expect(modalityFromStudies([{ type: "Абракадабра" }])).toBe("OTHER");
  });
});

describe("studiesMatchModality — інваріант «тип ↔ модальність кабінету» (дзеркало 0088)", () => {
  it("усі дослідження збігаються з модальністю кабінету → true", () => {
    expect(studiesMatchModality([{ type: "УЗД" }], "US")).toBe(true);
    expect(studiesMatchModality([{ type: "Рентген" }], "XRAY")).toBe(true);
    expect(studiesMatchModality([{ type: "Мамографія" }], "MAMMO")).toBe(true);
  });

  it("невідповідність → false (саме це відбив сервер у стале-вкладковому тесті)", () => {
    expect(studiesMatchModality([{ type: "Рентген" }], "US")).toBe(false);
    expect(studiesMatchModality([{ type: "УЗД" }], "MRI")).toBe(false);
  });

  it("кабінет OTHER або без модальності — не обмежуємо", () => {
    expect(studiesMatchModality([{ type: "УЗД" }], "OTHER")).toBe(true);
    expect(studiesMatchModality([{ type: "УЗД" }], null)).toBe(true);
    expect(studiesMatchModality([{ type: "УЗД" }], undefined)).toBe(true);
  });

  it("порожній склад — не обмежуємо", () => {
    expect(studiesMatchModality([], "US")).toBe(true);
    expect(studiesMatchModality(null, "US")).toBe(true);
  });

  it("хоч одне дослідження не тієї модальності → false", () => {
    expect(studiesMatchModality([{ type: "УЗД" }, { type: "Рентген" }], "US")).toBe(false);
  });
});

describe("waitlistMatchesSlot — кандидат нового типу підбирається на слот СВОЄЇ модальності", () => {
  const base = {
    status: "waiting",
    desired_date_from: null,
    desired_date_to: null,
    desired_time_from: null,
    desired_time_to: null,
    room_id: null,
    priority_level: "planned",
    created_at: "2026-07-16T08:00:00Z",
  };
  const wl = (over: Partial<WaitlistEntry>): WaitlistEntry => ({ ...base, ...over } as unknown as WaitlistEntry);
  const slot = (over: Partial<FreedSlot>): FreedSlot => ({ date: "2026-07-16", timeMin: 540, ...over });

  it("US-кандидат підходить під US-слот", () => {
    expect(waitlistMatchesSlot(wl({ modality: "US" }), slot({ modality: "US" }))).toBe(true);
  });

  it("US-кандидат НЕ підходить під MRI-слот (регресія: раніше US зберігався як MRI і потрапляв не туди)", () => {
    expect(waitlistMatchesSlot(wl({ modality: "US" }), slot({ modality: "MRI" }))).toBe(false);
  });

  it("XRAY / MAMMO кандидати матчаться саме за своєю модальністю", () => {
    expect(waitlistMatchesSlot(wl({ modality: "XRAY" }), slot({ modality: "XRAY" }))).toBe(true);
    expect(waitlistMatchesSlot(wl({ modality: "MAMMO" }), slot({ modality: "MAMMO" }))).toBe(true);
    expect(waitlistMatchesSlot(wl({ modality: "MAMMO" }), slot({ modality: "US" }))).toBe(false);
  });

  it("жорстка прив'язка до кабінету: інший room_id → не матч", () => {
    expect(
      waitlistMatchesSlot(wl({ modality: "US", room_id: "room-A" }), slot({ modality: "US", roomId: "room-B" })),
    ).toBe(false);
  });

  it("статус не waiting → ніколи не матч", () => {
    expect(waitlistMatchesSlot(wl({ modality: "US", status: "scheduled" }), slot({ modality: "US" }))).toBe(false);
  });
});
