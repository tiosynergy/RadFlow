import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
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
