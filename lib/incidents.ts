/* ===== RadFlow — единая логика простоев (поломка/ТО) =====
   Общий источник для всех ролей (доска администратора, бронирование,
   перенос, портал направителей), чтобы блокировка кабинета трактовалась
   одинаково везде.

   blocked_until — ВСЕГДА жёсткая граница блокировки (кабинет блокируется лишь в окне
   [started_at, blocked_until)). Если blocked_until не задано — «до восстановления» (Infinity).

   auto_unblock (по умолчанию true) управляет ТОЛЬКО судьбой записи после завершения окна:
     • true  — инцидент снимается автоматически (запись исчезает, баннер гаснет);
     • false — кабинет так же разблокируется в конце окна, но запись остаётся
               и ждёт ручного подтверждения снятия («🔓 Розблокувати»). */

/** Минимальная форма инцидента, нужная этим предикатам (подмножество incidents.Row). */
export interface IncidentLike {
  started_at: string;
  blocked_until?: string | null;
  auto_unblock?: boolean | null;
  room_id?: string | null;
}

/* ===== U-11: простої їдуть у компоненти ПРОПОМ, і масив про це бреше =====

   Дошки читають `incidents` самі й передають ГОТОВИЙ МАСИВ дітям. При збої
   читання прапорець (`incidentsErr`) лишається В БАТЬКА, а дитина отримує `[]` —
   і не може відрізнити «простоїв немає» від «ми не змогли їх прочитати». П'ять
   компонентів на цьому будували твердження «слот вільний», ще один — «кабінет
   не на ремонті», а `ReferralPortal` не передавав проп ВЗАГАЛІ, тобто для
   направника кабінет у простої завжди виглядав робочим.

   Тому проп більше не масив, а ФІД: рядки + чи вдалося їх прочитати. Це не
   стиль, а механізм — після зміни типу жоден виклик із голим масивом і жоден
   пропущений проп не компілюються, тож повнота правки перевіряється tsc, а не
   уважністю. Урок пакета U-8 («правило, застосоване руками, забудуть»),
   застосований до типу.

   Читати рядки можна ТІЛЬКИ через хелпери нижче: вони не дають прийняти
   невідомість за порожнечу. */
/* Дженерик — щоб фід не з'їдав поля рядка: `BreakdownModal` читає `id`/`reason`,
   `RoomDayOverviewModal` — `reason_label`. Без параметра ці екрани довелося б
   кастити назад, а каст — це рівно та дірка, яку фід і закриває. */
export type IncidentFeed<T extends IncidentLike = IncidentLike> = { rows: T[]; failed: boolean };

/** Загорнути прочитане. `failed` — прапорець збою читання з батьківського лоадера. */
export function incidentFeed<T extends IncidentLike>(rows: T[] | null | undefined, failed?: boolean | null): IncidentFeed<T> {
  return { rows: rows || [], failed: !!failed };
}

/** Простої НЕ прочитані — жодне твердження про доступність кабінету не можна робити. */
export function incidentsUnknown(feed: IncidentFeed<IncidentLike> | null | undefined): boolean {
  return !feed || feed.failed;
}

/** Простої КАБІНЕТУ. При невідомості — null (а НЕ порожній масив): виклику
    доведеться вирішити явно, і `.length` на null не пройде типізацію. */
export function roomIncidentsOf<T extends IncidentLike>(feed: IncidentFeed<T> | null | undefined, roomId: string | null | undefined): T[] | null {
  if (incidentsUnknown(feed)) return null;
  if (!roomId) return [];
  return (feed as IncidentFeed<T>).rows.filter((i) => i.room_id === roomId);
}

/** Чи припадає момент (мс, настінний час) на простій кабінету.
    ⚠️ Повертає `null`, коли простої невідомі. Саме `null`, а не `false`:
    `if (!roomIncidents.length) return false` — і був той fail-open, який
    дублювався у BookingModal і RescheduleModal. */
export function incidentAtInstant<T extends IncidentLike>(feed: IncidentFeed<T> | null | undefined, roomId: string | null | undefined, instantMs: number): T | null | undefined {
  const rows = roomIncidentsOf(feed, roomId);
  if (rows === null) return undefined;   // невідомо
  return rows.find((i) => instantMs >= new Date(i.started_at).getTime() && instantMs < incidentEffectiveEnd(i)) || null;
}

