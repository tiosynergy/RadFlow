/* ===== RadFlow — производный статус «требует уточнения» =====
   Если время начала записи уже прошло, а статус всё ещё «В черзі» (scheduled)
   или «Очікує» (waiting, пациент пришёл, но его не вызвали) — запись не
   проведена вовремя и требует действия администратора/радиолога (провести,
   отметить неявку или перенести).
   Это ВИЗУАЛЬНЫЙ производный статус — в БД статус не меняется.

   ВРЕМЯ: сравнение «сейчас vs слот» идёт в «настінному» пространстве (wall-as-UTC)
   по ТАЙМЗОНЕ КЛИНИКИ. now по умолчанию = wallNow() (клиника из setClinicTz);
   мультиклиничные экраны передают nowMs = wallNow(entryClinicTz) явно. */
import { wallNow, wallMinOfDay, wallMinOfInstant } from "./incidents";
import { BUFFER_DEFAULT, normBuffer } from "./studies";
import { slotFmt } from "./slots";

export interface ClarifyMeta {
  label: string;
  cls: string;
  title: string;
}

export const CLARIFY_META: ClarifyMeta = {
  label: "⚠ Уточнити",
  cls: "orange",
  title: "Потребує уточнення: час запису минув, а пацієнта ще не проведено",
};

/* ===== Производный статус «Запізнення» =====
   Пацієнт НЕ прийшов (статус усе ще scheduled), а від початку слота минуло
   БІЛЬШЕ буферного часу запису. Прямий виклик у кабінет блокується — потрібне
   явне рішення: повернути в чергу («все ж прийшов»), перенести, до листа
   очікування або «не відбулося». Видно всім ролям (derived, БД не змінюється);
   та сама формула піде в n8n/AI-автоматизацію (Stage 2). */

export const LATE_META = {
  label: "⏰ Запізнення",
  cls: "red",
  title:
    "Пацієнт не прийшов — запізнення понад буферний час. Прямий виклик заблоковано: зателефонуйте і перенесіть, поверніть у чергу або зніміть запис.",
} as const;

// dayDate — Date дня записи (00:00); scheduledTime — "HH:MM"; bufferMin — буфер записи.
// nowMs — настінний момент (wall-as-UTC мс); по умолчанию wallNow() по TZ клиники.
export function isLate(
  status: string | null | undefined,
  dayDate: Date | null | undefined,
  scheduledTime: string | null | undefined,
  bufferMin: number | null | undefined,
  nowMs: number = wallNow()
): boolean {
  if (status !== "scheduled") return false; // waiting = пацієнт уже прийшов
  if (!dayDate || !scheduledTime) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  const startMs = Date.UTC(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0);
  return nowMs > startMs + Math.max(0, bufferMin ?? 5) * 60000;
}

/* ===== Пізній виклик: перевірка фактичного вікна =====
   Виклик у кабінет ЗАРАЗ займає кабінет на (тривалість + буфер) від поточного
   часу, а не від слота. Якщо це вікно налазить на наступний активний запис
   кабінету (scheduled/waiting) — виклик блокується: спершу перенесіть один із
   записів. Захищає сценарії «пацієнт запізнився → все ж прийшов → виклик»
   та будь-який виклик із затримкою. */
/* Кінець вікна виклику в ХВИЛИНАХ ДОБИ від 00:00 ПОТОЧНОЇ доби — значення
   МОЖЕ перевищувати 1440, і це не помилка, а факт: виклик о 23:40 на 30 хв
   з буфером 5 займає кабінет до 00:15 наступної доби. Одна формула на два
   місця (lateCallClash і перевірка `next_day` нижче), щоб вони не розійшлись
   при першій же правці буфера. */
// Свідомо БЕЗ normBuffer: це вікно — дзеркало серверного
// `coalesce(q.buffer_time_min, 5)` з гарда 0129. normBuffer (collisionFor,
// delayPlan) живе в план-просторі; тут розбіжність із БД дорожча за акуратність.
export function callWindowEndMin(
  p: { duration_min: number | null; buffer_time_min: number | null },
  nowMs: number = wallNow()
): number {
  return wallMinOfDay(nowMs) + (p.duration_min || 30) + Math.max(0, p.buffer_time_min ?? BUFFER_DEFAULT);
}

