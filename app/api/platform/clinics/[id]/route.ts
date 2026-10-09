import { NextResponse } from "next/server";
import { PLATFORM_LOG_COLUMNS, hydrateLogRows, requirePlatformOperator, type PlatformLogRaw } from "@/lib/platformAuth";
import { safeDbError, zUuid } from "@/lib/validation";
import { effectiveStatus, type ClinicStats, type PlatformAccountRow } from "@/lib/platformContract";
import { isTechnicalEmail } from "@/lib/login";
import { logError } from "@/lib/serverLog";

/* ===== GET /api/platform/clinics/[id] — картка центру як клієнта (0206, с84) =====
   Що віддає: реквізити центру (назва, місто, адреса, контакти ЦЕНТРУ, зона, дати),
   облік (статус / тариф / оплачено до / нотатки), агрегати, кабінети, штат
   (ПІБ, роль, логін, стан запрошення; робочі контакти — ЛИШЕ в адміністраторів:
   це контактні особи клієнта), лічильники направників і керівників (без імен:
   це люди інших сторін), інтеграції (без секретів: назва ключа, префікс, стан;
   вебхук — лише ХОСТ і стан: повний url у Zapier/Make сам є токеном доступу,
   ревʼю с84, лінза C, L-5; дзеркало Google — стан/останній синк) і останні 50 записів
   журналу платформи по центру (`details` — лише відомі ключі, біла проекція).
   Агрегати — best-effort: збій `platform_clinic_stats()` дає `stats: null` і слід
   у лозі, а не 500 на всю картку (ревʼю с84, лінза B).
   ЧОГО НЕ ВІДДАЄ і не має: жодного рядка `queue_entries` / `waitlist_entries` /
   `patient_cases` / `doctors` / `referrer_private` — пацієнтів оператор не бачить. */

export const dynamic = "force-dynamic";

const STATUS_LIMIT = 50;

/** Хост вебхука без шляху й запиту (у шляху буває токен). У сервісів на кшталт
    Pipedream ідентифікатор ендпоінта — у ЛІВІЙ мітці хоста (eoXXXX.m.pipedream.net),
    тож за трьох і більше міток ліва маскується: `*.m.pipedream.net` (ревʼю с84 р2,
    L-8). Оператору досить провайдера і стану. Не URL — «—». */
function webhookHost(url: unknown): string {
  try {
    const host = new URL(String(url)).host;
    if (!host) return "—";
    if (/^\[|^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)) return host;
    const labels = host.split(".");
    return labels.length >= 3 ? ["*", ...labels.slice(1)].join(".") : host;
  } catch {
    return "—";
  }
}

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
      .select(PLATFORM_LOG_COLUMNS)
      .eq("clinic_id", clinicId).order("occurred_at", { ascending: false }).limit(STATUS_LIMIT),
  ]);
  const firstErr = [acc, staff, refs, ceos, rooms, keys, hooks, gcal, log].find((r) => r.error);
  if (firstErr?.error) {
    return NextResponse.json({ error: safeDbError("api/platform/clinic.read", firstErr.error) }, { status: 500 });
  }
  if (stats.error) {
    logError({ event: "platform.stats_read_failed", actorId: gate.operator.id, clinicId, errorCode: stats.error.code ?? null, message: stats.error.message });
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

  const statRow = ((stats.error ? [] : stats.data ?? []) as Array<ClinicStats & { clinic_id: string }>)
    .find((s) => String(s.clinic_id).toLowerCase() === clinicId.toLowerCase()) ?? null;
  const statsOut: ClinicStats | null = statRow
    ? { ...statRow, entries_total: Number(statRow.entries_total), entries_30d: Number(statRow.entries_30d) }
    : null;

  /* Імена операторів у журналі — окремим читанням за id (журнал імен не
     зберігає); `details` — біла проекція (hydrateLogRows). */
  const hydrated = await hydrateLogRows(admin, (log.data ?? []) as PlatformLogRaw[]);
  if (!hydrated.ok) return NextResponse.json({ error: safeDbError("api/platform/clinic.operators", hydrated.error) }, { status: 500 });
  const logOut = hydrated.items;

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
      webhooks: (hooks.data ?? []).map((w) => ({ id: w.id, host: webhookHost(w.url), enabled: w.enabled, created_at: w.created_at })),
      gcal: gcal.data ?? null,
    },
    log: logOut,
  });
}