/** Чи заблокований момент простоєм КАБІНЕТУ — з рішенням про невідомість
    ВСЕРЕДИНІ. НЕВІДОМО → true (fail-closed).

    Це рішення тут, а не в компонентах, свідомо: тести цього проєкту ходять у
    node-середовищі й компонентів не бачать, тож правило, залишене в JSX,
    перевіряється лише сторожем-регуляркою. Тут воно перевіряється по суті —
    і однаково для BookingModal і RescheduleModal, які колись розійшлися саме
    на цій гілці (обидва мали `if (!roomIncidents.length) return false`). */
export function slotBlockedByFeed<T extends IncidentLike>(feed: IncidentFeed<T> | null | undefined, roomId: string | null | undefined, instantMs: number): boolean {
  const inc = incidentAtInstant(feed, roomId, instantMs);
  if (inc === undefined) return true;   // простої не прочитані
  return !!inc;
}

/* ===== U-15 (с48): стеля ТРИВАЛОСТІ за простоями =====

   `slotBlockedByFeed` відповідає на питання «чи вільний ЦЕЙ момент» — його
   вистачає екранам, які обирають СЛОТ. `StudyEditModal` слот не обирає, він
   міняє ТРИВАЛІСТЬ, тож йому треба інше питання: скільки хвилин від старту
   можна зайняти, поки дослідження не перетнеться з простоєм.

   ⚠️ Дзеркалимо серверний гард `check_not_during_incident` (0020) ПОБІТОВО.
   Він рахує так:

     tstzrange(i.started_at, coalesce(i.blocked_until, 'infinity'))
       && tstzrange(new.scheduled_at, new.scheduled_at + duration_min)

   Діапазони `[)`, отже перетин ⟺ `started_at < кінець_дослідження` І
   `старт_запису < кінець_простою`. Звідси максимум без перетину — рівно
   `started_at − старт_запису`, і рахувати його треба лише по простоях, чий
   кінець ЩЕ ПОПЕРЕДУ старту. Якщо простій уже накрив сам старт — не
   вміщується жодна тривалість, і це 0, а не «мало часу».

   Повертає `undefined`, коли стверджувати не можна: простої не прочитані
   (`roomIncidentsOf` → null); або простої в кабінеті Є, але старт невідомий чи
   `started_at` не парситься. Порожній список простоїв — це НЕ невідомість:
   там `Infinity` (див. коментар у тілі — порядок гілок має значення).
   Рішення про невідомість лишається у виклику — рівно як у `incidentAtInstant`,
   і НЕ підмінюється нулем чи нескінченністю тут. */
export function incidentDurCapMin<T extends IncidentLike>(
  feed: IncidentFeed<T> | null | undefined,
  roomId: string | null | undefined,
  startMs: number,
): number | undefined {
  const rows = roomIncidentsOf(feed, roomId);
  if (rows === null) return undefined;              // простої не прочитані
  /* Простоїв у кабінету НЕМАЄ — стелі немає, і це не «невідомо». Порядок із
     перевіркою старту важливий: якби `startMs` питали першим, запис без дати
     (`scheduledDate=""` — модалка це прямо допускає, див. `showGrid`) отримав би
     консервативну стелю `committedDur` у здоровому кабінеті й перестав би
     подовжуватись узагалі. Сервер у цьому місці теж пропускає: `not exists`
     по порожній вибірці істинний незалежно від `scheduled_at`. */
  if (rows.length === 0) return Infinity;
  /* Простої Є, а старт невідомий → «не знаємо», тобто консервативна стеля у
     виклику. НЕ 0: банер «кабінет у простої до 14:00» на запису без дати назвав
     би причиною те, що причиною не є.

     ⚠️ Перша версія цього коментаря стверджувала, що сервер тут ВІДХИЛИВ БИ —
     мовляв, `tstzrange(null,null)` це `(,)` і перетинається з будь-яким вікном.
     Діапазон справді такий (перевірено на проді), але висновок був НЕПРАВИЛЬНИЙ:
     я прочитав лише `exists`-частину гарда й не дійшов до його першого рядка.
     `check_not_during_incident` починається з
       `if new.status in (…) or new.scheduled_at is null or new.duration_min is
        null then return new;`
     — тобто запис без `scheduled_at` сервер пропускає ВЗАГАЛІ (ревʼю р1).
     Дзеркалити це один-в-один усе одно не можна: тут `startMs` — NaN і тоді,
     коли `scheduled_at` у рядка Є, а модалці просто не передали `scheduledDate`
     (проп nullable, див. `showGrid`). Розрізнити ці два випадки звідси нічим,
     тож лишаємось консервативними — але вголос: у проді записів без дати нуль
     (`scheduled_at is null` → 0), тож гілка є запобіжником, а не робочою. */
  if (!Number.isFinite(startMs)) return undefined;
  let cap = Infinity;
  for (const i of rows) {
    const s = new Date(i.started_at).getTime();
    /* Нерозпарсиваний початок — саме `undefined`, а не «пропустити рядок»:
       пропуск тихо перетворив би невідомий простій на «простою немає» —
       той самий fail-open, який весь цей модуль і закриває. */
    if (isNaN(s)) return undefined;
    if (incidentEffectiveEnd(i) <= startMs) continue;  // простій закінчився до старту
    if (s <= startMs) return 0;                        // старт УЖЕ всередині простою
    /* ⚠️ `floor` до ЦІЛИХ хвилин, і саме вниз (ревʼю р1, знахідка 1).
       `started_at` не вирівняний на хвилину: `emergency_stop_rpc` пише
       `(now() at time zone tz) at time zone 'utc'` з мікросекундами — на проді
       таких рядків 5 із 6. Без floor стеля виходила дробовою (23.7918…), і
       далі її друкував `fmt`, який робить `m % 60`: екран показував «до простою
       о 10:23.791866666666666» і радив «скоротіть на 6.2081 хв» — число, якого
       сама ж форма не прийме (normDur кратний 5).
       Вниз, а не round: 24 хв від 10:00 закінчуються о 10:24, а простій
       починається о 10:23:47 — сервер такий запис відхилить. Округлення вгору
       коштувало б рівно того відмовленого збереження. */
    cap = Math.min(cap, Math.floor((s - startMs) / 60000));
  }
  return Math.max(0, cap);
}

