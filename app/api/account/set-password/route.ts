import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { clientIp, rateLimitOk } from "@/lib/rateLimit";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zPassword } from "@/lib/validation";

const INVALID = "Посилання недійсне або вже використане. Зверніться до адміністратора.";

/* invite_token — hex довжиною 64 (два UUID без дефісів, див. /api/staff). Форма
   токена перевіряється ДО звернення до БД: сміття не має доїжджати до lookup. */
const zInviteToken = z.string().trim().regex(/^[0-9a-f]{32,80}$/i, "invalid token");
const sSetPassword = z.object({ token: zInviteToken, password: zPassword });

// GET /api/account/set-password?token=… — резолвимо ОДНОРАЗОВИЙ токен у логін/ПІБ,
// щоб користувач бачив, для якого акаунта задає пароль. Без зміни стану.
export async function GET(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }

  const tokenRes = zInviteToken.safeParse(new URL(req.url).searchParams.get("token") ?? "");
  if (!tokenRes.success) return NextResponse.json({ error: INVALID }, { status: 400 });
  const token = tokenRes.data;

  // Rate-limit за IP — захист від перебору токенів через lookup.
  const ip = clientIp(req);
  if (!(await rateLimitOk(`setpw:lookup:${ip}`, 30, 600))) {
    return NextResponse.json({ error: "Забагато спроб. Зачекайте кілька хвилин і спробуйте знову." }, { status: 429 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("login, full_name, password_set")
    .eq("invite_token", token)
    .maybeSingle();

  if (!profile || profile.password_set) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  return NextResponse.json({ login: profile.login, full_name: profile.full_name });
}

// POST /api/account/set-password — користувач задає пароль за ОДНОРАЗОВИМ токеном
// із /set-password?token=… Токен підтверджує володіння і гаситься після використання.
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }

  const parsed = await parseBody("api/account/set-password", req, sSetPassword, "Пароль мінімум 8 символів, посилання має бути дійсним");
  if (!parsed.ok) return parsed.res;
  const { token, password } = parsed.data;

  // Rate-limit за IP — захист від перебору токенів.
  const ip = clientIp(req);
  if (!(await rateLimitOk(`setpw:ip:${ip}`, 20, 600))) {
    return NextResponse.json({ error: "Забагато спроб. Зачекайте кілька хвилин і спробуйте знову." }, { status: 429 });
  }

  const admin = createAdminClient();

  /* RF-02 (аудит с32): токен гаситься АТОМАРНО — одним умовним UPDATE, ДО зміни
     пароля. Стара схема «select → updateUserById → окремий update» давала гонку:
     два паралельні POST з одним токеном проходили pre-check обидва (переможе
     останній пароль), а збій між GoTrue і profiles лишав токен ЖИВИМ при вже
     зміненому паролі. Тепер: WHERE invite_token = … AND password_set = false —
     рівно один запит забирає токен (row lock у Postgres), решта отримує 0 рядків
     і INVALID. Це той самий прийом claim-first, що в atomic claim вейтліста. */
  const { data: claimed, error: cErr } = await admin
    .from("profiles")
    .update({ password_set: true, invite_token: null })
    .eq("invite_token", token)
    .eq("password_set", false)
    .select("id")
    .maybeSingle();
  if (cErr) return NextResponse.json({ error: safeDbError("api/account/set-password", cErr) }, { status: 400 });
  if (!claimed) return NextResponse.json({ error: INVALID }, { status: 400 });

  const { error: uErr } = await admin.auth.admin.updateUserById(claimed.id as string, { password });
  if (uErr) {
    /* GoTrue не прийняв пароль — повертаємо токен, щоб людина могла повторити
       за тим самим посиланням. Відкат СУВОРО умовний (ревʼю р.1 MINOR-9):
       .is("invite_token", null).eq("password_set", true) — рівно той стан,
       який лишив НАШ клейм. Інакше інтерливінг «клейм → таймаут GoTrue →
       адмін перевидав посилання» затирав би СВІЖИЙ токен адміна старим
       (можливо скомпрометованим — заради чого й перевидавали). Якщо відкат
       не вдався — стан fail-closed (токен мертвий, пароль не змінено),
       адміністратор перевидасть посилання. Залишковий кут (не діра): якщо
       uErr — це таймаут ПІСЛЯ фактично застосованого пароля, токен
       воскресає при вже зміненому паролі — але токен і так підтверджує
       володіння ЦИМ акаунтом, тож повторний прохід лише перезапише пароль
       тим самим власником; password_set=false при робочому паролі —
       видимий стан, що самовиправляється повторним сабмітом. */
    const { error: rErr } = await admin
      .from("profiles")
      .update({ password_set: false, invite_token: token })
      .eq("id", claimed.id)
      .is("invite_token", null)
      .eq("password_set", true);
    if (rErr) safeDbError("api/account/set-password.rollback", rErr);
    return NextResponse.json({ error: safeDbError("api/account/set-password", uErr) }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
