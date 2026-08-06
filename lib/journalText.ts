/* ===== RadFlow — «Журнал дій»: людські формулювання подій (с25, ТЗ §11) =====

   Чиста логіка (без React і без БД) → тестується vitest.

   ПРИНЦИП БЕЗПЕКИ. Екран рендерить НЕ довільний вміст `details`, а лише
   ЯВНО дозволені ключі через відомі шаблони. Навіть якщо колись емітер
   покладе в payload щось несподіване, у журнал на екрані воно не потрапить.
   Це третя лінія захисту після allowlist у TS і CHECK у БД. */

import type {
  ImportantEventType,
  ImportantEventActorRole,
  ImportantEventEntityType,
} from "@/lib/importantEvents";

/* ---------------------------------------------------------------- ролі */

const ROLE_LABEL: Record<ImportantEventActorRole, string> = {
  admin: "Адміністратор",
  radiologist: "Радіолог",
  registrar: "Реєстратор",
  referrer: "Направник",
  ceo: "Керівник",
  system: "Система",
};

export function actorRoleLabel(role: ImportantEventActorRole): string {
  return ROLE_LABEL[role] ?? "Користувач";
}

/* ------------------------------------------------------------- статуси */

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Заплановано",
  waiting: "Очікує",
  in_progress: "Триває",
  done: "Виконано",
  no_show: "Неявка",
  cancelled: "Скасовано",
  not_held: "Не відбулося",
  needs_reschedule: "Потребує переносу",
  expired: "Протерміновано",
};

export function statusLabel(s: unknown): string {
  return typeof s === "string" ? (STATUS_LABEL[s] ?? s) : "—";
}

/* --------------------------------------------------- назви полів (§4.4) */

const FIELD_LABEL: Record<string, string> = {
  patient_name: "ПІБ",
  patient_phone: "телефон",
  patient_email: "email",
  patient_dob: "дата народження",
  patient_sex: "стать",
  patient_age: "вік",
  patient_weight: "вага",
  contraindications: "протипоказання",
  note: "нотатка",
  doctor: "лікар",
  referrer_id: "направник",
  scheduled_date: "дата",
  scheduled_time: "час",
  room_id: "кабінет",
  studies: "склад досліджень",
  duration_min: "тривалість",
  has_contrast: "контраст",
  buffer_time_min: "буфер",
  off_schedule: "поза графіком",
  priority_level: "пріоритет",
  status: "статус",
};

/** Назви змінених полів людською мовою. ЗНАЧЕНЬ немає — лише назви. */
export function changedFieldsLabel(fields: string[] | null | undefined): string {
  if (!fields || fields.length === 0) return "";
  return fields.map((f) => FIELD_LABEL[f] ?? f).join(", ");
}

/* ------------------------------------------------------- сім'я → колір */

/** Клас крапки таймлайну (.tl-dot) за сім'єю події. */
export function eventDotClass(type: ImportantEventType): string {
  if (type.startsWith("incident.")) return "red";
  if (type === "access.denied") return "orange";
  if (type.startsWith("referral.") || type.startsWith("staff.")) return "blue";
  if (type.startsWith("case.")) return "yellow";
  return "green";
}

/* ---------------------------------------------------- заголовок події */

type Details = Record<string, unknown> | null | undefined;

