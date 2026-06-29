/* ===== RadFlow — производный статус «требует уточнения» =====
   Если время начала записи уже прошло, а статус всё ещё «В черзі» (scheduled)
   или «Очікує» (waiting, пациент пришёл, но его не вызвали) — запись не
   проведена вовремя и требует действия администратора/радиолога (провести,
   отметить неявку или перенести).
   Это ВИЗУАЛЬНЫЙ производный статус — в БД статус не меняется. */

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

// dayDate — Date дня записи (00:00); scheduledTime — "HH:MM".
export function needsClarification(
  status: string | null | undefined,
  dayDate: Date | null | undefined,
  scheduledTime: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (status && status !== "scheduled" && status !== "waiting") return false; // лише «В черзі»/«Очікує»/невизначений
  if (!dayDate || !scheduledTime) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  const start = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0);
  return start.getTime() < now.getTime();
}
