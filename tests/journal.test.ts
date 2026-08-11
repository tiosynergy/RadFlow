/**
 * «Журнал дій» (с25, ТЗ §11) — чиста логіка формулювань і контракту фільтрів.
 *
 * Тут перевіряється те, що вирішує коректність екрана і не видно в tsc:
 *  - формат рядка події збігається з прикладами ТЗ §11;
 *  - рід дієслова: людина — «переніс», система — безособове «перенесено»
 *    (спіймано живою перевіркою екрана);
 *  - у заголовок НЕ потрапляють значення полів пацієнта — лише НАЗВИ (§4.4);
 *  - екран рендерить лише ВІДОМІ ключі details: сторонній ключ ігнорується
 *    (третя лінія захисту від PII після TS-allowlist і CHECK у БД);
 *  - нормалізація періоду і keyset-курсор журналу.
 */
import { describe, expect, it } from "vitest";

import {
  actorRoleLabel,
  changedFieldsLabel,
  entityLabel,
  eventDotClass,
  eventTitle,
  eventTypeLabel,
  fmtDayKey,
  fmtInstant,
  fmtTime,
  shortId,
  statusLabel,
} from "@/lib/journalText";
import {
  ALL_EVENT_TYPES,
  JOURNAL_SPAN_MAX_DAYS,
  decodeJournalCursor,
  encodeJournalCursor,
  normalizeJournalRequest,
  dayStartIso,
  shiftDayKey,
  spanDays,
} from "@/lib/journalContract";

/* ------------------------------------------------ формат рядка (ТЗ §11) */

describe("eventTitle: формат за прикладами ТЗ §11", () => {
  it("«Направник переніс запис: … → …»", () => {
    const t = eventTitle({
      eventType: "referral.rescheduled",
      actorRole: "referrer",
      details: {
        from: { date: "2026-08-05", time: "10:00", roomId: "r1" },
        to: { date: "2026-08-05", time: "11:20", roomId: "r1" },
      },
    });
    expect(t).toBe("Направник переніс запис: 05.08.2026 10:00 → 05.08.2026 11:20");
  });

  it("«Адміністратор змінив дослідження у направленні»", () => {
    expect(eventTitle({ eventType: "referral.studies_changed", actorRole: "admin", details: null }))
      .toBe("Адміністратор змінив дослідження у направленні");
  });

  it("«Адміністратор відкликав доступ направника до центру»", () => {
    expect(eventTitle({ eventType: "referral.access_revoked", actorRole: "admin", details: null }))
      .toBe("Адміністратор відкликав доступ направника до центру");
  });

  it("статуси перекладені, а не сирі", () => {
    const t = eventTitle({
      eventType: "queue.status_changed",
      actorRole: "admin",
      details: { previousStatus: "scheduled", newStatus: "in_progress" },
    });
    expect(t).toBe("Адміністратор змінив статус запису: Заплановано → Триває");
  });

  it("подія від RIS (0146) названа джерелом, а не безіменною «Системою»", () => {
    const t = eventTitle({
      eventType: "integration.status_applied",
      actorRole: "system",
      details: { event: "finished", from: "in_progress", to: "done", integration: "RIS Мед-Експерт" },
    });
    expect(t).toBe("Система: оновлено статус із зовнішньої системи: Триває → Виконано (RIS Мед-Експерт)");
  });

  it("кожен оголошений тип події має власне формулювання (без сирого типу)", () => {
    for (const t of ALL_EVENT_TYPES) {
      const s = eventTitle({ eventType: t, actorRole: "admin", details: null });
      expect(s, `тип ${t} не має формулювання`).not.toContain(t);
      expect(s.length).toBeGreaterThan(10);
    }
  });
});

/* ------------------------------------------------------ рід дієслова */

