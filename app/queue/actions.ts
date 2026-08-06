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

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, QueueStatus, CallStatus, TablesUpdate, QueueDelayPolicy } from "@/supabase/types";
import { BUFFER_DEFAULT, normBuffer, normDur, DUR_MAX, studiesMatchModality } from "@/lib/studies";
import { firstClosedService, loadClinicCatalog, studiesKeySet, CatalogUnavailableError } from "@/lib/serviceGate";
import { firstClosedStudy, type Catalog } from "@/lib/catalog";
import { normPriority, type PatientPriority } from "@/lib/priority";
import { deliverPendingOutbox } from "@/lib/outbox";
import { wallNow, wallInstant, wallDayKey, wallInstantOf, wallMinOfDay, wallMinOfInstant } from "@/lib/incidents";
import {
  roomScheduleFor, effectiveRoomBreaks, offScheduleKind, OFF_SCHED_GRACE_MIN,
  type DayOverride, type OffScheduleInfo, type Break, type EffectiveRoomSchedule,
} from "@/lib/schedule";
import { slotToMin, type BusySpan } from "@/lib/slots";
import {
  actualFreeAtMin, delayTriggers, buildCascadePlan, buildConflictPlan,
  type DelayEntry, type DelayPlan,
} from "@/lib/delayPlan";
import {
  parseInput, safeDbError, zUuid, zDateKey, zTime, zSlotTime, zIsoInstant, zName, zOptText, zOptEmail,
  zOptDob, zOptAge, zOptWeight, PATIENT_AGE_MAX, PATIENT_WEIGHT_MAX,
  zDuration, zBuffer, zPriority, zQueueStatus, zCallStatus, zStudiesRequired, zIdList,
  zQueueDelayPolicy, zOverlapThreshold, zMaxCascade, zQueueStatusAny,
} from "@/lib/validation";
/* 0128 — журнал важливих подій: емісія СТРОГО ПІСЛЯ успіху бізнес-операції,
   fail-OPEN (emitImportantEvent ніколи не кидає). details — БЕЗ PII: лише id,
   дати/часи, статуси, лічильники; changedFields — лише НАЗВИ колонок. */
import { queueEventTypeFor, caseEventTypeFor, changedFieldsOf } from "@/lib/importantEvents";
import { emitImportantEvent } from "@/lib/importantEvents.server";
import { logError } from "@/lib/serverLog";

