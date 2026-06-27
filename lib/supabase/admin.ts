import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";

// Серверний клієнт із service_role-ключем. ТІЛЬКИ для серверного коду
// (Route Handlers/Server Actions) — ключ ніколи не потрапляє у браузер.
// Обходить RLS, тож кожен роут МАЄ сам перевіряти права викликача.
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export function isAdminConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
