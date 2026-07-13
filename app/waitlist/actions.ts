"use server";

// Server Actions листа очікування (патерн TD-4, як app/queue/actions.ts):
// мутації виконуються на сервері з перевіркою сесії/ролі; RLS на
// waitlist_entries (0047) лишається defense-in-depth. Синхронізація між
// клієнтами — realtime (postgres_changes), revalidate не потрібен.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, TablesUpdate, WaitlistStatus } from "@/supabase/types";
import { BUFFER_DEFAULT, normBuffer, type Study } from "@/lib/studies";
import { normPriority, type PatientPriority } from "@/lib/priority";
import { modalityFromStudies } from "@/lib/waitlist";
import {
  parseInput, safeDbError, zUuid, zDateKey, zTime, zName, zOptText, zOptEmail,
  zOptDob, zOptAge, zOptWeight, PATIENT_AGE_MAX, PATIENT_WEIGHT_MAX,
  zDuration, zBuffer, zPriority, zStudies,
} from "@/lib/validation";

/* ===== Схеми входу (M-12) — див. lib/validation.ts =====
   Раніше вхід перевірявся лише на «є ПІБ / є id»; усе інше (дати бажаного вікна,
   час "HH:MM", тривалість, склад досліджень) їхало в БД як прийшло. */
const sWaitlistInput = z.object({
  clinicId: zUuid.nullish(),
  roomId: zUuid.nullish(),
  name: zName,
  phone: zOptText(32),
  email: zOptEmail,
  dob: zOptDob,
  sex: zOptText(16),
  age: zOptAge,
  weight: zOptWeight,
  priorityLevel: zPriority.optional(),
  studies: zStudies,
  durationMin: zDuration,
  bufferTimeMin: zBuffer.optional(),
  desiredDateFrom: z.union([zDateKey, z.literal(""), z.null(), z.undefined()]).transform((v) => v || null),
  desiredDateTo: z.union([zDateKey, z.literal(""), z.null(), z.undefined()]).transform((v) => v || null),
  desiredTimeFrom: z.union([zTime, z.literal(""), z.null(), z.undefined()]).transform((v) => v || null),
  desiredTimeTo: z.union([zTime, z.literal(""), z.null(), z.undefined()]).transform((v) => v || null),
  note: zOptText(2000),
  sourceEntryId: zUuid.nullish(),
});

/* Патч рядка листа: колонки БД (як їх шле WaitlistBoard). Усі поля .optional() —
   відсутній ключ має лишитись відсутнім, інакше патч затер би колонку в null. */
const sWaitlistPatch = z.object({
  patient_name: zName.optional(),
  patient_phone: z.union([z.string().trim().max(32), z.null()]).optional(),
  patient_email: z.union([z.string().trim().max(254), z.null()]).optional(),
  patient_dob: z.union([zDateKey, z.literal(""), z.null()]).optional(),
  patient_sex: z.union([z.string().trim().max(16), z.null()]).optional(),
  patient_age: z.union([z.number().int().min(0).max(PATIENT_AGE_MAX), z.null()]).optional(),
  patient_weight: z.union([z.number().finite().min(0).max(PATIENT_WEIGHT_MAX), z.null()]).optional(),
  studies: zStudies.optional(),
  duration_min: zDuration.optional(),
  buffer_time_min: zBuffer.optional(),
  desired_date_from: z.union([zDateKey, z.literal(""), z.null()]).optional(),
  desired_date_to: z.union([zDateKey, z.literal(""), z.null()]).optional(),
  desired_time_from: z.union([zTime, z.literal(""), z.null()]).optional(),
  desired_time_to: z.union([zTime, z.literal(""), z.null()]).optional(),
  note: z.union([z.string().trim().max(2000), z.null()]).optional(),
  room_id: z.union([zUuid, z.null()]).optional(),
});

export type WaitlistActionResult =
  | { ok: true; id?: string }
  // 'stale' — CAS не спрацював: рядок уже змінив стан (напр. кандидата встиг
  // записати інший адміністратор). UI має оновитись, а не мовчки перетерти.
  | { ok: false; error: string; code?: "forbidden" | "auth" | "duplicate" | "stale" | "generic" };

