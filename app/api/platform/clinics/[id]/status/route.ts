import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOperator, platformLog } from "@/lib/platformAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zOptText, zUuid } from "@/lib/validation";
import { CLINIC_STATUSES, STATUS_REASON_MAX, effectiveStatus, statusNeedsReason } from "@/lib/platformContract";

/* ===== POST /api/platform/clinics/[id]/status — статус центру як клієнта (0206) =====
   body: { status: trial|active|suspended|archived, reason?: string }.
   Причина ОБОВʼЯЗКОВА для suspended / archived (центр втрачає вхід — слід має
   пояснювати чому); для trial / active — за бажанням. Рядка обліку може не бути
   (= trial) — тоді він створюється тут. Зміна на той самий статус — no-op без
   запису в журнал і без створення рядка (журнал — про дії, а не про кліки).
   Статус у коді 0206 застосовується при ВІДКРИТТІ сесії (`loginVerdict`:
   /api/auth/login і автовхід після /set-password): персонал центру зі статусом
   suspended / archived не входить. */

const sStatus = z.object({
  status: z.enum(CLINIC_STATUSES),
  reason: zOptText(STATUS_REASON_MAX),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformOperator({ path: new URL(req.url).pathname });
  if (!gate.ok) return gate.res;
  const { admin, operator } = gate;
  const { id: rawId } = await ctx.params;
  const idp = zUuid.safeParse(rawId);
  if (!idp.success) return NextResponse.json({ error: "Некоректний ідентифікатор" }, { status: 400 });
  const clinicId = idp.data;

  const parsed = await parseBody("api/platform/clinic.status", req, sStatus, "Вкажіть статус із переліку");
  if (!parsed.ok) return parsed.res;
  const { status, reason } = parsed.data;
  if (statusNeedsReason(status) && !reason) {
    return NextResponse.json({ error: "Для призупинення або архіву вкажіть причину" }, { status: 400 });
  }

  const { data: clinic, error: cErr } = await admin.from("clinics").select("id, name").eq("id", clinicId).maybeSingle();
  if (cErr) return NextResponse.json({ error: safeDbError("api/platform/clinic.status.clinic", cErr) }, { status: 500 });
  if (!clinic) return NextResponse.json({ error: "Центр не знайдено" }, { status: 404 });

  const { data: acc, error: aErr } = await admin
    .from("platform_accounts").select("clinic_id, status").eq("clinic_id", clinicId).maybeSingle();
  if (aErr) return NextResponse.json({ error: safeDbError("api/platform/clinic.status.read", aErr) }, { status: 500 });
  const from = effectiveStatus(acc);
  /* Той самий статус — no-op і БЕЗ рядка теж: «trial → trial» для центру без
     обліку не створює рядка і не пише сліду (ревʼю с84, лінза B). */
  if (from === status) return NextResponse.json({ ok: true, unchanged: true, status });

  const now = new Date().toISOString();
  const patch = {
    status, status_reason: reason, status_changed_at: now, status_changed_by: operator.id,
    updated_at: now, updated_by: operator.id,
  };
  const { error: wErr } = acc
    ? await admin.from("platform_accounts").update(patch).eq("clinic_id", clinicId)
    : await admin.from("platform_accounts").insert({ clinic_id: clinicId, ...patch });
  if (wErr) return NextResponse.json({ error: safeDbError("api/platform/clinic.status.write", wErr) }, { status: 500 });

  await platformLog(admin, {
    operatorId: operator.id,
    action: "clinic.status_changed",
    clinicId,
    clinicName: clinic.name,
    details: { from, to: status, reason },
  });
  return NextResponse.json({ ok: true, status, from });
}
