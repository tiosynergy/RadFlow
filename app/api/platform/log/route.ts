import { NextResponse } from "next/server";
import { requirePlatformOperator } from "@/lib/platformAuth";
import { safeDbError, zUuid } from "@/lib/validation";
import type { PlatformLogItem } from "@/lib/platformContract";

/* ===== GET /api/platform/log?clinic_id=&limit= — журнал дій операторів (0206) =====
   Останні N (≤200, типово 100) записів, свіжі зверху; `clinic_id` звужує до
   одного центру. Імена операторів резолвляться окремим читанням за id (журнал
   імен не зберігає — вони живуть у `platform_operators` і змінюються). */

export const dynamic = "force-dynamic";
const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 200;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const gate = await requirePlatformOperator({ path: url.pathname });
  if (!gate.ok) return gate.res;
  const { admin } = gate;

  const rawLimit = Number(url.searchParams.get("limit") ?? LIMIT_DEFAULT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), LIMIT_MAX) : LIMIT_DEFAULT;
  const rawClinic = url.searchParams.get("clinic_id");
  let clinicId: string | null = null;
  if (rawClinic) {
    const p = zUuid.safeParse(rawClinic);
    if (!p.success) return NextResponse.json({ error: "Некоректний ідентифікатор центру" }, { status: 400 });
    clinicId = p.data;
  }

  let q = admin
    .from("platform_log")
    .select("id, occurred_at, operator_id, action, clinic_id, clinic_name, target_operator_id, details")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (clinicId) q = q.eq("clinic_id", clinicId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: safeDbError("api/platform/log", error) }, { status: 500 });

  const rows = (data ?? []) as Array<Omit<PlatformLogItem, "operator_name" | "target_operator_name" | "details"> & { details: unknown }>;
  const opIds = [...new Set(rows.flatMap((r) => [r.operator_id, r.target_operator_id]).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (opIds.length) {
    const { data: ops, error: oErr } = await admin.from("platform_operators").select("id, full_name, email").in("id", opIds);
    if (oErr) return NextResponse.json({ error: safeDbError("api/platform/log.operators", oErr) }, { status: 500 });
    for (const o of ops ?? []) names.set(String(o.id).toLowerCase(), o.full_name || o.email);
  }
  const items: PlatformLogItem[] = rows.map((r) => ({
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
  return NextResponse.json({ log: items, limit });
}
