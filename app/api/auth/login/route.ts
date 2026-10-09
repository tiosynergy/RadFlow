import { NextResponse } from "next/server";
import { z } from "zod";
import { createDeferredClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { clientIp, rateLimitOk, rlKey } from "@/lib/rateLimit";
import { isJsonRequest, parseBody } from "@/lib/validationHttp";
import { isTechnicalEmail } from "@/lib/login";
import { logError } from "@/lib/serverLog";
import { loginVerdict } from "@/lib/platformAuth";
import { PLATFORM_APP_METADATA_OFF, PLATFORM_APP_METADATA_ON, isOperatorByClaim } from "@/lib/platformClaim";

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
// suspended / archived (`platform_accounts`) НЕ входить; вимкнений оператор — теж.
// Сесія, яку GoTrue відкрив на signInWithPassword, до браузера доходить лише
// через `commit()` відкладеного клієнта — ПІСЛЯ вердикту (без commit cookie у
// відповіді немає, хоч би що впало далі). Глобальні акаунти (направник /
// керівник, clinic_id NULL) і вже відкриті сесії не чіпаються — ToDo Н-25.
// Service-role потрібен ЗАВЖДИ (не лише для резолву логіна): вердикт читає
// deny-all таблиці за id щойно відкритої сесії — тому перевірка env безумовна.
export async function POST(req: Request) {
  const FAIL = "Невірний логін/email або пароль.";
  /* login-CSRF (ревʼю с84, лінза C, L-4): лише JSON-запит — HTML-форма чужого
     сайту так не вміє (див. isJsonRequest). */
  if (!isJsonRequest(req)) return NextResponse.json({ error: FAIL }, { status: 415 });
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

  const admin = createAdminClient();
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
    const { data: resolved } = await admin.rpc("resolve_login_email", { p_login: ident });
    if (!resolved) return NextResponse.json({ error: FAIL }, { status: 400 });
    email = String(resolved).toLowerCase();
  }

  const { supabase, commit } = await createDeferredClient();
  const { data: signed, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (/email not confirmed/i.test(error.message)) {
      return NextResponse.json({ error: "Спочатку підтвердьте email — перевірте пошту." }, { status: 400 });
    }
    return NextResponse.json({ error: FAIL }, { status: 400 });
  }

  /* Відмова ПІСЛЯ відкриття сесії: cookie не комітимо, а refresh-токен, який
     GoTrue уже видав, відкликаємо (scope local — лише цю сесію; живі сесії
     людини в інших браузерах — Н-25). Збій відкликання не змінює відповіді:
     токен живе тільки в буфері цього запиту і до браузера не доходить. */
  const refuse = async (message: string) => {
    const { error: soErr } = await supabase.auth.signOut({ scope: "local" });
    if (soErr) logError({ event: "login.revoke_failed", actorId: signed.user?.id ?? null, errorCode: "signOut", message: soErr.message });
    return NextResponse.json({ error: message }, { status: 403 });
  };

  /* 0206: хто увійшов — оператор платформи чи персонал центру, і чи центр не
     призупинений. Читання під service_role за id ПЕРЕВІРЕНОЇ сесії (ніколи з
     тіла) — `loginVerdict`. */
  const uid = signed.user?.id ?? null;
  let kind: "platform" | "clinic" = "clinic";
  if (uid) {
    const verdict = await loginVerdict(admin, uid);
    if (verdict.kind === "platform") {
      if (!verdict.active) return refuse("Доступ оператора вимкнено. Зверніться до іншого оператора RadFlow.");
      kind = "platform";
      /* Прапорець маршрутизації відстав від рядка (збій при увімкненні, ручне
         втручання) — лагодимо тут, у єдиному місці, де сесія і рядок зустрічаються
         напевно. middleware читає app_metadata через getUser() (запит до Auth,
         не JWT), тож правка діє з наступного запиту. Збій — лише слід. */
      if (!isOperatorByClaim(signed.user)) {
        const { error: mErr } = await admin.auth.admin.updateUserById(uid, { app_metadata: { ...PLATFORM_APP_METADATA_ON } });
        if (mErr) logError({ event: "platform.claim_update_failed", actorId: uid, entityId: uid, errorCode: "login_heal_on", message: mErr.message });
      }
    } else {
      /* Прапорець без рядка — знімаємо (інакше middleware водив би людину в
         консоль, де на неї чекає відмова і /api/auth/reset). Лише коли рядок
         ПРОЧИТАНО і його немає: збій читання — не доказ (ревʼю с84, лінза C, L-1). */
      if (verdict.operatorKnown && isOperatorByClaim(signed.user)) {
        const { error: mErr } = await admin.auth.admin.updateUserById(uid, { app_metadata: { ...PLATFORM_APP_METADATA_OFF } });
        if (mErr) logError({ event: "platform.claim_update_failed", actorId: uid, entityId: uid, errorCode: "login_heal_off", message: mErr.message });
      }
      if (verdict.blocked) {
        logError({ event: "login.clinic_blocked", actorId: uid, clinicId: verdict.clinicId, errorCode: verdict.blocked });
        return refuse("Доступ вашого центру до RadFlow призупинено. Зверніться до RadFlow.");
      }
    }
  }
  commit();
  return NextResponse.json({ ok: true, kind });
}
