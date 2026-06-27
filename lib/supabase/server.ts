import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";

// Supabase client for server code (Server Components, Route Handlers,
// Server Actions). Reads/refreshes the session via cookies.
// In Next.js 15 cookies() is async.
// Возвращаемый тип фиксируем как SupabaseClient<Database>: @supabase/ssr@0.5.2
// инстанцирует SupabaseClient по СТАРОЙ сигнатуре дженериков, а supabase-js@2.108
// ввёл новый параметр (ClientOptions), из-за чего <Database> у ssr «съезжает» и
// результаты запросов резолвятся в never. Приведение к одно-параметрической форме
// SupabaseClient<Database> восстанавливает корректную типизацию. (Убрать после
// апгрейда @supabase/ssr до версии под supabase-js 2.x.)
export async function createClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component - safe to ignore,
            // session refresh is handled by middleware.
          }
        },
      },
    }
  ) as unknown as SupabaseClient<Database>;
}
