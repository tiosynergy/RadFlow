import { NextResponse } from "next/server";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseBody } from "@/lib/validationHttp";
import { SearchRequestSchema, type SearchCursor, type SearchResultItem } from "@/lib/searchContract";
import { decodeSearchCursor, prepareSearch, runSearchPage } from "@/lib/searchEngine.server";
import { buildXlsx } from "@/lib/xlsx";
import { buildSearchExportSheets, EXPORT_MAX_ROWS, exportFileName, type ExportIncomplete } from "@/lib/searchExport";
import { emitImportantEvent } from "@/lib/importantEvents.server";
import { logError } from "@/lib/serverLog";

/* ===== POST /api/search/export — результат пошуку в .xlsx (с77) =====

   Тіло запиту — той самий SearchRequest, що й у POST /api/search (курсор і
   ліміт ігноруються). Область, фільтри, скриття — з ТОГО САМОГО рушія
   (lib/searchEngine.server.ts): файл не може показати більше, ніж екран.

   ⚠️ Новий канал ПІБ і телефонів, тому:
     • ліміт частоти — 10 файлів за 10 хв на користувача. Чесно: це ГАЛЬМО, а
       не замок — 50 тис. рядків за 10 хв порівнянні з тим, що вже дає
       посторінковий POST /api/search (60 × 100 за хвилину), а лімітер
       fail-open. Замок — область ролі, а слід — журнал;
     • стеля EXPORT_MAX_ROWS рядків і бюджет часу; якщо не влізло — файл
       чесно каже «НЕ ВСЕ» (і чому) на аркуші «Параметри» і в заголовку
       відповіді. «Не все» ставимо лише тоді, коли ДОВЕДЕНО, що є ще збіг, або
       коли довести не встигли — а не тому, що скан уперся в стелю (ревʼю с77);
     • кожне вивантаження з даними — подія `patient_data.exported` у журнал
       КОЖНОГО центру, чиї записи пішли у файл: лише кількість ЦЬОГО центру,
       джерело і формат. Ні загальної кількості, ні «обрізано»: журнал центру
       А не має знати, скільки цей користувач вивантажив із центру Б (ревʼю с77);
     • `no-store`: файл із ПІБ не лягає в жоден кеш. */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Бюджет часу на скан: запас до maxDuration на збирання файлу і журнал. */
