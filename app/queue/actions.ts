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
import { wallNow, wallInstant, wallDayKey } from "@/lib/incidents";
import { roomScheduleFor, effectiveRoomBreaks, overlapsBreak, type DayOverride } from "@/lib/schedule";

export type QueueActionResult =
  | { ok: true; id?: string } // id — створений запис (createBooking/createReferralBooking)
  | {
      ok: false;
      error: string;
      code?: "room_busy" | "slot_unavailable" | "slot_taken" | "incident" | "forbidden" | "auth" | "duplicate" | "stale" | "past" | "off_schedule" | "generic";
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

/* ===== Заборона слотів у МИНУЛОМУ =====
   Досі «минуле» ловила лише клієнтська сітка (стан "past"), а сервер і БД не
   перевіряли нічого. Дірка: у RescheduleModal дата вводиться звичайним
   <input type="date"> — атрибут min нічого не блокує, — і при даті ≠ сьогодні
   перевірка past взагалі не виконувалась. Тобто перенести (у тому числі
   направником, прямим викликом Server Action) можна було у вчора.

   «Зараз» рахуємо в НАСТІННОМУ часі КЛІНІКИ (clinics.timezone, 0059) — у тому
   самому каноні, що й scheduled_at (0035). Ніколи не по часу сервера.

   Допуск 5 хв: панель колізій та «пізній виклик» законно ставлять запис на
   найближчу пʼятихвилинку від «зараз», і поки запит летить, слот встигає стати
   минулим на секунди. Записів «заднім числом» у продукті немає (постфактум —
   це зміна СТАТУСУ наявного запису), тому в іншому забороняємо жорстко. */
const PAST_TOLERANCE_MIN = 5;

// Санітизація масових операцій: id мають бути UUID, кількість — обмежена
// (інакше один виклик Server Action шле в PostgREST десятки тисяч id).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MASS_UPDATE_CAP = 500;

async function clinicTz(supabase: SupabaseClient<Database>, clinicId: string): Promise<string> {
  const { data } = await supabase.from("clinics").select("timezone").eq("id", clinicId).maybeSingle();
  return data?.timezone || "UTC"; // tz передаємо ЯВНО: на сервері модульний _clinicTz не встановлений
}

/** Слот (дата+час) уже минув за настінним часом клініки? */
async function isPastSlot(
  supabase: SupabaseClient<Database>,
  clinicId: string,
  scheduledDate: string,
  scheduledTime: string
): Promise<boolean> {
  const slotMs = wallInstant(scheduledDate, scheduledTime);
  if (!isFinite(slotMs)) return false; // некоректну дату відсіє БД
  const tz = await clinicTz(supabase, clinicId);
  return slotMs < wallNow(tz) - PAST_TOLERANCE_MIN * 60000;
}

const PAST_ERR = { ok: false as const, error: "Цей час уже минув — оберіть майбутній слот", code: "past" as const };

/* ===== Запис ПОЗА ГРАФІКОМ кабінету =====
   Аудит 2026-07-11: графік кабінету (rooms.schedule: дні тижня + години) не
   застосовувався НІДЕ — сітки жили за хардкодом «Пн–Сб 08:00–18:00». Це
   полагоджено в UI, але сам по собі UI-фікс нічого не гарантує: застаріла
   вкладка або прямий виклик Server Action усе одно запише пацієнта в суботу
   або о 17:30 у кабінет, що працює Пн–Пт до 15:00. Тому перевіряємо на сервері.

   Правила ті самі, що в сітці: пріоритет override на дату → базовий графік
   кабінету; саме ДОСЛІДЖЕННЯ має вміститись до кінця графіка (буфер прибирання
   може виходити за межі — так само, як у computeCallBlock). Перерви кабінету тут
   НЕ перевіряємо (їх тримає клієнт + тригери зайнятості) — свідоме спрощення. */
async function isOutsideRoomSchedule(
  supabase: SupabaseClient<Database>,
  roomId: string,
  clinicId: string,
  scheduledDate: string,
  scheduledTime: string,
  durationMin: number
): Promise<boolean> {
  /* H-6: помилку читання графіка НЕ ковтаємо. Раніше при збої room/override
     ставали null, roomScheduleFor відкочувався на дефолт «Пн–Сб 08:00–18:00»,
     і ГАРД ПРОПУСКАВ запис у кабінет, який насправді зачинений. Кидаємо —
     виклик у write-екшені впаде в generic-помилку, і запис НЕ створиться
     (fail-closed: краще «спробуйте ще раз», ніж пацієнт у зачиненому кабінеті). */
  const { data: room, error: roomErr } = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
  if (roomErr) throw roomErr;
  const { data: ov, error: ovErr } = await supabase
    .from("schedule_overrides").select("all_closed, label, rooms")
    .eq("clinic_id", clinicId).eq("override_date", scheduledDate).maybeSingle();
  if (ovErr) throw ovErr;

  const day = new Date(scheduledDate + "T00:00:00");
  if (isNaN(day.getTime())) return false;
  const sched = roomScheduleFor(day, roomId, (ov as unknown as DayOverride) || null, room?.schedule ?? null);
  if (sched.closed) return true;

  const toMin = (t: string) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const start = toMin(scheduledTime);
  const end = start + (durationMin || 30);
  return start < toMin(sched.start) || end > toMin(sched.end);
}

const OFF_SCHED_ERR = {
  ok: false as const,
  error: "Кабінет не працює в цей час — оберіть слот у межах графіка",
  code: "off_schedule" as const,
};

// H-6, fail-closed: не змогли прочитати графік → НЕ пускаємо запис (раніше гард
// мовчки відкочувався на дефолт 08:00–18:00 і пропускав бронь у зачинений кабінет).
const SCHED_READ_ERR = {
  ok: false as const,
  error: "Не вдалося перевірити графік кабінету — спробуйте ще раз",
  code: "generic" as const,
};

/** Гард графіка для write-шляхів: null = можна писати, інакше — готова відповідь клієнту. */
async function scheduleBlock(
  supabase: SupabaseClient<Database>,
  roomId: string,
  clinicId: string,
  scheduledDate: string,
  scheduledTime: string,
  durationMin: number
): Promise<QueueActionResult | null> {
  try {
    if (await isOutsideRoomSchedule(supabase, roomId, clinicId, scheduledDate, scheduledTime, durationMin)) {
      return OFF_SCHED_ERR;
    }
    return null;
  } catch {
    return SCHED_READ_ERR;
  }
}

/** Чи перетинає дослідження [time, +dur) перерву кабінету на цю дату. */
async function crossesRoomBreak(
  supabase: SupabaseClient<Database>,
  roomId: string,
  clinicId: string,
  scheduledDate: string,
  scheduledTime: string,
  durationMin: number
): Promise<boolean> {
  // H-6: те саме — збій читання не має виглядати як «перерв немає» (див. isOutsideRoomSchedule).
  const { data: room, error: roomErr } = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
  if (roomErr) throw roomErr;
  const { data: ov, error: ovErr } = await supabase
    .from("schedule_overrides").select("all_closed, label, rooms")
    .eq("clinic_id", clinicId).eq("override_date", scheduledDate).maybeSingle();
  if (ovErr) throw ovErr;
  const day = new Date(scheduledDate + "T00:00:00");
  if (isNaN(day.getTime())) return false;
  const breaks = effectiveRoomBreaks(day, roomId, room?.schedule ?? null, (ov as unknown as DayOverride) || null);
  if (!breaks.length) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  return overlapsBreak((h || 0) * 60 + (m || 0), durationMin || 30, breaks);
}

/* Клінічні тривалості — кратні 5 хв; стеля 600 хв (10 год) відсікає абсурд і
   «розтягування» запису на весь день. Раніше editQueueEntryStudies приймав
   БУДЬ-ЯКЕ число: дослідження можна було витягнути за кінець графіка і в перерву
   (ловив лише тригер перетину з іншим записом, та й той рахує без буфера). */
const DUR_MAX_MIN = 600;

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

/* ===== CAS для решти мутацій (аудит 2026-07-12, H-4) =====
   setQueueEntryStatus уже має CAS по expectedFrom, а решта мутацій писала
   .eq("id", id) без огляду на поточний стан → last-write-wins:
     • «Перенести» зі старої вкладки ВОСКРЕШАЛА завершений запис (патч містить
       status:'scheduled') і везла його на новий слот — факт виконання стирався;
     • «✕ Відмова» в колл-листі скасовувала пацієнта, який УЖЕ в кабінеті;
     • «Виконано» проставлялось запису, який колега встиг скасувати.
   Рішення: дозволені вихідні статуси в самому UPDATE (.in("status", …)).
   0 рядків → дивимось реальний стан: той самий цільовий → ідемпотентно ok,
   інший → code='stale' (дошки вже вміють його показувати і робити reload). */
const LIVE_STATUSES: readonly QueueStatus[] = ["scheduled", "waiting", "in_progress"];
/* Перенести можна і «не відбулося»/«неявку»/«скасовано» — це штатний «Перезапис»
   з панелі скасованих (QueueBoard/CancelledPanel), і навіть in_progress (свідоме
   рішення: дослідження зупиняється, кабінет звільняється — див. коментар у
   rescheduleQueueEntry). НЕ можна — тільки ЗАВЕРШЕНИЙ (done): саме там патч
   status:'scheduled' воскрешав запис і стирав факт виконання (і «Дохід» CEO). */
const RESCHEDULABLE_STATUSES: readonly QueueStatus[] = [
  "scheduled", "waiting", "in_progress", "no_show", "not_held", "cancelled",
];

const STALE_ERR = "Стан змінився — оновіть дошку";

/** 0 рядків після CAS-UPDATE: розрізняємо «стан змінився», «вже так само» і «немає доступу». */
async function casMiss(
  supabase: SupabaseClient<Database>,
  id: string,
  sameAs?: QueueStatus
): Promise<QueueActionResult> {
  const { data: cur } = await supabase.from("queue_entries").select("status").eq("id", id).maybeSingle();
  if (!cur) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  const current = cur.status as QueueStatus;
  if (sameAs && current === sameAs) return { ok: true }; // хтось уже застосував той самий перехід
  return { ok: false, error: STALE_ERR, code: "stale", currentStatus: current };
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

  // CAS: скасувати можна лише живий запис (не завершений/не скасований).
  const { data, error } = await supabase
    .from("queue_entries")
    .update({ status: "cancelled" })
    .eq("id", id)
    .in("status", LIVE_STATUSES as unknown as QueueStatus[])
    .select("id");

  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return casMiss(supabase, id, "cancelled");
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

  // CAS: підсумок ставимо лише живому запису — не «дозавершуємо» скасований.
  const { data, error } = await supabase
    .from("queue_entries")
    .update({ status, note })
    .eq("id", id)
    .in("status", LIVE_STATUSES as unknown as QueueStatus[])
    .select("id");

  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return casMiss(supabase, id, status);
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

  /* CAS. «Відмова» СКАСОВУЄ запис, тому дозволена лише до приходу пацієнта:
     оператор колл-листа зі старим списком не має скасувати того, хто вже
     в кабінеті. Решта статусів обдзвону — на будь-якому живому записі. */
  const allowedFrom: readonly QueueStatus[] =
    callStatus === "declined" ? (["scheduled", "waiting"] as const) : LIVE_STATUSES;

  const { data, error } = await supabase
    .from("queue_entries")
    .update(patch)
    .eq("id", id)
    .in("status", allowedFrom as unknown as QueueStatus[])
    .select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) {
    /* Ідемпотентність — по call_status, а не по status: інакше «✕ Відмова» на
       записі, який щойно скасували ЗВИЧАЙНИМ «Скасувати», повертала б ok, і UI
       казав би «Пацієнт відмовився» + пропонував кандидатів на вже вільний слот. */
    const { data: cur } = await supabase.from("queue_entries").select("status, call_status").eq("id", id).maybeSingle();
    if (!cur) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
    if (cur.call_status === callStatus) return { ok: true }; // той самий перехід уже застосовано
    return { ok: false, error: STALE_ERR, code: "stale", currentStatus: cur.status as QueueStatus };
  }
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

  /* Час інцидентів — «настінний UTC» (той самий канон, що scheduled_at, 0035):
     BreakdownModal кодує 19:01 як 19:01Z. Порівнювати його з Date.now() (РЕАЛЬНИЙ
     інстант, 16:01Z для Києва) не можна: поломка, заведена ЗАРАЗ, ставала 'planned'
     на +offset годин. Наслідки були реальні: unique-індекс «один активний інцидент
     на кабінет» (0017) її не покривав, а emergency_stop_rpc не бачив і створював
     ДРУГИЙ інцидент на той самий кабінет. Порівнюємо в одному фреймі. */
  const startMs = new Date(input.startedAt).getTime();
  const nowWall = wallNow(await clinicTz(supabase, clinicId));
  const status: "planned" | "active" = startMs > nowWall ? "planned" : "active";
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
   resolveEmergency (знімає аварійні інциденти ОБРАНИХ кабінетів).

   «Цей день» рахує СЕРВЕР у настінному часі клініки (wallDayKey(clinics.timezone)).
   Раніше дату передавав клієнт як dateKey(new Date()) — день БРАУЗЕРА оператора:
   біля півночі / в іншій зоні на обдзвон потрапляли пацієнти не того дня. */

export type EmergencyResult =
  | { ok: true; stopped: number; affected: number }
  | { ok: false; error: string; code?: "forbidden" | "auth" | "generic" };

/** Аварійно зупинити роботу обраних кабінетів + обдзвон постраждалих ЦЬОГО дня. */
export async function emergencyStop(input: { roomIds: string[]; note?: string | null }): Promise<EmergencyResult> {
  const roomIds = Array.from(new Set((input?.roomIds || []).filter(Boolean)));
  if (!roomIds.length) return { ok: false, error: "Не обрано кабінети", code: "generic" };

  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Дата — НЕ з клієнта: настінний «сьогодні» клініки (0059).
  const date = wallDayKey(await clinicTz(supabase, clinicId));

  // Кроки 1–4 (інциденти → обдзвон → not_held → подія в event_outbox)
  // виконуються АТОМАРНО в одній транзакції через RPC emergency_stop_rpc
  // (0054/0055). Ізоляція по клініці — всередині RPC.
  const { data, error } = await supabase.rpc("emergency_stop_rpc", {
    p_room_ids: roomIds,
    p_date: date,
    p_note: input.note ?? null,
  });
  if (error) {
    const code = /28000|не авторизовано/i.test(error.message) ? "auth" : "generic";
    return { ok: false, error: error.message, code };
  }
  const res = Array.isArray(data) ? data[0] : data;

  // Негайна best-effort доставка події в n8n — НЕ awaited. Подія вже durable в
  // event_outbox (записана транзакційно в RPC), а оператор в аварії не має чекати
  // на повільний n8n: раніше `await` на 20 подій без таймауту міг вибити функцію
  // по maxDuration і показати ПОМИЛКУ на вже закомічену зупинку.
  // Недоставлене добере cron-воркер /api/outbox/deliver з backoff (0064).
  void deliverPendingOutbox(3).catch(() => { /* backstop — cron */ });

  return { ok: true, stopped: res?.stopped ?? 0, affected: res?.affected ?? 0 };
}

export type ResolveEmergencyResult =
  | { ok: true; resolved: number }
  | { ok: false; error: string; code?: "auth" | "generic" };

/** Відновити роботу ОБРАНИХ кабінетів: зняти їхні активні аварійні інциденти.
    roomIds обовʼязковий: раніше порожній виклик знімав аварію з УСІХ кабінетів
    клініки (кнопка «▶ Відновити роботу» в модалці саме так і викликалась —
    відновлювала все, хоча в списку були конкретні кабінети). */
export async function resolveEmergency(input: { roomIds: string[] }): Promise<ResolveEmergencyResult> {
  const roomIds = Array.from(new Set((input?.roomIds || []).filter(Boolean)));
  if (!roomIds.length) return { ok: false, error: "Не обрано кабінети", code: "generic" };

  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data, error } = await supabase.from("incidents")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("clinic_id", clinicId).eq("reason", "emergency").eq("status", "active")
    .in("room_id", roomIds)
    .select("id");
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
  // PAST_SLOT — тригер 0063 (останній рубіж; серверна перевірка стоїть вище).
  if (/PAST_SLOT/i.test(message)) return PAST_ERR;
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

  // Стан ДО переносу — для довідки reschedule_origin. Перенос дослідження, що
  // ТРИВАЄ (in_progress), дозволено: воно зупиняється (status → scheduled),
  // кабінет одразу звільняється, а запис переноситься на новий слот (та сама
  // запис, не копія) з поміткою про перенос (from_status='in_progress').
  const { data: cur } = await supabase.from("queue_entries")
    .select("status, scheduled_date, scheduled_time, room_id, clinic_id")
    .eq("id", input.id).maybeSingle();
  const reason = (input.reason || "").trim();

  /* Перенести в МИНУЛЕ не можна — жодною роллю. Клієнтський гейт тут не працював
     (isToday=false → перевірка "past" пропускалась), тому це і є основна діра. */
  if (cur?.clinic_id && await isPastSlot(supabase, cur.clinic_id, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  if (cur?.clinic_id) {
    const blocked = await scheduleBlock(supabase, input.roomId, cur.clinic_id, input.scheduledDate, input.scheduledTime, input.durationMin);
    if (blocked) return blocked;
  }

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
    // Перенос = свіжий слот: скидаємо фактичний старт (важливо, якщо переносимо
    // in_progress — щоб запис не «займав» кабінет за старим in_progress_at).
    in_progress_at: null,
    /* …і мітку «⚠ Уточнити» (0058). Її ставить RPC sink_overdue_scheduled
       прострочениим записам, і саме за нею дошка ОПУСКАЄ запис униз черги
       (clarifyRank у сортуванні). Без цього скидання перенесений у майбутнє
       пацієнт лишався з міткою і на старій позиції — «переніс, а він не
       перемістився». Якщо новий слот теж прострочений, RPC позначить знову. */
    clarify_at: null,
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

  // CAS: не воскрешаємо завершений/скасований запис (патч містить status:'scheduled').
  const { data, error } = await supabase
    .from("queue_entries")
    .update(patch)
    .eq("id", input.id)
    .in("status", RESCHEDULABLE_STATUSES as unknown as QueueStatus[])
    .select("id");

  if (error) return mapBookingError(error.message);
  if (!data || data.length === 0) return casMiss(supabase, input.id);
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

  /* Валідація тривалості НА СЕРВЕРІ (аудит 2026-07-11). Клієнт обмежує повзунок
     графіком/перервою/наступним записом, але сам по собі клієнт нічого не гарантує:
     застаріла вкладка чи прямий виклик Server Action розтягували дослідження за
     кінець робочого дня або крізь перерву. Перетин з іншим записом ловить тригер
     check_no_overlap; графік і перерви — ось тут. */
  const dur = Math.round(Number(durationMin));
  if (!Number.isFinite(dur) || dur <= 0 || dur > DUR_MAX_MIN || dur % 5 !== 0) {
    return { ok: false, error: "Некоректна тривалість дослідження", code: "generic" };
  }

  const { data: cur } = await supabase.from("queue_entries")
    .select("clinic_id, room_id, scheduled_date, scheduled_time, status")
    .eq("id", id).maybeSingle();
  if (!cur) return { ok: false, error: "Запис не знайдено", code: "forbidden" };

  const active = cur.status === "scheduled" || cur.status === "waiting" || cur.status === "in_progress";
  if (active && cur.room_id && cur.clinic_id && cur.scheduled_date && cur.scheduled_time) {
    try {
      if (await isOutsideRoomSchedule(supabase, cur.room_id, cur.clinic_id, cur.scheduled_date, cur.scheduled_time, dur)) {
        return { ok: false, error: "Дослідження не вміщується до кінця графіка кабінету", code: "off_schedule" };
      }
      if (await crossesRoomBreak(supabase, cur.room_id, cur.clinic_id, cur.scheduled_date, cur.scheduled_time, dur)) {
        return { ok: false, error: "Дослідження перетинає перерву в роботі кабінету", code: "off_schedule" };
      }
    } catch {
      return SCHED_READ_ERR;   // fail-closed: не змогли перевірити графік — не подовжуємо дослідження
    }
  }

  const hasContrast = Array.isArray(studies)
    ? studies.some((s) => typeof s === "object" && s !== null && (s as { contrast?: boolean }).contrast === true)
    : false;

  // Хто редагує склад досліджень: направник → 'referrer', персонал → 'clinic'.
  // Дошки підписують зміну відповідно й синхронізуються realtime.
  const { data: prof } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const changedBy = prof?.role === "referrer" ? "referrer" : "clinic";

  // Буфер оновлюємо лише якщо переданий (редактор досліджень може його змінювати).
  const patch: TablesUpdate<"queue_entries"> = { studies, duration_min: dur, has_contrast: hasContrast, studies_changed_by: changedBy };
  if (bufferTimeMin != null) patch.buffer_time_min = normBuffer(bufferTimeMin);

  // CAS: склад досліджень міняємо лише живому запису — не редагуємо завершений
  // (це змінило б «Дохід» CEO) і не воскрешаємо скасований.
  const { data, error } = await supabase
    .from("queue_entries")
    .update(patch)
    .eq("id", id)
    .in("status", LIVE_STATUSES as unknown as QueueStatus[])
    .select("id");

  // Збільшення тривалості/буфера може перетнути наступний запис — DB-тригер
  // check_no_overlap відхилить; класифікуємо, щоб UI показав локалізовану причину.
  if (error) return mapBookingError(error.message);
  if (!data || data.length === 0) return casMiss(supabase, id);
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

  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  {
    const blocked = await scheduleBlock(supabase, input.roomId, clinicId, input.scheduledDate, input.scheduledTime, input.durationMin);
    if (blocked) return blocked;
  }

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

export type ConfirmAllResult =
  | { ok: true; updated: number }
  | { ok: false; error: string; code?: "auth" | "generic" };

/** Масове підтвердження обзвону (call_status → confirmed) за списком id. RLS обмежує клінікою.
    Повертає КІЛЬКІСТЬ реально оновлених рядків: раніше дія рапортувала «усіх
    підтверджено» навіть коли RLS не оновила жодного рядка. */
export async function confirmAllCalls(ids: string[]): Promise<ConfirmAllResult> {
  const list = Array.from(new Set((Array.isArray(ids) ? ids : []).filter((v) => typeof v === "string" && UUID_RE.test(v))));
  if (!list.length) return { ok: true, updated: 0 };
  if (list.length > MASS_UPDATE_CAP) return { ok: false, error: "Забагато записів за один раз", code: "generic" };
  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };
  // clinic_id — defense-in-depth поверх RLS (єдиною лінією оборони бути не повинна).
  // CAS: підтверджуємо лише живі записи — ids приходять із (можливо застарілого)
  // відфільтрованого списку, і 'confirmed' не має лягати на щойно скасований запис.
  // Розбіжність оператор побачить: updated < очікуваного.
  const { data, error } = await supabase.from("queue_entries")
    .update({ call_status: "confirmed" })
    .eq("clinic_id", clinicId)
    .in("id", list)
    .in("status", LIVE_STATUSES as unknown as QueueStatus[])
    .select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  return { ok: true, updated: data?.length ?? 0 };
}

/* Колонки, які РЕАЛЬНО редагує PatientEditModal. Типи TS не захищають Server Action
   від довільного JSON: раніше сюди приймався весь TablesUpdate<"queue_entries">, і
   через нього з клієнта (або протухлої вкладки) проходили status, scheduled_date/time,
   room_id, in_progress_at, call_status — тобто завершений запис можна було воскресити
   в обхід усіх CAS-гардів. Той самий підхід, що WAITLIST_PATCH_ALLOWED у листі очікування. */
const PATIENT_PATCH_ALLOWED = [
  "patient_name", "patient_phone", "patient_email", "patient_dob", "patient_age",
  "patient_sex", "patient_weight", "contraindications", "note", "doctor", "referrer_id",
] as const;

/** Редагування даних пацієнта (PatientEditModal). patch — тільки allowlist колонок. */
export async function updatePatientDetails(id: string, patch: TablesUpdate<"queue_entries">): Promise<QueueActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Пріоритет — ЛИШЕ через setQueuePriority (там перевірка ролі); решта — за allowlist.
  const safePatch: TablesUpdate<"queue_entries"> = {};
  for (const col of PATIENT_PATCH_ALLOWED) {
    if (patch[col] !== undefined) (safePatch as Record<string, unknown>)[col] = patch[col];
  }
  if (Object.keys(safePatch).length === 0) return { ok: true };

  /* CAS тут НЕ ставимо свідомо: ПІБ/телефон правлять і в завершеному записі
     (клік по імені відкриває редактор у будь-якому рядку дошки), а статус ці
     колонки не чіпають — воскресити запис ними неможливо (за це відповідає allowlist). */
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

  if (await isPastSlot(supabase, input.clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  {
    const blocked = await scheduleBlock(supabase, input.roomId, input.clinicId, input.scheduledDate, input.scheduledTime, input.durationMin);
    if (blocked) return blocked;
  }

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
