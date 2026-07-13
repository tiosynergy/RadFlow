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

// Эффективный конец блокировки в мс. Жёсткая граница = blocked_until; без неё — Infinity («до восстановления»).
export function incidentEffectiveEnd(inc: IncidentLike | null | undefined): number {
  if (!inc) return -Infinity;
  return inc.blocked_until ? new Date(inc.blocked_until).getTime() : Infinity;
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
