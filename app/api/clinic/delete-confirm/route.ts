import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/serverLog";

/* ===== GET /api/clinic/delete-confirm?rid=…&t=… =====
   Виконання видалення центру за посиланням із листа підтвердження.

   GET, бо це перехід із поштового клієнта — форму туди не вкладеш. Токен
   одноразовий і живе 60 хвилин, тож prefetch-ризик GET-а обмежений; сам
   токен ніде не логуються і не рендериться.

   Порядок незворотних кроків:
     1) RPC clinic_deletion_execute — перевірки + видалення клініки ОДНІЄЮ
        транзакцією зі слідом в audit_log; повертає auth-id ВСЬОГО штату;
     2) auth.admin.deleteUser для кожного — інакше кожен працівник стає
        сиротою з ERR_TOO_MANY_REDIRECTS (наступили живцем 21.08);
     3) редірект на /login: сесія викликача вже мертва разом з акаунтом.

   Якщо крок 2 упаде посередині — клініки вже немає, а частина auth-акаунтів
   лишилась. Це НЕ мовчазний стан: кожен збій пишеться в лог з id, а огляд
   сиріт є в списку перевірок (auth.users без профілю). */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{48}$/i;

function goodbye(base: string, params: Record<string, string>): NextResponse {
  const url = new URL("/login", base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

type ExecuteResult = { clinic_name?: string; staff_user_ids?: string[] } | null;

export async function GET(req: Request) {
  const u = new URL(req.url);
  const rid = u.searchParams.get("rid") ?? "";
  const token = u.searchParams.get("t") ?? "";

  /* Валідація форми ДО будь-якого звернення в БД. Помилки — редіректом на
     /login з кодом причини: людина прийшла з поштового клієнта, JSON їй
     нічого не скаже. */
  if (!UUID_RE.test(rid) || !TOKEN_RE.test(token)) {
    return goodbye(u.origin, { deletion: "bad_link" });
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("clinic_deletion_execute", {
    p_request: rid,
    p_token: token,
  });
  if (error) {
    /* Текст помилки RPC навмисно НЕ прокидається в URL: там розрізняються
       «прострочено» / «невірний токен» / «скасовано», і це підказка тому,
       хто перебирає токени. Людині достатньо «не вдалося», деталі — в логах. */
    logError({ event: "clinic.delete_confirm", errorCode: "rpc_failed", message: error.message });
    return goodbye(u.origin, { deletion: "failed" });
  }
  const result = data as unknown as ExecuteResult;

  const staff = (result?.staff_user_ids ?? []).filter((s: string) => UUID_RE.test(s));
  let authFailures = 0;
  for (const userId of staff) {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) {
      authFailures++;
      // Id у лог — без нього сироту потім не знайти.
      logError({ event: "clinic.delete_confirm", errorCode: "auth_delete_failed", message: userId });
    }
  }
  if (authFailures > 0) {
    logError({
      event: "clinic.delete_confirm",
      errorCode: "auth_orphans",
      message: `${authFailures} of ${staff.length}`,
    });
  }

  return goodbye(u.origin, { deletion: "done" });
}
