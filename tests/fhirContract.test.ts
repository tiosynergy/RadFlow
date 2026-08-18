import { describe, it, expect } from "vitest";
import {
  DICOM_TO_MODALITY,
  FHIR_VERSION,
  MODALITY_TO_DICOM,
  fhirExportModeWarning,
  fromDicomModality,
  healthcareServiceFromService,
  issueCodeForStatus,
  locationFromClinic,
  locationFromRoom,
  operationOutcome,
  parseSlotId,
  scheduleFromRoom,
  searchsetBundle,
  slotId,
  slotResource,
  toDicomModality,
  type RoomRow,
  type ServiceRow,
} from "@/lib/fhirContract";

const CLINIC = "c0aaaf36-a13f-4fa1-8882-b4b133d4ffcd";
const ROOM = "11111111-2222-3333-4444-555555555555";
const BASE = "https://rad-flow-tau.vercel.app";

const room = (over: Partial<RoomRow> = {}): RoomRow => ({
  id: ROOM,
  name: "МРТ-1",
  modality: "MRI",
  apparatus_model: "Siemens Magnetom",
  active: true,
  ...over,
});

const service = (over: Partial<ServiceRow> = {}): ServiceRow => ({
  id: "99999999-8888-7777-6666-555555555555",
  code: "MRI-BRAIN",
  name: "МРТ головного мозку",
  modality: "MRI",
  duration_min: 30,
  contrast_allowed: true,
  room_id: null,
  active: true,
  ...over,
});

describe("модальність ↔ DICOM", () => {
  it("покриває ВСІ значення enum modality", () => {
    // Список — дзеркало enum-а в БД (supabase/types.ts). Нове значення
    // модальності мусить впасти саме тут, а не мовчки поїхати назовні як null.
    const enumValues = ["MRI", "CT", "US", "XRAY", "MAMMO", "OTHER"];
    expect(Object.keys(MODALITY_TO_DICOM).sort()).toEqual(enumValues.slice().sort());
  });

  it("мапить за планом §4.3", () => {
    expect(toDicomModality("MRI")).toBe("MR");
    expect(toDicomModality("CT")).toBe("CT");
    expect(toDicomModality("US")).toBe("US");
    expect(toDicomModality("XRAY")).toBe("DX");
    expect(toDicomModality("MAMMO")).toBe("MG");
    expect(toDicomModality("OTHER")).toBe("OT");
  });

  it("невідоме/порожнє → null, без вгадування", () => {
    expect(toDicomModality(null)).toBeNull();
    expect(toDicomModality("")).toBeNull();
    expect(toDicomModality("PET")).toBeNull();
    expect(fromDicomModality("XX")).toBeNull();
    expect(fromDicomModality(null)).toBeNull();
  });

  it("зворотний напрям — біекція", () => {
    for (const [rf, dicom] of Object.entries(MODALITY_TO_DICOM)) {
      expect(DICOM_TO_MODALITY[dicom]).toBe(rf);
    }
    expect(fromDicomModality("mr")).toBe("MRI"); // регістр не має значення
  });
});

describe("OperationOutcome", () => {
  it("статус → issue-код", () => {
    expect(issueCodeForStatus(401)).toBe("security");
    expect(issueCodeForStatus(403)).toBe("forbidden");
    expect(issueCodeForStatus(404)).toBe("not-found");
    expect(issueCodeForStatus(400)).toBe("invalid");
    expect(issueCodeForStatus(429)).toBe("throttled");
    expect(issueCodeForStatus(500)).toBe("exception");
    expect(issueCodeForStatus(418)).toBe("exception"); // невідомий → exception
  });

  it("має форму ресурсу, а не {error}", () => {
    const oo = operationOutcome("not-found", "Location не знайдено");
    expect(oo.resourceType).toBe("OperationOutcome");
    expect(oo.issue).toHaveLength(1);
    expect(oo.issue[0].severity).toBe("error");
    expect(oo).not.toHaveProperty("error");
  });
});

