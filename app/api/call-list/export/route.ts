import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { zDateKey } from "@/lib/validation";
import { emitImportantEvent } from "@/lib/importantEvents.server";
import { logError } from "@/lib/serverLog";
import { buildCsv } from "@/lib/csv";
import { readPages, type DbErr } from "@/lib/pagedRead";
import {
  CALL_LIST_ENTRY_COLS,
  CALL_LIST_EXPORT_ERR,
  CALL_LIST_EXPORT_HEAD,
  CALL_LIST_STATUSES,
  callListExportFileName,
  callListExportRows,
  compareCallListOrder,
  type CallListExportEntry,
} from "@/lib/callListExport";

/* ===== POST /api/call-list/export — CSV колл-листа з журналом (с80, Н-16) =====

   До с80 файл збирав браузер (CallListBoard.exportCsv): ПІБ, телефон і
   нотатка дзвінка за день ішли у CSV без події в журналі, а екранування формул
   не було ВЗАГАЛІ — нотатка чи ПІБ, що починались із «=», у Excel ставали
   формулою. Той самий клас, що Н-10 (CSV дашборда CEO), і те саме лікування,
   за зразком /api/ceo/export:

     • ГЕЙТ. requireRole(["admin","registrar"], needClinic) + ліміт 10 файлів за
       10 хв (свій ключ `call_list_export`), далі — центр НАЛАШТОВАНИЙ
       (`configured_at`). Це ПОЗИТИВНА форма правила сторінки /call-list:
       радіолога, направника, CEO і персонал без центру вона відводить, іншу
       роль — зупиняє поясненням, ненастроєний центр — веде в /setup; дійти до
       дошки можуть рівно адмін і реєстратор настроєного центру. Центр, якого
       сесія не прочитала, — теж відмова (fail-closed; сторінка в такому разі
       малювала б дошку, але роут, що віддає ПДн, не вгадує).
     • ОБЛАСТЬ. Клієнт шле ЛИШЕ день (`date`, календарний день центру — той,
       що в пікері дошки). Центр — із сесії (profiles.clinic_id), не з тіла:
       чужий центр назвати нічим. strict: зайвий ключ — 400, а не «тихо інший
       файл».
     • ДАНІ — RLS-клієнтом СЕСІЇ (той, що віддав requireRole), не service-role:
       межа лишається на RLS, фільтри роуту (центр, день, статуси
       scheduled/waiting — ті самі, що в `reload` дошки) — друга лінія.
     • СТОРІНКИ ≤1000 (lib/pagedRead.ts, урок M-1 с79: db-max-rows мовчки різав
       вибірку до 1000). День одного центру фізично обмежений сіткою кабінетів,
       тож СТЕЛІ файлу немає — є запобіжник MAX_PAGES (помилка, а не тиша).
       Порядок у файлі — за часом, як на дошці (lib/callListExport.ts).
     • ФАЙЛ — спільним писачем lib/csv.ts: BOM, `;`, лапки, апостроф перед
       формулою (= + - @ TAB CR LF), переводи рядка всередині клітинки →
       пробіл. Колонки — як були: Дата, Час, Пацієнт, Телефон, Процедура,
       Кабінет, Статус, Нотатка.
     • ЖУРНАЛ — подія `patient_data.exported` у журнал центру з числом рядків
       і ДНЕМ файлу. details — { source: "call_list", rows, format: "csv",
       scheduledDate }: ключі ті самі, що вже пропускають усі чотири лінії
       (allowlist, piiViolations, CHECK important_events_no_pii_chk,
       DETAIL_KEYS /api/journal; `scheduledDate` там із 0128); нове лише
       ЗНАЧЕННЯ `call_list`, і заголовок події lib/journalText.ts називає канал
       і день (ревʼю с80, L-3: без дня склад файлу при розборі витоку не
       відновити — день однозначно задає файл разом із центром). clinic_id події — з РЯДКІВ БД (урок с25). fail-OPEN за
       конвенцією 0128: збій журналу файл не скасовує, але не мовчить —
       logError усередині emitImportantEvent. Порожній файл нічого не
       вивантажив — події немає.
     • `no-store`: файл із ПІБ і телефонами не лягає в жоден кеш.

   ⚠️ Межа (та сама, що в T10 моделі загроз для пошуку й у Н-10): журнал
   фіксує ОФІЦІЙНИЙ канал. Ті самі рядки персонал центру може прочитати прямим
   запитом PostgREST зі свого браузера — RLS їх йому віддає; замок — роль і
   центр, а не цей роут. */

