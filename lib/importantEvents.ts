/**
 * Журнал важливих подій (0128) — ЧИСТА логіка без серверних залежностей.
 * ТЗ: CLAUDE_MINIMAL_IMPORTANT_EVENTS_LOGGING_SPEC.md.
 *
 * Тут живе все, що можна перевірити vitest-ом без БД:
 *  - union-типи подій (§4, §5) і сутностей (§3);
 *  - вибір сімʼї події: referral.* проти queue.* / case.* / waitlist.* (§4, §5:
 *    «одна дія — ОДНА подія», сімʼї не дублюються);
 *  - PII-сторож payload-а (§6, §12.7): рекурсивний скан заборонених ключів;
 *  - будування changed_fields: лише НАЗВИ полів, без значень (§4.4).
 *
 * Серверна емісія — lib/importantEvents.server.ts (fail-OPEN, §12.11).
 */

/** 12 подій направника (§4). */
export const REFERRAL_EVENT_TYPES = [
  "referral.created",
  "referral.rescheduled",
  "referral.cancelled",
  "referral.patient_data_changed",
  "referral.studies_changed",
  "referral.waitlist_added",
  "referral.waitlist_removed",
  "referral.case_created",
  "referral.case_step_added",
  "referral.case_cancelled",
  "referral.access_granted",
  "referral.access_revoked",
] as const;

/** Загальні події (§5). */
export const GENERAL_EVENT_TYPES = [
  "queue.created",
  "queue.rescheduled",
  "queue.status_changed",
  "queue.cancelled",
  "queue.patient_data_changed",
  "queue.studies_changed",
  "waitlist.scheduled",
  "waitlist.removed",
  "case.created",
  "case.step_added",
  "case.cancelled",
  "incident.started",
  "incident.resolved",
  "incident.emergency_stop",
  "queue.delay_plan_applied",
  "schedule.exception_confirmed",
  "access.denied",
  "patient_data.exported",
  "staff.role_changed",
  "staff.access_changed",
  /* Статус змінила ЗОВНІШНЯ система (RIS/PACS) через API інтеграцій, 0146.
     Окремий тип, а не queue.status_changed (рішення власника 2026-08-11):
     адміністратор має бачити, що запис рухав не реєстратор, а міст — інакше
     розбір «хто це зробив» упирався б у безіменну «Систему». */
  "integration.status_applied",
  /* 0160: адмін-дії над резервним дзеркалом Google Calendar (entity_id =
     clinic_id, entity_type = 'integration'). Дві останні — системні
     (actor null): sync вимкнув фічу fail-closed, адмін мусить це ПОБАЧИТИ. */
  "integration.gcal_connected",
  "integration.gcal_calendar_selected",
  "integration.gcal_enabled",
  "integration.gcal_disabled",
  "integration.gcal_disconnected",
  "integration.gcal_reauth_required",
  "integration.gcal_access_lost",
] as const;

export type ReferralEventType = (typeof REFERRAL_EVENT_TYPES)[number];
export type GeneralEventType = (typeof GENERAL_EVENT_TYPES)[number];
export type ImportantEventType = ReferralEventType | GeneralEventType;

export type ImportantEventEntityType =
  | "queue_entry"
  | "waitlist_entry"
  | "patient_case"
  | "incident"
  | "referral_access"
  | "staff"
  /** Свідоме розширення §3: queue.delay_plan_applied посилається на рядок
      queue_delay_events — серед шести канонічних сутностей його немає. */
  | "delay_plan"
  /** 0160: clinic-level інтеграція (Google Calendar Backup); entity_id =
      clinic_id — окремої таблиці-сутності в журналі їй не треба. */
  | "integration";

/** Роль актора в журналі: 5 людських (енум user_role) + 'system' (лише журнал). */
export type ImportantEventActorRole =
  | "admin"
  | "radiologist"
  | "registrar"
  | "referrer"
  | "ceo"
  | "system";

/**
 * Заборонені ключі details (§6): ПІБ/телефон/email/д.н./вага/протипоказання/
 * нотатки/повний склад досліджень. Мусить бути НАДмножиною CHECK-у БД
 * important_events_no_pii_chk (там — snake_case верхнього рівня; тут — ще й
 * camelCase і вкладені рівні). Тест sync-ує списки навмисною поломкою.
 */
export const FORBIDDEN_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "patient_name", "patientname",
  "patient_phone", "patientphone",
  "patient_email", "patientemail",
  "patient_dob", "patientdob",
  "name", "phone", "email", "dob",
  "contraindications", "note", "notes",
  "studies", "weight",
  /* 0160: OAuth приніс НОВИЙ клас витоку — секрети/ідентифікатори Google.
     Журнал читають admin/CEO з браузера: токен у details = токен у клієнта. */
  "refresh_token", "refreshtoken",
  "access_token", "accesstoken",
  "id_token", "idtoken", "token",
  "code", "client_secret", "clientsecret",
  "calendar_id", "calendarid",
  "google_email", "googleemail", "account_email", "accountemail",
]);

