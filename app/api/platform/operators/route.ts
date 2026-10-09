import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOperator, platformLog, tempOperatorPassword } from "@/lib/platformAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zEmail, zOptName, zOptText } from "@/lib/validation";
import { isTechnicalEmail } from "@/lib/login";
import { logError } from "@/lib/serverLog";
import { PLATFORM_APP_METADATA_ON, PLATFORM_CLAIM_VALUE } from "@/lib/platformClaim";

/* ===== /api/platform/operators — оператори платформи (0206, с84) =====
   GET  — перелік (без паролів і токенів: їх у рядку і немає).
   POST — новий оператор: акаунт auth (managed, прапорець маршрутизації в
          app_metadata) + рядок `platform_operators`. Відповідь — тимчасовий
          пароль РІВНО один раз тому, хто створив; передати новому оператору
          поза системою (той самий клас довіри, що й посилання /set-password).
   Усе — ПІСЛЯ гейта `requirePlatformOperator`; ліміт per-operator на створення. */

const sCreate = z.object({
  email: zEmail,
  full_name: zOptName,
  note: zOptText(2000),
});

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requirePlatformOperator({ path: new URL(req.url).pathname });
  if (!gate.ok) return gate.res;
  const { data, error } = await gate.admin
    .from("platform_operators")
    .select("id, email, full_name, active, created_at, disabled_at, note")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: safeDbError("api/platform/operators.list", error) }, { status: 500 });
  return NextResponse.json({ operators: data ?? [], me: gate.operator.id });
}

export async function POST(req: Request) {
  const gate = await requirePlatformOperator({
    path: new URL(req.url).pathname,
    rateLimit: { key: "platform:op_create", max: 10, windowSeconds: 3600 },
  });
  if (!gate.ok) return gate.res;
  const { admin, operator } = gate;

  const parsed = await parseBody("api/platform/operators", req, sCreate, "Вкажіть коректний email оператора");
  if (!parsed.ok) return parsed.res;
  const { email, note } = parsed.data;
  const fullName = parsed.data.full_name ?? "";
  if (isTechnicalEmail(email)) {
    return NextResponse.json({ error: "Email оператора має бути справжньою поштою, а не службовою адресою" }, { status: 400 });
  }

  const tempPass = tempOperatorPassword();
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: tempPass,
    user_metadata: { managed: "true", platform: PLATFORM_CLAIM_VALUE },
    app_metadata: { ...PLATFORM_APP_METADATA_ON },
  });
  if (cErr || !created?.user) {
    const msg = cErr?.message || "";
    return NextResponse.json(
      { error: /registered|already|exists/i.test(msg) ? "Email вже використовується в RadFlow" : safeDbError("api/platform/operators.createUser", cErr) },
      { status: 400 }
    );
  }
  const id = created.user.id;
  const { error: iErr } = await admin.from("platform_operators").insert({
    id, email, full_name: fullName, active: true, created_by: operator.id, note,
  });
  if (iErr) {
    const { error: dErr } = await admin.auth.admin.deleteUser(id);
    if (dErr) logError({ event: "platform.operator_compensation_failed", actorId: operator.id, entityId: id, errorCode: dErr.message ?? null });
    return NextResponse.json({ error: safeDbError("api/platform/operators.insert", iErr) }, { status: 500 });
  }

  await platformLog(admin, { operatorId: operator.id, action: "operator.created", targetOperatorId: id });
  return NextResponse.json({ ok: true, id, email, temp_password: tempPass });
}
