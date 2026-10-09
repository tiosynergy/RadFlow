import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { clientIp, rateLimitOk } from "@/lib/rateLimit";
import { isJsonRequest, parseBody } from "@/lib/validationHttp";
import { safeDbError, zPassword } from "@/lib/validation";
import { passwordTooLong, PASSWORD_TOO_LONG } from "@/lib/passwordRules";
import { inviteState } from "@/lib/inviteTtl";
import { logError } from "@/lib/serverLog";
import { loginVerdict } from "@/lib/platformAuth";

const INVALID = "Посилання недійсне або вже використане. Зверніться до адміністратора.";
/* RF-02 (пакет 43): протухле посилання відрізняємо від недійсного НАВМИСНО.
   ⚠️ Оракула це не створює: щоб побачити цей текст, треба вже мати на руках
      дійсний токен на 256 біт — тобто знати те, що й так відкриває акаунт.
      Натомість людині кажемо правду, і вона йде по нове посилання, а не
      думає, що помилилась при копіюванні. Текст затверджено власником. */
const EXPIRED = "Термін дії посилання минув. Зверніться до адміністратора за новим.";

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
  /* fail-CLOSED: тут лімітер — ЄДИНИЙ захист від перебору по lookup-у.
     Краще 429, ніж тихо відкритий перебір. */
  if (!(await rateLimitOk(`setpw:lookup:${ip}`, 30, 600, "closed"))) {
    return NextResponse.json({ error: "Забагато спроб. Зачекайте кілька хвилин і спробуйте знову." }, { status: 429 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("login, full_name, password_set, invite_issued_at")
    .eq("invite_token", token)
    .maybeSingle();

  if (!profile || profile.password_set) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }
  /* TTL перевіряємо і ТУТ, а не лише на POST: інакше людина заповнила б форму
     і дізналась про протух лише після сабміту. */
  if (inviteState(profile.invite_issued_at) !== "valid") {
    return NextResponse.json({ error: EXPIRED }, { status: 400 });
  }

  return NextResponse.json({ login: profile.login, full_name: profile.full_name });
}

// POST /api/account/set-password — користувач задає пароль за ОДНОРАЗОВИМ токеном
// із /set-password?token=… Токен підтверджує володіння і гаситься після використання.
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }
  /* login-CSRF (ревʼю с84, лінза C, L-4): роут відкриває сесію (автовхід с82) —
     власний токен атакувальника з чужої HTML-форми залогінив би жертву в його
     акаунт. Лише JSON-запит (isJsonRequest). */
  if (!isJsonRequest(req)) {
    return NextResponse.json({ error: "Непідтримуваний формат запиту" }, { status: 415 });
  }

  const parsed = await parseBody("api/account/set-password", req, sSetPassword, "Пароль мінімум 8 символів, посилання має бути дійсним");
  if (!parsed.ok) return parsed.res;
  const { token, password } = parsed.data;
  /* с85 (Н-27(з)): межа сервера входу — 72 БАЙТИ (bcrypt), а не 200 символів схеми.
     ДО ліміту, читання і клейму: раніше довгий пароль гасив токен, GoTrue відмовляв
     (`validation_failed`), роут відкочував клейм — і людина бачила загальне «не
     вдалося», не знаючи чому. Відповідь не залежить від токена — оракула немає. */
  if (passwordTooLong(password)) {
    return NextResponse.json({ error: PASSWORD_TOO_LONG }, { status: 400 });
  }

  // Rate-limit за IP — захист від перебору токенів.
  const ip = clientIp(req);
  if (!(await rateLimitOk(`setpw:ip:${ip}`, 20, 600))) {
    return NextResponse.json({ error: "Забагато спроб. Зачекайте кілька хвилин і спробуйте знову." }, { status: 429 });
  }

  const admin = createAdminClient();

  /* RF-02 хвіст (пакет 43): ТЕРМІН ДІЇ — ДО клейму.
     ⚠️ Порядок не косметичний. Клейм гасить токен; якби TTL перевірявся
        ПІСЛЯ, протухле посилання спалювало б токен і людина втратила б навіть
        можливість попросити те саме — довелось би перевидавати. Тому спершу
        читаємо штамп, і лише потім забираємо токен.
     ⚠️ Гонка тут нешкідлива: між читанням і клеймом токен могли погасити —
        тоді клейм поверне 0 рядків і людина побачить INVALID, що правда. */
  const { data: pre } = await admin
    .from("profiles")
    .select("invite_issued_at")
    .eq("invite_token", token)
    .eq("password_set", false)
    .maybeSingle();
  if (pre && inviteState(pre.invite_issued_at) !== "valid") {
    return NextResponse.json({ error: EXPIRED }, { status: 400 });
  }

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

  /* с82: пароль задано — людина вже довела володіння акаунтом (одноразовий токен)
     і щойно ввела пароль. Просити її ввести логін і цей самий пароль ще раз на
     /login — зайвий крок, який ми прибираємо: відкриваємо сесію тут же. Поруч —
     контекст для привітання (роль, центр, скільки кабінетів/центрів відкрито),
     щоб екран пояснив, куди людина потрапила. Усе це — best-effort: пароль уже
     стоїть, і жодний збій нижче не має перетворити успіх на 4xx. */
  const welcome = await welcomeAfterSetPassword(admin, claimed.id as string, password);
  return NextResponse.json({ ok: true, ...welcome });
}

/* ---------- Автовхід і контекст привітання (с82) ---------- */

