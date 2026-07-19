"use server";

// Server Actions листа очікування (патерн TD-4, як app/queue/actions.ts):
// мутації виконуються на сервері з перевіркою сесії/ролі; RLS на
// waitlist_entries (0047) лишається defense-in-depth. Синхронізація між
// клієнтами — realtime (postgres_changes), revalidate не потрібен.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, TablesUpdate, WaitlistStatus } from "@/supabase/types";
import { BUFFER_DEFAULT, hasBookableStudy, normBuffer, type Study } from "@/lib/studies";
import { normPriority, type PatientPriority } from "@/lib/priority";
import { modalityFromStudies } from "@/lib/waitlist";
import { wallDayKey } from "@/lib/incidents";
import { firstClosedService, studiesKeySet, CatalogUnavailableError } from "@/lib/serviceGate";
import {
  parseInput, safeDbError, zUuid, zDateKey, zTime, zName, zOptText, zOptEmail,
  zOptDob, zOptAge, zOptWeight, PATIENT_AGE_MAX, PATIENT_WEIGHT_MAX,
  zDuration, zBuffer, zPriority, zStudiesRequired,
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
  studies: zStudiesRequired,
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
  studies: zStudiesRequired.optional(),
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

/* Defense-in-depth (High): послуга вимкнена в каталозі центру / прихована в кабінеті. */
const SERVICE_CLOSED_WL = (region: string): WaitlistActionResult => ({
  ok: false, error: `Послуга «${region}» вимкнена в центрі або кабінеті — оновіть форму`, code: "generic",
});
// Fail-CLOSED: збій читання каталогу → відмова у записі (а не легасі-фолбэк).
const CATALOG_UNAVAILABLE_WL: WaitlistActionResult = {
  ok: false, error: "Каталог послуг тимчасово недоступний — спробуйте ще раз", code: "generic",
};
/** Гейт закритих послуг листа очікування з fail-CLOSED (дзеркало closedRegionGate). */
async function closedRegionGateWL(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  roomId: string | null | undefined,
  studies: { type?: string | null; region?: string | null }[] | null | undefined,
  grandfather?: ReadonlySet<string>,
): Promise<WaitlistActionResult | null> {
  try {
    const closed = await firstClosedService(supabase, clinicId, roomId, studies, grandfather);
    return closed ? SERVICE_CLOSED_WL(closed) : null;
  } catch (e) {
    if (e instanceof CatalogUnavailableError) return CATALOG_UNAVAILABLE_WL;
    throw e;
  }
}

/* Серверний гард «бажане вікно вже минуло» (defense-in-depth до клієнтського в
   WaitlistModal). Стягуюча умова — на КІНЕЦЬ вікна: якщо desired_date_to цілком у
   минулому, жоден майбутній слот не потрапить у [from, to] і пацієнт вічно висить
   у «Очікують». «Сьогодні» — доба КЛІНІКИ (canon: wallDayKey(clinics.timezone),
   на сервері singleton не виставлений, тож зону передаємо явно). */
const PAST_WINDOW = {
  ok: false as const,
  error: "Кінець бажаного вікна вже минув — оберіть майбутню дату",
  code: "generic" as const,
};
async function clinicTodayKey(supabase: SupabaseClient<Database>, clinicId: string): Promise<string> {
  const { data } = await supabase.from("clinics").select("timezone").eq("id", clinicId).maybeSingle();
  return wallDayKey(data?.timezone || "UTC");
}

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

/** Чи доступна направнику модальність у центрі за його грантом.
    roomIds = null → усі кабінети центру; інакше — лише перелічені. Модальність
    дозволена, якщо серед доступних кабінетів є хоч один цієї модальності.
    RLS-клієнт: направник бачить кабінети центрів, до яких має referral_access. */
async function referrerModalityAllowed(
  supabase: SupabaseClient<Database>, clinicId: string, roomIds: string[] | null, modality: string,
): Promise<boolean> {
  let q = supabase.from("rooms").select("modality").eq("clinic_id", clinicId);
  if (roomIds && roomIds.length) q = q.in("id", roomIds);
  const { data } = await q;
  return (data || []).some((r) => r.modality === modality);
}

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
      .select("status, room_ids")
      .eq("referrer_id", caller.userId)
      .eq("clinic_id", input.clinicId)
      .eq("status", "active")
      .maybeSingle();
    if (!access) return { ok: false, error: "Немає активного доступу до центру", code: "forbidden" };
    // Бізнес-обмеження гранту: направник може завести в лист лише модальність,
    // до кабінетів якої має доступ (room_ids; null = усі кабінети центру). Пряма
    // запис фільтрується по room_ids, лист очікування — раніше НІ (показував усі
    // 5 модальностей і давав завести напр. мамографію там, де доступ лише МРТ).
    const grantRooms = access.room_ids as string[] | null;
    const entryMod = modalityFromStudies(input.studies as Study[] | null);
    if (!(await referrerModalityAllowed(supabase, input.clinicId, grantRooms, entryMod))) {
      return { ok: false, error: "Ця модальність недоступна за вашим доступом до центру", code: "forbidden" };
    }
    // Якщо направник жорстко привʼязав кабінет — він теж має бути в його гранті
    // (null/[] = усі). Захист від крафтового запиту повз UI (портал кабінети не показує).
    if (input.roomId && grantRooms && grantRooms.length > 0 && !grantRooms.includes(input.roomId)) {
      return { ok: false, error: "Кабінет недоступний для вас", code: "forbidden" };
    }
    clinicId = input.clinicId;
    referrerId = caller.userId;
  } else {
    clinicId = caller.clinicId;
  }
  if (!clinicId) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Бажане вікно цілком у минулому → пацієнт не потрапить у підбір (див. PAST_WINDOW).
  if (input.desiredDateTo && input.desiredDateTo < await clinicTodayKey(supabase, clinicId)) return PAST_WINDOW;

  // Гейт закритих послуг: лист не завжди привʼязаний до кабінету (roomId=null →
  // база центру). Легасі-модальність (без каталогу) не чіпаємо.
  { const g = await closedRegionGateWL(supabase, clinicId, input.roomId ?? null, input.studies); if (g) return g; }

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

  // Новий рядок листа — це НОВА запис: склад мусить мати ≥1 дослідження з каталожною
  // модальністю (не порожній/без типу — інакше modalityFromStudies мовчки дав би MRI).
  // Легасі-джерело без валідного типу відсікаємо тут, дзеркало zStudiesRequired.
  if (!hasBookableStudy(entry.studies as Study[] | null)) {
    return { ok: false, error: "У записі немає дослідження з валідним типом", code: "generic" };
  }

  // Захист від дубля: пацієнт із цього запису вже чекає.
  const { data: dup } = await supabase
    .from("waitlist_entries")
    .select("id")
    .eq("source_entry_id", entryId)
    .eq("status", "waiting")
    .maybeSingle();
  if (dup) return { ok: false, error: "Пацієнт уже в листі очікування", code: "duplicate" };

  if (opts?.desiredDateTo && entry.clinic_id
      && opts.desiredDateTo < await clinicTodayKey(supabase, entry.clinic_id)) return PAST_WINDOW;

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
    (setWaitlistPriority / setWaitlistStatus; 'scheduled' — через scheduleFromWaitlist).
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
  const caller = await callerProfile(supabase);
  if (!caller) return { ok: false, error: "Не авторизовано", code: "auth" };

  const safePatch: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v.data.patch)) {
    if (val === undefined) continue;
    safePatch[k] = val === "" ? null : val;   // "" не має лягати в дату/час
  }
  if (Object.keys(safePatch).length === 0) return { ok: true };
  // Модальність — похідна від складу досліджень, рахуємо на сервері.
  const newMod = safePatch.studies !== undefined ? modalityFromStudies(safePatch.studies as Study[] | null) : undefined;
  if (newMod !== undefined) safePatch.modality = newMod;

  /* Грант направника: перевіряємо і МОДАЛЬНІСТЬ (при зміні складу), і КАБІНЕТ (при
     зміні room_id) — раніше room_id узагалі не перевірявся, тож крафтовий запит міг
     проставити кабінет ПОЗА грантом (модальність збігалась → проходило). Дзеркало
     перевірки на вставці createWaitlistEntry. RLS-політика — останній рубіж (0101).
     Персоналу — свій центр, обмежень тут немає. */
  if (caller.role === "referrer" && (newMod !== undefined || safePatch.room_id !== undefined)) {
    const { data: row } = await supabase.from("waitlist_entries").select("clinic_id").eq("id", v.data.id).maybeSingle();
    if (!row?.clinic_id) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
    const { data: access } = await supabase.from("referral_access")
      .select("room_ids").eq("referrer_id", caller.userId).eq("clinic_id", row.clinic_id).eq("status", "active").maybeSingle();
    if (!access) return { ok: false, error: "Немає активного доступу до центру", code: "forbidden" };
    const grantRooms = access.room_ids as string[] | null;
    if (newMod !== undefined && !(await referrerModalityAllowed(supabase, row.clinic_id, grantRooms, newMod))) {
      return { ok: false, error: "Ця модальність недоступна за вашим доступом до центру", code: "forbidden" };
    }
    // Кабінет у патчі (не null) має бути в гранті (null/[] = усі кабінети центру).
    if (safePatch.room_id != null && grantRooms && grantRooms.length > 0 && !grantRooms.includes(safePatch.room_id as string)) {
      return { ok: false, error: "Кабінет недоступний для вас", code: "forbidden" };
    }
  }

  // Гейт закритих послуг при зміні складу (grandfather: області, вже наявні в
  // записі-снапшоті, не ріжемо — тільки нові вимкнені/приховані в кабінеті).
  if (safePatch.studies !== undefined) {
    const { data: row } = await supabase.from("waitlist_entries")
      .select("clinic_id, room_id, studies").eq("id", v.data.id).maybeSingle();
    if (row?.clinic_id) {
      const effRoom = (safePatch.room_id !== undefined ? safePatch.room_id : row.room_id) as string | null;
      const gf = studiesKeySet(row.studies as unknown as { type?: string | null; region?: string | null }[]);
      const g = await closedRegionGateWL(
        supabase, row.clinic_id, effRoom,
        safePatch.studies as unknown as { type?: string | null; region?: string | null }[], gf);
      if (g) return g;
    }
  }

  // Патч ставить кінець вікна у минуле → той самий гард, що на вставці. Клініку
  // рядка беремо під RLS (не бачимо — далі UPDATE усе одно віддасть forbidden).
  const newTo = safePatch.desired_date_to;
  if (typeof newTo === "string" && newTo) {
    const { data: row } = await supabase.from("waitlist_entries").select("clinic_id").eq("id", v.data.id).maybeSingle();
    if (row?.clinic_id && newTo < await clinicTodayKey(supabase, row.clinic_id)) return PAST_WINDOW;
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
    status: z.enum(["waiting", "cancelled"]),   // 'scheduled' — лише через scheduleFromWaitlist
  }), { id, status });
  if (!v.ok) return v;
  id = v.data.id;
  status = v.data.status;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Не авторизовано", code: "auth" };

  // Перехід статусу — ЛИШЕ через set_waitlist_status_rpc (0102). Службові колонки
  // status/scheduled_entry_id/claim_token закриті від прямого запису колоночними
  // грантами; RPC (SECURITY DEFINER) робить явну авторизацію (персонал свого центру
  // або направник-власник) і на restore→waiting чистить застовплення (0089).
  const { error } = await supabase.rpc("set_waitlist_status_rpc", {
    p_id: id,
    p_status: status,
  });
  if (error) {
    const m = error.message ?? "";
    if (/^AUTH/i.test(m)) return { ok: false, error: "Не авторизовано", code: "auth" };
    if (/WAITLIST_NOT_FOUND|^FORBIDDEN/i.test(m)) {
      return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
    }
    return { ok: false, error: safeDbError("setWaitlistStatus", error), code: "generic" };
  }
  return { ok: true };
}

/* markWaitlistScheduled ВИДАЛЕНО (2026-07-15): перенос кандидата у слот тепер
   атомарний — scheduleFromWaitlist у app/queue/actions.ts застовплює кандидата
   (CAS waiting→scheduled) ПЕРЕД createBooking, тож два адміністратори не задвоять
   пацієнта. Стара дія позначала 'scheduled' ПІСЛЯ створення запису, тож переможець
   CAS уже мав сироту в черзі. Не відроджувати цей двокроковий шлях. */