export function lateCallClash(
  p: { id: string; room_id: string | null; duration_min: number | null; buffer_time_min: number | null },
  entries: Array<{ id: string; room_id: string | null; status: string; scheduled_time: string | null; patient_name?: string | null }>,
  nowMs: number = wallNow()
): { time: string; name?: string | null } | null {
  if (!p.room_id) return null;
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const nowMin = wallMinOfDay(nowMs);
  const endMin = callWindowEndMin(p, nowMs);
  const next = entries
    .filter((e) => e.room_id === p.room_id && e.id !== p.id && (e.status === "scheduled" || e.status === "waiting") && e.scheduled_time)
    .map((e) => ({ s: toMin(String(e.scheduled_time)), time: String(e.scheduled_time), name: e.patient_name }))
    .filter((x) => x.s >= nowMin && x.s < endMin)
    .sort((a, b) => a.s - b.s)[0];
  return next || null;
}

/* ===== Вікно виклику виходить за добу (M-2 аудиту 2026-08-23) =====
   `entries` — записи РІВНО однієї доби (дошка вантажить `.eq(scheduled_date,
   dayKey)`), а вікно виклику рахується від «зараз». О 23:40 дослідження на
   30 хв з буфером закінчиться о 00:15 — і запис наступної доби о 00:10
   lateCallClash не побачить НІКОЛИ: його немає в масиві. БД (0129, гілка «б»
   → `ACTUAL_OVERLAP`) відхилить — але ЛИШЕ якщо такий запис справді є, а ми
   про це не знаємо. Даних це не псує, проте оператор бачив дозволену дію,
   яка падає помилкою сервера.
   ⚠️ `ACTUAL_OVERLAP_BUSY` — ІНША гілка того ж гарда (сидить in_progress),
   її клієнт уже ловить кодом `room_busy`. Не сплутати: за цією константою
   легко вирішити, що перевірка дублює room_busy, і зняти її.
   Ціна рішення: попереджаємо і тоді, коли завтра вранці нікого немає —
   зайвий діалог дешевший за тиху дію, яку відхилить сервер.

   Сусідню добу свідомо НЕ вантажимо: чужі записи в `entries` зламали б
   лічильники дня, звук перевищення й таймери кабінетів (та сама причина, що
   в lib/stuckStudy.ts — хвости живуть окремим станом). Натомість чесно
   кажемо, ЧОГО не знаємо: вікно за північчю → підтвердження замість тихого
   «можна». Дірка з невидимої стає названою. */
export function callCrossesMidnight(
  p: { room_id: string | null; duration_min: number | null; buffer_time_min: number | null },
  nowMs: number = wallNow()
): boolean {
  if (!p.room_id) return false;         // без кабінету займати нічого
  return callWindowEndMin(p, nowMs) > 24 * 60;
}

/* ===== Причина, чому «Викликати в кабінет» ЗАРАЗ неможливо =====
   Централізована логіка (порядок перевірок + арифметика вікна виклику), спільна
   для адмінської дошки (QueueBoard) та дошки радіолога (RadiologistBoard). Щоб
   не тримати два екземпляри, які розповзаються, тут — лише машинний КОД причини
   + потрібні дані; рольові формулювання повідомлень лишаються в компонентах.

   opts обчислюються в компоненті з наявних хелперів:
     roomBlocked — кабінет заблоковано (поломка/ТО), напр. blockingByRoom[room_id];
     schedClosed — кабінет зачинено за графіком на цей день (roomSchedClosed);
     schedEnd    — "HH:MM" кінець графіка кабінету (null якщо зачинено/невідомо). */
