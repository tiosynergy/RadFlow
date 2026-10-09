import crypto from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zEmail, zOptName } from "@/lib/validation";
import { isTechnicalEmail } from "@/lib/login";
import { clientIp, rateLimitOk } from "@/lib/rateLimit";
import { logError } from "@/lib/serverLog";
import { platformLog, tempOperatorPassword } from "@/lib/platformAuth";
import { PLATFORM_APP_METADATA_ON, PLATFORM_CLAIM_VALUE } from "@/lib/platformClaim";

/* ===== POST /api/platform/bootstrap — ПЕРШИЙ оператор платформи (0206, с84) =====

   Курка і яйце: операторів створює оператор (/api/platform/operators), а першого
   створювати нікому. Цей роут робить це РІВНО ОДИН РАЗ: поки `platform_operators`
   порожня. Далі він інертний (409) — і лишається в дереві свідомо, щоб відновлення
   з бекапу, у якому таблиця порожня, не вимагало ручного SQL.

   Хто стереже замість ролі: `CRON_SECRET` у заголовку (той самий секрет, що
   авторизує /api/maintenance/retention і /api/outbox/deliver; порівняння
   timingSafeEqual, fail-closed без секрету) + ліміт по IP (5 за годину, ДО
   порівняння секрету; при відмові лімітера — ВІДМОВА). Тіло — email (справжня
   пошта, не службовий домен radflow.local) і ПІБ.
   ⚠️ Вікно: поки таблиця порожня, власник CRON_SECRET може викарбувати
   оператора. Тому bootstrap — одразу після деплою 0206; далі 409 (а 409 на
   свіжому середовищі — сигнал, що хтось устиг раніше). Два паралельні виклики
   в це вікно дадуть двох «перших» — обидва з секретом, тобто від власника.

   Відповідь — тимчасовий пароль, показаний РІВНО один раз тому, хто викликав
   (власник, зі свого терміналу). У лог сервера і в журнал платформи пароль не
   потрапляє. Вхід — /login за email + цей пароль → консоль /platform. */

const sBootstrap = z.object({
  email: zEmail,
  full_name: zOptName,
});

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET не налаштовано на сервері" }, { status: 500 });
  }
  /* Ліміт ДО порівняння секрету (ревʼю с84, лінза C, L-3): інакше перебір
     секрету нічим не тротлиться. Ключ — IP; при відмові лімітера — відмова. */
  const ok = await rateLimitOk(`platform:bootstrap:${clientIp(req)}`, 5, 3600, "closed");
  if (!ok) return NextResponse.json({ error: "Забагато запитів. Спробуйте за годину." }, { status: 429 });
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері" }, { status: 500 });
  }

  const parsed = await parseBody("api/platform/bootstrap", req, sBootstrap, "Вкажіть коректний email і ПІБ оператора");
  if (!parsed.ok) return parsed.res;
  const { email } = parsed.data;
  const fullName = parsed.data.full_name ?? "";
  if (isTechnicalEmail(email)) {
    return NextResponse.json({ error: "Email оператора має бути справжньою поштою, а не службовою адресою" }, { status: 400 });
  }

  const admin = createAdminClient();
  /* count: exact, head: true — рядки не читаємо, лише число; помилка читання =
     відмова (fail-closed: «не знаю, чи порожня» ≠ «порожня»). */
  const { count, error: cntErr } = await admin
    .from("platform_operators")
    .select("id", { count: "exact", head: true });
  if (cntErr) {
    return NextResponse.json({ error: safeDbError("api/platform/bootstrap.count", cntErr) }, { status: 500 });
  }
  if (count == null) {
    return NextResponse.json({ error: "Не вдалося перевірити, чи є оператори (лічильник порожній)" }, { status: 500 });
  }
  if (count > 0) {
    return NextResponse.json({ error: "Оператор уже є — bootstrap більше не доступний. Нових операторів створює оператор у консолі." }, { status: 409 });
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
      { error: /registered|already|exists/i.test(msg) ? "Email вже використовується в RadFlow" : safeDbError("api/platform/bootstrap.createUser", cErr) },
      { status: 400 }
    );
  }
  const id = created.user.id;
  const { error: iErr } = await admin.from("platform_operators").insert({
    id, email, full_name: fullName, active: true, created_by: null,
  });
  if (iErr) {
    /* Компенсація: акаунт без рядка оператора — сирота (№24 назве його за 15 хв,
       якщо deleteUser не дійде). */
    const { error: dErr } = await admin.auth.admin.deleteUser(id);
    if (dErr) logError({ event: "platform.bootstrap_compensation_failed", entityId: id, errorCode: "deleteUser", message: dErr.message });
    return NextResponse.json({ error: safeDbError("api/platform/bootstrap.insert", iErr) }, { status: 500 });
  }

  await platformLog(admin, { operatorId: null, action: "operator.bootstrapped", targetOperatorId: id, details: { bootstrap: true } });
  return NextResponse.json({ ok: true, id, email, temp_password: tempPass, login_url: "/login" });
}
