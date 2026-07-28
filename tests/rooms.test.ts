import { describe, it, expect } from "vitest";
import {
  isRoomBookable, bookableRooms, ROOM_OFF_LABEL,
  isRoomVisible, visibleRooms, residualSet, pluralZapys, roomOffLabel,
} from "../lib/rooms";
import { offRoomIdsOf } from "../lib/roomsResidual";

/* 0123 «вимкнути кабінет». Головне, що тут захищено, — тристанність поля:
   true / false / undefined. undefined приходить зі СТАРИХ селектів, які не тягнуть
   колонку active; трактувати його як «вимкнено» означало б, що після викатки
   клієнта будь-який екран, де ще не додали `active` в select, показав би «кабінетів
   немає» і запис став би неможливим. Тому undefined = активний, а останній рубіж —
   тригер check_room_active у БД (та сама конвенція, що з services.room_id у 0121). */

const room = (id: string, active?: boolean | null) => ({ id, active });

describe("isRoomBookable", () => {
  it("active = true → можна записувати", () => {
    expect(isRoomBookable(room("a", true))).toBe(true);
  });

  it("active = false → не можна", () => {
    expect(isRoomBookable(room("a", false))).toBe(false);
  });

  it("active відсутній (старий селект) → вважаємо активним, а не вимкненим", () => {
    expect(isRoomBookable(room("a"))).toBe(true);
    expect(isRoomBookable({ id: "a" } as { id: string; active?: boolean | null })).toBe(true);
  });

  it("active = null (колонка є, значення немає) → активний", () => {
    expect(isRoomBookable(room("a", null))).toBe(true);
  });
});

describe("bookableRooms", () => {
  it("лишає лише ті, у які можна записати, і зберігає порядок", () => {
    const list = [room("a", true), room("b", false), room("c"), room("d", false), room("e", null)];
    expect(bookableRooms(list).map((r) => r.id)).toEqual(["a", "c", "e"]);
  });

  it("undefined / null на вході → порожній масив, а не виняток", () => {
    expect(bookableRooms(undefined)).toEqual([]);
    expect(bookableRooms(null)).toEqual([]);
  });

  it("усі вимкнені → порожньо (форма має показати «немає кабінетів», а не впасти)", () => {
    expect(bookableRooms([room("a", false), room("b", false)])).toEqual([]);
  });

  it("не мутує вхідний масив", () => {
    const list = [room("a", true), room("b", false)];
    bookableRooms(list);
    expect(list).toHaveLength(2);
  });
});

describe("ROOM_OFF_LABEL", () => {
  it("мітка українською — її бачать на дошці і в переносі", () => {
    expect(ROOM_OFF_LABEL).toBe("вимкнено");
  });
});

/* ===== Видимість (правило змінилось 2026-07-28) =====
   Раніше вимкнений кабінет показувався ЗАВЖДИ — саме тому, що в ньому могли
   лишитись пацієнти. Тепер він ховається, але «спливає» назад, поки живі рядки є.
   Це спливання й тримає інваріант «пацієнта не загубити», тож перевіряємо явно. */

describe("isRoomVisible", () => {
  const residual = residualSet(["offR"]);

  it("активний видно завжди — навіть коли про залишки нічого не відомо", () => {
    expect(isRoomVisible(room("a", true), residual)).toBe(true);
    expect(isRoomVisible(room("a", true))).toBe(true);
    expect(isRoomVisible(room("a"))).toBe(true);          // старий селект
    expect(isRoomVisible(room("a", null))).toBe(true);
  });

  it("вимкнений і порожній — сховано", () => {
    expect(isRoomVisible(room("offE", false), residual)).toBe(false);
  });

  it("вимкнений із залишком — СПЛИВАЄ назад у список", () => {
    expect(isRoomVisible(room("offR", false), residual)).toBe(true);
  });

  it("залишки не передали → вимкнені сховані (fail-closed саме для ВИДИМОСТІ)", () => {
    expect(isRoomVisible(room("offR", false))).toBe(false);
    expect(isRoomVisible(room("offR", false), null)).toBe(false);
  });

  it("щойно залишок спорожнів — кабінет зникає сам", () => {
    expect(isRoomVisible(room("offR", false), residualSet(["offR"]))).toBe(true);
    expect(isRoomVisible(room("offR", false), residualSet([]))).toBe(false);
  });
});

describe("visibleRooms", () => {
  it("активні + вимкнені із залишками, порядок збережено", () => {
    const list = [room("a", true), room("offE", false), room("offR", false), room("c")];
    expect(visibleRooms(list, residualSet(["offR"])).map((r) => r.id)).toEqual(["a", "offR", "c"]);
  });

  it("undefined / null на вході → порожній масив", () => {
    expect(visibleRooms(undefined, residualSet([]))).toEqual([]);
    expect(visibleRooms(null, residualSet([]))).toEqual([]);
  });

  it("не мутує вхідний масив", () => {
    const list = [room("a", true), room("b", false)];
    visibleRooms(list, residualSet([]));
    expect(list).toHaveLength(2);
  });
});

describe("offRoomIdsOf", () => {
  it("бере лише ЯВНО вимкнені: undefined і null — активні", () => {
    expect(offRoomIdsOf([room("a", true), room("b"), room("c", null), room("d", false)])).toEqual(["d"]);
  });

  it("undefined / null → порожній масив (жодного запиту за залишками)", () => {
    expect(offRoomIdsOf(undefined)).toEqual([]);
    expect(offRoomIdsOf(null)).toEqual([]);
  });
});

describe("підпис кабінету-залишку", () => {
  it("українська множина «запис» — 11–14 окремий виняток", () => {
    expect(pluralZapys(1)).toBe("запис");
    expect(pluralZapys(2)).toBe("записи");
    expect(pluralZapys(4)).toBe("записи");
    expect(pluralZapys(5)).toBe("записів");
    expect(pluralZapys(11)).toBe("записів");
    expect(pluralZapys(12)).toBe("записів");
    expect(pluralZapys(14)).toBe("записів");
    expect(pluralZapys(21)).toBe("запис");
    expect(pluralZapys(22)).toBe("записи");
    expect(pluralZapys(25)).toBe("записів");
    expect(pluralZapys(111)).toBe("записів");
    expect(pluralZapys(0)).toBe("записів");
  });

  it("без залишків — просто «вимкнено»", () => {
    expect(roomOffLabel()).toBe("вимкнено");
    expect(roomOffLabel(0)).toBe("вимкнено");
    expect(roomOffLabel(null)).toBe("вимкнено");
  });

  it("із залишками — пояснює, ЧОМУ кабінет ще у списку", () => {
    expect(roomOffLabel(1)).toBe("вимкнено · 1 запис");
    expect(roomOffLabel(3)).toBe("вимкнено · 3 записи");
    expect(roomOffLabel(7)).toBe("вимкнено · 7 записів");
  });
});