describe("рід дієслова: система говорить безособово", () => {
  it("людина — чоловічий рід", () => {
    expect(eventTitle({ eventType: "incident.emergency_stop", actorRole: "admin", details: null }))
      .toBe("Адміністратор зупинив кабінет (аварія)");
  });

  it("система — «Система: зупинено», а не «Система зупинив»", () => {
    const t = eventTitle({ eventType: "incident.emergency_stop", actorRole: "system", details: null });
    expect(t).toBe("Система: зупинено кабінет (аварія)");
    expect(t).not.toContain("Система зупинив");
  });

  /* ⚠️ Тут була ПОРОЖНЯ перевірка (ревʼю с25 LOW-5): у JS `\b` спирається на
     \w = [A-Za-z0-9_], тож між кириличною «в» і пробілом межі слова НЕМАЄ —
     регексп не спрацьовував НІКОЛИ. Тепер — явний lookahead на пробіл/кінець. */
  const MASC_AFTER_SYSTEM = /^Система:\s+\S*(ив|їв|ів|ав)(?=\s|$)/u;

  it("сторож роду справді ловить чоловічу форму (перевірка самого регекспа)", () => {
    expect("Система: зупинив кабінет").toMatch(MASC_AFTER_SYSTEM);
    expect("Система: створив запис").toMatch(MASC_AFTER_SYSTEM);
    expect("Система: зупинено кабінет").not.toMatch(MASC_AFTER_SYSTEM);
  });

  it("жодне системне формулювання не має чоловічого закінчення «-ив/-ів»", () => {
    for (const t of ALL_EVENT_TYPES) {
      const s = eventTitle({ eventType: t, actorRole: "system", details: null });
      expect(s, `тип ${t}: «${s}»`).not.toMatch(MASC_AFTER_SYSTEM);
    }
  });
});

/* ----------------------------------------------------------- PII (§4.4) */

describe("у заголовку немає значень полів пацієнта", () => {
  it("changed_fields дають НАЗВИ полів, не значення", () => {
    const t = eventTitle({
      eventType: "referral.patient_data_changed",
      actorRole: "admin",
      changedFields: ["patient_phone", "patient_dob"],
      details: null,
    });
    expect(t).toBe("Адміністратор змінив дані пацієнта у направленні (телефон, дата народження)");
    expect(t).not.toMatch(/\d{5,}/); // жодних телефонів
  });

  it("сторонній ключ details ІГНОРУЄТЬСЯ (рендеримо лише відомі ключі)", () => {
    const t = eventTitle({
      eventType: "queue.status_changed",
      actorRole: "admin",
      details: { previousStatus: "scheduled", newStatus: "waiting", patient_name: "Петренко Іван" },
    });
    expect(t).not.toContain("Петренко");
  });

  it("надто довгий рядок у details не потрапляє в заголовок", () => {
    const t = eventTitle({
      eventType: "access.denied",
      actorRole: "admin",
      details: { path: "x".repeat(200) },
    });
    expect(t).toBe("Адміністратор: відмовлено в доступі");
  });

  it("changedFieldsLabel не показує значень", () => {
    expect(changedFieldsLabel(["patient_name"])).toBe("ПІБ");
    expect(changedFieldsLabel([])).toBe("");
    expect(changedFieldsLabel(null)).toBe("");
  });
});

/* ------------------------------------------------------- дрібні хелпери */

describe("хелпери відображення", () => {
  it("fmtDayKey ріже рядок, а не парсить у Date", () => {
    expect(fmtDayKey("2026-08-05")).toBe("05.08.2026");
    expect(fmtDayKey("сміття")).toBe("сміття");
    expect(fmtDayKey(null)).toBe("");
  });

  it("fmtTime відкидає секунди", () => {
    expect(fmtTime("10:30:00")).toBe("10:30");
  });

  it("fmtInstant показує час У ЗОНІ ЦЕНТРУ, а не браузера", () => {
    // 08:47 UTC = 11:47 у Києві (UTC+3 влітку).
    expect(fmtInstant("2026-08-06T08:47:26.601Z", "Europe/Kyiv")).toBe("06.08.2026 11:47");
    // Інша зона — інший час того ж інстанта.
    expect(fmtInstant("2026-08-06T08:47:26.601Z", "UTC")).toBe("06.08.2026 08:47");
  });

  it("fmtInstant не падає на невалідній зоні", () => {
    expect(fmtInstant("2026-08-06T08:47:00.000Z", "Not/AZone")).toContain("2026-08-06");
  });

  it("статуси, ролі, сутності мають людські підписи", () => {
    expect(statusLabel("no_show")).toBe("Неявка");
    expect(actorRoleLabel("referrer")).toBe("Направник");
    expect(entityLabel("waitlist_entry")).toBe("лист очікування");
  });

  it("shortId ріже uuid до 8 символів", () => {
    expect(shortId("209d9513-1111-4111-8111-111111111111")).toBe("209d9513");
  });

  it("колір крапки за сім'єю події", () => {
    expect(eventDotClass("incident.emergency_stop")).toBe("red");
    expect(eventDotClass("access.denied")).toBe("orange");
    expect(eventDotClass("referral.created")).toBe("blue");
    expect(eventDotClass("case.created")).toBe("yellow");
    expect(eventDotClass("queue.created")).toBe("green");
  });

  it("eventTypeLabel — підпис без імені актора (для випадайки)", () => {
    expect(eventTypeLabel("referral.access_revoked")).toBe("Відкликав доступ направника до центру");
    for (const t of ALL_EVENT_TYPES) {
      expect(eventTypeLabel(t)).not.toContain("Адміністратор");
    }
  });
});