async function callerProfile(supabase: SupabaseClient<Database>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profiles").select("clinic_id, role").eq("id", user.id).maybeSingle();
  if (!data) return null;
  return { userId: user.id, clinicId: data.clinic_id, role: data.role };
}

export type WaitlistInput = {
  clinicId?: string | null; // направник передає центр; персонал — визначається з сервера
  roomId?: string | null; // опційна жорстка прив'язка до кабінету (guard 0051: має бути того ж центру)
  name: string;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  sex?: string | null;
  age?: number | null;
  weight?: number | null;
  priorityLevel?: PatientPriority;
  studies: Json;
  durationMin: number;
  bufferTimeMin?: number;
  desiredDateFrom?: string | null; // YYYY-MM-DD
  desiredDateTo?: string | null;
  desiredTimeFrom?: string | null; // HH:MM
  desiredTimeTo?: string | null;
  note?: string | null;
  sourceEntryId?: string | null; // якщо доданий з наявного запису черги
};

/** Додати пацієнта до листа очікування (новий або з наявного запису).
    Персонал — свій центр; направник — авторизований центр (referral_access). */
export async function addWaitlistEntry(raw: WaitlistInput): Promise<WaitlistActionResult> {
  const v = parseInput("addWaitlistEntry", sWaitlistInput, raw);
  if (!v.ok) return v;
  const input = v.data;

  const supabase = await createClient();
  const caller = await callerProfile(supabase);
  if (!caller) return { ok: false, error: "Не авторизовано", code: "auth" };

  let clinicId: string | null = null;
  let referrerId: string | null = null;

  if (caller.role === "referrer") {
    if (!input.clinicId) return { ok: false, error: "Не вказано центр", code: "generic" };
    const { data: access } = await supabase
      .from("referral_access")
      .select("status")
      .eq("referrer_id", caller.userId)
      .eq("clinic_id", input.clinicId)
      .eq("status", "active")
      .maybeSingle();
    if (!access) return { ok: false, error: "Немає активного доступу до центру", code: "forbidden" };
    clinicId = input.clinicId;
    referrerId = caller.userId;
  } else {
    clinicId = caller.clinicId;
  }
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data, error } = await supabase
    .from("waitlist_entries")
    .insert({
      clinic_id: clinicId,
      room_id: input.roomId ?? null,
      source_entry_id: input.sourceEntryId ?? null,
      patient_name: input.name,
      patient_phone: input.phone,
      patient_email: input.email,
      patient_dob: input.dob,
      patient_sex: input.sex,
      patient_age: input.age ?? null,
      patient_weight: input.weight ?? null,
      studies: input.studies as unknown as Json,
      duration_min: input.durationMin,   // H-1 + M-12: схема дала кратне 5 у [5,480]
      buffer_time_min: normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT),
      modality: modalityFromStudies(input.studies as Study[] | null),
      priority_level: normPriority(input.priorityLevel),
      desired_date_from: input.desiredDateFrom,
      desired_date_to: input.desiredDateTo,
      desired_time_from: input.desiredTimeFrom,
      desired_time_to: input.desiredTimeTo,
      note: input.note,
      referrer_id: referrerId,
      created_by: caller.userId,
      status: "waiting",
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: safeDbError("addWaitlistEntry", error), code: "generic" };
  return { ok: true, id: data.id };
}

