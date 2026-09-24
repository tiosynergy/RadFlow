import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { zUuid } from "@/lib/validation";
import { emitImportantEvent } from "@/lib/importantEvents.server";
import { logError } from "@/lib/serverLog";
import { ceoDashboardAccess, ceoScopeTz } from "@/lib/ceoScope";
import {
  CEO_ENTRY_COLS,
  CEO_EXPORT_HEAD,
  CEO_EXPORT_MAX_ROWS,
  CEO_PERIODS,
  CEO_SERVICE_COLS,
  buildCsvCatalog,
  ceoExportFileName,
  ceoExportRows,
  dateKey,
  periodRange,
  type CeoExportRow,
} from "@/lib/ceoExport";
import { buildCsv } from "@/lib/csv";

/* ===== POST /api/ceo/export — CSV дашборда CEO з журналом (с79, Н-10) =====

   Раніше CSV збирав браузер: до 5000 рядків із ПІБ, процедурою й доходом
   читались напряму під RLS, а журнал про вивантаження не знав нічого — тоді
   як xlsx-експорт пошуку пише подію в кожен центр. Тепер файл збирає сервер,
   за зразком /api/search/export:

     • ГЕЙТ. requireRole(null) + ліміт 10 файлів за 10 хв (свій ключ
       `ceo_export`), далі — ТЕ САМЕ правило, що гейтить сторінку /ceo
       (lib/ceoScope.ts; тотожність зі сторінкою стереже диференційний тест,
       що викликає справжню сторінку): бачать admin і ceo, а будь-яка інша
       роль — лише з активним грантом ceo_access; адмін із ненастроєним
       центром — ні (сторінка веде його в /setup). Статичним переліком ролей
       це не виразити (радіолог «ще й CEO» — легітимний), тому список ролей
       гейта — null, а відмова — 403 від правила області. fail-closed: збій
       читання грантів — 500, а не «область порожня».
     • ОБЛАСТЬ. Клієнт шле лише період і `scope` («all» або ОДИН id центру).
       Id центру НЕ розширює нічого: він мусить бути в області, обчисленій тут
       із сесії; чужий (або відкликаний, поки сторінка була відкрита) — 403, а
       не порожній файл, що читався б як «записів немає».
     • ДАНІ — RLS-клієнтом СЕСІЇ (той, що віддав requireRole), не service-role:
       межа лишається на RLS, серверні фільтри — друга лінія.
     • ПЕРІОД — тим самим periodRange і за тією самою зоною (ceoScopeTz), що й
       KPI на екрані: файл описує ті самі дні, що й картки.
     • СТЕЛЯ 5000 і чесне «перші N»: читаємо на рядок більше — «обрізано»
       лише тоді, коли ДОВЕДЕНО, що є ще рядок (рівно 5000 записів — повний
       файл). Сигнал — заголовок X-Export-Truncated.
     • ЖУРНАЛ — подія `patient_data.exported` у журнал КОЖНОГО центру, чиї
       рядки пішли у файл, лише з ЙОГО числом рядків (журнал центру А не має
       знати, скільки вивантажено з центру Б). details — { source, rows,
       format }: ключі, які вже пропускають усі чотири лінії (allowlist тут,
       piiViolations, CHECK important_events_no_pii_chk, DETAIL_KEYS
       /api/journal). Нові лише ЗНАЧЕННЯ (`ceo_dashboard`, `csv`): усі
       чотири лінії судять за ключами, а заголовок події з цим джерелом
       lib/journalText.ts підписує «з дашборда CEO». fail-OPEN за
       конвенцією 0128: збій журналу файл не скасовує, але не мовчить —
       logError усередині emitImportantEvent.
       Порожній файл нічого не вивантажив — події немає.
     • `no-store`: файл із ПІБ не лягає в жоден кеш.

   ⚠️ Межа (та сама, що в T10 моделі загроз для пошуку): журнал фіксує
   ОФІЦІЙНИЙ канал. Ті самі рядки CEO може прочитати прямим запитом PostgREST
   зі свого браузера — RLS їх йому віддає; замок — область ролі, а не цей роут. */

export const dynamic = "force-dynamic";

const PATH = "/api/ceo/export";
const EXPORT_ERR = "Не вдалося сформувати експорт — спробуйте ще раз";

/** Тіло — лише період і область. strict: клієнт, що шле ще й `clinicIds`,
    помиляється, і про це краще почути 400, ніж «тихо» отримати інший файл. */
const CeoExportRequestSchema = z
  .object({
    period: z.enum(CEO_PERIODS),
    scope: z.union([z.literal("all"), zUuid]),
  })
  .strict();

