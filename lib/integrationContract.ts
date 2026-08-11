/* ===== RadFlow — контракт інтеграційного API v1 (фаза 1, режим A) =====
   ЧИСТА логіка (під vitest): білий список полів експорту, інтервальна
   арифметика вільних вікон, розбір дат. Джерело правди контракту — план
   claude/pacs-fhir-integration-plan.md: назовні йдуть ЛИШЕ поля класу 1
   (операційні); демографія (клас 2) і клінічний контекст (клас 3) — ні.

   УВАГА: SQL-дзеркало цієї проєкції живе в migrations/0145
   (integration_project_entry) — обидва списки МУСЯТЬ збігатися; тест
   integrationContract.test.ts фіксує еталон, зміна тут = свідома зміна
   контракту (і SQL-двійника). */

/** Типи подій вебхуків (емітує тригер 0145; воркер маршрутизує за префіксом). */
export const INTEGRATION_EVENT_PREFIX = "integration.";
export const INTEGRATION_EVENT_TYPES = [
  "integration.appointment.created",
  "integration.appointment.rescheduled",
  "integration.appointment.cancelled",
  "integration.appointment.noshow",
  "integration.appointment.updated",
  "integration.appointment.deleted",
] as const;

/** Поля queue_entries, що ЕКСПОРТУЮТЬСЯ (клас 1). Порядок не значущий. */
export const APPOINTMENT_EXPORT_FIELDS = [
  "id",
  "clinic_id",
  "room_id",
  "status",
  "call_status",
  "scheduled_at",
  "scheduled_date",
  "scheduled_time",
  "duration_min",
  "buffer_time_min",
  "priority_level",
  "cito",
  "has_contrast",
  "off_schedule",
  "case_id",
  "case_step",
  "created_at",
  "updated_at",
  "studies",
] as const;

/** Поля, що НЕ СМІЮТЬ потрапити назовні (клас 2 демографія + клас 3 клінічний
    контекст + внутрішні). Тест звіряє, що проєкція їх відкидає. */
export const APPOINTMENT_FORBIDDEN_FIELDS = [
  "patient_name",
  "patient_phone",
  "patient_dob",
  "patient_sex",
  "patient_age",
  "patient_weight",
  "patient_email",
  "note",
  "indication",
  "contraindications",
  "radiologist_note",
  "call_note",
  "doctor",
  "reschedule_origin",
  "studies_original",
  "studies_changed_by",
  "clarify_at",
  "created_by",
  "referrer_id",
  "priority",
] as const;

type StudyLike = { type?: unknown; region?: unknown; contrast?: unknown };

/** Дослідження запису → експортна форма: лише type/region/contrast. */
export function projectStudies(studies: unknown): Array<{
  type: string | null;
  region: string | null;
  contrast: boolean | null;
}> {
  if (!Array.isArray(studies)) return [];
  return (studies as StudyLike[]).map((s) => ({
    type: typeof s?.type === "string" ? s.type : null,
    region: typeof s?.region === "string" ? s.region : null,
    contrast: typeof s?.contrast === "boolean" ? s.contrast : null,
  }));
}

/** Проєкція рядка queue_entries у форму API (режим A). Whitelist: беремо
    ЛИШЕ перелічені поля — нова колонка БД не протече сама собою. */
export function projectAppointment(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of APPOINTMENT_EXPORT_FIELDS) {
    if (f === "studies") continue;
    if (f === "id") {
      out.entry_id = row.id ?? null; // назовні — entry_id (термінологія плану)
      continue;
    }
    out[f] = (row as Record<string, unknown>)[f] ?? null;
  }
  out.studies = projectStudies(row.studies);
  return out;
}

/* ===== Інтервали (хвилини доби) для вільних вікон ===== */

export interface Interval {
  s: number;
  e: number;
}

/** Злиття перетинних/дотичних інтервалів; відкидає порожні; сортує. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .filter((i) => i.e > i.s)
    .slice()
    .sort((a, b) => a.s - b.s);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.s <= last.e) last.e = Math.max(last.e, cur.e);
    else out.push({ ...cur });
  }
  return out;
}

/** window мінус blockers → вільні інтервали (обрізані по window). */
export function subtractIntervals(window: Interval, blockers: Interval[]): Interval[] {
  if (!(window.e > window.s)) return [];
  const merged = mergeIntervals(
    blockers.map((b) => ({ s: Math.max(b.s, window.s), e: Math.min(b.e, window.e) }))
  );
  const free: Interval[] = [];
  let cursor = window.s;
  for (const b of merged) {
    if (b.s > cursor) free.push({ s: cursor, e: b.s });
    cursor = Math.max(cursor, b.e);
  }
  if (cursor < window.e) free.push({ s: cursor, e: window.e });
  return free;
}

/** Рядки room_busy_slots → зайняті інтервали. Контракт 0074: start_min/end_min
    — джерело правди (вікно, ОБРІЗАНЕ по добі); fallback на старий контракт —
    БЕЗ дефолтів «|| 30» (хвостовий рядок після опівночі законно має 0 хв
    дослідження — дефолт намалював би зайнятість із повітря). */
export function busyRowsToIntervals(
  rows: Array<{
    start_min?: number | null;
    end_min?: number | null;
    scheduled_time?: string | null;
    duration_min?: number | null;
    buffer_time_min?: number | null;
  }>
): Interval[] {
  const toMin = (t: string) => {
    const p = t.split(":");
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  };
  return mergeIntervals(
    (rows || []).flatMap((r) => {
      if (r.start_min != null && r.end_min != null) return [{ s: r.start_min, e: r.end_min }];
      // напівзламаний рядок (start_min без end_min, немає scheduled_time):
      // з room_busy_slots така форма неможлива (0074 віддає *_min парою),
      // тож НЕ малюємо фантомну зайнятість о 00:00 — пропускаємо
      if (!r.scheduled_time) return [];
      const s = toMin(r.scheduled_time);
      return [{ s, e: s + (r.duration_min ?? 0) + (r.buffer_time_min ?? 0) }];
    })
  );
}

/* ===== Дати ===== */

/** Суворий 'YYYY-MM-DD' → компоненти; невалідний рядок/дата → null. */
export function parseDateKey(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return { y, m: mo, d };
}

/** Date із КОМПОНЕНТ (локальний конструктор): день тижня не залежить від TZ
    сервера — на відміну від new Date('YYYY-MM-DD') (UTC-опівніч). */
export function dateFromKey(s: string): Date | null {
  const p = parseDateKey(s);
  return p ? new Date(p.y, p.m - 1, p.d) : null;
}

/** Кількість днів включно між ключами; невалід → null. */
export function daysBetweenKeys(from: string, to: string): number | null {
  const a = dateFromKey(from);
  const b = dateFromKey(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

export function addDaysKey(s: string, days: number): string | null {
  const d = dateFromKey(s);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export const minToHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export const hhmmToMin = (t: string): number => {
  const [h, m] = String(t || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
