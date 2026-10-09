import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/serverLog";

/* ===== Перевірка ПОТОЧНОГО пароля (с84, «Змінити пароль» оператора) =====
   GoTrue не має окремого «перевір пароль»: єдиний спосіб — увійти ним. Тому
   одноразовий клієнт на anon-ключі БЕЗ збереження сесії (жодних cookie, жодного
   авто-оновлення): він відкриває сесію в памʼяті й одразу її відкликає
   (`signOut({ scope: "local" })` — лише цю сесію, живі сесії людини не чіпає).
   Побічний слід: кожна перевірка — справжній вхід, тож у GoTrue оновлюється
   `last_sign_in_at`, а в логах Auth зʼявляється пара login/logout з IP сервера.

   Три відповіді, і вони різні за змістом:
     ok      — пароль правильний І це той самий акаунт (`expectedUserId`);
     invalid — GoTrue сказав «невірні облікові дані» (400 invalid_credentials)
               АБО вхід відкрив сесію ІНШОГО акаунта: для поточного акаунта це
               теж «не його пароль», і відповідь та сама — інакше різниця 400/503
               підказала б, що пароль підходить до чужого акаунта (ревʼю с84, C);
     error   — не знаємо: мережа, ліміт GoTrue, не налаштовано оточення. Це НЕ
               «невірний пароль» — інакше збій виглядав би як помилка людини.
   Пароль нікуди не пишеться і не логується. */

export type PasswordCheck = "ok" | "invalid" | "error";

export async function checkCurrentPassword(email: string, password: string, expectedUserId: string): Promise<PasswordCheck> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return "error";
  try {
    const probe = createSupabaseClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await probe.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.code === "invalid_credentials" || /invalid login credentials/i.test(error.message)) return "invalid";
      return "error";
    }
    /* Сесію, яку щойно відкрив GoTrue, гасимо: перевірка не має залишати слідів.
       Збій відкликання не змінює відповіді (пароль ПЕРЕВІРЕНО), але лишає гучний
       слід: refresh-токен жив лише в памʼяті цього виклику, а сесію GoTrue
       прибере успішна зміна пароля (вона завершує всі інші сесії). */
    if (data.session) {
      try {
        const { error: soErr } = await probe.auth.signOut({ scope: "local" });
        if (soErr) logError({ event: "platform.own_password_probe_signout_failed", actorId: expectedUserId, errorCode: soErr.code ?? null, message: soErr.message });
      } catch (e) {
        logError({ event: "platform.own_password_probe_signout_failed", actorId: expectedUserId, errorCode: "throw", message: e instanceof Error ? e.message : null });
      }
    }
    /* Той самий акаунт? GoTrue шукає за email серед парольних акаунтів, тож інший
       id тут бути не мав би; якщо таки так — «не той пароль» + окремий слід. */
    if (!data.user || data.user.id !== expectedUserId) {
      logError({ event: "platform.own_password_probe_other_user", actorId: expectedUserId, errorCode: "other_user" });
      return "invalid";
    }
    return "ok";
  } catch {
    return "error";
  }
}