export async function POST(req: Request) {
  const gate = await requireRole(null, { rateLimit: { key: "ceo_export", max: 10, windowSeconds: 600 }, path: PATH });
  if (!gate.ok) return gate.res;
  const { supabase, me } = gate;

  const parsed = await parseBody("api/ceo/export", req, CeoExportRequestSchema, "Некоректний запит експорту");
  if (!parsed.ok) return parsed.res;
  const { period, scope } = parsed.data;

  /** Збій читання — 500 і структурований слід без PII (текст помилки чистить logError). */
  const fail = (step: string, err: { code?: string; message?: string } | null) => {
    logError({ event: "ceo.export_failed", actorId: me.id, errorCode: err?.code ?? "db_error", message: `step=${step} ${err?.message ?? ""}` });
    return NextResponse.json({ error: EXPORT_ERR }, { status: 500 });
  };

  /* 1. Хто і які центри — ТИМ САМИМ правилом, що сторінка /ceo, і з тих самих
        джерел: активні гранти ceo_access + власний центр адміна. */
  const grantsRes = await supabase.from("ceo_access").select("clinic_id").eq("ceo_id", me.id).eq("status", "active");
  if (grantsRes.error) return fail("ceo_access", grantsRes.error);
  const grantIds = (grantsRes.data ?? []).map((g) => g.clinic_id);
  const ownId = me.role === "admin" && me.clinic_id ? me.clinic_id : null;
  const lookupIds = Array.from(new Set(ownId ? [...grantIds, ownId] : grantIds));
  const cards = new Map<string, { name: string; timezone: string; configured_at: string | null }>();
  if (lookupIds.length) {
    const clRes = await supabase.from("clinics").select("id, name, timezone, configured_at").in("id", lookupIds);
    if (clRes.error) return fail("clinics", clRes.error);
    (clRes.data ?? []).forEach((c) => cards.set(String(c.id).toLowerCase(), c));
  }
  const card = (id: string) => cards.get(id.toLowerCase());
  const access = ceoDashboardAccess({
    role: me.role,
    clinicId: me.clinic_id,
    ownClinic: ownId ? card(ownId) ?? null : null,
    grants: grantIds.map((id) => ({ clinicId: id, name: card(id)?.name, timezone: card(id)?.timezone })),
  });
  if (!access.ok) {
    logError({ event: "access.denied", actorId: me.id, errorCode: access.reason === "setup" ? "clinic_not_configured" : "forbidden", message: `path=${PATH}` });
    return NextResponse.json(
      { error: access.reason === "setup" ? "Спершу завершіть налаштування центру" : "Недостатньо прав" },
      { status: 403 }
    );
  }

  /* 2. Обраний центр — лише з області, обчисленої вище. */
  let clinicIds: string[];
  let tzScope: string;
  if (scope === "all") {
    clinicIds = access.clinics.map((c) => c.id);
    tzScope = "all";
  } else {
    const hit = access.clinics.find((c) => c.id.toLowerCase() === scope.toLowerCase());
    if (!hit) {
      logError({ event: "access.denied", actorId: me.id, errorCode: "clinic_out_of_scope", message: `path=${PATH}` });
      return NextResponse.json({ error: "Немає доступу до цього центру" }, { status: 403 });
    }
    clinicIds = [hit.id];
    tzScope = hit.id;
  }

  /* 3. Період — тим самим кодом і за тією самою зоною, що й KPI на екрані. */
  const [from, to] = periodRange(period, ceoScopeTz(access.clinics, tzScope));

  let rows: CeoExportRow[] = [];
  let truncated = false;
  const byClinic = new Map<string, number>();
  if (clinicIds.length) {
    const qRes = await supabase
      .from("queue_entries")
      .select(CEO_ENTRY_COLS)
      .in("clinic_id", clinicIds)
      .neq("status", "cancelled")
      .gte("scheduled_date", dateKey(from))
      .lte("scheduled_date", dateKey(to))
      // Дата, як і раніше; час і id — лише щоб зріз на стелі був детермінованим.
      .order("scheduled_date", { ascending: true })
      .order("scheduled_time", { ascending: true })
      .order("id", { ascending: true })
      .limit(CEO_EXPORT_MAX_ROWS + 1);   // +1 — проба «чи є рядок понад стелю»
    if (qRes.error) return fail("queue_entries", qRes.error);
    const all = qRes.data ?? [];
    truncated = all.length > CEO_EXPORT_MAX_ROWS;
    const entries = truncated ? all.slice(0, CEO_EXPORT_MAX_ROWS) : all;

    if (entries.length) {
      // Каталог — для оцінки позицій без снапшот-ціни (як catalog_est_sum RPC 0114);
      // кабінети — УСІ, включно з вимкненими: це рядки ЗАПИСІВ, а не список кабінетів.
      const [svRes, rmRes] = await Promise.all([
        supabase.from("services").select(CEO_SERVICE_COLS).in("clinic_id", clinicIds).eq("active", true).order("sort_order").order("id"),
        supabase.from("rooms").select("id, name").in("clinic_id", clinicIds),
      ]);
      /* Збій каталогу — це НЕ «доходу немає»: без нього стовпець «Дохід» мовчки
         занизився б до снапшот-цін (так робив клієнт до с79). Тому — помилка. */
      if (svRes.error) return fail("services", svRes.error);
      if (rmRes.error) return fail("rooms", rmRes.error);
      const catalog = buildCsvCatalog(svRes.data ?? []);
      const roomNames = new Map((rmRes.data ?? []).map((r) => [String(r.id).toLowerCase(), r.name || ""]));
      rows = ceoExportRows(entries, catalog, (id) => roomNames.get(id.toLowerCase()) ?? "");
      // clinic_id події — з РЯДКА БД, а не з параметра клієнта (урок с25).
      for (const e of entries) byClinic.set(e.clinic_id, (byClinic.get(e.clinic_id) ?? 0) + 1);
    }
  }
  const csv = buildCsv([CEO_EXPORT_HEAD, ...rows]);

  /* 4. Журнал: по події в КОЖЕН центр, чиї рядки пішли у файл, — лише його число. */
  for (const [clinicId, n] of byClinic) {
    await emitImportantEvent({
      clinicId,
      actorId: me.id,
      eventType: "patient_data.exported",
      entityType: "staff",
      entityId: me.id,
      details: { source: "ceo_dashboard", rows: n, format: "csv" },
    });
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ceoExportFileName(period)}"`,
      "Cache-Control": "no-store",
      "X-Export-Rows": String(rows.length),
      "X-Export-Truncated": truncated ? "1" : "0",
    },
  });
}
