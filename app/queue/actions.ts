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
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QueueStatus, CallStatus } from "@/supabase/types";

export type QueueActionResult =
  | { ok: true }
  | { ok: false; error: string; code?: "room_busy" | "slot_unavailable" | "forbidden" | "auth" | "duplicate" | "generic" };

// clinic_id текущего пользователя берём с сервера (не доверяем клиенту) — нужно
// для insert'ов (incidents/booking), где tenant нельзя выводить из обновляемой строки.
async function callerClinicId(supabase: SupabaseClient<Database>): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profiles").select("clinic_id").eq("id", user.id).single();
  return data?.clinic_id ?? null;
}

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

/** Завершить процедуру: статус done/no_show + объединённая заметка. */
export async function completeQueueEntry(
  id: string,
  status: "done" | "no_show",
  note: string | null
): Promise<QueueActionResult> {
  if (!id || typeof id !== "string") return { ok: false, error: "Невірний ідентифікатор запису", code: "generic" };
  if (status !== "done" && status !== "no_show") return { ok: false, error: "Невідомий статус", code: "generic" };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data, error } = await supabase
    .from("queue_entries")
    .update({ status, note })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

const ALLOWED_CALL_STATUSES: readonly CallStatus[] = [
  "not_called",
  "to_recall",
  "no_answer",
  "confirmed",
  "declined",
];

/** Статус обзвона. При declined запись отменяется (status → cancelled). */
export async function setQueueEntryCall(id: string, callStatus: CallStatus): Promise<QueueActionResult> {
  if (!id || typeof id !== "string") return { ok: false, error: "Невірний ідентифікатор запису", code: "generic" };
  if (!ALLOWED_CALL_STATUSES.includes(callStatus)) return { ok: false, error: "Невідомий статус обдзвону", code: "generic" };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const patch =
    callStatus === "declined" ? { call_status: callStatus, status: "cancelled" as QueueStatus } : { call_status: callStatus };

  const { data, error } = await supabase.from("queue_entries").update(patch).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Снять простой кабинета (incident → resolved). */
export async function resolveIncident(id: string): Promise<QueueActionResult> {
  if (!id || typeof id !== "string") return { ok: false, error: "Невірний ідентифікатор", code: "generic" };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data, error } = await supabase
    .from("incidents")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або інцидент не знайдено", code: "forbidden" };
  return { ok: true };
}

export type IncidentInput = {
  id?: string | null;
  roomId: string;
  reason: string;
  reasonLabel?: string | null;
  note?: string | null;
  startedAt: string;
  blockedUntil?: string | null;
  autoUnblock?: boolean;
};

export type IncidentActionResult =
  | { ok: true; status: "planned" | "active" }
  | { ok: false; error: string; code?: "duplicate" | "forbidden" | "auth" | "generic" };

/** Создать/обновить простой (поломка/ТО). Будущий старт → planned, текущий → active.
    При создании активного простоя пациент «у кабінеті» переводится в not_held. */
export async function submitIncident(input: IncidentInput): Promise<IncidentActionResult> {
  if (!input?.roomId) return { ok: false, error: "Не вказано кабінет", code: "generic" };

  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  const startMs = new Date(input.startedAt).getTime();
  const status: "planned" | "active" = startMs > Date.now() ? "planned" : "active";
  const fields = {
    room_id: input.roomId,
    reason: input.reason,
    reason_label: input.reasonLabel ?? null,
    note: input.note ?? null,
    started_at: input.startedAt,
    blocked_until: input.blockedUntil ?? null,
    auto_unblock: input.autoUnblock !== false,
    status,
  };

  if (input.id) {
    const { data, error } = await supabase.from("incidents").update(fields).eq("id", input.id).select("id");
    if (error) return { ok: false, error: error.message, code: "generic" };
    if (!data || data.length === 0) return { ok: false, error: "Немає доступу або інцидент не знайдено", code: "forbidden" };
    return { ok: true, status };
  }

  const { error } = await supabase.from("incidents").insert({ clinic_id: clinicId, ...fields });
  if (error) {
    if (/duplicate|unique|23505/i.test(error.message)) {
      return { ok: false, error: error.message, code: "duplicate" };
    }
    return { ok: false, error: error.message, code: "generic" };
  }
  // Поломка ЗАРАЗ під час дослідження → пацієнт «у кабінеті» → «Не відбулося».
  if (status === "active") {
    await supabase
      .from("queue_entries")
      .update({ status: "not_held" })
      .eq("clinic_id", clinicId)
      .eq("room_id", input.roomId)
      .eq("status", "in_progress");
  }
  return { ok: true, status };
}