export type CallBlockInfo = {
  id: string;
  room_id: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
};
export type CallBlockOpts = {
  roomBlocked?: boolean;
  schedClosed?: boolean;
  schedEnd?: string | null;
  // Дошка відкрита НЕ на сьогодні (обрана дата ≠ сьогодні). Виклик у кабінет
  // можливий лише для записів сьогоднішнього дня — не можна «завести» пацієнта
  // з майбутнього/минулого слота у кабінет зараз.
  notToday?: boolean;
  /* с24: незавершене дослідження в ЦЬОМУ ж кабінеті, але з ІНШОЇ дати.
     Індекс `queue_one_in_progress_per_room` (0018) не має дати, тож такий запис
     блокує кабінет назавжди — але в `entries` дошки його немає (вони за один
     день), і перевірка room_busy нижче його не бачить. Без цього поля кнопка
     виглядала активною, а сервер відповідав 23505 «у кабінеті вже є пацієнт»
     про пацієнта, якого на дошці нема. */
  roomStuck?: { id?: string; scheduled_date: string; patient_name?: string | null } | null;
  /* с24, ревʼю H1: дані про «хвости» ще не завантажились або запит упав.
     Стартове `[]` не відрізнити від «хвостів немає», тож без цього прапорця
     будь-який збій тихо повертав вихідний дефект: картка писала «вільний»,
     кнопка була активна, а сервер відповідав 23505. Інваріант проєкту
     «помилка завантаження ≠ пусто» — і саме там, де від цього залежить
     заведення пацієнта в апарат. Тому fail-CLOSED: не знаємо — не пускаємо. */
  stuckUnknown?: boolean;
  nowMs?: number;
};
/* 0077: sched_overrun — це вже НЕ блок, а ПОПЕРЕДЖЕННЯ (confirmable: true).
   Рішення власника: центр має добити день — усіх, кого записано на сьогодні,
   можна викликати в кабінет і після закриття, але через явне підтвердження.
   Стелі (+2 год) тут НЕМАЄ свідомо: вона обмежує НОВИЙ запис у сітці, а цей
   пацієнт уже записаний — відмовити йому о 20:30 «бо пізно» безглуздо.
   Решта кодів лишаються жорсткими блоками: чужий день, простій, зайнятий
   кабінет і накладення на наступний запис підтвердженням не лікуються. */
export type CallBlock =
  | { code: "wrong_day"; confirmable?: false }
  | { code: "room_blocked"; confirmable?: false }
  | { code: "room_closed"; confirmable?: false }
  | { code: "room_busy"; confirmable?: false }
  | { code: "room_stuck"; date: string; name?: string | null; confirmable?: false }
  | { code: "stuck_unknown"; confirmable?: false }
  | { code: "sched_overrun"; durationMin: number; end: string; confirmable: true }
  /* M-2: вікно виклику перетинає північ, а записів наступної доби дошка не
     бачить. Теж підтвердження, а не блок: заборонити виклик через те, що ми
     чогось не завантажили, — гірше за чесне попередження (БД лишається
     остаточним гардом). `end` — кінець вікна вже НАСТУПНОЇ доби, "HH:MM". */
  | { code: "next_day"; durationMin: number; end: string; confirmable: true }
  | { code: "clash"; durationMin: number; time: string; name?: string | null; confirmable?: false };