export type QueueActionResult =
  | { ok: true; id?: string } // id — створений запис (createBooking/createReferralBooking)
  | {
      ok: false;
      error: string;
      code?: "room_busy" | "slot_unavailable" | "slot_taken" | "incident" | "forbidden" | "auth" | "duplicate" | "stale" | "past" | "off_schedule" | "modality_mismatch" | "generic";
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

/* ===== Схеми входу (M-12) =====
   Раніше кожна дія «валідувала» вручну: !id, typeof x === "string", Number(dur).
   Типи TS на межі Server Action НЕ гарантують нічого — клієнт, протухла вкладка
   або прямий виклик шлють що завгодно (саме так через updatePatientDetails
   проходили status / room_id / scheduled_at). Тепер вхід кожної дії має схему;
   деталі помилки — в лог сервера, користувачу — загальне повідомлення.
   Примітиви (UUID, "HH:MM", "YYYY-MM-DD", тривалість, буфер) — lib/validation.ts. */

const sStudies = zStudiesRequired;

/** Спільні поля пацієнта для бронювання (адмін і направник). */
const sPatientFields = {
  name: zName,
  phone: zOptText(32),
  email: zOptEmail,
  dob: zOptDob,        // та сама строгість, що й у патчі: інакше запис зі сміттям у ДР не редагується
  sex: zOptText(16),
  age: zOptAge,
  weight: zOptWeight,
  hasContra: z.boolean().optional(),
  priorityLevel: zPriority.optional(),
  studies: sStudies,
  durationMin: zDuration,
  bufferTimeMin: zBuffer.optional(),
  scheduledDate: zDateKey,
  // Слот запису — на сітці 5 хв (zSlotTime, техаудит High-1): '09:03' повз UI
  // створював би запис, невидимий у сітці SlotPicker. Дзеркало в БД — 0125.
  scheduledTime: zSlotTime,
  scheduledAt: zIsoInstant,
};

const sBooking = z.object({
  roomId: zUuid,
  referrerId: zUuid.nullish(),
  doctor: zOptText(200),
  notes: zOptText(2000),
  // 0077: оператор підтвердив роботу поза графіком (після закриття / у перерву).
  // Сам по собі прапорець нічого не відкриває — див. scheduleBlock().
  offSchedule: z.boolean().optional(),
  ...sPatientFields,
});

const sReferralBooking = z.object({
  clinicId: zUuid,
  roomId: zUuid,
  doctorName: zOptText(200),
  note: zOptText(2000),
  ...sPatientFields,
});

const sReschedule = z.object({
  id: zUuid,
  roomId: zUuid,
  scheduledDate: zDateKey,
  scheduledTime: zSlotTime,   // сітка 5 хв — як у створенні (техаудит High-1)
  scheduledAt: zIsoInstant,
  durationMin: zDuration,
  bufferTimeMin: zBuffer.optional(),
  callStatus: zCallStatus.optional(),
  reason: zOptText(500),
  offSchedule: z.boolean().optional(),   // 0077 — див. scheduleBlock()
  /* 0122: НОВИЙ склад досліджень — коли переносимо в кабінет з ІНШИМ прайсом
     (0121) і позиції довелось перепризначити на каталог цільового кабінету.
     Не передано → склад лишається як був (канон 0070). */
  studies: sStudies.optional(),
});

const sIncident = z.object({
  id: zUuid.nullish(),
  roomId: zUuid,
  reason: z.enum(["breakdown", "maintenance", "emergency"]),   // = CHECK incidents_reason_chk (0056)
  reasonLabel: zOptText(200),
  note: zOptText(2000),
  startedAt: zIsoInstant,
  blockedUntil: z.union([zIsoInstant, z.null(), z.undefined()]).transform((v) => v ?? null),
  autoUnblock: z.boolean().optional(),
});

const sRoomIdList = z.object({
  roomIds: z.array(zUuid).min(1, "Не обрано кабінети").max(100).transform((v) => Array.from(new Set(v))),
  note: zOptText(2000).optional(),
});

/* Особливий графік дня. Раніше rooms був `Record<string, unknown>` і летів у JSONB
   як є: невалідні години («18:00–08:00», «25:70») зберігались, а сітка слотів
   мовчки зникала. Тепер — формат HH:MM і start < end (і для годин, і для перерв). */
const sHours = z
  .object({ start: zTime, end: zTime })
  .refine((v) => v.start < v.end, "Кінець має бути пізніше за початок");
const sRoomOverride = z
  .object({
    closed: z.boolean().optional(),
    start: zTime.optional(),
    end: zTime.optional(),
    breaks: z.array(sHours).max(10).optional(),
  })
  .refine((v) => !(v.start && v.end) || v.start < v.end, "Кінець роботи має бути пізніше за початок");
const sScheduleOverride = z.object({
  overrideDate: zDateKey,
  allClosed: z.boolean(),
  label: zOptText(200),
  rooms: z.record(zUuid, sRoomOverride).nullish(),
});

async function clinicTz(supabase: SupabaseClient<Database>, clinicId: string): Promise<string> {
  const { data } = await supabase.from("clinics").select("timezone").eq("id", clinicId).maybeSingle();
  return data?.timezone || "UTC"; // tz передаємо ЯВНО: на сервері модульний _clinicTz не встановлений
}

/* ===== 0078 — політика черги при затримці дослідження =====
   Налаштовує ТІЛЬКИ адмін свого центру. Три рубежі, і жоден не зайвий:
     1) цей екшен (роль читаємо з profiles на СЕРВЕРІ, не з клієнта);
     2) RLS clinics_update (0073) — вимагає auth_is_admin();
     3) CHECK-констрейнти clinics_*_chk — на випадок прямого API-виклику.
   Схеми zod дають користувачу помилку В ПОЛІ, а не сирий 23514 з БД. */
const sQueuePolicy = z.object({
  policy: zQueueDelayPolicy,
  overlapThresholdMin: zOverlapThreshold,
  maxCascadePatients: zMaxCascade,
  allowAfterHoursShift: z.boolean(),
});

export type QueuePolicyResult =
  | { ok: true }
  | { ok: false; error: string; code?: "auth" | "forbidden" | "generic" };

export async function saveQueueDelayPolicy(raw: {
  policy: QueueDelayPolicy;
  overlapThresholdMin: number;
  maxCascadePatients: number;
  allowAfterHoursShift: boolean;
}): Promise<QueuePolicyResult> {
  const v = parseInput("saveQueueDelayPolicy", sQueuePolicy, raw);
  if (!v.ok) return v;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Роль і клініку беремо з БД, а не з клієнта: інакше «адмін» — це просто поле в запиті.
  const { data: prof } = await supabase.from("profiles").select("role, clinic_id").eq("id", user.id).maybeSingle();
  if (!prof?.clinic_id || prof.role !== "admin") {
    return { ok: false, error: "Політику черги налаштовує лише адміністратор центру", code: "forbidden" };
  }

  /* .select("id") — НЕ косметика. PostgREST на відхиленому RLS UPDATE повертає
     error = null і НУЛЬ рядків: без перевірки користувач побачив би «Політику
     збережено», хоча в БД нічого не змінилось. Це рівно той клас fail-open,
     який проект уже ловив (H-6, «помилка ≠ пусто»). */
  const { data: upd, error } = await supabase.from("clinics").update({
    queue_delay_policy: v.data.policy,
    overlap_threshold_min: v.data.overlapThresholdMin,
    max_cascade_patients: v.data.maxCascadePatients,
    allow_after_hours_shift: v.data.allowAfterHoursShift,
  }).eq("id", prof.clinic_id).select("id");

  if (error) return { ok: false, error: safeDbError("saveQueueDelayPolicy", error), code: "generic" };
  if (!upd?.length) return { ok: false, error: "Не вдалося зберегти політику — немає прав", code: "forbidden" };
  return { ok: true };
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

   0077 — графік став ПЛАНОМ, а не стіною. Класифікацію «наскільки саме поза
   графіком» тримає ЧИСТА функція offScheduleKind() (lib/schedule.ts) — та сама,
   якою сітка фарбує слоти. Тут — лише авторизація й політика:

     confirmable = false (closed / before_start / too_late) → відмова ЗАВЖДИ;
     confirmable = true  (after_end / break) → потрібні ДВІ умови разом:
        • викликає ПЕРСОНАЛ центру (не направник, не CEO), і
        • прийшов явний прапорець offSchedule (оператор підтвердив у діалозі).

   Прапорець без персоналу — не працює; персонал без прапорця — не працює.
   У БД друга лінія: trg_c_guard_off_schedule (0077) не дасть глобальному
   акаунту поставити off_schedule навіть прямим викликом PostgREST, а
   check_not_during_break пускає в перерву лише рядки з прапорцем.

   ⚠️ Графік (години/дні) у БД НЕ enforce'иться взагалі — ні до 0077, ні після.
   Для випадку «після кінця дня» цей серверний гард — ЄДИНИЙ рубіж, а колонка
   off_schedule там лише мітка (бейдж + audit_log). Для ПЕРЕРВИ рубежів два. */

/** Класифікація слота відносно графіка кабінету. Кидає при збої читання (H-6). */
async function scheduleGate(
  supabase: SupabaseClient<Database>,
  roomId: string,
  clinicId: string,
  scheduledDate: string,
  scheduledTime: string,
  durationMin: number
): Promise<OffScheduleInfo | null> {
  /* H-6: помилку читання графіка НЕ ковтаємо. Раніше при збої room/override
     ставали null, roomScheduleFor відкочувався на дефолт «Пн–Сб 08:00–18:00»,
     і ГАРД ПРОПУСКАВ запис у кабінет, який насправді зачинений. Кидаємо —
     виклик у write-екшені впаде в SCHED_READ_ERR, і запис НЕ створиться
     (fail-closed: краще «спробуйте ще раз», ніж пацієнт у зачиненому кабінеті). */
  const { data: room, error: roomErr } = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
  if (roomErr) throw roomErr;
  const { data: ov, error: ovErr } = await supabase
    .from("schedule_overrides").select("all_closed, label, rooms")
    .eq("clinic_id", clinicId).eq("override_date", scheduledDate).maybeSingle();
  if (ovErr) throw ovErr;

  const day = new Date(scheduledDate + "T00:00:00");
  if (isNaN(day.getTime())) return null;
  const override = (ov as unknown as DayOverride) || null;
  const sched = roomScheduleFor(day, roomId, override, room?.schedule ?? null);
  const breaks = effectiveRoomBreaks(day, roomId, room?.schedule ?? null, override);
  const [h, m] = String(scheduledTime).split(":").map(Number);
  return offScheduleKind((h || 0) * 60 + (m || 0), durationMin || 30, sched, breaks);
}

const OFF_SCHED_ERR = {
  ok: false as const,
  error: "Кабінет не працює в цей час — оберіть слот у межах графіка",
  code: "off_schedule" as const,
};

/* Мапінг сирої помилки тригера check_not_during_break (0067). Лишається і після
   0077: тригер тепер пускає рядки з off_schedule, але без прапорця (направник,
   застаріла вкладка, прямий виклик) він так само кидає BREAK. */
const BREAK_ERR = {
  ok: false as const,
  error: "Дослідження перетинає перерву в роботі кабінету — оберіть інший слот",
  code: "off_schedule" as const,
};

/* Мапінг гардів КАБІНЕТУ — останній рубіж у БД: графік check_room_schedule (0084)
   і вимкнення check_room_active (0123). Нормальний шлях відхиляє scheduleBlock /
   не пропонує вимкнений кабінет раніше; сюди доходить прямий виклик або
   розсинхрон (графік змінили між preview і apply плану затримки; кабінет вимкнули,
   поки модалка була відкрита). Коди тригерів — префікси повідомлень; сирий текст
   користувачу не показуємо. */
function schedTriggerError(message: string): QueueActionResult | null {
  /* 0123. Код НЕ slot_unavailable свідомо: дошки підміняють його своїм «слот щойно
     зайняли», і причина «кабінет вимкнено» загубилась би. */
  if (/^ROOM_INACTIVE/.test(message)) {
    return { ok: false, error: "Кабінет вимкнено — записувати в нього не можна. Оберіть інший кабінет", code: "forbidden" };
  }
  if (/^ROOM_CLOSED/.test(message)) return { ok: false, error: "Кабінет не працює цього дня — оберіть іншу дату", code: "off_schedule" };
  if (/^BEFORE_OPEN/.test(message)) return { ok: false, error: "Кабінет ще не відкрито в цей час — оберіть слот у межах графіка", code: "off_schedule" };
  if (/^TOO_LATE/.test(message))    return { ok: false, error: "Занадто пізно — за межами дозволеного вікна роботи кабінету", code: "off_schedule" };
  if (/^OFF_SCHEDULE/.test(message)) return { ok: false, error: "Робота після закриття кабінету потребує підтвердження", code: "off_schedule" };
  return null;
}

// H-6, fail-closed: не змогли прочитати графік → НЕ пускаємо запис (раніше гард
// мовчки відкочувався на дефолт 08:00–18:00 і пропускав бронь у зачинений кабінет).
const SCHED_READ_ERR = {
  ok: false as const,
  error: "Не вдалося перевірити графік кабінету — спробуйте ще раз",
  code: "generic" as const,
};

/* Повідомлення про ЖОРСТКУ відмову. Формулюємо предметно: «оберіть слот у межах
   графіка» на записі о 22:00 у кабінет, що працює до 18:00, звучить як знущання. */
function offSchedError(info: OffScheduleInfo): QueueActionResult {
  if (info.kind === "closed") {
    return { ok: false, error: "Кабінет не працює цього дня — оберіть іншу дату", code: "off_schedule" };
  }
  if (info.kind === "before_start") {
    return { ok: false, error: "Кабінет ще не відкрито — оберіть слот у межах графіка", code: "off_schedule" };
  }
  // too_late
  const hours = Math.round(OFF_SCHED_GRACE_MIN / 60);
  return {
    ok: false,
    error: `Поза графіком можна працювати не більше ніж ${hours} год після закриття (${info.end}) — оберіть інший слот`,
    code: "off_schedule",
  };
}

/* Підтвердження не прийшло, хоча слот підтверджуваний. Це НЕ помилка користувача,
   а розсинхрон клієнта (застаріла вкладка / прямий виклик): актуальна сітка сама
   показала б діалог. Код лишаємо off_schedule — UI на нього вже завʼязаний. */
function offSchedNeedsConfirm(info: OffScheduleInfo): QueueActionResult {
  if (info.kind === "break") {
    const b = info.brk;
    return {
      ok: false,
      error: `Дослідження перетинає перерву${b ? ` ${b.start}–${b.end}` : ""} — потрібне підтвердження роботи поза графіком`,
      code: "off_schedule",
    };
  }
  return {
    ok: false,
    error: `Робочий день кабінету закінчується о ${info.end} — потрібне підтвердження роботи поза графіком`,
    code: "off_schedule",
  };
}

interface ScheduleBlockOpts {
  /** Оператор явно підтвердив роботу поза графіком. */
  offSchedule?: boolean;
  /** Викликає персонал ЦЬОГО центру (у направника/CEO clinic_id = NULL). */
  isStaff: boolean;
}

/* Рішення гарда. offSchedule — ЩО ПИСАТИ В КОЛОНКУ, і рахує це СЕРВЕР, а не клієнт:
   клієнтський прапорець — це лише «оператор підтвердив», а не «слот поза графіком».
   Якби ми писали в колонку прапорець клієнта, застаріла вкладка (слот уже в межах
   графіка після правки графіка адміном) поставила б бейдж «поза графіком» на
   абсолютно нормальний запис. */
type ScheduleDecision =
  | { blocked: QueueActionResult; offSchedule?: undefined }
  | { blocked: null; offSchedule: boolean };

/* Гард графіка ДЛЯ ВСІХ write-шляхів: null = можна писати, інакше — готова відповідь.
   Перевіряє і межі графіка, і ПЕРЕРВИ кабінету (обід тощо, rooms.schedule.breaks[]).
   Раніше перерви перевіряв лише editQueueEntryStudies, а createBooking /
   createReferralBooking / rescheduleQueueEntry — ні: клієнт малює перерву закритою,
   але застаріла вкладка, прямий виклик Server Action або направник зі старою сіткою
   садили пацієнта в обід. */
async function scheduleBlock(
  supabase: SupabaseClient<Database>,
  roomId: string,
  clinicId: string,
  scheduledDate: string,
  scheduledTime: string,
  durationMin: number,
  opts: ScheduleBlockOpts
): Promise<ScheduleDecision> {
  let info: OffScheduleInfo | null;
  try {
    info = await scheduleGate(supabase, roomId, clinicId, scheduledDate, scheduledTime, durationMin);
  } catch {
    return { blocked: SCHED_READ_ERR };
  }
  if (!info) return { blocked: null, offSchedule: false };   // у межах графіка
  if (!info.confirmable) return { blocked: offSchedError(info) };
  // Підтверджуваний вихід за графік — але лише для персоналу центру.
  if (!opts.isStaff) return { blocked: OFF_SCHED_ERR };
  if (!opts.offSchedule) return { blocked: offSchedNeedsConfirm(info) };
  return { blocked: null, offSchedule: true };
}

/** Чи належить викликач до ПЕРСОНАЛУ цього центру (направник/CEO — clinic_id NULL). */
async function callerIsStaffOf(supabase: SupabaseClient<Database>, clinicId: string): Promise<boolean> {
  return (await callerClinicId(supabase)) === clinicId;
}

/* ── Інваріант «тип дослідження ↔ модальність кабінету» (0088) ──────────────
   Джерело правди — rooms.modality; усі дослідження запису мають нормалізуватися
   в модальність кабінету. UI зазвичай не дасть обрати чужий тип, але Server Action
   приймає недовірений ввід (застаріла вкладка / інтеграція / прямий виклик), тож
   перевіряємо і на сервері (friendly-помилка нижче), і в БД (тригер check_studies_
   match_room — останній рубіж для шляхів повз ці екшени). OTHER/порожній склад —
   не обмежуємо (див. studiesMatchModality). */
const MODALITY_MISMATCH_ERR: QueueActionResult = {
  ok: false, error: "Тип дослідження не відповідає модальності кабінету", code: "modality_mismatch",
};
/* Defense-in-depth (High): послуга ВИМКНЕНА в каталозі центру або прихована в
   кабінеті (0107/0108). DB-тригер стереже лише модальність↔кабінет, тож крафтовий/
   застарілий запит міг записати на закриту послугу. Гейт — firstClosedService. */
const SERVICE_CLOSED_ERR = (region: string): QueueActionResult => ({
  ok: false, error: `Послуга «${region}» вимкнена, прихована або належить іншому кабінету — оновіть форму`, code: "modality_mismatch",
});
// Fail-CLOSED: збій читання каталогу → відмова у записі (а не мовчазний легасі-фолбэк).
const CATALOG_UNAVAILABLE_ERR: QueueActionResult = {
  ok: false, error: "Каталог послуг тимчасово недоступний — спробуйте ще раз", code: "generic",
};
/** Гейт закритих послуг із fail-CLOSED: назва закритої області → SERVICE_CLOSED_ERR;
    недоступний каталог → CATALOG_UNAVAILABLE_ERR; чисто → null. */
async function closedRegionGate(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  roomId: string | null | undefined,
  studies: { type?: string | null; region?: string | null }[] | null | undefined,
  grandfather?: ReadonlySet<string>,
): Promise<QueueActionResult | null> {
  try {
    const closed = await firstClosedService(supabase, clinicId, roomId, studies, grandfather);
    return closed ? SERVICE_CLOSED_ERR(closed) : null;
  } catch (e) {
    if (e instanceof CatalogUnavailableError) return CATALOG_UNAVAILABLE_ERR;
    throw e;
  }
}
// 0094/0095 — гарди кейса (тригери + create_case_rpc). Ловляться ЗА ТЕКСТОМ у всіх
// класифікаторах (mapCaseError/mapBookingError/classifyError) ДО перевірок за SQLSTATE:
// CASE_SAME_ROOM піднімається з 23505, який інакше сплутали б з «кабінет зайнятий».
const CASE_SAME_ROOM_ERR: QueueActionResult = {
  ok: false, error: "Кроки кейса мають бути в різних кабінетах — кілька досліджень одного кабінету оформіть звичайним записом", code: "generic",
};
const CASE_OVERLAP_ERR: QueueActionResult = {
  ok: false, error: "Пацієнт не може бути у двох кабінетах одночасно — змініть час кроку", code: "slot_unavailable",
};
// 0106 — сериалізація case-RPC: CASE_STALE (55000) — конкурент встиг організувати/
// змінити кейс між читанням і локом; queue_case_step_unique (23505) — DB-запобіжник
// дубля номера кроку. Обидва транзієнтні: користувач оновлює дошку і повторює.
const CASE_STALE_ERR: QueueActionResult = {
  ok: false, error: "Запис щойно змінив інший оператор — оновіть дошку і спробуйте ще раз", code: "stale",
};
/** Гарди кейса (0094/0095/0106) розпізнаємо за префіксом повідомлення — раніше за
    SQLSTATE, ніж будь-який класифікатор; null, якщо це не помилка кейса. */
function caseTriggerError(message: string): QueueActionResult | null {
  if (/CASE_SAME_ROOM/i.test(message)) return CASE_SAME_ROOM_ERR;
  if (/CASE_PATIENT_OVERLAP/i.test(message)) return CASE_OVERLAP_ERR;
  if (/CASE_STALE|queue_case_step_unique/i.test(message)) return CASE_STALE_ERR;
  // 0106 — тригер check_case_clinic_match: привʼязка кроку лише до відкритого кейса.
  if (/CASE_NOT_OPEN/i.test(message)) return { ok: false, error: "Кейс не активний — крок додати не можна", code: "generic" };
  return null;
}
async function studiesRoomMismatch(supabase: SupabaseClient<Database>, roomId: string, studies: unknown): Promise<boolean> {
  const { data } = await supabase.from("rooms").select("modality").eq("id", roomId).maybeSingle();
  return !studiesMatchModality(studies as Array<{ type?: string }> | null, data?.modality ?? null);
}

/* Клінічні тривалості — кратні 5 хв, стеля 480 (= CHECK queue_entries_duration_min_chk,
   0066). Перевірку робить схема zDuration (lib/validation.ts) на межі КОЖНОЇ дії —
   раніше вона жила лише в editQueueEntryStudies, а createBooking / createReferralBooking
   / waitlist покладались на normDur, тобто мовчки клампили сміття.
   Перелік статусів теж переїхав у схеми (zQueueStatus / zCallStatus). */

// Распознаём нарушения БД-инвариантов и отдаём код клиенту (укр. строки живут
// в компоненте). L-3: приоритет — по SQLSTATE (error.code), надёжнее текста:
//   23505 unique_violation → «один in_progress на кабинет» (частичный uniq idx 0018);
//   23P01 exclusion_violation → перекрытие слота / простой (триггеры 0014/0020).
// Текстовый разбор оставлен как fallback (на случай иной обёртки ошибки).
/* Конкурентність (0075): статусні RPC беруть рядок під `for update`, тож очікування
   блокування стало реальним. Звідси два НОВІ класи помилок, яких раніше не було:
     40P01 deadlock_detected   — Postgres вибрав нашу транзакцію жертвою;
     55P03 lock_not_available / 57014 query_canceled — таймаут очікування (Supabase
           тримає statement_timeout на ролі authenticated).
   Обидва — ТРАНЗІЄНТНІ: правильна реакція користувача — повторити, а не «щось зламалось». */
function isRetryableLockError(code: string, message: string): boolean {
  return code === "40P01" || code === "40001" || code === "55P03" || code === "57014"
    || /deadlock|canceling statement due to statement timeout|lock timeout/i.test(message);
}

function classifyError(err: { code?: string; message?: string }, status?: QueueStatus): QueueActionResult {
  const code = err?.code ?? "";
  const message = err?.message ?? "";
  if (isRetryableLockError(code, message)) {
    safeDbError("queue.status.lock", err);
    return { ok: false, error: "Запис саме зараз змінює інший оператор — спробуйте ще раз", code: "stale" };
  }
  // Гарди кейса (0095 CASE_SAME_ROOM піднімається з 23505) — за текстом ДО коду,
  // інакше перенос/зміна статусу кроку кейса показала б хибне «кабінет зайнятий».
  { const ce = caseTriggerError(message); if (ce) return ce; }
  if (status === "in_progress" && (code === "23505" || /in_progress|duplicate|23505/i.test(message))) {
    return { ok: false, error: "У кабінеті вже є пацієнт", code: "room_busy" };
  }
  // MODALITY_MISMATCH — тригер 0088: перенос у кабінет іншої модальності заборонено.
  if (/MODALITY_MISMATCH/i.test(message)) return MODALITY_MISMATCH_ERR;
  // STATUS_TRANSITION — тригер 0069: «Виконано» лише з in_progress.
  if (/STATUS_TRANSITION/i.test(message)) {
    return { ok: false, error: "«Виконано» можна поставити лише пацієнту, який був у кабінеті", code: "forbidden" };
  }
  // BREAK — тригер 0067 (перерва кабінету). Сюди доходить лише на воскресінні
  // термінального запису (зміна статусу «живого» рядка гард пропускає), але
  // сирий текст Postgres користувачу показувати не можна.
  if (/^BREAK|перетинає перерву/i.test(message)) return BREAK_ERR;
  { const se = schedTriggerError(message); if (se) return se; }   // 0084 — тригер графіка
  if (code === "23P01" || /overlap|exclusion|incident/i.test(message)) {
    // M-14: сирий текст Postgres (id кабінету, імена констрейнтів) — у лог, не клієнту.
    safeDbError("queue.status", err);
    return { ok: false, error: "Слот недоступний — кабінет зайнятий або в простої", code: "slot_unavailable" };
  }
  return { ok: false, error: safeDbError("queue.status", err), code: "generic" };
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
   рішення: дослідження зупиняється, кабінет звільняється). НЕ можна — тільки
   ЗАВЕРШЕНИЙ (done): саме там патч status:'scheduled' воскрешав запис і стирав
   факт виконання (і «Дохід» CEO). Цей CAS живе тепер у queue_reschedule_rpc (0070). */

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
  /* 0078: ЦІЛЬ і ОЧІКУВАННЯ — різні схеми. status (куди ставимо) не приймає
     'needs_reschedule' — його ставить лише план затримки. Але expectedFrom (звідки
     йдемо) мусить приймати ВСІ статуси: інакше запис, який опинився в
     'needs_reschedule', неможливо повернути в чергу — доска шле поточний статус
     як expectedFrom, і будь-яка кнопка падала б на валідації входу. */
  const v = parseInput("setQueueEntryStatus", z.object({
    id: zUuid, status: zQueueStatus, expectedFrom: zQueueStatusAny.optional(),
  }), { id, status, expectedFrom });
  if (!v.ok) return v;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  return setStatusViaRpc(supabase, user.id, v.data.id, v.data.status, { expected: v.data.expectedFrom });
}

/* ===== Єдина точка входу для зміни статусу (міграція 0070) =====
   Колонки status / call_status / in_progress_at / clarify_at / reschedule_origin
   ВІДКЛИКАНІ в authenticated: прямий PATCH з браузера падає 42501. Писати їх може
   лише SECURITY DEFINER RPC, де живуть авторизація (клініка/роль), CAS і правила.
   Раніше CAS існував тільки тут, у Server Action, а RLS дозволяла персоналу
   оновити рядок напряму анон-ключем — тобто вся машина станів обходилась. */
async function setStatusViaRpc(
  supabase: SupabaseClient<Database>,
  /** 0128: актор для журналу — user.id з УЖЕ перевіреної сесії викликача. */
  actorId: string,
  id: string,
  status: QueueStatus,
  opts: {
    expected?: QueueStatus;
    allowed?: readonly QueueStatus[];
    /** Передати note ЯВНО (у т.ч. null = стерти). Без цього прапорця нотатка не чіпається. */
    setNote?: boolean;
    note?: string | null;
    sameAsOk?: QueueStatus;
  } = {}
): Promise<QueueActionResult> {
  /* 0128: знімок ДО RPC — previousStatus для журналу береться з БД (не з клієнта),
     referrer_id/clinic_id потрібні для вибору сімʼї події та clinic-контексту.
     Це read-only і жодного гейта не міняє; якщо RLS рядок не показує — подія
     просто не запишеться (fail-open журналу, бізнес-результат незмінний). */
  const { data: pre } = await supabase.from("queue_entries")
    .select("referrer_id, clinic_id, status")
    .eq("id", id).maybeSingle();

  const { data, error } = await supabase.rpc("queue_set_status_rpc", {
    p_id: id,
    p_status: status,
    p_expected: opts.expected ?? undefined,
    p_allowed: opts.allowed ? (opts.allowed as QueueStatus[]) : undefined,
    p_note: opts.setNote ? (opts.note ?? null) : undefined,
    p_set_note: opts.setNote ?? undefined,
  });

  if (error) {
    if (error.code === "42501" || /FORBIDDEN/i.test(error.message)) {
      return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
    }
    return classifyError(error, status);
  }

  const res = Array.isArray(data) ? data[0] : data;
  if (!res) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  if (res.updated) {
    /* 0128: подія — лише при РЕАЛЬНІЙ зміні (updated=true), одна на дію.
       'cancelled' — окремий тип (queue.cancelled / referral.cancelled), решта
       переходів — завжди queue.status_changed (у referral-сімʼї свого немає).
       У details — лише статуси; p_note НЕ потрапляє в журнал (PII-правило). */
    if (pre?.clinic_id) {
      const referral = Boolean(pre.referrer_id);
      await emitImportantEvent({
        clinicId: pre.clinic_id,
        actorId,
        eventType: status === "cancelled"
          ? queueEventTypeFor("cancelled", referral)
          : queueEventTypeFor("status_changed", referral),
        entityType: "queue_entry",
        entityId: id,
        subjectReferrerId: pre.referrer_id ?? null,
        details: { previousStatus: pre.status, newStatus: status },
      });
    } else {
      // §12.11 (ревʼю с25 L1): пропуск події не мовчить.
      logError({ event: "important_event.skipped", actorId,
        entityId: id, errorCode: "pre_snapshot_unreadable",
        message: `type=queue.status_changed->${status}` });
    }
    return { ok: true };
  }

  const current = res.current_status as QueueStatus;
  // Той самий перехід уже застосовано (повторний клік / гонка) — ідемпотентно ok.
  if (current === status || (opts.sameAsOk && current === opts.sameAsOk)) return { ok: true };
  return { ok: false, error: STALE_ERR, code: "stale", currentStatus: current };
}

/** Скасувати запис (status → cancelled). Лише живий запис. */
export async function cancelQueueEntry(id: string): Promise<QueueActionResult> {
  const v = parseInput("cancelQueueEntry", zUuid, id);
  if (!v.ok) return v;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  return setStatusViaRpc(supabase, user.id, v.data, "cancelled", { allowed: LIVE_STATUSES, sameAsOk: "cancelled" });
}

/** Завершити процедуру: статус done/no_show/not_held + нотатка. Лише живий запис. */
export async function completeQueueEntry(
  id: string,
  status: "done" | "no_show" | "not_held",
  note: string | null
): Promise<QueueActionResult> {
  const v = parseInput("completeQueueEntry", z.object({
    id: zUuid,
    status: z.enum(["done", "no_show", "not_held"]),
    note: zOptText(2000),
  }), { id, status, note });
  if (!v.ok) return v;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // setNote: нотатка завершення пишеться ЗАВЖДИ (у т.ч. порожня — оператор міг її стерти).
  return setStatusViaRpc(supabase, user.id, v.data.id, v.data.status, {
    allowed: LIVE_STATUSES, setNote: true, note: v.data.note, sameAsOk: v.data.status,
  });
}

/** Статус обзвона. При declined запись отменяется (status → cancelled). */
export async function setQueueEntryCall(id: string, callStatus: CallStatus): Promise<QueueActionResult> {
  const v = parseInput("setQueueEntryCall", z.object({ id: zUuid, callStatus: zCallStatus }), { id, callStatus });
  if (!v.ok) return v;
  id = v.data.id;
  callStatus = v.data.callStatus;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  /* CAS. «Відмова» СКАСОВУЄ запис, тому дозволена лише до приходу пацієнта:
     оператор колл-листа зі старим списком не має скасувати того, хто вже
     в кабінеті. Решта статусів обдзвону — на будь-якому живому записі.
     Пишемо через RPC (0070): call_status відкликаний у authenticated. */
  const allowedFrom: readonly QueueStatus[] =
    callStatus === "declined" ? (["scheduled", "waiting"] as const) : LIVE_STATUSES;

  const { data, error } = await supabase.rpc("queue_set_call_rpc", {
    p_id: id,
    p_call: callStatus,
    p_allowed: allowedFrom as unknown as QueueStatus[],
  });
  if (error) {
    if (error.code === "42501" || /FORBIDDEN/i.test(error.message)) {
      return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
    }
    if (isRetryableLockError(error.code ?? "", error.message)) {
      safeDbError("setQueueEntryCall.lock", error);
      return { ok: false, error: "Запис саме зараз змінює інший оператор — спробуйте ще раз", code: "stale" };
    }
    return { ok: false, error: safeDbError("setQueueEntryCall", error), code: "generic" };
  }

  const res = Array.isArray(data) ? data[0] : data;
  if (!res) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  if (res.updated) return { ok: true };

  /* Ідемпотентність — по call_status, а не по status: інакше «✕ Відмова» на
     записі, який щойно скасували ЗВИЧАЙНИМ «Скасувати», повертала б ok, і UI
     казав би «Пацієнт відмовився» + пропонував кандидатів на вже вільний слот. */
  if (res.current_call === callStatus) return { ok: true };
  return { ok: false, error: STALE_ERR, code: "stale", currentStatus: res.current_status as QueueStatus };
}

/** Снять простой кабинета (incident → resolved). */
export async function resolveIncident(id: string): Promise<QueueActionResult> {
  const v = parseInput("resolveIncident", zUuid, id);
  if (!v.ok) return v;
  id = v.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // 0128: clinic_id інциденту потрібен журналу — читаємо ДО мутації тим самим RLS-клієнтом.
  const { data: pre } = await supabase.from("incidents").select("clinic_id").eq("id", id).maybeSingle();

  const { data, error } = await supabase
    .from("incidents")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: safeDbError("resolveIncident", error), code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або інцидент не знайдено", code: "forbidden" };
  if (pre?.clinic_id) {
    await emitImportantEvent({
      clinicId: pre.clinic_id,
      actorId: user.id,
      eventType: "incident.resolved",
      entityType: "incident",
      entityId: id,
      details: null,
    });
  } else {
    // §12.11 (ревʼю с25 L1): пропуск події не мовчить.
    logError({ event: "important_event.skipped", actorId: user.id,
      entityId: id, errorCode: "pre_snapshot_unreadable", message: "type=incident.resolved" });
  }
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

/* Створити/оновити простій (поломка / ТО / аварія) — АТОМАРНО, одним RPC (0066).
   Було: два окремі PostgREST-запити (insert incidents; update in_progress → not_held),
   тобто дві транзакції, і результат другої навіть не перевірявся. Обрив між ними →
   кабінет заблоковано, а пацієнт назавжди 'in_progress': унікальний індекс не дасть
   завести іншого, «Завершити» на заблокованому кабінеті недоступне → КАБІНЕТ МЕРТВИЙ.

   Статус planned/active рахує БД у настінному часі клініки (0065/0066) — TS більше
   не порівнює настінний startedAt з реальним Date.now(). */
export async function submitIncident(input: IncidentInput): Promise<IncidentActionResult> {
  const v = parseInput("submitIncident", sIncident, input);
  if (!v.ok) return v;
  const inc = v.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  // 0128: клініка викликача — для журналу (простій створює лише персонал свого центру).
  const eventClinicId = await callerClinicId(supabase);

  const { data, error } = await supabase.rpc("submit_incident_rpc", {
    p_room_id: inc.roomId,
    p_reason: inc.reason,
    p_id: inc.id ?? undefined,
    p_reason_label: inc.reasonLabel ?? undefined,
    p_note: inc.note ?? undefined,
    p_started_at: inc.startedAt,
    p_blocked_until: inc.blockedUntil ?? undefined,
    p_auto_unblock: inc.autoUnblock !== false,
  });

  if (error) {
    const code = error.code ?? "";
    // 0109: простій переводить in_progress-кроки кейса у not_held → перерахунок
    // статусу кейса бере лок кейса. У рідкій гонці з case-RPC це дає транзиентний
    // 40P01 — правильна реакція «повторіть», а не «щось зламалось».
    if (isRetryableLockError(code, error.message)) {
      safeDbError("submitIncident.lock", error);
      return { ok: false, error: "Кабінет саме зараз змінює інший оператор — спробуйте ще раз", code: "generic" };
    }
    // 23505 — унікальний індекс «один активний інцидент на кабінет» (0017).
    if (code === "23505" || /duplicate|unique|23505/i.test(error.message)) {
      return { ok: false, error: "Кабінет уже має активний простій", code: "duplicate" };
    }
    if (code === "28000" || /не авторизовано/i.test(error.message)) {
      return { ok: false, error: "Не авторизовано", code: "auth" };
    }
    if (/NOT_FOUND|ROOM_NOT_IN_CLINIC/i.test(error.message)) {
      return { ok: false, error: "Немає доступу або інцидент не знайдено", code: "forbidden" };
    }
    return { ok: false, error: safeDbError("submitIncident", error), code: "generic" };
  }

  const res = Array.isArray(data) ? data[0] : data;
  const status = (res?.status === "planned" ? "planned" : "active") as "planned" | "active";
  /* 0128: у details — лише id кабінету і allowlisted-код причини (enum схеми
     sIncident, НЕ вільний текст reasonLabel/note). */
  if (eventClinicId && res?.id) {
    await emitImportantEvent({
      clinicId: eventClinicId,
      actorId: user.id,
      eventType: "incident.started",
      entityType: "incident",
      entityId: res.id,
      details: { roomId: inc.roomId, reason: inc.reason },
    });
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
  const v = parseInput("emergencyStop", sRoomIdList, input);
  if (!v.ok) return v;
  const { roomIds } = v.data;

  const supabase = await createClient();
  // 0128: актор журналу — user.id з перевіреної сесії (callerClinicId його не повертає).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
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
    p_note: v.data.note ?? null,
  });
  if (error) {
    if (/28000|не авторизовано/i.test(error.message)) return { ok: false, error: "Не авторизовано", code: "auth" };
    // 0076 змінила ПРОФІЛЬ помилок: раніше конкурентна аварійка падала миттєво
    // (23505 на unique-індексі), тепер вона ЧЕКАЄ на спекулятивній вставці.
    // Отже тут уперше реальні 40P01 / 55P03 / 57014 (statement_timeout ролі
    // authenticated). Це транзієнт — «спробуйте ще раз», а не «щось зламалось».
    if (isRetryableLockError(error.code ?? "", error.message)) {
      safeDbError("emergencyStop.lock", error);
      return { ok: false, error: "Кабінет саме зараз зупиняє інший оператор — спробуйте ще раз", code: "generic" };
    }
    return { ok: false, error: safeDbError("emergencyStop", error), code: "generic" };
  }
  const res = Array.isArray(data) ? data[0] : data;

  // Негайна best-effort доставка події в n8n — НЕ awaited. Подія вже durable в
  // event_outbox (записана транзакційно в RPC), а оператор в аварії не має чекати
  // на повільний n8n: раніше `await` на 20 подій без таймауту міг вибити функцію
  // по maxDuration і показати ПОМИЛКУ на вже закомічену зупинку.
  // Недоставлене добере cron-воркер /api/outbox/deliver з backoff (0064).
  void deliverPendingOutbox(3).catch(() => { /* backstop — cron */ });

  /* 0128: emergency_stop_rpc не повертає id створених інцидентів — читаємо їх
     одразу після успіху тим самим RLS-клієнтом (активні emergency-інциденти
     реально зупинених кабінетів). Подія — на КОЖЕН створений інцидент (зупинка
     N кабінетів = N інцидентів); у details — лише id кабінету. */
  const stoppedRooms: string[] = res?.stopped_rooms ?? [];
  if (stoppedRooms.length > 0) {
    const { data: incs } = await supabase.from("incidents")
      .select("id, room_id")
      .eq("clinic_id", clinicId).eq("reason", "emergency").eq("status", "active")
      .in("room_id", stoppedRooms);
    /* Ревʼю с25 (M4): аварійний сценарій — N подій паралельно, не послідовно
       (20 кабінетів × RTT ≈ секунди зверху; emitImportantEvent не кидає). */
    await Promise.all((incs ?? []).map((inc) => emitImportantEvent({
      clinicId,
      actorId: user.id,
      eventType: "incident.emergency_stop",
      entityType: "incident",
      entityId: inc.id,
      details: { roomId: inc.room_id },
    })));
  }

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
  const v = parseInput("resolveEmergency", sRoomIdList, input);
  if (!v.ok) return v;
  const { roomIds } = v.data;

  const supabase = await createClient();
  // 0128: актор журналу — user.id з перевіреної сесії (callerClinicId його не повертає).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data, error } = await supabase.from("incidents")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("clinic_id", clinicId).eq("reason", "emergency").eq("status", "active")
    .in("room_id", roomIds)
    .select("id");
  if (error) {
    // Симетрично до emergencyStop (0076): зняття аварії тепер може чекати на
    // паралельній аварійній зупинці того ж кабінету → транзієнтні lock-помилки.
    if (isRetryableLockError(error.code ?? "", error.message)) {
      safeDbError("resolveEmergency.lock", error);
      return { ok: false, error: "Кабінет саме зараз змінює інший оператор — спробуйте ще раз", code: "generic" };
    }
    return { ok: false, error: safeDbError("resolveEmergency", error), code: "generic" };
  }
  // 0128: подія на кожен реально знятий аварійний інцидент (id — з результату UPDATE).
  // Ревʼю с25 (M4): паралельно — emitImportantEvent не кидає.
  await Promise.all((data ?? []).map((inc) => emitImportantEvent({
    clinicId,
    actorId: user.id,
    eventType: "incident.resolved",
    entityType: "incident",
    entityId: inc.id,
    details: { kind: "emergency" },
  })));
  return { ok: true, resolved: data?.length ?? 0 };
}

/** "YYYY-MM-DD" ± n діб (у настінному календарі, без TZ-арифметики). */
function shiftDayKey(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/* Мʼяка пред-перевірка перетину слота (жорстку гарантію дає тригер check_no_overlap).

   ЧОМУ АБСОЛЮТНІ МС, А НЕ ХВИЛИНИ ДОБИ (фікс 2026-07-14).
   Раніше перевірка брала лише записи `scheduled_date = scheduledDate` і рахувала
   хвилини від початку доби. Але зайнятість кабінету для in_progress рахується від
   ФАКТИЧНОГО старту (канон 0060), і дослідження, розпочате пізно ввечері, займає
   кабінет уже в НАСТУПНІЙ добі. Такий «хвіст» ця перевірка не бачила:
     • сітка малювала слот вільним (та сама діра була в room_busy_slots — 0074);
     • тригер (порівнює абсолютні tstzrange) бронь відхиляв → «слот зелений, але
       незаписуваний».
   Тепер критерій той самий, що в БД: перетин АБСОЛЮТНИХ настінних інтервалів,
   вибірка — сусідні доби (±1; довший хвіст неможливий: duration_min ≤ 480). */
async function hasSlotClash(
  supabase: SupabaseClient<Database>,
  roomId: string,
  clinicId: string,
  scheduledDate: string,
  startMs: number,   // настінні мс (wallInstant) початку нового вікна
  endMs: number,     // …і кінця (дослідження + буфер)
  excludeId?: string
): Promise<boolean> {
  const tz = await clinicTz(supabase, clinicId);
  /* Сусідні доби (±1) — лише для ПЛАНОВИХ рядків: довший хвіст неможливий
     (duration_min ≤ 480, буфер ≤ 15). in_progress за датою НЕ фільтруємо: його
     вікно прив'язане до in_progress_at, а не до scheduled_date (прострочений запис
     можна завести в кабінет через кілька днів). Тригер 0068 теж не фільтрує за
     датою — розбіжність повернула б «зелений, але незаписуваний слот». */
  const { data } = await supabase
    .from("queue_entries")
    .select("id, status, scheduled_date, scheduled_time, duration_min, buffer_time_min, in_progress_at")
    .eq("room_id", roomId)
    .or(
      `and(scheduled_date.gte.${shiftDayKey(scheduledDate, -1)},scheduled_date.lte.${shiftDayKey(scheduledDate, 1)}),` +
      `and(status.eq.in_progress,in_progress_at.not.is.null)`
    )
    .neq("status", "cancelled")
    .neq("status", "no_show")
    .neq("status", "not_held");

  return (data || []).some((q) => {
    if (excludeId && q.id === excludeId) return false;
    if (q.duration_min == null) return false;
    const qStart = q.status === "in_progress" && q.in_progress_at
      ? wallInstantOf(q.in_progress_at, tz)                        // фактичний старт
      : wallInstant(q.scheduled_date ?? "", q.scheduled_time ?? ""); // плановий слот
    if (qStart == null || !isFinite(qStart)) return false;
    const qEnd = qStart + (q.duration_min + normBuffer(q.buffer_time_min ?? BUFFER_DEFAULT)) * 60000;
    return qStart < endMs && startMs < qEnd;
  });
}

// L-3: здесь текст ОСТАВЛЕН намеренно — «простой» (INCIDENT, триггер 0020) и
// «перекрытие» (OVERLAP, триггер 0014) оба поднимаются с одним SQLSTATE 23P01,
// поэтому различить incident/slot_unavailable можно только по сообщению.
function mapBookingError(message: string, code = ""): QueueActionResult {
  // 0075: очікування рядкового блокування → дедлок/таймаут. Транзієнтне, не «помилка даних».
  if (isRetryableLockError(code, message)) {
    safeDbError("booking.lock", { code, message });
    return { ok: false, error: "Запис саме зараз змінює інший оператор — спробуйте ще раз", code: "stale" };
  }
  // Гарди кейса (0094/0095) — за текстом ДО перевірок за SQLSTATE (CASE_SAME_ROOM = 23505).
  { const ce = caseTriggerError(message); if (ce) return ce; }
  // SERVICE_CLOSED — тригер 0112/0113 (послуга вимкнена/прихована в кабінеті). TOCTOU:
  // послугу вимкнули між прикладним гейтом і записом → показуємо зрозумілу дію.
  if (/^SERVICE_CLOSED/i.test(message)) {
    return { ok: false, error: "Обрана послуга щойно була вимкнена або прихована в кабінеті — оновіть форму та виберіть іншу", code: "modality_mismatch" };
  }
  // MODALITY_MISMATCH — тригер 0088 (тип дослідження ↔ модальність кабінету).
  if (/MODALITY_MISMATCH/i.test(message)) return MODALITY_MISMATCH_ERR;
  // SLOT_GRID — тригер 0125 (час слота на сітці 5 хв). Сюди доходити не має
  // (zSlotTime блокує раніше), але якщо клієнт і БД колись розійдуться —
  // діагноз мусить лишатись видимим, а не «Не вдалося виконати операцію».
  if (/^SLOT_GRID/i.test(message)) {
    safeDbError("booking.slot_grid", { message });
    return { ok: false, error: "Час слота має бути кратним 5 хвилинам — оберіть слот у сітці", code: "generic" };
  }
  // PAST_SLOT — тригер 0063 (останній рубіж; серверна перевірка стоїть вище).
  if (/PAST_SLOT/i.test(message)) return PAST_ERR;
  // 0066: CHECK тривалості. Сюди доходити не має (клієнт клампить, сервер нормалізує),
  // але сирий текст Postgres користувачу показувати не можна.
  if (/duration_min_chk/i.test(message)) {
    return { ok: false, error: `Некоректна тривалість дослідження (кратна 5 хв, до ${DUR_MAX / 60} год)`, code: "generic" };
  }
  // BREAK — тригер 0067 (перерва кабінету). Перевіряти треба ДО overlap/exclusion:
  // виняток піднімається з тим самим SQLSTATE 23P01.
  if (/^BREAK|перетинає перерву/i.test(message)) return BREAK_ERR;
  { const se = schedTriggerError(message); if (se) return se; }   // 0084 — тригер графіка
  /* M-14: коди лишаються ті самі (UI на них зав'язаний), але НАЗОВНІ йде наш текст,
     а сирий Postgres (id кабінету, імена констрейнтів/таблиць) — у лог сервера. */
  if (/incident/i.test(message)) {
    safeDbError("booking.incident", { message });
    return { ok: false, error: "Кабінет у простої — оберіть інший слот або кабінет", code: "incident" };
  }
  if (/overlap|exclusion/i.test(message)) {
    safeDbError("booking.overlap", { message });
    return { ok: false, error: "Слот зайнятий — оберіть інший час", code: "slot_unavailable" };
  }
  return { ok: false, error: safeDbError("booking", { message }), code: "generic" };
}

export type ScheduleOverrideInput = {
  overrideDate: string;
  allClosed: boolean;
  label?: string | null;
  rooms?: Record<string, unknown> | null;
};

/** Сохранить особый график на день (upsert) или удалить, если пусто. */
export async function saveScheduleOverride(input: ScheduleOverrideInput): Promise<QueueActionResult> {
  const v = parseInput("saveScheduleOverride", sScheduleOverride, input);
  if (!v.ok) return v;

  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  const rooms = v.data.rooms || {};
  const empty = !v.data.allClosed && Object.keys(rooms).length === 0;

  if (empty) {
    const { error } = await supabase
      .from("schedule_overrides")
      .delete()
      .eq("clinic_id", clinicId)
      .eq("override_date", v.data.overrideDate);
    if (error) return { ok: false, error: safeDbError("saveScheduleOverride.delete", error), code: "generic" };
    return { ok: true };
  }

  const { error } = await supabase.from("schedule_overrides").upsert(
    {
      clinic_id: clinicId,
      override_date: v.data.overrideDate,
      all_closed: v.data.allClosed,
      label: v.data.label,
      rooms: rooms as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "clinic_id,override_date" }
  );
  if (error) return { ok: false, error: safeDbError("saveScheduleOverride.upsert", error), code: "generic" };
  return { ok: true };
}

/** Вернуть типовой график на день (удалить override). */
export async function resetScheduleOverride(overrideDate: string): Promise<QueueActionResult> {
  const v = parseInput("resetScheduleOverride", zDateKey, overrideDate);
  if (!v.ok) return v;

  const supabase = await createClient();
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { error } = await supabase
    .from("schedule_overrides")
    .delete()
    .eq("clinic_id", clinicId)
    .eq("override_date", v.data);
  if (error) return { ok: false, error: safeDbError("resetScheduleOverride", error), code: "generic" };
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
  reason?: string | null; // причина переносу (обовʼязкова для «не відбулося»/неявки)
  offSchedule?: boolean;  // 0077 — оператор підтвердив роботу поза графіком
  /* 0122: НОВИЙ склад — коли переносимо в кабінет з іншим прайсом (0121) і
     позиції перепризначено на його каталог. Не передано → склад не змінюється. */
  studies?: { type?: string; region?: string; contrast?: boolean; dur?: number; price?: number | null }[];
};

/** Перенос записи на другой кабинет/дату/время (с пред-проверкой пересечения). */
export async function rescheduleQueueEntry(raw: RescheduleInput): Promise<QueueActionResult> {
  const v = parseInput("rescheduleQueueEntry", sReschedule, raw);
  if (!v.ok) return v;
  const input = v.data;   // нормалізовані: UUID, "HH:MM", "YYYY-MM-DD", тривалість/буфер

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Стан ДО переносу — для довідки reschedule_origin. Перенос дослідження, що
  // ТРИВАЄ (in_progress), дозволено: воно зупиняється (status → scheduled),
  // кабінет одразу звільняється, а запис переноситься на новий слот (та сама
  // запис, не копія) з поміткою про перенос (from_status='in_progress').
  const { data: cur } = await supabase.from("queue_entries")
    // referrer_id — для журналу 0128 (вибір сімʼї події queue.*/referral.*).
    .select("status, scheduled_date, scheduled_time, room_id, clinic_id, studies, referrer_id")
    .eq("id", input.id).maybeSingle();
  /* Рядок не видно під RLS (чужа клініка / не свій запис направника) або він без
     клініки — далі йти нема сенсу. Раніше при cur=null МОВЧКИ пропускались усі три
     мʼякі перевірки (минуле / графік / перетин), і користувач отримував не підказку,
     а мапінг сирої помилки тригера. Дірки в безпеці не було (авторизація — в RPC),
     але поведінка була неохайною. */
  if (!cur?.clinic_id) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  const clinicId = cur.clinic_id;
  const reason = (input.reason || "").trim();

  /* Перенос у ІНШИЙ кабінет — це новий контекст: склад перевіряємо як актуальний
     для цільового кабінету, БЕЗ grandfather (0113 — той самий інваріант у БД). Так
     перенос у кабінет, де послугу приховано/вимкнено, дає зрозумілу помилку ДО RPC.
     Той самий кабінет (лише зміна часу) не гейтимо — склад не змінюється. */
  /* 0122: перенос може ЗАОДНО перепризначити склад — у цільового кабінету свій
     прайс, і стара позиція там може просто не існувати. Гейтимо той склад, який
     реально поїде: новий, якщо переданий, інакше поточний. Модальність нового
     складу звіряємо окремо — інакше «КТ у МРТ-кабінет» дійшов би до тригера і
     повернувся сирою помилкою замість зрозумілої. */
  const nextStudies = input.studies as unknown as { type?: string | null; region?: string | null }[] | undefined;
  if (input.roomId !== cur.room_id || nextStudies) {
    if (nextStudies && await studiesRoomMismatch(supabase, input.roomId, nextStudies)) {
      return MODALITY_MISMATCH_ERR;
    }
    /* Grandfather — ДЗЕРКАЛО умови тригера (0113/0121): він пропускає старі
       позиції, поки кабінет НЕ змінився. Без цього зміна складу в тому самому
       кабінеті була б суворішою за БД і впиралась у той самий глухий кут, від
       якого рятує 0122 (ревʼю 0122 №8). Перенос у ІНШИЙ кабінет — усе нове. */
    const gf = input.roomId === cur.room_id
      ? studiesKeySet(cur.studies as unknown as { type?: string | null; region?: string | null }[])
      : undefined;
    const g = await closedRegionGate(
      supabase, clinicId, input.roomId,
      (nextStudies ?? cur.studies) as unknown as { type?: string | null; region?: string | null }[],
      gf);
    if (g) return g;
  }

  /* Перенести в МИНУЛЕ не можна — жодною роллю. Клієнтський гейт тут не працював
     (isToday=false → перевірка "past" пропускалась), тому це і є основна діра. */
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  /* 0077: поза графіком переносить лише персонал ЦЬОГО центру і лише з підтвердженням.
     isStaff рахуємо від профілю викликача, а не від clinic_id ЗАПИСУ: сюди приходить
     і направник (переносить своє направлення) — у нього clinic_id = NULL. */
  const isStaff = await callerIsStaffOf(supabase, clinicId);
  const gate = await scheduleBlock(
    supabase, input.roomId, clinicId, input.scheduledDate, input.scheduledTime, input.durationMin,
    { offSchedule: input.offSchedule, isStaff }
  );
  if (gate.blocked) return gate.blocked;
  const offSchedule = gate.offSchedule;

  const bufferMin = normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT);
  // Абсолютні настінні мс (не хвилини доби): вікно може перетнути опівніч.
  const startMs = wallInstant(input.scheduledDate, input.scheduledTime);
  const endMs = startMs + (input.durationMin + bufferMin) * 60000;
  if (await hasSlotClash(supabase, input.roomId, clinicId, input.scheduledDate, startMs, endMs, input.id)) {
    return { ok: false, error: "Слот зайнятий", code: "slot_taken" };
  }

  /* Перенос — через RPC (0070): status / in_progress_at / clarify_at / call_status /
     reschedule_origin відкликані в authenticated, тож прямий UPDATE тут уже неможливий.
     Усередині RPC: авторизація (персонал своєї клініки АБО направник-власник із
     активним доступом), CAS (завершений запис не воскрешаємо — патч ставить
     'scheduled'), скидання фактичного старту й мітки «⚠ Уточнити», знімок
     reschedule_origin. Направнику call_status не чіпаємо (гард 0048).
     scheduled_at не передаємо: його авторитетно перераховує тригер 0035. */
  const { data, error } = await supabase.rpc("queue_reschedule_rpc", {
    p_id: input.id,
    p_room_id: input.roomId,
    p_date: input.scheduledDate,
    p_time: input.scheduledTime,
    p_duration: normDur(input.durationMin),
    p_buffer: bufferMin,
    p_call: input.callStatus ?? undefined,
    p_reason: reason || undefined,
    // 0077: прапорець ставиться ВСЕРЕДИНІ RPC — інакше check_not_during_break
    // відхилив би перенос у перерву ще до того, як мітку встигли б записати.
    p_off_schedule: offSchedule,
    // 0122: склад їде ТИМ САМИМ UPDATE, що й кабінет (двома кроками неможливо —
    // див. шапку міграції). null → RPC склад не чіпає.
    p_studies: (input.studies ?? null) as unknown as Json,
  });

  if (error) {
    if (error.code === "42501" || /FORBIDDEN/i.test(error.message)) {
      return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
    }
    return mapBookingError(error.message, error.code ?? "");
  }
  const res = Array.isArray(data) ? data[0] : data;
  if (!res) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  if (!res.updated) {
    return { ok: false, error: STALE_ERR, code: "stale", currentStatus: res.current_status as QueueStatus };
  }

  /* 0128: журнал переносу. changed_fields — лише НАЗВИ колонок, що реально
     змінились (час із БД може мати секунди — порівнюємо перші 5 символів);
     у details — тільки дати/часи/id кабінетів, БЕЗ імен та складу досліджень. */
  {
    const referral = Boolean(cur.referrer_id);
    const changedFields: string[] = [];
    if ((cur.scheduled_date ?? "") !== input.scheduledDate) changedFields.push("scheduled_date");
    if ((cur.scheduled_time ?? "").slice(0, 5) !== input.scheduledTime) changedFields.push("scheduled_time");
    if (cur.room_id !== input.roomId) changedFields.push("room_id");
    if (input.studies) changedFields.push("studies", "duration_min", "has_contrast");
    await emitImportantEvent({
      clinicId,
      actorId: user.id,
      eventType: queueEventTypeFor("rescheduled", referral),
      entityType: "queue_entry",
      entityId: input.id,
      subjectReferrerId: cur.referrer_id ?? null,
      changedFields: changedFields.sort(),
      details: {
        from: { date: cur.scheduled_date, time: cur.scheduled_time, roomId: cur.room_id },
        to: { date: input.scheduledDate, time: input.scheduledTime, roomId: input.roomId },
      },
    });
  }
  return { ok: true };
}

/** Изменить состав исследований записи (+ длительность и флаг контраста). */
export async function editQueueEntryStudies(
  id: string,
  studies: Json,
  durationMin: number,
  bufferTimeMin?: number,
  offSchedule?: boolean   // 0077: оператор підтвердив, що дослідження вийде за графік
): Promise<QueueActionResult> {
  /* Валідація НА СЕРВЕРІ (аудит 2026-07-11 + M-12). Клієнт обмежує повзунок
     графіком/перервою/наступним записом, але сам по собі клієнт нічого не гарантує:
     застаріла вкладка чи прямий виклик Server Action розтягували дослідження за
     кінець робочого дня або крізь перерву. Перетин з іншим записом ловить тригер
     check_no_overlap; графік і перерви — нижче. Тривалість тепер нормалізує схема
     (кратно 5, [5,480]) — раніше вона перевірялась тут вручну і лише в цій дії. */
  const v = parseInput("editQueueEntryStudies", z.object({
    id: zUuid,
    studies: sStudies,
    durationMin: zDuration,
    bufferTimeMin: zBuffer.optional(),
    offSchedule: z.boolean().optional(),
  }), { id, studies, durationMin, bufferTimeMin, offSchedule });
  if (!v.ok) return v;
  id = v.data.id;
  studies = v.data.studies as unknown as Json;
  const dur = v.data.durationMin;
  bufferTimeMin = v.data.bufferTimeMin;
  offSchedule = v.data.offSchedule;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data: cur } = await supabase.from("queue_entries")
    // referrer_id — для журналу 0128 (вибір сімʼї події queue.*/referral.*).
    .select("clinic_id, room_id, scheduled_date, scheduled_time, status, in_progress_at, duration_min, buffer_time_min, studies, referrer_id")
    .eq("id", id).maybeSingle();
  if (!cur) return { ok: false, error: "Запис не знайдено", code: "forbidden" };
  if (cur.room_id && await studiesRoomMismatch(supabase, cur.room_id, studies)) return MODALITY_MISMATCH_ERR;
  // Гейт закритих послуг з grandfather: області, що вже є в записі (снапшот), не
  // ріжемо — інакше не відредагувати запис із послугою, вимкненою вже після броні.
  if (cur.clinic_id) {
    // Узгоджено з БД-тригером 0112 (перевіряє й записи з room_id IS NULL проти
    // базового каталогу): не гейтимо лише за наявності кабінету, інакше тригер міг
    // би відхилити запис, який прикладний гейт пропустив.
    const gf = studiesKeySet(cur.studies as unknown as { type?: string | null; region?: string | null }[]);
    const g = await closedRegionGate(
      supabase, cur.clinic_id, cur.room_id,
      studies as unknown as { type?: string | null; region?: string | null }[], gf);
    if (g) return g;
  }

  const active = cur.status === "scheduled" || cur.status === "waiting" || cur.status === "in_progress";
  // 0077: подовження за графік / у перерву — можливе, але лише персоналу і з підтвердженням.
  let offSchedFlag = false;
  if (active && cur.room_id && cur.clinic_id && cur.scheduled_date && cur.scheduled_time) {
    const isStaff = await callerIsStaffOf(supabase, cur.clinic_id);
    const gate = await scheduleBlock(
      supabase, cur.room_id, cur.clinic_id, cur.scheduled_date, cur.scheduled_time, dur,
      { offSchedule, isStaff }
    );
    if (gate.blocked) return gate.blocked;
    offSchedFlag = gate.offSchedule;

    /* Мʼяка пред-перевірка перетину з НАСТУПНИМ записом (жорстку дає тригер
       check_no_overlap, 0068). Для пацієнта В КАБІНЕТІ вікно рахується від
       ФАКТИЧНОГО старту (in_progress_at), а не від планового слота — канон 0060.
       Клієнтський capByNext не гарантія: у StudyEditModal він Infinity, поки
       вантажиться зайнятість, а застаріла вкладка не знає про сусіда взагалі. */
    const newBuf = bufferTimeMin != null ? normBuffer(bufferTimeMin) : normBuffer(cur.buffer_time_min ?? BUFFER_DEFAULT);
    // Вікно — в абсолютних настінних мс: подовжене дослідження може перетнути опівніч.
    const startMs = cur.status === "in_progress" && cur.in_progress_at
      ? wallInstantOf(cur.in_progress_at, await clinicTz(supabase, cur.clinic_id)) ?? wallInstant(cur.scheduled_date, cur.scheduled_time)
      : wallInstant(cur.scheduled_date, cur.scheduled_time);
    if (await hasSlotClash(supabase, cur.room_id, cur.clinic_id, cur.scheduled_date, startMs, startMs + (dur + newBuf) * 60000, id)) {
      return { ok: false, error: "Дослідження не вміщується — далі стоїть інший запис", code: "slot_unavailable" };
    }
  }

  const hasContrast = Array.isArray(studies)
    ? studies.some((s) => typeof s === "object" && s !== null && (s as { contrast?: boolean }).contrast === true)
    : false;

  // Хто редагує склад досліджень: направник → 'referrer', персонал → 'clinic'.
  // Дошки підписують зміну відповідно й синхронізуються realtime.
  const { data: prof } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const changedBy = prof?.role === "referrer" ? "referrer" : "clinic";

  /* Буфер оновлюємо лише якщо переданий (редактор досліджень може його змінювати).
     off_schedule — в ТОМУ САМОМУ патчі: тригер check_not_during_break бачить
     new.duration_min і new.off_schedule разом, тож подовження в перерву проходить
     рівно тоді, коли мітка вже стоїть. Окремим UPDATE «після» це б не спрацювало. */
  const patch: TablesUpdate<"queue_entries"> = { studies, duration_min: dur, has_contrast: hasContrast, studies_changed_by: changedBy };
  if (bufferTimeMin != null) patch.buffer_time_min = normBuffer(bufferTimeMin);
  /* Мітку чіпаємо ЛИШЕ для активного запису: у завершеного/скасованого гард графіка
     не рахувався (active=false), і offSchedFlag там завжди false — записавши його,
     ми б мовчки зняли бейдж «поза графіком» з історичного запису. */
  if (active) patch.off_schedule = offSchedFlag;

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
  if (error) return mapBookingError(error.message, error.code ?? "");
  if (!data || data.length === 0) return casMiss(supabase, id);

  /* 0128: журнал зміни складу. changed_fields — імена колонок патча; у details —
     ЛИШЕ кількості позицій до/після (сам склад studies — заборонений ключ PII). */
  if (cur.clinic_id) {
    const referral = Boolean(cur.referrer_id);
    const previousCount = Array.isArray(cur.studies) ? cur.studies.length : null;
    const newCount = Array.isArray(studies) ? studies.length : 0;
    await emitImportantEvent({
      clinicId: cur.clinic_id,
      actorId: user.id,
      eventType: queueEventTypeFor("studies_changed", referral),
      entityType: "queue_entry",
      entityId: id,
      subjectReferrerId: cur.referrer_id ?? null,
      changedFields: changedFieldsOf(patch as Record<string, unknown>),
      details: previousCount != null ? { previousCount, newCount } : { newCount },
    });
  }
  return { ok: true };
}

