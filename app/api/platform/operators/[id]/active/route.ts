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
     • останнього АКТИВНОГО вимкнути не можна (те саме, з іншого боку) — і до
       оновлення, і ПІСЛЯ нього (гонка двох запитів; див. нижче).
   Вимкнення не вбиває сесію: гейт відмовляє з наступного запиту, прапорець
   маршрутизації знімається — middleware поведе на /queue, а там профілю немає →
   /api/auth/reset → вихід. Не знявся (збій GoTrue) — теж не петля: сторінка
   /platform показує «доступ вимкнено» з кнопкою виходу (вхід вимкненому закрито,
   тож самовирівнювання при вході тут НЕМАЄ — консоль каже про це). Видалення оператора НЕ
   передбачено: слід у журналі і в обліку центрів (status_changed_by) має лишатись. */

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

  if (!active) {
    /* Гонка «двоє вимикають одне одного» (ревʼю с84, лінза C, L-2): лічильник ДО
       оновлення в обох запитах бачить 2, і без повторної перевірки лишилось би 0
       активних — а повернути контур тоді можна лише SQL (bootstrap інертний, поки
       таблиця не порожня). Тому ПІСЛЯ оновлення рахуємо ще раз — активних
       ОКРІМ цілі (ревʼю с84 р2, L-1: ціль могло щойно повернути чуже «повернення»,
       і тоді вона рахувалася б як «інший активний»); 0 або «не прочиталось» —
       повертаємо рядок і відмовляємо. Повернення лише вмикає, тож у будь-якому
       переплетенні наприкінці лишається ≥1 активний. */
    const { count: after, error: aErr } = await admin
      .from("platform_operators")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .neq("id", targetId);
    if (aErr || after == null || after < 1) {
      const { error: rErr } = await admin
        .from("platform_operators")
        .update({ active: true, disabled_at: null })
        .eq("id", targetId);
      if (rErr) logError({ event: "platform.operator_disable_revert_failed", actorId: operator.id, entityId: targetId, errorCode: "revert", message: rErr.message });
      if (aErr || after == null) {
        return NextResponse.json({ error: safeDbError("api/platform/operators.active.recount", aErr ?? { message: "count null" }) }, { status: 500 });
      }
      return NextResponse.json({ error: "Це останній активний оператор — вимкнути не можна" }, { status: 409 });
    }
  }

  /* Прапорець маршрутизації — слідом за рядком. Помилка тут НЕ відкочує рядок
     (рядок — джерело прав; прапорець — лише куди вести), але не мовчить. */
  const { error: mErr } = await admin.auth.admin.updateUserById(targetId, {
    app_metadata: active ? { ...PLATFORM_APP_METADATA_ON } : { ...PLATFORM_APP_METADATA_OFF },
  });
  if (mErr) logError({ event: "platform.claim_update_failed", actorId: operator.id, entityId: targetId, errorCode: "updateUserById", message: mErr.message });

  await platformLog(admin, {
    operatorId: operator.id,
    action: active ? "operator.enabled" : "operator.disabled",
    targetOperatorId: targetId,
  });
  /* `claim_synced: false` — рядок змінено, прапорець ні: консоль каже це вголос.
     Увімкнення: /api/auth/login долагодить прапорець при наступному вході.
     Вимкнення: вхід вимкненому закрито, тож прапорець лишиться, доки його не
     знімуть повторним вимкненням/увімкненням; прав він не дає — middleware
     поведе людину на /platform, а там «доступ вимкнено» з кнопкою виходу. */
  return NextResponse.json({ ok: true, claim_synced: !mErr });
}