type WelcomePayload = {
  /** Сесію відкрито в cookie відповіді — клієнт може йти на стартовий екран ролі.
      ⚠️ Це відповідь GoTrue на signInWithPassword, а не доказ, що cookie лягла:
      `setAll` у lib/supabase/server.ts глушить виняток (для Server Components);
      у Route Handler `cookies().set()` працює — той самий шлях, що /api/auth/login.
      Якби колись не лягла — людина впаде в /login?redirect=…, тобто деградація мʼяка. */
  signedIn: boolean;
  /** Чому автовходу не було: `other_session` — у цьому браузері вже відкрито інший
      акаунт (ревʼю А, M-2: автовхід не має мовчки підміняти чужу сесію). */
  reason: "other_session" | null;
  /** 0206: центр зі статусом suspended / archived — пароль встановлено, автовходу
      немає (той самий вердикт, що й у /api/auth/login: статус центру діє при
      ВІДКРИТТІ сесії, і запрошення — не обхід). */
  clinic_blocked: boolean;
  role: string | null;
  full_name: string | null;
  /** Центр персоналу (registrar/radiologist/admin); у глобальних ролей — null. */
  clinic_name: string | null;
  /** Радіолог: кабінетів призначено. null — не рахували / не вдалося. */
  rooms_count: number | null;
  /** Направник / керівник: центрів з активним доступом. null — не рахували / не вдалося. */
  centers_count: number | null;
};

/* ⚠️ Клієнт НЕ отримує звідси шлях редіректу — лише роль; шлях він обчислює сам
   (lib/quickStart.startPathForRole). Так у відповіді немає значення, яке можна
   було б підставити під редірект. */
async function welcomeAfterSetPassword(admin: SupabaseClient<Database>, userId: string, password: string): Promise<WelcomePayload> {
  const out: WelcomePayload = { signedIn: false, reason: null, clinic_blocked: false, role: null, full_name: null, clinic_name: null, rooms_count: null, centers_count: null };
  try {
    const { data: prof } = await admin
      .from("profiles")
      .select("role, full_name, clinic_id, clinics(name)")
      .eq("id", userId)
      .maybeSingle();
    if (prof) {
      out.role = prof.role;
      out.full_name = prof.full_name ?? null;
      const clinic = (Array.isArray(prof.clinics) ? prof.clinics[0] : prof.clinics) as { name?: string | null } | null | undefined;
      out.clinic_name = clinic?.name ?? null;
      /* Лічильники — `head: true`, рядки не читаємо: екрану потрібне лише число. */
      if (prof.role === "radiologist") {
        const { count } = await admin.from("radiologist_rooms").select("id", { count: "exact", head: true }).eq("profile_id", userId);
        out.rooms_count = count ?? null;
      } else if (prof.role === "referrer") {
        const { count } = await admin.from("referral_access").select("id", { count: "exact", head: true }).eq("referrer_id", userId).eq("status", "active");
        out.centers_count = count ?? null;
      } else if (prof.role === "ceo") {
        const { count } = await admin.from("ceo_access").select("id", { count: "exact", head: true }).eq("ceo_id", userId).eq("status", "active");
        out.centers_count = count ?? null;
      }
    }

    /* Адреса входу — з auth.users (єдине джерело істини для signInWithPassword;
       у радіолога вона службова й випадкова, profiles.email — лише копія).
       Сесію відкриває КЛІЄНТ СЕСІЇ (cookie), а не service-role: cookie лягають у
       відповідь цього ж Route Handler, як після звичайного /api/auth/login. */
    const { data: au } = await admin.auth.admin.getUserById(userId);
    const email = au?.user?.email;
    /* 0206 (с84): статус центру застосовується при ВІДКРИТТІ сесії — і тут теж,
       інакше персонал призупиненого центру входив би через запрошення повз
       /api/auth/login. Пароль уже стоїть (знадобиться, коли центр повернуть);
       автовходу немає, екран каже чому. Збій читання вердикт не блокує (лог). */
    const verdict = await loginVerdict(admin, userId);
    if (verdict.kind === "clinic" && verdict.blocked) {
      out.clinic_blocked = true;
      logError({ event: "login.clinic_blocked", actorId: userId, clinicId: verdict.clinicId, errorCode: verdict.blocked });
    } else if (email) {
      const session = await createClient();
      /* ⚠️ Чужу живу сесію НЕ підміняємо (ревʼю А, M-2). /set-password не в PROTECTED
         і не в AUTH_PAGES, тож сторінку може відкрити залогінений: адмін, що «перевіряє»
         посилання реєстратора у своєму браузері, або жертва login-CSRF, якій
         прислали чуже посилання. До с82 обох рятував /login (вводили СВІЙ логін);
         автовхід мовчки зробив би браузер адміна сесією реєстратора, а записи
         жертви пішли б у чужий центр. Є сесія будь-якого акаунта — автовходу немає,
         екран чесно каже «увійдіть», а решта відповіді лишається. */
      const { data: cur } = await session.auth.getUser();
      if (cur?.user?.id === userId) {
        /* Та сама людина вже увійшла (адмін скинув пароль, а сесія жива — GoTrue
           admin-зміна пароля сесій не відкликає): входити вдруге нема потреби, і
           «інший акаунт» тут був би неправдою (ревʼю с82 р2, лінза A, L-2). */
        out.signedIn = true;
      } else if (cur?.user) {
        out.reason = "other_session";
      } else {
        const { error: sErr } = await session.auth.signInWithPassword({ email, password });
        out.signedIn = !sErr;
        if (sErr) logError({ event: "set_password.autologin_failed", actorId: userId, errorCode: "sign_in", message: sErr.message });
      }
    }
  } catch (e) {
    /* Пароль уже стоїть — збій тут не перетворюємо на помилку, лише лишаємо слід. */
    logError({ event: "set_password.welcome_failed", actorId: userId, errorCode: "welcome", message: (e as { message?: string })?.message ?? String(e) });
  }
  return out;
}
