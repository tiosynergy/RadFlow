import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// Витягуємо IP клієнта із заголовків проксі (Vercel ставить x-forwarded-for).
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

// Перевірка обмеження частоти через БД (fixed-window, функція rl_check).
// Повертає TRUE, якщо запит ДОЗВОЛЕНО.
// Fail-open: якщо лімітер недоступний (немає service-role або міграцію ще не
// застосовано) — НЕ блокуємо, бо доступність входу важливіша за ідеальний rate-limit.
export async function rateLimitOk(key: string, max: number, windowSeconds: number): Promise<boolean> {
  if (!isAdminConfigured()) return true;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("rl_check", {
      p_key: key,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) return true;
    return data !== false;
  } catch {
    return true;
  }
}
