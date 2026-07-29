/* ===== RadFlow — «кабінети-залишки» (серверна частина) =====

   Вимкнений кабінет (`rooms.active = false`) ховаємо з робочих екранів — але лише
   поки він ПОРОЖНІЙ. Поки в ньому лишається хоч один живий рядок, кабінет
   повертається у списки з підписом «вимкнено · N записів» і зникає сам, коли
   останній рядок закрито або перенесено.

   Саме це «сплиття» дозволило скасувати старе правило «показуємо завжди» й при
   цьому НЕ ризикувати загубити пацієнта. Правила видимості та чисті хелпери —
   у `lib/rooms.ts`; дизайн — `claude/room-off-visibility-design.md` у проєкті.

   Що вважаємо ЖИВИМ рядком:
     queue_entries    — статус не термінальний І дата >= «сьогодні» В ЗОНІ ЦЕНТРУ.
                        Минуле не рахуємо: воно вже історія, її видно пошуком і
                        карткою запису, і тримати через неї кабінет у сайдбарі
                        вічно — це та сама проблема, яку ми й прибираємо.
     waitlist_entries — статус `waiting` або `scheduled` (жорстка прив'язка до
                        кабінету, яку ще треба кудись подіти). Дати тут немає —
                        бронь висить, доки її не знято.

   ⚠️ День беремо через `wallDayKey(tz)`, а не `new Date()`: у центрі з іншою зоною
   близько опівночі «сьогодні» сервера — це вже інший день, і кабінет із записом
   на сьогодні міг би зникнути зі списку прямо в робочу зміну. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { wallDayKey } from "@/lib/incidents";

/** Термінальні статуси черги — кабінет вони не займають (дзеркало check_room_active). */
const DEAD_QUEUE = ["cancelled", "no_show", "not_held", "done", "needs_reschedule"] as const;
/** Живі статуси вейтліста (решта — cancelled / expired). */
const LIVE_WAITLIST = ["waiting", "scheduled"] as const;

export interface ResidualRooms {
  /** id вимкнених кабінетів, у яких ще щось лишилось. */
  ids: string[];
  /** id → скільки живих рядків (для підпису «вимкнено · N записів»). */
  counts: Record<string, number>;
  /** Хоч один підрахунок не вдався → `ids` містить УСІ вимкнені кабінети (fail-open),
   *  а `counts` неповні. Див. коментар до residualOffRooms. */
  degraded?: boolean;
}

export const EMPTY_RESIDUAL: ResidualRooms = { ids: [], counts: {} };

/** По скільки кабінетів кладемо в один `.in(...)`. Розмір пачки, а НЕ стеля:
 *  кабінетів може бути скільки завгодно, просто питаємо їх партіями. Стеля тут
 *  була б міною сповільненої дії — 0126 забороняє видаляти кабінет із історією,
 *  тож виведені з експлуатації накопичуються назавжди. */
const CHUNK = 30;

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * Порахувати залишки у вимкнених кабінетах центру.
 *
 * `offRoomIds` — id вимкнених кабінетів (їх сторінка вже має зі свого селекту
 * `rooms`, тож зайвого запиту не робимо). Порожній масив → одразу порожній
 * результат без жодного запиту: у переважній більшості центрів вимкнених
 * кабінетів немає взагалі.
 *
 * ⚠️ ПОМИЛКА ЗАПИТУ → FAIL-OPEN: показуємо ВСІ вимкнені кабінети, просто без
 * числа в підписі (ревʼю с18b, High-1). Раніше збій був невідрізнимий від
 * справжньої порожнечі, і наслідок був не косметичний, як тут колись написали:
 * на /radiologist кабінети радіолога рахуються саме за видимими, тож єдиний
 * невдалий запит показував радіологу «усі ваші кабінети вимкнено» і відрізав
 * його від власної черги. Зайвий кабінет у сайдбарі — прийнятна ціна; зниклий
 * кабінет із живими записами — ні.
 *
 * ⚠️ Читаємо `select("room_id")` пачками по CHUNK, а не рядок за рядком і не
 * все одним запитом без ліміту (ревʼю с17, Low + с18b, Medium-2). `.limit()`
 * тут поставити не можна: зріз рядків мовчки занизив би лічильники, а це вже
 * брехня в підписі. Пачка обмежує РОЗМІР запиту, а не повноту відповіді.
 */
export async function residualOffRooms(
  supabase: SupabaseClient,
  clinicId: string,
  offRoomIds: string[],
  tz?: string | null,
): Promise<ResidualRooms> {
  if (!clinicId || offRoomIds.length === 0) return EMPTY_RESIDUAL;

  const today = wallDayKey(tz || undefined);
  const counts: Record<string, number> = {};
  let degraded = false;

  const bump = (roomId: unknown) => {
    if (typeof roomId !== "string" || !roomId) return;
    counts[roomId] = (counts[roomId] || 0) + 1;
  };

  await Promise.all(chunk(offRoomIds, CHUNK).map(async (ids) => {
    const [queueRes, waitRes] = await Promise.all([
      supabase
        .from("queue_entries")
        .select("room_id")
        .eq("clinic_id", clinicId)
        .in("room_id", ids)
        .gte("scheduled_date", today)
        .not("status", "in", `(${DEAD_QUEUE.join(",")})`),
      supabase
        .from("waitlist_entries")
        .select("room_id")
        .eq("clinic_id", clinicId)
        .in("room_id", ids)
        .in("status", LIVE_WAITLIST as unknown as string[]),
    ]);
    if (queueRes.error || waitRes.error) {
      degraded = true;
      console.warn(`[roomsResidual] ${clinicId}: ${(queueRes.error || waitRes.error)?.message ?? "невідома помилка"}`);
      return;
    }
    for (const row of queueRes.data || []) bump((row as { room_id?: unknown }).room_id);
    for (const row of waitRes.data || []) bump((row as { room_id?: unknown }).room_id);
  }));

  // Порядок як у вхідному списку — щоб сайдбар не «стрибав» між рендерами.
  if (degraded) return { ids: [...offRoomIds], counts, degraded: true };
  return { ids: offRoomIds.filter((id) => (counts[id] || 0) > 0), counts };
}

/** Дістати id вимкнених кабінетів зі списку, який сторінка вже завантажила. */
export function offRoomIdsOf(rooms: Array<{ id: string; active?: boolean | null }> | null | undefined): string[] {
  return (rooms || []).filter((r) => r.active === false).map((r) => r.id);
}
