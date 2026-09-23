/* ===== Експорт результатів пошуку в Excel — чиста частина (с77) =====

   Задача власника 22.09: «у пошуку — експорт даних (звіту) в xls», для всіх
   ролей. Рішення 23.09: справжній .xlsx (lib/xlsx.ts, без нової залежності),
   ВЕСЬ результат за фільтрами зі стелею рядків.

   ⚠️ ЦЕ НОВИЙ КАНАЛ ПІБ І ТЕЛЕФОНІВ, а не кнопка. Тому колонки файлу рахуються
      з ТІЄЇ САМОЇ області ролі, що й екран:
        • CEO — БЕЗ колонки «Телефон» (showPhone=false стоїть свідомо з с22);
          колонка не порожня, а ВІДСУТНЯ: порожня колонка брехала б «номера немає»;
        • направник — без колонки «Направник» (він бачить лише власні записи);
        • радіолог — лише черга і лише призначені кабінети (це тримає рушій).
      Сам факт вивантаження пише роут у журнал (`patient_data.exported`). */

import type { XlsxColumn, XlsxSheet, XlsxValue } from "@/lib/xlsx";
import type { NormalizedSearchFilters, SearchResultItem, SearchSource } from "@/lib/searchContract";
import {
  SEARCH_PRIORITY_LABEL,
  SEARCH_QUEUE_STATUS_LABEL,
  SEARCH_SOURCE_LABEL,
  SEARCH_WAITLIST_STATUS_LABEL,
} from "@/lib/searchLabels";
import { modalityLabel } from "@/lib/studies";
import { pluralZapys } from "@/lib/rooms";
import { studiesLine } from "@/lib/searchLabels";

export { studiesLine };

/** Стеля рядків одного файлу. Більше — звузити фільтри (аркуш «Параметри» каже про це). */
export const EXPORT_MAX_ROWS = 5000;

export type ExportScope = { showPhone: boolean; referrerVisible: boolean };

export type ExportLookup = {
  clinicName: (id: string) => string;
  roomName: (id: string | null) => string;
};

type Col = XlsxColumn & { get: (it: SearchResultItem, lk: ExportLookup) => XlsxValue };

/** Колонки файлу для джерела й області ролі. */
export function exportColumnSpec(source: SearchSource, scope: ExportScope): Col[] {
  const st = source === "queue" ? SEARCH_QUEUE_STATUS_LABEL : SEARCH_WAITLIST_STATUS_LABEL;
  const cols: Col[] = [];
  cols.push({ header: source === "queue" ? "Дата" : "Дата додавання", width: 12, get: (it) => (it.date ? { date: it.date } : null) });
  if (source === "queue") cols.push({ header: "Час", width: 7, get: (it) => it.time || null });
  cols.push({ header: "Пацієнт", width: 30, get: (it) => it.patientName });
  if (scope.showPhone) cols.push({ header: "Телефон", width: 18, get: (it) => it.patientPhone || null });
  cols.push({ header: "Дослідження", width: 44, get: (it) => studiesLine(it.studies) || null });
  cols.push({ header: "Центр", width: 22, get: (it, lk) => lk.clinicName(it.clinicId) || null });
  cols.push({ header: "Кабінет", width: 18, get: (it, lk) => lk.roomName(it.roomId) || null });
  cols.push({ header: "Статус", width: 16, get: (it) => st[it.status] || it.status });
  cols.push({ header: "Пріоритет", width: 11, get: (it) => SEARCH_PRIORITY_LABEL[it.priority] || it.priority });
  if (scope.referrerVisible) cols.push({ header: "Направник", width: 28, get: (it) => it.referrerName || null });
  if (source === "queue") cols.push({ header: "Кейс", width: 7, get: (it) => (it.caseId ? "так" : null) });
  cols.push({ header: "ID запису", width: 38, get: (it) => it.recordId });
  return cols;
}

const fmtKey = (k: string) => {
  const [y, m, d] = k.split("-");
  return `${d}.${m}.${y}`;
};

/** Чому файл неповний: `cap` — доведено, що збігів більше за стелю; `time` —
 *  не встигли переглянути все; `cursor` — деградований курсор міг пропустити
 *  рядки (кривий час прийому). null — файл повний. */
export type ExportIncomplete = "cap" | "time" | "cursor" | null;

