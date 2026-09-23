/* ===== Мінімальний писач .xlsx (OOXML) на jszip — без нової залежності (с77) =====

   Навіщо свій: рішення власника 23.09 — «xlsx на jszip». `jszip` уже в
   залежностях (lib/docxText.ts), а бібліотека-таблиця (exceljs/sheetjs) — це
   новий пакет у публічному репозиторії з окремим аудитом. Нам потрібна рівно
   одна операція: записати ТАБЛИЦЮ рядків. Формул, злиття, діаграм — немає.

   Що гарантує файл:
     • кожен рядок — inline string (`t="inlineStr"`): текст НЕ стає формулою
       при відкритті, і `<f>` у файлі немає взагалі;
     • ФОРМУЛЬНА ІНʼЄКЦІЯ: значення, що починається з = + - @ таб/CR (і їхніх
       повноширинних двійників), отримує стиль `quotePrefix` — Excel лишає його
       текстом навіть ПІСЛЯ редагування клітинки (F2 → Enter), а не лише при
       відкритті. Реальний випадок — телефон «+380 67 …»: без префікса Excel
       сприйняв би його як початок формули;
     • символи, заборонені XML 1.0 (керівні, самотні сурогати), вирізаються —
       інакше Excel відмовляється відкривати файл «пошкодженим»;
     • текст клітинки обрізається до 32 767 символів (межа Excel);
     • дата — справжнє число-серійник зі стилем `dd.mm.yyyy`: сортування й
       фільтри Excel працюють по даті, а не по рядку. */

import JSZip from "jszip";

export type XlsxValue = string | number | { date: string } | null | undefined;
export type XlsxColumn = { header: string; width?: number };
export type XlsxSheet = {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxValue[][];
  /** Автофільтр на рядок заголовків (типово так). */
  autoFilter?: boolean;
  /** Закріпити рядок заголовків (типово так). */
  freezeHeader?: boolean;
};

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Стилі (індекси cellXfs у styles.xml). */
const S_HEADER = 1;
const S_TEXT_GUARDED = 2;
const S_DATE = 3;

export const XLSX_MAX_CELL_CHARS = 32767;

/** Значення, яке Excel прочитав би як формулу (або як її початок). */
export function isFormulaLike(s: string): boolean {
  return /^[=+\-@\t\r＝＋－＠]/.test(s);
}