/** Додати до листа наявного пацієнта з черги (копія полів + source_entry_id). */
export async function addEntryToWaitlist(
  entryId: string,
  opts?: Pick<WaitlistInput, "desiredDateFrom" | "desiredDateTo" | "desiredTimeFrom" | "desiredTimeTo" | "note">
): Promise<WaitlistActionResult> {
  const v = parseInput("addEntryToWaitlist", z.object({
    entryId: zUuid,
    opts: sWaitlistInput
      .pick({ desiredDateFrom: true, desiredDateTo: true, desiredTimeFrom: true, desiredTimeTo: true, note: true })
      .partial()
      .optional(),
  }), { entryId, opts });
  if (!v.ok) return v;
  entryId = v.data.entryId;
  opts = v.data.opts as typeof opts;

  const supabase = await createClient();
  const caller = await callerProfile(supabase);
  if (!caller) return { ok: false, error: "Не авторизовано", code: "auth" };

  // RLS: персонал бачить записи свого центру, направник — лише власні.
  const { data: entry } = await supabase
    .from("queue_entries")
    .select("id, clinic_id, referrer_id, patient_name, patient_phone, patient_email, patient_dob, patient_sex, patient_age, patient_weight, studies, duration_min, buffer_time_min, priority_level, note")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };

  // Захист від дубля: пацієнт із цього запису вже чекає.
  const { data: dup } = await supabase
    .from("waitlist_entries")
    .select("id")
    .eq("source_entry_id", entryId)
    .eq("status", "waiting")
    .maybeSingle();
  if (dup) return { ok: false, error: "Пацієнт уже в листі очікування", code: "duplicate" };

  const { data, error } = await supabase
    .from("waitlist_entries")
    .insert({
      clinic_id: entry.clinic_id,
      source_entry_id: entry.id,
      patient_name: entry.patient_name,
      patient_phone: entry.patient_phone,
      patient_email: entry.patient_email,
      patient_dob: entry.patient_dob,
      patient_sex: entry.patient_sex,
      patient_age: entry.patient_age,
      patient_weight: entry.patient_weight,
      studies: entry.studies,
      duration_min: entry.duration_min,
      buffer_time_min: entry.buffer_time_min,
      modality: modalityFromStudies(entry.studies as Study[] | null),
      priority_level: entry.priority_level,
      desired_date_from: opts?.desiredDateFrom || null,
      desired_date_to: opts?.desiredDateTo || null,
      desired_time_from: opts?.desiredTimeFrom || null,
      desired_time_to: opts?.desiredTimeTo || null,
      note: opts?.note ?? entry.note,
      referrer_id: entry.referrer_id,
      created_by: caller.userId,
      status: "waiting",
    })
    .select("id")
    .single();

  if (error) {
    // Гонку паралельних додавань закриває unique-індекс waitlist_source_waiting_uniq.
    if (/duplicate|unique|23505/i.test(error.message)) {
      return { ok: false, error: "Пацієнт уже в листі очікування", code: "duplicate" };
    }
    return { ok: false, error: safeDbError("addEntryToWaitlist", error), code: "generic" };
  }
  return { ok: true, id: data.id };
}

/** Редагування рядка листа. Пріоритет і статус — ЛИШЕ через окремі дії
    (setWaitlistPriority / setWaitlistStatus / markWaitlistScheduled).
    Allowlist колонок тепер задає СХЕМА sWaitlistPatch: невідомі ключі відкидаються,
    а значення (дати, "HH:MM", тривалість) нарешті перевіряються — раніше allowlist
    пропускав у дозволену колонку будь-яке сміття. */
