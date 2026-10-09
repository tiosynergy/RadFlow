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
   маршрутизація в middleware; авторизація — тільки рядок.

   ТРИ СТАНИ ЧИТАННЯ РЯДКА (ревʼю с84, лінза B). «Рядка немає» і «не вдалося
   прочитати» — різні речі: перше — не оператор (403 / геть із контуру), друге —
   тимчасова відмова (503 / «спробуйте за хвилину»). Поки обидва були одним
   `null`, збій БД виглядав як втрата прав, а сторінка /platform зі збою
   редіректила в /queue, звідки middleware за прапорцем вів назад — петля. */

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/supabase/types";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { rateLimitOk } from "@/lib/rateLimit";
import { logError } from "@/lib/serverLog";
import { isOperatorByClaim } from "@/lib/platformClaim";
import {
  LOGIN_BLOCKED_STATUSES,
  PLATFORM_LOG_DETAIL_KEYS,
  isClinicStatus,
  projectLogDetails,
  type ClinicStatus,
  type PlatformAction,
  type PlatformLogItem,
  type PlatformOperatorRow,
} from "@/lib/platformContract";

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

/** Результат читання рядка оператора: прочитано (рядок або його немає) чи збій. */
export type OperatorRead = { ok: true; operator: PlatformOperator | null } | { ok: false };

/** Рядок оператора за id ПЕРЕВІРЕНОЇ сесії. `{ ok: false }` — читання впало
    (слід у лозі; хто викликав, вирішує сам: гейт — 503, сторінка — екран без
    редіректу). Рядка немає — `{ ok: true, operator: null }`. */
export async function platformOperatorOf(admin: Admin, userId: string): Promise<OperatorRead> {
  const { data, error } = await admin
    .from("platform_operators")
    .select("id, email, full_name, active")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    logError({ event: "platform.operator_read_failed", actorId: userId, errorCode: error.code ?? null, message: error.message });
    return { ok: false };
  }
  return { ok: true, operator: data ? (data as PlatformOperator) : null };
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
  const read = await platformOperatorOf(admin, user.id);
  if (!read.ok) {
    /* Збій читання — не «немає прав», а «не знаємо» (fail-closed, але чесно:
       503, щоб консоль не писала людині «недостатньо прав» через хвилинний збій). */
    return err("Тимчасова помилка перевірки прав. Спробуйте за хвилину.", 503);
  }
  const operator = read.operator;
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

/** Стан сесії для сторінки `/platform` (Server Component) — без імпорту
    service-role у сторінку. Кожен стан має РІВНО один наслідок на сторінці
    (tests/authSurface.test.ts, HEAD_PLATFORM):
      unconfigured — немає service-ключа: екран, не редірект (залогіненого
                     middleware з /login вів би назад сюди — петля);
      anonymous    — сесії немає → /login з поверненням;
      read_failed  — сесія є, рядок не прочитався → екран «спробуйте за хвилину»;
      stranger     — сесія є, рядка немає: з прапорцем оператора → /api/auth/reset
                     (вихід; інакше middleware вів би з /queue назад — петля),
                     без прапорця → /queue (клінічний контур);
      operator     — рядок є; `active` вирішує консоль чи відмова. */
export type PlatformSession =
  | { state: "unconfigured" }
  | { state: "anonymous" }
  | { state: "read_failed"; user: { id: string } }
  | { state: "stranger"; user: { id: string }; claim: boolean }
  | { state: "operator"; user: { id: string }; operator: PlatformOperator };

export async function platformSession(): Promise<PlatformSession> {
  if (!isAdminConfigured()) return { state: "unconfigured" };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { state: "anonymous" };
  const read = await platformOperatorOf(createAdminClient(), user.id);
  if (!read.ok) return { state: "read_failed", user: { id: user.id } };
  if (!read.operator) return { state: "stranger", user: { id: user.id }, claim: isOperatorByClaim(user) };
  return { state: "operator", user: { id: user.id }, operator: read.operator };
}

/* ── Вердикт входу (хто увійшов і чи можна віддати сесію) ──────────────────
   Спільний для ДВОХ місць, де сесію відкриває НАШ сервер за паролем: `/api/auth/login` і
   автовхід після `/api/account/set-password` (с82). Статус центру застосовується
   рівно тут — при відкритті сесії; живі сесії, server actions і глобальні
   акаунти (clinic_id NULL) не чіпаються (Н-25, рішення власника).
   ⚠️ ЦЕ М'ЯКИЙ ГЕЙТ (ревʼю с84, лінза C M-1; р2 L-9): сесію відкриває GoTrue, а не
   ми. Anon-ключ публічний, тож вхід напряму в GoTrue (`/auth/v1/token`) і обмін
   коду в `/auth/callback` (OAuth / magic link) цей вердикт оминають — RLS статусу
   центру не знає. Справжнє застосування статусу — у БД (Н-25, рішення власника).
   Помилка читання НЕ блокує вхід (доступність входу важливіша — той самий вибір,
   що в лімітера), але ніколи не мовчить (`logError`). */