const EXPORT_TIME_BUDGET_MS = 25_000;
const PAGE_LIMIT = 1000;
const PAGE_MAX_SCAN = 5000;
const PAGE_BATCH = 500;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fmtNow(tz: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("uk-UA", {
      timeZone: tz || "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

export async function POST(req: Request) {
  const path = "/api/search/export";
  const gate = await requireRole(null, { rateLimit: { key: "search_export", max: 10, windowSeconds: 600 }, path });
  if (!gate.ok) return gate.res;
  const { supabase, me } = gate;

  const parsed = await parseBody("api/search/export", req, SearchRequestSchema, "Некоректний запит експорту");
  if (!parsed.ok) return parsed.res;
  const { cursor: _c, limit: _l, ...input } = parsed.data;

  const prep = await prepareSearch(supabase, createAdminClient(), me, input);
  if (!prep.ok) return NextResponse.json(prep.body, { status: prep.status });
  const { ctx, f } = prep;

  const items: SearchResultItem[] = [];
  const seen = new Set<string>();
  let incomplete: ExportIncomplete = null;
  if (!prep.empty) {
    const deadline = Date.now() + EXPORT_TIME_BUDGET_MS;
    let cursor: SearchCursor | null = null;
    let degraded = false;
    for (;;) {
      // room = 0 — це ПРОБА: «чи є хоч один збіг понад стелю?» (limit 0 →
      // перший же збіг дає more="match"). Без неї рівно EXPORT_MAX_ROWS збігів,
      // за якими йдуть лише незбіги, давали б хибне «НЕ ВСЕ».
      const room = EXPORT_MAX_ROWS - items.length;
      const page = await runSearchPage(ctx, f, cursor, {
        limit: Math.min(PAGE_LIMIT, room),
        maxScan: PAGE_MAX_SCAN,
        batch: PAGE_BATCH,
        deadline,
      });
      if (!page.ok) return NextResponse.json({ error: page.error }, { status: page.status });
      degraded = degraded || page.degraded;
      // Дедуп між сторінками: деградований keyset (кривий scheduled_time) може
      // повторно переглянути сусідів у межах дати — у файлі дубль недопустимий.
      for (const it of page.items) {
        if (seen.has(it.recordId)) continue;
        seen.add(it.recordId);
        items.push(it);
      }
      if (page.more === null) break;                                              // вибірку вичерпано
      if (page.more === "match" && items.length >= EXPORT_MAX_ROWS) { incomplete = "cap"; break; } // доведено: є ще
      if (Date.now() > deadline) { incomplete = "time"; break; }                  // не встигли довести
      cursor = page.nextCursor ? decodeSearchCursor(page.nextCursor, f.source, f.sort) : null;
      if (!cursor) { incomplete = "time"; break; }
    }
    // Деградований курсор міг ПРОПУСТИТИ рядки в межах дати — повноту не
    // гарантуємо і кажемо про це (ревʼю с77; на проді таких рядків 0).
    if (!incomplete && degraded) incomplete = "cursor";
  }
  const truncated = incomplete !== null;

  // Назви центрів і кабінетів — RLS-клієнтом (роль і так бачить свої довідники).
  const clinicNames = new Map<string, string>();
  const roomNames = new Map<string, string>();
  if (ctx.scope.clinicIds.length) {
    const [cl, rm] = await Promise.all([
      supabase.from("clinics").select("id, name").in("id", ctx.scope.clinicIds),
      supabase.from("rooms").select("id, name").in("clinic_id", ctx.scope.clinicIds),
    ]);
    if (cl.error || rm.error) {
      logError({ event: "search.export_lookup_failed", actorId: me.id, errorCode: (cl.error || rm.error)?.code ?? "db_error", message: null });
    }
    (cl.data || []).forEach((c) => clinicNames.set(String(c.id).toLowerCase(), c.name || ""));
    (rm.data || []).forEach((r) => roomNames.set(String(r.id).toLowerCase(), r.name || ""));
  }
  const lookup = {
    clinicName: (id: string) => clinicNames.get(id.toLowerCase()) || "",
    roomName: (id: string | null) => (id ? roomNames.get(id.toLowerCase()) || "" : ""),
  };

  /* Підпис фільтра «Направник» для аркуша «Параметри». ⚠️ Імʼя акаунта — лише з
     РЕЗУЛЬТАТІВ (їх уже віддала RLS), а не за id із запиту: інакше експорт
     став би оракулом «ПІБ будь-якого направника за UUID». */
  let referrerLabel: string | null = null;
  if (f.noReferrer) referrerLabel = f.source === "waitlist" ? "без акаунта направника" : "без направника";
  else if (f.doctorIds) referrerLabel = (ctx.docNames.join(", ") || "лікар довідника") + " (довідник)";
  else if (f.referrerIds) referrerLabel = items.find((it) => it.referrerName)?.referrerName || "акаунт направника";

  const sheets = buildSearchExportSheets(items, {
    f,
    scope: { showPhone: ctx.scope.showPhone, referrerVisible: ctx.scope.referrerVisible },
    rows: items.length,
    incomplete,
    generatedAt: fmtNow(ctx.tz0),
    referrerLabel,
    lookup,
  });
  const bytes = await buildXlsx(sheets, { title: "RadFlow — пошук" });

  /* Журнал: подія в КОЖЕН центр, чиї записи пішли у файл. Порожній файл
     нічого не вивантажив — події немає. fail-OPEN (конвенція 0128). */
  const byClinic = new Map<string, number>();
  for (const it of items) byClinic.set(it.clinicId, (byClinic.get(it.clinicId) ?? 0) + 1);
  const subjectReferrerId =
    me.role === "referrer" ? me.id : f.referrerIds && f.referrerIds.length === 1 ? f.referrerIds[0] : null;
  for (const [clinicId, rows] of byClinic) {
    await emitImportantEvent({
      clinicId,
      actorId: me.id,
      eventType: "patient_data.exported",
      entityType: "staff",
      entityId: me.id,
      subjectReferrerId,
      details: { source: f.source, rows, format: "xlsx" },
    });
  }

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${exportFileName(f.source, ctx.todayKey)}"`,
      "Cache-Control": "no-store",
      "X-Export-Rows": String(items.length),
      "X-Export-Truncated": truncated ? "1" : "0",
      "X-Export-Incomplete": incomplete ?? "",
    },
  });
}
