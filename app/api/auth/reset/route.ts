import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/* ===== GET /api/auth/reset =====
   Розлогін для «мертвої» сесії: auth-користувач існує, а профілю немає.

   Звідки береться цей стан: профіль видалили, поки людина була залогінена —
   каскад від видалення клініки (наступили живцем 21.08: ERR_TOO_MANY_
   REDIRECTS без жодної підказки), delete_clinic_member для співробітника,
   ручне втручання в БД.

   Механіка петлі без цього роута: middleware бачить сесію і жене з /login
   на /queue; сторінка /queue не знаходить профіль і жене на /login. Жодна
   сторона не знає, що інша робить те саме. Server Component розірвати цикл
   не може — йому заборонено писати cookie; Route Handler — може.

   Тому сторінки з `!profile` редіректять СЮДИ: сесія гаситься, людина
   потрапляє на /login з поясненням, а не на «Сторінка недоступна».

   0206 (с84): той самий тупик є і в контурі платформи — акаунт із прапорцем
   оператора в app_metadata, але без рядка `platform_operators` (middleware за
   прапорцем вів би його з /queue назад на /platform). Сторінка /platform
   редіректить сюди з `?reason=platform_missing`; причина — лише з переліку
   (значення параметра в розмітку не потрапляє, /login зіставляє його з
   фіксованими текстами). */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REASONS = new Set(["profile_missing", "platform_missing"]);

export async function GET(req: Request) {
  const supabase = await createClient();
  try {
    await supabase.auth.signOut();
  } catch {
    /* Мережа/Auth недоступні — все одно ведемо на /login: локальні cookie
       signOut уже спробував зняти, а падати тут означало б лишити людину в
       петлі, від якої цей роут і рятує. */
  }
  const reqUrl = new URL(req.url);
  const want = reqUrl.searchParams.get("reason");
  const url = new URL("/login", reqUrl.origin);
  url.searchParams.set("reason", want && REASONS.has(want) ? want : "profile_missing");
  return NextResponse.redirect(url);
}
