import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CeoDashboard from "@/components/CeoDashboard";

export default async function CeoPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, clinics(name, configured_at)")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");
  if (profile.role === "radiologist") redirect("/radiologist");
  if (profile.role === "referrer") redirect("/referral");
  // Дашборд керівника з фінансовими метриками — лише для admin/ceo.
  if (profile.role !== "admin" && profile.role !== "ceo") redirect("/queue");

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; configured_at: string | null }
    | null
    | undefined;
  if (clinic && !clinic.configured_at) redirect("/setup");

  const ROLE_LABELS: Record<string, string> = {
    admin: "Адміністратор", radiologist: "Радіолог", registrar: "Реєстратор", referrer: "Лікар-направник", ceo: "Керівник",
  };

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, name, modality, apparatus_model")
    .eq("clinic_id", profile.clinic_id)
    .order("name");

  return (
    <CeoDashboard
      clinicId={profile.clinic_id as string}
      rooms={rooms ?? []}
      clinicName={clinic?.name ?? ""}
      adminName={(profile.full_name as string) ?? (user.email ?? "")}
      adminRole={profile.role ? ROLE_LABELS[profile.role as string] ?? (profile.role as string) : "Адміністратор"}
    />
  );
}
