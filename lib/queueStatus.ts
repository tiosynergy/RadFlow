/* ===== RadFlow — производный статус «требует уточнения» =====
   Если время начала записи уже прошло, а статус всё ещё «В черзі» (scheduled)
   или «Очікує» (waiting, пациент пришёл, но его не вызвали) — запись не
   проведена вовремя и требует действия администратора/радиолога (провести,
   отметить неявку или перенести).
   Это ВИЗУАЛЬНЫЙ производный статус — в БД статус не меняется.

   ВРЕМЯ: сравнение «сейчас vs слот» идёт в «настінному» пространстве (wall-as-UTC)
   по ТАЙМЗОНЕ КЛИНИКИ. now по умолчанию = wallNow() (клиника из setClinicTz);
   мультиклиничные экраны передают nowMs = wallNow(entryClinicTz) явно. */
import { wallNow, wallMinOfDay, wallMsOfDay, wallMinOfInstant } from "./incidents";
import { CLOCK_WORST_ERROR_MS } from "./serverClock";
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
/* Ширина вікна виклику у ХВИЛИНАХ: тривалість + буфер. ОДНА формула на всіх
   споживачів (lateCallClash, callCrossesMidnight, текст діалогу), щоб вони не
   розійшлись при першій же правці буфера.
   Свідомо БЕЗ normBuffer: це вікно — дзеркало серверного
   `coalesce(q.buffer_time_min, 5)` з гарда 0129. normBuffer (collisionFor,
   delayPlan) живе в план-просторі; тут розбіжність із БД дорожча за акуратність. */
export function callWindowMinutes(
  p: { duration_min: number | null; buffer_time_min: number | null }
): number {
  return (p.duration_min || 30) + Math.max(0, p.buffer_time_min ?? BUFFER_DEFAULT);
}

/* Кінець вікна виклику в ХВИЛИНАХ ДОБИ від 00:00 ПОТОЧНОЇ доби — значення
   МОЖЕ перевищувати 1440, і це не помилка, а факт: виклик о 23:40 на 30 хв
   з буфером 5 займає кабінет до 00:15 наступної доби.
   ⚠️ Це НЕ дзеркало 0129 (Ф4-2): `wallMinOfDay` усікає секунди вниз, а гард
   порівнює timestamptz. Лишається саме для тих двох місць, де потрібна
   ХВИЛИНА для людини: предикат `callCrossesMidnight` і текст «зайнято до
   HH:MM». Порівняння зі слотами живе нижче, у мілісекундах. */
export function callWindowEndMin(
  p: { duration_min: number | null; buffer_time_min: number | null },
  nowMs: number = wallNow()
): number {
  return wallMinOfDay(nowMs) + callWindowMinutes(p);
}

