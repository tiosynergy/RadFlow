import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { clientIp, rateLimitOk, rlKey } from "@/lib/rateLimit";
import { parseBody } from "@/lib/validationHttp";
import { isTechnicalEmail } from "@/lib/login";
import { logError } from "@/lib/serverLog";
import { LOGIN_BLOCKED_STATUSES, isClinicStatus } from "@/lib/platformContract";

/* Межа довжини — теж захист: identifier іде в ключ rate-limit (хешується) і в
   резолв логіна, password — у Supabase Auth. Повідомлення про помилку — те саме
   узагальнене, що й при невірному паролі: воно НЕ має розрізняти «немає такого
   логіна» і «не той пароль» (енумерація акаунтів). */
const sLogin = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});

// POST /api/auth/login — вхід за логіном АБО email + паролем.
// Резолв логін→email виконується ЛИШЕ на сервері (service-role); email клієнту
// не повертається — це закриває енумерацію акаунтів. Сесія — через cookie.
// 0206 (с84): відповідь несе `kind` — "platform" для оператора платформи (акаунт
// без профілю; клієнт веде в /platform) або "clinic". Персонал центру зі статусом
// suspended / archived (`platform_accounts`) НЕ входить: сесію, яку щойно відкрив
// GoTrue, тут же гасимо і віддаємо 403 з поясненням. Глобальні акаунти
// (направник / керівник, clinic_id NULL) і вже відкриті сесії не чіпаються —
// названо в ToDo (Н-25).
export async function POST(req: Request) {
  const FAIL = "Невірний логін/email або пароль.";
  const parsed = await parseBody("api/auth/login", req, sLogin, FAIL);
  if (!parsed.ok) return parsed.res;
  const { identifier: ident, password } = parsed.data;
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }

  // Rate-limit: за IP і окремо за ідентифікатором (захист від перебору паролів).
  const ip = clientIp(req);
  const [okIp, okId] = await Promise.all([
    rateLimitOk(`login:ip:${ip}`, 15, 300),
    // Ключ із логіна — ХЕШОМ (rlKey): інакше вміст і довжину PK у rate_limits
    // задає атакувальник (мільйон випадкових логінів = мільйон рядків).
    rateLimitOk(rlKey("login:id", ident), 8, 300),
  ]);
  if (!okIp || !okId) {
    return NextResponse.json({ error: "Забагато спроб входу. Зачекайте кілька хвилин і спробуйте знову." }, { status: 429 });
  }

  let email = ident.toLowerCase();
  if (ident.includes("@")) {
    /* 0124: службові домени — не спосіб входу. У радіолога адреса ще й
       випадкова (rad.<hex>@…), тож підібрати її не можна; але в направників і
       CEO вона будується з логіна й цілком вгадувана, а логін — публічний
       ідентифікатор. Тому глушимо весь службовий домен, а не одну роль:
       для цих акаунтів вхід має йти логіном. */
    if (isTechnicalEmail(email)) {
      return NextResponse.json({ error: FAIL }, { status: 400 });
    }
  } else {
    /* Резолв логін→email через RPC (0072). Раніше було `.ilike("login", ident)`:
       семантично це регістронезалежна рівність, але планувальник не може взяти
       btree по lower(login) — предикат не sargable, тож КОЖНА спроба входу (і кожна
       спроба перебору) сканувала profiles цілком. RPC робить lower(login) = lower($1)
       і бере індекс. Доступ до функції має лише service_role: за логіном вона віддає
       email, тобто клієнтам це був би готовий інструмент енумерації акаунтів. */
    const admin = createAdminClient();
    const { data: resolved } = await admin.rpc("resolve_login_email", { p_login: ident });
    if (!resolved) return NextResponse.json({ error: FAIL }, { status: 400 });
    email = String(resolved).toLowerCase();
  }

  const supabase = await createClient();
  const { data: signed, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (/email not confirmed/i.test(error.message)) {
      return NextResponse.json({ error: "Спочатку підтвердьте email — перевірте пошту." }, { status: 400 });
    }
    return NextResponse.json({ error: FAIL }, { status: 400 });
  }

  /* 0206: хто увійшов — оператор платформи чи персонал центру, і чи центр не
     призупинений. Читання під service_role за id ПЕРЕВІРЕНОЇ сесії (ніколи з
     тіла). Помилка читання НЕ зриває вхід (доступність входу важливіша — той
     самий вибір, що в лімітера), але ніколи не мовчить (`logError`). */
  const uid = signed.user?.id ?? null;
  if (uid) {
    const admin = createAdminClient();
    const { data: op, error: opErr } = await admin
      .from("platform_operators").select("id, active").eq("id", uid).maybeSingle();
    if (opErr) logError({ event: "login.kind_read_failed", actorId: uid, errorCode: opErr.code ?? null, message: opErr.message });
    if (op) {
      if (!op.active) {
        await supabase.auth.signOut();
        return NextResponse.json({ error: "Доступ оператора вимкнено. Зверніться до іншого оператора RadFlow." }, { status: 403 });
      }
      return NextResponse.json({ ok: true, kind: "platform" });
    }
    const { data: prof, error: pErr } = await admin
      .from("profiles").select("clinic_id").eq("id", uid).maybeSingle();
    if (pErr) logError({ event: "login.kind_read_failed", actorId: uid, errorCode: pErr.code ?? null, message: pErr.message });
    if (prof?.clinic_id) {
      const { data: acc, error: aErr } = await admin
        .from("platform_accounts").select("status").eq("clinic_id", prof.clinic_id).maybeSingle();
      if (aErr) logError({ event: "login.status_read_failed", actorId: uid, clinicId: prof.clinic_id, errorCode: aErr.code ?? null, message: aErr.message });
      if (acc && isClinicStatus(acc.status) && LOGIN_BLOCKED_STATUSES.includes(acc.status)) {
        await supabase.auth.signOut();
        logError({ event: "login.clinic_blocked", actorId: uid, clinicId: prof.clinic_id, errorCode: acc.status });
        return NextResponse.json(
          { error: "Доступ вашого центру до RadFlow призупинено. Зверніться до RadFlow." },
          { status: 403 }
        );
      }
    }
  }
  return NextResponse.json({ ok: true, kind: "clinic" });
}
