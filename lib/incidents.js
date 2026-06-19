/* ===== RadFlow — єдина логіка простоїв (поломка/ТО) =====
   Спільне джерело для всіх ролей (дошка адміністратора, бронювання,
   перенос, портал направників), щоб блокування кабінету трактувалося
   однаково скрізь.

   blocked_until — ЗАВЖДИ жорстка межа блокування (кабінет блокується лише у вікні
   [started_at, blocked_until)). Якщо blocked_until не задано — «до відновлення» (Infinity).

   auto_unblock (за замовчуванням true) керує ЛИШЕ долею запису після завершення вікна:
     • true  — інцидент знімається автоматично (запис зникає, банер гасне);
     • false — кабінет так само розблоковується наприкінці вікна, але запис лишається
               й чекає на ручне підтвердження зняття («🔓 Розблокувати»). */

// Ефективний кінець блокування у мс. Жорстка межа = blocked_until; без неї — Infinity («до відновлення»).
export function incidentEffectiveEnd(inc) {
  if (!inc) return -Infinity;
  return inc.blocked_until ? new Date(inc.blocked_until).getTime() : Infinity;
}

// Чи інцидент блокує кабінет у момент ms.
export function incidentActiveAt(inc, ms) {
  if (!inc) return false;
  const s = new Date(inc.started_at).getTime();
  return ms >= s && ms < incidentEffectiveEnd(inc);
}

// Авто-розблокування + час завершення вже минув → інцидент більше не діє (знімаємо/ховаємо банер).
export function incidentExpired(inc, ms = Date.now()) {
  if (!inc) return false;
  return inc.auto_unblock !== false && !!inc.blocked_until && ms >= new Date(inc.blocked_until).getTime();
}

// Ручний режим + вікно вже завершилося → кабінет вже не блокується, але запис чекає на ручне зняття.
export function incidentAwaitingManualUnblock(inc, ms = Date.now()) {
  if (!inc) return false;
  return inc.auto_unblock === false && !!inc.blocked_until && ms >= new Date(inc.blocked_until).getTime();
}

// Чи слот (мс початку) потрапляє у вікно простою будь-якого інциденту кабінету — блокує бронювання.
export function slotBlockedByIncidents(incidents, roomId, slotMs) {
  return (incidents || []).some((i) => i.room_id === roomId && slotMs >= new Date(i.started_at).getTime() && slotMs < incidentEffectiveEnd(i));
}
