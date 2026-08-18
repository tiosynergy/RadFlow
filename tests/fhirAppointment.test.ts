import { describe, it, expect } from "vitest";
import {
  QUEUE_TO_FHIR_STATUS,
  appointmentResource,
  appointmentWallSpan,
  studiesToServiceTypes,
  toFhirAppointmentStatus,
  type AppointmentRow,
} from "@/lib/fhirAppointment";
import { APPOINTMENT_FORBIDDEN_FIELDS } from "@/lib/integrationContract";

const ENTRY = "a4297670-1111-2222-3333-444455556666";
const ROOM = "11111111-2222-3333-4444-555555555555";
const BASE = "https://rad-flow-tau.vercel.app";

const row = (over: Partial<AppointmentRow> = {}): AppointmentRow => ({
  id: ENTRY,
  room_id: ROOM,
  status: "scheduled",
  scheduled_date: "2026-08-18",
  scheduled_time: "10:30",
  duration_min: 30,
  buffer_time_min: 10,
  priority_level: 0,
  cito: false,
  has_contrast: false,
  off_schedule: false,
  case_id: null,
  case_step: null,
  updated_at: "2026-08-17T12:00:00.000Z",
  created_at: "2026-08-01T09:00:00.000Z",
  studies: [{ type: "MRI", region: "brain", contrast: false }],
  ...over,
});

describe("статуси черги → Appointment.status", () => {
  it("покриває ВСІ вісім значень queue_status", () => {
    // Дзеркало enum-а в БД. Новий статус мусить впасти тут, а не поїхати
    // назовні як null або як мовчазне «cancelled».
    expect(Object.keys(QUEUE_TO_FHIR_STATUS).sort()).toEqual(
      [
        "cancelled",
        "done",
        "needs_reschedule",
        "no_show",
        "not_held",
        "in_progress",
        "scheduled",
        "waiting",
      ].sort()
    );
  });

  it("мапить за таблицею", () => {
    expect(toFhirAppointmentStatus("scheduled")).toBe("booked");
    expect(toFhirAppointmentStatus("waiting")).toBe("arrived");
    expect(toFhirAppointmentStatus("in_progress")).toBe("checked-in");
    expect(toFhirAppointmentStatus("done")).toBe("fulfilled");
    expect(toFhirAppointmentStatus("no_show")).toBe("noshow");
    expect(toFhirAppointmentStatus("needs_reschedule")).toBe("waitlist");
  });

  it("невідомий статус → null, без вгадування", () => {
    expect(toFhirAppointmentStatus("не-статус")).toBeNull();
    expect(toFhirAppointmentStatus(null)).toBeNull();
  });
});

describe("втрата різниці при схлопуванні статусів компенсована", () => {
  it("not_held і cancelled дають однаковий status, але різні розширення", () => {
    // На проді not_held — живий статус (9 записів). Якби різниця зникала
    // безслідно, партнер не відрізнив би «не відбулося» від скасування.
    const a = appointmentResource(row({ status: "not_held" }), BASE, null);
    const b = appointmentResource(row({ status: "cancelled" }), BASE, null);
    expect(a.status).toBe("cancelled");
    expect(b.status).toBe("cancelled");

    const raw = (r: Record<string, unknown>) =>
      ((r.extension ?? []) as Array<{ url: string; valueCode?: string }>).find((e) =>
        e.url.endsWith("radflow-queue-status")
      )?.valueCode;
    expect(raw(a)).toBe("not_held");
    expect(raw(b)).toBe("cancelled");
    expect(raw(a)).not.toBe(raw(b));
  });
});

