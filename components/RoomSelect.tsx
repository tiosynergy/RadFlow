"use client";

/* ===== RadFlow — компактний список кабінетів (вимога власника 2026-07-27) =====
   Чипи кабінетів (`.bk-room-chips` / `.bd-rooms`) читаються добре, поки кабінетів
   небагато: `.bk-room-chip` має `flex: 1`, тож усі влазять в один ряд. Коли
   кабінетів однієї модальності стає БІЛЬШЕ ТРЬОХ, назви стискаються до
   нечитабельного («DocLif…», накладання сусідніх підписів) — центр із кількома
   МРТ-апаратами саме в це і впирається.

   Тому понад `ROOM_LIST_MAX_CHIPS` кабінетів УСІ точки бронювання (персонал,
   направник, перенос) перемикаються на цей список. Поріг і компонент спільні —
   інакше ролі розʼїхалися б у поведінці.

   Нативний `<select className="inp">` — свідомий вибір, а не кастомний дропдаун:
   • той самий елемент уже вживає `WaitlistModal` («Кабінет (необовʼязково)») —
     паттерн у продукті єдиний;
   • доступний із клавіатури й скрінрідера без ARIA-костилів (правило проекту);
   • на мобільному дає нативний пікер, а не список, що не влазить у екран.
   Модальність у підписі не дублюємо: усі точки виклику вже фільтрують кабінети
   за однією модальністю (тип дослідження / kind переносу). */

export interface RoomSelectOption {
  id: string;
  name: string;
  apparatus_model?: string | null;
}

/** Понад стільки кабінетів чипи замінюються списком (див. коментар вище). */
export const ROOM_LIST_MAX_CHIPS = 3;

interface Props {
  rooms: readonly RoomSelectOption[];
  /** id обраного кабінету; "" = ще не обрано. */
  value: string;
  onChange: (roomId: string) => void;
  /** Підпис для скрінрідера — поле-лейбл поруч візуальний (`fld-lab`). */
  ariaLabel?: string;
  disabled?: boolean;
}

export default function RoomSelect({ rooms, value, onChange, ariaLabel = "Кабінет", disabled }: Props) {
  return (
    <select
      className="inp"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {/* Плейсхолдер лише поки кабінет НЕ обрано: інакше список дозволяв би
          «розобрати» вибір назад у порожнечу — а кабінет обовʼязковий. */}
      {!value && <option value="">— Оберіть кабінет —</option>}
      {rooms.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}{r.apparatus_model ? " · " + r.apparatus_model : ""}
        </option>
      ))}
    </select>
  );
}