/** Ключі, заборонені CHECK-ом БД (верхній рівень) — дзеркало міграцій
    0128 + 0160. */
export const DB_FORBIDDEN_TOP_KEYS = [
  "patient_name", "patient_phone", "patient_email", "patient_dob",
  "name", "phone", "email", "dob",
  "contraindications", "note", "studies", "weight",
  "refresh_token", "access_token", "id_token", "token", "code",
  "client_secret", "calendar_id", "google_email", "account_email",
] as const;

/**
 * Рекурсивний скан details на заборонені ключі. Повертає шляхи порушень
 * (порожній масив = чисто). Значення не аналізуються — журнал не повинен
 * отримувати PII навіть під «безпечним» ключем, але за це відповідає
 * будування payload-а на місці виклику; сторож ловить рівно те, що можна
 * зловити механічно, — імена ключів.
 */
export function piiViolations(details: unknown, path = "details"): string[] {
  if (details === null || details === undefined) return [];
  if (Array.isArray(details)) {
    return details.flatMap((v, i) => piiViolations(v, `${path}[${i}]`));
  }
  if (typeof details !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase())) out.push(`${path}.${key}`);
    out.push(...piiViolations(value, `${path}.${key}`));
  }
  return out;
}

/**
 * Чи відноситься дія до направника (§4): referrer_id запису / created_by
 * направника / сам актор — направник. Області referral_access тут нема —
 * ті події завжди referral.* за визначенням.
 */
export function isReferralAction(opts: {
  entryReferrerId?: string | null;
  createdByIsReferrer?: boolean;
  actorRole?: ImportantEventActorRole | null;
}): boolean {
  return Boolean(
    opts.entryReferrerId ||
    opts.createdByIsReferrer ||
    opts.actorRole === "referrer"
  );
}

type QueueEventKind =
  | "created" | "rescheduled" | "cancelled"
  | "patient_data_changed" | "studies_changed" | "status_changed";

/**
 * «Одна дія — одна подія» (§2.1, §12.5): вибір типу події черги.
 * referral-сімʼя НЕ має власного status_changed — зміна статусу направлення,
 * що не є скасуванням, лишається queue.status_changed із subjectReferrerId.
 */
export function queueEventTypeFor(
  kind: QueueEventKind,
  referral: boolean
): ImportantEventType {
  if (referral) {
    switch (kind) {
      case "created": return "referral.created";
      case "rescheduled": return "referral.rescheduled";
      case "cancelled": return "referral.cancelled";
      case "patient_data_changed": return "referral.patient_data_changed";
      case "studies_changed": return "referral.studies_changed";
      case "status_changed": return "queue.status_changed";
    }
  }
  switch (kind) {
    case "created": return "queue.created";
    case "rescheduled": return "queue.rescheduled";
    case "cancelled": return "queue.cancelled";
    case "patient_data_changed": return "queue.patient_data_changed";
    case "studies_changed": return "queue.studies_changed";
    case "status_changed": return "queue.status_changed";
  }
}

/** Події листа очікування. У §5 НЕМАЄ загального «waitlist.added» —
    додавання листа журналюється лише для направника (§4.6). */
export function waitlistEventTypeFor(
  kind: "added" | "removed",
  referral: boolean
): ImportantEventType | null {
  if (kind === "added") return referral ? "referral.waitlist_added" : null;
  return referral ? "referral.waitlist_removed" : "waitlist.removed";
}

/** Події кейсів (§4.8–4.10 / §5). */
export function caseEventTypeFor(
  kind: "created" | "step_added" | "cancelled",
  referral: boolean
): ImportantEventType {
  if (referral) {
    switch (kind) {
      case "created": return "referral.case_created";
      case "step_added": return "referral.case_step_added";
      case "cancelled": return "referral.case_cancelled";
    }
  }
  switch (kind) {
    case "created": return "case.created";
    case "step_added": return "case.step_added";
    case "cancelled": return "case.cancelled";
  }
}

/**
 * changed_fields з патча: лише НАЗВИ полів (§4.4), відсортовано для
 * стабільності тестів. undefined-поля (не передані) не рахуються зміною.
 */
export function changedFieldsOf(patch: Record<string, unknown>): string[] {
  return Object.keys(patch)
    .filter((k) => patch[k] !== undefined)
    .sort();
}

/** Вхід емісії (серверний хелпер додає actor із перевіреної сесії). */
export type ImportantEventInput = {
  clinicId: string;
  /** null → системна подія (cron): роль стане 'system'. */
  actorId: string | null;
  eventType: ImportantEventType;
  entityType: ImportantEventEntityType;
  entityId: string;
  subjectReferrerId?: string | null;
  changedFields?: string[] | null;
  details?: Record<string, unknown> | null;
  requestId?: string | null;
};
