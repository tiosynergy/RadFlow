import { NextResponse } from "next/server";
import { requirePlatformOperator } from "@/lib/platformAuth";
import { safeDbError, zUuid } from "@/lib/validation";
import { effectiveStatus, type ClinicStats, type PlatformAccountRow, type PlatformLogItem } from "@/lib/platformContract";
import { isTechnicalEmail } from "@/lib/login";

/* ===== GET /api/platform/clinics/[id] — картка центру як клієнта (0206, с84) =====
   Що віддає: реквізити центру (назва, місто, адреса, контакти ЦЕНТРУ, зона, дати),
   облік (статус / тариф / оплачено до / нотатки), агрегати, кабінети, штат
   (ПІБ, роль, логін, стан запрошення; робочі контакти — ЛИШЕ в адміністраторів:
   це контактні особи клієнта), лічильники направників і керівників (без імен:
   це люди інших сторін), інтеграції (без секретів: назва ключа, префікс, стан;
   вебхук — url і стан; дзеркало Google — стан/останній синк) і останні 50 записів
   журналу платформи по центру.
   ЧОГО НЕ ВІДДАЄ і не має: жодного рядка `queue_entries` / `waitlist_entries` /
   `patient_cases` / `doctors` / `referrer_private` — пацієнтів оператор не бачить. */

export const dynamic = "force-dynamic";

