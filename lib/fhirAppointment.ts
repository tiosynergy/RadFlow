/* ===== RadFlow — Appointment для FHIR R4 фасаду (фаза 3, пакет 3) =====
   ЧИСТА логіка під vitest. Режим A: пацієнт назовні — НЕПРОЗОРИЙ
   ідентифікатор ЗАПИСУ, не людини. Демографії немає в жодному вигляді.

   Джерело правди полів — APPOINTMENT_EXPORT_FIELDS у lib/integrationContract.ts
   (і його SQL-двійник у 0145). Цей модуль НЕ розширює білий список: він лише
   перекладає вже дозволені поля у форму FHIR. Якщо тут зʼявилось поле, якого
   немає в тому списку, — це помилка, а не фіча. */

import { toDicomModality } from "@/lib/fhirContract";

/** Статуси черги RadFlow (enum queue_status). */
export type QueueStatusValue =
  | "scheduled"
  | "waiting"
  | "in_progress"
  | "done"
  | "no_show"
  | "cancelled"
  | "not_held"
  | "needs_reschedule";

/** Статуси Appointment за R4, якими користується фасад. */
export type FhirAppointmentStatus =
  | "booked"
  | "arrived"
  | "checked-in"
  | "fulfilled"
  | "noshow"
  | "cancelled"
  | "waitlist";

/** queue_status → Appointment.status.

    Відповідність НЕ взаємно однозначна, і це головне, що треба знати про
    цей мапінг. R4 не має коду для «дослідження триває» і для «не відбулося»,
    тож:
    - `in_progress` → `checked-in` (пацієнта прийнято; найближче, що є);
    - `not_held` і `cancelled` обидва → `cancelled`;
    - `needs_reschedule` → `waitlist` (запис існує, слот треба призначити).

    Через це КОЖЕН Appointment несе розширення `radflow-queue-status` із
    сирим значенням. Партнер, якому потрібна точна різниця (а вона потрібна:
    на проді `not_held` — живий статус), читає розширення; партнер, якому
    вистачає стандарту, читає status і не знає про наші подробиці. Мовчазне
    схлопування без сліду було б втратою даних. */
export const QUEUE_TO_FHIR_STATUS: Readonly<Record<QueueStatusValue, FhirAppointmentStatus>> =
  Object.freeze({
    scheduled: "booked",
    waiting: "arrived",
    in_progress: "checked-in",
    done: "fulfilled",
    no_show: "noshow",
    cancelled: "cancelled",
    not_held: "cancelled",
    needs_reschedule: "waitlist",
  });

/** Невідомий статус → null: вигадувати «щось схоже» тут не можна. */
export function toFhirAppointmentStatus(s: string | null | undefined): FhirAppointmentStatus | null {
  if (!s) return null;
  return QUEUE_TO_FHIR_STATUS[s as QueueStatusValue] ?? null;
}

/** Рядок queue_entries у межах білого списку класу 1. */
export interface AppointmentRow {
  id: string;
  room_id: string | null;
  status: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
  priority_level: number | null;
  cito: boolean | null;
  has_contrast: boolean | null;
  off_schedule: boolean | null;
  case_id: string | null;
  case_step: number | null;
  updated_at: string | null;
  created_at: string | null;
  studies: unknown;
}

/** Межі запису у стінних хвилинах доби. `null`, якщо часу або тривалості
    немає: на проді таких рядків немає, але колонки nullable, і малювати
    інтервал із повітря не можна — RIS спланував би слот, якого не існує. */