export const dynamic = "force-dynamic";

const PATH = "/api/call-list/export";

type EntryRow = CallListExportEntry;

/** Тіло — лише день. strict: `clinicId` чи будь-що інше — 400. */
const CallListExportRequestSchema = z.object({ date: zDateKey }).strict();

export async function POST(req: Request) {
  const gate = await requireRole(["admin", "registrar"], {
    needClinic: true,
    forbidden: "Недостатньо прав для експорту",
    rateLimit: { key: "call_list_export", max: 10, windowSeconds: 600 },
    path: PATH,
  });
  if (!gate.ok) return gate.res;
  const { supabase, me } = gate;

  const parsed = await parseBody("api/call-list/export", req, CallListExportRequestSchema, "Некоректний запит експорту");
  if (!parsed.ok) return parsed.res;
  const { date } = parsed.data;
  const clinicId = me.clinic_id;

  /** Збій читання — 500 і структурований слід без PII (текст помилки чистить logError). */
  const fail = (step: string, err: DbErr | null) => {
    logError({ event: "call_list.export_failed", actorId: me.id, clinicId, errorCode: err?.code ?? "db_error", message: `step=${step} ${err?.message ?? ""}` });
    return NextResponse.json({ error: CALL_LIST_EXPORT_ERR }, { status: 500 });
  };

  /* 1. Центр налаштований — як на сторінці (`configured_at` → інакше /setup). */
  const clRes = await supabase.from("clinics").select("id, configured_at").eq("id", clinicId).maybeSingle();
  if (clRes.error) return fail("clinics", clRes.error);
  if (!clRes.data || !clRes.data.configured_at) {
    logError({ event: "access.denied", actorId: me.id, clinicId, errorCode: clRes.data ? "clinic_not_configured" : "clinic_unreadable", message: `path=${PATH}` });
    return NextResponse.json({ error: "Спершу завершіть налаштування центру" }, { status: 403 });
  }

  /* 2. Записи дня — сторінками за id (keyset), дедуп за id; порядок файлу — нижче. */
  const qRes = await readPages<EntryRow>((after, want) => {
    let q = supabase
      .from("queue_entries")
      .select(CALL_LIST_ENTRY_COLS)
      .eq("clinic_id", clinicId)
      .eq("scheduled_date", date)
      .in("status", [...CALL_LIST_STATUSES]);
    if (after) q = q.gt("id", after.id);
    return q.order("id", { ascending: true }).limit(want);
  }, Infinity);
  if (qRes.error) return fail("queue_entries", qRes.error);
  const entries = qRes.rows.sort(compareCallListOrder);

  let rows: string[][] = [];
  const byClinic = new Map<string, number>();
  if (entries.length) {
    /* Кабінети — УСІ, включно з вимкненими: це рядки ЗАПИСІВ, а не список
       кабінетів (той самий принцип, що roomsById на дошці). */
    const rmRes = await readPages<{ id: string; name: string | null }>((after, want) => {
      let q = supabase.from("rooms").select("id, name").eq("clinic_id", clinicId);
      if (after) q = q.gt("id", after.id);
      return q.order("id", { ascending: true }).limit(want);
    }, Infinity);
    if (rmRes.error) return fail("rooms", rmRes.error);
    const roomNames = new Map(rmRes.rows.map((r) => [String(r.id).toLowerCase(), r.name || ""]));
    rows = callListExportRows(entries, (id) => roomNames.get(id.toLowerCase()) ?? "");
    // clinic_id події — з РЯДКА БД, а не з параметра (урок с25).
    for (const e of entries) byClinic.set(e.clinic_id, (byClinic.get(e.clinic_id) ?? 0) + 1);
  }
  const csv = buildCsv([CALL_LIST_EXPORT_HEAD, ...rows]);

  /* 3. Журнал: подія в центр, чиї рядки пішли у файл, — з його числом рядків. */
  for (const [cid, n] of byClinic) {
    await emitImportantEvent({
      clinicId: cid,
      actorId: me.id,
      eventType: "patient_data.exported",
      entityType: "staff",
      entityId: me.id,
      details: { source: "call_list", rows: n, format: "csv", scheduledDate: date },
    });
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${callListExportFileName(date)}"`,
      "Cache-Control": "no-store",
      "X-Export-Rows": String(rows.length),
    },
  });
}
