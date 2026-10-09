import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isAuthApiError, isAuthRetryableFetchError, isAuthSessionMissingError, isAuthWeakPasswordError,
  type AuthError,
} from "@supabase/supabase-js";
import { requirePlatformOperator, platformLog } from "@/lib/platformAuth";
import { createClient } from "@/lib/supabase/server";
import { checkCurrentPassword } from "@/lib/supabase/passwordCheck";
import { isJsonRequest, parseBody } from "@/lib/validationHttp";
import { zPassword } from "@/lib/validation";
import { logError } from "@/lib/serverLog";

/* ===== POST /api/platform/me/password — оператор змінює ВЛАСНИЙ пароль на свій (с84) =====

   Навіщо окремий роут, а не «Скинути пароль» на своєму рядку. Скидання йде через
   auth.admin.updateUserById, а GoTrue, змінюючи пароль через admin API, завершує
   ВСІ сесії людини — і ту, з якої оператор щойно натиснув кнопку. Так і сталося
   09.10.2026 (логи Auth): PUT /admin/users → 200, у ту ж секунду GET /user →
   403 session_not_found; консоль перечитала список, дістала 401, і блок із новим
   паролем зник разом зі сторінкою. Тому скинути СВІЙ пароль тепер не можна
   (/operators/[id]/password відмовляє), а змінити — лише тут.

   Тут пароль міняє САМ користувач через власну сесію (auth.updateUser → PUT /user):
   GoTrue лишає поточну сесію і завершує всі інші. Email — з ПЕРЕВІРЕНОЇ сесії.

   ⚠️ Перевірка поточного пароля тут — ЗАХИСТ ЦЬОГО РОУТУ, а не межа безпеки
   акаунта (ревʼю с84, лінзи B і C): cookie сесії Supabase читаються JS-ом, anon-ключ
   публічний, тож той, хто має токен сесії, може змінити пароль напряму в GoTrue
   (PUT /auth/v1/user), минаючи цей роут. Справжня межа — перемикачі GoTrue з ToDo
   П-6 (рішення власника; їхній поточний стан записано там, не тут): «Require current
   password when updating» — тоді GoTrue сам вимагає `current_password`, який ми вже
   передаємо (поки перемикач вимкнений, GoTrue це поле ігнорує), — і «Secure email
   change». І навіть увімкнені вони межу не замикають: recovery-сесії та акаунти без
   пароля GoTrue не перевіряє, а за пласкої моделі довіри (Н-26) викрадена операторська
   сесія замикає власника через інший операторський акаунт і «Скинути».

   Ліміт — 5 спроб за 15 хв на оператора, fail-CLOSED (тут ліміт — захист від
   перебору пароля). Паролі нікуди не пишуться: ні в журнал платформи, ні в лог. */

const sOwnPassword = z.object({
  current_password: z.string().min(1).max(200),
  new_password: zPassword,
});

/** bcrypt рахує лише 72 БАЙТИ; довший пароль GoTrue відхиляє (validation_failed).
    Кирилиця — 2 байти на літеру, тож це ≈36 кириличних символів. */
const PASSWORD_MAX_BYTES = 72;
const byteLen = (s: string) => new TextEncoder().encode(s).length;

const SESSION_GONE = "Сесія завершилась — увійдіть знову";
const WRONG_CURRENT = "Поточний пароль невірний";
const SAME = "Новий пароль збігається з поточним";
const TOO_LONG = "Новий пароль задовгий: до 72 байт (≈72 латинських або ≈36 кириличних символів)";
/* Мережа впала або GoTrue відповів 5xx ПІСЛЯ того, як міг уже зберегти пароль:
   результат невідомий — кажемо це прямо, щоб людина не лишилась без входу. */
const UNKNOWN_OUTCOME = "Не вдалося підтвердити зміну пароля. Спробуйте увійти з НОВИМ паролем, а якщо не вийде — зі старим.";

export const dynamic = "force-dynamic";

/** Відповідь GoTrue на PUT /user → текст для людини (+ поле, куди повернути фокус).
    Класи помилок — з auth-js: `session_not_found` приходить як
    AuthSessionMissingError (400, без коду), слабкий пароль — AuthWeakPasswordError
    із `reasons`, 500–504/520–530 і мережа — AuthRetryableFetchError. Коди
    поточного пароля — як їх шле GoTrue (`current_password_invalid`; імʼя
    Go-константи …Mismatch на дроті НЕ зʼявляється). */