export function computeCallBlock(
  p: CallBlockInfo,
  entries: Array<{ id: string; room_id: string | null; status: string; scheduled_time: string | null; patient_name?: string | null }>,
  opts: CallBlockOpts = {}
): CallBlock | null {
  const nowMs = opts.nowMs ?? wallNow();
  // Найперше: запис не на сьогодні — виклик неможливий незалежно від стану кабінету.
  if (opts.notToday) return { code: "wrong_day" };
  if (opts.roomBlocked) return { code: "room_blocked" };
  if (opts.schedClosed) return { code: "room_closed" };
  if (entries.some((e) => e.room_id === p.room_id && e.status === "in_progress" && e.id !== p.id)) return { code: "room_busy" };
  /* Після room_busy: якщо пацієнт у кабінеті Є сьогодні, оператору важливіша
     саме ця причина. room_stuck — про «хвіст» з іншого дня, і він теж жорсткий:
     унікальний індекс 0018 однаково не дасть другий in_progress. */
  if (opts.roomStuck && opts.roomStuck.id !== p.id) {
    return { code: "room_stuck", date: opts.roomStuck.scheduled_date, name: opts.roomStuck.patient_name ?? null };
  }
  /* Тільки для записів З кабінетом: без room_id хвіст блокувати нічого не може,
     а показувати «дані не оновились» на такому записі — брехня (ревʼю с24, L3). */
  if (opts.stuckUnknown && p.room_id) return { code: "stuck_unknown" };
  const durationMin = p.duration_min || 30;
  /* Накладення на НАСТУПНИЙ запис перевіряємо ДО виходу за графік (0077).
     Порядок важливий: обидва можуть спрацювати одночасно (кінець дня + хтось
     записаний слідом). clash — жорсткий блок, sched_overrun — підтвердження;
     якби першим повертався sched_overrun, оператор підтвердив би «так, поза
     графіком» і завів пацієнта поверх наступного. Спершу — те, що не лікується
     підтвердженням. */
  const clash = lateCallClash(p, entries, nowMs);
  if (clash) return { code: "clash", durationMin, time: clash.time, name: clash.name };

  /* Північ — ПЕРЕД sched_overrun, хоча обидва лише підтверджуються. Те, що
     робочий день скінчився, оператор о 23:40 і так знає з годинника; а от що
     дошка НЕ бачить записів наступної доби — ні звідки більше не видно.
     Показуємо рідше зустрічне й важливіше.
     Ціна: попередження «поза графіком» при цьому НЕ показується — повертати
     два коди ми не вміємо, а один момент рішення важливіший за повноту. */
  if (callCrossesMidnight(p, nowMs)) {
    return { code: "next_day", durationMin, end: slotFmt(callWindowEndMin(p, nowMs) - 24 * 60), confirmable: true };
  }

  // Виклик ЗАРАЗ має вміститись до кінця робочого графіка кабінету (саме
  // дослідження; буфер прибирання може вийти за межі — як у редакторі слотів).
  // 0077: не блок, а підтвердження — «робочий день скінчився, все одно викликати?».
  if (p.room_id && opts.schedEnd) {
    const [eh, em] = String(opts.schedEnd).split(":").map(Number);
    const endMin = (eh || 0) * 60 + (em || 0);
    const nowMin = wallMinOfDay(nowMs);
    if (nowMin + durationMin > endMin) {
      return { code: "sched_overrun", durationMin, end: opts.schedEnd, confirmable: true };
    }
  }
  return null;
}

/* ===== Колізія черги: дослідження затягнулося і наїжджає на наступний запис =====
   Пацієнт А в кабінеті з 10:20 (слот був 10:00, 60 хв + 5 буфер) → кабінет
   звільниться о 11:25. Пацієнт Б записаний на 11:00 і вже під дверима.

   Джерело правди — ФАКТИЧНИЙ старт (`in_progress_at`, міграція 0060), а не слот.
   Рахуємо лише для НАЙБЛИЖЧОГО активного запису кабінету: панель рішення має
   бути одна, а не на кожному записі до кінця дня.

   Дві зони (рішення Ігоря 2026-07-11):
     drift — кабінет відстає від плану, але до слота Б ще встигає → тихий
             індикатор «+N хв», панелі немає (буфер для цього й існує);
     clash — кабінет НЕ встигає до слота Б → панель рішення.
   Сама панель пропонує лише перенос Б (не зсув усього хвоста) і не виштовхує
   нікого за межі графіка — хто не влазить, іде в обзвон. */

export type CollisionEntry = {
  id: string;
  room_id: string | null;
  status: string;
  scheduled_time: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
  in_progress_at?: string | null;
  patient_name?: string | null;
};

export type CollisionInfo = {
  zone: "drift" | "clash";
  freeAtMin: number;   // коли кабінет звільниться (хв доби, настінний час)
  freeAt: string;      // те саме як "HH:MM"
  overlapMin: number;  // наїзд на слот Б (>0 лише для clash)
  driftMin: number;    // наскільки кабінет відстає від плану (0, якщо йде за планом)
  running: { id: string; name: string | null; remainMin: number }; // хто в кабінеті; скільки лишилось самого дослідження
};

