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
// конвертации TZ). Не зависит от таймзоны браузера, без сдвига даты в полночь и без DST.
export function wallInstant(dateStr: string | null | undefined, timeStr: string | null | undefined): number {
  if (!dateStr || !timeStr) return NaN;
  const [Y, Mo, D] = String(dateStr).split("-").map(Number);
  const [h, m] = String(timeStr).split(":").map(Number);
  return Date.UTC(Y, (Mo || 1) - 1, D || 1, h || 0, m || 0);
}
// Текущий настенный момент (локальные часы центра, закодированные как UTC).
export function wallNow(): number {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
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
