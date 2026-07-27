import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ServicesManager from "@/components/ServicesManager";

/* Каталог послуг клініки (Stage 2, фаза 1): перелік / ціни / тривалості.
   Редагує ЛИШЕ адмін (RLS services_admin_write, 0073) — інших відводимо. */
export default async function ServicesPage() {
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
  if (profile.role !== "admin" || !profile.clinic_id) redirect("/queue");

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; configured_at: string | null; timezone?: string | null }
    | null
    | undefined;
  if (clinic && !clinic.configured_at) redirect("/setup");

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, name, modality, apparatus_model, schedule, active")
    .eq("clinic_id", profile.clinic_id as string)
    .order("name");

  const { data: services } = await supabase
    .from("services")
    .select("*")
    .eq("clinic_id", profile.clinic_id as string)
    .order("modality").order("active", { ascending: false }).order("sort_order").order("name");

  // Переозначення каталогу по кабінетах (0108) — для режиму «Кабінет» редактора.
  const { data: roomOverrides } = await supabase
    .from("service_room_overrides")
    .select("*")
    .eq("clinic_id", profile.clinic_id as string);

  return (
    <ServicesManager
      clinicId={profile.clinic_id as string}
      clinicTz={clinic?.timezone || "UTC"}
      initialServices={services ?? []}
      roomOverrides={roomOverrides ?? []}
      rooms={rooms ?? []}
      clinicName={clinic?.name ?? ""}
      adminName={(profile.full_name as string) ?? (user.email ?? "")}
    />
  );
}