/** Прибрати символи, недопустимі в XML 1.0, і самотні сурогати. */
export function xmlSafeText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Номер колонки (0-based) → літери Excel: 0 → A, 25 → Z, 26 → AA. */
export function colLetter(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** «YYYY-MM-DD» → серійний номер дати Excel (1900-система); битий ключ → null. */
export function excelSerialDate(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round((t - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Назва аркуша: без []:*?/\, не довша за 31, унікальна, не порожня. */
export function sanitizeSheetName(name: string, taken: Set<string>): string {
  let base = xmlSafeText(name).replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "");
  if (!base) base = "Аркуш";
  base = base.slice(0, 31);
  let out = base;
  for (let i = 2; taken.has(out.toLowerCase()); i++) {
    const suf = ` (${i})`;
    out = base.slice(0, 31 - suf.length) + suf;
  }
  taken.add(out.toLowerCase());
  return out;
}

function cellXml(ref: string, v: XlsxValue, header: boolean): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return `<c r="${ref}"><v>${v}</v></c>`;
  }
  if (typeof v === "object") {
    const serial = excelSerialDate(v.date);
    if (serial === null) return cellXml(ref, v.date, header); // битий ключ — хай буде текстом
    return `<c r="${ref}" s="${S_DATE}"><v>${serial}</v></c>`;
  }
  let s = xmlSafeText(String(v));
  if (s.length > XLSX_MAX_CELL_CHARS) s = s.slice(0, XLSX_MAX_CELL_CHARS);
  if (s === "") return "";
  const style = header ? S_HEADER : isFormulaLike(s) ? S_TEXT_GUARDED : 0;
  const sAttr = style ? ` s="${style}"` : "";
  return `<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
}

function sheetXml(sh: XlsxSheet): { xml: string; lastRef: string } {
  const ncol = Math.max(1, sh.columns.length);
  const nrow = sh.rows.length + 1;
  const lastRef = `${colLetter(ncol - 1)}${nrow}`;
  const parts: string[] = [];
  parts.push(XML_HEAD, `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`);
  parts.push(`<dimension ref="A1:${lastRef}"/>`);
  if (sh.freezeHeader !== false) {
    parts.push(
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
    );
  } else {
    parts.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
  }
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  parts.push("<cols>");
  sh.columns.forEach((c, i) => {
    const w = Math.min(100, Math.max(4, c.width ?? Math.max(10, c.header.length + 2)));
    parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`);
  });
  parts.push("</cols><sheetData>");
  parts.push('<row r="1">');
  sh.columns.forEach((c, i) => parts.push(cellXml(`${colLetter(i)}1`, c.header, true)));
  parts.push("</row>");
  sh.rows.forEach((row, ri) => {
    const r = ri + 2;
    parts.push(`<row r="${r}">`);
    for (let ci = 0; ci < ncol; ci++) parts.push(cellXml(`${colLetter(ci)}${r}`, row[ci], false));
    parts.push("</row>");
  });
  parts.push("</sheetData>");
  if (sh.autoFilter !== false && sh.columns.length) parts.push(`<autoFilter ref="A1:${lastRef}"/>`);
  parts.push("</worksheet>");
  return { xml: parts.join(""), lastRef };
}

const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${NS_MAIN}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** Ім'я аркуша у формулі визначеного імені: '…' з подвоєнням апострофа. */
const quoteSheet = (n: string) => `'${n.replace(/'/g, "''")}'`;

/** Абсолютне посилання «A1:L10» → «$A$1:$L$10». */
const absRef = (ref: string) => ref.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2");

/**
 * Збирає книгу. Порядок аркушів = порядок у масиві. Повертає байти .xlsx.
 * `created` — лише для властивостей документа (docProps/core.xml).
 */
export async function buildXlsx(sheets: XlsxSheet[], meta: { title?: string; created?: Date } = {}): Promise<Uint8Array> {
  if (!sheets.length) throw new Error("buildXlsx: потрібен хоча б один аркуш");
  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sanitizeSheetName(s.name, taken) }));
  const zip = new JSZip();
  const created = (meta.created ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");

  zip.file(
    "[Content_Types].xml",
    XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      named
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      "</Types>"
  );
  zip.file(
    "_rels/.rels",
    XML_HEAD +
      `<Relationships xmlns="${NS_PKG_REL}">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      "</Relationships>"
  );
  zip.file(
    "docProps/core.xml",
    XML_HEAD +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${esc(xmlSafeText(meta.title ?? "RadFlow"))}</dc:title><dc:creator>RadFlow</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
      "</cp:coreProperties>"
  );
  zip.file(
    "docProps/app.xml",
    XML_HEAD +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>RadFlow</Application></Properties>'
  );

  const defined: string[] = [];
  named.forEach((sh, i) => {
    const { xml, lastRef } = sheetXml(sh);
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, xml);
    if (sh.autoFilter !== false && sh.columns.length) {
      defined.push(
        `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(quoteSheet(sh.name))}!${absRef(`A1:${lastRef}`)}</definedName>`
      );
    }
  });
  zip.file(
    "xl/workbook.xml",
    XML_HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000"/></bookViews>' +
      "<sheets>" +
      named.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets>" +
      (defined.length ? `<definedNames>${defined.join("")}</definedNames>` : "") +
      "</workbook>"
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    XML_HEAD +
      `<Relationships xmlns="${NS_PKG_REL}">` +
      named
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("") +
      `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>"
  );
  zip.file("xl/styles.xml", STYLES_XML);

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
