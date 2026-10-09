import { NextResponse } from "next/server";
import { PLATFORM_LOG_COLUMNS, hydrateLogRows, requirePlatformOperator, type PlatformLogRaw } from "@/lib/platformAuth";
import { safeDbError, zUuid } from "@/lib/validation";

/* ===== GET /api/platform/log?clinic_id=&limit= — журнал дій операторів (0206) =====
   Останні N (≤200, типово 100) записів, свіжі зверху; `clinic_id` звужує до
   одного центру. Імена операторів резолвляться окремим читанням за id (журнал
   імен не зберігає — вони живуть у `platform_operators` і змінюються); `details`
   на виході — лише відомі ключі (`projectLogDetails`, біла проекція). */

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
    .select(PLATFORM_LOG_COLUMNS)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (clinicId) q = q.eq("clinic_id", clinicId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: safeDbError("api/platform/log", error) }, { status: 500 });

  const hydrated = await hydrateLogRows(admin, (data ?? []) as PlatformLogRaw[]);
  if (!hydrated.ok) return NextResponse.json({ error: safeDbError("api/platform/log.operators", hydrated.error) }, { status: 500 });
  return NextResponse.json({ log: hydrated.items, limit });
}
