import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SetupWizard from "@/components/SetupWizard";
import { normalizeRoomSchedule } from "@/lib/schedule";
import { modalityLabel } from "@/lib/studies";
import type { QueueDelayPolicy } from "@/supabase/types";
import type { QueuePolicyInitial } from "@/components/QueuePolicySettings";

export default async function SetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, phone, clinics(name, city, address, phones, emails, timezone, queue_delay_policy, overlap_threshold_min, max_cascade_patients, allow_after_hours_shift)")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/login");
  if (profile.role === "radiologist") redirect("/radiologist");
  if (profile.role === "referrer") redirect("/referral");

  /* Майстер налаштувань — лише адмін (з 0073 БД однаково відхилить запис у rooms/clinics
     не-адміну). Реєстратора НЕ редіректимо на /queue: якщо центр ще не налаштований,
     /queue сам веде на /setup — виходила петля. Показуємо пояснення. */
  if (profile.role !== "admin") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ maxWidth: 460, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Центр ще не налаштовано</h1>
          <p style={{ color: "var(--text-muted)", lineHeight: 1.55 }}>
            Майстер налаштувань доступний лише адміністратору центру. Зверніться до адміністратора —
            після налаштування кабінетів і графіка черга запрацює.
          </p>
        </div>
      </div>
    );
  }

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | {
        name?: string; city?: string; address?: string; phones?: string[]; emails?: string[]; timezone?: string | null;
        queue_delay_policy?: QueueDelayPolicy; overlap_threshold_min?: number;
        max_cascade_patients?: number; allow_after_hours_shift?: boolean;
      }
    | null
    | undefined;

  /* 0078 — політика черги при затримці. Дефолти дублюють DEFAULT у БД: якщо
     міграцію ще не накатили (або клініка старша за неї), майстер має відкритись,
     а не впасти. Значення все одно перевіряє сервер + CHECK. */
  const queuePolicy: QueuePolicyInitial = {
    policy: clinic?.queue_delay_policy ?? "manual",
    overlapThresholdMin: clinic?.overlap_threshold_min ?? 15,
    maxCascadePatients: clinic?.max_cascade_patients ?? 30,
    allowAfterHoursShift: clinic?.allow_after_hours_shift ?? false,
  };

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, name, modality, apparatus_model, schedule, active")
    .eq("clinic_id", profile.clinic_id as string);

  const equip = (rooms ?? []).map((r: Record<string, unknown>, i: number) => {
    // Прозора міграція старого формату (одна обідня перерва) → breaks[].
    const sched = normalizeRoomSchedule(r.schedule as Record<string, unknown> | null);
    const modality = r.modality as string;
    return {
      id: i + 1,
      roomId: r.id as string,   // DB-id кабінету — щоб оновлювати, а не пересоздавати
      type: modalityLabel(modality),
      desc: (r.apparatus_model as string) ?? "",
      room: (r.name as string) ?? "",
      active: r.active !== false,        // 0123 — стан перемикача у формі
      activeSaved: r.active !== false,   // …і те саме значення, яке вже в базі
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
    active: r.active !== false,   // 0123
  }));

  // Каталог послуг (0107) + переозначення по кабінетах (0108) — крок «Послуги та прайс».
  const { data: services } = await supabase
    .from("services").select("*")
    .eq("clinic_id", profile.clinic_id as string)
    .order("modality").order("active", { ascending: false }).order("sort_order").order("name");
  const { data: roomOverrides } = await supabase
    .from("service_room_overrides").select("*")
    .eq("clinic_id", profile.clinic_id as string);

  return (
    <SetupWizard
      clinicId={profile.clinic_id as string}
      userId={user.id}
      initial={initial as Parameters<typeof SetupWizard>[0]["initial"]}
      rooms={managerRooms}
      services={services ?? []}
      roomOverrides={roomOverrides ?? []}
      clinicName={clinic?.name ?? ""}
      adminName={profile.full_name ?? (user.email ?? "")}
      queuePolicy={queuePolicy}
    />
  );
}
