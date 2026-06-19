/* ===== RadFlow — єдина логіка простоїв (поломка/ТО) =====
   Спільне джерело для всіх ролей (дошка адміністратора, бронювання,
   перенос, портал направників), щоб блокування кабінету трактувалося
   однаково скрізь.

   auto_unblock (за замовчуванням true):
     • true  — кабінет розблокується автоматично, щойно настане blocked_until;
     • false — лише ручне зняття; до того кабінет заблоковано без обмеження в часі
               (blocked_until — орієнтовний). */

// Ефективний кінець блокування у мс. Для ручного зняття або «до відновлення» — Infinity.
export function incidentEffectiveEnd(inc) {
  if (!inc) return -Infinity;
  if (inc.blocked_until && inc.auto_unblock !== false) return new Date(inc.blocked_until).getTime();
  return Infinity; // ручне зняття або без часу завершення
}

// Чи інцидент блокує кабінет у момент ms.
export function incidentActiveAt(inc, ms) {
  if (!inc) return false;
  const s = new Date(inc.started_at).getTime();
  return ms >= s && ms < incidentEffectiveEnd(inc);
}

// Авто-розблокування + час завершення вже минув → інцидент більше не діє (можна знімати/ховати банер).
export function incidentExpired(inc, ms = Date.now()) {
  if (!inc) return false;
  return inc.auto_unblock !== false && !!inc.blocked_until && ms >= new Date(inc.blocked_until).getTime();
}

// Чи слот (мс початку) потрапляє у вікно простою будь-якого інциденту кабінету — блокує бронювання.
export function slotBlockedByIncidents(incidents, roomId, slotMs) {
  return (incidents || []).some((i) => i.room_id === roomId && slotMs >= new Date(i.started_at).getTime() && slotMs < incidentEffectiveEnd(i));
}