const str = (d: Details, k: string): string | null => {
  const v = d?.[k];
  return typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null;
};
const num = (d: Details, k: string): number | null => {
  const v = d?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const obj = (d: Details, k: string): Record<string, unknown> | null => {
  const v = d?.[k];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};

/** '2026-08-05' → '05.08.2026'. Різання рядка, не `new Date()` (інваріант проєкту). */
export function fmtDayKey(key: unknown): string {
  if (typeof key !== "string") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : key;
}

/** 'HH:MM[:SS]' → 'HH:MM'. */
export function fmtTime(t: unknown): string {
  return typeof t === "string" ? t.slice(0, 5) : "";
}

/** Слот «05.08.2026 10:30» із частин переносу. */
function slotOf(part: Record<string, unknown> | null): string {
  if (!part) return "";
  const d = fmtDayKey(part.date);
  const t = fmtTime(part.time);
  return [d, t].filter(Boolean).join(" ");
}

/**
 * Головний рядок події (те, що бачить адмін). Формат ТЗ §11:
 * «Направник переніс запис: 10:00 -> 11:20».
 *
 * РІД ДІЄСЛОВА. Для людини — чоловічий рід («створив»), бо підмет — назва ролі
 * («Адміністратор», «Направник»). Для системних подій підмет жіночого роду
 * («Система»), тому там БЕЗОСОБОВА форма: «Система: зупинено кабінет».
 * Спіймано живою перевіркою екрана — «Система зупинив» різало око.
 */
export function eventTitle(item: {
  eventType: ImportantEventType;
  actorRole: ImportantEventActorRole;
  changedFields?: string[] | null;
  details?: Details;
}): string {
  const who = actorRoleLabel(item.actorRole);
  const isSys = item.actorRole === "system";
  const d = item.details;
  /** m — чоловічий рід (людина), i — безособова форма (система). */
  const say = (m: string, i: string, tail = ""): string =>
    isSys ? `${who}: ${i}${tail}` : `${who} ${m}${tail}`;

  switch (item.eventType) {
    /* ---- направник ---- */
    case "referral.created":
      return say("створив направлення", "створено направлення");
    case "referral.rescheduled":
    case "queue.rescheduled": {
      const from = slotOf(obj(d, "from"));
      const to = slotOf(obj(d, "to"));
      const tail = from && to ? `: ${from} → ${to}` : "";
      return say("переніс запис", "перенесено запис", tail);
    }
    case "referral.cancelled":
      return say("скасував направлення", "скасовано направлення");
    case "referral.patient_data_changed": {
      const f = changedFieldsLabel(item.changedFields);
      return say("змінив дані пацієнта у направленні", "змінено дані пацієнта у направленні", f ? ` (${f})` : "");
    }
    case "referral.studies_changed": {
      const a = num(d, "previousCount");
      const b = num(d, "newCount");
      const tail = a != null && b != null ? `: ${a} → ${b}` : "";
      return say("змінив дослідження у направленні", "змінено дослідження у направленні", tail);
    }
    case "referral.waitlist_added":
      return say("додав направлення в лист очікування", "додано направлення в лист очікування");
    case "referral.waitlist_removed":
      return say("зняв направлення з листа очікування", "знято направлення з листа очікування");
    case "referral.case_created":
      return say("створив кейс направника", "створено кейс направника");
    case "referral.case_step_added":
      return say("додав етап у кейс направника", "додано етап у кейс направника");
    case "referral.case_cancelled":
      return say("скасував кейс направника", "скасовано кейс направника");
    case "referral.access_granted":
      return say("надав направнику доступ до центру", "надано направнику доступ до центру");
    case "referral.access_revoked":
      return say("відкликав доступ направника до центру", "відкликано доступ направника до центру");

    /* ---- черга ---- */
    case "queue.created":
      return say("створив запис", "створено запис");
    case "queue.cancelled":
      return say("скасував запис", "скасовано запис");
    case "queue.status_changed": {
      const a = str(d, "previousStatus");
      const b = str(d, "newStatus");
      const tail = a && b ? `: ${statusLabel(a)} → ${statusLabel(b)}` : "";
      return say("змінив статус запису", "змінено статус запису", tail);
    }
    case "queue.patient_data_changed": {
      const f = changedFieldsLabel(item.changedFields);
      return say("змінив дані пацієнта", "змінено дані пацієнта", f ? ` (${f})` : "");
    }
    case "queue.studies_changed": {
      const a = num(d, "previousCount");
      const b = num(d, "newCount");
      const tail = a != null && b != null ? `: ${a} → ${b}` : "";
      return say("змінив склад досліджень", "змінено склад досліджень", tail);
    }
    case "queue.delay_plan_applied": {
      const moved = num(d, "shifted");
      const conf = num(d, "conflicts");
      const parts: string[] = [];
      if (moved != null) parts.push(`зсунуто ${moved}`);
      if (conf != null && conf > 0) parts.push(`потребують переносу ${conf}`);
      return say("застосував план затримки", "застосовано план затримки", parts.length ? `: ${parts.join(", ")}` : "");
    }

    /* ---- лист очікування ---- */
    case "waitlist.scheduled":
      return say("записав кандидата з листа очікування", "записано кандидата з листа очікування");
    case "waitlist.removed":
      return say("зняв запис із листа очікування", "знято запис із листа очікування");

    /* ---- кейси ---- */
    case "case.created": {
      const n = num(d, "stepsCount");
      return say("створив кейс", "створено кейс", n != null ? ` (етапів: ${n})` : "");
    }
    case "case.step_added":
      return say("додав етап у кейс", "додано етап у кейс");
    case "case.cancelled": {
      const n = num(d, "affectedSteps");
      return say("скасував кейс", "скасовано кейс", n != null ? ` (етапів: ${n})` : "");
    }

    /* ---- інциденти ---- */
    case "incident.started":
      return say("зафіксував простій кабінету", "зафіксовано простій кабінету");
    case "incident.resolved":
      return str(d, "kind") === "emergency"
        ? say("відновив роботу кабінету", "відновлено роботу кабінету")
        : say("закрив простій кабінету", "закрито простій кабінету");
    case "incident.emergency_stop":
      return say("зупинив кабінет (аварія)", "зупинено кабінет (аварія)");

    /* ---- графік і доступи ---- */
    case "schedule.exception_confirmed":
      return say("підтвердив роботу поза графіком", "підтверджено роботу поза графіком");
    case "access.denied": {
      const path = str(d, "path");
      // Форма вже безособова — рід підмета не заважає.
      return `${who}: відмовлено в доступі${path ? ` (${path})` : ""}`;
    }
    case "patient_data.exported":
      return say("вивантажив дані пацієнтів", "вивантажено дані пацієнтів");
    case "staff.role_changed":
      return say("змінив роль співробітника", "змінено роль співробітника");
    case "staff.access_changed": {
      const action = str(d, "action");
      if (action === "ceo_granted") return say("надав доступ керівника", "надано доступ керівника");
      if (action === "ceo_revoked") return say("відкликав доступ керівника", "відкликано доступ керівника");
      const role = str(d, "role");
      if (role) return say("створив акаунт співробітника", "створено акаунт співробітника", ` (${role})`);
      const rooms = num(d, "roomsCount");
      return say("змінив доступ співробітника", "змінено доступ співробітника", rooms != null ? ` (кабінетів: ${rooms})` : "");
    }
  }
  // Невідомий тип (журнал старший за код) — показуємо сирий тип, не падаємо.
  return `${who}: ${item.eventType}`;
}

/* ------------------------------------------------------- підзаголовок */

const ENTITY_LABEL: Record<ImportantEventEntityType, string> = {
  queue_entry: "запис",
  waitlist_entry: "лист очікування",
  patient_case: "кейс",
  incident: "інцидент",
  referral_access: "доступ",
  staff: "співробітник",
  delay_plan: "план затримки",
};

export function entityLabel(t: ImportantEventEntityType): string {
  return ENTITY_LABEL[t] ?? String(t);
}

/** Короткий ID для ока: перші 8 символів uuid. Повний — у тултипі/фільтрі. */
export function shortId(id: string): string {
  return typeof id === "string" && id.length >= 8 ? id.slice(0, 8) : String(id ?? "");
}

/* --------------------------------------------------- інстант у зоні центру */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/**
 * ISO-інстант → «05.08.2026 14:32» У ЗОНІ ЦЕНТРУ.
 *
 * ⚠️ Не `new Date(iso).toLocaleString()` без timeZone: у журналі
 * occurred_at — timestamptz, і без явної зони екран показував би час
 * браузера адміна, а не час центру (інваріант проєкту про добу).
 */
export function fmtInstant(iso: string, tz?: string): string {
  if (!iso) return "";
  const key = tz || "local";
  try {
    let f = fmtCache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat("uk-UA", {
        ...(tz ? { timeZone: tz } : {}),
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      fmtCache.set(key, f);
    }
    return f.format(new Date(iso)).replace(",", "");
  } catch {
    // Невалідна IANA-зона — краще показати без зони, ніж зламати екран.
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  }
}

/* ------------------------------------------------- групи фільтра «тип» */

/** Групи типів для випадайки фільтра (щоб 32 пункти не були простирадлом). */
export const EVENT_TYPE_GROUPS: { label: string; match: (t: ImportantEventType) => boolean }[] = [
  { label: "Направники", match: (t) => t.startsWith("referral.") },
  { label: "Черга", match: (t) => t.startsWith("queue.") },
  { label: "Лист очікування", match: (t) => t.startsWith("waitlist.") },
  { label: "Кейси", match: (t) => t.startsWith("case.") },
  { label: "Інциденти", match: (t) => t.startsWith("incident.") },
  {
    label: "Доступи та інше",
    match: (t) => t.startsWith("staff.") || t.startsWith("access.") || t.startsWith("schedule.") || t.startsWith("patient_data."),
  },
];

/** Короткий підпис типу події для випадайки (без імені актора). */
export function eventTypeLabel(t: ImportantEventType): string {
  return eventTitle({ eventType: t, actorRole: "admin", details: null })
    .replace(/^Адміністратор:?\s*/, "")
    .replace(/^./, (c) => c.toUpperCase());
}