/* ------------------------------------------------------------ контракт */

describe("normalizeJournalRequest: період", () => {
  it("без дат — останні 30 днів від «сьогодні» центру", () => {
    const r = normalizeJournalRequest({}, "2026-08-06");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.dateTo).toBe("2026-08-06");
    expect(r.filters.dateFrom).toBe("2026-07-08");
    expect(spanDays(r.filters.dateFrom, r.filters.dateTo)).toBe(30);
  });

  it("перевернутий діапазон відхиляється", () => {
    const r = normalizeJournalRequest({ dateFrom: "2026-08-06", dateTo: "2026-08-01" }, "2026-08-06");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("bad_range");
  });

  it("задовгий період відхиляється", () => {
    const from = shiftDayKey("2026-08-06", -(JOURNAL_SPAN_MAX_DAYS + 5));
    const r = normalizeJournalRequest({ dateFrom: from, dateTo: "2026-08-06" }, "2026-08-06");
    expect(r.ok).toBe(false);
  });

  it("порожній масив типів = без фільтра типів", () => {
    const r = normalizeJournalRequest({ eventTypes: [] }, "2026-08-06");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.eventTypes).toBeUndefined();
  });

  it("межа рівно в максимум приймається", () => {
    const from = shiftDayKey("2026-08-06", -(JOURNAL_SPAN_MAX_DAYS - 1));
    const r = normalizeJournalRequest({ dateFrom: from, dateTo: "2026-08-06" }, "2026-08-06");
    expect(r.ok).toBe(true);
  });
});

describe("keyset-курсор журналу", () => {
  it("кодування → декодування без втрат", () => {
    const c = { at: "2026-08-06T08:47:26.601543+00:00", id: "11111111-1111-4111-8111-111111111111" };
    expect(decodeJournalCursor(encodeJournalCursor(c))).toEqual(c);
  });

  it("сміття у курсорі = null (починаємо спочатку), а не виняток", () => {
    expect(decodeJournalCursor("не-base64")).toBeNull();
    expect(decodeJournalCursor(Buffer.from('{"at":"x"}').toString("base64url"))).toBeNull();
    expect(decodeJournalCursor(undefined)).toBeNull();
  });

  it("курсор із чужим id-форматом відхиляється", () => {
    const bad = Buffer.from(JSON.stringify({ at: "2026-08-06T08:47:26Z", id: "1; drop table" })).toString("base64url");
    expect(decodeJournalCursor(bad)).toBeNull();
  });
});

