import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOperator, platformLog } from "@/lib/platformAuth";
import { parseJson } from "@/lib/validationHttp";
import { safeDbError, zDateKey, zOptText, zUuid } from "@/lib/validation";
import { ACCOUNT_NOTES_MAX, PLAN_MAX } from "@/lib/platformContract";

/* ===== POST /api/platform/clinics/[id]/account — тариф, оплата, нотатки (0206) =====
   Ручний контур без платіжного провайдера (рішення власника: рахунки — пізніше):
   body: { plan?, paid_until?, notes? } — ВІДСУТНІЙ ключ = не чіпати, "" / null =
   очистити. Статусу цей роут не торкається (окремий роут зі своїм слідом).
   У журнал — перелік змінених полів і нові значення тарифу / дати; текст нотаток
   у журнал не потрапляє (там може бути що завгодно). */

const sAccount = z.object({
  plan: z.union([zOptText(PLAN_MAX), z.undefined()]),
  paid_until: z.union([zDateKey, z.literal(""), z.null(), z.undefined()]).transform((v) => (v === undefined ? undefined : v || null)),
  notes: z.union([zOptText(ACCOUNT_NOTES_MAX), z.undefined()]),
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

  /* Ключі читаємо з сирого тіла ДО схеми: «відсутній ключ = не чіпати», а zod
     після transform уже не відрізняє відсутнє від очищеного. */
  const raw: unknown = await req.json().catch(() => ({}));
  const keysGiven = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw as object) : [];
  const parsed = parseJson("api/platform/clinic.account", raw, sAccount, "Перевірте поля: тариф до 80 символів, дата у форматі РРРР-ММ-ДД, нотатки до 4000");
  if (!parsed.ok) return parsed.res;

  const patch: Record<string, string | null> = {};
  const fields: string[] = [];
  if (keysGiven.includes("plan")) { patch.plan = parsed.data.plan ?? null; fields.push("plan"); }
  if (keysGiven.includes("paid_until")) { patch.paid_until = parsed.data.paid_until ?? null; fields.push("paid_until"); }
  if (keysGiven.includes("notes")) { patch.notes = parsed.data.notes ?? null; fields.push("notes"); }
  if (!fields.length) return NextResponse.json({ error: "Нічого змінювати" }, { status: 400 });

  const { data: clinic, error: cErr } = await admin.from("clinics").select("id, name").eq("id", clinicId).maybeSingle();
  if (cErr) return NextResponse.json({ error: safeDbError("api/platform/clinic.account.clinic", cErr) }, { status: 500 });
  if (!clinic) return NextResponse.json({ error: "Центр не знайдено" }, { status: 404 });

  const { data: acc, error: aErr } = await admin
    .from("platform_accounts").select("clinic_id").eq("clinic_id", clinicId).maybeSingle();
  if (aErr) return NextResponse.json({ error: safeDbError("api/platform/clinic.account.read", aErr) }, { status: 500 });

  const now = new Date().toISOString();
  const write = { ...patch, updated_at: now, updated_by: operator.id };
  const { error: wErr } = acc
    ? await admin.from("platform_accounts").update(write).eq("clinic_id", clinicId)
    : await admin.from("platform_accounts").insert({ clinic_id: clinicId, ...write });
  if (wErr) return NextResponse.json({ error: safeDbError("api/platform/clinic.account.write", wErr) }, { status: 500 });

  await platformLog(admin, {
    operatorId: operator.id,
    action: "clinic.account_updated",
    clinicId,
    clinicName: clinic.name,
    details: {
      fields,
      ...(fields.includes("plan") ? { plan: patch.plan ?? null } : {}),
      ...(fields.includes("paid_until") ? { paid_until: patch.paid_until ?? null } : {}),
    },
  });
  return NextResponse.json({ ok: true, fields });
}
