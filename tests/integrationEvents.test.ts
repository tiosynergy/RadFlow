/* Контракт вхідних подій RIS (фаза 2). Головне тут — межа продукту: канал
   приймає ФАКТИ руху пацієнта і ВІДХИЛЯЄ клінічний/персональний вміст, а не
   мовчки його ковтає. Плюс мапінг результатів RPC 0146 у HTTP: повтор і
   застаріла подія — успіх, інакше RIS ретраїтиме вічно. */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_BODY_KEYS,
  EVENT_TARGET,
  INBOUND_EVENTS,
  RESULT_HTTP,
  mapDbError,
  overBodyLimit,
  parseInboundEvent,
  resultMessage,
} from "../lib/integrationEvents";

const ok = { event: "started", source_event_id: "RIS-1" };

describe("parseInboundEvent — контракт", () => {
  it("мінімальне валідне тіло", () => {
    const r = parseInboundEvent(ok);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        event: "started",
        sourceEventId: "RIS-1",
        at: null,
        accession: null,
      });
    }
  });

  it("at нормалізується в ISO, accession тримиться", () => {
    const r = parseInboundEvent({ ...ok, at: "2026-08-12T10:31:00+03:00", accession: "  ACC-7 " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.at).toBe("2026-08-12T07:31:00.000Z");
      expect(r.value.accession).toBe("ACC-7");
    }
  });

  it("невідома подія / порожній source_event_id / кривий at — 400 з текстом", () => {
    expect(parseInboundEvent({ ...ok, event: "exploded" })).toMatchObject({ ok: false });
    expect(parseInboundEvent({ ...ok, source_event_id: "   " })).toMatchObject({ ok: false });
    expect(parseInboundEvent({ ...ok, at: "вчора" })).toMatchObject({ ok: false });
    expect(parseInboundEvent(null)).toMatchObject({ ok: false });
    expect(parseInboundEvent([ok])).toMatchObject({ ok: false });
  });

  it("at СУВОРО ISO з зоною: без зони результат залежав би від TZ сервера", () => {
    // vitest TZ=Europe/Kyiv, Vercel — UTC: та сама подія лягала б у журнал
    // з різним часом (реальний дефект, спійманий ревʼю)
    expect(parseInboundEvent({ ...ok, at: "2026-08-12T10:31:00" })).toMatchObject({ ok: false });
    expect(parseInboundEvent({ ...ok, at: "Aug 12, 2026" })).toMatchObject({ ok: false });
    expect(parseInboundEvent({ ...ok, at: "2026" })).toMatchObject({ ok: false });
    expect(parseInboundEvent({ ...ok, at: "2026-08-12T10:31:00Z" })).toMatchObject({ ok: true });
    expect(parseInboundEvent({ ...ok, at: "2026-08-12T10:31:00.500+03:00" })).toMatchObject({ ok: true });
  });

  it("source_event_id без керуючих символів (інакше 22P05 з БД замість 400)", () => {
    expect(parseInboundEvent({ ...ok, source_event_id: "EV\u00001" })).toMatchObject({ ok: false });
    expect(parseInboundEvent({ ...ok, source_event_id: "EV-1\n" })).toMatchObject({ ok: false });
    // trim() перед перевіркою мовчки «лікував» би край — і ключ дедупу в БД
    // відрізнявся б від того, що надіслав RIS (реальний дефект, спійманий тут)
    expect(parseInboundEvent({ ...ok, source_event_id: "\tEV-1" })).toMatchObject({ ok: false });
    expect(parseInboundEvent({ ...ok, accession: "ACC\u00071" })).toMatchObject({ ok: false });
    // пробіли по краях — не керуючі символи: приймаємо й нормалізуємо
    expect(parseInboundEvent({ ...ok, source_event_id: " EV-1 " })).toMatchObject({ ok: true });
  });

  it("довгі ідентифікатори відсікаються (ключ дедупу — не смітник)", () => {
    expect(parseInboundEvent({ ...ok, source_event_id: "x".repeat(201) })).toMatchObject({ ok: false });
    expect(parseInboundEvent({ ...ok, accession: "y".repeat(201) })).toMatchObject({ ok: false });
  });

  it("КЛЮЧОВЕ: межа — ALLOWLIST, тож будь-який клінічний/персональний ключ відпадає", () => {
    // denylist обходився б mrn / birth_date / Patient_Name / вкладеністю —
    // саме тому контракт закритий переліком дозволених ключів
    for (const key of [
      "report", "findings", "conclusion", "impression", "diagnosis",
      "observation", "dose", "series", "images", "study_description",
      "patient_name", "Patient_Name", "patient_phone", "patient_dob",
      "mrn", "birth_date", "dob", "phone", "comment", "meta",
    ]) {
      const r = parseInboundEvent({ ...ok, [key]: "щось" });
      expect(r.ok, `поле ${key} прийнято`).toBe(false);
      if (!r.ok) expect(r.error).toContain(key);
    }
  });

  it("перелічує ВСІ невідомі поля запиту, а не перше-ліпше", () => {
    const r = parseInboundEvent({ ...ok, report: "a", diagnosis: "b" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("report");
      expect(r.error).toContain("diagnosis");
    }
  });

  it("дозволені ключі — рівно чотири (зміна = свідома правка контракту)", () => {
    expect([...ALLOWED_BODY_KEYS].sort()).toEqual(["accession", "at", "event", "source_event_id"]);
  });
});

