import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  SURFACE_KEYS, FIELD_SCOPES, MARKER_ENTITY_TYPES, MARKER_SEVERITIES,
  indexMarkers, entityKey, fieldKey,
  hasUnreadSurface, hasUnreadEntity, hasUnreadField,
  unreadForSurface, unreadForEntity, unreadForField,
  topSeverity, ackIdsForScope, snapshotIdsOf,
  unreadForDate, hasUnreadDate, calendarDayKey,
  markerLabel, unreadGroupLabel, unreadNavLabel, scheduleScopeText, hasUnreadNav, unreadForNav,
  type ChangeMarker,
} from "@/lib/unreadChanges";
/* Компонент — чиста функція без хуків, тож у node-середовищі його можна просто
   ВИКЛИКАТИ і перевірити повернуте дерево. Це не «компонентний тест» (DOM тут
   немає), а звичайна перевірка чистої функції — і саме вона рятує від сторожів,
   що пінять текст файла й обходяться раннім `return` (ревʼю U-30, с48). */
import UnreadDot from "@/components/UnreadDot";

/* ─────────────────────────── Фікстури ─────────────────────────────────── */

let seq = 0;
function marker(over: Partial<ChangeMarker> = {}): ChangeMarker {
  seq += 1;
  return {
    id: over.id ?? `m${seq}`,
    clinic_id: "c1",
    event_type: "queue.studies_changed",
    surface_key: "queue",
    entity_type: "queue_entry",
    entity_id: "e1",
    field_scope: "studies",
    actor_id: "a1",
    actor_role: "referrer",
    subject_referrer_id: null,
    room_id: null,
    severity: "important",
    changed_fields: null,
    details: null,
    created_at: "2026-08-06T10:00:00.000Z",
    seen_at: null,
    subject_date: null,
    ...over,
  };
}

/* ══════════════ 1. Таксономія = дзеркало CHECK-ів міграції 0131 ═════════
   Найдешевша перевірка з усіх і найдорожча пропущена помилка: розбіжність
   між TS-юніоном і CHECK-ом БД не ловиться ані tsc, ані lint — вона
   спливає рядком, який БД мовчки відхилила вже в проді.
   Той самий підхід, що tests/sqlComments.test.ts і DB_FORBIDDEN_TOP_KEYS
   у tests/importantEvents.test.ts. */

const MIGRATION = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0131_user_change_markers.sql"),
  "utf8"
);

