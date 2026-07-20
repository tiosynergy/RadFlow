"use server";

/* ===== RadFlow — Server Actions каталогу послуг (Stage 2, фаза 1) =====
   Перелік послуг / ціни / тривалості клініки живуть у таблиці services (0107,
   per-clinic). Мутації — ТІЛЬКИ адмін свого центру: явний гейт тут (чисте
   повідомлення) + RLS services_admin_write (0073) як defense-in-depth.
   Читання списку — клієнтським supabase напряму (RLS: staff / referrer / CEO).

   Фаза 2 (наступна сесія): booking-флоу читає каталог замість хардкоду
   lib/studies.ts (фолбэк на статичний каталог, поки services порожня).
   Фаза 3: імпорт прайсу файлом/URL через n8n + AI → source='import'. */

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";
import { parseInput, safeDbError, zUuid, zDuration, zPriceNullable } from "@/lib/validation";
import { BOOKABLE_MODALITIES, regionsFor, type ModalityCode } from "@/lib/studies";

export type ServiceActionResult =
  | { ok: true; id?: string; count?: number }
  | { ok: false; error: string; code?: "auth" | "forbidden" | "duplicate" | "generic" };

/* ---- Схеми входу (M-12) ---- */
const PRICE_MAX = 1_000_000; // = CHECK services_price_chk (0107)
const zPrice = z.coerce.number().int().min(0).max(PRICE_MAX);
const zModality = z.enum(["MRI", "CT", "US", "XRAY", "MAMMO"]); // = BOOKABLE_MODALITIES
const sService = z.object({
  name: z.string().trim().min(2, "Вкажіть назву послуги").max(120),
  modality: zModality,
  // 0117: null = час не задано («—» в каталозі; вводиться вручну при записі).
  // union безпечний: zDuration БЕЗ coerce (канон zPriceNullable — B1).
  durationMin: z.union([zDuration, z.null()]),
  price: zPrice,
  contrastAllowed: z.boolean().optional().default(false),
  // null = глобальний дефолт CONTRAST_SURCHARGE (lib/studies.ts).
  // preprocess: порожній рядок → null. Далі zPriceNullable БЕЗ coerce: у
  // z.union([zPrice(coerce), z.null()]) Number(null)===0 робив із null доплату 0
  // (ревью 0116 B1/M1 — той самий клас бага, що в імпорті).
  contrastPrice: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    zPriceNullable
  ),
  active: z.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional().default(0),
});
export type ServiceInput = z.infer<typeof sService>;

/* Адмін свого центру: явний гейт (RLS 0073 дублює). */
async function requireAdmin(
  supabase: SupabaseClient<Database>
): Promise<{ clinicId: string } | { error: ServiceActionResult }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: { ok: false, error: "Не авторизовано", code: "auth" } };
  const { data: prof } = await supabase
    .from("profiles").select("clinic_id, role").eq("id", user.id).single();
  if (!prof?.clinic_id || prof.role !== "admin") {
    return { error: { ok: false, error: "Каталог послуг редагує адміністратор центру", code: "forbidden" } };
  }
  return { clinicId: prof.clinic_id };
}

function mapServiceError(message: string): ServiceActionResult {
  // 0107: унікальність (clinic_id, modality, lower(name)).
  if (/services_clinic_mod_name_uniq|duplicate key/i.test(message)) {
    return { ok: false, error: "Така послуга вже є в цій модальності", code: "duplicate" };
  }
  if (/services_duration_chk/i.test(message)) {
    return { ok: false, error: "Тривалість — кратна 5 хв, від 5 до 480", code: "generic" };
  }
  if (/services_price_chk|services_contrast_price_chk/i.test(message)) {
    return { ok: false, error: "Некоректна ціна", code: "generic" };
  }
  return { ok: false, error: safeDbError("services", { message }), code: "generic" };
}

