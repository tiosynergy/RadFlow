/* ===== RadFlow — контракт FHIR R4 фасаду (фаза 3) =====
   ЧИСТА логіка (під vitest): словник модальностей, мапери довідників,
   конструктори Bundle/OperationOutcome. Мережі й БД тут немає СВІДОМО —
   роути лишаються тонкими, а контракт перевіряється без підняття Next.

   Фасад READ-ONLY і працює ЛИШЕ в режимі A (рішення власника, с36):
   демографія назовні не йде в жодному вигляді. Режим B (contained Patient)
   не реалізований — див. `fhirExportModeWarning`.

   Джерело правди мапінгів — claude/pacs-fhir-integration-plan.md §4.
   Зміна тут = свідома зміна контракту партнера (і docs/integration-fhir-r4.md). */

/** Версія FHIR, під яку заявлений фасад. R4 — базова; мапінги сумісні з
    R4B/R5, але CapabilityStatement заявляє рівно те, що реалізовано. */
export const FHIR_VERSION = "4.0.1";

/** Наш CodeSystem для кодів послуг (services.code, 0144). */
export const SERVICE_CODE_SYSTEM_PATH = "/fhir/CodeSystem/service";
/** NamingSystem для opaque-id ЗАПИСУ (не людини) — режим A, §4.4 плану. */
export const ENTRY_NAMING_SYSTEM_PATH = "/fhir/NamingSystem/entry";

/* ===== Модальність ↔ DICOM (0008,0060) ===== */

export type RadFlowModality = "MRI" | "CT" | "US" | "XRAY" | "MAMMO" | "OTHER";

/** DICOM PS3.3 C.7.3.1. XRAY → DX: план §4.3 лишає CR як можливе
    перевизначення per clinic (касетні апарати) — поки словник статичний,
    перевизначення додається окремим пакетом, коли зʼявиться така клініка. */
export const MODALITY_TO_DICOM: Readonly<Record<RadFlowModality, string>> = Object.freeze({
  MRI: "MR",
  CT: "CT",
  US: "US",
  XRAY: "DX",
  MAMMO: "MG",
  OTHER: "OT",
});

/** Зворотний напрям. OT→OTHER; невідомий код → null (не вгадуємо). */
export const DICOM_TO_MODALITY: Readonly<Record<string, RadFlowModality>> = Object.freeze({
  MR: "MRI",
  CT: "CT",
  US: "US",
  DX: "XRAY",
  MG: "MAMMO",
  OT: "OTHER",
});

export function toDicomModality(m: string | null | undefined): string | null {
  if (!m) return null;
  return MODALITY_TO_DICOM[m as RadFlowModality] ?? null;
}

export function fromDicomModality(code: string | null | undefined): RadFlowModality | null {
  if (!code) return null;
  return DICOM_TO_MODALITY[code.toUpperCase()] ?? null;
}

/* ===== OperationOutcome ===== */

/** Підмножина issue-кодів R4, якою користується фасад. */
export type FhirIssueCode =
  | "security"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "throttled"
  | "exception";

export interface OperationOutcome {
  resourceType: "OperationOutcome";
  issue: Array<{
    severity: "error";
    code: FhirIssueCode;
    diagnostics: string;
  }>;
}

/** FHIR не приймає `{error: "…"}` — помилка мусить бути ресурсом. */
export function operationOutcome(code: FhirIssueCode, diagnostics: string): OperationOutcome {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code, diagnostics }],
  };
}

/** HTTP-статус → issue-код. Тримаємо тут, щоб гейт інтеграційного API
    (lib/integrationAuth.ts) лишався недоторканим: він перевірений живим
    прогоном фази 2, і формат FHIR — не його турбота. */
export function issueCodeForStatus(status: number): FhirIssueCode {
  if (status === 401) return "security";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 400) return "invalid";
  if (status === 429) return "throttled";
  return "exception";
}

/* ===== Bundle ===== */

export interface BundleLink {
  relation: "self" | "next";
  url: string;
}

export interface SearchsetBundle {
  resourceType: "Bundle";
  type: "searchset";
  link: BundleLink[];
  entry: Array<{ fullUrl: string; resource: Record<string, unknown> }>;
}

/** Bundle типу searchset.

    `total` НЕ віддається СВІДОМО: пагінація фасаду keyset-ова (як і в REST
    v1), чесно порахувати загальну кількість без другого COUNT-запиту по
    рухливих даних неможливо. В R4 `total` для searchset опційний — краще
    його не мати, ніж мати неправдивим. */
export function searchsetBundle(
  baseUrl: string,
  resourceType: string,
  resources: Array<Record<string, unknown>>,
  links: { self: string; next?: string | null }
): SearchsetBundle {
  const link: BundleLink[] = [{ relation: "self", url: links.self }];
  if (links.next) link.push({ relation: "next", url: links.next });
  return {
    resourceType: "Bundle",
    type: "searchset",
    link,
    entry: resources.map((r) => ({
      fullUrl: `${baseUrl}/${resourceType}/${String(r.id ?? "")}`,
      resource: r,
    })),
  };
}

