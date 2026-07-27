import { describe, it, expect } from "vitest";
import { isRoomBookable, bookableRooms, ROOM_OFF_LABEL } from "../lib/rooms";

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
