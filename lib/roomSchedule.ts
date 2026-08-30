/* ===== RadFlow — довіра до ЧИТАННЯ графіка кабінету (U-13) =====
   Одне правило для ВСІХ, хто бере `rooms.schedule`. Сім місць виклику, і
   перепис із них живе в `tests/roomScheduleRead.test.ts` (там же сканер, що
   валить тест на новому читачі — числа тут навмисно не дублюємо):
     • сітки слотів — BookingModal, RescheduleModal, StudyEditModal,
       ReferralPortal (у порталу ВЛАСНА сітка, не лише модалки);
     • поради — QuickRescheduleButton, CollisionPanel (спискова форма);
     • ⚠️ СЕРВЕРНИЙ гейт `app/queue/actions.ts` (scheduleGate + roomDayCtx) —
       найдорожче місце: за коментарем у ньому графік у БД не enforce'иться, і
       для «після кінця дня» цей гейт єдиний рубіж.

   Чому це окрема функція, а не `if` на місці. `maybeSingle()` має ТРИ різні
   відповіді, і дві з них екрани довго плутали:

     1. `error` — читання впало (мережа, токен). Це «не знаємо».
     2. `data === null` — рядка НЕМАЄ: кабінет невидимий за RLS 0139
        (`rooms_referrer_read` = грант направника ∧ `auth_referrer_visible_rooms`)
        або вже видалений. Помилки при цьому НЕМАЄ — і саме тому перевірки
        `if (res.error) throw` не досить. Це теж «не знаємо».
     3. рядок є — графік прочитано. `schedule` у ньому може бути `null`, і це
        ЛЕГІТИМНЕ «власного графіка немає, працює дефолт», а не невідомість.

   Ціна плутанини заміряна на проді (с49): при (2) `roomScheduleFor` тихо
   відкочується на хардкод «Пн–Сб 08:00–18:00». Для кабінету, що працює
   09:00–22:00 сім днів, сітка одночасно ВИГАДУВАЛА годину 08:00–09:00, якої
   немає, і ХОВАЛА чотири робочі години 18:00–22:00 — без жодного банера.

   Правило живе в lib/, бо компонентних тестів у проєкті немає
   (`vitest.config.ts` — environment: "node"): залишене в JSX, воно
   перевірялось би лише регуляркою. */

/** Рядок `rooms`, прочитаний як `select("schedule").maybeSingle()`. */
export type RoomScheduleRow = { schedule?: unknown } | null;

/** Результат читання: або графік відомий, або названа причина незнання. */
export type RoomScheduleRead =
  | { known: true; schedule: unknown }
  | { known: false; reason: "error" | "missing" };

/** Розбір відповіді `maybeSingle()` на читання графіка кабінету.
 *
 *  ⚠️ `known: true` із `schedule: null` — НЕ помилка: рядок прочитано, власного
 *  графіка в кабінету немає, далі працює дефолт `roomScheduleFor`. Саме тому
 *  функція повертає розрізнення, а не просто `unknown | null`: інакше виклик
 *  знову склеїв би «немає графіка» з «не змогли прочитати» — тобто рівно той
 *  дефект, який вона закриває. */
export function readRoomScheduleRow(
  res: { data: RoomScheduleRow; error: unknown } | null | undefined,
): RoomScheduleRead {
  if (!res) return { known: false, reason: "error" };
  if (res.error) return { known: false, reason: "error" };
  if (!res.data) return { known: false, reason: "missing" };
  return { known: true, schedule: res.data.schedule ?? null };
}

/** Текст для `throw` у лоадері: причина видима в логах, а не «щось впало».
 *  Окремо від `readRoomScheduleRow`, щоб та лишалась чистою і тестованою. */
export function roomScheduleReadError(reason: "error" | "missing"): Error {
  return new Error(
    reason === "missing"
      ? "room schedule row not readable (RLS or deleted)"
      : "room schedule read failed",
  );
}

/** Те саме правило для СПИСКОВОГО читання (`.in("id", ids)`), яким користується
 *  `CollisionPanel`: там кабінетів кілька, і `maybeSingle` не підходить.
 *
 *  ⚠️ Форма інша, дірка та сама, і вона тихіша. Відсутній у відповіді кабінет
 *  дає `byId[id] === undefined`, далі `roomScheduleFor(…, undefined)` — той самий
 *  хардкод 08:00–18:00, тільки помилки немає й рядка `?? null` теж немає, тож
 *  очима це не видно взагалі. Панель на цьому РАДИТЬ слот, тому «прочитали не
 *  всіх» мусить означати «не радимо», а не «у них звичайний день». */
export function roomSchedulesById(
  res: { data: Array<{ id: string; schedule?: unknown }> | null; error: unknown } | null | undefined,
  wanted: readonly string[],
): { known: true; byId: Record<string, unknown> } | { known: false; reason: "error" | "missing" } {
  if (!res || res.error) return { known: false, reason: "error" };
  const rows = res.data || [];
  const byId: Record<string, unknown> = {};
  for (const r of rows) byId[r.id] = r.schedule ?? null;
  /* Саме `in`, а не порівняння довжин. ⚠️ Формулювання виправлене ревʼю: довжини
     розходяться у ДВА боки, і обидва погані. Зайвий чи чужий рядок у відповіді
     робить перевірку довжиною ЗЕЛЕНОЮ на неповних даних (wanted = [a, c],
     відповідь [a, b]: 2 = 2, а `c` втрачено) — це дірка. Дублікат у `wanted`
     навпаки дає ХИБНУ тривогу на повних даних ([a, a] проти [a]: 1 ≠ 2).
     Перевірка по ключах не має ні того, ні іншого. */
  for (const id of wanted) if (!(id in byId)) return { known: false, reason: "missing" };
  return { known: true, byId };
}
