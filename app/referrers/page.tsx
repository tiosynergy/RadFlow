import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ReferrersManager from "@/components/ReferrersManager";

export default async function ReferrersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, clinics(name, configured_at)")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");
  if (profile.role === "radiologist") redirect("/radiologist");
  if (profile.role === "referrer") redirect("/referral");
  if (profile.role !== "admin") redirect("/queue");

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; configured_at: string | null }
    | null
    | undefined;
  if (clinic && !clinic.configured_at) redirect("/setup");

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, name, modality, apparatus_model")
    .eq("clinic_id", profile.clinic_id as string)
    .order("name");

  return (
    <ReferrersManager
      clinicId={profile.clinic_id as string}
      rooms={rooms ?? []}
      clinicName={clinic?.name ?? ""}
      adminName={(profile.full_name as string) ?? (user.email ?? "")}
    />
  );
}
