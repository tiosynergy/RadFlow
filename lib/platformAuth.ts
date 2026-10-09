/* ===== RadFlow — гейт і сервісний шар контуру платформи (0206, с84) =====

   Оператор платформи — людина RadFlow, яка керує ЦЕНТРАМИ як клієнтами, а не
   пацієнтами як записами. Це акаунт `auth.users` БЕЗ рядка `profiles`: він не
   входить у `user_role` (admin / registrar / radiologist / referrer / ceo),
   центру не має, і для RLS він — ніхто (`auth_role()` / `auth_clinic_id()`
   NULL, політики віддають нуль рядків, definer-функції для `authenticated`
   відмовляють). Усе, що оператор читає й пише, іде ЧЕРЕЗ СЕРВЕР під
   service_role ПІСЛЯ цього гейта; у браузер service-role не потрапляє.

   ЧОМУ ОКРЕМИЙ ГЕЙТ, а не `requireRole`. `requireRole` читає `profiles` під
   сесією користувача і міркує ролями центру; у оператора профілю немає за
   задумом, а право дає РЯДОК `platform_operators` (deny-all RLS — читається
   лише service_role). Тому порядок тут: сесія → рядок оператора за `user.id`
   із ПЕРЕВІРЕНОЇ сесії (ніколи з тіла запиту) → `active`. Єдиний вихід «ok»
   — у кінці (та сама властивість, що стереже `tests/serverAuthSurface.test.ts`
   для `requireRole`).

   `app_metadata.platform = 'operator'` (lib/platformClaim.ts) — лише
   маршрутизація в middleware; авторизація — тільки рядок. */

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/supabase/types";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { rateLimitOk } from "@/lib/rateLimit";
import { logError } from "@/lib/serverLog";
import type { PlatformAction, PlatformOperatorRow } from "@/lib/platformContract";

export type PlatformOperator = Pick<PlatformOperatorRow, "id" | "email" | "full_name" | "active">;

type Admin = SupabaseClient<Database>;
type Gate =
  | { ok: true; admin: Admin; user: { id: string }; operator: PlatformOperator }
  | { ok: false; res: NextResponse };

const err = (message: string, status: number): { ok: false; res: NextResponse } => ({
  ok: false,
  res: NextResponse.json({ error: message }, { status }),
});

type RateLimitOpt = { key: string; max: number; windowSeconds: number };

/** Рядок оператора за id ПЕРЕВІРЕНОЇ сесії. null — рядка немає або читання впало
    (fail-closed: помилка читання = «не оператор», слід у лозі). */
export async function platformOperatorOf(admin: Admin, userId: string): Promise<PlatformOperator | null> {
  const { data, error } = await admin
    .from("platform_operators")
    .select("id, email, full_name, active")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    logError({ event: "platform.operator_read_failed", actorId: userId, errorCode: error.code ?? null, message: error.message });
    return null;
  }
  return data ? (data as PlatformOperator) : null;
}

/**
 * Гейт роутів `/api/platform/**`: сесія → рядок оператора → active → (ліміт).
 * @param opts.path      pathname роута — для structured log відмов (без ПДн).
 * @param opts.rateLimit ліміт per-operator для роутів, що створюють акаунти.
 */
export async function requirePlatformOperator(
  opts?: { path?: string; rateLimit?: RateLimitOpt }
): Promise<Gate> {
  if (!isAdminConfigured()) {
    return err("SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері (.env.local)", 500);
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    logError({ event: "platform.access_denied", errorCode: "unauthenticated", message: opts?.path ? `path=${opts.path}` : null });
    return err("Не авторизовано", 401);
  }

  const admin = createAdminClient();
  const operator = await platformOperatorOf(admin, user.id);
  if (!operator) {
    /* Сесія є, рядка оператора немає — персонал центру або чужий акаунт на
       платформному роуті. Текст 403 загальний: не каже, що такий контур існує
       для когось іншого. */
    logError({ event: "platform.access_denied", actorId: user.id, errorCode: "not_operator", message: opts?.path ? `path=${opts.path}` : null });
    return err("Недостатньо прав", 403);
  }
  if (!operator.active) {
    logError({ event: "platform.access_denied", actorId: user.id, errorCode: "operator_disabled", message: opts?.path ? `path=${opts.path}` : null });
    return err("Доступ оператора вимкнено", 403);
  }

  if (opts?.rateLimit) {
    const { key, max, windowSeconds } = opts.rateLimit;
    const ok = await rateLimitOk(`${key}:${user.id}`, max, windowSeconds);
    if (!ok) return err("Забагато запитів. Спробуйте за кілька хвилин.", 429);
  }

  return { ok: true, admin, user: { id: user.id }, operator };
}

/** Для сторінки `/platform` (Server Component): сесія + рядок оператора без
    імпорту service-role у сторінку. `user` null — сесії немає; `operator` null —
    сесія є, але це не оператор (персонал центру або чужий акаунт). */
export async function platformSession(): Promise<{ user: { id: string } | null; operator: PlatformOperator | null }> {
  if (!isAdminConfigured()) return { user: null, operator: null };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, operator: null };
  const operator = await platformOperatorOf(createAdminClient(), user.id);
  return { user: { id: user.id }, operator };
}

/* ── Журнал дій оператора ──────────────────────────────────────────────────
   fail-OPEN, як важливі події центру (рішення власника для 0128): помилка
   журналу НЕ відкочує дію, але ніколи не мовчить — `logError`. ПДн сюди не
   кладуть: `details` проходить CHECK `platform_log_no_pii_chk` у БД, а тут —
   allowlist ключів на рівні типу (лише те, що перелічено нижче). */
export type PlatformLogDetails = {
  from?: string;
  to?: string;
  reason?: string | null;
  fields?: string[];
  plan?: string | null;
  paid_until?: string | null;
  bootstrap?: boolean;
};

export async function platformLog(
  admin: Admin,
  entry: {
    operatorId: string | null;
    action: PlatformAction;
    clinicId?: string | null;
    clinicName?: string | null;
    targetOperatorId?: string | null;
    details?: PlatformLogDetails;
  }
): Promise<void> {
  const details: { [key: string]: Json | undefined } = {};
  const d = entry.details ?? {};
  for (const k of ["from", "to", "reason", "fields", "plan", "paid_until", "bootstrap"] as const) {
    if (d[k] !== undefined) details[k] = d[k] as Json;
  }
  const { error } = await admin.from("platform_log").insert({
    operator_id: entry.operatorId,
    action: entry.action,
    clinic_id: entry.clinicId ?? null,
    clinic_name: entry.clinicName ? String(entry.clinicName).slice(0, 200) : null,
    target_operator_id: entry.targetOperatorId ?? null,
    details,
  });
  if (error) {
    logError({
      event: "platform.log_write_failed",
      actorId: entry.operatorId,
      clinicId: entry.clinicId ?? null,
      errorCode: error.code ?? null,
      message: `${entry.action}: ${error.message}`,
    });
  }
}

/** Тимчасовий пароль оператора — показується РІВНО один раз тому, хто створив
    або скинув (той самий клас довіри, що й посилання /set-password?token=…). */
export function tempOperatorPassword(): string {
  return "Rf-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}
