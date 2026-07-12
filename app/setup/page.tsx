import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SetupWizard from "@/components/SetupWizard";
import { normalizeRoomSchedule } from "@/lib/schedule";

export default async function SetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, phone, clinics(name, city, address, phones, emails, timezone)")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/login");
  if (profile.role === "radiologist") redirect("/radiologist");
  if (profile.role === "referrer") redirect("/referral");
  if (profile.role !== "admin") redirect("/queue"); // майстер налаштувань — лише адмін

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; city?: string; address?: string; phones?: string[]; emails?: string[]; timezone?: string | null }
    | null
    | undefined;

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, name, modality, apparatus_model, schedule")
    .eq("clinic_id", profile.clinic_id as string);

  const equip = (rooms ?? []).map((r: Record<string, unknown>, i: number) => {
    // Прозора міграція старого формату (одна обідня перерва) → breaks[].
    const sched = normalizeRoomSchedule(r.schedule as Record<string, unknown> | null);
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
    // Пусто → майстер підставить зону браузера як ПОЧАТКОВЕ значення (нова клініка).
    timezone: clinic?.timezone ?? "",
    adminName: profile.full_name ?? "",
    adminEmail: user.email ?? "",
    adminPhone: profile.phone ?? "",
    equip: equip.length ? equip : undefined,
  };

  const managerRooms = (rooms ?? []).map((r) => ({
    id: r.id as string,
    name: (r.name as string) ?? "",
    modality: r.modality as string,
    apparatus_model: (r.apparatus_model as string) ?? null,
  }));

  return (
    <SetupWizard
      clinicId={profile.clinic_id as string}
      userId={user.id}
      initial={initial as Parameters<typeof SetupWizard>[0]["initial"]}
      rooms={managerRooms}
      clinicName={clinic?.name ?? ""}
      adminName={profile.full_name ?? (user.email ?? "")}
    />
  );
}
