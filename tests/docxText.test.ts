import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { docxToText } from "@/lib/docxText";

/* docx = zip із word/document.xml — збираємо мінімальний файл прямо в тесті. */
async function makeDocx(documentXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("docxToText (фаза 3b: docx → плоский текст для AI-гілки)", () => {
  it("абзаци → рядки; клітинки таблиці → таби (рядок прайса лишається рядком)", async () => {
    const xml = `<?xml version="1.0"?><w:document><w:body>
      <w:p><w:r><w:t>Прайс-лист</w:t></w:r></w:p>
      <w:tbl><w:tr>
        <w:tc><w:p><w:r><w:t>МРТ головного мозку</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>3200</w:t></w:r></w:p></w:tc>
      </w:tr><w:tr>
        <w:tc><w:p><w:r><w:t>УЗД нирок</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>700</w:t></w:r></w:p></w:tc>
      </w:tr></w:tbl>
    </w:body></w:document>`;
    const text = await docxToText(await makeDocx(xml));
    expect(text).toBeTruthy();
    const lines = (text as string).split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe("Прайс-лист");
    expect(lines.some((l) => /МРТ головного мозку\t3200/.test(l))).toBe(true);
    expect(lines.some((l) => /УЗД нирок\t700/.test(l))).toBe(true);
  });
  it("XML-ентіті декодуються, теги не течуть у текст", async () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>КТ &amp; МРТ &lt;зі знижкою&gt;</w:t></w:r></w:p></w:body></w:document>`;
    const text = await docxToText(await makeDocx(xml));
    expect(text).toBe("КТ & МРТ <зі знижкою>");
  });
  it("не zip / без document.xml → null (роут відповість чистою помилкою)", async () => {
    expect(await docxToText(Buffer.from("не docx"))).toBeNull();
    const empty = new JSZip();
    empty.file("інше.txt", "x");
    expect(await docxToText(await empty.generateAsync({ type: "nodebuffer" }))).toBeNull();
  });
});

describe("docxToText — zip-бомба (ревʼю 3b M2)", () => {
  it("роздутий document.xml → null ДО regex-чистки", async () => {
    // 30 МБ XML із ~нульовою ентропією — стискається в дрібний zip, як бомба.
    const zip = new JSZip();
    const huge = "<w:p><w:r><w:t>А</w:t></w:r></w:p>".repeat(1_000_000); // ~33 МБ
    zip.file("word/document.xml", huge);
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(buf.length).toBeLessThan(1024 * 1024); // сам файл маленький — пройшов би 4 МБ-ліміт
    expect(await docxToText(buf)).toBeNull();
  });
});
