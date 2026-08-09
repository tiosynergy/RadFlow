import { describe, it, expect } from "vitest";
import {
  isRoomBookable, bookableRooms, ROOM_OFF_LABEL,
  isRoomVisible, visibleRooms, residualSet, pluralZapys, roomOffLabel,
  roomDeleteBlockReason, grantRoomIds, grantAllowsRoom, roomsInGrant,
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

/* ===== Видалення кабінету (0126) =====
   Це найдрейфовіша частина правила: те саме мусить збігатись у трьох місцях —
   діалог майстра, преflight збереження і тригер guard_delete_room. Тримаємо
   рішення чистою функцією, щоб розходження ловилось тут, а не в проді. */

describe("roomDeleteBlockReason", () => {
  it("порожній вимкнений кабінет — видаляти можна (єдиний легітимний сценарій «✕»)", () => {
    expect(roomDeleteBlockReason({ queue: 0, waitlist: 0, active: false })).toBe(null);
  });

  it("порожній, але ще ввімкнений — спершу вимкнути (0123)", () => {
    expect(roomDeleteBlockReason({ queue: 0, waitlist: 0, active: true })).toBe("active");
  });

  it("active невідомий → вважаємо ввімкненим (fail-closed)", () => {
    expect(roomDeleteBlockReason({ queue: 0, waitlist: 0 })).toBe("active");
    expect(roomDeleteBlockReason({ queue: 0, waitlist: 0, active: null })).toBe("active");
  });

  it("ЗАКРИТА МИНУЛА історія теж блокує — саме її пропускало старе правило", () => {
    expect(roomDeleteBlockReason({ queue: 1, waitlist: 0, active: false })).toBe("history");
  });

  it("сама лише бронь вейтліста — теж історія (room_id → SET NULL і тут)", () => {
    expect(roomDeleteBlockReason({ queue: 0, waitlist: 1, active: false })).toBe("history");
  });

  it("історія важливіша за «ще ввімкнений»: порядок як у тригері", () => {
    // Інакше власник вимкнув би кабінет, зберіг і лише потім дізнався,
    // що видалити не можна взагалі.
    expect(roomDeleteBlockReason({ queue: 3, waitlist: 2, active: true })).toBe("history");
  });

  it("не порахували історію → блокуємо, а не «ризикнемо»", () => {
    expect(roomDeleteBlockReason({ queue: null, waitlist: 0, active: false })).toBe("unknown");
    expect(roomDeleteBlockReason({ queue: 0, waitlist: null, active: false })).toBe("unknown");
    expect(roomDeleteBlockReason({ active: false })).toBe("unknown");
    expect(roomDeleteBlockReason({})).toBe("unknown");
  });

  it("NaN — теж «не порахували», а не нуль", () => {
    expect(roomDeleteBlockReason({ queue: NaN, waitlist: 0, active: false })).toBe("unknown");
  });

  it("«не порахували» важливіше за все інше", () => {
    expect(roomDeleteBlockReason({ queue: null, waitlist: 5, active: true })).toBe("unknown");
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

/* 0137: семантика `referral_access.room_ids`. Головне, що тут захищено, — що
   ПОРОЖНІЙ масив означає «жодного кабінету», а не «усі». До 0137 БД і сім копій
   формули в коді читали `'{}'` як «усі», тобто спроба ЗАБРАТИ в направника всі
   кабінети відкривала центр повністю. Гілку прибрано в
   `auth_referrer_can_book_room` і `referral_center_card`; ці тести — гард від
   повернення старої семантики в код (M-7 уже одного разу відкочували). */
describe("кабінети гранта направника (0137)", () => {
  const rooms = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

  it("null = усі кабінети центру", () => {
    expect(grantRoomIds(null)).toBeNull();
    expect(grantRoomIds(undefined)).toBeNull();
    expect(grantAllowsRoom(null, "r1")).toBe(true);
    expect(grantAllowsRoom(undefined, "r9")).toBe(true);
    expect(roomsInGrant(rooms, null)).toHaveLength(3);
  });

  it("масив = рівно ці кабінети", () => {
    expect(grantRoomIds(["r1", "r2"])).toEqual(["r1", "r2"]);
    expect(grantAllowsRoom(["r1", "r2"], "r1")).toBe(true);
    expect(grantAllowsRoom(["r1", "r2"], "r3")).toBe(false);
    expect(roomsInGrant(rooms, ["r2"]).map((r) => r.id)).toEqual(["r2"]);
  });

  it("ПОРОЖНІЙ масив = жодного (fail-closed, а не «усі»)", () => {
    expect(grantRoomIds([])).toEqual([]);
    expect(grantAllowsRoom([], "r1")).toBe(false);
    expect(grantAllowsRoom([], "будь-що")).toBe(false);
    expect(roomsInGrant(rooms, [])).toEqual([]);
  });

  it("порожній список кабінетів центру не ламає жодну гілку", () => {
    expect(roomsInGrant([], null)).toEqual([]);
    expect(roomsInGrant(null, ["r1"])).toEqual([]);
    expect(roomsInGrant(undefined, [])).toEqual([]);
  });
});
