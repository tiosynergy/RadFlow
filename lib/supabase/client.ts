import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/supabase/types";

/**
 * Клиент Supabase для браузера (Client Components).
 * Использует публичные ключи NEXT_PUBLIC_*.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

/** Настроен ли Supabase (заданы ли переменные окружения). */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
