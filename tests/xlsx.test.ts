/* ===== lib/xlsx.ts — мінімальний писач .xlsx (с77) =====
   Перевіряємо ФАЙЛ, а не код: розпаковуємо згенерований zip тим самим jszip і
   читаємо XML частин. Головні властивості — формульна інʼєкція неможлива ні
   при відкритті, ні після редагування клітинки; XML завжди валідний. */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  buildXlsx,
  colLetter,
  excelSerialDate,
  isFormulaLike,
  sanitizeSheetName,
  xmlSafeText,
  XLSX_MAX_CELL_CHARS,
} from "@/lib/xlsx";

async function unzip(bytes: Uint8Array) {
  const z = await JSZip.loadAsync(bytes);
  const read = async (p: string) => {
    const f = z.file(p);
    if (!f) throw new Error(`у файлі немає частини ${p}`);
    return f.async("string");
  };
  return { z, read };
}

describe("xlsx — дрібні примітиви", () => {
  it("літери колонок: A, Z, AA, AZ, BA", () => {
    expect([0, 25, 26, 51, 52].map(colLetter)).toEqual(["A", "Z", "AA", "AZ", "BA"]);
  });
  it("серійний номер дати Excel (1900-система) і відмова на битих ключах", () => {
    expect(excelSerialDate("1900-03-01")).toBe(61);
    expect(excelSerialDate("2026-09-23")).toBe(46288);
    expect(excelSerialDate("2026-02-30")).toBeNull();
    expect(excelSerialDate("23.09.2026")).toBeNull();
  });
  it("формулоподібні значення — усі префікси, включно з повноширинними", () => {
    for (const s of ["=1+1", "+380 67 123 45 67", "-2", "@SUM(A1)", "\tx", "\rx", "\uFF1D1", "\uFF0B1", "\uFF0D1", "\uFF20x"]) {
      expect(isFormulaLike(s), JSON.stringify(s)).toBe(true);
    }
    for (const s of ["Іваненко", "1=1", " =1", "МРТ + КТ"]) expect(isFormulaLike(s), s).toBe(false);
  });
  it("символи, заборонені XML 1.0, і самотні сурогати вирізаються; емодзі лишається", () => {
    expect(xmlSafeText("a\u0000b\u0007c\u001Fd")).toBe("abcd");
    expect(xmlSafeText("x\uD800y")).toBe("xy");
    expect(xmlSafeText("x\uDC00y")).toBe("xy");
    expect(xmlSafeText("ок 🙂")).toBe("ок 🙂");
    expect(xmlSafeText("таб\tрядок\ncr\r")).toBe("таб\tрядок\ncr\r");
  });
  it("назва аркуша: заборонені символи, довжина 31, унікальність", () => {
    const taken = new Set<string>();
    expect(sanitizeSheetName("Черга: [МРТ]/КТ?", taken)).toBe("Черга МРТ КТ");
    const long = "Дуже довга назва аркуша, що перевищує межу";
    const a = sanitizeSheetName(long, taken);
    const b = sanitizeSheetName(long, taken);
    expect(a.length).toBeLessThanOrEqual(31);
    expect(b.length).toBeLessThanOrEqual(31);
    expect(a).not.toBe(b);
    expect(sanitizeSheetName("   ", taken)).toBe("Аркуш");
  });
});

