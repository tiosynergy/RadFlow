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
import { parseInput, safeDbError, zUuid, zDuration } from "@/lib/validation";
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
  durationMin: zDuration,                       // кратна 5, 5..600 (= CHECK 0107)
  price: zPrice,
  contrastAllowed: z.boolean().optional().default(false),
  // null = глобальний дефолт CONTRAST_SURCHARGE (lib/studies.ts).
  // preprocess: порожній рядок → null (інакше coerce зробив би з "" доплату 0).
  contrastPrice: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.union([zPrice, z.null()])
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
    return { ok: false, error: "Тривалість — кратна 5 хв, від 5 до 600", code: "generic" };
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
