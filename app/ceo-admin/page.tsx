import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CeoManager from "@/components/CeoManager";

export default async function CeoAdminPage() {
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
  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; configured_at: string | null }
    | null
    | undefined;
  if (clinic && !clinic.configured_at) redirect("/setup");

  return (
    <CeoManager
      clinicId={profile.clinic_id as string}
      clinicName={clinic?.name ?? ""}
      adminName={(profile.full_name as string) ?? (user.email ?? "")}
    />
  );
}