export type BookingInput = {
  roomId: string;
  referrerId?: string | null;
  offSchedule?: boolean;   // 0077 — оператор підтвердив роботу поза графіком
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
export async function createBooking(raw: BookingInput): Promise<QueueActionResult> {
  const v = parseInput("createBooking", sBooking, raw);
  if (!v.ok) return v;
  const input = v.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  if (await studiesRoomMismatch(supabase, input.roomId, input.studies)) return MODALITY_MISMATCH_ERR;
  { const g = await closedRegionGate(supabase, clinicId, input.roomId, input.studies); if (g) return g; }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  /* 0077: createBooking доступний лише персоналу (clinic_id викликача = clinicId),
     тому isStaff тут завжди true — але передаємо явно, щоб гейт лишався одним
     і тим самим у всіх write-шляхах і не «розповзався». */
  const gate = await scheduleBlock(
    supabase, input.roomId, clinicId, input.scheduledDate, input.scheduledTime, input.durationMin,
    { offSchedule: input.offSchedule, isStaff: true }
  );
  if (gate.blocked) return gate.blocked;

  const bufferMin = normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT);
  // Абсолютні настінні мс (не хвилини доби): вікно може перетнути опівніч.
  const startMs = wallInstant(input.scheduledDate, input.scheduledTime);
  const endMs = startMs + (input.durationMin + bufferMin) * 60000;
  if (await hasSlotClash(supabase, input.roomId, clinicId, input.scheduledDate, startMs, endMs)) {
    return { ok: false, error: "Слот зайнятий", code: "slot_taken" };
  }

  const studies = input.studies as unknown as Json;
  const hasContrast = input.studies.some((s) => s.contrast === true);

  const { data: created, error } = await supabase.from("queue_entries").insert({
    clinic_id: clinicId,
    off_schedule: gate.offSchedule,   // 0077 — рахує сервер, не клієнт
    room_id: input.roomId,
    created_by: user.id,
    referrer_id: input.referrerId ?? null,
    patient_name: input.name,
    patient_phone: input.phone,
    patient_email: input.email,
    patient_dob: input.dob,
    patient_sex: input.sex,
    patient_age: input.age ?? null,
    patient_weight: input.weight ?? null,
    contraindications: !!input.hasContra,
    priority_level: normPriority(input.priorityLevel),
    has_contrast: hasContrast,
    studies,
    studies_original: studies,
    doctor: input.doctor,
    note: input.notes,
    duration_min: input.durationMin,   // H-1 + M-12: схема вже дала кратне 5 у [5,480]
    buffer_time_min: bufferMin,
    scheduled_date: input.scheduledDate,
    scheduled_time: input.scheduledTime,
    scheduled_at: input.scheduledAt,
    status: "scheduled",
    call_status: "not_called",
  }).select("id").single();

  if (error) return mapBookingError(error.message, error.code ?? "");
  /* 0128: журнал створення. Запис від імені направника (referrerId у формі
     персоналу) — referral.created із subject_referrer_id; без направника —
     queue.created. У details — лише кабінет і слот, жодних даних пацієнта. */
  if (created?.id) {
    const referral = Boolean(input.referrerId);
    await emitImportantEvent({
      clinicId,
      actorId: user.id,
      eventType: queueEventTypeFor("created", referral),
      entityType: "queue_entry",
      entityId: created.id,
      subjectReferrerId: input.referrerId ?? null,
      details: { roomId: input.roomId, scheduledDate: input.scheduledDate, scheduledTime: input.scheduledTime },
    });
  }
  return { ok: true, id: created?.id };
}