/* Невизначеність «зараз» клієнта відносно «зараз» сервера — ДВОСТОРОННЯ, і
   слак кладеться на ОБИДВІ межі вікна.

   ⚠️ ЦЕ ПЕРЕРАХУНОК ПІСЛЯ U-70, а не косметика. У Ф4-2 константа була 1000 мс
   і стояла лише на КІНЦІ вікна, бо тоді помилка була ОДНОнаправленою:
   `wallNow()` збирав момент із частин Intl (мілісекунд немає) і тому завжди
   ВІДСТАВАВ від сервера в межах секунди. U-70 перевів `wallNow()` на
   ВИМІРЯНИЙ годинник — і поправка може ПЕРЕСТРИБНУТИ сервер. Лишити слак
   одностороннім означало б відкрити ліву межу: слот, який сервер ще блокує,
   клієнт уже вважав би минулим.

   ЗВІДКИ ЧИСЛО. Клієнтське «зараз» N відносно справжнього настінного T:
     • помилка ЗАСТОСОВАНОГО зсуву — `CLOCK_WORST_ERROR_MS` (2125 мс), у будь-який
       бік. Її виведення живе в `lib/serverClock.ts` — там, де стоять самі
       пороги, а не переказується тут;
     • усічення до секунди в `wallNow` — N відстає ще на [0, 1000) мс.
   Отже T − N ∈ (−2125, +3125]. Беремо симетричні `CLOCK_WORST_ERROR_MS + 1000`
   на ОБИДВА краї: тоді і найслабший, і найсильніший можливий сервер накриті.

   ⚠️ ПЕРША РЕДАКЦІЯ ЦЬОГО ВИВЕДЕННЯ БУЛА НЕВІРНОЮ (знахідка ревʼю Б, HIGH), і
   помилка була саме в бік fail-open. Я порахував лише `rtt/2` і забув, що
   `applyClockEstimate` ОБНУЛЯЄ виміряний зсув, менший за `CLOCK_MIN_APPLY_MS`:
   справжній зсув до секунди лишається невиправленим, і це окреме доданкове
   джерело, а не частина похибки вимірювання. Отримані тоді 2000 мс не
   покривали праву межу: при справжньому зсуві 1999 мс і пробі з rtt = 2000
   оцінка виходила 999 мс, обнулялась, і слот рівно на кінці вікна проходив
   повз клієнта, а сервер його відхиляв.

   Ціна названа: слот у межах ~3 с від будь-якої межі вікна буде заблоковано і
   тоді, коли сервер пропустив би. Слоти лежать на хвилинній сітці, тож це
   зачіпає лише перші/останні секунди хвилини — і завжди в бік «зайвий блок»,
   який дешевший за тиху дію, що падає помилкою БД.
   ⚠️ На ЛІВІЙ межі ця ціна вища за праву, і це варто знати: `clash` не
   `confirmable`, тобто кнопка гасне без можливості підтвердити (ревʼю Б, LOW).
   Три секунди на п'ятихвилинну сітку — 1 % спроб виклику саме в цю мить.

   ⚠️ ЧОГО слак НЕ закриває:
     • ЗАТРИМКУ між рішенням клієнта і серверним `now()`. Між ними — Server
       Action, PostgREST і `pg_advisory_xact_lock(room)` у самій RPC, тобто
       очікування чужої транзакції по тому ж кабінету. Серверне вікно
       з'їжджає ВПЕРЕД на L, і слот на дальньому краї сервер відхилить, а
       клієнт його не блокував. L необмежена, тож сталою це не лікується, а
       великий слак дав би справжні хибні блоки щодня;
     • ДРЕЙФ годинника ПК між перезамірами (раз на 10 хв). Практично це
       десятки мілісекунд, але верхньої межі в нього немає — назвати чесніше,
       ніж вдавати, що 3125 мс її покривають.
   Обидва залишки закінчуються чесною помилкою `slot_unavailable`, а не
   зіпсованими даними: авторитет — гард. */
export const CALL_WINDOW_CLOCK_SLACK_MS = CLOCK_WORST_ERROR_MS + 1000;

/* Мілісекунди доби зі `scheduled_time`. Секунди читаємо, а не відкидаємо:
   тригер `set_scheduled_at` будує `scheduled_at` кастом
   ('YYYY-MM-DD' || 'T' || scheduled_time || 'Z')::timestamptz — тобто рядок
   ГАРАНТОВАНО парситься як час (інакше INSERT падає ще в БД), але CHECK-у на
   формат 'HH:MM' немає (перевірено на проді 31.08: 96/96 у 'HH:MM', обмеження
   відсутнє). Старий `toMin` брав лише [h, m] — секунда в даних зробила б
   клієнт і гард різними. `map(Number)` тримає і дробові секунди ('10:35:30.5'). */
function slotMsOfDay(t: string): number {
  const [h, m, s] = String(t).split(":").map(Number);
  return (h || 0) * 3600000 + (m || 0) * 60000 + (s || 0) * 1000;
}

/* Дзеркало гілки (б) гарда 0129 (`queue_set_status_rpc`, перевірено на живій
   функції 31.08):
     v_actual := (now() at time zone tz) at time zone 'utc';
     v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5));
     q.scheduled_at >= v_actual and q.scheduled_at < v_end  → ACTUAL_OVERLAP
   Рахуємо в мілісекундах доби, а не у хвилинах (Ф4-2). Хвилинне усічення
   зсувало обидві межі вниз і давало дві різні розбіжності:
     • початок — клієнт блокував БІЛЬШЕ за сервер (слот 10:00, коли вже
       10:00:30, для гарда вже в минулому) → хибний жорсткий блок до 59 с;
     • кінець  — клієнт блокував МЕНШЕ (слот рівно на кінці вікна) → оператор
       бачив дозволений виклик, який сервер відхиляв ACTUAL_OVERLAP.
   Друга розбіжність і є причина правки: fail-open у дзеркалі гарда. */