/** Підпис КІНЦЯ простою у настінному часі — для банерів, які мусять сказати не
    лише «кабінет у простої», а й «до коли». Без цього порада зводиться до
    «перезапишіть пацієнта», хоча простій міг закінчуватись через 20 хвилин.

    `null` = межі НЕМАЄ («до відновлення»): `blocked_until` порожній або
    нерозпарсиваний — рівно те саме `Infinity`, що й у `incidentEffectiveEnd`.
    Для виклику це не «не знаємо, промовчимо», а окремий текст: невідомий термін
    треба назвати вголос, інакше банер виглядає як недописаний.

    `dayKey` — доба, відносно якої підпис читають (`scheduled_date` запису).
    Простій тягнеться через північ легко (нічна поломка з `blocked_until` на
    ранок), і тоді «до 09:00» без дати — брехня рівно на добу: оператор чекав би
    дев'ятої ГОДИНИ ЦЬОГО Ж дня. Інший день → у підпис їде «DD.MM HH:MM».
    Без `dayKey` завжди друкуємо дату: зайва дата нікого не вводить в оману,
    відсутня — вводить.

    Кадр часу — «настінний як UTC» (канон 0035/0059, ті самі getUTC*, що в
    `wallMinOfDay`): конвертація через Intl дала б подвійний зсув. */
export function incidentEndLabel(inc: IncidentLike | null | undefined, dayKey?: string | null): string | null {
  if (!inc) return null;
  const end = incidentEffectiveEnd(inc);
  if (!Number.isFinite(end)) return null;
  const d = new Date(end);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const hhmm = p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
  const key = d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate());
  return key === dayKey ? hhmm : p2(d.getUTCDate()) + "." + p2(d.getUTCMonth() + 1) + " " + hhmm;
}

/** Усе, що екран редагування ТРИВАЛОСТІ має знати про простої, — одним викликом.

    Три величини (стеля, жорсткий блок, термін) рахувались би в компоненті
    трьома окремими викликами — і саме так вони з часом розходяться: стеля
    каже «0 хв», прапорець блоку мовчить, банер називає чужу причину. Тут вони
    виводяться ОДНА З ОДНОЇ: `blocked` — це рівно `capMin === 0`, а рядок
    простою дістається лише щоб НАЗВАТИ термін, і на рішення не впливає.

    Друга причина винести це в lib: тести проєкту ходять у node-середовищі й
    компонентів не бачать (`vitest.config.ts`). Правило, залишене в JSX,
    перевіряється лише сторожем-регуляркою — а той, як показало ревʼю U-30,
    обходиться раннім `return`. Тут воно перевіряється поведінково. */
