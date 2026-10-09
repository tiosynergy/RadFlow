import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/supabase/types";

// Supabase client for server code (Server Components, Route Handlers,
// Server Actions). Reads/refreshes the session via cookies.
// In Next.js 15 cookies() is async.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
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
  );
}

/* ===== Клієнт сесії з ВІДКЛАДЕНИМ записом cookie (0206, с84) =====
   Для роутів, які ВІДКРИВАЮТЬ сесію і лише потім вирішують, чи можна її
   віддати (/api/auth/login: вимкнений оператор, персонал призупиненого
   центру). GoTrue видає сесію на signInWithPassword одразу; зі звичайним
   `createClient()` cookie лягали б у відповідь у ту ж мить, і відмова трималась
   би на наступному `signOut()` — тобто на поведінці бібліотеки при збої мережі
   (auth-js 2.110 локальну сесію знімає й тоді, але це властивість версії, а не
   контракт; ревʼю с84 р2, L-12), а чужа сесія в тому ж браузері губилась би.
   Тут cookie збираються в буфер і потрапляють у відповідь лише через
   `commit()`; без нього сесії для браузера не існує, хоч би що впало, а наявна
   сесія іншого акаунта лишається недоторканою.
   `supabase.auth.getUser()` / `signOut()` на цьому клієнті працюють як завжди
   (сховище сесії в @supabase/ssr читає спершу з буфера записаного). */
export async function createDeferredClient() {
  const cookieStore = await cookies();
  const pending: Parameters<SetAllCookies>[0] = [];
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
          pending.push(...cookiesToSet);
        },
      },
    }
  );
  return {
    supabase,
    /** Кладе зібрані cookie у відповідь. Викликати РІВНО тоді, коли сесію
        вирішено віддати; до того відповідь cookie не несе. */
    commit(): void {
      for (const { name, value, options } of pending) cookieStore.set(name, value, options);
      pending.length = 0;
    },
  };
}