describe("розмір тіла", () => {
  it("рахуємо БАЙТИ, не code units (кирилиця важить удвічі)", () => {
    expect(overBodyLimit("a".repeat(8 * 1024))).toBe(false);
    expect(overBodyLimit("a".repeat(8 * 1024 + 1))).toBe(true);
    expect(overBodyLimit("ї".repeat(4100))).toBe(true); // 8200 байт
  });
});

describe("мапінг помилок БД → HTTP (межа: сирий текст назовні не йде)", () => {
  it("зайнятий кабінет і перетин — 409 з ретраєм, а не 422", () => {
    // 0146 обіцяє «двоє в кабінеті ловить unique-індекс і дає 409»;
    // 422 змусив би RIS викинути подію назавжди
    expect(mapDbError("23505")).toEqual({ status: 409, reason: "room_busy", retryable: true });
    expect(mapDbError("23P01")).toEqual({ status: 409, reason: "room_busy", retryable: true });
  });

  it("CASE_STALE — транзієнт 409; контрактні помилки — 400; гарди — 422", () => {
    expect(mapDbError("55000").status).toBe(409);
    expect(mapDbError("22023").status).toBe(400);
    expect(mapDbError("23514")).toMatchObject({ status: 422, retryable: false });
    expect(mapDbError("P0001", "STATUS_TRANSITION: …")).toMatchObject({
      status: 422, reason: "illegal_transition",
    });
    expect(mapDbError("P0001", "INTEGRATION_EVENT: …").status).toBe(400);
    expect(mapDbError("P0001", "щось інше").status).toBe(422);
  });

  it("невідомий код — 500; reason завжди машинний, без тексту БД", () => {
    const r = mapDbError("42P01", 'relation "queue_entries" does not exist');
    expect(r.status).toBe(500);
    expect(r.reason).toBe("server_error");
    for (const code of ["23505", "23P01", "55000", "22023", "23514", "P0001", "42P01"]) {
      expect(mapDbError(code, "constraint queue_one_in_progress_per_room uuid 123").reason)
        .not.toContain("constraint");
    }
  });
});

describe("мапінг результатів RPC 0146 → HTTP", () => {
  it("повтор і застаріла подія — УСПІХ (інакше вічні ретраї RIS)", () => {
    expect(RESULT_HTTP.applied).toBe(200);
    expect(RESULT_HTTP.duplicate).toBe(200);
    expect(RESULT_HTTP.noop).toBe(200);
  });

  it("стан заважає ЗАРАЗ → 409; гард → 422; немає запису → 404", () => {
    expect(RESULT_HTTP.conflict).toBe(409);
    expect(RESULT_HTTP.busy).toBe(409);
    expect(RESULT_HTTP.reused).toBe(409);
    expect(RESULT_HTTP.rejected_busy).toBe(409);
    expect(RESULT_HTTP.rejected).toBe(422);
    expect(RESULT_HTTP.not_found).toBe(404);
  });

  it("таблиця результатів повна (пропажа ключа = мовчазний 500 на валідний результат)", () => {
    expect(Object.keys(RESULT_HTTP).sort()).toEqual([
      "applied", "busy", "conflict", "duplicate", "noop",
      "not_found", "rejected", "rejected_busy", "reused",
    ]);
  });

  it("кожен результат має людський текст", () => {
    for (const key of Object.keys(RESULT_HTTP)) {
      expect(resultMessage(key)).not.toBe("Невідомий результат");
    }
    expect(resultMessage("щось")).toBe("Невідомий результат");
  });
});

describe("ланцюжок подій", () => {
  it("три події ведуть у три статуси (дзеркало 0146)", () => {
    expect(INBOUND_EVENTS).toEqual(["arrived", "started", "finished"]);
    expect(EVENT_TARGET).toEqual({
      arrived: "waiting",
      started: "in_progress",
      finished: "done",
    });
  });
});
