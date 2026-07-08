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
import type { Database, Json, QueueStatus, CallStatus, TablesUpdate } from "@/supabase/types";
import { BUFFER_DEFAULT, normBuffer } from "@/lib/studies";
import { normPriority, type PatientPriority } from "@/lib/priority";
import { deliverPendingOutbox } from "@/lib/outbox";

export type QueueActionResult =
  | { ok: true; id?: string } // id — створений запис (createBooking/createReferralBooking)
  | {
      ok: false;
      error: string;
      code?: "room_busy" | "slot_unavailable" | "slot_taken" | "incident" | "forbidden" | "auth" | "duplicate" | "stale" | "generic";
      // Для code='stale' (H-2): реальный статус на сервере, чтобы доска ресинкнулась.
      currentStatus?: QueueStatus;
    };

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

// Распознаём нарушения БД-инвариантов и отдаём код клиенту (укр. строки живут
// в компоненте). L-3: приоритет — по SQLSTATE (error.code), надёжнее текста:
//   23505 unique_violation → «один in_progress на кабинет» (частичный uniq idx 0018);
//   23P01 exclusion_violation → перекрытие слота / простой (триггеры 0014/0020).
// Текстовый разбор оставлен как fallback (на случай иной обёртки ошибки).
function classifyError(err: { code?: string; message?: string }, status?: QueueStatus): QueueActionResult {
  const code = err?.code ?? "";
  const message = err?.message ?? "";
  if (status === "in_progress" && (code === "23505" || /in_progress|duplicate|23505/i.test(message))) {
    return { ok: false, error: message, code: "room_busy" };
  }
  if (code === "23P01" || /overlap|exclusion|incident/i.test(message)) {
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
  status: QueueStatus,
  // H-2: ожидаемый текущий статус (тот, что видит оператор на доске). Если задан —
  // делаем CAS через .eq("status", expectedFrom): при устаревшем состоянии
  // (коллега уже сменил статус) обновятся 0 строк → отдаём code='stale', а не
  // тихо перетираем чужой переход (last-write-wins). Необязателен → обратная
  // совместимость: без него поведение прежнее.
  expectedFrom?: QueueStatus
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

  let q = supabase.from("queue_entries").update(patch).eq("id", id);
  if (expectedFrom) q = q.eq("status", expectedFrom); // CAS
  const { data, error } = await q.select("id");

  if (error) return classifyError(error, status);
  // RLS не отдаёт ошибку, а молча обновляет 0 строк, если нет доступа/записи.
  if (!data || data.length === 0) {
    // С CAS 0 строк может означать «статус уже изменился» — отличаем от forbidden.
    if (expectedFrom) {
      const { data: cur } = await supabase.from("queue_entries").select("status").eq("id", id).maybeSingle();
      if (cur) {
        if (cur.status === status) return { ok: true }; // кто-то уже применил тот же переход — идемпотентно
        return { ok: false, error: "Стан змінився — оновіть дошку", code: "stale", currentStatus: cur.status as QueueStatus };
      }
    }
    return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  }
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
  status: "done" | "no_show" | "not_held",
  note: string | null
): Promise<QueueActionResult> {
  if (!id || typeof id !== "string") return { ok: false, error: "Невірний ідентифікатор запису", code: "generic" };
  if (status !== "done" && status !== "no_show" && status !== "not_held") return { ok: false, error: "Невідомий статус", code: "generic" };

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

/* ===== Аварійна зупинка (emergency stop) =====
   Блокує один/кілька/усі кабінети до з'ясування обставин: створює інциденти
   reason='emergency' (той самий механізм блокування, що поломка), переводить
   пацієнта «у кабінеті» в not_held, позначає постраждалих ЦЬОГО дня на обдзвон
   (call_status='to_recall'). Подія в n8n пишеться в event_outbox ТРАНЗАКЦІЙНО
   всередині RPC (0055) і доставляється надійно (H-1). «Відновлення» роботи —
   resolveEmergency (знімає всі активні аварійні інциденти). */

export type EmergencyResult =
  | { ok: true; stopped: number; affected: number }
  | { ok: false; error: string; code?: "forbidden" | "auth" | "generic" };

/** Аварійно зупинити роботу обраних кабінетів + обдзвон постраждалих ЦЬОГО дня. */
export async function emergencyStop(input: { roomIds: string[]; note?: string | null; date: string }): Promise<EmergencyResult> {
  const roomIds = Array.from(new Set((input?.roomIds || []).filter(Boolean)));
  if (!roomIds.length) return { ok: false, error: "Не обрано кабінети", code: "generic" };
  if (!input?.date) return { ok: false, error: "Не вказано дату", code: "generic" };

  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Кроки 1–4 (інциденти → обдзвон → not_held → подія в event_outbox)
  // виконуються АТОМАРНО в одній транзакції через RPC emergency_stop_rpc
  // (0054/0055). Ізоляція по клініці — всередині RPC.
  const { data, error } = await supabase.rpc("emergency_stop_rpc", {
    p_room_ids: roomIds,
    p_date: input.date,
    p_note: input.note ?? null,
  });
  if (error) {
    const code = /28000|не авторизовано/i.test(error.message) ? "auth" : "generic";
    return { ok: false, error: error.message, code };
  }
  const res = Array.isArray(data) ? data[0] : data;

  // Негайна best-effort доставка події в n8n. Подія вже durable в event_outbox
  // (записана транзакційно в RPC), тож якщо доставка тут не вдасться —
  // cron-воркер /api/outbox/deliver добере її з ретраями (H-1).
  try { await deliverPendingOutbox(20); } catch { /* backstop — cron */ }

  return { ok: true, stopped: res?.stopped ?? 0, affected: res?.affected ?? 0 };
}

export type ResolveEmergencyResult =
  | { ok: true; resolved: number }
  | { ok: false; error: string; code?: "auth" | "generic" };

/** Відновити роботу: зняти активні аварійні інциденти (усі або обрані кабінети). */
export async function resolveEmergency(input?: { roomIds?: string[] }): Promise<ResolveEmergencyResult> {
  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  let q = supabase.from("incidents")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("clinic_id", clinicId).eq("reason", "emergency").eq("status", "active");
  if (input?.roomIds?.length) q = q.in("room_id", input.roomIds);
  const { data, error } = await q.select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  return { ok: true, resolved: data?.length ?? 0 };
}

// Мягкая пред-проверка пересечения слота (жёсткую гарантию даёт DB-триггер
// check_no_overlap). startMin/endMin — минуты от начала суток.
async function hasSlotClash(
  supabase: SupabaseClient<Database>,
  roomId: string,
  scheduledDate: string,
  startMin: number,
  endMin: number,
  excludeId?: string
): Promise<boolean> {
  const { data } = await supabase
    .from("queue_entries")
    .select("id, scheduled_time, duration_min, buffer_time_min")
    .eq("room_id", roomId)
    .eq("scheduled_date", scheduledDate)
    .neq("status", "cancelled")
    .neq("status", "no_show")
    .neq("status", "not_held");
  return (data || []).some((q) => {
    if (excludeId && q.id === excludeId) return false;
    const [qh, qm] = String(q.scheduled_time || "0:0").split(":").map(Number);
    const qs = (qh || 0) * 60 + (qm || 0);
    // Ефективна зайнятість наявного запису = тривалість + його буфер.
    return qs < endMin && startMin < qs + (q.duration_min || 30) + (q.buffer_time_min ?? BUFFER_DEFAULT);
  });
}

// L-3: здесь текст ОСТАВЛЕН намеренно — «простой» (INCIDENT, триггер 0020) и
// «перекрытие» (OVERLAP, триггер 0014) оба поднимаются с одним SQLSTATE 23P01,
// поэтому различить incident/slot_unavailable можно только по сообщению.
function mapBookingError(message: string): QueueActionResult {
  if (/incident/i.test(message)) return { ok: false, error: message, code: "incident" };
  if (/overlap|exclusion/i.test(message)) return { ok: false, error: message, code: "slot_unavailable" };
  return { ok: false, error: message, code: "generic" };
}

export type ScheduleOverrideInput = {
  overrideDate: string;
  allClosed: boolean;
  label?: string | null;
  rooms?: Record<string, unknown> | null;
};

/** Сохранить особый график на день (upsert) или удалить, если пусто. */
export async function saveScheduleOverride(input: ScheduleOverrideInput): Promise<QueueActionResult> {
  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };
  if (!input?.overrideDate) return { ok: false, error: "Не вказано дату", code: "generic" };

  const rooms = input.rooms || {};
  const empty = !input.allClosed && Object.keys(rooms).length === 0;

  if (empty) {
    const { error } = await supabase
      .from("schedule_overrides")
      .delete()
      .eq("clinic_id", clinicId)
      .eq("override_date", input.overrideDate);
    if (error) return { ok: false, error: error.message, code: "generic" };
    return { ok: true };
  }

  const { error } = await supabase.from("schedule_overrides").upsert(
    {
      clinic_id: clinicId,
      override_date: input.overrideDate,
      all_closed: !!input.allClosed,
      label: input.label || null,
      rooms: rooms as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "clinic_id,override_date" }
  );
  if (error) return { ok: false, error: error.message, code: "generic" };
  return { ok: true };
}

/** Вернуть типовой график на день (удалить override). */
export async function resetScheduleOverride(overrideDate: string): Promise<QueueActionResult> {
  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { error } = await supabase
    .from("schedule_overrides")
    .delete()
    .eq("clinic_id", clinicId)
    .eq("override_date", overrideDate);
  if (error) return { ok: false, error: error.message, code: "generic" };
  return { ok: true };
}

export type RescheduleInput = {
  id: string;
  roomId: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduledAt: string;
  durationMin: number;
  bufferTimeMin?: number; // буфер переноситься разом із записом (за замовч. 5)
  callStatus?: CallStatus; // напр. колл-лист підтверджує слот при переносі
  reason?: string; // причина переносу (обовʼязкова для «не відбулося»/неявки)
};

/** Перенос записи на другой кабинет/дату/время (с пред-проверкой пересечения). */
export async function rescheduleQueueEntry(input: RescheduleInput): Promise<QueueActionResult> {
  if (!input?.id) return { ok: false, error: "Невірний запис", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Не можна переносити дослідження, що ТРИВАЄ (in_progress): спершу його треба
  // «закрити» — завершити або позначити «не відбулося». Захист на сервері (не лише в UI).
  // Заразом читаємо стан ДО переносу для довідки reschedule_origin.
  const { data: cur } = await supabase.from("queue_entries")
    .select("status, scheduled_date, scheduled_time, room_id, clinic_id")
    .eq("id", input.id).maybeSingle();
  if (cur?.status === "in_progress") {
    return { ok: false, error: "Дослідження триває — спершу завершіть його або позначте «не відбулося», а потім переносьте", code: "forbidden" };
  }
  const reason = (input.reason || "").trim();

  const bufferMin = normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT);
  const [hh, mm] = input.scheduledTime.split(":").map(Number);
  const startMin = (hh || 0) * 60 + (mm || 0);
  const endMin = startMin + (input.durationMin || 30) + bufferMin;
  if (await hasSlotClash(supabase, input.roomId, input.scheduledDate, startMin, endMin, input.id)) {
    return { ok: false, error: "Слот зайнятий", code: "slot_taken" };
  }

  const patch: TablesUpdate<"queue_entries"> = {
    room_id: input.roomId,
    scheduled_date: input.scheduledDate,
    scheduled_time: input.scheduledTime,
    scheduled_at: input.scheduledAt,
    duration_min: input.durationMin,
    buffer_time_min: bufferMin,
    status: "scheduled",
  };
  // call_status: направник НЕ має права його чіпати (гард 0048) — для нього
  // колонку не оновлюємо взагалі. Персонал при перенесенні скидає підтвердження
  // дзвінка на "not_called" (новий слот → передзвонити), або передає явне значення.
  if (input.callStatus !== undefined) {
    patch.call_status = input.callStatus;
  } else {
    const { data: prof } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (prof?.role !== "referrer") patch.call_status = "not_called";
  }
  // Довідка «звідки перенесено» — знімок стану до переносу + причина.
  if (cur) {
    patch.reschedule_origin = {
      from_date: cur.scheduled_date, from_time: cur.scheduled_time,
      from_room: cur.room_id, from_clinic: cur.clinic_id, from_status: cur.status,
      reason: reason || null, at: new Date().toISOString(),
    } as unknown as Json;
  }

  const { data, error } = await supabase
    .from("queue_entries")
    .update(patch)
    .eq("id", input.id)
    .select("id");

  if (error) return mapBookingError(error.message);
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Изменить состав исследований записи (+ длительность и флаг контраста). */
export async function editQueueEntryStudies(
  id: string,
  studies: Json,
  durationMin: number,
  bufferTimeMin?: number
): Promise<QueueActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const hasContrast = Array.isArray(studies)
    ? studies.some((s) => typeof s === "object" && s !== null && (s as { contrast?: boolean }).contrast === true)
    : false;

  // Хто редагує склад досліджень: направник → 'referrer', персонал → 'clinic'.
  // Дошки підписують зміну відповідно й синхронізуються realtime.
  const { data: prof } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const changedBy = prof?.role === "referrer" ? "referrer" : "clinic";

  // Буфер оновлюємо лише якщо переданий (редактор досліджень може його змінювати).
  const patch: TablesUpdate<"queue_entries"> = { studies, duration_min: durationMin, has_contrast: hasContrast, studies_changed_by: changedBy };
  if (bufferTimeMin != null) patch.buffer_time_min = normBuffer(bufferTimeMin);

  const { data, error } = await supabase
    .from("queue_entries")
    .update(patch)
    .eq("id", id)
    .select("id");

  // Збільшення тривалості/буфера може перетнути наступний запис — DB-тригер
  // check_no_overlap відхилить; класифікуємо, щоб UI показав локалізовану причину.
  if (error) return mapBookingError(error.message);
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

export type BookingInput = {
  roomId: string;
  referrerId?: string | null;
  name: string;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  sex?: string | null;
  age?: number | null;
  weight?: number | null;
  hasContra?: boolean;
  priorityLevel?: PatientPriority;
  studies: Json;
  doctor?: string | null;
  notes?: string | null;
  durationMin: number;
  bufferTimeMin?: number;
  scheduledDate: string;
  scheduledTime: string;
  scheduledAt: string;
};

/** Создать новую запись (с пред-проверкой пересечения; clinic_id/created_by — с сервера). */
export async function createBooking(input: BookingInput): Promise<QueueActionResult> {
  if (!input?.roomId || !input?.name) return { ok: false, error: "Не вистачає даних запису", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  const bufferMin = normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT);
  const [hh, mm] = input.scheduledTime.split(":").map(Number);
  const startMin = (hh || 0) * 60 + (mm || 0);
  const endMin = startMin + (input.durationMin || 30) + bufferMin;
  if (await hasSlotClash(supabase, input.roomId, input.scheduledDate, startMin, endMin)) {
    return { ok: false, error: "Слот зайнятий", code: "slot_taken" };
  }

  const hasContrast = Array.isArray(input.studies)
    ? input.studies.some((s) => typeof s === "object" && s !== null && (s as { contrast?: boolean }).contrast === true)
    : false;

  const { data: created, error } = await supabase.from("queue_entries").insert({
    clinic_id: clinicId,
    room_id: input.roomId,
    created_by: user.id,
    referrer_id: input.referrerId ?? null,
    patient_name: input.name,
    patient_phone: input.phone || null,
    patient_email: input.email ?? null,
    patient_dob: input.dob || null,
    patient_sex: input.sex || null,
    patient_age: input.age ?? null,
    patient_weight: input.weight ?? null,
    contraindications: !!input.hasContra,
    priority_level: normPriority(input.priorityLevel),
    has_contrast: hasContrast,
    studies: input.studies,
    studies_original: input.studies,
    doctor: input.doctor ?? null,
    note: input.notes ?? null,
    duration_min: input.durationMin,
    buffer_time_min: bufferMin,
    scheduled_date: input.scheduledDate,
    scheduled_time: input.scheduledTime,
    scheduled_at: input.scheduledAt,
    status: "scheduled",
    call_status: "not_called",
  }).select("id").single();

  if (error) return mapBookingError(error.message);
  return { ok: true, id: created?.id };
}

/** Заметка радіолога (radiologist_note). */
export async function setRadiologistNote(id: string, note: string): Promise<QueueActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const { data, error } = await supabase.from("queue_entries").update({ radiologist_note: note }).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Заметка обзвона (call_note). */
export async function setCallNote(id: string, note: string): Promise<QueueActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const { data, error } = await supabase.from("queue_entries").update({ call_note: note }).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Масове підтвердження обзвону (call_status → confirmed) за списком id. RLS обмежує клінікою. */
export async function confirmAllCalls(ids: string[]): Promise<QueueActionResult> {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const { error } = await supabase.from("queue_entries").update({ call_status: "confirmed" }).in("id", ids);
  if (error) return { ok: false, error: error.message, code: "generic" };
  return { ok: true };
}

/** Редагування даних пацієнта (PatientEditModal). patch — підмножина колонок queue_entries. */
export async function updatePatientDetails(id: string, patch: TablesUpdate<"queue_entries">): Promise<QueueActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  // Пріоритет змінюється ЛИШЕ через setQueuePriority (з перевіркою ролі) — прибираємо з generic-патча.
  const { priority_level: _pl, cito: _cito, ...safePatch } = patch;
  const { data, error } = await supabase.from("queue_entries").update(safePatch).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/**
 * Змінити пріоритет пацієнта у вже створеній записі.
 * Дозволено ЛИШЕ: адміністратору клініки АБО направнику-власнику запису
 * (referrer_id = auth.uid()). Реєстратор/радіолог — заборонено (403).
 * Тригер БД синхронізує булевий cito = (priority_level='cito').
 */
export async function setQueuePriority(id: string, priority: PatientPriority): Promise<QueueActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  const level = normPriority(priority);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Хто редагує: роль + чи це власна запис направника.
  const [{ data: profile }, { data: entry }] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    supabase.from("queue_entries").select("referrer_id").eq("id", id).maybeSingle(),
  ]);
  if (!entry) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  const isAdmin = profile?.role === "admin";
  const isOwnerReferrer = entry.referrer_id != null && entry.referrer_id === user.id;
  if (!isAdmin && !isOwnerReferrer) {
    return { ok: false, error: "Змінювати пріоритет може адміністратор або лікар-направник", code: "forbidden" };
  }

  const { data, error } = await supabase
    .from("queue_entries")
    .update({ priority_level: level })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

