import { NextResponse } from "next/server";
import { requirePlatformOperator } from "@/lib/platformAuth";
import { safeDbError } from "@/lib/validation";
import { logError } from "@/lib/serverLog";
import { effectiveStatus, type ClinicListItem, type ClinicStats } from "@/lib/platformContract";

/* ===== GET /api/platform/clinics — центри як клієнти платформи (0206, с84) =====
   Три читання під service_role ПІСЛЯ гейта: `clinics` (без ПДн: назва, місто,
   зона, дати), `platform_accounts` (статус / тариф / оплачено до; рядка може
   не бути = trial) і агрегати `platform_clinic_stats()` (штат, кабінети,
   записи за 30 днів, остання активність, інтеграції — лічильники, не рядки).
   Пацієнтських даних цей роут не читає і читати не має: оператор керує центрами
   як клієнтами. Агрегати — best-effort: збій `platform_clinic_stats()` дає
   `stats: null` у кожному рядку і слід у лозі, а не 500 на весь перелік — це
   точка входу оператора (ревʼю с84 р2, L-5). Межа: PostgREST віддає до 1000 рядків на читання — центрів
   на платформі на порядки менше; стане більше — пагінація, а не збільшення стелі. */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requirePlatformOperator({ path: new URL(req.url).pathname });
  if (!gate.ok) return gate.res;
  const { admin } = gate;

  const [{ data: clinics, error: cErr }, { data: accounts, error: aErr }, { data: stats, error: sErr }] = await Promise.all([
    admin.from("clinics").select("id, name, city, timezone, created_at, configured_at").order("created_at", { ascending: true }),
    admin.from("platform_accounts").select("clinic_id, status, status_changed_at, plan, paid_until"),
    admin.rpc("platform_clinic_stats"),
  ]);
  if (cErr) return NextResponse.json({ error: safeDbError("api/platform/clinics.clinics", cErr) }, { status: 500 });
  if (aErr) return NextResponse.json({ error: safeDbError("api/platform/clinics.accounts", aErr) }, { status: 500 });
  if (sErr) logError({ event: "platform.stats_read_failed", actorId: gate.operator.id, errorCode: sErr.code ?? null, message: sErr.message });

  const accById = new Map((accounts ?? []).map((a) => [String(a.clinic_id).toLowerCase(), a]));
  const statsById = new Map(((sErr ? [] : stats ?? []) as Array<ClinicStats & { clinic_id: string }>).map((s) => [String(s.clinic_id).toLowerCase(), s]));

  const items: ClinicListItem[] = (clinics ?? []).map((c) => {
    const key = String(c.id).toLowerCase();
    const acc = accById.get(key) ?? null;
    const st = statsById.get(key) ?? null;
    return {
      id: c.id,
      name: c.name,
      city: c.city ?? null,
      timezone: c.timezone,
      created_at: c.created_at,
      configured_at: c.configured_at ?? null,
      status: effectiveStatus(acc),
      status_changed_at: acc?.status_changed_at ?? null,
      plan: acc?.plan ?? null,
      paid_until: acc?.paid_until ?? null,
      stats: st
        ? {
            staff_n: st.staff_n, admins_n: st.admins_n, referrers_n: st.referrers_n, ceos_n: st.ceos_n,
            rooms_n: st.rooms_n, rooms_active_n: st.rooms_active_n, services_n: st.services_n,
            entries_total: Number(st.entries_total), entries_30d: Number(st.entries_30d),
            last_activity_at: st.last_activity_at ?? null,
            integration_keys_n: st.integration_keys_n, webhooks_n: st.webhooks_n, gcal_status: st.gcal_status ?? null,
          }
        : null,
    };
  });
  return NextResponse.json({ clinics: items });
}
