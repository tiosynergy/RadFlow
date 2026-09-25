/* ===== Дашборд CEO: період, дохід, рядки CSV — ЧИСТА частина (с79, Н-10) =====

   Спільна для клієнта (components/CeoDashboard.tsx: KPI-період, drill-down) і
   сервера (app/api/ceo/export/route.ts: CSV). До с79 ці функції жили в самому
   компоненті, а CSV збирався в браузері: до 5000 рядків із ПІБ, процедурою й
   доходом читались напряму під RLS, і журнал про вивантаження не знав нічого
   (знахідка Н-10). Тепер файл збирає сервер, а період і дохід рахує ОДИН код
   на обидва боки: файл не може розійтися з KPI у періоді, а drill-down із
   файлом — у доході.

   ⚠️ Тут немає ні React, ні клієнта Supabase, ні писача CSV: модуль їде і в
   браузер (drill-down), тож зайвого в бандл він тягнути не сміє. Сам CSV —
   lib/csv.ts, лише на сервері. */

import { wallToday0 } from "@/lib/incidents";
import { modalityCode } from "@/lib/studies";

/** Періоди дашборда — ті самі три кнопки «Сьогодні / Цей тиждень / Цей місяць». */
export const CEO_PERIODS = ["today", "week", "month"] as const;
export type CeoPeriod = (typeof CEO_PERIODS)[number];

/** Стеля рядків одного файлу — та сама, що й до с79. Понад неї файл чесно
    каже «перші N» (сервер доводить це пробою +1 рядок, а не «рівно стеля»). */
export const CEO_EXPORT_MAX_ROWS = 5000;

/** Колонки записів черги — ОДИН перелік для CSV (сервер) і drill-down (клієнт).
    `id` і `scheduled_time` — для keyset-сторінок і показу за часом (ревʼю с79, M-1). */
export const CEO_ENTRY_COLS = "id, status, studies, room_id, scheduled_date, scheduled_time, patient_name, note, clinic_id";

/** Колонки каталогу для оцінки доходу. 0121: room_id — пріоритет власної
    послуги кабінету запису над базовою. `id, sort_order` — сервер читає
    каталог сторінками за id і сам відновлює пріоритетний порядок
    (compareCatalogOrder). */
export const CEO_SERVICE_COLS = "id, clinic_id, modality, name, price, contrast_price, room_id, sort_order";

/** Загальна відмова експорту — і в роуті (500), і в тості клієнта. */
export const CEO_EXPORT_ERR = "Не вдалося сформувати експорт — спробуйте ще раз";

/** Текст тоста на невдалий експорт (ревʼю с79, L-4).
    • 429 — гальмо на 10 файлів за 10 хв: «спробуйте ще раз» тут збрехало б;
    • 403 — БЕЗПЕЧНИЙ текст самого роуту: там лише загальні українські фрази
      («Недостатньо прав», «Немає доступу до цього центру — оновіть сторінку»,
      «Спершу завершіть налаштування центру»), без внутрощів; нетекстова або
      надто довга відповідь (проксі, HTML) — загальне «недостатньо прав»;
    • решта — колишнє «не вдалося — спробуйте ще раз». */
export function ceoExportErrorText(status: number, body: unknown): string {
  if (status === 429) return "Забагато вивантажень за короткий час — спробуйте за кілька хвилин";
  if (status === 403) {
    const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    return typeof e === "string" && e.trim() !== "" && e.length <= 160 ? e : "Недостатньо прав для експорту";
  }
  return CEO_EXPORT_ERR;
}

/** Заголовок CSV. Колонки й сенс — як були до переїзду на сервер. */
export const CEO_EXPORT_HEAD = ["Дата", "Пацієнт", "Процедура", "Кабінет", "Статус", "Дохід"] as const;

/** Імʼя файлу — лише ASCII (заголовок Content-Disposition), як і раніше: ceo-<період>.csv. */
export function ceoExportFileName(period: CeoPeriod): string {
  return "ceo-" + period + ".csv";
}

/* ---------- Дати: календарні дні ЦЕНТРУ ---------- */

/** Date (локальна північ) → 'YYYY-MM-DD'. Пара до wallToday0: той повертає
    локальну північ настінної дати центру, тож локальні геттери тут дають саме
    дату центру, а не браузера чи сервера. */
