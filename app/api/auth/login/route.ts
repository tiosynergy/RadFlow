import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { clientIp, rateLimitOk, rlKey } from "@/lib/rateLimit";
import { parseBody } from "@/lib/validationHttp";
import { isTechnicalEmail } from "@/lib/login";

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
export async function POST(req: Request) {
  const FAIL = "Невірний логін/email або пароль.";
  const parsed = await parseBody("api/auth/login", req, sLogin, FAIL);
  if (!parsed.ok) return parsed.res;
  const { identifier: ident, password } = parsed.data;

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
    if (!isAdminConfigured()) {
      return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
    }
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
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (/email not confirmed/i.test(error.message)) {
      return NextResponse.json({ error: "Спочатку підтвердьте email — перевірте пошту." }, { status: 400 });
    }
    return NextResponse.json({ error: FAIL }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