export interface IncidentDurNotice {
  /** Стеля тривалості від старту, хв. `undefined` — стверджувати не можна
      (простої не прочитані), викликач мусить взяти консервативну стелю. */
  capMin: number | undefined;
  /** Старт УЖЕ всередині простою: не вміщується ЖОДНА тривалість. */
  blocked: boolean;
  /** Кінець простою, що блокує старт (`incidentEndLabel`). `null` — блоку немає
      або термін не визначено; текст «до відновлення» лишається за викликачем. */
  endLabel: string | null;
}

export function incidentDurNotice<T extends IncidentLike>(
  feed: IncidentFeed<T> | null | undefined,
  roomId: string | null | undefined,
  dateKey: string | null | undefined,
  timeStr: string | null | undefined,
): IncidentDurNotice {
  const startMs = wallInstant(dateKey, timeStr);
  const capMin = incidentDurCapMin(feed, roomId, startMs);
  /* ⚠️ Саме `=== 0`, а не `!capMin`: `undefined` (простої не прочитані) теж
     фолсі, і банер «кабінет у простої» світився б на справному кабінеті
     щоразу, коли впав запит інцидентів. */
  const blocked = capMin === 0;
  const inc = blocked ? incidentAtInstant(feed, roomId, startMs) : null;
  return { capMin, blocked, endLabel: inc ? incidentEndLabel(inc, dateKey) : null };
}

// Эффективный конец блокировки в мс. Жёсткая граница = blocked_until; без неё — Infinity («до восстановления»).
// Нераспарсимый blocked_until — тоже Infinity: «не знаем, когда закончится» ≠ «уже закончилось».
// Из БД (timestamptz) такое не приходит, но IncidentLike — публичный интерфейс, и NaN
// здесь молча снимал бы блокировку (fail-open в модуле, который весь fail-closed).
export function incidentEffectiveEnd(inc: IncidentLike | null | undefined): number {
  if (!inc) return -Infinity;
  if (!inc.blocked_until) return Infinity;
  const end = new Date(inc.blocked_until).getTime();
  return isNaN(end) ? Infinity : end;
}

// Канон времени: «настенный» момент — дата+время трактуются как UTC (без реальной
// конвертации TZ). Слот кодируется как UTC-мс независимо от таймзоны просмотра.
export function wallInstant(dateStr: string | null | undefined, timeStr: string | null | undefined): number {
  if (!dateStr || !timeStr) return NaN;
  const [Y, Mo, D] = String(dateStr).split("-").map(Number);
  const [h, m] = String(timeStr).split(":").map(Number);
  return Date.UTC(Y, (Mo || 1) - 1, D || 1, h || 0, m || 0);
}

// Таймзона клиники (IANA). Задаётся один раз при загрузке данных клиники
// (setClinicTz) в одноклиничных экранах (доски персонала). undefined → локальная
// таймзона браузера (fallback). Для мультиклиничных экранов (портал направителя)
// таймзона передаётся в wallNow(tz) поэлементно.
let _clinicTz: string | undefined;
export function setClinicTz(tz: string | null | undefined): void { _clinicTz = tz || undefined; }
export function getClinicTz(): string | undefined { return _clinicTz; }

// Текущий «настенный» момент В ТАЙМЗОНЕ КЛИНИКИ, закодированный как UTC-мс —
// сопоставим с wallInstant(slot). tz переопределяет клинику по умолчанию
// (нужно для портала направителя, где записи из разных центров).
export function wallNow(tz?: string): number {
  const d = new Date();
  const zone = tz || _clinicTz;
  if (!zone) {
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(d);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  } catch {
    // Невалидная IANA-зона → безопасный fallback на локальную.
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }
}

// Минуты от начала суток из настенного UTC-мс (getUTC*, т.к. закодировано как UTC).
export function wallMinOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// «Сегодня» (YYYY-MM-DD) в НАСТЕННОМ времени клиники — ключ scheduled_date.
// Не использовать dateKey(new Date()): он даёт день БРАУЗЕРА (или сервера в
// Server Action) — в клинике с другой зоной около полуночи это другой день, и
// «пострадавшие сегодня» считаются не за тот день. getUTC*, т.к. wallNow
// кодирует настенное время как UTC-мс.
export function wallDayKey(tz?: string): string {
  const d = new Date(wallNow(tz));
  return (
    d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0")
  );
}