export type LoginVerdict =
  | { kind: "platform"; active: boolean }
  /** `operatorKnown: false` — рядок оператора НЕ прочитався: людина може бути
      оператором, тож прапорець маршрутизації за цим вердиктом не чіпають (ревʼю
      с84, лінза C, L-1: інакше хвилинний збій знімав би прапорець операторові). */
  | { kind: "clinic"; clinicId: string | null; blocked: ClinicStatus | null; operatorKnown: boolean };

export async function loginVerdict(admin: Admin, uid: string): Promise<LoginVerdict> {
  const { data: op, error: opErr } = await admin
    .from("platform_operators").select("id, active").eq("id", uid).maybeSingle();
  if (opErr) logError({ event: "login.kind_read_failed", actorId: uid, errorCode: opErr.code ?? null, message: opErr.message });
  if (op) return { kind: "platform", active: !!op.active };
  const operatorKnown = !opErr;

  const { data: prof, error: pErr } = await admin
    .from("profiles").select("clinic_id").eq("id", uid).maybeSingle();
  if (pErr) logError({ event: "login.kind_read_failed", actorId: uid, errorCode: pErr.code ?? null, message: pErr.message });
  const clinicId = prof?.clinic_id ?? null;
  if (!clinicId) return { kind: "clinic", clinicId: null, blocked: null, operatorKnown };

  const { data: acc, error: aErr } = await admin
    .from("platform_accounts").select("status").eq("clinic_id", clinicId).maybeSingle();
  if (aErr) logError({ event: "login.status_read_failed", actorId: uid, clinicId, errorCode: aErr.code ?? null, message: aErr.message });
  const blocked = acc && isClinicStatus(acc.status) && LOGIN_BLOCKED_STATUSES.includes(acc.status) ? acc.status : null;
  return { kind: "clinic", clinicId, blocked, operatorKnown };
}

/* ── Журнал дій оператора ──────────────────────────────────────────────────
   fail-OPEN, як важливі події центру (рішення власника для 0128): помилка
   журналу НЕ відкочує дію, але ніколи не мовчить — `logError`. ПДн сюди не
   кладуть: `details` проходить CHECK `platform_log_no_pii_chk` у БД, а тут —
   allowlist ключів `PLATFORM_LOG_DETAIL_KEYS` (той самий перелік — біла
   проекція на виході, `hydrateLogRows`). */
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
  const d = (entry.details ?? {}) as Record<string, unknown>;
  for (const k of PLATFORM_LOG_DETAIL_KEYS) {
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

/** Рядки журналу як їх читають роути (імена операторів журнал не зберігає). */
export type PlatformLogRaw = Omit<PlatformLogItem, "operator_name" | "target_operator_name" | "details"> & { details: unknown };
export const PLATFORM_LOG_COLUMNS = "id, occurred_at, operator_id, action, clinic_id, clinic_name, target_operator_id, details";

/** Імена операторів — окремим читанням за id; `details` — лише відомі ключі
    (біла проекція). Помилка читання імен — `{ ok: false }`, роут віддає 500. */
export async function hydrateLogRows(
  admin: Admin,
  rows: PlatformLogRaw[]
): Promise<{ ok: true; items: PlatformLogItem[] } | { ok: false; error: { message: string; code?: string } }> {
  const opIds = [...new Set(rows.flatMap((r) => [r.operator_id, r.target_operator_id]).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (opIds.length) {
    const { data: ops, error } = await admin.from("platform_operators").select("id, full_name, email").in("id", opIds);
    if (error) return { ok: false, error };
    for (const o of ops ?? []) names.set(String(o.id).toLowerCase(), o.full_name || o.email);
  }
  const nameOf = (id: string | null) => (id ? names.get(String(id).toLowerCase()) ?? null : null);
  const items: PlatformLogItem[] = rows.map((r) => ({
    id: r.id,
    occurred_at: r.occurred_at,
    operator_id: r.operator_id,
    operator_name: nameOf(r.operator_id),
    action: r.action,
    clinic_id: r.clinic_id,
    clinic_name: r.clinic_name,
    target_operator_id: r.target_operator_id,
    target_operator_name: nameOf(r.target_operator_id),
    details: projectLogDetails(r.details),
  }));
  return { ok: true, items };
}

/** Тимчасовий пароль оператора — показується РІВНО один раз тому, хто створив
    або скинув (той самий клас довіри, що й посилання /set-password?token=…). */
export function tempOperatorPassword(): string {
  return "Rf-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}
