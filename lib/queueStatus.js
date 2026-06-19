/* ===== RadFlow — похідний статус «потребує уточнення» =====
   Якщо час початку запису вже минув, а статус усе ще «В черзі» (scheduled)
   чи «Очікує» (waiting, пацієнт прийшов, але його не викликали) — запис не
   проведено вчасно й він потребує дії адміністратора/радіолога (провести,
   відмітити неявку або перенести).
   Це ВІЗУАЛЬНИЙ похідний статус — у БД статус не змінюється. */

export const CLARIFY_META = { label: "⚠ Уточнити", cls: "orange", title: "Потребує уточнення: час запису минув, а пацієнта ще не проведено" };

// dayDate — Date дня запису (00:00); scheduledTime — "HH:MM".
export function needsClarification(status, dayDate, scheduledTime, now = new Date()) {
  if (status && status !== "scheduled" && status !== "waiting") return false; // лише «В черзі»/«Очікує»/невизначений
  if (!dayDate || !scheduledTime) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  const start = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0);
  return start.getTime() < now.getTime();
}