/** Витягує список рядкових літералів із CHECK-обмеження за його імʼям. */
function dbListOf(constraint: string): string[] {
  const at = MIGRATION.indexOf("constraint " + constraint);
  expect(at, `у міграції немає обмеження ${constraint}`).toBeGreaterThan(-1);
  const chunk = MIGRATION.slice(at, at + 700);
  const inAt = chunk.indexOf(" in (");
  expect(inAt, `${constraint}: не знайдено списку IN (...)`).toBeGreaterThan(-1);
  const close = chunk.indexOf(")", inAt);
  return Array.from(chunk.slice(inAt, close).matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
}

describe("таксономія позначок синхронна з міграцією 0131", () => {
  it("surface_key", () => {
    expect(dbListOf("ucm_surface_key_chk").sort()).toEqual([...SURFACE_KEYS].sort());
  });
  it("field_scope", () => {
    expect(dbListOf("ucm_field_scope_chk").sort()).toEqual([...FIELD_SCOPES].sort());
  });
  it("entity_type", () => {
    expect(dbListOf("ucm_entity_type_chk").sort()).toEqual([...MARKER_ENTITY_TYPES].sort());
  });
  it("severity", () => {
    expect(dbListOf("ucm_severity_chk").sort()).toEqual([...MARKER_SEVERITIES].sort());
  });

  /* Сторож самого сторожа: перевіряємо, що dbListOf справді читає файл, а не
     повертає порожнечу, на якій будь-яке порівняння «зійшлося б» (урок с25 —
     три зелені сторожі на зламаній реалізації). */
  it("парсер CHECK-ів реально щось знаходить", () => {
    expect(dbListOf("ucm_surface_key_chk").length).toBeGreaterThan(5);
    expect(() => dbListOf("ucm_no_such_constraint_chk")).toThrow();
  });

  it("міграція не містить передчасного закриття блочного коментаря", () => {
    // Урок с25: '*/' у тексті шапки закрив коментар і зламав 0128 у власника.
    const header = MIGRATION.slice(0, MIGRATION.indexOf("begin;"));
    expect(header.split("*/").length - 1).toBe(1);
  });
});

/* ══════════════ 2. Індексація і селектори ═══════════════════════════════ */

describe("індексація", () => {
  it("прочитані позначки в індекс не потрапляють", () => {
    const ix = indexMarkers([
      marker({ id: "unread" }),
      marker({ id: "read", seen_at: "2026-08-06T11:00:00.000Z" }),
    ]);
    expect(ix.all.map((m) => m.id)).toEqual(["unread"]);
    expect(hasUnreadEntity(ix, "queue_entry", "e1")).toBe(true);
  });

  it("сортує від найсвіжішої", () => {
    const ix = indexMarkers([
      marker({ id: "old", created_at: "2026-08-01T00:00:00.000Z" }),
      marker({ id: "new", created_at: "2026-08-06T00:00:00.000Z" }),
    ]);
    expect(ix.all.map((m) => m.id)).toEqual(["new", "old"]);
  });

  it("один прохід наповнює три індекси", () => {
    const ix = indexMarkers([marker({ id: "x" })]);
    expect(ix.bySurface.get("queue")).toHaveLength(1);
    expect(ix.byEntity.get(entityKey("queue_entry", "e1"))).toHaveLength(1);
    expect(ix.byField.get(fieldKey("queue_entry", "e1", "studies"))).toHaveLength(1);
  });

  it("порожній вхід не дає жодної крапки", () => {
    const ix = indexMarkers([]);
    expect(hasUnreadSurface(ix, "queue")).toBe(false);
    expect(hasUnreadField(ix, "queue_entry", "e1", "studies")).toBe(false);
    expect(unreadForSurface(ix, "queue")).toEqual([]);
  });
});

/* ══════════════ 3. Батьківські індикатори виводяться з дітей ═══════════ */

describe("агрегація батьківських індикаторів", () => {
  const ix = indexMarkers([
    marker({ id: "a", field_scope: "studies" }),
    marker({ id: "b", field_scope: "schedule" }),
    marker({ id: "c", entity_id: "e2", field_scope: "status" }),
  ]);

  it("секція світиться, поки є хоч одна непрочитана дитина", () => {
    expect(hasUnreadSurface(ix, "queue")).toBe(true);
    expect(unreadForSurface(ix, "queue")).toHaveLength(3);
  });

  it("картка збирає свої поля", () => {
    expect(unreadForEntity(ix, "queue_entry", "e1").map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("поле бачить лише себе", () => {
    expect(unreadForField(ix, "queue_entry", "e1", "studies").map((m) => m.id)).toEqual(["a"]);
    expect(unreadForField(ix, "queue_entry", "e1", "patient_data")).toEqual([]);
  });

  it("гасне лише коли не лишилось жодної дитини", () => {
    const after = indexMarkers([
      marker({ id: "a", seen_at: "2026-08-06T12:00:00.000Z", field_scope: "studies" }),
      marker({ id: "b", field_scope: "schedule" }),
    ]);
    expect(hasUnreadEntity(after, "queue_entry", "e1")).toBe(true);

    const all = indexMarkers([
      marker({ id: "a", seen_at: "2026-08-06T12:00:00.000Z", field_scope: "studies" }),
      marker({ id: "b", seen_at: "2026-08-06T12:00:00.000Z", field_scope: "schedule" }),
    ]);
    expect(hasUnreadEntity(all, "queue_entry", "e1")).toBe(false);
    expect(hasUnreadSurface(all, "queue")).toBe(false);
  });

  it("навігація агрегує кілька поверхонь", () => {
    const withIncident = indexMarkers([
      marker({ id: "i", surface_key: "incidents", entity_type: "incident",
               entity_id: "i1", field_scope: "incident" }),
    ]);
    expect(hasUnreadNav(withIncident, "queue")).toBe(true);   // queue + incidents
    expect(hasUnreadNav(withIncident, "waitlist")).toBe(false);
    expect(unreadForNav(withIncident, "queue")).toHaveLength(1);
    expect(hasUnreadNav(withIncident, "невідомий-пункт")).toBe(false);
  });
});

/* ══════════════ 4. Важливість ══════════════════════════════════════════ */

describe("важливість", () => {
  it("бере максимум, а не алфавіт", () => {
    // Текстовий max() дав би 'info' — саме тому в БД є greatest_severity().
    expect(topSeverity([marker({ severity: "info" }), marker({ severity: "critical" })])).toBe("critical");
    expect(topSeverity([marker({ severity: "info" }), marker({ severity: "important" })])).toBe("important");
    expect(topSeverity([])).toBeNull();
  });
});

/* ══════════════ 5. Підтвердження прочитання ════════════════════════════
   Головні сценарії гонок із ТЗ (розділ «Race conditions to handle»). */

describe("ack підтверджує ЛИШЕ відрендерений знімок", () => {
  it("подія, що прийшла ПІСЛЯ знімка, лишається непрочитаною (сценарій 1)", () => {
    const rendered = [marker({ id: "was-rendered" })];
    const snapshot = snapshotIdsOf(rendered);

    // Поки картка була відкрита, realtime приніс ще одну зміну того ж блоку.
    const ix = indexMarkers([...rendered, marker({ id: "arrived-later" })]);

    const ids = ackIdsForScope(ix, { kind: "field", entityType: "queue_entry", entityId: "e1", scope: "studies" }, snapshot);
    expect(ids).toEqual(["was-rendered"]);
    expect(ids).not.toContain("arrived-later");
  });

  it("невдале завантаження знімок не оновлює → підтверджувати нічого", () => {
    const ix = indexMarkers([marker({ id: "x" })]);
    expect(ackIdsForScope(ix, { kind: "surface", surface: "queue" }, new Set())).toEqual([]);
  });

  it("відкриття секції не підтверджує НЕзавантажені рядки (сценарій 7)", () => {
    const loadedRow = marker({ id: "row-1", entity_id: "e1" });
    const offscreenRow = marker({ id: "row-2", entity_id: "e2" });
    const ix = indexMarkers([loadedRow, offscreenRow]);
    // У знімку — лише те, що клієнт реально показав.
    const ids = ackIdsForScope(ix, { kind: "surface", surface: "queue" }, new Set(["row-1"]));
    expect(ids).toEqual(["row-1"]);
  });

  it("підтвердження поля не чіпає інші поля тієї ж картки", () => {
    const a = marker({ id: "studies", field_scope: "studies" });
    const b = marker({ id: "schedule", field_scope: "schedule" });
    const ix = indexMarkers([a, b]);
    const ids = ackIdsForScope(
      ix, { kind: "field", entityType: "queue_entry", entityId: "e1", scope: "studies" },
      snapshotIdsOf([a, b])
    );
    expect(ids).toEqual(["studies"]);
  });

  it("підтвердження картки бере всі її поля", () => {
    const a = marker({ id: "studies", field_scope: "studies" });
    const b = marker({ id: "schedule", field_scope: "schedule" });
    const c = marker({ id: "other-card", entity_id: "e9", field_scope: "studies" });
    const ix = indexMarkers([a, b, c]);
    const ids = ackIdsForScope(
      ix, { kind: "entity", entityType: "queue_entry", entityId: "e1" },
      snapshotIdsOf([a, b, c])
    ).sort();
    expect(ids).toEqual(["schedule", "studies"]);
  });
});

/* ══════════════ 5b. Календар: дата живе в самій позначці ════════════════
   Урок с24 у мініатюрі: календар показує МІСЯЦЬ, дошка вантажить ОДИН день,
   тож дату не можна виводити із завантажених записів. */

describe("календар", () => {
  it("групує позначки черги за subject_date", () => {
    const ix = indexMarkers([
      marker({ id: "a", subject_date: "2026-08-10" }),
      marker({ id: "b", subject_date: "2026-08-10", entity_id: "e2" }),
      marker({ id: "c", subject_date: "2026-08-12", entity_id: "e3" }),
    ]);
    expect(unreadForDate(ix, "2026-08-10").map((m) => m.id).sort()).toEqual(["a", "b"]);
    expect(hasUnreadDate(ix, "2026-08-12")).toBe(true);
    expect(hasUnreadDate(ix, "2026-08-11")).toBe(false);
  });

  it("позначки без дати на календар не сідають", () => {
    const ix = indexMarkers([marker({ id: "x", subject_date: null })]);
    expect(ix.byDate.size).toBe(0);
  });

  it("не-черга на календар не сідає, навіть якщо дата зʼявиться", () => {
    // Каталог/лист очікування можуть колись отримати дату — календар усе одно
    // показує лише чергу, і це має бути явним, а не випадковим.
    const ix = indexMarkers([
      marker({ id: "svc", surface_key: "services", entity_type: "room",
               field_scope: "catalog", subject_date: "2026-08-10" }),
    ]);
    expect(hasUnreadDate(ix, "2026-08-10")).toBe(false);
  });

  it("прочитана позначка гасить день", () => {
    const ix = indexMarkers([
      marker({ id: "a", subject_date: "2026-08-10", seen_at: "2026-08-06T12:00:00.000Z" }),
    ]);
    expect(hasUnreadDate(ix, "2026-08-10")).toBe(false);
  });

  it("calendarDayKey бере ЛОКАЛЬНІ поля дати, а не UTC-зріз", () => {
    // toISOString() для 00:00 у зоні на схід від UTC дав би попередню добу —
    // саме та помилка, від якої застерігає правило «час через wallNow».
    const d = new Date(2026, 7, 10, 0, 0, 0);
    expect(calendarDayKey(d)).toBe("2026-08-10");
    expect(calendarDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

/* ══════════════ 6. Доступні формулювання (українські) ══════════════════ */

describe("формулювання", () => {
  it("крапка несе текст, а не лише колір", () => {
    const label = markerLabel(marker({ actor_role: "referrer", field_scope: "studies" }));
    expect(label).toContain("Змінено іншим користувачем");
    expect(label).toContain("перелік послуг");
    expect(label).toContain("лікар-направник");
  });

  it("невідома роль не ламає текст", () => {
    expect(markerLabel(marker({ actor_role: "щось-нове" }))).toContain("інший користувач");
  });

  it("група показує кількість", () => {
    expect(unreadGroupLabel([marker(), marker(), marker()])).toBe("Є непрочитані зміни: 3");
    expect(unreadGroupLabel([])).toBe("");
    expect(unreadGroupLabel([marker({ field_scope: "schedule" })])).toContain("дата, час або кабінет");
  });

  /* ── U-30 (с48): підпис для крапки, що показує ЧИСЛО ──────────────────
     Власник не розпізнав червону крапку в сайдбарі. Причин було дві, і обидві
     тут: (1) число зʼявлялось лише від ДВОХ позначок, тож найчастіший стан —
     одна зміна — давав німу крапку 8×8; (2) розшифровка існувала тільки для
     скрінрідера. Коли цифра видна, підпис МУСИТЬ починатися з неї, інакше
     бейдж «1» читається як лічильник сутностей (поруч у тому ж сайдбарі —
     «Лист очікування 1», і саме так його й прочитали). */
  describe("U-30: підпис навігаційної крапки з числом", () => {
    it("починається з кількості — навіть коли позначка одна", () => {
      expect(unreadNavLabel([marker()])).toMatch(/^Є непрочитані зміни: 1\b/);
      expect(unreadNavLabel([marker(), marker()])).toMatch(/^Є непрочитані зміни: 2\b/);
    });

    /* Ревʼю U-30: для КІЛЬКОХ позначок сам лише лічильник не додавав нічого до
       видимої цифри — людина дізнавалась, що число значить, але не ЩО саме
       змінилось. Перелічуємо напрями без повторів, не більше трьох. */
    it("для кількох позначок перелічує напрями змін без повторів", () => {
      const label = unreadNavLabel([
        marker({ field_scope: "studies" }),
        marker({ field_scope: "studies" }),
        marker({ field_scope: "patient_data" }),
      ]);
      expect(label).toMatch(/^Є непрочитані зміни: 3 —/);
      expect(label).toContain("перелік послуг");
      expect(label).toContain("дані пацієнта");
      // Без повторів: «перелік послуг» рівно один раз, хоч позначок дві.
      expect(label.match(/перелік послуг/g)).toHaveLength(1);
    });

    /* ⚠️ Беремо scope'и, чиї тексти КОМИ не містять: «дата, час або кабінет»
       (scope `schedule`) сам по собі з комами, і наївний split по ", " рахував
       би його за три напрями. Перша версія тесту саме на цьому й упала —
       корисне нагадування, що розбирати готовий підпис рядковими операціями
       ненадійно (для коду ця пастка закрита виносом `markerWhat`). */
    it("довгий перелік обрізається трьома напрямами", () => {
      const label = unreadNavLabel(
        (["record", "studies", "patient_data", "status"] as const).map((s) => marker({ field_scope: s })),
      );
      expect(label).toBe("Є непрочитані зміни: 4 — запис · перелік послуг · дані пацієнта …");
    });

    /* ⚠️ Роздільник напрямів мусить відрізнятись від ком ВСЕРЕДИНІ напряму:
       `markerWhat` для scope `schedule` повертає «дата, час або кабінет».
       З комою між напрямами два різні стани давали ОДИН підпис (ревʼю р2). */
    it("напрями розділені « · », а не комою — інакше зливаються з комами всередині", () => {
      const label = unreadNavLabel([
        marker({ field_scope: "schedule", changed_fields: ["scheduled_date", "scheduled_time"] }),
        marker({ field_scope: "studies" }),
      ]);
      expect(label).toBe("Є непрочитані зміни: 2 — дата, час · перелік послуг");
    });

    /* Обрізаємо по три, тож важливо, ЩО саме лишиться: критичне попереду. */
    it("напрями впорядковані за важливістю — критичне не випадає з трійки", () => {
      const label = unreadNavLabel([
        marker({ field_scope: "studies", severity: "info" }),
        marker({ field_scope: "patient_data", severity: "info" }),
        marker({ field_scope: "status", severity: "info" }),
        marker({ field_scope: "incident", severity: "critical" }),
      ]);
      expect(label, "критичний напрям вилетів під обрізання").toContain("простій кабінету");
      expect(label.indexOf("простій кабінету"), "критичний напрям не перший")
        .toBeLessThan(label.indexOf("перелік послуг"));
    });

    it("для однієї позначки додає ЩО саме змінилось", () => {
      const label = unreadNavLabel([marker({ field_scope: "studies", actor_role: "referrer" })]);
      expect(label).toContain("перелік послуг");
      expect(label).toContain("лікар-направник");
    });

    /* Порожньо → порожньо: крапки в цьому стані немає взагалі, і підпис
       «Є непрочитані зміни: 0» був би твердженням про неіснуючий стан. */
    it("порожній список дає порожній рядок", () => {
      expect(unreadNavLabel([])).toBe("");
    });

    /* ⚠️ Саме те, чим цей підпис відрізняється від групового: груповий для
       ОДНІЄЇ позначки числа не називає взагалі, тож поруч із видимою цифрою
       був би розсинхрон «бачу 1 — читаю про запис». */
    it("відрізняється від групового підпису саме на одній позначці", () => {
      const m = [marker()];
      expect(unreadGroupLabel(m)).not.toMatch(/^Є непрочитані зміни/);
      expect(unreadNavLabel(m)).toMatch(/^Є непрочитані зміни/);
      /* На кількох груповий підпис — це РІВНО лічильник, і саме тому він не
         годиться поруч із видимою цифрою: він не додає до неї нічого. */
      const many = [marker(), marker(), marker()];
      expect(unreadGroupLabel(many)).toBe("Є непрочитані зміни: 3");
      expect(unreadNavLabel(many)).toMatch(/^Є непрочитані зміни: 3 — /);
    });
  });

  it("кожен field_scope має українську назву", () => {
    for (const scope of FIELD_SCOPES) {
      const label = markerLabel(marker({ field_scope: scope }));
      expect(label, `немає тексту для ${scope}`).not.toContain("інформація");
    }
  });

  /* с28: scope `schedule` покриває пʼять колонок, і жива перевірка показала,
     що зміна САМОЇ тривалості підписувалась як «дата, час або кабінет» —
     жодне з трьох не мінялось. Текст тепер виводиться з changed_fields. */
  describe("текст scope schedule — із changed_fields", () => {
    it("сама тривалість → «тривалість», без «дата, час або кабінет»", () => {
      const label = markerLabel(marker({ field_scope: "schedule", changed_fields: ["duration_min"] }));
      expect(label).toContain("тривалість");
      expect(label).not.toContain("дата, час або кабінет");
    });

    it("комбінація полів — перелік у порядку тригера 0132", () => {
      expect(scheduleScopeText(["duration_min", "scheduled_date"])).toBe("дата, тривалість");
      expect(scheduleScopeText(["room_id", "scheduled_time", "scheduled_date"])).toBe("дата, час, кабінет");
      expect(scheduleScopeText(["buffer_time_min"])).toBe("буфер");
    });

    it("порожній / null / невідомі поля → загальний фолбек (старі позначки)", () => {
      expect(scheduleScopeText(null)).toBe("дата, час або кабінет");
      expect(scheduleScopeText([])).toBe("дата, час або кабінет");
      expect(scheduleScopeText(["поле-з-майбутнього"])).toBe("дата, час або кабінет");
      const label = markerLabel(marker({ field_scope: "schedule", changed_fields: null }));
      expect(label).toContain("дата, час або кабінет");
    });

    it("список полів — дзеркало гілки schedule тригера 0132", () => {
      const trig = readFileSync(resolve(process.cwd(), "supabase/migrations/0132_change_marker_triggers.sql"), "utf8");
      for (const f of ["scheduled_date", "scheduled_time", "room_id", "duration_min", "buffer_time_min"]) {
        expect(trig, `тригер 0132 не знає поля ${f}`).toContain(`'${f}'`);
        expect(scheduleScopeText([f]), `немає тексту для ${f}`).not.toBe("дата, час або кабінет");
      }
    });

    it("інші scope changed_fields не читають", () => {
      const label = markerLabel(marker({ field_scope: "studies", changed_fields: ["duration_min"] }));
      expect(label).toContain("перелік послуг");
    });
  });
});

/* ══════════════ 7. PII: позначка не несе даних пацієнта ════════════════ */

describe("PII", () => {
  it("changed_fields несе ІМЕНА полів, а details даних пацієнта не має", () => {
    const m = marker({
      field_scope: "patient_data",
      changed_fields: ["patient_name", "patient_phone"],
      details: null,
    });
    // Імена колонок — не значення: саме так робить і журнал 0128.
    expect(m.changed_fields).toContain("patient_name");
    expect(m.details).toBeNull();
    // Текст крапки говорить ЩО змінилось, але не ЧИМ воно стало.
    const label = markerLabel(m);
    expect(label).toContain("дані пацієнта");
    expect(label).not.toMatch(/\+?\d{5,}/);
  });
});

/* ═══════════ 8. Аудиторія: крапка без поверхні для ack — дефект ═══════════

   Правило проєкту: позначка, яку отримувач не може погасити НІЧИМ, вічна —
   ретенція чистить лише прочитані. Через це 0134 прибрала з матриці CEO, а 0138
   звузила `catalog` до адміна і забрала радіолога з каталогу й вейтліста
   (`p_room_relevant => false` у трьох тригерах).

   ⚠️ Тіла цих тригерів тепер живуть у ДВОХ файлах (0132 — вихідні, 0138 —
   звужені), а зеркало вище читає 0132. Без цього пину сужение могло б молча
   регресувати: хтось перевипустить тригер із 0132 і аудиторія повернеться. */

describe("аудиторія позначок (0138)", () => {
  const mig0138 = readFileSync(
    resolve(process.cwd(), "supabase/migrations/0138_schedule_override_lockdown_and_marker_audience.sql"),
    "utf8",
  );

  it("catalog і waitlist не роблять радіолога отримувачем — у КОЖНОМУ виклику", () => {
    for (const fn of ["tg_change_markers_services", "tg_change_markers_sro", "tg_change_markers_waitlist"]) {
      const at = mig0138.indexOf("function public." + fn);
      expect(at, `у 0138 немає ${fn}`).toBeGreaterThan(-1);
      const end = mig0138.indexOf("$function$;", at);
      expect(end, `${fn}: не знайшли кінець тіла`).toBeGreaterThan(at);
      const body = mig0138.slice(at, end);
      /* Рахуємо, а не `toContain`: у цих тригерах по 2–3 виклики
         `emit_change_markers`, і знятий флаг в ОДНІЙ гілці (напр. у DELETE
         послуги або в UPDATE вейтліста) `toContain` не помітив би. */
      const emits = (body.match(/emit_change_markers\(/g) || []).length;
      const flags = (body.match(/p_room_relevant => false/g) || []).length;
      expect(emits, `${fn}: жодного emit_change_markers`).toBeGreaterThan(0);
      expect(flags, `${fn}: флагів ${flags} на ${emits} викликів`).toBe(emits);
    }
  });

  it("catalog — лише адмінам (реєстратор без екрана /services)", () => {
    expect(mig0138).toContain("p_scope_kind not in ('access', 'catalog')");
  });

  it("черга радіолога не зачеплена: у ЖИВОМУ тригері queue room_relevant не false", () => {
    /* Дзеркало зонда (e3) смоука: 0138 звузила саме каталог і вейтліст, а
       позначки ЧЕРГИ по призначеному кабінету радіолог отримувати мусить —
       їх він гасить розгорнутим рядком своєї дошки.

       ⚠️ Читаємо ОСТАННЄ визначення функції по всіх міграціях, а не конкретний
       файл (ревʼю р.3): `tg_change_markers_queue` створює 0132, але 0133
       перевипускає її (додає `p_subject_date`) — тобто 0132 більше ніколи не
       накатується, і пін по ньому захищав би мертвий текст. Заодно межу тіла
       шукаємо і по `$$;`, і по `$function$;`: у 0132/0133 тіла закриті
       по-різному, а наївний пошук одного варіанта дає -1 → зріз «до кінця
       файла», де флаг є в СУСІДНІХ тригерах (cases, access). */
    const dir = resolve(process.cwd(), "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let live: string | null = null;
    let liveFile = "";
    for (const f of files) {
      const txt = readFileSync(resolve(dir, f), "utf8");
      const at = txt.indexOf("function public.tg_change_markers_queue");
      if (at < 0) continue;
      const ends = ["\n$$;", "\n$function$;"].map((e) => txt.indexOf(e, at)).filter((i) => i > at);
      expect(ends.length, `${f}: не знайшли кінець тіла тригера queue`).toBeGreaterThan(0);
      live = txt.slice(at, Math.min(...ends));
      liveFile = f;
    }
    expect(live, "жодна міграція не визначає tg_change_markers_queue").not.toBeNull();
    expect(live as string).toContain("emit_change_markers");
    expect(live as string, `останнє визначення (${liveFile}) звузило чергу радіолога`)
      .not.toContain("p_room_relevant => false");
  });
});

/* ═══════ 9. U-30 (с48): крапку мусить розуміти ЗРЯЧА людина теж ═══════════

   Скарга власника: «подія, позначена червоною крапкою, не розпізнана
   користувачем». Розбір показав ДВА окремі провали, і обидва — про те, що
   пояснення існувало, але не для тих очей:

   1. Розшифровка жила ТІЛЬКИ в `.rf-vh` — прихованому тексті для скрінрідера.
      Формально WCAG 1.4.1 виконано («стан не лише кольором»), а зряча людина
      з мишею отримувала голу кольорову крапку 8×8 і жодного способу дізнатись,
      що це. Дзеркальна позначка того ж механізму на MiniCalendar `title` мала
      з самого початку — дві крапки однієї родини поводились по-різному.
   2. Число показувалось лише ВІД ДВОХ позначок. Тобто найчастіший стан —
      рівно одна зміна — був найменш зрозумілим: замість бейджа німа крапка.

   DOM-середовища в проєкті немає (vitest.config.ts — environment: "node"), але
   `UnreadDot` — чиста функція без хуків, тож перевіряємо її ПОВЕРНУТЕ ДЕРЕВО,
   а не текст файла. Статичними лишились тільки два пункти, які у дерево не
   потрапляють у принципі: порядок CSS-правил (від нього залежить, чи видно
   число) і симетрія з MiniCalendar. */

describe("U-30: крапка пояснює себе зрячому користувачеві", () => {
  const CAL = "components/MiniCalendar.tsx";
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  /* ⚠️ Тести ПОВЕДІНКОВІ, а не по тексту файла. Перша версія пінила підрядки
     (`/<span aria-hidden="true">\{withCount \? markers\.length/` тощо), і ревʼю
     показало, як їх обійти, НЕ прибравши жодного символа: досить вставити
     ранній `return` вище — регулярки й далі знаходять свої рядки в мертвому
     коді, а дефект повністю відновлений. Компонент — чиста функція без хуків,
     тож у node-середовищі його можна просто ВИКЛИКАТИ і подивитись, що він
     повернув. Це той самий урок, що з мутацією `{inSchedCap > 0` → `{true`:
     сторож мусить дивитись на результат, а не на присутність тексту. */
  type El = { props: { className?: string; title?: string; children?: unknown } };
  const flat = (n: unknown): El[] =>
    Array.isArray(n) ? n.flatMap(flat) : (n && typeof n === "object" ? [n as El] : []);
  const render = (markers: ChangeMarker[], withCount?: boolean) =>
    UnreadDot({ markers, withCount }) as unknown as El | null;
  const kids = (el: El) => flat(el.props.children);
  const visible = (el: El) => {
    const k = kids(el).find((c) => !String(c.props.className || "").includes("rf-vh"));
    return k ? String((k.props as { children?: unknown }).children ?? "") : "";
  };
  const hidden = (el: El) => {
    const k = kids(el).find((c) => String(c.props.className || "").includes("rf-vh"));
    return k ? String((k.props as { children?: unknown }).children ?? "") : "";
  };

  it("одна позначка з числом дає бейдж «1», а не німу крапку", () => {
    const el = render([marker()], true)!;
    expect(el, "крапка взагалі не відрендерилась").not.toBeNull();
    expect(visible(el), "видиме число зникло — німа крапка повернулась").toBe("1");
    expect(el.props.className, "клас бейджа не навішений — число буде display:none")
      .toContain("rf-dot-num");
  });

  it("без withCount лишається крапка, а не число", () => {
    const el = render([marker(), marker()])!;
    expect(visible(el)).toBe("●");
    expect(el.props.className).not.toContain("rf-dot-num");
  });

  it("у крапки є title — пояснення для миші", () => {
    const withNum = render([marker()], true)!;
    const plain = render([marker()])!;
    expect(withNum.props.title, "title зник — розшифровка знову лише для скрінрідера")
      .toMatch(/^Є непрочитані зміни: 1\b/);
    expect(plain.props.title, "у крапки без числа теж має бути пояснення").toBeTruthy();
  });

  /* Коли цифра видна, підпис мусить починатися з неї — інакше «1» читається як
     лічильник сутностей (у тому ж сайдбарі поруч «Лист очікування 1»). */
  it("видиме число і текст підпису кажуть одне й те саме", () => {
    for (const n of [1, 2, 5]) {
      const el = render(Array.from({ length: n }, () => marker()), true)!;
      expect(visible(el)).toBe(String(n));
      expect(el.props.title, `підпис не починається з ${n}`).toMatch(new RegExp(`^Є непрочитані зміни: ${n}\\b`));
      expect(hidden(el), "прихований текст розійшовся з видимим").toBe(el.props.title);
    }
  });

  /* title НЕ замінює прихований текст: він не є надійним доступним іменем
     (не читається частиною скрінрідерів, недоступний з клавіатури). */
  it("прихований текст для скрінрідера лишився на місці", () => {
    expect(hidden(render([marker()], true)!), "`.rf-vh` прибрали, вирішивши що title його замінює")
      .toBeTruthy();
  });

  it("порожній список не малює нічого", () => {
    expect(render([], true)).toBeNull();
  });

  /* ⚠️ `aria-hidden` на видимому вузлі — НЕ косметика: на нього зав'язані ОБИДВА
     CSS-правила видимості (`.rf-dot > span[aria-hidden="true"]` ховає глиф,
     `.rf-dot-num > …` вмикає число). Ревʼю р2: перша версія поведінкових тестів
     шукала дитину «за відсутністю класу rf-vh», тож зняття `aria-hidden`
     лишало всі тести зеленими — а число ставало невидимим, і скрінрідер читав
     його ДРУГИМ голосом поверх прихованого підпису. Пінимо обидві дитини. */
  it("видимий вузол прихований від скрінрідера, а текстовий — навпаки", () => {
    const el = render([marker()], true)!;
    const num = kids(el).find((c) => !String(c.props.className || "").includes("rf-vh"))!;
    const vh = kids(el).find((c) => String(c.props.className || "").includes("rf-vh"))!;
    expect((num.props as { ["aria-hidden"]?: string })["aria-hidden"],
      "з видимого числа зняли aria-hidden — CSS перестане його показувати, а скрінрідер прочитає двічі")
      .toBe("true");
    expect((vh.props as { ["aria-hidden"]?: string })["aria-hidden"],
      "текст підпису сховали від скрінрідера — доступного імені більше немає")
      .toBeUndefined();
  });

  /* ── Місця виклику: без цього всю правку можна відкотити «зовні» ──────────
     Ревʼю р2 знайшло найдорожчу дірку покриття: усі тести вище перевіряють
     КОМПОНЕНТ, а прибрати `withCount` у `Sidebar.tsx` — і власник знову бачить
     німу крапку, при цьому все зелене. Той самий прийом, що MODAL_SITES в
     offScheduleConsent: список місць + сканер, який вимагає дописати сюди
     кожен новий екран. */
  const COUNT_SITES = [
    "components/Sidebar.tsx",
    "components/ReferrerSidebar.tsx",
    "components/SetupWizard.tsx",
    "components/QueueBoard.tsx",
    "components/RadiologistBoard.tsx",
  ];

  it.each(COUNT_SITES)("%s: навігація/секції показують ЧИСЛО, а не німу крапку", (file) => {
    const code = src(file);
    const navDots = code.match(/<UnreadDot[^>]*\/>/g) ?? [];
    const withNum = navDots.filter((t) => /\bwithCount\b/.test(t));
    expect(withNum.length, `${file}: жоден <UnreadDot> більше не просить число`).toBeGreaterThan(0);
  });

  it("Sidebar: число просять УСІ пункти навігації з крапкою", () => {
    const code = src("components/Sidebar.tsx");
    const dots = code.match(/<UnreadDot[^>]*\/>/g) ?? [];
    expect(dots.length, "у сайдбарі зникли крапки").toBeGreaterThanOrEqual(4);
    const mute = dots.filter((t) => !/\bwithCount\b/.test(t));
    expect(mute, "у пункті навігації зʼявилась крапка без числа — рівно те, чого не розпізнав власник")
      .toEqual([]);
  });

  /* Симетрія списку: новий екран, що ставить крапку в навігацію або в шапку
     секції, зобовʼязаний зʼявитись у COUNT_SITES — інакше сторож перевіряє
     лише те, що вже знає. */
  it("усі файли з withCount перелічені в COUNT_SITES", () => {
    const dir = resolve(process.cwd(), "components");
    const found = readdirSync(dir).filter((f) => f.endsWith(".tsx"))
      .map((f) => "components/" + f)
      .filter((p) => /<UnreadDot[^>]*\bwithCount\b/.test(src(p)));
    expect(found.filter((p) => !COUNT_SITES.includes(p)),
      "новий екран просить число — допишіть його в COUNT_SITES").toEqual([]);
    expect(COUNT_SITES.filter((p) => !found.includes(p)),
      "у COUNT_SITES лишився файл, який більше не просить числа").toEqual([]);
  });

  /* ── CSS: видимість числа тримається НЕ на JSX ────────────────────────────
     `.rf-dot > span[aria-hidden]` — display:none, і бейдж вмикає число окремим
     правилом. Специфічність в обох (0,2,1), тож усе вирішує ПОРЯДОК у файлі:
     переставити — і число зникне, а всі тести вище лишаться зеленими, бо
     компонент повертає те саме (ревʼю U-30). */
  it("правило, що вмикає число, стоїть ПІСЛЯ правила, що його ховає", () => {
    const css = readFileSync(resolve(process.cwd(), "styles/prototype/radflow.css"), "utf8");
    const hide = css.indexOf('.rf-dot > span[aria-hidden="true"] { display: none; }');
    const show = css.indexOf('.rf-dot-num > span[aria-hidden="true"] { display: inline; }');
    expect(hide, "зникло правило, що ховає глиф у крапці без числа").toBeGreaterThan(-1);
    expect(show, "зникло правило, що показує число в бейджі").toBeGreaterThan(-1);
    expect(show, "правила помінялись місцями — при рівній специфічності число знову сховане")
      .toBeGreaterThan(hide);
  });

  /* Форма бейджа — те, що відрізняє його від сусіднього `.sb-badge`
     (лічильника СУТНОСТЕЙ) у тому самому пункті навігації. Обидва червоні;
     якщо обидва стануть пігулками, повернеться рівно та плутанина, заради
     якої правка й робилась. */
  /* ⚠️ Читаємо ТІЛО правила регуляркою, а не `slice` між двома `indexOf`.
     Ревʼю р2 показало, що зрізом можна отримати порожній рядок або чужий блок,
     якщо якорі поміняються місцями чи зникнуть, — і тест падав з причин, що не
     мають стосунку до форми (це реально сталось на мутації N07). */
  const ruleBody = (css: string, selector: string) => {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
    const m = css.match(re);
    return m ? m[1] : null;
  };

  it("бейдж непрочитаного відрізняється формою від лічильника пункту", () => {
    const css = readFileSync(resolve(process.cwd(), "styles/prototype/radflow.css"), "utf8");
    const numRule = ruleBody(css, ".rf-dot-num");
    const sbRule = ruleBody(css, ".sb-badge");
    expect(numRule, "правило .rf-dot-num зникло").not.toBeNull();
    expect(sbRule, "правило .sb-badge зникло").not.toBeNull();
    const radius = (r: string) => (r.match(/border-radius:\s*([^;]+);/) || [])[1]?.trim();
    expect(radius(numRule!), "бейдж непрочитаного втратив власну форму").toBe("5px");
    expect(radius(sbRule!), "лічильник пункту більше не пігулка — форми зрівнялись").toBe("10px");
    expect(radius(numRule!)).not.toBe(radius(sbRule!));
    /* Форму не можна повернути й «зверху»: правило нижче по файлу перебило б
       обидва. Пінимо, що іншого border-radius для бейджа в темі немає. */
    const all = [...css.matchAll(/\.rf-dot-num[^{]*\{([^}]*)\}/g)]
      .map((m) => m[1]).filter((b) => /border-radius/.test(b));
    expect(all, "зʼявилось друге правило border-radius для бейджа — форма знову може зрівнятись")
      .toHaveLength(1);
  });

  /* Симетрія родини: календарна позначка того ж механізму мусить і далі
     пояснювати себе тим самим способом. Саме її наявність довела, що
     сайдбарна крапка — виняток, а не задум. */
  it("календарна позначка того ж механізму теж має title і рахує з ОДНІЄЇ", () => {
    const code = src(CAL);
    expect(code, "у дня календаря зник title — знову дві крапки з різною поведінкою")
      .toMatch(/title=\{\[st\?\.label \|\| null, unreadLabel\]\.filter\(Boolean\)\.join\(" · "\) \|\| undefined\}/);
    /* ⚠️ Пінимо саме ПОРІГ. Ревʼю показало, що попередня версія пінила лише
       рядок «Є непрочитані зміни: ${dayUnread.length}» — і мутація
       `dayUnread.length ? … : null` → `dayUnread.length > 1 ? … : null`
       (тобто рівно дефект U-30, внесений у календар) лишала тест зеленим. */
    expect(code, "календар почав мовчати про ОДНУ зміну — той самий дефект, що чинили")
      .toMatch(/const unreadLabel = dayUnread\.length \? `Є непрочитані зміни: \$\{dayUnread\.length\}` : null;/);
    expect(code, "поріг крапки на дні знову більший за одну позначку")
      .toMatch(/\{dayUnread\.length > 0 && <span className="cal-change"/);
  });
});