export type ReferralBookingInput = {
  clinicId: string;
  roomId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  sex?: string | null;
  age?: number | null;
  weight?: number | null;
  hasContra?: boolean;
  priorityLevel?: PatientPriority;
  studies: Json;
  doctorName?: string | null;
  note?: string | null;
  durationMin: number;
  bufferTimeMin?: number;
  scheduledDate: string;
  scheduledTime: string;
  scheduledAt: string;
};

/** Створення направлення направником у обраний центр. Сервер перевіряє активний
    referral_access (referrer_id=user, clinic_id, status=active) і дозволений кабінет. */
export async function createReferralBooking(input: ReferralBookingInput): Promise<QueueActionResult> {
  if (!input?.clinicId || !input?.roomId || !input?.name) return { ok: false, error: "Не вистачає даних направлення", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Перевірка доступу направника до центру і кабінету.
  const { data: access } = await supabase
    .from("referral_access")
    .select("status, room_ids")
    .eq("referrer_id", user.id)
    .eq("clinic_id", input.clinicId)
    .eq("status", "active")
    .maybeSingle();
  if (!access) return { ok: false, error: "Немає активного доступу до центру", code: "forbidden" };
  const roomAllowed = !access.room_ids || access.room_ids.length === 0 || access.room_ids.includes(input.roomId);
  if (!roomAllowed) return { ok: false, error: "Кабінет недоступний для вас", code: "forbidden" };

  const bufferMin = normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT);
  const [hh, mm] = input.scheduledTime.split(":").map(Number);
  const startMin = (hh || 0) * 60 + (mm || 0);
  const endMin = startMin + (input.durationMin || 30) + bufferMin;
  if (await hasSlotClash(supabase, input.roomId, input.scheduledDate, startMin, endMin)) {
    return { ok: false, error: "Слот зайнятий", code: "slot_taken" };
  }

  const hasContrast = Array.isArray(input.studies)
    ? input.studies.some((s) => typeof s === "object" && s !== null && (s as { contrast?: boolean }).contrast === true)
    : false;

  const { data: created, error } = await supabase.from("queue_entries").insert({
    clinic_id: input.clinicId,
    room_id: input.roomId,
    created_by: user.id,
    referrer_id: user.id,
    patient_name: input.name,
    patient_phone: input.phone || null,
    patient_email: input.email ?? null,
    patient_dob: input.dob || null,
    patient_sex: input.sex || null,
    patient_age: input.age ?? null,
    patient_weight: input.weight ?? null,
    contraindications: !!input.hasContra,
    priority_level: normPriority(input.priorityLevel),
    has_contrast: hasContrast,
    studies: input.studies,
    studies_original: input.studies,
    doctor: input.doctorName ?? null,
    note: input.note ?? null,
    indication: input.note ?? null,
    duration_min: input.durationMin,
    buffer_time_min: bufferMin,
    scheduled_date: input.scheduledDate,
    scheduled_time: input.scheduledTime,
    scheduled_at: input.scheduledAt,
    status: "scheduled",
    call_status: "not_called",
  }).select("id").single();

  if (error) return mapBookingError(error.message);
  return { ok: true, id: created?.id };
}
