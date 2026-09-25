/* ===== CSV колл-листа — спільне для дошки й роуту (с80, Н-16) =====

   До с80 файл збирав БРАУЗЕР: ПІБ, телефон і нотатка дзвінка за день ішли в
   CSV без жодного сліду в журналі і без захисту від формульної інʼєкції —
   нотатка «=HYPERLINK(…)» ставала клікабельним посиланням в Excel. Той самий
   клас, що Н-10 (CSV дашборда CEO), і лікування те саме: файл збирає сервер
   (POST /api/call-list/export), спільним писачем lib/csv.ts, і пише подію
   `patient_data.exported`.

   Тут — лише ЧИСТІ функції, без серверних імпортів: ними користується і роут
   (що піде у файл), і дошка CallListBoard (що видно на екрані). Підпис статусу
   дзвінка й назва процедури у файлі — ті самі рядки, що бачить оператор, за
   побудовою, а не за збігом двох копій. */

import { isContrastName } from "@/lib/studies";
import type { FileExportRequest } from "@/lib/fileExportClient";

/** Підписи статусу дзвінка — одне джерело для бейджа дошки й колонки «Статус». */
export const CALL_STATUS_LABELS = {
  not_called: "Ще не дзвонили",
  confirmed: "Підтверджено",
  no_answer: "Не відповідає",
  to_recall: "Передзвонити",
  declined: "Відмова",
} as const;
export type CallStatusKey = keyof typeof CALL_STATUS_LABELS;

/** Порожній / невідомий статус — «Ще не дзвонили», як і на дошці (`call_status || "not_called"`). */
export function callStatusLabel(s: string | null | undefined): string {
  const k = (s || "not_called") as CallStatusKey;
  return CALL_STATUS_LABELS[k] ?? CALL_STATUS_LABELS.not_called;
}

/** Назва процедури рядка обдзвону — дослівно та, що була в CallListBoard до с80. */
export function callListProcLabel(e: { studies?: unknown; note?: string | null }): string {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast && !isContrastName(x.region) ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

/** Статуси, які показує колл-лист, — ті самі, що в `reload` дошки. */
export const CALL_LIST_STATUSES = ["scheduled", "waiting"] as const;

/** Колонки запису для файлу. `clinic_id` — для події журналу (центр — із РЯДКА БД,
    урок с25), `id` — ключ сторінок і дедупу.
    ⚠️ `note` тут НЕМАЄ свідомо (ревʼю с80, L-2): дошка його не вибирає (TD-5), тож
    у записі без досліджень на екрані «—», і файл мусить казати те саме, а не
    вільний текст бронювання («скерування, особливі вимоги…» — ПДн). Колонки
    файлу ⊆ колонок `reload` дошки — пін у tests/callListExport.test.ts. */
export const CALL_LIST_ENTRY_COLS =
  "id, clinic_id, scheduled_date, scheduled_time, patient_name, patient_phone, studies, room_id, call_status, call_note";

export type CallListExportEntry = {
  id: string;
  clinic_id: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  patient_name: string | null;
  patient_phone: string | null;
  studies: unknown;
  room_id: string | null;
  call_status: string | null;
  call_note: string | null;
};

/** Заголовок CSV. Колонки й порядок — як були до переїзду на сервер. Дата —
    КОЛОНКОЮ, а не лише в імені файлу: помилку дня видно в самому файлі. */
export const CALL_LIST_EXPORT_HEAD = ["Дата", "Час", "Пацієнт", "Телефон", "Процедура", "Кабінет", "Статус", "Нотатка"] as const;

/** Порядок рядків — за часом, як на дошці (`order("scheduled_time")`: NULL —
    у кінці), рівні часи — за id, щоб файл був детермінованим. */
export function compareCallListOrder(a: CallListExportEntry, b: CallListExportEntry): number {
  const ta = a.scheduled_time, tb = b.scheduled_time;
  if (ta !== tb) {
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta < tb ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Рядки файлу. Екранування формул і переводів рядка — НЕ тут, а в писачі
    lib/csv.ts (buildCsv): одне місце для всіх CSV проєкту. */
export function callListExportRows(
  entries: ReadonlyArray<CallListExportEntry>,
  roomName: (id: string) => string
): string[][] {
  return entries.map((e) => [
    e.scheduled_date || "",
    e.scheduled_time || "",
    e.patient_name || "",
    e.patient_phone || "",
    // Лише склад — без `note` (див. CALL_LIST_ENTRY_COLS): як на дошці.
    callListProcLabel({ studies: e.studies }),
    e.room_id ? roomName(e.room_id) : "",
    callStatusLabel(e.call_status),
    e.call_note || "",
  ]);
}

/** Імʼя файлу — лише ASCII (заголовок Content-Disposition), як і до с80. */
export function callListExportFileName(dayKey: string): string {
  return "call-list-" + dayKey + ".csv";
}

/** Тост успіху: порожній день — чесно «лише заголовок» (ревʼю с80: файл з
    однією шапкою раніше звався «експортовано»). Число — із заголовка роуту
    `X-Export-Rows`; нема заголовка — звичайний текст. */
export function callListExportSuccessText(rowsHeader: string | null): string {
  if (rowsHeader === "0") return "У цей день обдзвонювати нікого — у файлі лише заголовок";
  return "Колл-лист експортовано у CSV";
}

/** Загальна фраза збою: деталі — у лозі сервера, не в тості. */
export const CALL_LIST_EXPORT_ERR = "Не вдалося експортувати колл-лист — спробуйте ще раз";

/** Увесь запит експорту дня — ОДНИМ обʼєктом (ревʼю с80 р2, L-2): що саме
    компонент передає в `runFileExport` (адреса, тіло, імʼя файлу, тексти
    відмови/збою/успіху), перевіряється в node, а не регуляркою по TSX. */
export function callListExportRequest(day: string): FileExportRequest {
  return {
    url: "/api/call-list/export",
    body: { date: day },
    fileName: callListExportFileName(day),
    errorText: callListExportErrorText,
    failText: CALL_LIST_EXPORT_ERR,
    successText: (res) => callListExportSuccessText(res.headers.get("X-Export-Rows")),
    successKind: "info",
  };
}

/** Текст відмови для тосту. 401 — сесія скінчилась (повтор не допоможе, ревʼю с80
    L-2); 429 — гальмо ліміту; 403 і 400 — безпечна фраза самого роуту (лише
    загальні слова, без внутрощів — правило L-4 с79); решта — «спробуйте ще раз». */
export function callListExportErrorText(status: number, body: unknown): string {
  if (status === 401) return "Сесія завершилась — увійдіть знову";
  if (status === 429) return "Забагато вивантажень за короткий час — спробуйте за кілька хвилин";
  if (status === 403 || status === 400) {
    const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    if (typeof e === "string" && e.trim() !== "" && e.length <= 160) return e;
    return status === 403 ? "Недостатньо прав для експорту" : CALL_LIST_EXPORT_ERR;
  }
  return CALL_LIST_EXPORT_ERR;
}
