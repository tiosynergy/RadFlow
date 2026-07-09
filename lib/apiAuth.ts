import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdminConfigured } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";

// M-7: единый guard для service-role API-роутов. Раньше каждый роут повторял
// один и тот же блок (isAdminConfigured → getUser → profiles.role → clinic_id)
// вручную; риск был в РЕГРЕССЕ нового роута. Здесь — единый источник истины,
// который гарантирует правильный порядок проверок ДО любого createAdminClient()
// (service-role обходит RLS, поэтому право вызывающего проверяем сами).

type Role = Database["public"]["Enums"]["user_role"];
export type Caller = { id: string; clinic_id: string | null; role: Role };
// При needClinic:true clinic_id гарантированно непустой — отдаём сужённый тип,
// чтобы роуты (вставки/фильтры в NOT NULL clinic_id) не падали на string|null.
export type ClinicCaller = { id: string; clinic_id: string; role: Role };

type Gate<M> =
  | { ok: true; supabase: SupabaseClient<Database>; user: { id: string }; me: M }
  | { ok: false; res: NextResponse };

const err = (message: string, status: number): { ok: false; res: NextResponse } => ({
  ok: false,
  res: NextResponse.json({ error: message }, { status }),
});

/**
 * Проверяет вызывающего для service-role роута.
 * @param allowed  список разрешённых ролей, или null — «любой авторизованный
 *                 пользователь с профилем» (роль проверяется дальше в самом
 *                 роуте, напр. per-row, как в /referral/access/decide).
 * @param opts.needClinic  требовать непустой clinic_id (персонал центра).
 *                 При true возвращаемый me.clinic_id сужается до string.
 * @param opts.forbidden   сообщение при неподходящей роли (по умолчанию общее).
 */
export function requireRole(
  allowed: Role[] | null,
  opts: { needClinic: true; forbidden?: string }
): Promise<Gate<ClinicCaller>>;
export function requireRole(
  allowed: Role[] | null,
  opts?: { needClinic?: boolean; forbidden?: string }
): Promise<Gate<Caller>>;
export async function requireRole(
  allowed: Role[] | null,
  opts?: { needClinic?: boolean; forbidden?: string }
): Promise<Gate<Caller>> {
  if (!isAdminConfigured()) {
    return err("SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері (.env.local)", 500);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err("Не авторизовано", 401);

  const { data: me } = await supabase
    .from("profiles")
    .select("id, clinic_id, role")
    .eq("id", user.id)
    .single();
  if (!me) return err("Профіль не знайдено", 403);

  if (allowed && !allowed.includes(me.role)) {
    return err(opts?.forbidden ?? "Недостатньо прав", 403);
  }
  if (opts?.needClinic && !me.clinic_id) {
    return err("Адміністратор без центру", 403);
  }

  return { ok: true, supabase, user: { id: user.id }, me: me as Caller };
}