describe("Bundle", () => {
  it("searchset із self, fullUrl і БЕЗ total", () => {
    const b = searchsetBundle(`${BASE}/fhir/R4`, "Location", [locationFromRoom(room(), CLINIC)], {
      self: `${BASE}/fhir/R4/Location`,
    });
    expect(b.type).toBe("searchset");
    expect(b.entry[0].fullUrl).toBe(`${BASE}/fhir/R4/Location/${ROOM}`);
    expect(b.link).toEqual([{ relation: "self", url: `${BASE}/fhir/R4/Location` }]);
    // total для keyset-пагінації чесно не рахується — його не має бути взагалі
    expect(b).not.toHaveProperty("total");
  });

  it("next додається лише коли він є", () => {
    const withNext = searchsetBundle(`${BASE}/fhir/R4`, "Location", [], {
      self: "s",
      next: "n",
    });
    expect(withNext.link.map((l) => l.relation)).toEqual(["self", "next"]);
    const noNext = searchsetBundle(`${BASE}/fhir/R4`, "Location", [], { self: "s", next: null });
    expect(noNext.link.map((l) => l.relation)).toEqual(["self"]);
  });
});

describe("Location", () => {
  it("активний кабінет → status=active, тип DICOM, partOf на сайт", () => {
    const loc = locationFromRoom(room(), CLINIC);
    expect(loc.resourceType).toBe("Location");
    expect(loc.id).toBe(ROOM);
    expect(loc.status).toBe("active");
    expect(loc.mode).toBe("instance");
    expect(loc.partOf).toEqual({ reference: `Location/${CLINIC}` });
    const type = loc.type as Array<{ coding: Array<{ code: string }> }>;
    expect(type[0].coding[0].code).toBe("MR");
  });

  it("вимкнений кабінет → suspended, НЕ inactive", () => {
    // active=false (0123) = «сюди не можна записувати», а не «локації нема».
    // inactive у R4 означає, що локація більше не використовується взагалі.
    expect(locationFromRoom(room({ active: false }), CLINIC).status).toBe("suspended");
  });

  it("невідома модальність не малює type з повітря", () => {
    expect(locationFromRoom(room({ modality: null }), CLINIC).type).toBeUndefined();
  });

  it("клініка — site, без partOf", () => {
    const site = locationFromClinic(CLINIC, "Medicom-Odessa");
    expect(site.id).toBe(CLINIC);
    const pt = site.physicalType as { coding: Array<{ code: string }> };
    expect(pt.coding[0].code).toBe("si");
    expect(site.partOf).toBeUndefined();
  });

  it("назовні не протікає нічого, крім класу 1", () => {
    const loc = locationFromRoom(room(), CLINIC);
    // причини простоїв, розклад, інциденти — внутрішнє (§3 плану)
    for (const forbidden of ["schedule", "incidents", "reason", "label", "clinic_id"]) {
      expect(loc).not.toHaveProperty(forbidden);
    }
  });
});

describe("HealthcareService", () => {
  it("код послуги — у type.coding з нашим CodeSystem, id — технічний uuid", () => {
    const hs = healthcareServiceFromService(service(), CLINIC, BASE);
    expect(hs.id).toBe("99999999-8888-7777-6666-555555555555");
    const type = hs.type as Array<{ coding: Array<{ system: string; code: string }> }>;
    expect(type[0].coding[0]).toEqual({
      system: `${BASE}/fhir/CodeSystem/service`,
      code: "MRI-BRAIN",
    });
    expect(type[0].coding[1].code).toBe("MR");
  });

  it("ціни НЕ віддаються за жодних обставин", () => {
    const hs = healthcareServiceFromService(service(), CLINIC, BASE);
    for (const forbidden of ["price", "contrast_price", "sort_order", "source"]) {
      expect(hs).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(hs)).not.toMatch(/price/i);
  });

  it("code=null не ламає ресурс (колонка nullable)", () => {
    const hs = healthcareServiceFromService(service({ code: null }), CLINIC, BASE);
    const type = hs.type as Array<{ coding: Array<{ code: string }> }>;
    expect(type[0].coding).toHaveLength(1); // лише DICOM
    expect(type[0].coding[0].code).toBe("MR");
  });

  it("duration_min=null (0117) → extension відсутній, а не 0", () => {
    // Нуль означав би «миттєве дослідження» — RIS спланував би слот у 0 хвилин.
    const hs = healthcareServiceFromService(service({ duration_min: null }), CLINIC, BASE);
    const ext = (hs.extension ?? []) as Array<{ url: string }>;
    expect(ext.some((e) => e.url.endsWith("radflow-duration-min"))).toBe(false);
  });

  it("базова послуга (room_id=null) не прив'язана до локації", () => {
    expect(healthcareServiceFromService(service(), CLINIC, BASE).location).toBeUndefined();
    const owned = healthcareServiceFromService(service({ room_id: ROOM }), CLINIC, BASE);
    expect(owned.location).toEqual([{ reference: `Location/${ROOM}` }]);
  });
});

