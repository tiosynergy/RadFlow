import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SetupWizard from "@/components/SetupWizard";

const DEF_DAY = { start: "08:00", end: "18:00", lunch: false, lunchS: "13:00", lunchE: "14:00" };
const defSched = () => ({
  days: [1, 1, 1, 1, 1, 0, 0],
  ...DEF_DAY,
  perDay: false,
  dayHours: Array.from({ length: 7 }, () => ({ ...DEF_DAY })),
});

export default async function SetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, phone, clinics(name, city, address, phones, emails)")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/login");
  if (profile.role === "radiologist") redirect("/radiologist");
  if (profile.role === "referrer") redirect("/referral");

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; city?: string; address?: string; phones?: string[]; emails?: string[] }
    | null
    | undefined;

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, name, modality, apparatus_model, schedule")
    .eq("clinic_id", profile.clinic_id);

  const equip = (rooms ?? []).map((r: Record<string, unknown>, i: number) => {
    const sched =
      r.schedule && typeof r.schedule === "object" && (r.schedule as Record<string, unknown>).days
        ? (r.schedule as Record<string, unknown>)
        : defSched();
    const modality = r.modality as string;
    return {
      id: i + 1,
      roomId: r.id as string,   // DB-id кабінету — щоб оновлювати, а не пересоздавати
      type: modality === "MRI" ? "МРТ" : modality === "CT" ? "КТ" : "Інше",
      desc: (r.apparatus_model as string) ?? "",
      room: (r.name as string) ?? "",
      ...sched,
    };
  });

  const initial = {
    clinic: clinic?.name ?? "",
    city: clinic?.city ?? "",
    address: clinic?.address ?? "",
    phones: clinic?.phones ?? [],
    emails: clinic?.emails ?? [],
    adminName: profile.full_name ?? "",
    adminEmail: user.email ?? "",
    adminPhone: profile.phone ?? "",
    equip: equip.length ? equip : undefined,
  };

  return <SetupWizard clinicId={profile.clinic_id as string} userId={user.id} initial={initial} />;
}