/* ===== Location (кабінети) ===== */

export interface RoomRow {
  id: string;
  name: string | null;
  modality: string | null;
  apparatus_model: string | null;
  active: boolean | null;
}

/** rooms → Location (mode=instance, partOf = сайт клініки).

    `status`: rooms.active=false — це «сюди не можна записувати» (канон 0123),
    а не «кабінету не існує». В R4 це рівно `suspended`, не `inactive`:
    inactive означає, що локація більше не використовується взагалі.

    Модальність — Location.type з DICOM-кодом. Причин простою тут немає:
    вони внутрішні (межа класу 1, §3 плану). */
export function locationFromRoom(room: RoomRow, clinicId: string): Record<string, unknown> {
  const dicom = toDicomModality(room.modality);
  const out: Record<string, unknown> = {
    resourceType: "Location",
    id: room.id,
    status: room.active === false ? "suspended" : "active",
    name: room.name ?? undefined,
    mode: "instance",
    physicalType: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/location-physical-type",
          code: "ro",
          display: "Room",
        },
      ],
    },
    partOf: { reference: `Location/${clinicId}` },
  };
  if (dicom) {
    out.type = [
      {
        coding: [{ system: "http://dicom.nema.org/resources/ontology/DCM", code: dicom }],
      },
    ];
  }
  // Модель апарата — опис локації, не окремий ресурс Device: Device потягнув
  // би за собою інвентарний контекст, якого RadFlow не веде.
  if (room.apparatus_model) out.description = room.apparatus_model;
  return out;
}

/** Клініка як Location-сайт. Окремого ресурсу Organization фасад у фазі 3
    не публікує — partOf мусить кудись вести, і сайт достатній. */
export function locationFromClinic(
  clinicId: string,
  name: string | null
): Record<string, unknown> {
  return {
    resourceType: "Location",
    id: clinicId,
    status: "active",
    name: name ?? undefined,
    mode: "instance",
    physicalType: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/location-physical-type",
          code: "si",
          display: "Site",
        },
      ],
    },
  };
}

/* ===== HealthcareService (послуги) ===== */

export interface ServiceRow {
  id: string;
  code: string | null;
  name: string | null;
  modality: string | null;
  duration_min: number | null;
  contrast_allowed: boolean | null;
  room_id: string | null;
  active: boolean | null;
}

/** services → HealthcareService.

    `id` — технічний uuid; стабільний код (0144) йде в `type.coding`, бо саме
    він призначений для HL7 AIS / FHIR serviceType і переживає перейменування.
    `code` типізований як nullable: тригер 0144 його присвоює, але покладатись
    на «на проді null-ів немає» не можна — колонка дозволяє null.

    Ціни НЕ віддаються (комерційна інформація клініки, канон v1).
    duration_min може бути null (0117 «час не задано») — тоді extension
    просто відсутній, а не 0: нуль означав би «миттєве дослідження». */
export function healthcareServiceFromService(
  svc: ServiceRow,
  clinicId: string,
  baseUrl: string
): Record<string, unknown> {
  const dicom = toDicomModality(svc.modality);
  const coding: Array<Record<string, unknown>> = [];
  if (svc.code) {
    coding.push({ system: `${baseUrl}${SERVICE_CODE_SYSTEM_PATH}`, code: svc.code });
  }
  if (dicom) {
    coding.push({ system: "http://dicom.nema.org/resources/ontology/DCM", code: dicom });
  }

  const out: Record<string, unknown> = {
    resourceType: "HealthcareService",
    id: svc.id,
    active: svc.active !== false,
    providedBy: { reference: `Location/${clinicId}` },
    name: svc.name ?? undefined,
  };
  if (coding.length) out.type = [{ coding }];
  // room_id = null — базова послуга клініки (канон 0121): доступна в кабінетах
  // тієї ж модальності, тому конкретної локації в неї немає.
  if (svc.room_id) out.location = [{ reference: `Location/${svc.room_id}` }];

  const ext: Array<Record<string, unknown>> = [];
  if (svc.duration_min != null) {
    ext.push({
      url: `${baseUrl}/fhir/StructureDefinition/radflow-duration-min`,
      valueInteger: svc.duration_min,
    });
  }
  if (svc.contrast_allowed != null) {
    ext.push({
      url: `${baseUrl}/fhir/StructureDefinition/radflow-contrast-allowed`,
      valueBoolean: svc.contrast_allowed,
    });
  }
  if (ext.length) out.extension = ext;
  return out;
}

/* ===== Режим експорту ===== */

/** Фасад реалізує ЛИШЕ режим A. Якщо ключу колись виставлять export_mode='B'
    прямим UPDATE-ом у БД, це НЕ повинно мовчки почати віддавати демографію —
    і так само не повинно мовчки віддавати A, ніби нічого не сталось.
    Повертає текст попередження для логів або null. */
export function fhirExportModeWarning(exportMode: string): string | null {
  return exportMode === "B"
    ? "export_mode=B не підтримується FHIR-фасадом; віддано проєкцію режиму A"
    : null;
}
