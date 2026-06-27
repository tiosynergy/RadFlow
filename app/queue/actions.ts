"use server";

// TD-4 (референс-паттерн) — Server Actions для мутаций доски очереди.
//
// Зачем: раньше мутации шли прямо из клиентского QueueBoard.jsx анон-клиентом,
// а единственной защитой была RLS. Здесь мутация выполняется на сервере с
// проверкой сессии и единой обработкой ошибок; RLS остаётся defense-in-depth
// (multi-tenant изоляция по clinic_id). Синхронизация между клиентами —
// по-прежнему через realtime (postgres_changes), поэтому отдельный revalidate
// для этих «живых» клиентских досок не нужен.
//
// Это эталон: остальные мутации очереди (incidents, schedule_overrides,
// бронирование, перенос) переводятся на тот же паттерн пошагово.

import { createClient } from "@/lib/supabase/server";
import type { QueueStatus } from "@/supabase/types";

export type QueueActionResult =
  | { ok: true }
  | { ok: false; error: string; code?: "room_busy" | "slot_unavailable" | "forbidden" | "auth" | "generic" };

const ALLOWED_STATUSES: readonly QueueStatus[] = [
  "scheduled",
  "waiting",
  "in_progress",
  "done",
  "no_show",
  "cancelled",
  "not_held",
];

// Распознаём нарушения БД-инвариантов по тексту ошибки и отдаём код клиенту,
// чтобы он показал локализованное сообщение (укр. строки живут в компоненте).
function classifyError(message: string, status?: QueueStatus): QueueActionResult {
  if (status === "in_progress" && /in_progress|duplicate|23505/i.test(message)) {
    return { ok: false, error: message, code: "room_busy" };
  }
  if (/overlap|exclusion|incident/i.test(message)) {
    return { ok: false, error: message, code: "slot_unavailable" };
  }
  return { ok: false, error: message, code: "generic" };
}

/**
 * Сменить статус записи очереди. При переходе в in_progress отдельно фиксирует
 * in_progress_at (для корректного таймера, независимого от updated_at).
 */
export async function setQueueEntryStatus(
  id: string,
  status: QueueStatus
): Promise<QueueActionResult> {
  if (!id || typeof id !== "string") return { ok: false, error: "Невірний ідентифікатор запису", code: "generic" };
  if (!ALLOWED_STATUSES.includes(status)) return { ok: false, error: "Невідомий статус", code: "generic" };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const patch =
    status === "in_progress"
      ? { status, in_progress_at: new Date().toISOString() }
      : { status };

  const { data, error } = await supabase
    .from("queue_entries")
    .update(patch)
    .eq("id", id)
    .select("id");

  if (error) return classifyError(error.message, status);
  // RLS не отдаёт ошибку, а молча обновляет 0 строк, если нет доступа/записи.
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Скасувати запис (status → cancelled). */
export async function cancelQueueEntry(id: string): Promise<QueueActionResult> {
  if (!id || typeof id !== "string") return { ok: false, error: "Невірний ідентифікатор запису", code: "generic" };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data, error } = await supabase
    .from("queue_entries")
    .update({ status: "cancelled" })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}
