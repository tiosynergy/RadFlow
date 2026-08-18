/* ===== RadFlow — HTTP-обв'язка FHIR R4 фасаду (фаза 3) =====
   Тонкий шар між роутами і перевіреним гейтом lib/integrationAuth.ts.

   Навіщо окремий шар: гейт віддає готовий NextResponse з `{error: "…"}`, а
   FHIR вимагає ресурс OperationOutcome і тип `application/fhir+json`. Гейт
   при цьому чіпати НЕ МОЖНА — він пройшов живий прогін фази 2 і тримає
   fail-closed-семантику (401/403 без деталей, який саме крок відмовив).
   Тому не параметр формату всередині гейта, а трансляція його відповіді. */

import { NextResponse } from "next/server";
import {
  issueCodeForStatus,
  operationOutcome,
  fhirExportModeWarning,
  type FhirIssueCode,
} from "@/lib/fhirContract";
import {
  requireIntegrationKey,
  type IntegrationCaller,
  type IntegrationScope,
} from "@/lib/integrationAuth";
import { logError } from "@/lib/serverLog";

const FHIR_JSON = "application/fhir+json; charset=utf-8";

/** Заголовки відповіді. no-store: розклад і зайнятість змінюються щохвилини,
    закешована відповідь на боці RIS = запис поверх пацієнта. */
const headers = () => ({
  "content-type": FHIR_JSON,
  "cache-control": "no-store",
});

export function fhirJson(body: unknown, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), { status, headers: headers() });
}

export function fhirError(status: number, diagnostics: string): NextResponse {
  return fhirJson(operationOutcome(issueCodeForStatus(status), diagnostics), status);
}

export function fhirErrorWithCode(
  status: number,
  code: FhirIssueCode,
  diagnostics: string
): NextResponse {
  return fhirJson(operationOutcome(code, diagnostics), status);
}

type FhirGate =
  | { ok: true; caller: IntegrationCaller }
  | { ok: false; res: NextResponse };

/** Гейт фасаду: той самий Bearer-ключ і ті самі скоупи, що в REST v1
    (окремий `fhir:read` вимагав би перевипуску вже виданого партнеру ключа).
    Відмову гейта перекладаємо в OperationOutcome, зберігаючи статус і не
    додаючи подробиць, яких у гейта не було. */
export async function requireFhirKey(
  req: Request,
  scope: IntegrationScope
): Promise<FhirGate> {
  const gate = await requireIntegrationKey(req, scope);
  if (!gate.ok) {
    const status = gate.res.status;
    let diagnostics = "Запит відхилено";
    try {
      const body = (await gate.res.clone().json()) as { error?: unknown };
      if (typeof body?.error === "string") diagnostics = body.error;
    } catch {
      // тіло не JSON — лишаємо загальний текст, статус важливіший за деталі
    }
    return { ok: false, res: fhirError(status, diagnostics) };
  }

  const warn = fhirExportModeWarning(gate.caller.exportMode);
  if (warn) {
    // Не 500 і не мовчання: режим B у БД без підтримки в коді мусить лишити
    // слід, інакше «увімкнули B» проявиться лише як здивування партнера.
    logError({ event: "fhir.export_mode", errorCode: "mode_b_unsupported", message: warn });
  }
  return { ok: true, caller: gate.caller };
}

/** Абсолютна база фасаду з запиту: `https://host`. Потрібна для fullUrl у
    Bundle, system-ів CodeSystem/NamingSystem і link.next — усі вони мусять
    бути абсолютними за R4. Беремо з URL запиту, а не з env: домен Vercel і
    майбутній власний домен клініки не мають розʼїхатись з конфігом. */
export function baseUrlFrom(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

/** Абсолютний URL поточного запиту — для link[relation=self]. */
export function selfUrlFrom(req: Request): string {
  return new URL(req.url).toString();
}
