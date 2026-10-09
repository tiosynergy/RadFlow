import { NextResponse } from "next/server";
import { requirePlatformOperator, platformLog, tempOperatorPassword } from "@/lib/platformAuth";
import { safeDbError, zUuid } from "@/lib/validation";

/* ===== POST /api/platform/operators/[id]/password — скинути пароль (0206) =====
   Новий тимчасовий пароль ІНШОГО оператора — показується РІВНО один раз у
   відповіді; далі людина входить ним через /login і міняє на свій кнопкою
   «Змінити пароль» (/api/platform/me/password). GoTrue при цьому завершує всі
   відкриті сесії цього оператора — консоль попереджає про це в підтвердженні.
   Собі пароль не скидають (с84, нижче). Пароль не логується ніде. Вимкненому
   оператору пароль не скидають (спершу увімкнути — так слід у журналі показує
   обидві дії). */

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformOperator({
    path: new URL(req.url).pathname,
    rateLimit: { key: "platform:op_pwd", max: 10, windowSeconds: 3600 },
  });
  if (!gate.ok) return gate.res;
  const { admin, operator } = gate;
  const { id: rawId } = await ctx.params;
  const idp = zUuid.safeParse(rawId);
  if (!idp.success) return NextResponse.json({ error: "Некоректний ідентифікатор" }, { status: 400 });
  const targetId = idp.data;
  /* Свій пароль тут не скидають (с84): admin-зміна пароля в GoTrue завершує ВСІ
     сесії людини — оператор вилітав із консолі в ту ж секунду, а новий пароль
     зникав разом зі сторінкою (09.10, логи Auth: PUT /admin/users → 200, GET /user →
     403 session_not_found). Свій пароль — лише через /api/platform/me/password. */
  if (targetId.toLowerCase() === operator.id.toLowerCase()) {
    return NextResponse.json({ error: "Свій пароль змінюйте кнопкою «Змінити пароль» — скидання завершило б вашу сесію" }, { status: 400 });
  }

  const { data: target, error: tErr } = await admin
    .from("platform_operators")
    .select("id, active")
    .eq("id", targetId)
    .maybeSingle();
  if (tErr) return NextResponse.json({ error: safeDbError("api/platform/operators.password.read", tErr) }, { status: 500 });
  if (!target) return NextResponse.json({ error: "Оператора не знайдено" }, { status: 404 });
  if (!target.active) return NextResponse.json({ error: "Оператор вимкнений — спершу увімкніть" }, { status: 409 });

  const tempPass = tempOperatorPassword();
  const { error: uErr } = await admin.auth.admin.updateUserById(targetId, { password: tempPass });
  if (uErr) return NextResponse.json({ error: safeDbError("api/platform/operators.password.update", uErr) }, { status: 400 });

  await platformLog(admin, { operatorId: operator.id, action: "operator.password_reset", targetOperatorId: targetId });
  return NextResponse.json({ ok: true, temp_password: tempPass });
}