// «Сегодня» как Date-объект ЛОКАЛЬНОЙ полуночи — но календарный день берётся из
// НАСТЕННОГО времени клиники. Единственная замена локальным today0() в компонентах:
// они сравнивают его с датами вида new Date("YYYY-MM-DD" + "T00:00:00") (тоже
// локальная полночь), поэтому фрейм «Date-объект = календарная дата» сохраняется,
// а сам день считается по клинике, а не по браузеру оператора.
//
// Было (баг M-4): оператор в другой зоне около полуночи видел день БРАУЗЕРА, тогда
// как isLate/computeCallBlock/nowMin считались по клинике → доска открывалась на
// «вчера клиники», кнопка «Викликати» разблокировалась, записи горели «⏰ Запізнення».
export function wallToday0(tz?: string): Date {
  const d = new Date(wallNow(tz));
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

// Минуты от начала суток настенного времени клиники для РЕАЛЬНОГО момента (ISO
// instant, напр. in_progress_at = new Date().toISOString()). Нужно, чтобы
// начатое (возможно с опозданием) in_progress-исследование занимало сетку слотов
// по фактическому старту, а не по плановому scheduled_time. tz переопределяет клинику.
export function wallMinOfInstant(iso: string | null | undefined, tz?: string): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const zone = tz || _clinicTz;
  if (!zone) return d.getHours() * 60 + d.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return g("hour") * 60 + g("minute");
  } catch {
    return d.getHours() * 60 + d.getMinutes();
  }
}

/* РЕАЛЬНЫЙ инстант (in_progress_at) → «настенные» мс в зоне клиники — тот же фрейм,
   что wallInstant(date,time). Нужно там, где занятость кабинета сравнивается
   СКВОЗЬ СУТКИ: wallMinOfInstant даёт только минуты дня и теряет дату, поэтому
   исследование, начатое в 23:30 и перешедшее полночь, в минутах дня не выражается
   (вылезает за 1440). Канон совпадает с check_no_overlap (0068), который сравнивает
   абсолютные tstzrange. */
export function wallInstantOf(iso: string | null | undefined, tz?: string): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const zone = tz || _clinicTz;
  if (!zone) return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(d);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  } catch {
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }
}

// Блокирует ли инцидент кабинет в момент ms (ms — настенный, из wallNow/wallInstant).
export function incidentActiveAt(inc: IncidentLike | null | undefined, ms: number): boolean {
  if (!inc) return false;
  const s = new Date(inc.started_at).getTime();
  return ms >= s && ms < incidentEffectiveEnd(inc);
}

// Авто-разблокировка + время завершения уже прошло → инцидент больше не действует (снимаем/прячем баннер).
export function incidentExpired(inc: IncidentLike | null | undefined, ms: number = wallNow()): boolean {
  if (!inc) return false;
  return inc.auto_unblock !== false && !!inc.blocked_until && ms >= new Date(inc.blocked_until).getTime();
}

// Ручной режим + окно уже завершилось → кабинет уже не блокируется, но запись ждёт ручного снятия.
export function incidentAwaitingManualUnblock(inc: IncidentLike | null | undefined, ms: number = wallNow()): boolean {
  if (!inc) return false;
  return inc.auto_unblock === false && !!inc.blocked_until && ms >= new Date(inc.blocked_until).getTime();
}

// Попадает ли слот (мс начала) в окно простоя любого инцидента кабинета — блокирует бронирование.
export function slotBlockedByIncidents(
  incidents: IncidentLike[] | null | undefined,
  roomId: string,
  slotMs: number
): boolean {
  return (incidents || []).some(
    (i) => i.room_id === roomId && slotMs >= new Date(i.started_at).getTime() && slotMs < incidentEffectiveEnd(i)
  );
}

/* ===== Простой в «минутах суток» — для публикуемой доступности (аудит с45) =====

   ЗАЧЕМ. `room_busy_slots` не знает про инциденты вообще: занятость там —
   исключительно строки `queue_entries`. Досок это не касается (они грузят
   `incidents` отдельно), а вот REST v1 `/slots` и FHIR `Slot` считали
   свободное время как «окно − перерывы − room_busy_slots» и публиковали
   кабинет в ремонте как СВОБОДНЫЙ. При этом CapabilityStatement на
   `/fhir/R4/metadata` дословно обещает партнёру обратное: «перерва,
   інцидент і вимкнений кабінет однаково дають busy-unavailable».
   Запись в такое окно всё равно отбивает триггер `check_not_during_incident`
   (23P01), то есть партнёр получает отказ на слот, который ему только что
   отдали свободным.

   ФРЕЙМ ВРЕМЕНИ. `incidents.started_at` / `blocked_until` хранятся в том же
   каноне «настенное время как UTC», что и `scheduled_at` (0035/0059) —
   проверено на проде: `started_at − created_at` = ровно смещение зоны
   клиники. Поэтому здесь сравниваются wall-as-UTC мс, БЕЗ конвертации через
   Intl (это дало бы двойной сдвиг — правило AGENTS.md).

   ГРАНИЦЫ КОНСЕРВАТИВНЫЕ: начало вниз (floor), конец вверх (ceil). Лишняя
   заблокированная минута — это отказ в записи; недостающая — пациент,
   записанный в сломанный аппарат. */