export type ExportParams = {
  f: NormalizedSearchFilters;
  scope: ExportScope;
  rows: number;
  incomplete: ExportIncomplete;
  /** Сформовано — вже відформатований рядок у зоні центру. */
  generatedAt: string;
  /** Підпис фільтра «Направник» (імʼя або «без направника»), якщо він був. */
  referrerLabel: string | null;
  lookup: ExportLookup;
};

/** Аркуш «Параметри»: що саме у файлі і чи все. */
export function exportParamsRows(p: ExportParams): XlsxValue[][] {
  const { f } = p;
  const st = f.source === "queue" ? SEARCH_QUEUE_STATUS_LABEL : SEARCH_WAITLIST_STATUS_LABEL;
  const rows: XlsxValue[][] = [];
  rows.push(["Сформовано", p.generatedAt]);
  rows.push(["Джерело", SEARCH_SOURCE_LABEL[f.source]]);
  rows.push(["Період", `${fmtKey(f.dateFrom)} – ${fmtKey(f.dateTo)}`]);
  if (f.term) rows.push(["Пошуковий запит", f.term]);
  rows.push(["Центр", f.clinicIds.map((id) => p.lookup.clinicName(id) || "—").join(", ")]);
  if (f.roomIds && f.roomIds.length) rows.push(["Кабінет", f.roomIds.map((id) => p.lookup.roomName(id) || "—").join(", ")]);
  const statuses = f.source === "queue" ? f.queueStatuses : f.waitlistStatuses;
  if (statuses) rows.push(["Статус", statuses.map((s) => st[s] || s).join(", ")]);
  if (f.modalities) rows.push(["Модальність", f.modalities.map((m) => modalityLabel(m)).join(", ")]);
  if (f.contrast !== null) rows.push(["Контраст", f.contrast ? "з контрастом" : "без контрасту"]);
  if (f.priorities) rows.push(["Пріоритет", f.priorities.map((x) => SEARCH_PRIORITY_LABEL[x] || x).join(", ")]);
  if (p.referrerLabel) rows.push(["Направник", p.referrerLabel]);
  rows.push(["Порядок", f.sort === "date_asc" ? "спочатку старіші" : "спочатку новіші"]);
  rows.push(["Записів у файлі", p.rows]);
  rows.push(["Повнота", completenessText(p.incomplete, p.rows)]);
  if (!p.scope.showPhone) rows.push(["Телефони", "не вивантажуються для цієї ролі"]);
  return rows;
}

/** Повнота файлу словами — і на аркуші «Параметри», і в повідомленні на екрані. */
export function completenessText(incomplete: ExportIncomplete, rows: number): string {
  const n = `${rows} ${pluralZapys(rows)}`;
  if (incomplete === "cap") return `НЕ ВСЕ: у файлі перші ${n}, а збігів більше — звузьте період або фільтри й вивантажте частинами`;
  if (incomplete === "time") return `НЕ ВСЕ: за відведений час переглянуто не всі записи (у файлі ${n}) — звузьте період або фільтри`;
  if (incomplete === "cursor") return `МОЖЛИВО НЕ ВСЕ: у частини записів некоректний час прийому, і через це записи тих самих дат могли не потрапити у файл (${n}) — вивантажте вужчий період`;
  return "усі записи, що відповідають фільтрам";
}

/** Книга експорту: «Дані» + «Параметри». */
export function buildSearchExportSheets(items: SearchResultItem[], params: ExportParams): XlsxSheet[] {
  const spec = exportColumnSpec(params.f.source, params.scope);
  const data: XlsxSheet = {
    name: params.f.source === "queue" ? "Черга" : "Лист очікування",
    columns: spec.map(({ header, width }) => ({ header, width })),
    rows: items.map((it) => spec.map((c) => c.get(it, params.lookup))),
  };
  const meta: XlsxSheet = {
    name: "Параметри",
    columns: [{ header: "Параметр", width: 22 }, { header: "Значення", width: 70 }],
    rows: exportParamsRows(params),
    autoFilter: false,
    freezeHeader: false,
  };
  return [data, meta];
}

/** Імʼя файлу — лише ASCII (заголовок Content-Disposition), дата — день центру. */
export function exportFileName(source: SearchSource, todayKey: string): string {
  return `radflow-${source === "queue" ? "queue" : "waitlist"}-${todayKey}.xlsx`;
}
