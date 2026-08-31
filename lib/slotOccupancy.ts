/* ===== Чи займає запис слот кабінету =====

   Єдине місце, де живе відповідь на питання «цей рядок черги забирає час у
   кабінеті ЗА КРИТЕРІЄМ ПЕРЕКРИТТЯ СЛОТА» (`check_no_overlap` / `room_busy_slots`).
   ⚠️ Це НЕ універсальний «список термінальних статусів»: у проєкті співіснують
   чотири різні критерії під різні питання, і зводити їх в один — помилка.
     • `check_case_no_time_overlap` (0099) — «пацієнт у двох кабінетах одночасно»:
       allow-лист scheduled|waiting|in_progress|needs_reschedule і БЕЗ буфера;
     • `ACTUAL_OVERLAP` (0129) ↔ `lateCallClash` (lib/queueStatus.ts) — «виклик
       ЗАРАЗ наїде на наступного»: allow-лист scheduled|waiting, вікно =
       зараз + тривалість + буфер (ширина — єдина формула `callWindowMinutes`;
       порівняння зі слотами — у мілісекундах доби, бо гард порівнює
       timestamptz, а не хвилини, Ф4-2; `callCrossesMidnight` називає вихід за
       добу, якого клієнт не бачить);
     • `DEAD_QUEUE` (lib/roomsResidual.ts) — «чи лишилось щось у вимкненому
       кабінеті»: п'ять статусів, включно з `done`;
     • KPI (`ceo_kpi_*`, 0079) — свої списки під звітність.
   Сюди зводиться рівно перекриття слота і нічого більше. Раніше критерій був розсипаний: SQL-тригери (`check_no_overlap`,
   `room_busy_slots` — 0068/0079), серверний прикладний гейт (`hasSlotClash` в
   app/queue/actions.ts) і клієнтська сітка. Розсинхрон між ними дає найгіршу з
   можливих помилок продукту — «слот зелений, але незаписуваний»: сітка малює час
   вільним, оператор кладе туди пацієнта, а БД відмовляє.

   Саме так і сталось (зовнішній аудит 2026-08-07, H-2a): 0079 додала
   `needs_reschedule` у скіп-лист БД в ОБОХ авторитетних місцях, а прикладний гейт
   лишився зі старим списком із трьох статусів. План затримки переводив записи в
   `needs_reschedule`, `room_busy_slots` чесно звільняла слот — і бронювання в цей
   слот падало з «Слот зайнятий». Це головний сценарій каскаду, а не крайовий.

   ⚠️ `SLOT_FREE_STATUSES` ДЗЕРКАЛИТЬ БД. Міняєш тут — міняй `check_no_overlap`
   і `room_busy_slots` (і навпаки). Тест tests/slotOccupancy.test.ts звіряє цей
   список із текстом міграції 0079, щоб розсинхрон не пережив коміт.

   ⚠️ ЧОГО ТУТ НЕМАЄ: `done`. Завершене дослідження свій час УЖЕ витратило —
   у БД воно виключене лише в гейті «новий рядок» (`new.status in (...)`), але як
   СУСІД у вибірці лишається зайнятим, інакше поверх завершеного о 10:00 можна
   було б записати ще одного на 10:00 і задвоїти історію кабінету. */

import { wallInstant, wallInstantOf } from "@/lib/incidents";
import { BUFFER_DEFAULT, normBuffer } from "@/lib/studies";

/** Статуси, за яких запис слот НЕ займає (дзеркало скіп-листів 0079). */
export const SLOT_FREE_STATUSES = ["cancelled", "no_show", "not_held", "needs_reschedule"] as const;

export type SlotRow = {
  id: string;
  status: string;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  duration_min: number | null;
  buffer_time_min?: number | null;
  in_progress_at?: string | null;
};

/** Чи забирає цей статус час кабінету. */
export function occupiesSlot(status: string | null | undefined): boolean {
  return !SLOT_FREE_STATUSES.includes((status ?? "") as (typeof SLOT_FREE_STATUSES)[number]);
}

/**
 * Абсолютне настінне вікно рядка [start, end) у мс, або null — якщо порахувати
 * його не з чого (немає тривалості / часу).
 *
 * `in_progress` рахуємо від ФАКТИЧНОГО старту (`in_progress_at`), а не від
 * `scheduled_date/time`: прострочений запис можуть завести в кабінет через кілька
 * днів, і саме фактичний інтервал зайнятий. Той самий критерій у тригері 0068.
 */
export function slotWindowOf(q: SlotRow, tz?: string): { start: number; end: number } | null {
  if (q.duration_min == null) return null;
  const start =
    q.status === "in_progress" && q.in_progress_at
      ? wallInstantOf(q.in_progress_at, tz)
      : wallInstant(q.scheduled_date ?? "", q.scheduled_time ?? "");
  if (start == null || !isFinite(start)) return null;
  return { start, end: start + (q.duration_min + normBuffer(q.buffer_time_min ?? BUFFER_DEFAULT)) * 60000 };
}

/**
 * Чи перетинає вікно [startMs, endMs) хоч один із рядків.
 *
 * Статусний фільтр застосовуємо ТУТ, а не тільки в запиті: запит звужує вибірку
 * заради трафіку, а рішення «зайнято / вільно» мусить мати рівно один критерій —
 * інакше наступний викликач із власним SELECT відтворить H-2a заново.
 */
export function slotClashIn(
  rows: readonly SlotRow[],
  startMs: number,
  endMs: number,
  opts: { excludeId?: string; tz?: string } = {}
): boolean {
  return (rows ?? []).some((q) => {
    if (opts.excludeId && q.id === opts.excludeId) return false;
    if (!occupiesSlot(q.status)) return false;
    const w = slotWindowOf(q, opts.tz);
    if (!w) return false;
    return w.start < endMs && startMs < w.end;
  });
}