const STATUS_LIMIT = 50;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformOperator({ path: new URL(req.url).pathname });
  if (!gate.ok) return gate.res;
  const { admin } = gate;
  const { id: rawId } = await ctx.params;
  const idp = zUuid.safeParse(rawId);
  if (!idp.success) return NextResponse.json({ error: "Некоректний ідентифікатор" }, { status: 400 });
  const clinicId = idp.data;

  const { data: clinic, error: cErr } = await admin
    .from("clinics")
    .select("id, name, city, address, phones, emails, timezone, created_at, configured_at, queue_delay_policy")
    .eq("id", clinicId)
    .maybeSingle();
  if (cErr) return NextResponse.json({ error: safeDbError("api/platform/clinic.clinic", cErr) }, { status: 500 });
  if (!clinic) return NextResponse.json({ error: "Центр не знайдено" }, { status: 404 });

  const [acc, staff, refs, ceos, rooms, stats, keys, hooks, gcal, log] = await Promise.all([
    admin.from("platform_accounts")
      .select("clinic_id, status, status_reason, status_changed_at, status_changed_by, plan, paid_until, notes, updated_at")
      .eq("clinic_id", clinicId).maybeSingle(),
    admin.from("profiles")
      .select("id, full_name, role, login, email, phone, approved, password_set, created_at")
      .eq("clinic_id", clinicId).order("created_at", { ascending: true }),
    admin.from("referral_access").select("status").eq("clinic_id", clinicId),
    admin.from("ceo_access").select("status").eq("clinic_id", clinicId),
    admin.from("rooms").select("id, name, modality, apparatus_model, active").eq("clinic_id", clinicId).order("name", { ascending: true }),
    admin.rpc("platform_clinic_stats"),
    admin.from("integration_keys").select("id, name, key_prefix, active, revoked_at, created_at, last_used_at").eq("clinic_id", clinicId),
    admin.from("integration_webhooks").select("id, url, enabled, created_at").eq("clinic_id", clinicId),
    admin.from("google_calendar_connections").select("status, enabled, last_sync_at, last_error_code").eq("clinic_id", clinicId).maybeSingle(),
    admin.from("platform_log")
      .select("id, occurred_at, operator_id, action, clinic_id, clinic_name, target_operator_id, details")
      .eq("clinic_id", clinicId).order("occurred_at", { ascending: false }).limit(STATUS_LIMIT),
  ]);
  const firstErr = [acc, staff, refs, ceos, rooms, stats, keys, hooks, gcal, log].find((r) => r.error);
  if (firstErr?.error) {
    return NextResponse.json({ error: safeDbError("api/platform/clinic.read", firstErr.error) }, { status: 500 });
  }

  const account: PlatformAccountRow | null = acc.data
    ? { ...(acc.data as Omit<PlatformAccountRow, "status">), status: effectiveStatus(acc.data) }
    : null;

  const countBy = (rows: Array<{ status: string }> | null) => {
    const out: Record<string, number> = {};
    for (const r of rows ?? []) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  };

  /* Робочі контакти — лише в адміністраторів (контактні особи клієнта); решті
     штату — ПІБ, роль, логін і стан запрошення. Службові адреси (radflow.local)
     не показуємо ніколи — це не пошта, а ключ входу. */
  const people = (staff.data ?? []).map((p) => {
    const isAdmin = p.role === "admin";
    const email = isAdmin && p.email && !isTechnicalEmail(p.email) ? p.email : null;
    return {
      id: p.id,
      full_name: p.full_name ?? "",
      role: p.role,
      login: p.login,
      approved: p.approved,
      password_set: p.password_set,
      created_at: p.created_at,
      email,
      phone: isAdmin ? (p.phone ?? null) : null,
    };
  });

  const statRow = ((stats.data ?? []) as Array<ClinicStats & { clinic_id: string }>)
    .find((s) => String(s.clinic_id).toLowerCase() === clinicId.toLowerCase()) ?? null;
  const statsOut: ClinicStats | null = statRow
    ? { ...statRow, entries_total: Number(statRow.entries_total), entries_30d: Number(statRow.entries_30d) }
    : null;

  /* Імена операторів у журналі — окремим читанням за id (журнал імен не зберігає). */
  const logRows = (log.data ?? []) as Array<Omit<PlatformLogItem, "operator_name" | "target_operator_name" | "details"> & { details: unknown }>;
  const opIds = [...new Set(logRows.flatMap((r) => [r.operator_id, r.target_operator_id]).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (opIds.length) {
    const { data: ops, error: oErr } = await admin.from("platform_operators").select("id, full_name, email").in("id", opIds);
    if (oErr) return NextResponse.json({ error: safeDbError("api/platform/clinic.operators", oErr) }, { status: 500 });
    for (const o of ops ?? []) names.set(String(o.id).toLowerCase(), o.full_name || o.email);
  }
  const logOut: PlatformLogItem[] = logRows.map((r) => ({
    id: r.id,
    occurred_at: r.occurred_at,
    operator_id: r.operator_id,
    operator_name: r.operator_id ? names.get(String(r.operator_id).toLowerCase()) ?? null : null,
    action: r.action,
    clinic_id: r.clinic_id,
    clinic_name: r.clinic_name,
    target_operator_id: r.target_operator_id,
    target_operator_name: r.target_operator_id ? names.get(String(r.target_operator_id).toLowerCase()) ?? null : null,
    details: (r.details && typeof r.details === "object" && !Array.isArray(r.details) ? r.details : {}) as Record<string, unknown>,
  }));

  return NextResponse.json({
    clinic: {
      id: clinic.id, name: clinic.name, city: clinic.city ?? null, address: clinic.address ?? null,
      phones: Array.isArray(clinic.phones) ? clinic.phones : [], emails: Array.isArray(clinic.emails) ? clinic.emails : [],
      timezone: clinic.timezone, created_at: clinic.created_at, configured_at: clinic.configured_at ?? null,
      queue_delay_policy: clinic.queue_delay_policy,
    },
    status: effectiveStatus(acc.data),
    account,
    stats: statsOut,
    people,
    referrers: countBy(refs.data as Array<{ status: string }> | null),
    ceos: countBy(ceos.data as Array<{ status: string }> | null),
    rooms: rooms.data ?? [],
    integrations: {
      keys: keys.data ?? [],
      webhooks: hooks.data ?? [],
      gcal: gcal.data ?? null,
    },
    log: logOut,
  });
}