export function appointmentWallSpan(
  row: AppointmentRow
): { startMin: number; endMin: number } | null {
  if (!row.scheduled_time || !row.scheduled_date) return null;
  const p = String(row.scheduled_time).split(":");
  const h = Number(p[0]);
  const m = Number(p[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const startMin = h * 60 + m;
  const dur = row.duration_min;
  if (dur == null || !Number.isFinite(dur) || dur <= 0) return null;
  return { startMin, endMin: startMin + dur };
}

type StudyLike = { type?: unknown; region?: unknown; contrast?: unknown };

/** Дослідження запису → serviceType-кодування.

    Тип дослідження — це модальність у наших термінах, тож поруч із власним
    кодом кладемо DICOM, коли він відомий. Регіон іде ОКРЕМИМ кодуванням, а
    не склеєним рядком: партнер має змогу зіставити його зі своїм довідником.
    Клінічного контексту (показання, протипоказання, нотатки) тут немає й
    бути не може — це клас 3. */
export function studiesToServiceTypes(
  studies: unknown,
  baseUrl: string
): Array<Record<string, unknown>> {
  if (!Array.isArray(studies)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const s of studies as StudyLike[]) {
    const coding: Array<Record<string, unknown>> = [];
    const type = typeof s?.type === "string" ? s.type : null;
    const region = typeof s?.region === "string" ? s.region : null;
    if (type) {
      coding.push({ system: `${baseUrl}/fhir/CodeSystem/study-type`, code: type });
      const dicom = toDicomModality(type);
      if (dicom) {
        coding.push({ system: "http://dicom.nema.org/resources/ontology/DCM", code: dicom });
      }
    }
    if (region) {
      coding.push({ system: `${baseUrl}/fhir/CodeSystem/study-region`, code: region });
    }
    if (coding.length) out.push({ coding });
  }
  return out;
}

/** queue_entries → Appointment (режим A).

    `start`/`end` приходять уже сконвертованими в instant (lib/fhirTime.ts).
    `end` — це початок ПЛЮС тривалість дослідження, БЕЗ буфера: буфер це
    наш внутрішній час на прибирання й підготовку, він не є часом пацієнта.
    Якби буфер входив у `end`, RIS показав би пацієнту довше дослідження,
    ніж воно є. Сам буфер їде окремим розширенням — він потрібен тому, хто
    планує завантаження апарата.

    Пацієнт — логічне посилання на ЗАПИС (§4.4 плану, режим A): жодного
    імені, телефону чи дати народження. Ресурс Patient фасад не публікує. */
export function appointmentResource(
  row: AppointmentRow,
  baseUrl: string,
  span: { start: string; end: string } | null
): Record<string, unknown> {
  const status = toFhirAppointmentStatus(row.status);
  const out: Record<string, unknown> = {
    resourceType: "Appointment",
    id: row.id,
    status: status ?? "cancelled",
  };
  if (row.updated_at) out.meta = { lastUpdated: row.updated_at };
  if (row.created_at) out.created = row.created_at;
  if (span) {
    out.start = span.start;
    out.end = span.end;
  }
  if (row.duration_min != null) out.minutesDuration = row.duration_min;

  const serviceType = studiesToServiceTypes(row.studies, baseUrl);
  if (serviceType.length) out.serviceType = serviceType;

  /* Учасники. Пацієнт — ЛОГІЧНЕ посилання: Reference без `reference`, лише
     `identifier`. Значення — id ЗАПИСУ, не людини: два візити одного
     пацієнта дадуть два різні ідентифікатори, і зіставити їх між собою
     ззовні неможливо. Це і є режим A. */
  const participant: Array<Record<string, unknown>> = [
    {
      actor: {
        type: "Patient",
        identifier: { system: `${baseUrl}/fhir/NamingSystem/entry`, value: row.id },
      },
      status: "accepted",
    },
  ];
  if (row.room_id) {
    participant.push({
      actor: { reference: `Location/${row.room_id}` },
      status: "accepted",
    });
  }
  out.participant = participant;

  /* Розширення. Сирий статус черги — ОБОВʼЯЗКОВИЙ (див. коментар до
     QUEUE_TO_FHIR_STATUS): без нього `not_held` невідрізненний від
     справжнього скасування. Решта — операційні ознаки класу 1. */
  const ext: Array<Record<string, unknown>> = [];
  const sd = `${baseUrl}/fhir/StructureDefinition`;
  if (row.status) ext.push({ url: `${sd}/radflow-queue-status`, valueCode: row.status });
  if (row.buffer_time_min != null) {
    ext.push({ url: `${sd}/radflow-buffer-min`, valueInteger: row.buffer_time_min });
  }
  if (row.cito != null) ext.push({ url: `${sd}/radflow-cito`, valueBoolean: row.cito });
  if (row.has_contrast != null) {
    ext.push({ url: `${sd}/radflow-contrast`, valueBoolean: row.has_contrast });
  }
  if (row.off_schedule != null) {
    ext.push({ url: `${sd}/radflow-off-schedule`, valueBoolean: row.off_schedule });
  }
  if (row.priority_level != null) {
    ext.push({ url: `${sd}/radflow-priority-level`, valueInteger: row.priority_level });
  }
  if (row.case_id) ext.push({ url: `${sd}/radflow-case-id`, valueString: row.case_id });
  if (row.case_step != null) {
    ext.push({ url: `${sd}/radflow-case-step`, valueInteger: row.case_step });
  }
  out.extension = ext;
  return out;
}
