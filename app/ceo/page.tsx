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
    .select("clinic_id, full_name, role, clinics(name, configured_at, timezone)")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");

  // Доступні центри CEO — через ceo_access (глобальний грант, кілька центрів).
  const { data: ceoLinks } = await supabase
    .from("ceo_access")
    .select("clinic_id, clinics(name, timezone)")
    .eq("ceo_id", user.id)
    .eq("status", "active");

  // Зона кожного центру потрібна дашборду: «сьогодні»/«тиждень» рахуються за часом
  // ЦЕНТРУ, а не браузера керівника (він може дивитися центр з іншої зони).
  const clinicsMap = new Map<string, { name: string; timezone: string }>();
  (ceoLinks ?? []).forEach((l) => {
    const c = (Array.isArray(l.clinics) ? l.clinics[0] : l.clinics) as { name?: string; timezone?: string | null } | null | undefined;
    if (l.clinic_id) clinicsMap.set(l.clinic_id as string, { name: c?.name ?? "Центр", timezone: c?.timezone || "UTC" });
  });

  const ownClinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; configured_at: string | null; timezone?: string | null }
    | null
    | undefined;

  // Адмін центру також бачить дашборд свого центру (як раніше).
  if (profile.role === "admin" && profile.clinic_id) {
    clinicsMap.set(profile.clinic_id as string, { name: ownClinic?.name ?? "Центр", timezone: ownClinic?.timezone || "UTC" });
  }

  const hasCeoAccess = clinicsMap.size > 0;
  const allowed = profile.role === "admin" || profile.role === "ceo" || hasCeoAccess;
  if (!allowed) {
    if (profile.role === "radiologist") redirect("/radiologist");
    if (profile.role === "referrer") redirect("/referral");
    redirect("/queue");
  }

  // Майстер налаштування — лише для адміна з ненастроєним власним центром.
  if (profile.role === "admin" && ownClinic && !ownClinic.configured_at) redirect("/setup");

  const ROLE_LABELS: Record<string, string> = {
    admin: "Адміністратор", radiologist: "Радіолог", registrar: "Реєстратор", referrer: "Лікар-направник", ceo: "Керівник",
  };

  const clinics = Array.from(clinicsMap.entries()).map(([id, c]) => ({ id, name: c.name, timezone: c.timezone }));

  return (
    <CeoDashboard
      clinics={clinics}
      clinicName={clinics.length === 1 ? clinics[0].name : "Всі центри"}
      adminName={(profile.full_name as string) ?? (user.email ?? "")}
      adminRole={profile.role ? ROLE_LABELS[profile.role as string] ?? (profile.role as string) : "Керівник"}
      roleKey={profile.role as string}
    />
  );
}
