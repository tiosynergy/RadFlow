import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { residualOffRooms, offRoomIdsOf } from "@/lib/roomsResidual";
import CallListBoard from "@/components/CallListBoard";

export default async function CallListPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, clinics(name, configured_at, timezone)")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");
  if (profile.role === "radiologist") redirect("/radiologist");
  if (profile.role === "referrer") redirect("/referral");
  /* ⚠️ Ф6-3 (с55). Цього рядка тут НЕ БУЛО, хоч в обох сусідів по столу він є:
     `/queue` відводить `ceo`, `/waitlist` — `ceo` і порожній `clinic_id`. А
     `ceo` за конституцією БД (`profiles_role_clinic_chk`) має `clinic_id IS
     NULL`, тож нижче йшов запит `.eq("clinic_id", null as string)` — каст
     ховав дірку від типів, і керівник потрапляв саме на той екран, де живе
     НЕЗВОРОТНЕ масове «Всіх підтверджено» (F2, с51).
     Це дослівно урок фази 4: дефект живе не там, де правила немає, а там, де
     правило є і про нього забули — тут воно було у двох місцях із трьох. */
  if (profile.role === "ceo" || !profile.clinic_id) redirect("/ceo");

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; configured_at: string | null; timezone?: string | null }
    | null
    | undefined;
  if (clinic && !clinic.configured_at) redirect("/setup");

  const ROLE_LABELS: Record<string, string> = {
    admin: "Адміністратор", radiologist: "Радіолог", registrar: "Реєстратор", referrer: "Лікар-направник", ceo: "Керівник",
  };

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, name, modality, apparatus_model, schedule, active")
    .eq("clinic_id", profile.clinic_id as string)
    .order("name");

  /* Вимкнений кабінет ховаємо зі списків — але поки в ньому лишились живі записи,
     він «спливає» назад із підписом «вимкнено · N». Див. lib/rooms.ts. */
  const residual = await residualOffRooms(supabase, profile.clinic_id as string, offRoomIdsOf(rooms), clinic?.timezone);

  // Каталог послуг центру (services, 0107) — форми запису з колл-листа (фаза 2a).
  // ВСІ рядки (у т.ч. active=false) — buildCatalog розрізняє «не налаштовували»
  // (→ статика) від «усі вимкнені» (→ порожньо, напрям закрито). High-2.
  const { data: services } = await supabase
    .from("services")
    .select("id, name, modality, duration_min, price, contrast_allowed, contrast_price, active, sort_order, room_id") // 0121: room_id — видимість послуги залежить від кабінету запису
    .eq("clinic_id", profile.clinic_id as string)
    .order("sort_order");

  // Переозначення каталогу по кабінетах (0108) — форми запису з колл-листа (фаза 2b).
  const { data: roomOverrides } = await supabase
    .from("service_room_overrides")
    .select("room_id, service_id, price, duration_min, contrast_price, active")
    .eq("clinic_id", profile.clinic_id as string);

  return (
    <CallListBoard
      clinicId={profile.clinic_id as string}
      clinicTz={clinic?.timezone || "UTC"}
      rooms={rooms ?? []}
      residualRoomIds={residual.ids}
      residualRoomCounts={residual.counts}
      services={services ?? []}
      roomOverrides={roomOverrides ?? []}
      clinicName={clinic?.name ?? ""}
      adminName={(profile.full_name as string) ?? (user.email ?? "")}
      adminRole={profile.role ? ROLE_LABELS[profile.role as string] ?? (profile.role as string) : "Адміністратор"}
      roleKey={(profile.role as string) ?? "admin"}
    />
  );
}