/** Створити позицію каталогу. */
export async function createService(raw: ServiceInput): Promise<ServiceActionResult> {
  const v = parseInput("createService", sService, raw);
  if (!v.ok) return v as ServiceActionResult;
  const supabase = await createClient();
  const gate = await requireAdmin(supabase);
  if ("error" in gate) return gate.error;

  const { data, error } = await supabase.from("services").insert({
    clinic_id: gate.clinicId,
    name: v.data.name,
    modality: v.data.modality,
    duration_min: v.data.durationMin,
    price: v.data.price,
    contrast_allowed: v.data.contrastAllowed,
    contrast_price: v.data.contrastAllowed ? v.data.contrastPrice : null,
    active: v.data.active,
    sort_order: v.data.sortOrder,
    source: "manual",
  }).select("id").single();
  if (error) return mapServiceError(error.message);
  return { ok: true, id: data?.id };
}

/** Оновити позицію (усі поля форми; модальність не змінюється — це нова позиція). */
export async function updateService(id: string, raw: ServiceInput): Promise<ServiceActionResult> {
  const idv = parseInput("updateService.id", zUuid, id);
  if (!idv.ok) return idv as ServiceActionResult;
  const v = parseInput("updateService", sService, raw);
  if (!v.ok) return v as ServiceActionResult;
  const supabase = await createClient();
  const gate = await requireAdmin(supabase);
  if ("error" in gate) return gate.error;

  const { data, error } = await supabase.from("services").update({
    name: v.data.name,
    duration_min: v.data.durationMin,
    price: v.data.price,
    contrast_allowed: v.data.contrastAllowed,
    contrast_price: v.data.contrastAllowed ? v.data.contrastPrice : null,
    active: v.data.active,
    sort_order: v.data.sortOrder,
  }).eq("id", idv.data).eq("clinic_id", gate.clinicId).select("id");
  if (error) return mapServiceError(error.message);
  if (!data?.length) return { ok: false, error: "Послугу не знайдено", code: "forbidden" };
  return { ok: true, id: idv.data };
}

/** Увімкнути/вимкнути позицію (м'яке приховування зі збереженням історії). */
export async function setServiceActive(id: string, active: boolean): Promise<ServiceActionResult> {
  const idv = parseInput("setServiceActive.id", zUuid, id);
  if (!idv.ok) return idv as ServiceActionResult;
  const supabase = await createClient();
  const gate = await requireAdmin(supabase);
  if ("error" in gate) return gate.error;
  const { data, error } = await supabase.from("services")
    .update({ active: !!active }).eq("id", idv.data).eq("clinic_id", gate.clinicId).select("id");
  if (error) return mapServiceError(error.message);
  if (!data?.length) return { ok: false, error: "Послугу не знайдено", code: "forbidden" };
  return { ok: true };
}

/** Видалити позицію назовсім (FK на неї немає — studies копіюються в записи jsonb-снімком). */
export async function deleteService(id: string): Promise<ServiceActionResult> {
  const idv = parseInput("deleteService.id", zUuid, id);
  if (!idv.ok) return idv as ServiceActionResult;
  const supabase = await createClient();
  const gate = await requireAdmin(supabase);
  if ("error" in gate) return gate.error;
  const { error } = await supabase.from("services")
    .delete().eq("id", idv.data).eq("clinic_id", gate.clinicId);
  if (error) return mapServiceError(error.message);
  return { ok: true };
}

/** Разове наповнення з базового каталогу lib/studies.ts (усі модальності,
    наявні назви пропускаються — повторний виклик безпечний). source='seed'. */