/** Помилки RPC переносу з листа очікування: власні raise (WAITLIST_*) поверх
    booking-тригерів; решта — той самий маппінг, що й бронювання. */
function mapWaitlistError(message: string, code = ""): QueueActionResult {
  if (/^AUTH/i.test(message)) return { ok: false, error: "Не авторизовано", code: "auth" };
  if (/WAITLIST_NOT_FOUND|^FORBIDDEN/i.test(message)) return { ok: false, error: "Немає доступу або кандидата не знайдено", code: "forbidden" };
  if (/WAITLIST_STALE/i.test(message)) return { ok: false, error: "Кандидата вже записує інший оператор — оновіть лист", code: "stale" };
  return mapBookingError(message, code);
}

/** АТОМАРНИЙ перенос кандидата з листа очікування у слот — ОДНІЄЮ транзакцією БД
    (schedule_from_waitlist_rpc, 0100): застовплення (CAS waiting→scheduled з
    рядковим блокуванням) + створення запису черги + запис scheduled_entry_id.
    Раніше це були ТРИ окремі транзакції: зупинка між створенням запису і звʼязком
    лишала кандидата 'scheduled' без scheduled_entry_id (зависав), а фінальний UPDATE
    навіть не перевірявся. Тепер проміжний стан не видно нікому, а будь-який збій
    відкочує все (кандидат лишається 'waiting', сиріт-записів нема). Пере-перевірки
    (модальність/минуле/графік/зайнятість) лишаємо на сервері для чистих помилок і
    щоб порахувати off_schedule (0077); авторитетний рубіж — тригери всередині RPC. */
