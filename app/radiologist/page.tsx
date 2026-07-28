import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RadiologistBoard from "@/components/RadiologistBoard";
import SignOutButton from "@/components/SignOutButton";
import { residualOffRooms, offRoomIdsOf } from "@/lib/roomsResidual";
import { residualSet, visibleRooms } from "@/lib/rooms";

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ minHeight: "100vh", background: "#1c1c1e", color: "#f5f5f7", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "-apple-system, system-ui, sans-serif" }}>
      <div style={{ maxWidth: 460, textAlign: "center", padding: 28, background: "#2c2c2e", border: "1px solid #38383a", borderRadius: 16 }}>
        <div style={{ fontSize: "2.375rem", marginBottom: 12 }}>🩺</div>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 650 }}>{title}</h1>
        <p style={{ fontSize: "0.875rem", color: "#8e8e93", marginTop: 10, lineHeight: 1.5 }}>{text}</p>
        <div style={{ marginTop: 20 }}><SignOutButton /></div>
      </div>
    </div>
  );
}

export default async function RadiologistPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, approved, clinics(configured_at, timezone)")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");

  const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
    | { configured_at: string | null; timezone?: string | null }
    | null
    | undefined;
  if (profile.role === "admin" && clinic && !clinic.configured_at) redirect("/setup");

  const { data: allRooms } = await supabase
    .from("rooms")
    .select("id, name, modality, apparatus_model, schedule, active")
    .eq("clinic_id", profile.clinic_id as string)
    .order("name");

  let rooms = allRooms ?? [];
  // Чи звузили список до кабінетів, призначених саме цьому радіологу (для
  // порожнього стану нижче: в адміна «немає кабінетів» — це інша історія).
  let radiologistScoped = false;

  if (profile.role === "radiologist") {
    if (!profile.approved) {
      return <Notice title="Очікує підтвердження" text="Ваш акаунт радіолога зареєстровано. Адміністратор клініки має підтвердити доступ — після цього ви побачите свою чергу пацієнтів." />;
    }
    const { data: rr } = await supabase
      .from("radiologist_rooms")
      .select("room_id")
      .eq("profile_id", user.id);
    const allowed = new Set((rr ?? []).map((x) => x.room_id as string));
    rooms = (allRooms ?? []).filter((r) => allowed.has(r.id as string));
    if (rooms.length === 0) {
      return <Notice title="Кабінети не призначено" text="Адміністратор ще не надав вам доступ до жодного кабінету. Зверніться до адміністратора клініки." />;
    }
    radiologistScoped = true;
  } else if (profile.role === "referrer") {
    redirect("/referral");
  } else if (profile.role !== "admin") {
    redirect("/queue");
  }

  /* Вимкнений кабінет ховаємо зі списків — але поки в ньому лишились живі записи,
     він «спливає» назад із підписом «вимкнено · N». Див. lib/rooms.ts. */
  const residual = await residualOffRooms(supabase, profile.clinic_id as string, offRoomIdsOf(rooms), clinic?.timezone);

  /* Прив'язки є, але після фільтра не лишилось жодного кабінету: усі призначені
     вимкнено й розбирати в них нічого. Порожня дошка без пояснення виглядала б
     як поламаний екран — краще прямо сказати, куди йти. Прив'язки при цьому
     НЕ чіпаємо: повернуть кабінет у стрій — радіолог одразу побачить свою чергу. */
  if (radiologistScoped && visibleRooms(rooms, residualSet(residual.ids)).length === 0) {
    return <Notice title="Усі ваші кабінети вимкнено" text="Зверніться до адміністратора центру — він увімкне кабінет або призначить вам інший." />;
  }

  return (
    <RadiologistBoard
      clinicId={profile.clinic_id as string}
      clinicTz={clinic?.timezone || "UTC"}
      rooms={rooms}
      residualRoomIds={residual.ids}
      residualRoomCounts={residual.counts}
      adminName={(profile.full_name as string) ?? (user.email ?? "")}
    />
  );
}
