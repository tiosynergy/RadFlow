/* ===== RadFlow — Крос-модальний кейс пацієнта: чиста логіка =====
   Кейс (patient_cases, 0091) групує N queue_entries РІЗНИХ модальностей
   (Мамографія→УЗД тощо). Тут лише чисті функції (як решта lib/*): статус кейса
   зі статусів кроків, порядок кроків, предикати «активний»/«скасовний».
   Це ДЗЕРКАЛО серверної логіки cancel_case_rpc (0092) — клієнт і сервер мусять
   рахувати однаково. Дефолти §12: Q1 — групове скасування чіпає лише активні
   кроки, КРІМ in_progress (пацієнт у кабінеті) і термінованих (done/no_show/…);
   Q2 — sequential за замовчуванням false. */

import type { CaseStatus, QueueStatus } from "@/supabase/types";

/** Мінімум для агрегації статусу кейса зі зрізаних queue_entries. */
export interface CaseStepLite {
  status: QueueStatus;
  case_step?: number | null;
  scheduled_at?: string | null;
}

/* «Живі» статуси кроку: слот ще актуальний / пацієнт у процесі. */
const ACTIVE: readonly QueueStatus[] = ["scheduled", "waiting", "in_progress", "needs_reschedule"];
/* Скасовні одним груповим скасуванням. in_progress НЕ чіпаємо (Q1): пацієнт у
   кабінеті — скасувати з-під нього не можна; done/no_show/not_held/cancelled —
   термінальні (нічого скасовувати). */
const CANCELLABLE: readonly QueueStatus[] = ["scheduled", "waiting", "needs_reschedule"];

export function isActiveStep(s: QueueStatus): boolean {
  return ACTIVE.includes(s);
}
export function isCancellableStep(s: QueueStatus): boolean {
  return CANCELLABLE.includes(s);
}

/** Статус кейса зі статусів кроків (дзеркало recompute у cancel_case_rpc):
    open — є хоч один активний крок; completed — активних немає і є хоч один done;
    cancelled — нічого активного й жодного done (усі cancelled/no_show/not_held). */
export function caseStatusFromSteps(steps: ReadonlyArray<Pick<CaseStepLite, "status">>): CaseStatus {
  const arr = Array.isArray(steps) ? steps : [];
  if (arr.length === 0) return "open"; // кейс ще формується
  if (arr.some((s) => isActiveStep(s.status))) return "open";
  if (arr.some((s) => s.status === "done")) return "completed";
  return "cancelled";
}

/** Скільки кроків реально скасуються груповим скасуванням (для тексту підтвердження). */
export function cancellableCount(steps: ReadonlyArray<Pick<CaseStepLite, "status">>): number {
  return (Array.isArray(steps) ? steps : []).filter((s) => isCancellableStep(s.status)).length;
}

/** Прогрес кейса для бейджа на дошці: done / усього. */
export function caseProgress(steps: ReadonlyArray<Pick<CaseStepLite, "status">>): { done: number; total: number } {
  const arr = Array.isArray(steps) ? steps : [];
  return { done: arr.filter((s) => s.status === "done").length, total: arr.length };
}

/** Порядок кроків: за case_step (null — в кінець), далі scheduled_at, далі стабільно. */
export function sortSteps<T extends CaseStepLite>(steps: ReadonlyArray<T>): T[] {
  return [...(Array.isArray(steps) ? steps : [])].sort((a, b) => {
    const sa = a.case_step ?? Number.POSITIVE_INFINITY;
    const sb = b.case_step ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return (a.scheduled_at || "").localeCompare(b.scheduled_at || "");
  });
}

/** «Наступний крок» — перший активний у порядку (для м'якої залежності/підказки). */
export function nextStep<T extends CaseStepLite>(steps: ReadonlyArray<T>): T | null {
  return sortSteps(steps).find((s) => isActiveStep(s.status)) ?? null;
}
