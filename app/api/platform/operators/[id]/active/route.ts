import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOperator, platformLog } from "@/lib/platformAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zUuid } from "@/lib/validation";
import { logError } from "@/lib/serverLog";
import { PLATFORM_APP_METADATA_OFF, PLATFORM_APP_METADATA_ON } from "@/lib/platformClaim";

/* ===== POST /api/platform/operators/[id]/active — увімкнути / вимкнути (0206) =====
   body: { active: boolean }. Правила, обидва fail-closed:
     • себе вимкнути не можна (інакше останній клік — і контур без операторів);
     • останнього АКТИВНОГО вимкнути не можна (те саме, з іншого боку).
   Вимкнення не вбиває сесію: гейт відмовляє з наступного запиту, прапорець
   маршрутизації знімається — middleware поведе на /queue, а там профілю немає →
   /api/auth/reset → вихід. Видалення оператора НЕ передбачено: слід у журналі
   і в обліку центрів (status_changed_by) має лишатись. */

const sActive = z.object({ active: z.boolean() });

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformOperator({ path: new URL(req.url).pathname });
  if (!gate.ok) return gate.res;
  const { admin, operator } = gate;
  const { id: rawId } = await ctx.params;
  const idp = zUuid.safeParse(rawId);
  if (!idp.success) return NextResponse.json({ error: "Некоректний ідентифікатор" }, { status: 400 });
  const targetId = idp.data;

  const parsed = await parseBody("api/platform/operators.active", req, sActive);
  if (!parsed.ok) return parsed.res;
  const { active } = parsed.data;

  if (targetId.toLowerCase() === operator.id.toLowerCase()) {
    return NextResponse.json({ error: "Себе вимкнути або увімкнути не можна — попросіть іншого оператора" }, { status: 400 });
  }
  const { data: target, error: tErr } = await admin
    .from("platform_operators")
    .select("id, email, full_name, active")
    .eq("id", targetId)
    .maybeSingle();
  if (tErr) return NextResponse.json({ error: safeDbError("api/platform/operators.active.read", tErr) }, { status: 500 });
  if (!target) return NextResponse.json({ error: "Оператора не знайдено" }, { status: 404 });
  if (target.active === active) return NextResponse.json({ ok: true, unchanged: true });

  if (!active) {
    const { count, error: cErr } = await admin
      .from("platform_operators")
      .select("id", { count: "exact", head: true })
      .eq("active", true);
    if (cErr) return NextResponse.json({ error: safeDbError("api/platform/operators.active.count", cErr) }, { status: 500 });
    if ((count ?? 0) <= 1) {
      return NextResponse.json({ error: "Це останній активний оператор — вимкнути не можна" }, { status: 409 });
    }
  }

  const { error: uErr } = await admin
    .from("platform_operators")
    .update({ active, disabled_at: active ? null : new Date().toISOString() })
    .eq("id", targetId);
  if (uErr) return NextResponse.json({ error: safeDbError("api/platform/operators.active.update", uErr) }, { status: 500 });

  /* Прапорець маршрутизації — слідом за рядком. Помилка тут НЕ відкочує рядок
     (рядок — джерело прав; прапорець — лише куди вести), але не мовчить. */
  const { error: mErr } = await admin.auth.admin.updateUserById(targetId, {
    app_metadata: active ? { ...PLATFORM_APP_METADATA_ON } : { ...PLATFORM_APP_METADATA_OFF },
  });
  if (mErr) logError({ event: "platform.claim_update_failed", actorId: operator.id, entityId: targetId, errorCode: mErr.message ?? null });

  await platformLog(admin, {
    operatorId: operator.id,
    action: active ? "operator.enabled" : "operator.disabled",
    targetOperatorId: targetId,
  });
  return NextResponse.json({ ok: true });
}
