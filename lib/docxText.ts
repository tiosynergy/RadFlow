/* ===== RadFlow — витяг тексту з docx (Stage 2, фаза 3b) =====
   docx = zip із word/document.xml. Для AI-гілки імпорту прайса потрібен лише
   ПЛОСКИЙ ТЕКСТ (таблиця послуг) — без стилів/картинок, тому повний конвертер
   (mammoth тощо) не потрібен: розпаковка jszip + зрізання XML-тегів.

   Чому на боці RadFlow, а не в n8n: Extract From File у n8n docx НЕ вміє
   (xlsx/csv/pdf/html/rtf/text — так), а Code-нода n8n Cloud без zip-бібліотек.
   Тому docx → текст тут, у n8n їде kind='text' (той самий AI-шлях, що pdf/url).

   Таблиці: </w:tc> (кінець клітинки) → таб, </w:p> і </w:tr> → новий рядок —
   рядок прайса лишається одним рядком тексту «Назва <TAB> 3200 <TAB> 30». */

import JSZip from "jszip";

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'",
};

/** M2 (ревʼю 3b): zip-бомба — 4 МБ deflate розгортається в сотні МБ XML і кладе
    serverless-функцію по памʼяті ЩЕ ДО regex-чистки. Реальні прайси — XML < 1 МБ. */
export const DOCX_XML_MAX_BYTES = 20 * 1024 * 1024;

/** Текст docx-файла або null (не zip / без document.xml / завеликий XML / збій). */
export async function docxToText(buf: Buffer | Uint8Array): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const doc = zip.file("word/document.xml");
    if (!doc) return null;
    // Стеля НЕРОЗПАКОВАНОГО розміру до матеріалізації рядка (zip-бомба, M2).
    // uncompressedSize — внутрішнє поле jszip; якщо його немає (зміна версії) —
    // другий рубіж нижче по довжині рядка (regex-цепочку теж не запускаємо).
    const metaSize = (doc as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof metaSize === "number" && metaSize > DOCX_XML_MAX_BYTES) return null;
    const xml = await doc.async("string");
    if (xml.length > DOCX_XML_MAX_BYTES) return null;
    const text = xml
      // Пробіли/переноси МІЖ тегами — форматування XML, не текст документа
      // (справжній текст живе всередині <w:t>…</w:t> і сюди не потрапляє).
      .replace(/>\s+</g, "><")
      // <w:t> несе текст; решта тегів — розмітка. Порядок замін важливий:
      // спершу структурні маркери → розділювачі, потім зрізаємо всі теги.
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      // Абзац, що ЗАКРИВАЄ клітинку, не має ламати рядок таблиці — тому
      // спершу згортаємо </w:p></w:tc> у таб, і лише потім самотні </w:p>.
      .replace(/<\/w:p>\s*<\/w:tc>/g, "\t")
      .replace(/<\/w:tc>/g, "\t")     // кінець клітинки таблиці → колонка
      .replace(/<\/w:tr>/g, "\n")     // кінець рядка таблиці → рядок
      .replace(/<\/w:p>/g, "\n")      // кінець абзацу → рядок
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;|&lt;|&gt;|&quot;|&apos;|&#39;/g, (m) => XML_ENTITIES[m] ?? m)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}
