import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/* Машинні канали (Bearer-ключ, без cookie-сесії) проходять повз сесійний
   шар. Редиректу на /login тут не було й раніше — PROTECTED це allowlist, і
   ні /fhir, ні /api/integrations у ньому не значаться. Але updateSession
   висить на всьому matcher-і й на КОЖНОМУ машинному запиті створює
   Supabase-клієнт заради сесії, якої в нього не буде ніколи. При стелі
   240 запитів/хв на ключ це чистий overhead, ще й зчіпляє інтеграційний
   канал зі станом Auth: деградація Auth не має впливати на RIS, який
   автентифікується зовсім іншим механізмом. */
const MACHINE_PREFIXES = ["/fhir/", "/api/integrations/"];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (MACHINE_PREFIXES.some((p) => path.startsWith(p))) {
    return NextResponse.next({ request });
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Все маршруты, кроме:
     * - _next/static, _next/image (внутренние ассеты Next.js)
     * - favicon.ico
     * - /board (статическое демо-прототип в public/board — остаётся публичным)
     * - файлы со статическими расширениями
     */
    "/((?!_next/static|_next/image|favicon.ico|board|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)",
  ],
};
