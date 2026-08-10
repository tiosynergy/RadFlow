import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SearchScreen, { type SearchClinicOpt, type SearchRoomOpt } from "@/components/SearchScreen";
import { grantRoomIds } from "@/lib/rooms";

/* ===== /search — универсальный поиск пациентов и исследований (с22) =====

   ОДНА страница для всех пяти ролей; область данных при этом определяет НЕ она,
   а сервер поиска (POST /api/search) из сессии. Здесь SSR готовит только
   СПРАВОЧНИКИ для фильтров и подписей: разрешённые клиники и кабинеты (по ним
   клиент резолвит названия — сами результаты несут только id). Расширить область
   подменой этих пропсов нельзя: они не участвуют в серверной фильтрации. */

export default async function SearchPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("clinic_id, full_name, role, clinics(name, timezone)")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");
  const role = (profile.role as string) || "admin";

  let clinics: SearchClinicOpt[] = [];
  let rooms: SearchRoomOpt[] = [];
  let backHref = "/queue";
  let sources: Array<"queue" | "waitlist"> = ["queue", "waitlist"];
  // Зона клиники для дата-пресетов (инвариант M-4). Мультиклиничным ролям — зона
  // ПЕРВОЙ клиники: общей «сегодня» у нескольких зон не существует, выбор
  // детерминированный (как calTz у ReferrerBoard).
  let clinicTz: string | null = null;

  if (role === "admin" || role === "registrar" || role === "radiologist") {
    if (!profile.clinic_id) redirect(role === "radiologist" ? "/radiologist" : "/queue");
    const clinic = (Array.isArray(profile.clinics) ? profile.clinics[0] : profile.clinics) as
      | { name?: string; timezone?: string | null }
      | null;
    clinics = [{ id: profile.clinic_id as string, name: clinic?.name || "Мій центр" }];
    clinicTz = clinic?.timezone || null;
    const { data: r } = await supabase
      .from("rooms")
      .select("id, name, clinic_id, modality, active")
      .eq("clinic_id", profile.clinic_id as string)
      .order("name");
    rooms = r ?? [];
    if (role === "radiologist") {
      // Радиологу показываем в фильтре ТОЛЬКО назначенные кабинеты (сервер поиска
      // всё равно сузит область — это лишь честная выпадайка).
      const { data: rr } = await supabase.from("radiologist_rooms").select("room_id").eq("profile_id", user.id);
      const mine = new Set((rr || []).map((x) => x.room_id));
      rooms = rooms.filter((x) => mine.has(x.id));
      backHref = "/radiologist";
      sources = ["queue"];
    }
  } else if (role === "referrer") {
    const { data: acc } = await supabase
      .from("referral_access")
      .select("clinic_id, status, room_ids, clinics(name, timezone)")
      .eq("referrer_id", user.id)
      .eq("status", "active");
    const active = acc || [];
    clinics = active.map((a) => {
      const c = (Array.isArray(a.clinics) ? a.clinics[0] : a.clinics) as { name?: string; timezone?: string | null } | null;
      return { id: a.clinic_id, name: c?.name || "Центр" };
    });
    const c0 = active.length ? ((Array.isArray(active[0].clinics) ? active[0].clinics[0] : active[0].clinics) as { timezone?: string | null } | null) : null;
    clinicTz = c0?.timezone || null;
    if (clinics.length) {
      const { data: r } = await supabase
        .from("rooms")
        .select("id, name, clinic_id, modality, active")
        .in("clinic_id", clinics.map((c) => c.id))
        .order("name");
      // Ограничение кабинетов гранта (referral_access.room_ids) — сузим выпадайку.
      // Семантика массива — в grantRoomIds (lib/rooms.ts), зеркало БД (0137).
      const limits = new Map(active.map((a) => {
        const l = grantRoomIds(a.room_ids as string[] | null);
        return [a.clinic_id, l ? new Set(l) : null] as const;
      }));
      rooms = (r ?? []).filter((x) => {
        const lim = limits.get(x.clinic_id);
        return !lim || lim.has(x.id);
      });
    }
    backHref = "/referral";
  } else if (role === "ceo") {
    const { data: acc } = await supabase
      .from("ceo_access")
      .select("clinic_id, clinics(name, timezone)")
      .eq("ceo_id", user.id)
      .eq("status", "active");
    clinics = (acc || []).map((a) => {
      const c = (Array.isArray(a.clinics) ? a.clinics[0] : a.clinics) as { name?: string; timezone?: string | null } | null;
      return { id: a.clinic_id, name: c?.name || "Центр" };
    });
    const c0 = acc?.length ? ((Array.isArray(acc[0].clinics) ? acc[0].clinics[0] : acc[0].clinics) as { timezone?: string | null } | null) : null;
    clinicTz = c0?.timezone || null;
    if (clinics.length) {
      const { data: r } = await supabase
        .from("rooms")
        .select("id, name, clinic_id, modality, active")
        .in("clinic_id", clinics.map((c) => c.id))
        .order("name");
      rooms = r ?? [];
    }
    backHref = "/ceo";
  } else {
    redirect("/queue");
  }

  return (
    <SearchScreen
      roleKey={role}
      userName={(profile.full_name as string) || user.email || ""}
      clinics={clinics}
      rooms={rooms}
      sources={sources}
      backHref={backHref}
      showPhone={role !== "ceo"}
      showReferrerCol={role === "admin" || role === "registrar"}
      clinicTz={clinicTz}
    />
  );
}
