/* ===== RadFlow — контракт контуру платформи (0206, с84) =====
   Чисті типи й константи, спільні для серверних роутів `/api/platform/**`,
   консолі оператора (`components/PlatformConsole.tsx`) і тестів. Без імпортів
   next/supabase — щоб файл читався і в браузері, і під vitest. */

/** Статус центру як клієнта платформи. Без рядка в `platform_accounts` = trial.
    Дзеркало CHECK `platform_accounts_status_chk` (0206) — тест
    `tests/platformOperators0206.test.ts` зводить обидва списки. */
export const CLINIC_STATUSES = ["trial", "active", "suspended", "archived"] as const;
export type ClinicStatus = (typeof CLINIC_STATUSES)[number];
export const DEFAULT_CLINIC_STATUS: ClinicStatus = "trial";

export const CLINIC_STATUS_LABEL: Record<ClinicStatus, string> = {
  trial: "Пробний",
  active: "Активний",
  suspended: "Призупинено",
  archived: "Архів",
};

/** Статуси, з якими персонал центру НЕ входить (єдине застосування статусу в
    коді 0206 — `/api/auth/login`; живі сесії і глобальні акаунти не чіпаються). */
export const LOGIN_BLOCKED_STATUSES: readonly ClinicStatus[] = ["suspended", "archived"];

export function isClinicStatus(v: unknown): v is ClinicStatus {
  return typeof v === "string" && (CLINIC_STATUSES as readonly string[]).includes(v);
}

/** Причина обовʼязкова там, де центр ВТРАЧАЄ доступ або йде в архів. */
export function statusNeedsReason(s: ClinicStatus): boolean {
  return s === "suspended" || s === "archived";
}

/** Дії журналу оператора (`platform_log.action`, форма `a.b` — CHECK у БД). */
export const PLATFORM_ACTIONS = [
  "operator.bootstrapped",
  "operator.created",
  "operator.enabled",
  "operator.disabled",
  "operator.password_reset",
  "operator.password_changed",
  "clinic.status_changed",
  "clinic.account_updated",
] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

export const PLATFORM_ACTION_LABEL: Record<PlatformAction, string> = {
  "operator.bootstrapped": "створено першого оператора (bootstrap)",
  "operator.created": "створив оператора",
  "operator.enabled": "увімкнув оператора",
  "operator.disabled": "вимкнув оператора",
  "operator.password_reset": "скинув пароль оператора",
  "operator.password_changed": "змінив свій пароль",
  "clinic.status_changed": "змінив статус центру",
  "clinic.account_updated": "оновив облік центру",
};

/** Межі полів обліку — дзеркало CHECK-ів 0206. */
export const PLAN_MAX = 80;
export const STATUS_REASON_MAX = 500;
export const ACCOUNT_NOTES_MAX = 4000;
export const OPERATOR_NAME_MAX = 200;

/** Ключі `details`, яких у журналі платформи бути не може (CHECK `platform_log_no_pii_chk`). */
export const PLATFORM_LOG_FORBIDDEN_KEYS = [
  "patient_name", "patient_phone", "patient_email", "patient_dob", "name", "phone", "email", "dob",
  "contraindications", "note", "notes", "studies", "weight",
  "refresh_token", "access_token", "id_token", "token", "code", "client_secret", "calendar_id", "google_email", "account_email",
  "password", "temp_password", "tmp_password", "pass", "secret",
] as const;

/** Ключі `details`, які журнал платформи ЗНАЄ. Той самий перелік — allowlist при
    записі (`platformLog`) і біла проекція при читанні (`projectLogDetails` у
    роутах): ключ поза ним не потрапляє в БД і не покидає сервер — як чотири
    лінії PII у `important_events` (`DETAIL_KEYS` у /api/journal). Новий ключ =
    сюди + підпис у `platformLogText` + тест. Перетин із FORBIDDEN — порожній
    (пін у tests/platformOperators0206.test.ts). */
export const PLATFORM_LOG_DETAIL_KEYS = ["from", "to", "reason", "fields", "plan", "paid_until", "bootstrap"] as const;
export type PlatformLogDetailKey = (typeof PLATFORM_LOG_DETAIL_KEYS)[number];

export function projectLogDetails(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const d = raw as Record<string, unknown>;
  for (const k of PLATFORM_LOG_DETAIL_KEYS) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

/* ── Форми відповідей роутів (те, що читає консоль) ───────────────────────── */

export type PlatformOperatorRow = {
  id: string;
  email: string;
  full_name: string;
  active: boolean;
  created_at: string;
  disabled_at: string | null;
  note: string | null;
};

export type PlatformAccountRow = {
  clinic_id: string;
  status: ClinicStatus;
  status_reason: string | null;
  status_changed_at: string | null;
  status_changed_by: string | null;
  plan: string | null;
  paid_until: string | null;
  notes: string | null;
  updated_at: string | null;
};

export type ClinicStats = {
  staff_n: number;
  admins_n: number;
  referrers_n: number;
  ceos_n: number;
  rooms_n: number;
  rooms_active_n: number;
  services_n: number;
  entries_total: number;
  entries_30d: number;
  last_activity_at: string | null;
  integration_keys_n: number;
  webhooks_n: number;
  gcal_status: string | null;
};

export type ClinicListItem = {
  id: string;
  name: string;
  city: string | null;
  timezone: string;
  created_at: string;
  configured_at: string | null;
  status: ClinicStatus;
  status_changed_at: string | null;
  plan: string | null;
  paid_until: string | null;
  stats: ClinicStats | null;
};

export type PlatformLogItem = {
  id: string;
  occurred_at: string;
  operator_id: string | null;
  operator_name: string | null;
  action: string;
  clinic_id: string | null;
  clinic_name: string | null;
  target_operator_id: string | null;
  target_operator_name: string | null;
  details: Record<string, unknown>;
};

/** Статус без рядка обліку — trial; невідоме значення з БД — теж trial (fail-closed до найменших прав? ні: trial — найчесніше «ще не вирішено»). */
export function effectiveStatus(row: { status?: unknown } | null | undefined): ClinicStatus {
  const s = row?.status;
  return isClinicStatus(s) ? s : DEFAULT_CLINIC_STATUS;
}

/** Людський підпис журналу: «<оператор>: <дія>[ — <центр>][ (деталі)]». */
export function platformLogText(item: PlatformLogItem): string {
  const who = item.operator_name ?? (item.action === "operator.bootstrapped" ? "Bootstrap" : "Оператор (видалений)");
  const label = (PLATFORM_ACTION_LABEL as Record<string, string>)[item.action] ?? item.action;
  const parts: string[] = [`${who}: ${label}`];
  if (item.clinic_name) parts.push(`— ${item.clinic_name}`);
  else if (item.target_operator_name) parts.push(`— ${item.target_operator_name}`);
  const d = item.details ?? {};
  const bits: string[] = [];
  if (typeof d.from === "string" && typeof d.to === "string") {
    const f = (CLINIC_STATUS_LABEL as Record<string, string>)[d.from] ?? d.from;
    const t = (CLINIC_STATUS_LABEL as Record<string, string>)[d.to] ?? d.to;
    bits.push(`${f} → ${t}`);
  }
  if (typeof d.reason === "string" && d.reason) bits.push(`причина: ${d.reason}`);
  if (Array.isArray(d.fields) && d.fields.length) bits.push(`поля: ${d.fields.join(", ")}`);
  if (bits.length) parts.push(`(${bits.join("; ")})`);
  return parts.join(" ");
}
