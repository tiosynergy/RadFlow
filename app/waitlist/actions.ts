"use server";

// Server Actions листа очікування (патерн TD-4, як app/queue/actions.ts):
// мутації виконуються на сервері з перевіркою сесії/ролі; RLS на
// waitlist_entries (0047) лишається defense-in-depth. Синхронізація між
// клієнтами — realtime (postgres_changes), revalidate не потрібен.

import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, TablesUpdate, WaitlistStatus } from "@/supabase/types";
import { BUFFER_DEFAULT, normBuffer, normDur, type Study } from "@/lib/studies";
import { normPriority, type PatientPriority } from "@/lib/priority";
import { modalityFromStudies } from "@/lib/waitlist";

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
export async function addWaitlistEntry(input: WaitlistInput): Promise<WaitlistActionResult> {
  if (!input?.name?.trim()) return { ok: false, error: "Не вказано ПІБ пацієнта", code: "generic" };
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
      patient_name: input.name.trim(),
      patient_phone: input.phone || null,
      patient_email: input.email ?? null,
      patient_dob: input.dob || null,
      patient_sex: input.sex || null,
      patient_age: input.age ?? null,
      patient_weight: input.weight ?? null,
      studies: input.studies,
      duration_min: normDur(input.durationMin),   // H-1: кратно 5, 5..480 (CHECK 0066)
      buffer_time_min: normBuffer(input.bufferTimeMin ?? BUFFER_DEFAULT),
      modality: modalityFromStudies(input.studies as Study[] | null),
      priority_level: normPriority(input.priorityLevel),
      desired_date_from: input.desiredDateFrom || null,
      desired_date_to: input.desiredDateTo || null,
      desired_time_from: input.desiredTimeFrom || null,
      desired_time_to: input.desiredTimeTo || null,
      note: input.note ?? null,
      referrer_id: referrerId,
      created_by: caller.userId,
      status: "waiting",
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message, code: "generic" };
  return { ok: true, id: data.id };
}

/** Додати до листа наявного пацієнта з черги (копія полів + source_entry_id). */
export async function addEntryToWaitlist(
  entryId: string,
  opts?: Pick<WaitlistInput, "desiredDateFrom" | "desiredDateTo" | "desiredTimeFrom" | "desiredTimeTo" | "note">
): Promise<WaitlistActionResult> {
  if (!entryId) return { ok: false, error: "Невірний запис", code: "generic" };
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
    return { ok: false, error: error.message, code: "generic" };
  }
  return { ok: true, id: data.id };
}

// Generic-патч листа: явний ALLOWLIST колонок (типи TS не захищають server action
// від довільного JSON з клієнта — blocklist пропускав би id/source_entry_id/created_at).
const WAITLIST_PATCH_ALLOWED = [
  "patient_name", "patient_phone", "patient_email", "patient_dob", "patient_sex",
  "patient_age", "patient_weight", "studies", "duration_min", "buffer_time_min",
  "desired_date_from", "desired_date_to", "desired_time_from", "desired_time_to", "note",
  "room_id",
] as const;

/** Редагування рядка листа. Пріоритет і статус — ЛИШЕ через окремі дії
    (setWaitlistPriority / setWaitlistStatus / markWaitlistScheduled). */
export async function updateWaitlistEntry(
  id: string,
  patch: TablesUpdate<"waitlist_entries">
): Promise<WaitlistActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const safePatch: TablesUpdate<"waitlist_entries"> = {};
  for (const k of WAITLIST_PATCH_ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      (safePatch as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
  }
  if (Object.keys(safePatch).length === 0) return { ok: true };
  if (safePatch.buffer_time_min != null) safePatch.buffer_time_min = normBuffer(safePatch.buffer_time_min);
  if (safePatch.duration_min != null) safePatch.duration_min = normDur(safePatch.duration_min); // H-1 (CHECK 0066)
  if (safePatch.studies !== undefined) {
    // Модальність — похідна від складу досліджень, рахуємо на сервері.
    safePatch.modality = modalityFromStudies(safePatch.studies as Study[] | null);
  }

  const { data, error } = await supabase.from("waitlist_entries").update(safePatch).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Пріоритет у листі: лише адмін або направник-власник (як setQueuePriority; дублює DB-guard). */
export async function setWaitlistPriority(id: string, priority: PatientPriority): Promise<WaitlistActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  const level = normPriority(priority);
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
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Зняти з листа (cancelled) або повернути в очікування (waiting). */
export async function setWaitlistStatus(id: string, status: WaitlistStatus): Promise<WaitlistActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
  if (status !== "cancelled" && status !== "waiting") {
    return { ok: false, error: "Невідомий статус", code: "generic" };
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  const patch: TablesUpdate<"waitlist_entries"> =
    status === "waiting" ? { status, scheduled_entry_id: null } : { status };
  const { data, error } = await supabase.from("waitlist_entries").update(patch).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message, code: "generic" };
  if (!data || data.length === 0) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Позначити «перенесено у слот»: status=scheduled + посилання на створений запис черги. */
export async function markWaitlistScheduled(id: string, scheduledEntryId?: string | null): Promise<WaitlistActionResult> {
  if (!id) return { ok: false, error: "Невірний запис", code: "generic" };
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
  if (error) return { ok: false, error: error.message, code: "generic" };
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