export async function seedServicesFromCatalog(): Promise<ServiceActionResult> {
  const supabase = await createClient();
  const gate = await requireAdmin(supabase);
  if ("error" in gate) return gate.error;

  // Наявні позиції — щоб не ловити unique-помилку на повторному сіді.
  const { data: existing, error: exErr } = await supabase
    .from("services").select("modality, name").eq("clinic_id", gate.clinicId);
  if (exErr) return mapServiceError(exErr.message);
  const seen = new Set((existing ?? []).map((r) => r.modality + "|" + r.name.trim().toLowerCase()));

  const rows: Database["public"]["Tables"]["services"]["Insert"][] = [];
  for (const mod of BOOKABLE_MODALITIES as ModalityCode[]) {
    regionsFor(mod).forEach((r, i) => {
      if (seen.has(mod + "|" + r.label.trim().toLowerCase())) return;
      rows.push({
        clinic_id: gate.clinicId,
        name: r.label,
        modality: mod,
        duration_min: r.dur,
        price: r.price,
        contrast_allowed: !!r.contrast,
        contrast_price: null,           // дефолт CONTRAST_SURCHARGE
        active: true,
        sort_order: (i + 1) * 10,
        source: "seed",
      });
    });
  }
  if (!rows.length) return { ok: true, count: 0 };
  const { error } = await supabase.from("services").insert(rows);
  if (error) {
    // Гонка двох паралельних «Заповнити» (дві вкладки): другий падає на
    // services_clinic_mod_name_uniq. Дані консистентні (одна INSERT-стейтмент,
    // перший переміг) — повертаємо чисте «вже наповнено», а не «дубль послуги».
    // PostgREST-upsert тут не допоможе: on_conflict не вміє expression-індекс.
    if (/services_clinic_mod_name_uniq|duplicate key/i.test(error.message)) {
      return { ok: true, count: 0 };
    }
    return mapServiceError(error.message);
  }
  return { ok: true, count: rows.length };
}

/* ============================================================
   Переозначення каталогу ПО КАБІНЕТУ (service_room_overrides, 0108).
   base services (0107) = шаблон центру; тут — цінa/тривалість/контраст/вкл-вимк
   на пару (room_id, service_id). Немає рядка → кабінет успадковує базу.
   ============================================================ */

const sRoomOverride = z.object({
  // NULL = успадкувати базу; число — свій параметр. zPriceNullable БЕЗ coerce:
  // інакше явний null ставав ціною 0 — «успадкувати базу» перетворювалось на
  // override 0 ₴ (ревью 0116 M1). zDuration без coerce — null проходить чесно.
  price: zPriceNullable.optional().default(null),
  durationMin: z.union([zDuration, z.null()]).optional().default(null),
  contrastPrice: zPriceNullable.optional().default(null),
  active: z.boolean().optional().default(true),
});
export type RoomOverrideInput = z.infer<typeof sRoomOverride>;

function mapSroError(message: string): ServiceActionResult {
  if (/SRO_MODALITY_MISMATCH/i.test(message)) return { ok: false, error: "Послуга іншої модальності, ніж кабінет", code: "generic" };
  if (/SRO_CLINIC_MISMATCH|SRO_BAD_REF/i.test(message)) return { ok: false, error: "Кабінет або послуга не з цього центру", code: "forbidden" };
  if (/sro_duration_chk/i.test(message)) return { ok: false, error: "Тривалість — кратна 5 хв, від 5 до 480", code: "generic" };
  if (/sro_price_chk|sro_contrast_price_chk/i.test(message)) return { ok: false, error: "Некоректна ціна", code: "generic" };
  return { ok: false, error: safeDbError("service_room_overrides", { message }), code: "generic" };
}

/** Задати/оновити переозначення послуги для кабінету (upsert по PK room_id,service_id).
    NULL price/durationMin/contrastPrice = успадкувати базу; active=false = сховати тут. */
export async function setRoomServiceOverride(
  roomId: string, serviceId: string, raw: RoomOverrideInput
): Promise<ServiceActionResult> {
  const rv = parseInput("setRoomServiceOverride.room", zUuid, roomId);
  if (!rv.ok) return rv as ServiceActionResult;
  const sv = parseInput("setRoomServiceOverride.service", zUuid, serviceId);
  if (!sv.ok) return sv as ServiceActionResult;
  const v = parseInput("setRoomServiceOverride", sRoomOverride, raw);
  if (!v.ok) return v as ServiceActionResult;
  const supabase = await createClient();
  const gate = await requireAdmin(supabase);
  if ("error" in gate) return gate.error;

  // PK (room_id, service_id) — звичайний конфлікт, PostgREST-upsert годиться
  // (на відміну від services: там expression-індекс lower(name)).
  // clinic_id ставимо свій; guard-тригер 0108 звірить room+service+модальність.
  const { error } = await supabase.from("service_room_overrides").upsert({
    clinic_id: gate.clinicId, room_id: rv.data, service_id: sv.data,
    price: v.data.price, duration_min: v.data.durationMin,
    contrast_price: v.data.contrastPrice, active: v.data.active,
  }, { onConflict: "room_id,service_id" });
  if (error) return mapSroError(error.message);
  return { ok: true };
}