describe("xlsx — зібраний файл", () => {
  it("має всі обовʼязкові частини OOXML і звʼязки на них", async () => {
    const bytes = await buildXlsx([{ name: "Пошук", columns: [{ header: "A" }], rows: [["x"]] }]);
    const { z, read } = await unzip(bytes);
    for (const p of [
      "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml", "xl/styles.xml", "docProps/core.xml", "docProps/app.xml",
    ]) expect(z.file(p), p).not.toBeNull();
    expect(await read("[Content_Types].xml")).toContain('PartName="/xl/worksheets/sheet1.xml"');
    expect(await read("xl/_rels/workbook.xml.rels")).toContain('Target="worksheets/sheet1.xml"');
    expect(await read("xl/workbook.xml")).toContain('<sheet name="Пошук" sheetId="1" r:id="rId1"/>');
  });

  it("текст — inline string; формул у файлі немає взагалі", async () => {
    const bytes = await buildXlsx([
      { name: "S", columns: [{ header: "Пацієнт" }, { header: "Телефон" }], rows: [["=HYPERLINK(\"http://x\")", "+380 67 123 45 67"]] },
    ]);
    const sheet = await (await unzip(bytes)).read("xl/worksheets/sheet1.xml");
    expect(sheet).not.toMatch(/<f[ >]/);
    expect(sheet).toContain('t="inlineStr"');
  });

  it("формулоподібні значення отримують quotePrefix-стиль, звичайні — ні", async () => {
    const bytes = await buildXlsx([
      { name: "S", columns: [{ header: "a" }, { header: "b" }, { header: "c" }], rows: [["=1+1", "Іваненко", "@x"]] },
    ]);
    const { read } = await unzip(bytes);
    const sheet = await read("xl/worksheets/sheet1.xml");
    const styles = await read("xl/styles.xml");
    // стиль 2 — саме той, що з quotePrefix
    const xfs = [...styles.matchAll(/<xf [^>]*\/>/g)].map((m) => m[0]);
    const cellXfs = xfs.slice(1); // перший — cellStyleXfs
    expect(cellXfs[2]).toContain('quotePrefix="1"');
    expect(sheet).toMatch(/<c r="A2" t="inlineStr" s="2">/);
    expect(sheet).toMatch(/<c r="B2" t="inlineStr">/);
    expect(sheet).toMatch(/<c r="C2" t="inlineStr" s="2">/);
  });

  it("XML-спецсимволи екрануються, текст не ламає розмітку", async () => {
    const bytes = await buildXlsx([{ name: "S", columns: [{ header: "a" }], rows: [["<b>&\"x\"</b>"]] }]);
    const sheet = await (await unzip(bytes)).read("xl/worksheets/sheet1.xml");
    expect(sheet).toContain("&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
    expect(sheet).not.toContain("<b>&");
  });

  it("дата — число-серійник зі стилем дати; число — число; null — порожня клітинка", async () => {
    const bytes = await buildXlsx([
      { name: "S", columns: [{ header: "d" }, { header: "n" }, { header: "e" }], rows: [[{ date: "2026-09-23" }, 42, null]] },
    ]);
    const sheet = await (await unzip(bytes)).read("xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<c r="A2" s="3"><v>46288</v></c>');
    expect(sheet).toContain('<c r="B2"><v>42</v></c>');
    expect(sheet).not.toContain('r="C2"');
  });

  it("задовгий текст обрізається до межі Excel", async () => {
    const bytes = await buildXlsx([{ name: "S", columns: [{ header: "a" }], rows: [["я".repeat(XLSX_MAX_CELL_CHARS + 10)]] }]);
    const sheet = await (await unzip(bytes)).read("xl/worksheets/sheet1.xml");
    const m = /<t xml:space="preserve">(я+)<\/t>/.exec(sheet);
    expect(m?.[1].length).toBe(XLSX_MAX_CELL_CHARS);
  });

  it("заголовок закріплено, автофільтр і визначене імʼя фільтра покривають усю таблицю", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => [`r${i}`, i]);
    const bytes = await buildXlsx([{ name: "Пошук'ок", columns: [{ header: "a" }, { header: "b" }], rows }]);
    const { read } = await unzip(bytes);
    const sheet = await read("xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<dimension ref="A1:B4"/>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:B4"/>');
    // порядок елементів CT_Worksheet: sheetData раніше за autoFilter
    expect(sheet.indexOf("</sheetData>")).toBeLessThan(sheet.indexOf("<autoFilter"));
    const wb = await read("xl/workbook.xml");
    // імʼя аркуша з апострофом у формулі — у лапках і з подвоєнням
    expect(wb).toContain("'Пошук''ок'!$A$1:$B$4");
  });

  it("аркуш без колонок — без порожнього <cols> (схема його забороняє)", async () => {
    const bytes = await buildXlsx([{ name: "S", columns: [], rows: [] }]);
    const sheet = await (await unzip(bytes)).read("xl/worksheets/sheet1.xml");
    expect(sheet).not.toContain("<cols>");
  });

  it("кілька аркушів — кожен зі своєю частиною і звʼязком", async () => {
    const bytes = await buildXlsx([
      { name: "Дані", columns: [{ header: "a" }], rows: [] },
      { name: "Параметри", columns: [{ header: "k" }, { header: "v" }], rows: [["x", "y"]], autoFilter: false, freezeHeader: false },
    ]);
    const { z, read } = await unzip(bytes);
    expect(z.file("xl/worksheets/sheet2.xml")).not.toBeNull();
    const rels = await read("xl/_rels/workbook.xml.rels");
    expect(rels).toContain('Id="rId2"');
    expect(rels).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"');
    const s2 = await read("xl/worksheets/sheet2.xml");
    expect(s2).not.toContain("<autoFilter");
    expect(s2).not.toContain('state="frozen"');
  });
});