describe("shiftDayKey / spanDays — календарна арифметика", () => {
  it("зсув через межу місяця", () => {
    expect(shiftDayKey("2026-08-01", -1)).toBe("2026-07-31");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("spanDays рахує включно", () => {
    expect(spanDays("2026-08-06", "2026-08-06")).toBe(1);
    expect(spanDays("2026-08-01", "2026-08-07")).toBe(7);
  });
});

/* ------------------------------------------------- межі доби (ревʼю с25 M2) */

describe("dayStartIso: початок доби в зоні центру", () => {
  it("Київ влітку — UTC+3", () => {
    expect(dayStartIso("2026-08-06", "Europe/Kyiv")).toBe("2026-08-05T21:00:00.000Z");
  });

  it("Київ взимку — UTC+2", () => {
    expect(dayStartIso("2026-01-15", "Europe/Kyiv")).toBe("2026-01-14T22:00:00.000Z");
  });

  it("UTC — рівно опівночі", () => {
    expect(dayStartIso("2026-08-06", "UTC")).toBe("2026-08-06T00:00:00.000Z");
  });

  it("мс завжди нульові (верхня межа = початок наступної доби з lt)", () => {
    for (const tz of ["Europe/Kyiv", "UTC", "America/New_York", "Asia/Tokyo"]) {
      expect(dayStartIso("2026-03-15", tz).endsWith(":00.000Z")).toBe(true);
    }
  });

  it("перехід НАЗАД опівночі: беремо ранішого кандидата", () => {
    // Santiago 05.04.2026 — годинник переводять назад опівночі.
    expect(dayStartIso("2026-04-05", "America/Santiago")).toBe("2026-04-05T04:00:00.000Z");
  });

  it("перехід ВПЕРЕД опівночі: локальної півночі не існує — перший інстант доби", () => {
    /* Santiago 06.09.2026 і Havana 08.03.2026: одноходовий зсув давав годину
       НАЗАД (03:00Z / 04:00Z), тобто події 23:00–23:59 попереднього дня
       потрапляли в наступний. Ревʼю с25, раунд 2. */
    expect(dayStartIso("2026-09-06", "America/Santiago")).toBe("2026-09-06T04:00:00.000Z");
    expect(dayStartIso("2026-03-08", "America/Havana")).toBe("2026-03-08T05:00:00.000Z");
  });

  it("доба НЕ перекривається і не має дірки: кінець дня = початок наступного", () => {
    /* Саме це рахує роут: верхня межа періоду — dayStartIso(dateTo + 1).
       Тавтологію (порівняння виклику з самим собою) ревʼю раунду 2 спіймало. */
    for (const tz of ["America/Santiago", "America/Havana", "Europe/Kyiv", "Pacific/Chatham"]) {
      for (const d of ["2026-04-04", "2026-04-05", "2026-09-05", "2026-09-06", "2026-03-07", "2026-03-08"]) {
        const start = dayStartIso(d, tz);
        const next = dayStartIso(shiftDayKey(d, 1), tz);
        // Строго зростає: доба непорожня, дірок і перекриттів немає.
        expect(start < next, `${tz} ${d}: ${start} !< ${next}`).toBe(true);
        // Довжина доби — 23, 24 або 25 годин (переходи DST), не більше.
        const hours = (Date.parse(next) - Date.parse(start)) / 3600000;
        expect(hours, `${tz} ${d}: ${hours} год`).toBeGreaterThanOrEqual(23);
        expect(hours).toBeLessThanOrEqual(25);
      }
    }
  });

  it("невалідна зона не валить запит", () => {
    expect(dayStartIso("2026-08-06", "Not/AZone")).toBe("2026-08-06T00:00:00.000Z");
  });
});

describe("курсор: алфавіт `at` (ревʼю с25 M1)", () => {
  /* ⚠️ Payload мусить бути КОРОТКИМ (≤40): інакше його відсіює обмеження
     довжини, і тест лишається зеленим навіть без перевірки алфавіту —
     спіймано навмисною поломкою (зняв regex → тест не впав). */
  it("лапки й коми в `at` відхиляються — у .or() вони переписали б фільтри", () => {
    const evil = '2026-01-01T00:00:00Z",id.is.null,or(a';
    expect(evil.length).toBeLessThanOrEqual(40); // інакше перевіряли б не те
    const raw = Buffer.from(
      JSON.stringify({ at: evil, id: "11111111-1111-4111-8111-111111111111" })
    ).toString("base64url");
    expect(decodeJournalCursor(raw)).toBeNull();
  });

  it("задовгий `at` відхиляється (межа довжини теж під сторожем)", () => {
    const long = "0".repeat(41);
    const raw = Buffer.from(JSON.stringify({ at: long, id: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
    expect(decodeJournalCursor(raw)).toBeNull();
  });

  it("нормальний ISO з таймзоною Postgres приймається", () => {
    const ok = { at: "2026-08-06 08:47:26.601543+00", id: "11111111-1111-4111-8111-111111111111" };
    expect(decodeJournalCursor(encodeJournalCursor(ok))).toEqual(ok);
  });
});
