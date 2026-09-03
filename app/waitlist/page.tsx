import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { residualOffRooms, offRoomIdsOf } from "@/lib/roomsResidual";
import WaitlistBoard from "@/components/WaitlistBoard";
import RoleNotice from "@/components/RoleNotice";

// с22: deep-link зі сторінки «Пошук» — ?tab=waiting|scheduled|removed&entry=<uuid>.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function firstParam(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? null : null;
}

export default async function WaitlistPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = searchParams ? await searchParams : {};
  const rawTab = firstParam(sp.tab);
  const rawEntry = firstParam(sp.entry);
  const initialTab = rawTab === "waiting" || rawTab === "scheduled" || rawTab === "removed" ? rawTab : null;
  const initialEntry = rawEntry && UUID_RE.test(rawEntry) ? rawEntry : null;

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
  if (profile.role === "ceo" || !profile.clinic_id) redirect("/ceo");
  /* ⚠️ ЗАКРИВАЮЧИЙ ПОЗИТИВ (Ф6-4, с55). Ланцюг вище — НЕГАТИВНИЙ: роль, якої в
     ньому немає, проходила далі. Відводити нікуди, тому рендеримо пояснення.
     Див. RoleNotice. */
  if (profile.role !== "admin" && profile.role !== "registrar") {
    return <RoleNotice title="Доступ обмежено" text="У вашій ролі цей розділ недоступний. Зверніться до адміністратора центру." />;
  }

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

  // Каталог послуг центру (services, 0107) — форми листа очікування (фаза 2a).
  // ВСІ рядки (у т.ч. active=false) — buildCatalog розрізняє «не налаштовували»
  // (→ статика) від «усі вимкнені» (→ порожньо, напрям закрито). High-2.
  const { data: services } = await supabase
    .from("services")
    .select("id, name, modality, duration_min, price, contrast_allowed, contrast_price, active, sort_order, room_id") // 0121: room_id — видимість послуги залежить від кабінету запису
    .eq("clinic_id", profile.clinic_id as string)
    .order("sort_order");

  // Переозначення каталогу по кабінетах (0108) — форми листа очікування (фаза 2b).
  const { data: roomOverrides } = await supabase
    .from("service_room_overrides")
    .select("room_id, service_id, price, duration_min, contrast_price, active")
    .eq("clinic_id", profile.clinic_id as string);

  return (
    <WaitlistBoard
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
      initialTab={initialTab}
      initialEntry={initialEntry}
    />
  );
}