export async function updateWaitlistEntry(
  id: string,
  patch: TablesUpdate<"waitlist_entries">
): Promise<WaitlistActionResult> {
  const v = parseInput("updateWaitlistEntry", z.object({ id: zUuid, patch: sWaitlistPatch }), { id, patch });
  if (!v.ok) return v;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const safePatch: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v.data.patch)) {
    if (val === undefined) continue;
    safePatch[k] = val === "" ? null : val;   // "" не має лягати в дату/час
  }
  if (Object.keys(safePatch).length === 0) return { ok: true };
  if (safePatch.studies !== undefined) {
    // Модальність — похідна від складу досліджень, рахуємо на сервері.
    safePatch.modality = modalityFromStudies(safePatch.studies as Study[] | null);
  }

  const { data, error } = await supabase
    .from("waitlist_entries")
    .update(safePatch as TablesUpdate<"waitlist_entries">)
    .eq("id", v.data.id)
    .select("id");
  if (error) return { ok: false, error: safeDbError("updateWaitlistEntry", error), code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Пріоритет у листі: лише адмін або направник-власник (як setQueuePriority; дублює DB-guard). */
export async function setWaitlistPriority(id: string, priority: PatientPriority): Promise<WaitlistActionResult> {
  const v = parseInput("setWaitlistPriority", z.object({ id: zUuid, priority: zPriority }), { id, priority });
  if (!v.ok) return v;
  id = v.data.id;
  const level = v.data.priority;

  const supabase = await createClient();
  const caller = await callerProfile(supabase);
  if (!caller) return { ok: false, error: "Не авторизовано", code: "auth" };

  const { data: row } = await supabase.from("waitlist_entries").select("referrer_id").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  const isAdmin = caller.role === "admin";
  const isOwnerReferrer = row.referrer_id != null && row.referrer_id === caller.userId;
  if (!isAdmin && !isOwnerReferrer) {
    return { ok: false, error: "Змінювати пріоритет може адміністратор або лікар-направник", code: "forbidden" };
  }

  const { data, error } = await supabase.from("waitlist_entries").update({ priority_level: level }).eq("id", id).select("id");
  if (error) return { ok: false, error: safeDbError("setWaitlistPriority", error), code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Зняти з листа (cancelled) або повернути в очікування (waiting). */
export async function setWaitlistStatus(id: string, status: WaitlistStatus): Promise<WaitlistActionResult> {
  const v = parseInput("setWaitlistStatus", z.object({
    id: zUuid,
    status: z.enum(["waiting", "cancelled"]),   // 'scheduled' — лише через markWaitlistScheduled
  }), { id, status });
  if (!v.ok) return v;
  id = v.data.id;
  status = v.data.status;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const patch: TablesUpdate<"waitlist_entries"> =
    status === "waiting" ? { status, scheduled_entry_id: null } : { status };
  const { data, error } = await supabase.from("waitlist_entries").update(patch).eq("id", id).select("id");
  if (error) return { ok: false, error: safeDbError("setWaitlistStatus", error), code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Позначити «перенесено у слот»: status=scheduled + посилання на створений запис черги. */
export async function markWaitlistScheduled(id: string, scheduledEntryId?: string | null): Promise<WaitlistActionResult> {
  const v = parseInput("markWaitlistScheduled", z.object({
    id: zUuid, scheduledEntryId: zUuid.nullish(),
  }), { id, scheduledEntryId });
  if (!v.ok) return v;
  id = v.data.id;
  scheduledEntryId = v.data.scheduledEntryId;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Валідація посилання: запис черги має бути видимим викликачу (RLS) і належати
  // тому ж центру, що й рядок листа (FK перевіряється повз RLS — не покладаємось).
  let entryRef: string | null = null;
  if (scheduledEntryId) {
    const [{ data: wlRow }, { data: qEntry }] = await Promise.all([
      supabase.from("waitlist_entries").select("clinic_id").eq("id", id).maybeSingle(),
      supabase.from("queue_entries").select("id, clinic_id").eq("id", scheduledEntryId).maybeSingle(),
    ]);
    if (!wlRow) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
    if (!qEntry || qEntry.clinic_id !== wlRow.clinic_id) {
      return { ok: false, error: "Невірне посилання на запис черги", code: "forbidden" };
    }
    entryRef = qEntry.id;
  }

  /* CAS: позначити «перенесено у слот» можна лише кандидата, який ЩЕ чекає.
     Раніше два адміністратори могли взяти того самого кандидата на два різні
     слоти: обидва створювали запис у черзі, обидва писали 'scheduled', і
     посилання scheduled_entry_id мовчки перетиралось другим — перший слот
     лишався за пацієнтом, але лист про нього «забував». */
  const { data, error } = await supabase
    .from("waitlist_entries")
    .update({ status: "scheduled", scheduled_entry_id: entryRef })
    .eq("id", id)
    .eq("status", "waiting")
    .select("id");
  if (error) return { ok: false, error: safeDbError("markWaitlistScheduled", error), code: "generic" };
  if (!data || data.length === 0) {
    const { data: cur } = await supabase.from("waitlist_entries")
      .select("status, scheduled_entry_id").eq("id", id).maybeSingle();
    if (!cur) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
    /* Ідемпотентність перевіряємо по ПОСИЛАННЮ, а не по статусу. Інакше гонка
       двох адміністраторів (обидва вже створили ЗАПИС у черзі) виглядала б як
       успіх у другого: лист уже 'scheduled' — «ok» — а пацієнт задвоєний у черзі,
       і ніхто про це не сказав. Той самий entryRef = ретрай/подвійний клік. */
    if (cur.status === "scheduled" && (entryRef == null || cur.scheduled_entry_id === entryRef)) {
      return { ok: true };
    }
    if (cur.status === "scheduled") {
      return { ok: false, error: "Кандидата вже записав інший оператор — перевірте лист", code: "stale" };
    }
    return { ok: false, error: "Кандидата вже знято з листа — оновіть сторінку", code: "stale" };
  }
  return { ok: true };
}
