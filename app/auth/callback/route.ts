import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Обробляє перехід за листом-підтвердженням email.
 * Supabase надсилає лінк виду /auth/callback?code=...
 * Обмінюємо code на сесію і ведемо в кабінет.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/queue";
  // Лише внутрішні шляхи: один провідний "/", без "//" чи "/\" (захист від open-redirect).
  const next = /^\/(?![/\\])/.test(rawNext) ? rawNext : "/queue";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