const bufOf = (e: { buffer_time_min: number | null }) => normBuffer(e.buffer_time_min ?? BUFFER_DEFAULT);
const durOf = (e: { duration_min: number | null }) => e.duration_min || 30;

export function collisionFor(
  next: CollisionEntry,
  entries: CollisionEntry[],
  nowMs: number = wallNow()
): CollisionInfo | null {
  if (!next.room_id || !next.scheduled_time) return null;
  if (next.status !== "scheduled" && next.status !== "waiting") return null;

  // Хто зараз у кабінеті (фактичний старт обовʼязковий — без нього окупація невідома).
  const run = entries.find((e) => e.room_id === next.room_id && e.status === "in_progress" && e.in_progress_at);
  if (!run) return null;
  const runStart = wallMinOfInstant(run.in_progress_at);
  if (runStart == null) return null;

  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const nowMin = wallMinOfDay(nowMs);

  /* Панель — лише в найближчого активного запису кабінету, і лише в того, ким
     ще реально займатимуться. Записи в «Запізненні» (не прийшов, минуло понад
     буфер) ПРОПУСКАЄМО: у них своя панель рішення (LATE_META), і саме вони
     інакше «залипали» б першими в списку з абсурдним наїздом на пів дня
     (протухла ранкова 09:00 при дослідженні, що йде о 14:40). */
  const stale = (e: CollisionEntry) =>
    e.status === "scheduled" && toMin(String(e.scheduled_time)) + bufOf(e) < nowMin;
  const upcoming = entries
    .filter((e) => e.room_id === next.room_id && e.id !== run.id
      && (e.status === "scheduled" || e.status === "waiting") && e.scheduled_time && !stale(e))
    .sort((a, b) => toMin(String(a.scheduled_time)) - toMin(String(b.scheduled_time)))[0];
  if (!upcoming || upcoming.id !== next.id) return null;

  /* Кабінет не може «звільнитися в минулому»: якщо планова тривалість уже
     вичерпана, а «Завершити» ніхто не натиснув — пацієнт усе ще в кабінеті.
     Без цього затримка, БІЛЬША за тривалість, схлопувала overlapMin у ≤ 0
     і панель зникала саме тоді, коли вона найпотрібніша. */
  const runEnd = Math.max(runStart + durOf(run), nowMin); // кінець самого дослідження (не раніше «зараз»)
  const freeAtMin = runEnd + bufOf(run);                  // кабінет вільний (з буфером прибирання)
  const plannedFree = run.scheduled_time ? toMin(String(run.scheduled_time)) + durOf(run) + bufOf(run) : freeAtMin;
  const driftMin = Math.max(0, freeAtMin - plannedFree);
  const overlapMin = freeAtMin - toMin(String(next.scheduled_time));
  if (overlapMin <= 0 && driftMin <= 0) return null; // усе за планом

  const running = { id: run.id, name: run.patient_name ?? null, remainMin: Math.max(0, runEnd - nowMin) };
  return {
    zone: overlapMin > 0 ? "clash" : "drift",
    freeAtMin, freeAt: slotFmt(freeAtMin),
    overlapMin: Math.max(0, overlapMin),
    driftMin, running,
  };
}

// dayDate — Date дня записи (00:00); scheduledTime — "HH:MM".
// nowMs — настінний момент (wall-as-UTC мс); по умолчанию wallNow() по TZ клиники.
export function needsClarification(
  status: string | null | undefined,
  dayDate: Date | null | undefined,
  scheduledTime: string | null | undefined,
  nowMs: number = wallNow()
): boolean {
  if (status && status !== "scheduled" && status !== "waiting") return false; // лише «В черзі»/«Очікує»/невизначений
  if (!dayDate || !scheduledTime) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  const startMs = Date.UTC(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0);
  return startMs < nowMs;
}
