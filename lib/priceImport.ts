/* ===== RadFlow — детермінована нормалізація імпорту прайса (Stage 2, фаза 3a) =====
   n8n-workflow «radflow-price-import» ПАРСИТЬ файл (xlsx/csv → сирі рядки
   «заголовок → значення»), а ВСЯ бізнес-нормалізація живе тут, у TS:
   евристика колонок, визначення модальності за ключовими словами, чистка цін
   («3 200 грн» → 3200) і тривалостей (normDur), confidence, класифікація проти
   каталогу центру (нові / зміна ціни / нерозпізнані).

   Чому нормалізація НЕ в n8n Code-ноді (відступ від docs/plan/SERVICES_CATALOG.md
   §5.2): правила імпорту мають бути ЄДИНИМ джерелом істини поруч із резолвером
   lib/catalog.ts і покриватися vitest. n8n лишається транспортом і парсером
   бінарника (Extract From File) — детерміновано, без AI (AI-гілка — фаза 3b).

   PII тут немає — тільки позиції прайса. */

import { BOOKABLE_MODALITIES, DUR_MAX, DUR_MIN, modalityCode, normDur, type ModalityCode } from "@/lib/studies";

/** Рядок, який повертає розбір файла (контракт docs/plan/SERVICES_CATALOG.md §5.1). */
export interface ImportRow {
  name: string;
  /** null = не визначили — адмін обере в передперегляді. */
  modality: ModalityCode | null;
  price: number;                 // грн, int ≥0
  durationMin: number | null;    // null = у прайсі часу не було (НЕ перезаписуємо)
  confidence: number;            // 0..1 (детермінована гілка: 1 / 0.5)
}

/** Результат розбору сирих рядків: позиції + що відкинули (для діагностики UI). */
export interface ParseResult {
  rows: ImportRow[];
  skipped: number;               // рядків без назви/ціни/у межах або дублів
  columns: DetectedColumns;      // що саме прийняли за колонки (показуємо адміну)
  truncated: boolean;            // уперлись у IMPORT_ROWS_MAX — частину файла НЕ розібрано
}

export interface DetectedColumns {
  name: string | null;
  price: string | null;
  duration: string | null;
  modality: string | null;
}

/* ---------------- Евристика заголовків ---------------- */

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

/* Порядок патернів = пріоритет. Українська + російська + англійська.
   ⚠️ Межі «слова» — [^а-яіїєґёa-z]: без укр. літер «і/ї/є/ґ» межа спрацьовувала
   б усередині слова («конфлікт» → «кт», ревью L5). */
const NAME_RE = /назв|послуг|наймен|дослідж|процедур|услуг|наимен|исследован|name|service/;
const PRICE_RE = /цін|ціна|варт|грн|uah|цена|стоим|price|cost/;
const DUR_RE = /трив|хвил|(^|[^а-яіїєґёa-z])хв|мин\.?|минут|длит|duration|min/;
const MOD_RE = /модальн|вид дослідж|тип дослідж|modality/;

export function detectColumns(headers: string[]): DetectedColumns {
  const out: DetectedColumns = { name: null, price: null, duration: null, modality: null };
  const claim = (key: keyof DetectedColumns, h: string) => { if (out[key] == null) out[key] = h; };
  for (const h of headers) {
    const t = lc(h);
    if (!t) continue;
    // Порядок перевірок важливий: «тривалість, хв» не має стати ціною, а
    // «вид дослідження» — назвою.
    if (MOD_RE.test(t)) { claim("modality", h); continue; }
    if (DUR_RE.test(t)) { claim("duration", h); continue; }
    if (PRICE_RE.test(t)) { claim("price", h); continue; }
    if (NAME_RE.test(t)) { claim("name", h); continue; }
  }
  return out;
}

/* ---------------- Модальність за ключовими словами ---------------- */

/* Слова-маркери в назві послуги або значенні колонки «модальність».
   Порядок = пріоритет (мскт → КТ раніше, ніж «т» щось зачепить). */
