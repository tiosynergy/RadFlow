import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import JournalScreen from "@/components/JournalScreen";

/* «Журнал дій» (ТЗ §11) — лише адміністратор центру.
   Порядок редиректів — той самий, що в /staff і /referrers (не міняти).
   SSR готує ЛИШЕ довідники для фільтрів (персонал, таймзона); область даних
   рахує сервер API із сесії, а не ці пропси. */
export default async function JournalPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, clinics(name, timezone, configured_at)")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");
  if (profile.role === "radiologist") redirect("/radiologist");
  if (profile.role === "referrer") redirect("/referral");
  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { name?: string; timezone?: string | null; configured_at: string | null }
    | null
    | undefined;
  if (clinic && !clinic.configured_at) redirect("/setup");

  const clinicId = profile.clinic_id as string;

  const [{ data: rooms }, { data: staff }] = await Promise.all([
    supabase
      .from("rooms")
      .select("id, name, modality, apparatus_model, active")
      .eq("clinic_id", clinicId)
      .order("name"),
    /* Довідник для фільтра «співробітник». БЕЗ .in("role", …): актором події
       може бути будь-яка роль центру, включно з адміном. Направники і CEO —
       глобальні акаунти (clinic_id null), їх сюди не тягнемо: у фільтрі вони
       з'являться лише як actor_id у самих подіях, і ім'я резолвиться окремо. */
    supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("clinic_id", clinicId)
      .order("full_name"),
  ]);

  return (
    <JournalScreen
      clinicName={clinic?.name ?? ""}
      clinicTz={clinic?.timezone ?? undefined}
      adminName={(profile.full_name as string) ?? (user.email ?? "")}
      rooms={rooms ?? []}
      staff={(staff ?? []).map((s) => ({
        id: s.id,
        name: (s.full_name as string) ?? "",
        role: s.role as string,
      }))}
    />
  );
}
