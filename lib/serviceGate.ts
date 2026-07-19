/* ===== RadFlow — серверний гейт складу дослідження проти каталогу центру =====
   Defense-in-depth (High, 2026-07-19): DB-тригер check_studies_match_room (0088)
   стереже лише «тип ↔ модальність кабінету», але НЕ активність послуги в каталозі
   й не переозначення по кабінету (0108). Тож крафтовий/застарілий запит міг
   створити запис на ВИМКНЕНУ або приховану в кабінеті послугу, хоча UI її вже не
   показує. Цей гейт дзеркалить резолвер lib/catalog.ts на серверній межі write-дій.

   Легасі-центр (модальність без каталогу) НЕ чіпаємо — проходить як раніше. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";
import {
  buildCatalog, overridesToMap, firstClosedStudy,
  type Catalog, type ServiceLike, type RoomOverrideRow,
} from "@/lib/catalog";

const SERVICE_COLS =
  "id, name, modality, duration_min, price, contrast_allowed, contrast_price, active, sort_order";
const SRO_COLS = "room_id, service_id, price, duration_min, contrast_price, active";

/** Резолвер каталогу центру для серверної валідації — ВСІ послуги (у т.ч.
    active=false, щоб відрізнити «не налаштовували» від «вимкнено») + переозначення
    по кабінетах. Дзеркало SSR-пропів форм (сторінки booking-флоу). */
/** Сигнал недоступності каталогу: збій читання services/service_room_overrides.
    Ловиться у write-гейтах для fail-CLOSED (відмова у записі), а не легасі-фолбэку. */
export class CatalogUnavailableError extends Error {
  constructor(message = "catalog read failed") {
    super(message);
    this.name = "CatalogUnavailableError";
  }
}

export async function loadClinicCatalog(
  supabase: SupabaseClient<Database>,
  clinicId: string
): Promise<Catalog> {
  const [svc, ov] = await Promise.all([
    supabase.from("services").select(SERVICE_COLS).eq("clinic_id", clinicId),
    supabase.from("service_room_overrides").select(SRO_COLS).eq("clinic_id", clinicId),
  ]);
  // Fail-CLOSED: помилку читання НЕ маскуємо порожнім каталогом — інакше центр
  // помилково вважався б «легасі» і статичний каталог пропускав би вимкнені послуги.
  if (svc.error || ov.error) {
    throw new CatalogUnavailableError(svc.error?.message ?? ov.error?.message ?? "catalog read failed");
  }
  return buildCatalog(
    (svc.data ?? []) as ServiceLike[],
    overridesToMap((ov.data ?? []) as RoomOverrideRow[])
  );
}

/** Назва першої області, ЗАКРИТОЇ каталогом центру (вимкнена/прихована в кабінеті),
    або null, якщо все дозволено. roomId — обраний кабінет (null/undefined → база
    центру, напр. лист очікування без привʼязки). grandfather — набір "type|region",
    вже наявних у записі (редагування снапшота): їх не ріжемо. */
export async function firstClosedService(
  supabase: SupabaseClient<Database>,
  clinicId: string,
  roomId: string | null | undefined,
  studies: ReadonlyArray<{ type?: string | null; region?: string | null }> | null | undefined,
  grandfather?: ReadonlySet<string>
): Promise<string | null> {
  const cat = await loadClinicCatalog(supabase, clinicId);
  return firstClosedStudy(cat, studies, roomId ?? undefined, grandfather);
}

/** Набір "type|region" зі снапшота наявних досліджень — для grandfather на редагуванні. */
export function studiesKeySet(
  studies: ReadonlyArray<{ type?: string | null; region?: string | null }> | null | undefined
): Set<string> {
  const set = new Set<string>();
  if (Array.isArray(studies)) {
    for (const s of studies) {
      if (s?.type && s?.region) set.add(s.type + "|" + s.region);
    }
  }
  return set;
}