const MOD_KEYWORDS: Array<[RegExp, ModalityCode]> = [
  [/мрт|магнітно|магнитно|mri|мр-|(^|\s)мр(\s|$)/, "MRI"],
  [/мскт|(^|[^а-яіїєґёa-z])кт([^а-яіїєґёa-z]|$)|комп'ютерн|компьютерн|томограф/, "CT"],
  [/узд|узи|ультразв|сонограф|доплер|допплер|(^|[^а-яіїєґёa-z])us([^a-z]|$)/, "US"],
  [/рентген|ренген|флюорограф|(^|[^а-яіїєґёa-z])рг([^а-яіїєґёa-z]|$)|x-?ray/, "XRAY"],
  [/мамограф|маммограф|(^|[^а-яіїєґёa-z])ммг([^а-яіїєґёa-z]|$)|mammo/, "MAMMO"],
];

/** Визначити модальність із тексту (значення колонки або назва послуги). */
export function inferModality(text: unknown): ModalityCode | null {
  const t = lc(text);
  if (!t) return null;
  // Пряме значення enum ("MRI", "us") — теж приймаємо.
  const direct = modalityCode(t.toUpperCase());
  if (direct !== "OTHER" && BOOKABLE_MODALITIES.includes(direct)) return direct;
  for (const [re, code] of MOD_KEYWORDS) if (re.test(t)) return code;
  return null;
}

/* ---------------- Чистка значень ---------------- */

export const PRICE_MAX = 1_000_000; // = CHECK services_price_chk (0107) і zPrice (actions)

/** «3 200,00 грн» / «3.200» (роздільник тисяч!) / «3200 ₴» / 3200.5 → 3200 (int, грн).
    null = не число АБО поза межами [0..PRICE_MAX] (такий рядок іде в skipped, а не
    валить увесь імпорт на сервері — ревью M1/L4). */
export function parsePrice(v: unknown): number | null {
  let n: number;
  if (typeof v === "number" && Number.isFinite(v)) {
    n = Math.round(v);
  } else {
    const t = String(v ?? "").slice(0, 64)
      .replace(/грн|uah|₴/gi, "")
      .replace(/\s|\u00a0/g, "")
      .trim();
    if (!t) return null;
    let canonical: string;
    if (/^\d{1,3}([.,]\d{3})+$/.test(t)) {
      // «3.200» / «12,500,000» — роздільники тисяч, НЕ десяткові (M1: інакше
      // «3.200» ставав 3 ₴ і масово псував каталог через «Зміна ціни»).
      canonical = t.replace(/[.,]/g, "");
    } else if (/^\d+([.,]\d{1,2})?$/.test(t)) {
      canonical = t.replace(",", ".");   // «2400,50» — копійки
    } else {
      return null;                        // неоднозначне («1.2.3», «3,1415») — не вгадуємо
    }
    n = Math.round(Number(canonical));
  }
  return Number.isFinite(n) && n >= 0 && n <= PRICE_MAX ? n : null;
}

/** «30 хв» / «30-40» (беремо перше) / 30 → normDur (кратно 5, 5..480). null = нема. */
export function parseDuration(v: unknown): number | null {
  if (v == null || v === "") return null;
  let n: number;
  if (typeof v === "number" && Number.isFinite(v)) {
    n = v;
  } else {
    const m = String(v).match(/\d+/);
    if (!m) return null;
    n = Number(m[0]);
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  // За межами розумного (наприклад, «1215» з колонки-сміття) — не вгадуємо.
  if (n > DUR_MAX * 2) return null;
  return Math.max(DUR_MIN, Math.min(DUR_MAX, normDur(n)));
}

/* ---------------- Розбір сирих рядків ---------------- */

export const IMPORT_NAME_MAX = 120; // = sService.name max (app/services/actions.ts)
export const IMPORT_ROWS_MAX = 500; // стеля позицій за один імпорт (= RPC 0115)

/** Сирі рядки з n8n (Extract From File): об'єкт «заголовок → значення». */
export type RawSheetRow = Record<string, unknown>;

export function parseRawRows(raw: RawSheetRow[] | null | undefined): ParseResult {
  const rows: ImportRow[] = [];
  let skipped = 0;
  let truncated = false;
  const list = Array.isArray(raw) ? raw : [];
  // Заголовки — ОБ'ЄДНАННЯ ключів перших 20 рядків (ревью M3): sparse-парсери
  // опускають порожні клітинки, і колонка, порожня в ПЕРШОМУ рядку, губилась.
  const headerSet = new Set<string>();
  for (const r of list.slice(0, 20)) {
    if (r && typeof r === "object") for (const k of Object.keys(r)) headerSet.add(k);
  }
  const cols = detectColumns([...headerSet]);

  // Без розпізнаної колонки назви або ціни детермінований розбір неможливий.
  if (!cols.name || !cols.price) return { rows: [], skipped: list.length, columns: cols, truncated };

  const seen = new Set<string>(); // дедуп у межах файла: (modality|lower(name))
  for (const r of list) {
    if (!r || typeof r !== "object") { skipped++; continue; }
    // slice(0, 512): значення-простиня з зіп-бомби не має коштувати CPU на regex (M2).
    const name = String(r[cols.name] ?? "").slice(0, 512).replace(/\s+/g, " ").trim();
    const price = parsePrice(r[cols.price]);
    if (name.length < 2 || name.length > IMPORT_NAME_MAX || price == null) { skipped++; continue; }

    const fromCol = cols.modality ? inferModality(r[cols.modality]) : null;
    const modality = fromCol ?? inferModality(name);
    const durationMin = cols.duration ? parseDuration(r[cols.duration]) : null;

    const key = (modality ?? "?") + "|" + name.toLowerCase();
    if (seen.has(key)) { skipped++; continue; } // дубль у файлі — беремо перший
    seen.add(key);

    rows.push({
      name,
      modality,
      price,
      durationMin,
      // Детермінована гілка: впевнені, коли модальність визначено; інакше 0.5 —
      // рядок піде в «нерозпізнані», адмін обере модальність руками.
      confidence: modality ? 1 : 0.5,
    });
    if (rows.length >= IMPORT_ROWS_MAX) { truncated = true; break; }
  }
  return { rows, skipped, columns: cols, truncated };
}

/* ---------------- Класифікація проти каталогу центру ---------------- */

/** Мінімальний контракт рядка services для матчингу (підмножина Tables<"services">). */
export interface ExistingService {
  id: string;
  name: string;
  modality: string;
  price: number;
  duration_min: number;
  active: boolean;
}

export type ClassifiedRow =
  | { kind: "new"; row: ImportRow }
  | { kind: "changed"; row: ImportRow; existing: ExistingService }   // ціна та/або час відрізняються
  | { kind: "unchanged"; row: ImportRow; existing: ExistingService }
  | { kind: "inactive"; row: ImportRow; existing: ExistingService }  // позиція вимкнена — «оживити»?
  | { kind: "unrecognized"; row: ImportRow };                        // без модальності

/** Зіставити розібрані рядки з каталогом центру (унікальність 0107:
    clinic_id + modality + lower(name)). */
export function classifyRows(rows: ImportRow[], existing: ExistingService[]): ClassifiedRow[] {
  const byKey = new Map<string, ExistingService>();
  for (const s of existing) {
    byKey.set(modalityCode(s.modality) + "|" + s.name.trim().toLowerCase(), s);
  }
  return rows.map((row): ClassifiedRow => {
    if (!row.modality) return { kind: "unrecognized", row };
    const ex = byKey.get(row.modality + "|" + row.name.toLowerCase());
    if (!ex) return { kind: "new", row };
    if (!ex.active) return { kind: "inactive", row, existing: ex };
    const priceSame = ex.price === row.price;
    const durSame = row.durationMin == null || ex.duration_min === row.durationMin;
    return priceSame && durSame
      ? { kind: "unchanged", row, existing: ex }
      : { kind: "changed", row, existing: ex };
  });
}