/** Пересечение окна простоя с сутками `dateKey`, в минутах от начала суток. */
export function incidentMinutesOnDay(
  inc: IncidentLike | null | undefined,
  dateKey: string
): { s: number; e: number } | null {
  if (!inc) return null;
  const dayStart = wallInstant(dateKey, "00:00");
  if (isNaN(dayStart)) return null;
  const dayEnd = dayStart + 1440 * 60000;

  const start = new Date(inc.started_at).getTime();
  if (isNaN(start)) return null;
  const end = incidentEffectiveEnd(inc);          // может быть Infinity («до восстановления»)

  const s = Math.max(start, dayStart);
  const e = Math.min(end, dayEnd);
  if (!(e > s)) return null;

  return { s: Math.floor((s - dayStart) / 60000), e: Math.ceil((e - dayStart) / 60000) };
}

/** Границы выборки простоев на диапазон дат [dateFrom, dateTo] — ISO-строки.

    Полуоткрытый интервал [00:00 dateFrom, 24:00 dateTo): предикат выборки —
    `started_at < toIso and (blocked_until is null or blocked_until > fromIso)`.

    Отдельная функция, а не три копии в роутах: потерянные «+ сутки» в верхней
    границе — это молчаливый пропуск простоя в последний день диапазона, то есть
    ровно тот дефект, ради которого всё это писалось (ревью с45, round 1).
    Кадр времени — «настенный как UTC» (канон 0035/0059), поэтому wallInstant,
    а не new Date(dateKey): иначе сдвиг на смещение зоны клиники.
    null — на невалидном или перевёрнутом диапазоне (у new Date(NaN).toISOString()
    нет безопасного значения: он бросает RangeError). */
export function incidentRangeIso(
  dateFrom: string,
  dateTo: string
): { fromIso: string; toIso: string } | null {
  const from = wallInstant(dateFrom, "00:00");
  const to = wallInstant(dateTo, "00:00");
  if (isNaN(from) || isNaN(to) || to < from) return null;
  return {
    fromIso: new Date(from).toISOString(),
    toIso: new Date(to + 1440 * 60000).toISOString(),
  };
}

/** Минуты суток, отобранные у кабинета всеми его простоями. Порядок не гарантируется.

    Сравнение id кабинета — БЕЗ УЧЁТА РЕГИСТРА. Внешние роуты принимают uuid по
    regex с флагом /i, Postgres сравнивает uuid тоже без учёта регистра, но
    ВОЗВРАЩАЕТ каноническую нижнюю форму. Партнёрский RIS с GUID в верхнем
    регистре (SQL Server, Delphi) прошёл бы валидацию, получил бы строки из БД —
    и здесь строгое `!==` выбросило бы ВСЕ простои: кабинет в ремонте снова
    публикуется свободным (ревью с45, round 1). */
export function incidentMinutesForRoom(
  incidents: IncidentLike[] | null | undefined,
  roomId: string,
  dateKey: string
): { s: number; e: number }[] {
  const want = String(roomId || "").toLowerCase();
  const out: { s: number; e: number }[] = [];
  for (const i of incidents || []) {
    if (String(i.room_id || "").toLowerCase() !== want) continue;
    const m = incidentMinutesOnDay(i, dateKey);
    if (m) out.push(m);
  }
  return out;
}

// Попадает ли запись (scheduled_date 'YYYY-MM-DD' + scheduled_time 'HH:MM') в окно простоя инцидента.
// Единый предикат «пострадавших» для доски и колл-листа (полный datetime, конец = blocked_until || Infinity).
export function entryInIncidentWindow(
  scheduledDate: string | null | undefined,
  scheduledTime: string | null | undefined,
  inc: IncidentLike | null | undefined
): boolean {
  if (!inc || !scheduledDate || !scheduledTime) return false;
  const dt = wallInstant(scheduledDate, scheduledTime);
  const start = new Date(inc.started_at).getTime();
  return dt >= start && dt < incidentEffectiveEnd(inc);
}