describe("режим A — пацієнт як непрозорий ідентифікатор ЗАПИСУ", () => {
  it("учасник-пацієнт має identifier, але НЕ має reference", () => {
    const a = appointmentResource(row(), BASE, null);
    const parts = a.participant as Array<{ actor: Record<string, unknown> }>;
    const patient = parts[0].actor as {
      type?: string;
      reference?: string;
      identifier?: { system: string; value: string };
    };
    expect(patient.type).toBe("Patient");
    expect(patient.reference).toBeUndefined(); // ресурсу Patient не існує
    expect(patient.identifier?.system).toBe(`${BASE}/fhir/NamingSystem/entry`);
    // Значення — id ЗАПИСУ: два візити однієї людини ззовні не звʼязуються.
    expect(patient.identifier?.value).toBe(ENTRY);
  });

  it("ЖОДНОГО поля з чорного списку v1 у серіалізованому ресурсі", () => {
    // Найважливіший тест файлу. Підсовуємо рядок, у якому демографія
    // ПРИСУТНЯ: мапер працює за білим списком, тож мусить її не помітити.
    // Чорний список — той самий, що охороняє REST v1 і його SQL-двійник
    // 0145: канали не мають розходитись у тому, що вважається демографією.
    const dirty = {
      ...row({ case_id: "case-1", case_step: 2 }),
      patient_name: "Іваненко Іван",
      patient_phone: "+380501234567",
      patient_dob: "1980-01-01",
      patient_sex: "M",
      note: "внутрішня нотатка",
      indication: "клінічний контекст",
      contraindications: "кардіостимулятор",
      doctor: "Петренко",
      referrer_id: "ref-1",
      priority: "urgent",
    } as unknown as AppointmentRow;

    const json = JSON.stringify(
      appointmentResource(dirty, BASE, {
        start: "2026-08-18T07:30:00Z",
        end: "2026-08-18T08:00:00Z",
      })
    );
    // Перевіряємо КЛЮЧІ (у лапках): голе `priority` збіглося б із
    // розширенням radflow-priority-level, а priority_level — дозволене поле.
    for (const forbidden of APPOINTMENT_FORBIDDEN_FIELDS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    // І самі значення — на випадок, якби вони протекли під іншим ключем.
    for (const value of ["Іваненко", "+380501234567", "1980-01-01", "кардіостимулятор", "Петренко"]) {
      expect(json).not.toContain(value);
    }
  });
});

describe("межі запису і буфер", () => {
  it("тривалість без буфера", () => {
    const sp = appointmentWallSpan(row());
    expect(sp).toEqual({ startMin: 630, endMin: 660 }); // 10:30 + 30 хв
  });

  it("буфер НЕ входить в end, а їде розширенням", () => {
    // Буфер — наш час на прибирання, не час пацієнта. У end він зробив би
    // дослідження довшим, ніж воно є.
    const sp = appointmentWallSpan(row({ buffer_time_min: 15 }));
    expect(sp?.endMin).toBe(660); // 30 хв, не 45
    const a = appointmentResource(row({ buffer_time_min: 15 }), BASE, null);
    const buf = ((a.extension ?? []) as Array<{ url: string; valueInteger?: number }>).find((e) =>
      e.url.endsWith("radflow-buffer-min")
    );
    expect(buf?.valueInteger).toBe(15);
  });

  it("немає часу або тривалості → span=null, інтервал не вигадується", () => {
    expect(appointmentWallSpan(row({ scheduled_time: null }))).toBeNull();
    expect(appointmentWallSpan(row({ duration_min: null }))).toBeNull();
    expect(appointmentWallSpan(row({ duration_min: 0 }))).toBeNull();
    const a = appointmentResource(row({ scheduled_time: null }), BASE, null);
    expect(a.start).toBeUndefined();
    expect(a.end).toBeUndefined();
  });
});

describe("дослідження → serviceType", () => {
  it("тип дає власний код і DICOM, регіон — окреме кодування", () => {
    const st = studiesToServiceTypes([{ type: "MRI", region: "brain" }], BASE);
    const codes = (st[0].coding as Array<{ system: string; code: string }>);
    expect(codes[0]).toEqual({ system: `${BASE}/fhir/CodeSystem/study-type`, code: "MRI" });
    expect(codes[1].code).toBe("MR");
    expect(codes[2]).toEqual({ system: `${BASE}/fhir/CodeSystem/study-region`, code: "brain" });
  });

  it("сміття у studies не ламає ресурс", () => {
    expect(studiesToServiceTypes(null, BASE)).toEqual([]);
    expect(studiesToServiceTypes("не масив", BASE)).toEqual([]);
    expect(studiesToServiceTypes([{}, { type: 42 }], BASE)).toEqual([]);
  });

  it("невідомий тип не малює DICOM з повітря", () => {
    const st = studiesToServiceTypes([{ type: "PET" }], BASE);
    const codes = st[0].coding as Array<{ code: string }>;
    expect(codes).toHaveLength(1);
    expect(codes[0].code).toBe("PET");
  });
});