describe("режим експорту", () => {
  it("режим A — тиша", () => {
    expect(fhirExportModeWarning("A")).toBeNull();
  });

  it("режим B — попередження, а не мовчазна згода", () => {
    // Фасад реалізує лише A. Якщо ключу виставлять B прямим UPDATE-ом,
    // це мусить лишити слід у логах, а не проскочити непоміченим.
    expect(fhirExportModeWarning("B")).toContain("не підтримується");
  });
});

describe("версія", () => {
  it("заявлена R4", () => {
    expect(FHIR_VERSION).toBe("4.0.1");
  });
});

describe("Schedule", () => {
  it("id збігається з кабінетом, actor веде на кабінет і клініку", () => {
    const sch = scheduleFromRoom(room(), CLINIC);
    expect(sch.resourceType).toBe("Schedule");
    expect(sch.id).toBe(ROOM);
    expect(sch.active).toBe(true);
    expect(sch.actor).toEqual([
      { reference: `Location/${ROOM}` },
      { reference: `Location/${CLINIC}` },
    ]);
    const st = sch.serviceType as Array<{ coding: Array<{ code: string }> }>;
    expect(st[0].coding[0].code).toBe("MR");
  });

  it("вимкнений кабінет → active=false", () => {
    expect(scheduleFromRoom(room({ active: false }), CLINIC).active).toBe(false);
  });
});

describe("id слота — детермінований і оборотний", () => {
  it("склеювання і розбір дають те саме", () => {
    const id = slotId(ROOM, "2026-08-18", 480, 510);
    expect(id).toBe(`${ROOM}.2026-08-18.480-510`);
    expect(parseSlotId(id)).toEqual({
      roomId: ROOM,
      dateKey: "2026-08-18",
      startMin: 480,
      endMin: 510,
    });
  });

  it("вкладається в стелю FHIR id (64 символи)", () => {
    // Найдовший можливий варіант: обидві межі чотиризначні.
    expect(slotId(ROOM, "2026-12-31", 1380, 1440).length).toBeLessThanOrEqual(64);
  });

  it("той самий слот дає той самий id при перерахунку", () => {
    // Слотів у БД немає — вони рахуються щоразу заново. Якби id залежав від
    // порядку чи лічильника, посилання партнера протухало б за хвилини.
    expect(slotId(ROOM, "2026-08-18", 480, 510)).toBe(slotId(ROOM, "2026-08-18", 480, 510));
  });
});

describe("розбір id слота відкидає сміття", () => {
  it("порожнє, чуже, обрізане → null", () => {
    for (const bad of [
      null,
      "",
      "не-uuid.2026-08-18.480-510",
      `${ROOM}.18-08-2026.480-510`, // дата не ISO
      `${ROOM}.2026-08-18.480`, // немає кінця
      `${ROOM}.2026-08-18.480-510.extra`,
    ]) {
      expect(parseSlotId(bad)).toBeNull();
    }
  });

  it("неможливі межі доби → null", () => {
    expect(parseSlotId(`${ROOM}.2026-08-18.480-480`)).toBeNull(); // порожній
    expect(parseSlotId(`${ROOM}.2026-08-18.510-480`)).toBeNull(); // перевернутий
    expect(parseSlotId(`${ROOM}.2026-08-18.0-1441`)).toBeNull(); // за добу
  });

  it("1440 як кінець доби — валідний (канон v1)", () => {
    expect(parseSlotId(`${ROOM}.2026-08-18.1380-1440`)?.endMin).toBe(1440);
  });
});

describe("Slot", () => {
  it("посилається на розклад кабінету і несе instant-межі", () => {
    const s = slotResource(
      ROOM,
      "2026-08-18",
      480,
      510,
      "free",
      "2026-08-18T05:00:00Z",
      "2026-08-18T05:30:00Z"
    );
    expect(s.resourceType).toBe("Slot");
    expect(s.id).toBe(`${ROOM}.2026-08-18.480-510`);
    expect(s.schedule).toEqual({ reference: `Schedule/${ROOM}` });
    expect(s.status).toBe("free");
    expect(s.start).toBe("2026-08-18T05:00:00Z");
  });

  it("причина недоступності назовні не йде", () => {
    // Перерва, інцидент і вимкнений кабінет — усе це busy-unavailable.
    const s = slotResource(ROOM, "2026-08-18", 720, 780, "busy-unavailable", "a", "b");
    for (const forbidden of ["reason", "comment", "label", "incident"]) {
      expect(s).not.toHaveProperty(forbidden);
    }
  });
});
