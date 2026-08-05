import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ReferralPortal from "@/components/ReferralPortal";
import SignOutButton from "@/components/SignOutButton";
import type { ServiceLike, RoomOverrideRow } from "@/lib/catalog";
import { safeBackHref } from "@/lib/portalBack";
import { residualOffRooms, offRoomIdsOf } from "@/lib/roomsResidual";

// Колонки каталогу для форм направника (services, 0107; RLS services_referrer_read).
const SERVICE_COLS = "id, clinic_id, name, modality, duration_min, price, contrast_allowed, contrast_price, active, sort_order, room_id"; // 0121: room_id — база + власні послуги кабінетів
// Переозначення каталогу по кабінетах (service_room_overrides, 0108; RLS читає направник центру).
const SRO_COLS = "clinic_id, room_id, service_id, price, duration_min, contrast_price, active";

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

type Center = {
  accessId: string | null;
  clinicId: string;
  status: string;
  policy: string;
  room_ids: string[] | null;
  name: string;
  city: string | null;
  timezone: string | null;
};

// с22: deep-link зі сторінки «Пошук» — ?tab=mine|waitlist&date=YYYY-MM-DD&entry=<uuid>.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function firstParam(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? null : null;
}

export default async function ReferralPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const backFrom = safeBackHref(sp?.from);
  const rawTab = firstParam(sp?.tab);
  const rawDate = firstParam(sp?.date);
  const rawEntry = firstParam(sp?.entry);
  const initialTab = rawTab === "mine" || rawTab === "waitlist" ? rawTab : null;
  const initialDate = rawDate && DATE_RE.test(rawDate) ? rawDate : null;
  const initialEntry = rawEntry && UUID_RE.test(rawEntry) ? rawEntry : null;
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
  const servicesByClinic: Record<string, ServiceLike[]> = {};
  const roomOverridesByClinic: Record<string, RoomOverrideRow[]> = {};

  if (profile.role === "referrer") {
    // Глобальний направник: членство — лише через referral_access.
    const { data: access } = await supabase
      .from("referral_access")
      .select("id, clinic_id, status, policy, room_ids")
      .eq("referrer_id", user.id);
    const list = access ?? [];
    const clinicIds = Array.from(new Set(list.map((a) => a.clinic_id as string)));

    const clinicsById: Record<string, { name?: string; city?: string | null; timezone?: string | null }> = {};
    if (clinicIds.length) {
      const { data: clinics } = await supabase.from("clinics").select("id, name, city, timezone").in("id", clinicIds);
      (clinics ?? []).forEach((c) => { clinicsById[c.id as string] = { name: c.name as string, city: (c.city as string) ?? null, timezone: (c.timezone as string) ?? null }; });
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
        timezone: clinicsById[a.clinic_id as string]?.timezone ?? null,
      });
    });

    const activeIds = centers.filter((c) => c.status === "active").map((c) => c.clinicId);
    if (activeIds.length) {
      const { data: rooms } = await supabase
        .from("rooms")
        .select("id, name, modality, apparatus_model, clinic_id, schedule, active")
        .in("clinic_id", activeIds)
        .order("name");
      (rooms ?? []).forEach((r) => {
        const cid = r.clinic_id as string;
        (roomsByClinic[cid] ||= []).push(r);
      });
      // Каталоги активних центрів (RLS services_referrer_read — лише центри з грантом).
      // ВСІ рядки (у т.ч. active=false): buildCatalog розрізняє «не налаштовували»
      // (→ статика) від «усі вимкнені» (→ порожньо, напрям закрито). High-2.
      const { data: svc } = await supabase
        .from("services").select(SERVICE_COLS)
        .in("clinic_id", activeIds).order("sort_order");
      (svc ?? []).forEach((s) => { (servicesByClinic[s.clinic_id as string] ||= []).push(s as ServiceLike); });
      // Переозначення по кабінетах активних центрів (2b) — ВСІ рядки (active=false ховає позицію).
      const { data: ov } = await supabase
        .from("service_room_overrides").select(SRO_COLS)
        .in("clinic_id", activeIds);
      (ov ?? []).forEach((o) => { (roomOverridesByClinic[o.clinic_id as string] ||= []).push(o as RoomOverrideRow); });
    }
  } else {
    // Адмін: прев'ю порталу для власного центру (один «центр»).
    // Його назва йде і в підпис кнопки повернення — «← Medicom» зрозуміліше,
    // ніж безадресне «Назад»: адмін бачить, куди саме він вийде.
    const { data: clinic } = await supabase
      .from("clinics")
      .select("id, name, city, configured_at, timezone")
      .eq("id", profile.clinic_id as string)
      .single();
    if (clinic && !clinic.configured_at) redirect("/setup");
    if (clinic) {
      centers.push({ accessId: null, clinicId: clinic.id as string, status: "active", policy: "direct", room_ids: null, name: (clinic.name as string) ?? "", city: (clinic.city as string) ?? null, timezone: (clinic.timezone as string) ?? null });
      const { data: rooms } = await supabase
        .from("rooms")
        .select("id, name, modality, apparatus_model, clinic_id, schedule, active")
        .eq("clinic_id", profile.clinic_id as string)
        .order("name");
      roomsByClinic[clinic.id as string] = rooms ?? [];
      const { data: svc } = await supabase
        .from("services").select(SERVICE_COLS)   // ВСІ рядки (active=false теж) — High-2
        .eq("clinic_id", profile.clinic_id as string).order("sort_order");
      servicesByClinic[clinic.id as string] = (svc ?? []) as ServiceLike[];
      const { data: ov } = await supabase
        .from("service_room_overrides").select(SRO_COLS)
        .eq("clinic_id", profile.clinic_id as string);
      roomOverridesByClinic[clinic.id as string] = (ov ?? []) as RoomOverrideRow[];
    }
  }

  /* Вимкнені кабінети в порталі направника (див. lib/rooms.ts). Центрів тут може
     бути кілька, і в кожного СВОЯ таймзона, тому залишки рахуємо окремо по кожному
     центру — одним tz на всіх «сьогодні» біля півночі поїхало б.
     Для направника RLS (0024) віддає з queue_entries лише ВЛАСНІ записи, тож
     «залишок» тут означає рівно те, що треба: кабінет тримається у списку, поки в
     ньому лишились ЙОГО пацієнти. У прев'ю адміна той самий запит бачить увесь
     центр — теж коректно для того, хто дивиться.
     Запиту не буде взагалі, якщо у центрі немає вимкнених кабінетів. */
  const residualRoomIdsByClinic: Record<string, string[]> = {};
  const residualRoomCountsByClinic: Record<string, Record<string, number>> = {};
  await Promise.all(
    centers
      .filter((c) => c.status === "active")
      .map(async (c) => {
        const offIds = offRoomIdsOf(roomsByClinic[c.clinicId] as Array<{ id: string; active?: boolean | null }> | undefined);
        const res = await residualOffRooms(supabase, c.clinicId, offIds, c.timezone);
        residualRoomIdsByClinic[c.clinicId] = res.ids;
        residualRoomCountsByClinic[c.clinicId] = res.counts;
      }),
  );

  return (
    <ReferralPortal
      role={profile.role as string}
      backHref={profile.role === "admin" ? backFrom : null}
      backLabel={profile.role === "admin" ? (centers[0]?.name || "Мій центр") : null}
      centers={centers}
      roomsByClinic={roomsByClinic as Parameters<typeof ReferralPortal>[0]["roomsByClinic"]}
      residualRoomIdsByClinic={residualRoomIdsByClinic}
      residualRoomCountsByClinic={residualRoomCountsByClinic}
      servicesByClinic={servicesByClinic}
      roomOverridesByClinic={roomOverridesByClinic}
      doctorName={(profile.full_name as string) ?? (user.email ?? "Лікар")}
      doctorId={user.id}
      initialTab={initialTab}
      initialDate={initialDate}
      initialEntry={initialEntry}
    />
  );
}