export async function scheduleFromWaitlist(waitlistId: string, booking: BookingInput): Promise<QueueActionResult> {
  const idv = parseInput("scheduleFromWaitlist.id", zUuid, waitlistId);
  if (!idv.ok) return idv;
  const bv = parseInput("scheduleFromWaitlist", sBooking, booking);
  if (!bv.ok) return bv;
  const input = bv.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Пере-перевірки (як createBooking): дають чисту помилку ДО застовплення й рахують
  // off_schedule. Це НЕ мутації — гонку розвʼязує атомарний claim усередині RPC.
  if (await studiesRoomMismatch(supabase, input.roomId, input.studies)) return MODALITY_MISMATCH_ERR;
  { const g = await closedRegionGate(supabase, clinicId, input.roomId, input.studies); if (g) return g; }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  const gate = await scheduleBlock(
    supabase, input.roomId, clinicId, input.scheduledDate, input.scheduledTime, input.durationMin,
    { offSchedule: input.offSchedule, isStaff: true }
  );
  if (gate.blocked) return gate.blocked;
  const bufferMin = normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT);
  const startMs = wallInstant(input.scheduledDate, input.scheduledTime);
  const endMs = startMs + (input.durationMin + bufferMin) * 60000;
  if (await hasSlotClash(supabase, input.roomId, clinicId, input.scheduledDate, startMs, endMs)) {
    return { ok: false, error: "Слот зайнятий", code: "slot_taken" };
  }

  const p_booking = {
    off_schedule: gate.offSchedule,
    room_id: input.roomId,
    referrer_id: input.referrerId ?? null,
    patient_name: input.name,
    patient_phone: input.phone,
    patient_email: input.email,
    patient_dob: input.dob,
    patient_sex: input.sex,
    patient_age: input.age ?? null,
    patient_weight: input.weight ?? null,
    contraindications: !!input.hasContra,
    priority_level: normPriority(input.priorityLevel),
    has_contrast: input.studies.some((s) => s.contrast === true),
    studies: input.studies,
    doctor: input.doctor,
    note: input.notes,
    duration_min: input.durationMin,
    buffer_time_min: bufferMin,
    scheduled_date: input.scheduledDate,
    scheduled_time: input.scheduledTime,
  };

  // 0128: referrer_id кандидата — для subject_referrer_id журналу; читаємо ДО мутації.
  const { data: wl } = await supabase.from("waitlist_entries")
    .select("referrer_id").eq("id", idv.data).maybeSingle();

  const { data, error } = await supabase.rpc("schedule_from_waitlist_rpc", {
    p_waitlist_id: idv.data,
    p_booking: p_booking as unknown as Json,
  });
  if (error) return mapWaitlistError(error.message, error.code ?? "");
  const createdId = (data as string) ?? undefined;
  // 0128: журнал переносу з листа очікування — сутність = кандидат листа.
  await emitImportantEvent({
    clinicId,
    actorId: user.id,
    eventType: "waitlist.scheduled",
    entityType: "waitlist_entry",
    entityId: idv.data,
    subjectReferrerId: wl?.referrer_id ?? null,
    details: {
      queueEntryId: createdId ?? null,
      roomId: input.roomId,
      scheduledDate: input.scheduledDate,
      scheduledTime: input.scheduledTime,
    },
  });
  return { ok: true, id: createdId };
}