/** Прибрати переозначення — кабінет повертається до базового каталогу центру. */
export async function clearRoomServiceOverride(roomId: string, serviceId: string): Promise<ServiceActionResult> {
  const rv = parseInput("clearRoomServiceOverride.room", zUuid, roomId);
  if (!rv.ok) return rv as ServiceActionResult;
  const sv = parseInput("clearRoomServiceOverride.service", zUuid, serviceId);
  if (!sv.ok) return sv as ServiceActionResult;
  const supabase = await createClient();
  const gate = await requireAdmin(supabase);
  if ("error" in gate) return gate.error;
  const { error } = await supabase.from("service_room_overrides")
    .delete().eq("room_id", rv.data).eq("service_id", sv.data).eq("clinic_id", gate.clinicId);
  if (error) return mapSroError(error.message);
  return { ok: true };
}

/* ============================================================
   Імпорт прайса (Stage 2, фаза 3a): підтвердження передперегляду.
   Розбір файла — POST /api/services/import (n8n парсить, lib/priceImport
   нормалізує). Сюди приходять ЛИШЕ обрані адміном рядки; фінальний upsert —
   services_import_rpc (0115, SECURITY DEFINER: admin-гейт усередині, атомарно,
   on conflict по expression-індексу lower(name), який PostgREST не вміє).
   ============================================================ */

const sImportRow = z.object({
  name: z.string().trim().min(2).max(120),
  modality: zModality,
  // null = у прайсі ціни не було: нова позиція → 0 («заповнити пізніше»),
  // існуюча → ціна НЕ чіпається (0116). zPriceNullable БЕЗ coerce — інакше
  // null коерсився в 0 і ЗАТИРАВ реальні ціни (ревью 0116, Blocker B1).
  price: zPriceNullable.optional().default(null),
  // null = у прайсі часу не було → тривалість існуючої позиції НЕ чіпається.
  durationMin: z.union([zDuration, z.null()]).optional().default(null),
  // true = «оживити» вимкнену позицію (інакше RPC її пропустить).
  revive: z.boolean().optional().default(false),
});
const sImportRows = z.array(sImportRow).min(1, "Немає позицій для імпорту").max(500);
export type ImportServiceRow = z.infer<typeof sImportRow>;

export type ImportServicesResult =
  | { ok: true; inserted: number; updated: number; skippedInactive: number; noop: number }
  | { ok: false; error: string; code?: "auth" | "forbidden" | "generic" };

/** Застосувати підтверджені позиції імпорту (все-або-нічого). */
export async function importServices(raw: ImportServiceRow[]): Promise<ImportServicesResult> {
  const v = parseInput("importServices", sImportRows, raw);
  if (!v.ok) return v as ImportServicesResult;
  const supabase = await createClient();
  const gate = await requireAdmin(supabase);
  if ("error" in gate) return gate.error as ImportServicesResult;

  const { data, error } = await supabase.rpc("services_import_rpc", {
    p_rows: v.data.map((r) => ({
      name: r.name,
      modality: r.modality,
      price: r.price,
      duration_min: r.durationMin,
      revive: r.revive,
    })),
  });
  if (error) {
    if (/FORBIDDEN/i.test(error.message)) {
      return { ok: false, error: "Імпорт прайса виконує адміністратор центру", code: "forbidden" };
    }
    if (/BAD_INPUT/i.test(error.message)) {
      // Повідомлення RPC уже людське («рядок N — …») — віддаємо як є.
      return { ok: false, error: error.message.replace(/^BAD_INPUT:\s*/i, ""), code: "generic" };
    }
    return { ok: false, error: safeDbError("services_import", { message: error.message }), code: "generic" };
  }
  const res = (data ?? {}) as { inserted?: number; updated?: number; skipped_inactive?: number; noop?: number };
  return {
    ok: true,
    inserted: res.inserted ?? 0,
    updated: res.updated ?? 0,
    skippedInactive: res.skipped_inactive ?? 0,
    // 0116: рядки без змін (гонка «каталог змінився між передпереглядом і apply»).
    noop: res.noop ?? 0,
  };
}
