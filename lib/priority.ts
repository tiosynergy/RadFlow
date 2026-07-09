/* ===== RadFlow — Пріоритет пацієнта (patient_priority) =====
   Єдине джерело для UI, сортування та інтеграцій (n8n / AI-агент).
   Коди стабільні й машинно-читабельні: 'cito' | 'urgent' | 'planned'.
   Значення = enum public.patient_priority у БД (queue_entries.priority_level). */

import type { Database } from "@/supabase/types";

export type PatientPriority = Database["public"]["Enums"]["patient_priority"]; // "cito" | "urgent" | "planned"

/** Порядок у черзі: менше = вище (cito → urgent → planned). Зручно для сортування та AI-логіки. */
export const PRIORITY_RANK: Record<PatientPriority, number> = { cito: 0, urgent: 1, planned: 2 };

/** Порядок опцій у формах (від найвищого пріоритету). */
export const PRIORITY_OPTIONS: PatientPriority[] = ["cito", "urgent", "planned"];

export const PRIORITY_DEFAULT: PatientPriority = "planned";

export interface PriorityMeta {
  value: PatientPriority;
  short: string;   // бейдж у черзі
  label: string;   // повна назва у формах
  desc: string;    // підказка/показання
  tone: "red" | "orange" | "muted"; // колірний акцент
}

export const PRIORITY_META: Record<PatientPriority, PriorityMeta> = {
  cito: { value: "cito", short: "CITO", label: "CITO — екстрено", desc: "Загроза життю", tone: "red" },
  urgent: { value: "urgent", short: "Терміново", label: "Терміново", desc: "Підозра на онкологію, інфаркт, ЧМТ", tone: "orange" },
  planned: { value: "planned", short: "Планово", label: "Планово", desc: "Планові пацієнти", tone: "muted" },
};

/** Ранг пріоритету запису (null/невідоме → planned). */
export function priorityRank(p?: PatientPriority | null): number {
  return PRIORITY_RANK[(p ?? PRIORITY_DEFAULT) as PatientPriority] ?? PRIORITY_RANK.planned;
}

/** Нормалізувати довільне значення до валідного пріоритету (захист на запис). */
export function normPriority(v: unknown): PatientPriority {
  return v === "cito" || v === "urgent" || v === "planned" ? v : PRIORITY_DEFAULT;
}

/** Чи «активний» статус, у якому пріоритет впливає на порядок/бейдж. */
export function isActiveStatus(status?: string | null): boolean {
  return status === "scheduled" || status === "waiting" || status === "in_progress";
}
