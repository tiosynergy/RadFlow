import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ReferralPortal from "@/components/ReferralPortal";
import SignOutButton from "@/components/SignOutButton";

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ minHeight: "100vh", background: "#1c1c1e", color: "#f5f5f7", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "-apple-system, system-ui, sans-serif" }}>
      <div style={{ maxWidth: 460, textAlign: "center", padding: 28, background: "#2c2c2e", border: "1px solid #38383a", borderRadius: 16 }}>
        <div style={{ fontSize: 38, marginBottom: 12 }}>🩺</div>
        <h1 style={{ fontSize: 20, fontWeight: 650 }}>{title}</h1>
        <p style={{ fontSize: 14, color: "#8e8e93", marginTop: 10, lineHeight: 1.5 }}>{text}</p>
        <div style={{ marginTop: 20 }}><SignOutButton /></div>
      </div>
    </div>
  );
}

type Center = {
  accessId: string | null;
  clinicId: string;
  status: string;
  policy: string;
  room_ids: string[] | null;
  name: string;
  city: string | null;
};

export default async function ReferralPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, approved")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");
  if (profile.role === "radiologist") redirect("/radiologist");
  if (profile.role !== "admin" && profile.role !== "referrer") redirect("/queue");

  // Лікар-направник має бути підтверджений (acount-level approve).
  if (profile.role === "referrer" && !profile.approved) {
    return <Notice title="Очікує підтвердження" text="Ваш акаунт лікаря-направника зареєстровано. Доступ до центрів зʼявиться після підтвердження адміністратором центру — у вкладці «Мої центри»." />;
  }

  const centers: Center[] = [];
  const roomsByClinic: Record<string, unknown[]> = {};

  if (profile.role === "referrer") {
    // Глобальний направник: членство — лише через referral_access.
    const { data: access } = await supabase
      .from("referral_access")
      .select("id, clinic_id, status, policy, room_ids")
      .eq("referrer_id", user.id);
    const list = access ?? [];
    const clinicIds = Array.from(new Set(list.map((a) => a.clinic_id as string)));

    const clinicsById: Record<string, { name?: string; city?: string | null }> = {};
    if (clinicIds.length) {
      const { data: clinics } = await supabase.from("clinics").select("id, name, city").in("id", clinicIds);
      (clinics ?? []).forEach((c) => { clinicsById[c.id as string] = { name: c.name as string, city: (c.city as string) ?? null }; });
    }

    list.forEach((a) => {
      centers.push({
        accessId: a.id as string,
        clinicId: a.clinic_id as string,
        status: a.status as string,
        policy: (a.policy as string) ?? "direct",
        room_ids: (a.room_ids as string[] | null) ?? null,
        name: clinicsById[a.clinic_id as string]?.name ?? "Центр",
        city: clinicsById[a.clinic_id as string]?.city ?? null,
      });
    });

    const activeIds = centers.filter((c) => c.status === "active").map((c) => c.clinicId);
    if (activeIds.length) {
      const { data: rooms } = await supabase
        .from("rooms")
        .select("id, name, modality, apparatus_model, clinic_id")
        .in("clinic_id", activeIds)
        .order("name");
      (rooms ?? []).forEach((r) => {
        const cid = r.clinic_id as string;
        (roomsByClinic[cid] ||= []).push(r);
      });
    }
  } else {
    // Адмін: прев'ю порталу для власного центру (один «центр»).
    const { data: clinic } = await supabase
      .from("clinics")
      .select("id, name, city, configured_at")
      .eq("id", profile.clinic_id as string)
      .single();
    if (clinic && !clinic.configured_at) redirect("/setup");
    if (clinic) {
      centers.push({ accessId: null, clinicId: clinic.id as string, status: "active", policy: "direct", room_ids: null, name: (clinic.name as string) ?? "", city: (clinic.city as string) ?? null });
      const { data: rooms } = await supabase
        .from("rooms")
        .select("id, name, modality, apparatus_model, clinic_id")
        .eq("clinic_id", profile.clinic_id as string)
        .order("name");
      roomsByClinic[clinic.id as string] = rooms ?? [];
    }
  }

  return (
    <ReferralPortal
      role={profile.role as string}
      centers={centers}
      roomsByClinic={roomsByClinic}
      doctorName={(profile.full_name as string) ?? (user.email ?? "Лікар")}
      doctorId={user.id}
    />
  );
}