/** Заметка радіолога (radiologist_note). */
export async function setRadiologistNote(id: string, note: string): Promise<QueueActionResult> {
  const v = parseInput("setRadiologistNote", z.object({ id: zUuid, note: zOptText(4000) }), { id, note });
  if (!v.ok) return v;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const { data, error } = await supabase.from("queue_entries").update({ radiologist_note: v.data.note }).eq("id", v.data.id).select("id");
  if (error) return { ok: false, error: safeDbError("setRadiologistNote", error), code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Заметка обзвона (call_note). */
export async function setCallNote(id: string, note: string): Promise<QueueActionResult> {
  const v = parseInput("setCallNote", z.object({ id: zUuid, note: zOptText(4000) }), { id, note });
  if (!v.ok) return v;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const { data, error } = await supabase.from("queue_entries").update({ call_note: v.data.note }).eq("id", v.data.id).select("id");
  if (error) return { ok: false, error: safeDbError("setCallNote", error), code: "generic" };
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
  const v = parseInput("confirmAllCalls", zIdList, ids);
  if (!v.ok) return v;
  const list = v.data;
  if (!list.length) return { ok: true, updated: 0 };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  /* Через RPC (0070): call_status відкликаний у authenticated. Ізоляція по клініці,
     роль і «лише живі записи» — усередині RPC. Повертає РЕАЛЬНУ кількість оновлених:
     ids приходять із (можливо застарілого) відфільтрованого списку, і 'confirmed'
     не має лягати на щойно скасований запис. */
  const { data, error } = await supabase.rpc("queue_confirm_calls_rpc", { p_ids: list });
  if (error) {
    if (error.code === "42501" || /FORBIDDEN/i.test(error.message)) {
      return { ok: false, error: "Немає прав на обдзвін", code: "generic" };
    }
    return { ok: false, error: safeDbError("confirmAllCalls", error), code: "generic" };
  }
  return { ok: true, updated: typeof data === "number" ? data : 0 };
}

/* Колонки, які РЕАЛЬНО редагує PatientEditModal — тепер СХЕМОЮ, а не масивом імен.
   Типи TS не захищають Server Action від довільного JSON: раніше сюди приймався
   весь TablesUpdate<"queue_entries">, і через нього з клієнта (або протухлої
   вкладки) проходили status, scheduled_date/time, room_id, in_progress_at,
   call_status — тобто завершений запис можна було воскресити в обхід усіх CAS-гардів.
   Невідомі ключі zod відкидає; ЗНАЧЕННЯ тепер теж перевіряються (раніше allowlist
   пропускав будь-яке сміття в дозволеній колонці).
   ВАЖЛИВО: усі поля .optional() — відсутній ключ має лишитись ВІДСУТНІМ, інакше
   патч затер би колонку в null. */
const sPatientPatch = z.object({
  patient_name: zName.optional(),
  patient_phone: z.union([z.string().trim().max(32), z.null()]).optional(),
  patient_email: z.union([z.string().trim().max(254), z.null()]).optional(),
  patient_dob: z.union([zDateKey, z.literal(""), z.null()]).optional(),
  patient_age: z.union([z.number().int().min(0).max(PATIENT_AGE_MAX), z.null()]).optional(),
  patient_sex: z.union([z.string().trim().max(16), z.null()]).optional(),
  patient_weight: z.union([z.number().finite().min(0).max(PATIENT_WEIGHT_MAX), z.null()]).optional(),
  contraindications: z.boolean().optional(),
  note: z.union([z.string().trim().max(2000), z.null()]).optional(),
  doctor: z.union([z.string().trim().max(200), z.null()]).optional(),
  referrer_id: z.union([zUuid, z.null()]).optional(),
});

/** Редагування даних пацієнта (PatientEditModal). patch — тільки колонки зі схеми. */
export async function updatePatientDetails(id: string, patch: TablesUpdate<"queue_entries">): Promise<QueueActionResult> {
  const v = parseInput("updatePatientDetails", z.object({ id: zUuid, patch: sPatientPatch }), { id, patch });
  if (!v.ok) return v;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Пріоритет — ЛИШЕ через setQueuePriority (там перевірка ролі).
  // Порожні рядки → null (як і раніше: "" не має лягати в дату/телефон).
  const safePatch: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v.data.patch)) {
    if (val === undefined) continue;
    safePatch[k] = val === "" ? null : val;
  }
  if (Object.keys(safePatch).length === 0) return { ok: true };

  /* 0128: referrer_id/clinic_id — для журналу; знімок ДО мутації (патч може
     міняти сам referrer_id — сімʼю події вибираємо за станом до правки). */
  const { data: pre } = await supabase.from("queue_entries")
    .select("referrer_id, clinic_id").eq("id", v.data.id).maybeSingle();

  /* CAS тут НЕ ставимо свідомо: ПІБ/телефон правлять і в завершеному записі
     (клік по імені відкриває редактор у будь-якому рядку дошки), а статус ці
     колонки не чіпають — воскресити запис ними неможливо (за це відповідає схема). */
  const { data, error } = await supabase
    .from("queue_entries")
    .update(safePatch as TablesUpdate<"queue_entries">)
    .eq("id", v.data.id)
    .select("id");
  if (error) return { ok: false, error: safeDbError("updatePatientDetails", error), code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };

  /* 0128: журнал правки даних пацієнта — БЕЗ details узагалі (значення полів —
     PII); changed_fields — лише ІМЕНА реально переданих колонок патча. */
  if (pre?.clinic_id) {
    const referral = Boolean(pre.referrer_id);
    await emitImportantEvent({
      clinicId: pre.clinic_id,
      actorId: user.id,
      eventType: queueEventTypeFor("patient_data_changed", referral),
      entityType: "queue_entry",
      entityId: v.data.id,
      subjectReferrerId: pre.referrer_id ?? null,
      changedFields: changedFieldsOf(safePatch),
    });
  }
  return { ok: true };
}

/**
 * Змінити пріоритет пацієнта у вже створеній записі.
 * Дозволено ЛИШЕ: адміністратору клініки АБО направнику-власнику запису
 * (referrer_id = auth.uid()). Реєстратор/радіолог — заборонено (403).
 * Тригер БД синхронізує булевий cito = (priority_level='cito').
 */
