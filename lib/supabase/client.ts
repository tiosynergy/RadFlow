import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";

/**
 * Клиент Supabase для браузера (Client Components).
 * Использует публичные ключи NEXT_PUBLIC_*.
 */
// См. комментарий в server.ts: ssr@0.5.2 «съезжает» по дженерикам с supabase-js@2.108,
// поэтому приводим к SupabaseClient<Database> вручную для корректной типизации.
export function createClient(): SupabaseClient<Database> {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  ) as unknown as SupabaseClient<Database>;
}

/** Настроен ли Supabase (заданы ли переменные окружения). */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
