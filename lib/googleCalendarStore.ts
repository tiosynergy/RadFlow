/* ===== RadFlow — резервне дзеркало GCal: шар БД (server-only) =====

   Читання/мутації google_calendar_connections + Vault-RPC (0160). Всі
   виклики — service-role admin-клієнтом ПІСЛЯ перевірки прав викликача в
   роуті (requireRole або scoped-токен): таблиці deny-all, клієнт напряму
   сюди не ходить.

   CAS: мутації конекшена йдуть через updateConnectionCas(expectedVersion) —
   два адміни, що одночасно тиснуть кнопки, не перетирають один одного
   мовчки (канон CAS 0075: перевірка на око — не перевірка). */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";
import { logError } from "@/lib/serverLog";

type Admin = SupabaseClient<Database>;
export type ConnectionRow = Database["public"]["Tables"]["google_calendar_connections"]["Row"];
type ConnectionUpdate = Database["public"]["Tables"]["google_calendar_connections"]["Update"];

export async function getConnection(admin: Admin, clinicId: string): Promise<ConnectionRow | null> {
  const { data, error } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (error) throw new Error(`gcal: читання підключення: ${error.message}`);
  return data;
}

export async function getConnectionByTokenHash(admin: Admin, hash: string): Promise<ConnectionRow | null> {
  const { data, error } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("sync_token_hash", hash)
    .maybeSingle();
  if (error) throw new Error(`gcal: пошук за токеном: ${error.message}`);
  return data;
}

/** Рядок гарантовано існує (перше підключення створює його). */
export async function ensureConnection(admin: Admin, clinicId: string): Promise<ConnectionRow> {
  const existing = await getConnection(admin, clinicId);
  if (existing) return existing;
  const { data, error } = await admin
    .from("google_calendar_connections")
    .insert({ clinic_id: clinicId })
    .select("*")
    .single();
  if (error) {
    // гонка двох перших підключень: 23505 → перечитати
    const again = await getConnection(admin, clinicId);
    if (again) return again;
    throw new Error(`gcal: створення підключення: ${error.message}`);
  }
  return data;
}

/**
 * CAS-мутація: застосовується, ЛИШЕ якщо version не змінився з моменту
 * читання. false = вас випередили (роут відповідає 409 «оновіть сторінку»).
 */
export async function updateConnectionCas(
  admin: Admin,
  clinicId: string,
  expectedVersion: number,
  patch: ConnectionUpdate
): Promise<ConnectionRow | null> {
  const { data, error } = await admin
    .from("google_calendar_connections")
    .update({ ...patch, version: expectedVersion + 1 })
    .eq("clinic_id", clinicId)
    .eq("version", expectedVersion)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`gcal: CAS-мутація: ${error.message}`);
  return data;
}

/** Мутація БЕЗ CAS — для системних переходів sync-а (він і так під lease). */
export async function updateConnection(
  admin: Admin,
  clinicId: string,
  patch: ConnectionUpdate
): Promise<void> {
  const { error } = await admin
    .from("google_calendar_connections")
    .update(patch)
    .eq("clinic_id", clinicId);
  if (error) throw new Error(`gcal: мутація підключення: ${error.message}`);
}

/* ── Vault ── */

export async function vaultStore(admin: Admin, secret: string, description: string): Promise<string> {
  const { data, error } = await admin.rpc("gcal_secret_store", {
    p_secret: secret, p_description: description,
  });
  if (error || !data) throw new Error(`gcal: збереження секрета: ${error?.message ?? "порожній id"}`);
  return data;
}

export async function vaultGet(admin: Admin, id: string): Promise<string> {
  const { data, error } = await admin.rpc("gcal_secret_get", { p_id: id });
  if (error || !data) throw new Error(`gcal: читання секрета: ${error?.message ?? "порожньо"}`);
  return data;
}

export async function vaultUpdate(admin: Admin, id: string, secret: string): Promise<void> {
  const { error } = await admin.rpc("gcal_secret_update", { p_id: id, p_secret: secret });
  if (error) throw new Error(`gcal: оновлення секрета: ${error.message}`);
}

/** Ідемпотентне видалення; помилку лише логуємо — disconnect не має
    зриватись через тимчасовий збій чистки (секрет добере ретрай/тригер). */
export async function vaultDeleteQuiet(admin: Admin, id: string): Promise<void> {
  try {
    const { error } = await admin.rpc("gcal_secret_delete", { p_id: id });
    if (error) {
      logError({ event: "gcal.vault", errorCode: "delete_failed", message: error.message });
    }
  } catch (e) {
    // «quiet» мусить бути quiet ДО КІНЦЯ: мережевий reject із чистки старого
    // секрета інакше летів у catch callback-роуту і зносив щойно записаний
    // НОВИЙ секрет (ревʼю с42, раунд 2)
    logError({ event: "gcal.vault", errorCode: "delete_failed",
               message: e instanceof Error ? e.message : String(e) });
  }
}

/* ── OAuth state ── */

export async function createOauthState(
  admin: Admin,
  stateHash: string,
  userId: string,
  clinicId: string,
  pkceVerifier: string,
  ttlMinutes: number
): Promise<void> {
  // чистка протухлих — тут, при видачі нового (окремий cron таблиці на
  // одиниці рядків не вартий; година запасу — щоб не зачепити чужий живий)
  await admin.from("google_oauth_states").delete()
    .lt("expires_at", new Date(Date.now() - 3600_000).toISOString());
  const { error } = await admin.from("google_oauth_states").insert({
    state_hash: stateHash,
    user_id: userId,
    clinic_id: clinicId,
    pkce_verifier: pkceVerifier,
    expires_at: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
  });
  if (error) throw new Error(`gcal: збереження state: ${error.message}`);
}

export type OauthStateRow = Database["public"]["Tables"]["google_oauth_states"]["Row"];

/**
 * АТОМАРНЕ споживання state: single-use гарантує сам UPDATE (used_at is null)
 * — два конкурентні callback-и з одним state отримають рівно одне true.
 * null = невідомий / протухлий / уже використаний (не розрізняємо назовні:
 * перебирачу нема чого знати, який саме крок відмовив).
 */
export async function consumeOauthState(
  admin: Admin,
  stateHash: string
): Promise<OauthStateRow | null> {
  const { data, error } = await admin
    .from("google_oauth_states")
    .update({ used_at: new Date().toISOString() })
    .eq("state_hash", stateHash)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("*")
    .maybeSingle();
  if (error) {
    logError({ event: "gcal.oauth", errorCode: "state_consume_failed", message: error.message });
    return null;
  }
  return data;
}