export async function setQueuePriority(id: string, priority: PatientPriority): Promise<QueueActionResult> {
  const v = parseInput("setQueuePriority", z.object({ id: zUuid, priority: zPriority }), { id, priority });
  if (!v.ok) return v;
  id = v.data.id;
  const level = v.data.priority;

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
  if (error) return { ok: false, error: safeDbError("setQueuePriority", error), code: "generic" };
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
export async function createReferralBooking(raw: ReferralBookingInput): Promise<QueueActionResult> {
  const v = parseInput("createReferralBooking", sReferralBooking, raw);
  if (!v.ok) return v;
  const input = v.data;

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

  if (await studiesRoomMismatch(supabase, input.roomId, input.studies)) return MODALITY_MISMATCH_ERR;
  { const g = await closedRegionGate(supabase, input.clinicId, input.roomId, input.studies); if (g) return g; }
  if (await isPastSlot(supabase, input.clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  /* 0077: направнику робота поза графіком НЕ доступна (рішення власника: він
     записує пацієнтів ззовні й не знає, чи лишиться зміна). isStaff: false —
     і жодного прапорця в схемі sReferralBooking навіть немає. Другий рубіж —
     тригер trg_c_guard_off_schedule у БД. */
  {
    const gate = await scheduleBlock(
      supabase, input.roomId, input.clinicId, input.scheduledDate, input.scheduledTime, input.durationMin,
      { isStaff: false }
    );
    if (gate.blocked) return gate.blocked;
  }

  const bufferMin = normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT);
  // Абсолютні настінні мс (не хвилини доби): вікно може перетнути опівніч.
  const startMs = wallInstant(input.scheduledDate, input.scheduledTime);
  const endMs = startMs + (input.durationMin + bufferMin) * 60000;
  if (await hasSlotClash(supabase, input.roomId, input.clinicId, input.scheduledDate, startMs, endMs)) {
    return { ok: false, error: "Слот зайнятий", code: "slot_taken" };
  }

  const studies = input.studies as unknown as Json;
  const hasContrast = input.studies.some((s) => s.contrast === true);

  const { data: created, error } = await supabase.from("queue_entries").insert({
    clinic_id: input.clinicId,
    room_id: input.roomId,
    created_by: user.id,
    referrer_id: user.id,
    patient_name: input.name,
    patient_phone: input.phone,
    patient_email: input.email,
    patient_dob: input.dob,
    patient_sex: input.sex,
    patient_age: input.age ?? null,
    patient_weight: input.weight ?? null,
    contraindications: !!input.hasContra,
    priority_level: normPriority(input.priorityLevel),
    has_contrast: hasContrast,
    studies,
    studies_original: studies,
    doctor: input.doctorName,
    note: input.note,
    indication: input.note,
    duration_min: input.durationMin,   // H-1 + M-12: схема дала кратне 5 у [5,480]
    buffer_time_min: bufferMin,
    scheduled_date: input.scheduledDate,
    scheduled_time: input.scheduledTime,
    scheduled_at: input.scheduledAt,
    status: "scheduled",
    call_status: "not_called",
  }).select("id").single();

  if (error) return mapBookingError(error.message, error.code ?? "");
  /* 0128: журнал направлення — завжди referral.created; направник діє над своїм
     (subject = actor). Клініка — та, чий грант дія вже перевірила вище. */
  if (created?.id) {
    await emitImportantEvent({
      clinicId: input.clinicId,
      actorId: user.id,
      eventType: queueEventTypeFor("created", true),
      entityType: "queue_entry",
      entityId: created.id,
      subjectReferrerId: user.id,
      details: { roomId: input.roomId, scheduledDate: input.scheduledDate, scheduledTime: input.scheduledTime },
    });
  }
  return { ok: true, id: created?.id };
}

/* ============================================================================
   0078–0081 — ПОЛІТИКА ЧЕРГИ ПРИ ЗАТРИМЦІ (етап 3b)

   Дослідження в кабінеті затягнулося і наїжджає на наступні записи. Сервер рахує
   ДВА плани (зсунути чергу / перенести конфліктних), адмін дивиться preview і
   підтверджує один. Застосування — атомарне, через queue_apply_delay_plan_rpc.

   ЧОМУ ПЛАН РАХУЄ СЕРВЕР, А НЕ БРАУЗЕР
   ------------------------------------
   `delay_min` і сітка слотів залежать від «зараз» — а «зараз» у цьому продукті
   існує ЛИШЕ в настінному часі клініки (clinics.timezone). Порахувавши план по
   годиннику браузера, оператор із іншої зони зсунув би чергу на години. Тому тут
   жодного `new Date()` для доменного часу: тільки wallNow(tz) / wallMinOfInstant(iso, tz).
   Ті самі чисті функції (lib/delayPlan.ts) виконує і клієнт — щоб адмін бачив рівно
   те, що застосується. Дві реалізації розійшлися б; у цьому проєкті так уже було
   (0074: сітка малювала слот зеленим, а тригер бронь відхиляв).
   ============================================================================ */

/** Графік кабінету + перерви на дату. Кидає при збої читання (H-6, fail-closed). */
async function roomDayCtx(
  supabase: SupabaseClient<Database>,
  roomId: string,
  clinicId: string,
  date: string
): Promise<{ sched: EffectiveRoomSchedule; breaks: Break[] }> {
  const { data: room, error: roomErr } = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
  if (roomErr) throw roomErr;
  const { data: ov, error: ovErr } = await supabase
    .from("schedule_overrides").select("all_closed, label, rooms")
    .eq("clinic_id", clinicId).eq("override_date", date).maybeSingle();
  if (ovErr) throw ovErr;

  const day = new Date(date + "T00:00:00");
  const override = (ov as unknown as DayOverride) || null;
  return {
    sched: roomScheduleFor(day, roomId, override, room?.schedule ?? null),
    breaks: effectiveRoomBreaks(day, roomId, room?.schedule ?? null, override),
  };
}

/* Вікна простоїв кабінету на дату — у хвилинах доби, для планувальника.
   Час інцидентів зберігається в «настінному UTC» (той самий фрейм, що wallInstant),
   тому віднімаємо настінну північ доби, а не робимо getHours().
   Клампінг: початок — floor, кінець — ceil. «Округлення як у школі» повернуло б
   секунди зайнятого часу в «вільні», і тригер відхилив би бронь саме в них (§6.1.0). */
async function incidentSpansFor(
  supabase: SupabaseClient<Database>,
  roomId: string,
  date: string
): Promise<BusySpan[]> {
  const { data, error } = await supabase
    .from("incidents")
    .select("started_at, blocked_until, status")
    .eq("room_id", roomId)
    .eq("status", "active");
  if (error) throw error;   // H-6: збій читання простоїв ≠ «простоїв немає»

  const day0 = wallInstant(date, "00:00");
  const spans: BusySpan[] = [];
  for (const i of data || []) {
    const sMs = new Date(i.started_at).getTime();
    const eMs = i.blocked_until ? new Date(i.blocked_until).getTime() : day0 + 24 * 3600e3;
    if (!isFinite(sMs) || !isFinite(eMs)) continue;
    const s = Math.max(0, Math.floor((sMs - day0) / 60000));
    const e = Math.min(1440, Math.ceil((eMs - day0) / 60000));
    if (e > s) spans.push({ s, e });
  }
  return spans;
}

export interface DelayPreview {
  sourceId: string;
  roomId: string;
  date: string;
  /** Фактичний наїзд на найближчий запис, хв (> порога центру). */
  delayMin: number;
  /** Хвилина доби, коли кабінет реально звільниться (з буфером прибирання). */
  freeAtMin: number;
  policy: QueueDelayPolicy;
  thresholdMin: number;
  cascade: DelayPlan;
  conflicts: DelayPlan;
  /** Знімок статусів записів, які план може чіпати. Його ж шлемо в RPC як p_expected. */
  expected: { id: string; status: QueueStatus }[];
}

export type DelayPreviewResult =
  | { ok: true; preview: DelayPreview | null }   // null = затримки немає (або вже не в кабінеті)
  | { ok: false; error: string; code?: "auth" | "forbidden" | "generic" };

/* Рахує обидва плани. Дивитись може будь-хто з ПЕРСОНАЛУ центру — радіолог теж
   (рішення власника: він бачить затримку і може ініціювати перерахунок), а от
   ЗАСТОСОВУЄ лише адмін (гейт в applyDelayPlan і, головне, у самій RPC). */
export async function previewDelayPlan(sourceEntryId: string): Promise<DelayPreviewResult> {
  const v = parseInput("previewDelayPlan", zUuid, sourceEntryId);
  if (!v.ok) return { ok: false, error: v.error, code: "generic" };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data: src, error: srcErr } = await supabase
    .from("queue_entries")
    .select("id, clinic_id, room_id, status, scheduled_date, scheduled_time, duration_min, buffer_time_min, in_progress_at")
    .eq("id", v.data)
    .maybeSingle();
  if (srcErr) return { ok: false, error: safeDbError("previewDelayPlan.src", srcErr), code: "generic" };
  if (!src || !src.room_id || !src.scheduled_date) {
    return { ok: false, error: "Запис не знайдено", code: "forbidden" };
  }
  // Персонал ЦЬОГО центру (у направника/CEO clinic_id = NULL → сюди не пройдуть).
  if (!(await callerIsStaffOf(supabase, src.clinic_id))) {
    return { ok: false, error: "Немає доступу", code: "forbidden" };
  }
  // План існує рівно доти, доки триває те, що затягнулося.
  if (src.status !== "in_progress" || !src.in_progress_at) return { ok: true, preview: null };

  const { data: clinic, error: clErr } = await supabase
    .from("clinics")
    .select("timezone, queue_delay_policy, overlap_threshold_min, max_cascade_patients, allow_after_hours_shift")
    .eq("id", src.clinic_id)
    .maybeSingle();
  if (clErr) return { ok: false, error: safeDbError("previewDelayPlan.clinic", clErr), code: "generic" };
  if (!clinic) return { ok: false, error: "Центр не знайдено", code: "forbidden" };

  const tz = clinic.timezone || "UTC";
  const roomId = src.room_id;
  const date = src.scheduled_date;

  // Записи кабінету на цей день, які ще чекають (рухати можна тільки їх).
  const { data: rows, error: rowsErr } = await supabase
    .from("queue_entries")
    .select("id, status, scheduled_time, duration_min, buffer_time_min, patient_name")
    .eq("room_id", roomId)
    .eq("scheduled_date", date)
    .in("status", ["scheduled", "waiting"]);
  if (rowsErr) return { ok: false, error: safeDbError("previewDelayPlan.rows", rowsErr), code: "generic" };

  let sched: EffectiveRoomSchedule, breaks: Break[], incidentSpans: BusySpan[];
  try {
    ({ sched, breaks } = await roomDayCtx(supabase, roomId, src.clinic_id, date));
    incidentSpans = await incidentSpansFor(supabase, roomId, date);
  } catch (e) {
    // fail-closed: не змогли прочитати графік/простої → плану НЕ показуємо.
    // Порада «перенести на 14:00» на застарілих даних гірша за її відсутність.
    return { ok: false, error: safeDbError("previewDelayPlan.ctx", e as { code?: string; message?: string }), code: "generic" };
  }

  const entries: DelayEntry[] = (rows || []) as DelayEntry[];

  /* «Зараз» і фактичний старт — у НАСТІННОМУ часі клініки, зона передана ЯВНО.
     wallNow() без аргументу мовчки взяв би зону сервера Vercel (UTC) — і о 09:00
     у Києві план вважав би, що зараз 06:00. */
  const nowMin = wallMinOfDay(wallNow(tz));
  const runStartMin = wallMinOfInstant(src.in_progress_at, tz);
  if (runStartMin == null) return { ok: true, preview: null };

  const run: DelayEntry = {
    id: src.id, status: src.status,
    scheduled_time: src.scheduled_time,
    duration_min: src.duration_min,
    buffer_time_min: src.buffer_time_min,
  };
  const freeAtMin = actualFreeAtMin(run, runStartMin, nowMin);

  const thresholdMin = clinic.overlap_threshold_min ?? 15;
  const delayMin = delayTriggers(freeAtMin, entries, thresholdMin);
  // Наїзд ≤ порога — це те, що буфер і має поглинати. Сценарій не запускаємо.
  if (delayMin <= 0) return { ok: true, preview: null };

  const ctx = {
    freeAtMin,
    schedStartMin: slotToMin(sched.start),
    schedEndMin: slotToMin(sched.end),
    breaks,
    incidentSpans,
    allowAfterHours: !!clinic.allow_after_hours_shift,
    maxItems: clinic.max_cascade_patients ?? 30,
  };

  return {
    ok: true,
    preview: {
      sourceId: src.id,
      roomId,
      date,
      delayMin,
      freeAtMin,
      policy: (clinic.queue_delay_policy ?? "manual") as QueueDelayPolicy,
      thresholdMin,
      cascade: buildCascadePlan(entries, ctx),
      conflicts: buildConflictPlan(entries, ctx),
      expected: entries.map((e) => ({ id: e.id, status: e.status as QueueStatus })),
    },
  };
}

/* ===== Застосування плану ===== */

const sDelayItem = z.object({
  id: zUuid,
  // 'keep' сюди не приходить: застосовувати там нічого, а RPC (0081) його відхиляє.
  kind: z.enum(["shift", "no_fit", "conflict"]),
  /* 'from' — провенанс (плановий час ДО зсуву) і їде лише в журнал; строгість
     сітки тут блокувала б увесь план, якби в кабінеті сидів легасі-запис поза
     сіткою. 'to' — НОВИЙ слот, його дає firstFittingSlot по кроку SLOT_STEP,
     тож сітку вимагаємо. */
  from: zTime,
  to: zSlotTime.nullable(),
});

const sApplyDelayPlan = z.object({
  sourceId: zUuid,
  strategy: z.enum(["cascade_shift", "reschedule_conflicts"]),
  delayMin: z.number().int().positive().max(480),
  items: z.array(sDelayItem).min(1).max(100),
  expected: z.array(z.object({ id: zUuid, status: zQueueStatusAny })).max(200),
  reason: zOptText(500),
});

/* code — той самий union, що в QueueActionResult (щоб пропускати готові відповіді
   offSchedError / offSchedNeedsConfirm / SCHED_READ_ERR без звуження типу), плюс
   staleIds для applied=false. */
type QueueErrResult = Extract<QueueActionResult, { ok: false }>;
type QueueErrCode = QueueErrResult["code"];
export type ApplyDelayResult =
  | { ok: true; moved: number; flagged: number; eventId: string | null }
  | { ok: false; error: string; code?: QueueErrCode; staleIds?: string[] };

export async function applyDelayPlan(raw: {
  sourceId: string;
  strategy: "cascade_shift" | "reschedule_conflicts";
  delayMin: number;
  items: { id: string; kind: "shift" | "no_fit" | "conflict"; from: string; to: string | null }[];
  expected: { id: string; status: string }[];
  reason?: string | null;
}): Promise<ApplyDelayResult> {
  const v = parseInput("applyDelayPlan", sApplyDelayPlan, raw);
  if (!v.ok) return { ok: false, error: v.error, code: "generic" };
  const input = v.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  /* Роль читаємо з БД. Гейт адміна є і всередині RPC (він і є справжнім рубежем —
     RPC видана authenticated), але падати тут дає ЗРОЗУМІЛУ помилку замість сирого
     42501, і не марнує роботу на розрахунок графіка. */
  const { data: prof } = await supabase.from("profiles").select("role, clinic_id").eq("id", user.id).maybeSingle();
  if (!prof?.clinic_id || prof.role !== "admin") {
    return { ok: false, error: "Масову зміну черги підтверджує адміністратор центру", code: "forbidden" };
  }

  const { data: src, error: srcErr } = await supabase
    .from("queue_entries")
    .select("id, clinic_id, room_id, status, scheduled_date")
    .eq("id", input.sourceId)
    .maybeSingle();
  if (srcErr) return { ok: false, error: safeDbError("applyDelayPlan.src", srcErr), code: "generic" };
  if (!src || !src.room_id || !src.scheduled_date || src.clinic_id !== prof.clinic_id) {
    return { ok: false, error: "Запис не знайдено", code: "forbidden" };
  }
  if (src.status !== "in_progress") {
    // Дослідження встигли завершити, поки адмін дивився preview.
    return { ok: false, error: "Дослідження вже завершено — затримки більше немає", code: "stale" };
  }

  const roomId = src.room_id;
  const date = src.scheduled_date;

  /* Тривалості беремо З БД, а не з клієнта: за ними рахується вихід за графік.
     Заразом це перевірка, що всі записи плану — цього кабінету і цього дня
     (те саме перевіряє RPC, але тут ми можемо сказати це людською мовою). */
  const ids = input.items.map((i) => i.id);
  const { data: rows, error: rowsErr } = await supabase
    .from("queue_entries")
    .select("id, duration_min, status")
    .in("id", ids)
    .eq("room_id", roomId)
    .eq("scheduled_date", date);
  if (rowsErr) return { ok: false, error: safeDbError("applyDelayPlan.rows", rowsErr), code: "generic" };
  if ((rows?.length ?? 0) !== ids.length) {
    return { ok: false, error: "План застарів — перерахуйте", code: "stale" };
  }
  const durById = new Map((rows || []).map((r) => [r.id, r.duration_min ?? 30]));

  /* ⚠️ ПРАПОРЕЦЬ off_schedule РАХУЄ СЕРВЕР (канон 0077). Клієнтський прапорець —
     це лише «оператор погодився», а не «слот поза графіком». Якби ми писали в БД
     те, що надіслав клієнт, застаріла вкладка позначила б «поза графіком» цілком
     нормальний слот — або, гірше, НЕ позначила б реальний вихід за графік, і запис
     сів би за межі робочого дня без причини і без сліду в schedule_exceptions
     (гард trg_c_guard_off_schedule стріляє лише при off_schedule = true). */
  const plan: Array<Record<string, unknown>> = [];
  for (const it of input.items) {
    if (it.kind !== "shift") {
      plan.push({ id: it.id, kind: it.kind, from: it.from, to: null, offSchedule: false });
      continue;
    }
    if (!it.to) return { ok: false, error: "План застарів — перерахуйте", code: "stale" };

    let info: OffScheduleInfo | null;
    try {
      info = await scheduleGate(supabase, roomId, prof.clinic_id, date, it.to, durById.get(it.id) ?? 30);
    } catch {
      return SCHED_READ_ERR;   // fail-closed
    }
    // Обидва хелпери завжди повертають ok:false, але їх тип — ширший QueueActionResult
    // (з ok:true-варіантом бронювання). Звужуємо до false-гілки — вона структурно
    // збігається з ApplyDelayResult (той самий union кодів).
    if (info && !info.confirmable) return offSchedError(info) as QueueErrResult;       // закрито / до відкриття / далі +2 год
    if (info && !input.reason?.trim()) return offSchedNeedsConfirm(info) as QueueErrResult; // причина обовʼязкова (0078)

    plan.push({
      id: it.id,
      kind: "shift",
      from: it.from,
      to: it.to,
      offSchedule: !!info,
      offScheduleKind: info ? (info.kind === "break" ? "break" : "after_hours") : undefined,
    });
  }

  const { data, error } = await supabase.rpc("queue_apply_delay_plan_rpc", {
    p_room: roomId,
    p_source: input.sourceId,
    p_delay_min: input.delayMin,
    p_strategy: input.strategy,
    p_plan: plan as unknown as Json,
    p_expected: input.expected as unknown as Json,
    p_reason: input.reason?.trim() || null,
  });

  if (error) {
    // classifyError уже вміє транзиентні блокування (→ stale), OVERLAP/простій
    // (→ slot_unavailable) і сирі помилки (→ safeDbError). Наш P0001 «застосовано
    // не повністю» піде в generic — і це правильно: це баг, а не дія користувача.
    const res = classifyError(error);
    return res.ok
      ? { ok: false, error: "Не вдалося застосувати план", code: "generic" }
      : { ok: false, error: res.error, code: res.code };
  }

  const r = data?.[0];
  if (!r) return { ok: false, error: safeDbError("applyDelayPlan.empty", { message: "RPC повернула порожньо" }), code: "generic" };

  /* applied = false — це НЕ помилка, а «стан розійшовся зі знімком»: колега завів
     пацієнта в кабінет / скасував запис, поки адмін дивився preview. У БД при цьому
     не змінилось НІЧОГО (0081 тримає все-або-нічого). Доска має перерахувати план. */
  if (!r.applied) {
    return {
      ok: false,
      error: "Черга змінилася, поки ви дивилися план — перерахуйте",
      code: "stale",
      staleIds: r.stale_ids ?? [],
    };
  }

  /* 0128: журнал застосованого плану. entity — рядок queue_delay_events, id якого
     RPC повертає як event_id; якщо його раптом немає (r.event_id = null) — подію
     пропускаємо (без entityId писати нема чого), бізнес-результат незмінний. */
  if (r.event_id) {
    await emitImportantEvent({
      clinicId: prof.clinic_id,
      actorId: user.id,
      eventType: "queue.delay_plan_applied",
      entityType: "delay_plan",
      entityId: r.event_id,
      details: { shifted: r.moved, conflicts: r.flagged },
    });
  }

  return { ok: true, moved: r.moved, flagged: r.flagged, eventId: r.event_id };
}

/* ===== Крос-модальний кейс пацієнта (P1, дизайн: docs/plan/CROSS_MODAL_CASE.md) =====
   Кейс групує N записів РІЗНИХ модальностей одного пацієнта. Тонкі обгортки над
   RPC (0092/0093) — уся атомарність/ізоляція/інваріанти живуть у БД. Помилки кроків
   (0088/overlap/past/break/schedule/incident) маплять тим самим mapBookingError. */

const sCaseStep = z.object({
  roomId: zUuid,
  studies: sStudies,
  durationMin: zDuration,
  bufferTimeMin: zBuffer.optional(),
  priorityLevel: zPriority.optional(),
  scheduledDate: zDateKey,
  scheduledTime: zSlotTime,   // сітка 5 хв (техаудит High-1)
  contraindications: z.boolean().optional(),
  doctor: zOptText(200),
  note: zOptText(2000),
});

const sCase = z.object({
  patient: z.object({
    name: zName,
    phone: zOptText(32),
    email: zOptEmail,
    dob: zOptDob,
    sex: zOptText(16),
    age: zOptAge,
    weight: zOptWeight,
  }),
  referrerId: zUuid.nullish(),
  note: zOptText(2000),
  steps: z.array(sCaseStep).min(1).max(12),
});

export type CaseInput = z.infer<typeof sCase>;

/** Знімок пацієнта для p_case (спільний для персоналу і направника, 0118). */
function caseRpcPatient(input: CaseInput) {
  return {
    patient_name: input.patient.name,
    patient_phone: input.patient.phone ?? null,
    patient_email: input.patient.email ?? null,
    patient_dob: input.patient.dob ?? null,
    patient_sex: input.patient.sex ?? null,
    patient_age: input.patient.age ?? null,
    patient_weight: input.patient.weight ?? null,
    note: input.note ?? null,
  };
}

/** p_step для case-RPC (спільний для персоналу і направника, 0118). */
function caseRpcStep(s: CaseStepInput) {
  return {
    room_id: s.roomId,
    studies: s.studies,
    duration_min: s.durationMin,
    buffer_time_min: normBuffer(s.bufferTimeMin ?? BUFFER_DEFAULT),
    priority_level: normPriority(s.priorityLevel),
    scheduled_date: s.scheduledDate,
    scheduled_time: s.scheduledTime,
    contraindications: !!s.contraindications,
    doctor: s.doctor ?? null,
    note: s.note ?? null,
  };
}

/** Помилки RPC кейса: власні raise (FORBIDDEN/AUTH/BAD_INPUT/case_clinic_*) поверх
    booking-тригерів; решта — той самий маппінг, що й бронювання. */
function mapCaseError(message: string, code = ""): QueueActionResult {
  // 0118: направник може скасувати лише НЕстартований свій кейс.
  if (/^CASE_STARTED/i.test(message)) return { ok: false, error: "Кейс уже в роботі центру — скасувати може лише персонал", code: "forbidden" };
  if (/^FORBIDDEN/i.test(message)) return { ok: false, error: "Немає прав керувати кейсом у цьому центрі", code: "forbidden" };
  if (/^AUTH/i.test(message)) return { ok: false, error: "Не авторизовано", code: "auth" };
  if (/^BAD_INPUT/i.test(message)) return { ok: false, error: "Некоректний склад кейса", code: "generic" };
  if (/case_clinic_mismatch|case_not_found/i.test(message)) return { ok: false, error: "Кейс і крок у різних центрах", code: "forbidden" };
  // 0094/0095 — гарди складу кейса (час пацієнта / різні кабінети).
  { const ce = caseTriggerError(message); if (ce) return ce; }
  return mapBookingError(message, code);
}

/** Створити крос-модальний кейс: пацієнт + N кроків (модальність/кабінет/слот).
    Атомарно (create_case_rpc, 0093): будь-який крок-порушення → відкат усього. */
export async function createCase(raw: CaseInput): Promise<QueueActionResult> {
  const v = parseInput("createCase", sCase, raw);
  if (!v.ok) return v;
  const input = v.data;

  const supabase = await createClient();
  // 0128: актор журналу — user.id з перевіреної сесії (callerClinicId його не повертає).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Гейт закритих послуг — ОДИН load каталогу центру, далі чиста перевірка кожного
  // кроку проти його кабінету (уникаємо до 24 запитів на кейс). Fail-CLOSED.
  let caseCat: Catalog;
  try {
    caseCat = await loadClinicCatalog(supabase, clinicId);
  } catch (e) {
    if (e instanceof CatalogUnavailableError) return CATALOG_UNAVAILABLE_ERR;
    throw e;
  }
  for (const st of input.steps) {
    const c = firstClosedStudy(
      caseCat,
      st.studies as { type?: string | null; region?: string | null }[],
      st.roomId ?? undefined);
    if (c) return SERVICE_CLOSED_ERR(c);
  }

  const p_case = { ...caseRpcPatient(input), referrer_id: input.referrerId ?? null };
  const p_steps = input.steps.map(caseRpcStep);

  const { data, error } = await supabase.rpc("create_case_rpc", {
    p_case: p_case as unknown as Json,
    p_steps: p_steps as unknown as Json,
  });
  if (error) return mapCaseError(error.message, error.code ?? "");
  const caseId = (data as string) ?? undefined;
  /* 0128: журнал створення кейса. Кейс із направником (referrerId у p_case) —
     referral.case_created; у details — лише кількість кроків. */
  if (caseId) {
    const referral = Boolean(input.referrerId);
    await emitImportantEvent({
      clinicId,
      actorId: user.id,
      eventType: caseEventTypeFor("created", referral),
      entityType: "patient_case",
      entityId: caseId,
      subjectReferrerId: input.referrerId ?? null,
      details: { stepsCount: input.steps.length },
    });
  }
  return { ok: true, id: caseId };
}

export type CaseStepInput = z.infer<typeof sCaseStep>;

/** Додати ОДИН крок (інша модальність/кабінет) до вже створеного кейса
    (add_case_step_rpc, 0097). Пацієнт береться зі знімка кейса; інваріанти кейса
    (різні кабінети 0095, без перетину часу 0096) тримають тригери — та сама
    перевірка пересічень, що й при створенні. */
export async function addCaseStep(caseId: string, raw: CaseStepInput): Promise<QueueActionResult> {
  const idv = parseInput("addCaseStep.caseId", zUuid, caseId);
  if (!idv.ok) return idv;
  const v = parseInput("addCaseStep", sCaseStep, raw);
  if (!v.ok) return v;
  const s = v.data;

  const supabase = await createClient();
  // 0128: актор журналу — user.id з перевіреної сесії (callerClinicId його не повертає).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  // 0128: referrer_id/clinic_id кейса — для журналу; читаємо ДО мутації тим самим RLS-клієнтом.
  const { data: pc } = await supabase.from("patient_cases")
    .select("referrer_id, clinic_id").eq("id", idv.data).maybeSingle();

  const p_step = caseRpcStep(s);
  { const g = await closedRegionGate(supabase, clinicId, s.roomId, s.studies); if (g) return g; }
  const { data, error } = await supabase.rpc("add_case_step_rpc", {
    p_case_id: idv.data,
    p_step: p_step as unknown as Json,
  });
  if (error) return mapCaseError(error.message, error.code ?? "");
  const stepEntryId = (data as string) ?? undefined;
  // 0128: журнал кроку кейса — сутність = кейс; у details — id створеного запису-кроку та слот.
  if (pc?.clinic_id) {
    const referral = Boolean(pc.referrer_id);
    await emitImportantEvent({
      clinicId: pc.clinic_id,
      actorId: user.id,
      eventType: caseEventTypeFor("step_added", referral),
      entityType: "patient_case",
      entityId: idv.data,
      subjectReferrerId: pc.referrer_id ?? null,
      details: {
        queueEntryId: stepEntryId ?? null,
        roomId: s.roomId,
        scheduledDate: s.scheduledDate,
        scheduledTime: s.scheduledTime,
      },
    });
  } else {
    // §12.11 (ревʼю с25 L1): пропуск події не мовчить.
    logError({ event: "important_event.skipped", actorId: user.id,
      entityId: idv.data, errorCode: "pre_snapshot_unreadable", message: "type=case.step_added" });
  }
  return { ok: true, id: stepEntryId };
}

/** Організувати кейс із наявного запису черги: створити кейс (якщо його ще нема)
    зі знімка пацієнта запису, зробити запис кроком 1 і додати новий крок іншої
    модальності/кабінету (case_from_entry_rpc, 0098). Повертає id кейса. Ті самі
    гарди (різні кабінети 0095, без перетину часу 0096) — на тригерах. */
export async function caseFromEntry(entryId: string, raw: CaseStepInput): Promise<QueueActionResult> {
  const idv = parseInput("caseFromEntry.entryId", zUuid, entryId);
  if (!idv.ok) return idv;
  const v = parseInput("caseFromEntry", sCaseStep, raw);
  if (!v.ok) return v;
  const s = v.data;

  const supabase = await createClient();
  // 0128: актор журналу — user.id з перевіреної сесії (callerClinicId його не повертає).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };
  const clinicId = await callerClinicId(supabase);
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  // 0128: referrer_id вихідного запису — успадковується кейсом (вибір сімʼї
  // події referral.* проти case.*); читаємо ДО мутації тим самим RLS-клієнтом.
  const { data: srcEntry } = await supabase.from("queue_entries")
    .select("referrer_id, clinic_id").eq("id", idv.data).maybeSingle();

  const p_step = caseRpcStep(s);
  { const g = await closedRegionGate(supabase, clinicId, s.roomId, s.studies); if (g) return g; }
  const { data, error } = await supabase.rpc("case_from_entry_rpc", {
    p_entry_id: idv.data,
    p_step: p_step as unknown as Json,
  });
  if (error) return mapCaseError(error.message, error.code ?? "");
  const caseId = (data as string) ?? undefined;
  // 0128: журнал організації кейса з наявного запису — сутність = створений кейс.
  if (caseId) {
    const referral = Boolean(srcEntry?.referrer_id);
    await emitImportantEvent({
      clinicId: srcEntry?.clinic_id ?? clinicId,
      actorId: user.id,
      eventType: caseEventTypeFor("created", referral),
      entityType: "patient_case",
      entityId: caseId,
      subjectReferrerId: srcEntry?.referrer_id ?? null,
      details: { sourceEntryId: idv.data, stepsCount: 2 },
    });
  }
  return { ok: true, id: caseId };
}

/** Групове скасування кейса (cancel_case_rpc, 0092): desk, лише активні
    НЕ-in_progress кроки. Повертає ok; доска/екран кейса ресинкаються realtime. */
export async function cancelCase(caseId: string): Promise<QueueActionResult> {
  const v = parseInput("cancelCase", z.object({ caseId: zUuid }), { caseId });
  if (!v.ok) return v;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // 0128: referrer_id/clinic_id кейса — для журналу; читаємо ДО мутації тим самим RLS-клієнтом.
  const { data: pc } = await supabase.from("patient_cases")
    .select("referrer_id, clinic_id").eq("id", v.data.caseId).maybeSingle();

  const { data, error } = await supabase.rpc("cancel_case_rpc", { p_case_id: v.data.caseId });
  if (error) return mapCaseError(error.message, error.code ?? "");
  // 0128: журнал скасування кейса; RPC повертає кількість скасованих кроків.
  if (pc?.clinic_id) {
    const referral = Boolean(pc.referrer_id);
    await emitImportantEvent({
      clinicId: pc.clinic_id,
      actorId: user.id,
      eventType: caseEventTypeFor("cancelled", referral),
      entityType: "patient_case",
      entityId: v.data.caseId,
      subjectReferrerId: pc.referrer_id ?? null,
      details: { affectedSteps: typeof data === "number" ? data : 0 },
    });
  } else {
    // §12.11 (ревʼю с25 L1): пропуск події не мовчить.
    logError({ event: "important_event.skipped", actorId: user.id,
      entityId: v.data.caseId, errorCode: "pre_snapshot_unreadable", message: "type=case.cancelled" });
  }
  return { ok: true };
}

/* ===== 0118 — кейси НАПРАВНИКА (повний паритет; docs/plan/REFERRER_CASES.md) =====
   Тонкі referral-обгортки над ТИМИ САМИМИ case-RPC: справжню авторизацію (грант
   центру auth_can_refer, кабінети auth_referrer_can_book_room, власність кейса
   created_by/referrer_id) тримає гілка направника в RPC (0118). Тут — zod,
   дружні відмови ДО RPC (як у createReferralBooking) і fail-closed каталог-гейт
   (0112/0113). Клініка НЕ береться з профілю (у глобального направника NULL) —
   вона їде параметром і перевіряється грантом і в дії, і в БД. */

/** Активний грант направника на центр — або null (нема доступу). */
async function referralAccessFor(supabase: SupabaseClient<Database>, userId: string, clinicId: string) {
  const { data } = await supabase
    .from("referral_access")
    .select("status, room_ids")
    .eq("referrer_id", userId)
    .eq("clinic_id", clinicId)
    .eq("status", "active")
    .maybeSingle();
  return data ?? null;
}

/** Канон room_ids (0061): NULL/[] = усі кабінети центру. */
function refRoomAllowed(roomIds: string[] | null, roomId: string): boolean {
  return !roomIds || roomIds.length === 0 || roomIds.includes(roomId);
}

export type ReferralCaseInput = CaseInput & { clinicId: string };
const sReferralCase = sCase.extend({ clinicId: zUuid });

/** Створити кейс направником у авторизований центр (create_case_rpc, гілка 0118).
    referrer_id кейса RPC ставить примусово = auth.uid() — від свого імені. */
export async function createReferralCase(raw: ReferralCaseInput): Promise<QueueActionResult> {
  const v = parseInput("createReferralCase", sReferralCase, raw);
  if (!v.ok) return v;
  const input = v.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const access = await referralAccessFor(supabase, user.id, input.clinicId);
  if (!access) return { ok: false, error: "Немає активного доступу до центру", code: "forbidden" };
  for (const st of input.steps) {
    if (!refRoomAllowed(access.room_ids, st.roomId)) {
      return { ok: false, error: "Кабінет недоступний для вас", code: "forbidden" };
    }
  }

  // Гейт закритих послуг — ОДИН load каталогу центру (як у createCase). Fail-CLOSED.
  let caseCat: Catalog;
  try {
    caseCat = await loadClinicCatalog(supabase, input.clinicId);
  } catch (e) {
    if (e instanceof CatalogUnavailableError) return CATALOG_UNAVAILABLE_ERR;
    throw e;
  }
  for (const st of input.steps) {
    const c = firstClosedStudy(
      caseCat,
      st.studies as { type?: string | null; region?: string | null }[],
      st.roomId ?? undefined);
    if (c) return SERVICE_CLOSED_ERR(c);
  }

  const p_case = { ...caseRpcPatient(input), clinic_id: input.clinicId };
  const p_steps = input.steps.map(caseRpcStep);

  const { data, error } = await supabase.rpc("create_case_rpc", {
    p_case: p_case as unknown as Json,
    p_steps: p_steps as unknown as Json,
  });
  if (error) return mapCaseError(error.message, error.code ?? "");
  const caseId = (data as string) ?? undefined;
  // 0128: журнал — завжди referral.case_created; направник діє над своїм (subject = actor).
  if (caseId) {
    await emitImportantEvent({
      clinicId: input.clinicId,
      actorId: user.id,
      eventType: caseEventTypeFor("created", true),
      entityType: "patient_case",
      entityId: caseId,
      subjectReferrerId: user.id,
      details: { stepsCount: input.steps.length },
    });
  }
  return { ok: true, id: caseId };
}

/** Додати крок до СВОГО кейса направником (add_case_step_rpc, гілка 0118).
    clinicId — центр кейса (для гранту і каталог-гейта; БД звіряє з кейсом сама). */
export async function addReferralCaseStep(caseId: string, clinicId: string, raw: CaseStepInput): Promise<QueueActionResult> {
  const idv = parseInput("addReferralCaseStep.ids", z.object({ caseId: zUuid, clinicId: zUuid }), { caseId, clinicId });
  if (!idv.ok) return idv;
  const v = parseInput("addReferralCaseStep", sCaseStep, raw);
  if (!v.ok) return v;
  const s = v.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const access = await referralAccessFor(supabase, user.id, idv.data.clinicId);
  if (!access) return { ok: false, error: "Немає активного доступу до центру", code: "forbidden" };
  if (!refRoomAllowed(access.room_ids, s.roomId)) {
    return { ok: false, error: "Кабінет недоступний для вас", code: "forbidden" };
  }

  { const g = await closedRegionGate(supabase, idv.data.clinicId, s.roomId, s.studies); if (g) return g; }
  const { data, error } = await supabase.rpc("add_case_step_rpc", {
    p_case_id: idv.data.caseId,
    p_step: caseRpcStep(s) as unknown as Json,
  });
  if (error) return mapCaseError(error.message, error.code ?? "");
  const stepEntryId = (data as string) ?? undefined;
  /* 0128: журнал — завжди referral.case_step_added; направник діє над своїм
     (subject = actor). clinic_id події — З КЕЙСА в БД, НЕ з клієнтського
     параметра (ревʼю с25 M2: інакше можна покласти подію в журнал чужої
     клініки). Кейс свій — RLS його показує. */
  const { data: pcStep } = await supabase.from("patient_cases")
    .select("clinic_id").eq("id", idv.data.caseId).maybeSingle();
  if (pcStep?.clinic_id) {
    await emitImportantEvent({
      clinicId: pcStep.clinic_id,
      actorId: user.id,
      eventType: caseEventTypeFor("step_added", true),
      entityType: "patient_case",
      entityId: idv.data.caseId,
      subjectReferrerId: user.id,
      details: {
        queueEntryId: stepEntryId ?? null,
        roomId: s.roomId,
        scheduledDate: s.scheduledDate,
        scheduledTime: s.scheduledTime,
      },
    });
  } else {
    // §12.11: пропуск події не мовчить.
    logError({ event: "important_event.skipped", actorId: user.id,
      entityId: idv.data.caseId, errorCode: "case_clinic_unreadable",
      message: "type=referral.case_step_added" });
  }
  return { ok: true, id: stepEntryId };
}

/** Організувати кейс зі СВОГО запису направником (case_from_entry_rpc, гілка 0118). */
export async function referralCaseFromEntry(entryId: string, clinicId: string, raw: CaseStepInput): Promise<QueueActionResult> {
  const idv = parseInput("referralCaseFromEntry.ids", z.object({ entryId: zUuid, clinicId: zUuid }), { entryId, clinicId });
  if (!idv.ok) return idv;
  const v = parseInput("referralCaseFromEntry", sCaseStep, raw);
  if (!v.ok) return v;
  const s = v.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const access = await referralAccessFor(supabase, user.id, idv.data.clinicId);
  if (!access) return { ok: false, error: "Немає активного доступу до центру", code: "forbidden" };
  if (!refRoomAllowed(access.room_ids, s.roomId)) {
    return { ok: false, error: "Кабінет недоступний для вас", code: "forbidden" };
  }

  { const g = await closedRegionGate(supabase, idv.data.clinicId, s.roomId, s.studies); if (g) return g; }
  const { data, error } = await supabase.rpc("case_from_entry_rpc", {
    p_entry_id: idv.data.entryId,
    p_step: caseRpcStep(s) as unknown as Json,
  });
  if (error) return mapCaseError(error.message, error.code ?? "");
  const caseId = (data as string) ?? undefined;
  /* 0128: журнал — завжди referral.case_created; направник діє над своїм
     (subject = actor). clinic_id події — З СТВОРЕНОГО КЕЙСА в БД, НЕ з
     клієнтського параметра (ревʼю с25 M2). */
  if (caseId) {
    const { data: pcNew } = await supabase.from("patient_cases")
      .select("clinic_id").eq("id", caseId).maybeSingle();
    if (pcNew?.clinic_id) {
      await emitImportantEvent({
        clinicId: pcNew.clinic_id,
        actorId: user.id,
        eventType: caseEventTypeFor("created", true),
        entityType: "patient_case",
        entityId: caseId,
        subjectReferrerId: user.id,
        details: { sourceEntryId: idv.data.entryId, stepsCount: 2 },
      });
    } else {
      logError({ event: "important_event.skipped", actorId: user.id,
        entityId: caseId, errorCode: "case_clinic_unreadable",
        message: "type=referral.case_created" });
    }
  }
  return { ok: true, id: caseId };
}

/** Скасувати СВІЙ нестартований кейс направником (cancel_case_rpc, гілка 0118).
    Стартований (in_progress/done/no_show/not_held) — CASE_STARTED від БД. */
export async function cancelReferralCase(caseId: string): Promise<QueueActionResult> {
  const v = parseInput("cancelReferralCase", z.object({ caseId: zUuid }), { caseId });
  if (!v.ok) return v;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  /* 0128: clinic_id кейса — для журналу (у глобального направника в профілі
     клініки немає); читаємо СВІЙ кейс ДО мутації тим самим RLS-клієнтом. */
  const { data: pc } = await supabase.from("patient_cases")
    .select("clinic_id").eq("id", v.data.caseId).maybeSingle();

  const { data, error } = await supabase.rpc("cancel_case_rpc", { p_case_id: v.data.caseId });
  if (error) return mapCaseError(error.message, error.code ?? "");
  // 0128: журнал — завжди referral.case_cancelled; направник діє над своїм (subject = actor).
  if (pc?.clinic_id) {
    await emitImportantEvent({
      clinicId: pc.clinic_id,
      actorId: user.id,
      eventType: caseEventTypeFor("cancelled", true),
      entityType: "patient_case",
      entityId: v.data.caseId,
      subjectReferrerId: user.id,
      details: { affectedSteps: typeof data === "number" ? data : 0 },
    });
  } else {
    // §12.11 (ревʼю с25 L1): пропуск події не мовчить.
    logError({ event: "important_event.skipped", actorId: user.id,
      entityId: v.data.caseId, errorCode: "pre_snapshot_unreadable", message: "type=referral.case_cancelled" });
  }
  return { ok: true };
}