export function dateKey(d: Date): string {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Межі періоду [перший, останній] день включно — за настінним «сьогодні»
    ЦЕНТРУ (tz), а не браузера чи сервера (аудит M-4). Тиждень — Пн–Нд.
    Невідомий період рахується як місяць — так було в компоненті з самого
    початку; сервер невідомого періоду не пропускає (zod). */
export function periodRange(period: string, tz?: string): [Date, Date] {
  const t = wallToday0(tz);
  if (period === "today") return [t, t];
  if (period === "week") {
    const mon = addDays(t, -((t.getDay() + 6) % 7));
    return [mon, addDays(mon, 6)];
  }
  const first = new Date(t.getFullYear(), t.getMonth(), 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  return [first, last];
}

/* ---------- Дохід запису ---------- */

type StudyLike = { price?: number; region?: string; contrast?: boolean; type?: string };
export type RevenueEntry = { studies?: unknown; note?: string | null; clinic_id?: string | null; room_id?: string | null };

/* Каталог scoped-центрів: clinic_id → «modalityCode|region» → ціна/контраст.
   Дзеркалить catalog_est_sum з RPC 0114/0121 (чистий каталог): дохід на
   картці KPI рахує сервер (агрегат), а для рядкового CSV і drill-down — тут,
   тією ж логікою, БЕЗ static-фолбэку.
   0121 (room-owned): видимі запису послуги = базові (room_id NULL) + власні
   кабінету запису; власна кабінету має ПРІОРИТЕТ над базовою при дублі імені —
   дзеркало `order by (sv.room_id is not null) desc, sort_order, id` у
   ceo_kpi_studies. (Відоме обмеження, як і в RPC: override-и 0108 тут свідомо
   не враховуються.) */
type CsvSvc = { price: number; contrastPrice: number | null };
export type CsvCatalog = {
  base: Map<string, Map<string, CsvSvc>>;                    // clinic → key → послуга
  room: Map<string, Map<string, Map<string, CsvSvc>>>;       // clinic → room → key → послуга
};
export type CatalogServiceRow = {
  clinic_id: string; modality: string; name: string; price: number; contrast_price: number | null; room_id: string | null;
};

/** Рядки мають бути ЛИШЕ активні й упорядковані `sort_order, id`: перша
    послуга з тим самим ключем — пріоритетна. */
export function buildCsvCatalog(rows: ReadonlyArray<CatalogServiceRow>): CsvCatalog {
  const cat: CsvCatalog = { base: new Map(), room: new Map() };
  for (const r of rows) {
    const key = r.modality + "|" + r.name;
    if ((r.room_id ?? null) === null) {
      let inner = cat.base.get(r.clinic_id);
      if (!inner) { inner = new Map(); cat.base.set(r.clinic_id, inner); }
      if (!inner.has(key)) inner.set(key, { price: r.price, contrastPrice: r.contrast_price });  // перша = пріоритетна
    } else {
      let byRoom = cat.room.get(r.clinic_id);
      if (!byRoom) { byRoom = new Map(); cat.room.set(r.clinic_id, byRoom); }
      let inner = byRoom.get(r.room_id as string);
      if (!inner) { inner = new Map(); byRoom.set(r.room_id as string, inner); }
      if (!inner.has(key)) inner.set(key, { price: r.price, contrastPrice: r.contrast_price });
    }
  }
  return cat;
}

/** Дохід запису: збережена ціна (снапшот) виграє; інакше — ціна КАТАЛОГУ
    центру (чистий каталог: лише коли послуга видима запису і price > 0),
    інакше 0. 0121: спершу власна послуга кабінету запису, потім базова. */
export function entryRevenue(e: RevenueEntry, cat: CsvCatalog): number {
  const s: StudyLike[] = Array.isArray(e.studies) ? (e.studies as StudyLike[]) : [];
  if (!s.length) return 0;
  const roomInner = e.clinic_id && e.room_id ? cat.room.get(e.clinic_id)?.get(e.room_id) : undefined;
  const baseInner = e.clinic_id ? cat.base.get(e.clinic_id) : undefined;
  return s.reduce((sum, x) => {
    if (typeof x.price === "number") return sum + x.price;
    const key = modalityCode(x.type) + "|" + (x.region || "");
    const svc = roomInner?.get(key) ?? baseInner?.get(key);
    /* Ціна каталогу — БЕЗ доплати за контраст: контрастна позиція прайсу має
       власну ціну (4900 проти 2200), доплата рахувала б контраст двічі. Записи
       зі збереженим снапшотом ціни (гілка вище) історію не змінюють. */
    if (svc && svc.price > 0) return sum + svc.price;
    return sum;
  }, 0);
}

/** Назва процедури: перше дослідження запису («МРТ · Коліно»), інакше нотатка, інакше «—». */
export function procName(e: RevenueEntry): string {
  const s: StudyLike[] = Array.isArray(e.studies) ? (e.studies as StudyLike[]) : [];
  if (s.length) return (s[0].type || "") + (s[0].region ? " · " + s[0].region : "");
  return e.note || "—";
}

/* ---------- Сторінки й порядок (ревʼю с79, M-1) ----------

   PostgREST віддає не більше db-max-rows (1000) рядків на запит — МОВЧКИ.
   Тому роут читає і записи, і каталог, і кабінети сторінками, а порядок, який
   потрібен файлу, відновлює тут — у памʼяті, одним кодом для тестів і роуту. */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Алфавіт, що не ламає синтаксис `or()` PostgREST (там роздільники `,.:()`
    і лапки). uuid проходить; усе інше — виняток, а не «кривий» фільтр. */
const SAFE_KEY_RE = /^[0-9A-Za-z_-]{1,64}$/;

/** Keyset-умова «строго після (дата, id)» для порядку scheduled_date ASC,
    id ASC — у синтаксисі `.or()` PostgREST.
    ⚠️ Час у ключі свідомо НЕМАЄ: scheduled_time — вільний text, і в `.or()`
    «кривий» час ламав би синтаксис (пошук заради цього тримає «деградований
    курсор»). Порядок за часом відновлює compareExportOrder після читання. */
export function afterDateIdOr(date: string, id: string): string {
  if (!DATE_KEY_RE.test(date) || !SAFE_KEY_RE.test(id)) throw new Error("keyset: некоректний ключ сторінки");
  return `scheduled_date.gt.${date},and(scheduled_date.eq.${date},id.gt.${id})`;
}

const cmpStr = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const cmpNullsLast = (x: string | null, y: string | null) =>
  x === y ? 0 : x === null ? 1 : y === null ? -1 : cmpStr(x, y);

/** Порядок рядків у файлі: дата, час (порожній — наприкінці дня), id. uuid
    порівнюється в нижньому регістрі — як і в Postgres. */
export function compareExportOrder(
  a: { scheduled_date: string | null; scheduled_time: string | null; id: string },
  b: { scheduled_date: string | null; scheduled_time: string | null; id: string }
): number {
  return cmpNullsLast(a.scheduled_date, b.scheduled_date)
    || cmpNullsLast(a.scheduled_time, b.scheduled_time)
    || cmpStr(a.id.toLowerCase(), b.id.toLowerCase());
}

/** Пріоритет каталогу — дзеркало `order by sort_order, id` (перша послуга з
    тим самим ключем виграє, див. buildCsvCatalog). Сервер читає каталог
    сторінками за id і відновлює цей порядок тут. */
export function compareCatalogOrder(a: { sort_order: number; id: string }, b: { sort_order: number; id: string }): number {
  return (a.sort_order - b.sort_order) || cmpStr(a.id.toLowerCase(), b.id.toLowerCase());
}

/* ---------- Рядки файлу ---------- */

export type CeoExportEntry = RevenueEntry & {
  status: string;
  scheduled_date: string | null;
  patient_name: string | null;
};
export type CeoExportRow = [string, string, string, string, string, number];

/** Рядки CSV у порядку CEO_EXPORT_HEAD. Статус — сирий код (як і до с79):
    таблиці керівників уже можуть на нього спиратися. */
export function ceoExportRows(
  entries: ReadonlyArray<CeoExportEntry>,
  cat: CsvCatalog,
  roomName: (roomId: string) => string
): CeoExportRow[] {
  return entries.map((e) => [
    e.scheduled_date ?? "",
    e.patient_name ?? "",
    procName(e),
    e.room_id ? roomName(e.room_id) : "",
    e.status,
    entryRevenue(e, cat),
  ]);
}
