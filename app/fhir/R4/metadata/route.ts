import { FHIR_VERSION } from "@/lib/fhirContract";
import { baseUrlFrom, fhirJson } from "@/lib/fhirHttp";

/* ===== RadFlow — FHIR R4: CapabilityStatement =====
   GET /fhir/R4/metadata

   Точка входу: за нею RIS дізнається, що фасад уміє. За R4 `metadata` —
   ЄДИНИЙ ендпоінт, який віддається БЕЗ автентифікації: клієнт мусить мати
   змогу дізнатись спосіб автентифікації до того, як автентифікувався.
   Жодних даних клініки тут немає — лише опис можливостей, однаковий для
   всіх ключів.

   Заявляємо РІВНО те, що реалізовано (фаза 3, пакет 1): Location і
   HealthcareService. Schedule/Slot/Appointment додаються в пакетах 2–3
   разом із записами тут — заявити наперед означало б збрехати клієнту,
   який будує свою логіку за CapabilityStatement. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const base = baseUrlFrom(req);

  return fhirJson({
    resourceType: "CapabilityStatement",
    status: "active",
    // Дата релізу контракту, не «зараз»: змінюється разом зі змістом.
    date: "2026-08-15",
    publisher: "RadFlow",
    kind: "instance",
    software: { name: "RadFlow FHIR facade" },
    implementation: {
      description: "RadFlow — операційний read-only фасад (записи, розклад, кабінети, послуги)",
      url: `${base}/fhir/R4`,
    },
    fhirVersion: FHIR_VERSION,
    format: ["application/fhir+json"],
    rest: [
      {
        mode: "server",
        documentation:
          "Read-only. Автентифікація: HTTP Bearer з інтеграційним ключем клініки " +
          "(той самий ключ, що й для REST v1). Клініка визначається ключем, " +
          "параметром запиту її задати не можна. Демографія пацієнта назовні " +
          "не передається: у записі пацієнт — непрозорий ідентифікатор ЗАПИСУ.",
        security: {
          service: [
            {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/restful-security-service",
                  code: "OAuth",
                  display: "OAuth",
                },
              ],
              text: "HTTP Bearer token (інтеграційний ключ RadFlow)",
            },
          ],
        },
        resource: [
          {
            type: "Location",
            interaction: [{ code: "read" }, { code: "search-type" }],
            documentation:
              "Кабінети клініки (mode=instance) і сама клініка як site. " +
              "Модальність — Location.type кодом DICOM (0008,0060).",
            searchParam: [
              { name: "status", type: "token", documentation: "active | suspended" },
              { name: "_count", type: "number" },
            ],
          },
          {
            type: "HealthcareService",
            interaction: [{ code: "read" }, { code: "search-type" }],
            documentation:
              "Каталог послуг. Стабільний код послуги — у type.coding із system " +
              `${base}/fhir/CodeSystem/service. Ціни не публікуються.`,
            searchParam: [
              { name: "location", type: "reference", documentation: "Location/{room_id}" },
              { name: "active", type: "token" },
              { name: "_count", type: "number" },
            ],
          },
        ],
      },
    ],
  });
}
