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
  /** null = у прайсі ціни немає: нова позиція створюється з ціною 0 («заповнити
      пізніше»), в існуючої ціна НЕ чіпається (рішення власника 2026-07-20). */
  price: number | null;
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

/* Назва, що складається ЛИШЕ зі слова-маркера модальності (заголовок розділу
   прайса: «УЗД», «Рентгенографія:», «МРТ (магнітно-резонансна томографія)»).
   ⚠️ «Мамографія» у списку НЕМАЄ свідомо: це повна назва реальної послуги
   (оглядова мамографія), а не лише заголовок розділу (ревью 0116 L2). */
const SECTION_RE = /^(мрт|магнітно-резонансна томографія|кт|мскт|комп'ютерна томографія|узд|узи|ультразвукова діагностика|ультразвукові дослідження|рентген(ографія|ологія)?|mri|ct|us|x-?ray)([\s:.\-–—]*\([^)]*\))?[\s:.\-–—]*$/i;
export function isSectionHeader(name: string): boolean {
  // Типографські апострофи (’ʼ`) → прямий ' — «Комп’ютерна томографія» в
  // реальних прайсах набрана саме так (ревью 0116 L2).
  return SECTION_RE.test(name.trim().replace(/[’ʼ`]/g, "'"));
}

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

/** Рятувальний прохід для файлів із «шапкою» (титул/примітки НАД таблицею):
    Extract From File бере ПЕРШИЙ рядок аркуша як заголовки, і якщо це титул —
    справжні заголовки («Назва послуги», «Ціна, грн»…) опиняються ЗНАЧЕННЯМИ
    одного з перших рядків. Шукаємо такий рядок у перших N і перекейовуємо
    решту позиційно. Потрібен includeEmptyCells=true на боці n8n (інакше
    порожні клітинки зсувають позиції). */
const HEADER_SCAN_ROWS = 10;

function rescueHeaderRow(list: RawSheetRow[]): { list: RawSheetRow[]; cols: DetectedColumns } | null {
  for (let i = 0; i < Math.min(list.length, HEADER_SCAN_ROWS); i++) {
    const candidate = list[i];
    if (!candidate || typeof candidate !== "object") continue;
    const values = Object.values(candidate).map((v) => String(v ?? "").trim());
    const cols = detectColumns(values);
    if (!cols.name || !cols.price) continue;
    // Знайшли рядок-заголовок: перекейовуємо все ПІСЛЯ нього позиційно.
    const idx = {
      name: values.indexOf(cols.name),
      price: values.indexOf(cols.price),
      duration: cols.duration ? values.indexOf(cols.duration) : -1,
      modality: cols.modality ? values.indexOf(cols.modality) : -1,
    };
    const rekeyed: RawSheetRow[] = [];
    for (const r of list.slice(i + 1)) {
      if (!r || typeof r !== "object") continue;
      const vals = Object.values(r);
      // Гард від позиційного зсуву: якщо у рядку менше клітинок, ніж у заголовку
      // (includeEmptyCells вимкнено на боці n8n), краще пропустити рядок, ніж
      // прочитати ціну з чужої колонки.
      if (vals.length !== values.length) { continue; }
      const row: RawSheetRow = { [cols.name]: vals[idx.name], [cols.price]: vals[idx.price] };
      if (idx.duration >= 0 && cols.duration) row[cols.duration] = vals[idx.duration];
      if (idx.modality >= 0 && cols.modality) row[cols.modality] = vals[idx.modality];
      rekeyed.push(row);
    }
    return { list: rekeyed, cols };
  }
  return null;
}

export function parseRawRows(raw: RawSheetRow[] | null | undefined): ParseResult {
  const rows: ImportRow[] = [];
  let skipped = 0;
  let truncated = false;
  let list = Array.isArray(raw) ? raw : [];
  // Заголовки — ОБ'ЄДНАННЯ ключів перших 20 рядків (ревью M3): sparse-парсери
  // опускають порожні клітинки, і колонка, порожня в ПЕРШОМУ рядку, губилась.
  const headerSet = new Set<string>();
  for (const r of list.slice(0, 20)) {
    if (r && typeof r === "object") for (const k of Object.keys(r)) headerSet.add(k);
  }
  let cols = detectColumns([...headerSet]);

  // Ключі не схожі на заголовки (файл із титулом-«шапкою» над таблицею)? —
  // шукаємо рядок-заголовок серед перших рядків і перекейовуємо (rescue).
  if (!cols.name || !cols.price) {
    const rescued = rescueHeaderRow(list);
    if (rescued) { list = rescued.list; cols = rescued.cols; }
  }

  // Без розпізнаної колонки назви або ціни детермінований розбір неможливий.
  if (!cols.name || !cols.price) return { rows: [], skipped: list.length, columns: cols, truncated };

  const seen = new Set<string>(); // дедуп у межах файла: (modality|lower(name))
  for (const r of list) {
    if (!r || typeof r !== "object") { skipped++; continue; }
    // slice(0, 512): значення-простиня з зіп-бомби не має коштувати CPU на regex (M2).
    const name = String(r[cols.name] ?? "").slice(0, 512).replace(/\s+/g, " ").trim();
    const price = parsePrice(r[cols.price]);
    if (name.length < 2 || name.length > IMPORT_NAME_MAX) { skipped++; continue; }

    const fromCol = cols.modality ? inferModality(r[cols.modality]) : null;
    const modality = fromCol ?? inferModality(name);
    const durationMin = cols.duration ? parseDuration(r[cols.duration]) : null;

    // Рядок БЕЗ ціни і часу, чия назва — лише слово-маркер модальності
    // («УЗД», «Рентгенографія», «МРТ:») — це заголовок РОЗДІЛУ прайса,
    // не послуга. Інакше він імпортувався б порожньою позицією.
    if (price == null && durationMin == null && isSectionHeader(name)) { skipped++; continue; }

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

/* ---------------- Формати файла прайса: ЄДИНЕ ДЖЕРЕЛО ІСТИНИ ----------------

   Раніше перелік розширень жив у ЧОТИРЬОХ місцях одночасно: атрибут `accept`
   інпута, видимий текст модалки, `title` кнопки в ServicesEditor і функція
   `fileKind` усередині route-файла. Вони вже встигли розійтися (`.webp` був у
   `accept` і на сервері, але не в тексті для користувача), а покрити тестами
   `fileKind` було неможливо: Next.js не дає експортувати з route-файла нічого,
   крім HTTP-хендлерів. Тому перелік переїхав сюди — як і `safePriceUrl` вище,
   і з тієї самої причини.

   ⚠️ ФОТО ПРАЙСА БІЛЬШЕ НЕ ПРИЙМАЄМО (рішення власника 2026-07-29). Було:
   .jpg/.jpeg/.png/.webp → Grok vision. Прибрано і з клієнта, і з сервера —
   тобто це не косметика тексту: сервер тепер відповідає 415 на зображення.
   Гілка `kind === 'image'` у n8n лишилась фізично, але стала недосяжною:
   RadFlow її більше не надсилає. Прибирати її з воркфлоу — окрема дія власника
   (правка ноди = чернетка до Publish), і без неї нічого не ламається. */

/** Ліміт розміру файла. НЕ 10 МБ із плану: Vercel обрізає тіло serverless-
    функції на ~4.5 МБ, тож більший файл фізично не долетить. Клієнт перевіряє
    ще до відправки, сервер — як справжній рубіж (413). */
export const IMPORT_MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Як обробляється файл: детерміновано (таблиця) чи через AI. */
export type ImportFileKind = "xlsx" | "csv" | "pdf" | "docx";

/** Розширення для `accept` і для перевірки на клієнті. Порядок — як у тексті. */
export const IMPORT_ACCEPT_EXT = [".xlsx", ".csv", ".pdf", ".docx"] as const;
export const IMPORT_ACCEPT_ATTR = IMPORT_ACCEPT_EXT.join(",");
/** Той самий перелік для ока — щоб підпис у зоні завантаження не набирали руками. */
export const IMPORT_ACCEPT_EXT_TEXT = IMPORT_ACCEPT_EXT.map((e) => e.slice(1)).join(" · ");

/** Один текст відмови на клієнті й на сервері — щоб не розійшлися. */
export const IMPORT_FORMATS_HINT = "Підтримуються .xlsx, .csv, .pdf і .docx";

/** Тип файла за РОЗШИРЕННЯМ імені. MIME від клієнта свідомо не дивимось: він
    підробляється тривіально, а справжній вміст усе одно перевіряє парсер далі
    по ланцюжку (n8n / docxToText). Розширення тут — це маршрутизація, не
    безпека. Невідоме розширення → null → 415. */
export function importFileKind(name: string): ImportFileKind | null {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".xlsx")) return "xlsx";
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".docx")) return "docx";
  return null;
}

/** Чи піде файл в AI-гілку. Важливо для очікувань користувача (секунди проти
    хвилин) і для таймауту звернення до n8n. xlsx/csv — детермінований розбір;
    pdf — текст → Grok; docx — текст витягуємо на сервері, далі теж Grok. */
export function isAiFileKind(kind: ImportFileKind): boolean {
  return kind === "pdf" || kind === "docx";
}

/* ---------------- AI-гілка (фаза 3b): рядки від LLM ---------------- */

/** SSRF-гард для режиму «посилання на прайс»: лише https і лише доменні імена
    (IP-літерали/localhost/IPv6/.local — відмова; хвостова крапка нормалізується).
    Дзеркальний гард — у n8n «Verify & Decode»; редиректи Fetch Page ВИМКНЕНО
    (302 на приватний http-хост знімав би обидва гарди). Живе тут (не в route.ts):
    Next.js дозволяє з route-файла експортувати лише HTTP-хендлери/конфіг. */
export function safePriceUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".local")) return null;
  if (host.includes(":") || /^(\d+\.){3}\d+$/.test(host)) return null;
  return u.toString();
}

/** Поріг упевненості AI: нижче — рядок іде в «Нерозпізнані» на ручне
    підтвердження (рішення власника 2026-07-20). Детермінованої гілки не
    зачіпає: там confidence 1 (модальність є) або 0.5 (і так unrecognized). */
export const AI_CONF_MIN = 0.7;

/** Сирий рядок AI-гілки n8n (Grok, structured output): контракт —
    { name, modality: MRI|CT|US|XRAY|MAMMO|null, price, duration_min, confidence }.
    Модель НЕ довірена (prompt-injection із документа) — тут усе валідується
    заново тими самими парсерами, що й детермінована гілка. */
export function parseAiRows(raw: unknown[] | null | undefined): ParseResult {
  const rows: ImportRow[] = [];
  let skipped = 0;
  let truncated = false;
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  for (const r of list) {
    if (!r || typeof r !== "object" || Array.isArray(r)) { skipped++; continue; }
    const o = r as Record<string, unknown>;
    const name = String(o.name ?? "").slice(0, 512).replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > IMPORT_NAME_MAX) { skipped++; continue; }

    // Модальність від моделі (enum) АБО фолбэк-евристика за назвою — та сама,
    // що в детермінованій гілці (модель могла лишити null там, де назва явна).
    const modality = inferModality(o.modality) ?? inferModality(name);
    const price = parsePrice(o.price);           // межі 0..PRICE_MAX — не довіряємо
    const durationMin = parseDuration(o.duration_min); // normDur 5..480 кратно 5
    if (price == null && durationMin == null && isSectionHeader(name)) { skipped++; continue; }

    const cRaw = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, cRaw));

    const key = (modality ?? "?") + "|" + name.toLowerCase();
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);

    rows.push({ name, modality, price, durationMin, confidence });
    if (rows.length >= IMPORT_ROWS_MAX) { truncated = true; break; }
  }
  // «Колонок» в AI-гілці немає — UI показує режим AI за прапором preview.ai.
  return { rows, skipped, columns: { name: null, price: null, duration: null, modality: null }, truncated };
}

/* ---------------- Класифікація проти каталогу центру ---------------- */

/** Мінімальний контракт рядка services для матчингу (підмножина Tables<"services">). */
export interface ExistingService {
  id: string;
  name: string;
  modality: string;
  price: number;
  duration_min: number | null; // 0117: null = час не задано
  active: boolean;
  /** 0119: версія рядка для оптимістичної блокування при застосуванні імпорту.
      Несеться СТРІНГОМ end-to-end (JS Date зрізав би мікросекунди → хибні конфлікти). */
  updated_at: string;
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
    // Без модальності АБО AI не впевнений (нижче порога) → ручне підтвердження.
    if (!row.modality || row.confidence < AI_CONF_MIN) return { kind: "unrecognized", row };
    const ex = byKey.get(row.modality + "|" + row.name.toLowerCase());
    if (!ex) return { kind: "new", row };
    if (!ex.active) return { kind: "inactive", row, existing: ex };
    // null-ціна/null-час у файлі = «не чіпати» → не рахується зміною.
    const priceSame = row.price == null || ex.price === row.price;
    const durSame = row.durationMin == null || ex.duration_min === row.durationMin;
    return priceSame && durSame
      ? { kind: "unchanged", row, existing: ex }
      : { kind: "changed", row, existing: ex };
  });
}
