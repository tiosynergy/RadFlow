import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SURFACE_KEYS, FIELD_SCOPES, MARKER_ENTITY_TYPES, MARKER_SEVERITIES,
  indexMarkers, entityKey, fieldKey,
  hasUnreadSurface, hasUnreadEntity, hasUnreadField,
  unreadForSurface, unreadForEntity, unreadForField,
  topSeverity, ackIdsForScope, snapshotIdsOf,
  unreadForDate, hasUnreadDate, calendarDayKey,
  markerLabel, unreadGroupLabel, hasUnreadNav, unreadForNav,
  type ChangeMarker,
} from "@/lib/unreadChanges";

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

  it("кожен field_scope має українську назву", () => {
    for (const scope of FIELD_SCOPES) {
      const label = markerLabel(marker({ field_scope: scope }));
      expect(label, `немає тексту для ${scope}`).not.toContain("інформація");
    }
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