type Field = "current" | "new";
const SESSION_CODES = new Set(["session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used", "bad_jwt", "no_authorization", "user_not_found"]);
function updateError(e: AuthError): { status: number; error: string; field?: Field } {
  if (isAuthSessionMissingError(e)) return { status: 401, error: SESSION_GONE };
  if (isAuthWeakPasswordError(e)) {
    return { status: 400, field: "new", error: e.reasons.includes("pwned") ? "Цей пароль є у відомих витоках — оберіть інший" : "Пароль надто простий — оберіть довший або складніший" };
  }
  if (isAuthRetryableFetchError(e)) return { status: 503, error: UNKNOWN_OUTCOME };
  if (isAuthApiError(e)) {
    const code = e.code ?? "";
    if (code === "same_password") return { status: 400, field: "new", error: SAME };
    if (code === "current_password_invalid" || code === "current_password_required") return { status: 400, field: "current", error: WRONG_CURRENT };
    if (code === "reauthentication_needed") return { status: 400, error: "Для зміни пароля вийдіть, увійдіть знову й повторіть" };
    if (code === "validation_failed") return { status: 400, field: "new", error: "Сервер входу не прийняв цей пароль — оберіть інший (до 72 байт, без незвичних символів)" };
    /* Ліміт GoTrue на PUT /user (per-IP): пароль навіть не оцінювався — «оберіть
       інший» тут відправило б людину назад у той самий ліміт. */
    if (e.status === 429 || code === "over_request_rate_limit") return { status: 429, error: "Сервіс входу тимчасово обмежив запити — спробуйте за кілька хвилин (пароль не змінено)" };
    /* Мертва сесія (у т.ч. невдале оновлення токена перед PUT) — не «поганий пароль». */
    if (e.status === 401 || e.status === 403 || SESSION_CODES.has(code)) return { status: 401, error: SESSION_GONE };
    if (e.status >= 400 && e.status < 500) return { status: 400, field: "new", error: "Сервер входу не прийняв цей пароль — оберіть інший" };
  }
  return { status: 503, error: UNKNOWN_OUTCOME };
}

export async function POST(req: Request) {
  /* Зміна пароля за cookie-сесією: лише JSON (чужа HTML-форма з text/plain сюди
     не дістанеться — той самий захід, що у вході й установці пароля). */
  if (!isJsonRequest(req)) {
    return NextResponse.json({ error: "Непідтримуваний формат запиту" }, { status: 415 });
  }
  const gate = await requirePlatformOperator({
    path: new URL(req.url).pathname,
    rateLimit: { key: "platform:own_pwd", max: 5, windowSeconds: 900, onFailure: "closed" },
  });
  if (!gate.ok) return gate.res;

  const parsed = await parseBody("api/platform/me/password", req, sOwnPassword, "Вкажіть поточний пароль і новий — мінімум 8 символів");
  if (!parsed.ok) return parsed.res;
  const { current_password, new_password } = parsed.data;
  if (byteLen(new_password) > PASSWORD_MAX_BYTES) {
    return NextResponse.json({ error: TOO_LONG, field: "new" }, { status: 400 });
  }
  if (current_password === new_password) {
    return NextResponse.json({ error: SAME, field: "new" }, { status: 400 });
  }

  /* Email — з ПЕРЕВІРЕНОЇ сесії (getUser ходить у GoTrue), не з тіла і не з рядка
     оператора: перевіряємо пароль саме того акаунта, з якого прийшов запит. */
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== gate.user.id) {
    return NextResponse.json({ error: SESSION_GONE }, { status: 401 });
  }
  if (!user.email) {
    return NextResponse.json({ error: "В акаунта немає email — пароль змінить інший оператор" }, { status: 409 });
  }

  const check = await checkCurrentPassword(user.email, current_password, user.id);
  if (check === "invalid") {
    logError({ event: "platform.own_password_wrong", actorId: user.id, errorCode: "invalid_current" });
    return NextResponse.json({ error: WRONG_CURRENT, field: "current" }, { status: 400 });
  }
  if (check === "error") {
    logError({ event: "platform.own_password_check_failed", actorId: user.id, errorCode: "check_error" });
    return NextResponse.json({ error: "Не вдалося перевірити поточний пароль. Спробуйте за хвилину." }, { status: 503 });
  }

  const { error } = await supabase.auth.updateUser({ password: new_password, current_password });
  if (error) {
    const out = updateError(error);
    logError({ event: "platform.own_password_update_failed", actorId: user.id, errorCode: error.code ?? error.name, message: out.error === UNKNOWN_OUTCOME ? error.message : null });
    return NextResponse.json(out.field ? { error: out.error, field: out.field } : { error: out.error }, { status: out.status });
  }

  await platformLog(gate.admin, { operatorId: gate.operator.id, action: "operator.password_changed" });
  return NextResponse.json({ ok: true });
}