export function lateCallClash(
  p: { id: string; room_id: string | null; duration_min: number | null; buffer_time_min: number | null },
  entries: Array<{ id: string; room_id: string | null; status: string; scheduled_time: string | null; patient_name?: string | null }>,
  nowMs: number = wallNow()
): { time: string; name?: string | null } | null {
  if (!p.room_id) return null;
  const nowMsOfDay = wallMsOfDay(nowMs);
  // U-70: слак ДВОСТОРОННІЙ — див. виведення над константою.
  const startMsOfDay = nowMsOfDay - CALL_WINDOW_CLOCK_SLACK_MS;
  const endMsOfDay = nowMsOfDay + callWindowMinutes(p) * 60000 + CALL_WINDOW_CLOCK_SLACK_MS;
  const next = entries
    .filter((e) => e.room_id === p.room_id && e.id !== p.id && (e.status === "scheduled" || e.status === "waiting") && e.scheduled_time)
    .map((e) => ({ s: slotMsOfDay(String(e.scheduled_time)), time: String(e.scheduled_time), name: e.patient_name }))
    .filter((x) => x.s >= startMsOfDay && x.s < endMsOfDay)
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
   «можна». Дірка з невидимої стає названою.

   ⚠️ U-67(а), закрито в U-70. Предикат стояв у ХВИЛИНАХ, і рівно в хвилині
   `1440 − (тривалість+буфер)` з НЕНУЛЬОВИМИ секундами попередження не
   з'являлось: о 23:25:30 при 30+5 `callWindowEndMin` = 1440, `1440 > 1440`
   хибне — а серверне вікно тягнеться до 00:00:30, і запис завтра на 00:00
   отримає `ACTUAL_OVERLAP`.
   Це НЕ «просто пропущене підтвердження»: саме воно тут і є єдиним замінником
   блоку (записів завтрашньої доби в `entries` немає за побудовою), тож
   операційно виходила тиха дія, яку відхиляє БД — той самий клас, що закривав
   Ф4-2, тільки на хвилину вище.
   Тепер предикат рахується в мілісекундах із тим самим ДВОСТОРОННІМ слаком, що
   й у `lateCallClash`: попередження з'являється, щойно вікно МОЖЕ перетнути
   добу з погляду сервера.
   ⚠️ Ціна прийнята свідомо: о 23:25:00 рівно (при 30+5) діалог тепер
   показується, хоча раніше тест «рівно 24:00 — ще НЕ наступна доба» фіксував
   протилежне. Сервер у цю мить блокує запис на 00:00 (його `now()`
   мікросекундний, тобто вже за межею), тож старе мовчання було саме тим
   fail-open, який ми закриваємо. */
export function callCrossesMidnight(
  p: { room_id: string | null; duration_min: number | null; buffer_time_min: number | null },
  nowMs: number = wallNow()
): boolean {
  if (!p.room_id) return false;         // без кабінету займати нічого
  return callWindowEndMs(nowMs, p) + CALL_WINDOW_CLOCK_SLACK_MS > 24 * 3600000;
}

/** Кінець вікна виклику в МІЛІСЕКУНДАХ доби — без слака і без усічення.

    ⚠️ ЩО САМЕ СПІЛЬНЕ, а що ні (знахідка ревʼю Б, M-2: попередня редакція цього
    коментаря обіцяла «одну арифметику на предикат і на текст», хоча предикат
    рахує `end + SLACK`, а підпис — `end`).
    СПІЛЬНА тут БАЗА: обидва споживачі беруть кінець вікна з цієї однієї
    функції, тож правка тривалості/буфера не може зсунути одного і не зсунути
    іншого — саме це і мало значення.
    РІЗНЕ — слак, і свідомо. Слак кодує невизначеність НАШОГО «зараз», а не
    зайнятість кабінету: предикат вирішує «чи МОЖЕ вікно перетнути добу з
    погляду сервера» і тому мусить бути fail-closed, а підпис стверджує ФАКТ
    «кабінет зайнятий до HH:MM» і не має права додавати до нього нашу похибку.
    Практично слак і не змінив би підпис: `slotFmt` працює у хвилинах, тож
    3125 мс зрушили б показану хвилину лише тоді, коли кінець вікна лежить у
    останніх 3 с хвилини. Саме цей стик і закриває кламп нижче. */
function callWindowEndMs(
  nowMs: number,
  p: { duration_min: number | null; buffer_time_min: number | null }
): number {
  return wallMsOfDay(nowMs) + callWindowMinutes(p) * 60000;
}

/** Час, до якого кабінет зайнятий, як «HH:MM» НАСТУПНОЇ доби.
    ⚠️ Кламп на нулі обов'язковий: предикат вище спрацьовує ЗІ СЛАКОМ, тож у
    межах останніх ~3 секунд хвилини вікно ще не перетнуло добу арифметично, і
    без клампа сюди приїхало б від'ємне число — `slotFmt(-1)` дав би «-1:-1».
    Показуємо 00:00: вікно закінчується в першу хвилину нової доби. */
function nextDayEndLabel(
  nowMs: number,
  p: { duration_min: number | null; buffer_time_min: number | null }
): string {
  return slotFmt(Math.max(0, Math.floor(callWindowEndMs(nowMs, p) / 60000) - 24 * 60));
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
  /* Аудит с46, U-6. Дані про простої / особливі графіки не завантажились
     (`incidentsErr || overridesErr` на дошці). Тоді roomBlocked і schedClosed
     пораховані з ПОРОЖНЬОГО списку: «кабінет не заблоковано» тут означає «ми не
     знаємо», і виклик пацієнта в апарат, який може стояти на ремонті, проходить
     мовчки. Той самий інваріант, що й stuckUnknown, і та сама відповідь:
     не знаємо — не пускаємо.
     Дошка радіолога цей гейт уже мала — окремим `if` ДО computeCallBlock;
     дошка черги (реєстратор/адмін), яка викликає пацієнтів найчастіше, — ні.
     Правило переїхало сюди саме тому, що дві копії одного правила розійшлись. */
  safetyUnknown?: boolean;
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
  /* с46: дані про простої/графіки ненадійні. Жорсткий блок — підтвердженням не
     лікується: підтверджувати можна ризик, який ти БАЧИШ, а не той, про який
     нічого не відомо. */
  | { code: "safety_unknown"; confirmable?: false }
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

/** Текст блокування для safety_unknown — ОДИН на обидві дошки (с46): доти
    формулювання жило лише в дошці радіолога, і саме тому дошка черги не мала
    ані тексту, ані самого блока. */
export const SAFETY_UNKNOWN_REASON =
  "Дані про простої/графік не оновились — виклик заблоковано, оновіть сторінку";

export function computeCallBlock(
  p: CallBlockInfo,
  entries: Array<{ id: string; room_id: string | null; status: string; scheduled_time: string | null; patient_name?: string | null }>,
  opts: CallBlockOpts = {}
): CallBlock | null {
  const nowMs = opts.nowMs ?? wallNow();
  // Найперше: запис не на сьогодні — виклик неможливий незалежно від стану кабінету.
  if (opts.notToday) return { code: "wrong_day" };
  /* ПЕРЕД roomBlocked/schedClosed: обидва пораховані САМЕ з тих даних, яких у
     нас немає, тож їх «false» нічого не означає. А «не на сьогодні» лишається
     вище — ця причина від простоїв не залежить і для оператора точніша.
     ⚠️ Свідомий компроміс (ревʼю с46, F-2): гейт стоїть і перед room_busy /
     room_stuck / clash, які пораховані з ЗАВАНТАЖЕНИХ `entries` і чий вердикт
     достовірний. Тобто при збої простоїв оператор побачить «оновіть сторінку»
     замість «кабінет зайнятий». Точність програє, безпека — ні: усі ці коди
     теж жорсткі блоки, вихід один і той самий. Перенести гейт нижче можна лише
     разом зі зміною давньої precedence room_blocked > room_busy, а це вже інша
     задача. `p.room_id` — як у stuckUnknown (ревʼю с24, L3): без кабінету
     простій блокувати нічого не може, і казати «дані про простої» — брехня. */
  if (opts.safetyUnknown && p.room_id) return { code: "safety_unknown" };
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
    return { code: "next_day", durationMin, end: nextDayEndLabel(nowMs, p), confirmable: true };
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
