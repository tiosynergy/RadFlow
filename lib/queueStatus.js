/* ===== RadFlow — похідний статус «потребує уточнення» =====
   Якщо час початку запису вже минув, а статус усе ще «В черзі» (scheduled)
   або не визначений — запис не міг бути проведений вчасно й потребує дії
   адміністратора/радіолога (провести, відмітити неявку або перенести).
   Це ВІЗУАЛЬНИЙ похідний статус — у БД статус не змінюється. */

export const CLARIFY_META = { label: "⚠ Потребує уточнення", cls: "orange" };

// dayDate — Date дня запису (00:00); scheduledTime — "HH:MM".
export function needsClarification(status, dayDate, scheduledTime, now = new Date()) {
  if (status && status !== "scheduled") return false; // лише «В черзі» / невизначений
  if (!dayDate || !scheduledTime) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  const start = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0);
  return start.getTime() < now.getTime();
}
