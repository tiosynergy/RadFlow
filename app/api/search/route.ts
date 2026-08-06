import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireRole, type Caller } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError } from "@/lib/validation";
import { wallDayKey } from "@/lib/incidents";
import { modalityCode } from "@/lib/studies";
import { entryMatchesTerm, idMatches, normSearchText, phoneMatches, studiesArr, studiesText } from "@/lib/searchText";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  normalizeSearchRequest,
  SearchRequestSchema,
  type NormalizedSearchFilters,
  type RoleScope,
  type SearchCursor,
  type SearchResponse,
  type SearchResultItem,
} from "@/lib/searchContract";
import type { Database } from "@/supabase/types";

/* ===== POST /api/search — универсальный поиск пациентов и исследований (с22) =====

   Одна функция для всех пяти ролей, РАЗНЫЕ области доступа (ТЗ §5):
   область вычисляется здесь из СЕССИИ (роль/клиника/назначенные кабинеты/гранты),
   клиентские clinicIds/roomIds могут только сузить её (нормализатор).

   Слои: auth (requireRole) → resolveSearchScope → SearchRequestSchema+normalizer →
   адаптер источника (queue | waitlist) → Supabase ПОД RLS → SearchResponse.

   Почему НЕ service-role: запросы идут RLS-клиентом сессии (gate.supabase) —
   RLS остаётся последним рубежом под нашими явными фильтрами области. Сервер при
   этом сам сужает область (радиолог: только назначенные кабинеты — RLS у него
   шире бизнес-правила экрана; направник: только собственные направления).

   Term-матчинг (имя/телефон-по-цифрам/type+region из studies[]) выполняется
   app-side поверх батчей, потому что: телефон в БД хранится форматированным
   («+380 67 123 45 67» — ilike не найдёт середину), а studies — JSONB-массив
   (PostgREST не умеет ilike по элементам). Скан ограничен MAX_SCAN строк на
   запрос; курсор = позиция последней ПРОСМОТРЕННОЙ строки в порядке БД, поэтому
   пагинация без дублей и пропусков даже при недоборе страницы. На текущих
   объёмах (сотни строк) это укладывается с запасом; путь масштабирования
   (нормализованное поисковое поле + trigram) — docs/SEARCH.md. */

const BATCH = 100;      // строк за один запрос к БД
const MAX_SCAN = 500;   // потолок просмотренных строк на один HTTP-запрос
const DB_TIMEOUT_MS = 8000;

type DB = SupabaseClient<Database>;

/* ---------- Область доступа роли (из сессии, не от клиента) ---------- */

async function resolveSearchScope(supabase: DB, me: Caller): Promise<RoleScope | { error: string; status: number }> {
  const base = {
    userId: me.id,
    role: me.role,
    roomIds: null as string[] | null,
    roomIdsByClinic: null as Record<string, string[] | null> | null,
    ownReferrerOnly: false,
    showReferrerName: false,
    showPhone: true,
  };
  if (me.role === "admin" || me.role === "registrar") {
    if (!me.clinic_id) return { error: "Обліковий запис без центру", status: 403 };
    return { ...base, clinicIds: [me.clinic_id], sources: ["queue", "waitlist"], showReferrerName: true };
  }
  if (me.role === "radiologist") {
    if (!me.clinic_id) return { error: "Обліковий запис без центру", status: 403 };
    const { data, error } = await supabase.from("radiologist_rooms").select("room_id").eq("profile_id", me.id);
    if (error) return { error: safeDbError("api/search.scope.rad", error), status: 400 };
    // Радиолог видит ТОЛЬКО назначенные кабинеты (RLS у него шире — сужаем сами).
    // Лист ожидания радиологу не показываем (ТЗ §5).
    return { ...base, clinicIds: [me.clinic_id], roomIds: (data || []).map((r) => r.room_id), sources: ["queue"] };
  }
  if (me.role === "referrer") {
    const { data, error } = await supabase
      .from("referral_access")
      .select("clinic_id, status, room_ids")
      .eq("referrer_id", me.id)
      .eq("status", "active");
    if (error) return { error: safeDbError("api/search.scope.ref", error), status: 400 };
    const roomIdsByClinic: Record<string, string[] | null> = {};
    (data || []).forEach((a) => {
      const list = Array.isArray(a.room_ids) && a.room_ids.length ? (a.room_ids as string[]) : null;
      roomIdsByClinic[a.clinic_id] = list;
    });
    // Направник ищет только СОБСТВЕННЫЕ направления/строки листа (доступ не расширяем).
    return {
      ...base,
      clinicIds: (data || []).map((a) => a.clinic_id),
      roomIdsByClinic,
      ownReferrerOnly: true,
      sources: ["queue", "waitlist"],
    };
  }
  if (me.role === "ceo") {
    const { data, error } = await supabase.from("ceo_access").select("clinic_id").eq("ceo_id", me.id).eq("status", "active");
    if (error) return { error: safeDbError("api/search.scope.ceo", error), status: 400 };
    // CEO — read-only: телефоны в выдаче не показываем (его экраны их и не показывают).
    return { ...base, clinicIds: (data || []).map((a) => a.clinic_id), sources: ["queue", "waitlist"], showPhone: false };
  }
  return { error: "Недостатньо прав", status: 403 };
}

/* ---------- Общие пост-фильтры (term / studyQuery / модальность / контраст) ---------- */

type StudyRow = { id: string; patient_name: string | null; patient_phone: string | null; studies: unknown };

function passesStudyFilters(row: StudyRow, f: NormalizedSearchFilters, waitlistModality?: string | null): boolean {
  if (f.termKind === "id") {
    // с25: пошук за ID запису (короткий ID з «Журналу дій» = префікс uuid).
    if (!idMatches(row.id, f.term)) return false;
  } else if (f.termKind === "phone") {
    if (!phoneMatches(row.patient_phone, f.term)) return false;
  } else if (f.termKind === "text") {
    if (!entryMatchesTerm(row, f.term)) return false;
  }
  if (f.studyQuery) {
    const st = normSearchText(studiesText(row.studies));
    const qn = normSearchText(f.studyQuery);
    if (!st || !qn.split(" ").every((w) => st.includes(w))) return false;
  }
  if (f.modalities) {
    const arr = studiesArr(row.studies);
    const codes = new Set(arr.map((s) => modalityCode(s.type)));
    if (waitlistModality) codes.add(modalityCode(waitlistModality));
    if (!f.modalities.some((m) => codes.has(m))) return false;
  }
  if (f.contrast !== null) {
    const any = studiesArr(row.studies).some((s) => !!s.contrast);
    if (f.contrast !== any) return false;
  }
  return true;
}

/* ---------- Маршрут открытия результата (существующие экраны, без новых прав) ---------- */

function hrefFor(scope: RoleScope, source: "queue" | "waitlist", row: { id: string; scheduled_date?: string | null; status?: string | null }): string | null {
  if (scope.role === "ceo") return null; // у CEO нет экрана записи — только read-only список
  if (source === "queue") {
    const d = row.scheduled_date ? `date=${row.scheduled_date}&` : "";
    if (scope.role === "radiologist") return `/radiologist?${d}entry=${row.id}`;
    if (scope.role === "referrer") return `/referral?tab=mine&${d}entry=${row.id}`;
    return `/queue?${d}entry=${row.id}`;
  }
  if (scope.role === "referrer") return `/referral?tab=waitlist&entry=${row.id}`;
  const tab = row.status === "waiting" ? "waiting" : row.status === "scheduled" ? "scheduled" : "removed";
  return `/waitlist?tab=${tab}&entry=${row.id}`;
}

/* ---------- Адаптер: очередь ---------- */

const QUEUE_COLS =
  "id, clinic_id, room_id, case_id, scheduled_date, scheduled_time, status, priority_level, cito, patient_name, patient_phone, studies, referrer_id";

type QueueRow = {
  id: string; clinic_id: string; room_id: string | null; case_id: string | null;
  scheduled_date: string | null; scheduled_time: string | null; status: string;
  priority_level: "cito" | "urgent" | "planned"; cito: boolean;
  patient_name: string | null; patient_phone: string | null; studies: unknown;
  referrer_id: string | null; referrer?: { full_name: string | null } | null;
};

/* Keyset-условие продолжения после (date, time, id) последней просмотренной строки.
   scheduled_time — nullable text (ревью с22 MEDIUM-4): порядок фиксируем явно —
   null считается «наименьшим» временем (asc: nulls first, desc: nulls last), и
   условие раскладывается по веткам is.null / not.is.null. Алфавит значений зажат
   схемой курсора — синтаксис .or() не ломается. */
function queueKeysetOr(c: Extract<SearchCursor, { s: "queue" }>, asc: boolean): string {
  const op = asc ? "gt" : "lt";
  const parts: string[] = [`scheduled_date.${op}.${c.d}`];
  if (c.u) {
    // «Время ненадёжно» (LOW-A р2): непустой scheduled_time вне безопасного
    // алфавита нельзя вставить в .or(). Деградируем до (date, id): внутри даты
    // возможен повторный скан соседей — его гасит дедуп по id в обработчике.
    parts.push(`and(scheduled_date.eq.${c.d},id.${op}.${c.id})`);
    return parts.join(",");
  }
  if (c.t === null) {
    if (asc) {
      parts.push(`and(scheduled_date.eq.${c.d},scheduled_time.is.null,id.gt.${c.id})`);
      parts.push(`and(scheduled_date.eq.${c.d},scheduled_time.not.is.null)`);
    } else {
      parts.push(`and(scheduled_date.eq.${c.d},scheduled_time.is.null,id.lt.${c.id})`);
    }
  } else if (asc) {
    parts.push(`and(scheduled_date.eq.${c.d},scheduled_time.gt."${c.t}")`);
    parts.push(`and(scheduled_date.eq.${c.d},scheduled_time.eq."${c.t}",id.gt.${c.id})`);
  } else {
    parts.push(`and(scheduled_date.eq.${c.d},scheduled_time.lt."${c.t}")`);
    parts.push(`and(scheduled_date.eq.${c.d},scheduled_time.is.null)`);
    parts.push(`and(scheduled_date.eq.${c.d},scheduled_time.eq."${c.t}",id.lt.${c.id})`);
  }
  return parts.join(",");
}

/** scheduled_time для курсора: безопасный алфавит → значение; null → null;
 *  непустое «кривое» значение → null + флаг u (деградация keyset до date+id). */
function cursorTimeParts(t: string | null): { t: string | null; u?: boolean } {
  if (t === null) return { t: null };
  // Пустая строка и значения вне алфавита («9:00 AM») — «ненадёжное» время:
  // деградация до (date, id). На проде таких строк 0 (замер с22), форма пишет «HH:MM».
  return /^[0-9:]{1,8}$/.test(t) ? { t: t.slice(0, 8) } : { t: null, u: true };
}

function queueBatch(supabase: DB, scope: RoleScope, f: NormalizedSearchFilters, cursor: SearchCursor | null) {
  const asc = f.sort === "date_asc";
  const cols = scope.showReferrerName ? QUEUE_COLS + ", referrer:referrer_id(full_name)" : QUEUE_COLS;
  let q = supabase
    .from("queue_entries")
    .select(cols)
    .in("clinic_id", f.clinicIds)
    .gte("scheduled_date", f.dateFrom)
    .lte("scheduled_date", f.dateTo);
  if (f.roomIds) q = q.in("room_id", f.roomIds);
  if (scope.ownReferrerOnly) q = q.eq("referrer_id", scope.userId);
  if (f.queueStatuses) q = q.in("status", f.queueStatuses);
  if (f.priorities) q = q.in("priority_level", f.priorities);
  if (f.referrerIds) q = q.in("referrer_id", f.referrerIds);
  if (cursor && cursor.s === "queue") q = q.or(queueKeysetOr(cursor, asc));
  return q
    .order("scheduled_date", { ascending: asc })
    // null-время — «наименьшее»: asc → першими, desc → останніми (зеркало queueKeysetOr).
    .order("scheduled_time", { ascending: asc, nullsFirst: asc })
    .order("id", { ascending: asc })
    .limit(BATCH)
    .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
}

/* ---------- Адаптер: лист ожидания ---------- */

const WL_COLS =
  "id, clinic_id, room_id, status, priority_level, modality, patient_name, patient_phone, studies, created_at, referrer_id, created_by";

type WlRow = {
  id: string; clinic_id: string; room_id: string | null; status: string;
  priority_level: "cito" | "urgent" | "planned"; modality: string | null;
  patient_name: string | null; patient_phone: string | null; studies: unknown;
  created_at: string; referrer_id: string | null; created_by: string | null;
};

/** Сдвиг календарного ключа на N дней (UTC-арифметика по ключу, не по «сейчас»). */
function shiftKey(dateKey: string, days: number): string {
  return new Date(new Date(dateKey + "T00:00:00Z").getTime() + days * 86400000).toISOString().slice(0, 10);
}

/* Календарный день timestamptz-момента В ЗОНЕ КЛИНИКИ (ревью с22 MEDIUM-3):
   строка листа, созданная 06.08 в 01:30 Киева, — это 05.08 по UTC; границы и
   отображаемая дата обязаны считаться по зоне клиники записи. en-CA даёт YYYY-MM-DD. */
const dayKeyFmtCache = new Map<string, Intl.DateTimeFormat>();
function dayKeyInTz(iso: string, tz?: string): string {
  if (!tz) return iso.slice(0, 10);
  try {
    let fmt = dayKeyFmtCache.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      dayKeyFmtCache.set(tz, fmt);
    }
    return fmt.format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function waitlistBatch(supabase: DB, scope: RoleScope, f: NormalizedSearchFilters, cursor: SearchCursor | null) {
  const asc = f.sort === "date_asc";
  let q = supabase
    .from("waitlist_entries")
    .select(WL_COLS)
    .in("clinic_id", f.clinicIds)
    // Грубые границы ±1 день (created_at — timestamptz, а фильтр — календарные дни
    // в зоне клиники): точное попадание в [dateFrom..dateTo] проверяется в обработчике
    // через dayKeyInTz по зоне клиники записи (ревью с22 MEDIUM-3).
    .gte("created_at", shiftKey(f.dateFrom, -1))
    .lte("created_at", shiftKey(f.dateTo, 1) + "T23:59:59.999Z");
  if (f.roomIds) q = q.in("room_id", f.roomIds);
  // Направник видит в листе ожидания ТОЛЬКО собственные строки (зеркало RLS waitlist_select).
  if (scope.ownReferrerOnly) q = q.eq("created_by", scope.userId);
  if (f.waitlistStatuses) q = q.in("status", f.waitlistStatuses);
  if (f.priorities) q = q.in("priority_level", f.priorities);
  if (cursor && cursor.s === "waitlist") {
    const { c, id } = cursor;
    const op = asc ? "gt" : "lt";
    q = q.or(`created_at.${op}."${c}",and(created_at.eq."${c}",id.${op}.${id})`);
  }
  return q
    .order("created_at", { ascending: asc })
    .order("id", { ascending: asc })
    .limit(BATCH)
    .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
}

/* ---------- Основной обработчик ---------- */

export async function POST(req: Request) {
  // Любой авторизованный пользователь с профилем; частота — 60 запросов/мин
  // (дебаунс на клиенте 350 мс, но лимит защищает и от скриптованного перебора).
  const gate = await requireRole(null, { rateLimit: { key: "search", max: 60, windowSeconds: 60 } });
  if (!gate.ok) return gate.res;
  const { supabase, me } = gate;

  const parsed = await parseBody("api/search", req, SearchRequestSchema, "Некоректний запит пошуку");
  if (!parsed.ok) return parsed.res;

  const scope = await resolveSearchScope(supabase, me);
  if ("error" in scope) return NextResponse.json({ error: scope.error }, { status: scope.status });

  // Зоны клиник: «сегодня» и признак будущей записи считаем по зоне клиники записи.
  const tzByClinic: Record<string, string> = {};
  let tz0: string | undefined;
  if (scope.clinicIds.length) {
    const { data: cl, error: clErr } = await supabase.from("clinics").select("id, timezone").in("id", scope.clinicIds);
    if (clErr) return NextResponse.json({ error: safeDbError("api/search.clinics", clErr) }, { status: 400 });
    (cl || []).forEach((c) => { if (c.timezone) tzByClinic[c.id] = c.timezone; });
    tz0 = cl?.[0]?.timezone || undefined;
  }
  const todayKey = wallDayKey(tz0);

  const norm = normalizeSearchRequest(parsed.data, scope, todayKey);
  if (!norm.ok) {
    return NextResponse.json({ error: norm.error, code: norm.code }, { status: norm.code === "forbidden_filter" ? 403 : 400 });
  }
  const f = norm.filters;
  const { limit: _limit, ...appliedFilters } = f;

  const empty: SearchResponse = { items: [], nextCursor: null, hasMore: false, appliedFilters };
  // Пустая область (нет активных грантов / радиолог без кабинетов) — честный пустой
  // результат БЕЗ запроса к БД (и без «ошибки», это законное состояние).
  if (!f.clinicIds.length || (f.roomIds !== null && !f.roomIds.length && f.source === "queue")) {
    return NextResponse.json(empty);
  }

  const cursor = decodeSearchCursor(parsed.data.cursor, f.source, f.sort);

  const items: SearchResultItem[] = [];
  // Дедуп в пределах запроса: страхует деградированный keyset (флаг u) от
  // повторного скана соседей внутри одной даты.
  const seenIds = new Set<string>();
  let scanned = 0;
  let lastKeyset: SearchCursor | null = cursor;
  let lastAcceptedKeyset: SearchCursor | null = null;
  let exhausted = false;
  let overflow = false; // нашли limit+1-е совпадение

  try {
    while (!exhausted && !overflow && scanned < MAX_SCAN) {
      const { data, error } =
        f.source === "queue"
          ? await queueBatch(supabase, scope, f, lastKeyset)
          : await waitlistBatch(supabase, scope, f, lastKeyset);
      // Ошибка БД — это ОШИБКА, а не «нічого не знайдено» (ТЗ §9).
      if (error) return NextResponse.json({ error: safeDbError("api/search." + f.source, error) }, { status: 400 });
      const rows = (data || []) as unknown as (QueueRow[] | WlRow[]);
      if (!rows.length) { exhausted = true; break; }

      for (const row of rows) {
        scanned++;
        lastKeyset =
          f.source === "queue"
            ? { s: "queue", o: f.sort, d: (row as QueueRow).scheduled_date || todayKey, ...cursorTimeParts((row as QueueRow).scheduled_time), id: row.id }
            : { s: "waitlist", o: f.sort, c: (row as WlRow).created_at, id: row.id };
        // Дедуп ПОСЛЕ обновления keyset: курсор продвигается и по дублю, иначе
        // батч из одних дублей зациклил бы выборку до упора в MAX_SCAN.
        if (seenIds.has(row.id)) {
          if (scanned >= MAX_SCAN) break;
          continue;
        }
        seenIds.add(row.id);

        // Вейтлист: точное попадание календарного дня В ЗОНЕ КЛИНИКИ записи
        // (батч выбран с грубыми границами ±1 день — см. waitlistBatch).
        let wlDay: string | null = null;
        if (f.source === "waitlist") {
          wlDay = dayKeyInTz((row as WlRow).created_at, tzByClinic[row.clinic_id] ?? tz0);
          if (wlDay < f.dateFrom || wlDay > f.dateTo) {
            if (scanned >= MAX_SCAN) break;
            continue;
          }
        }

        const wlMod = f.source === "waitlist" ? (row as WlRow).modality : null;
        if (passesStudyFilters(row as StudyRow, f, wlMod)) {
          if (items.length >= f.limit) { overflow = true; break; }
          const qr = row as QueueRow;
          const date = f.source === "queue" ? qr.scheduled_date : wlDay;
          const clinicTz = tzByClinic[row.clinic_id];
          items.push({
            source: f.source,
            recordId: row.id,
            caseId: f.source === "queue" ? qr.case_id : null,
            clinicId: row.clinic_id,
            roomId: row.room_id,
            date,
            time: f.source === "queue" ? qr.scheduled_time : null,
            patientName: row.patient_name || "—",
            patientPhone: scope.showPhone ? row.patient_phone : null,
            studies: studiesArr(row.studies).map((s) => ({ type: s.type || null, region: s.region || null, contrast: !!s.contrast })),
            status: row.status,
            priority: row.priority_level,
            referrerName: scope.showReferrerName ? ((qr.referrer && qr.referrer.full_name) || null) : null,
            isFuture: !!date && date > wallDayKey(clinicTz ?? tz0),
            href: hrefFor(scope, f.source, { id: row.id, scheduled_date: f.source === "queue" ? qr.scheduled_date : null, status: row.status }),
          });
          lastAcceptedKeyset = lastKeyset;
        }
        if (scanned >= MAX_SCAN) break;
      }
      if (rows.length < BATCH && !overflow) exhausted = true;
    }
  } catch (e) {
    // Таймаут БД / обрыв — тоже ошибка, а не пустой список.
    const msg = e instanceof Error && e.name === "TimeoutError" ? "Пошук триває занадто довго — звузьте фільтри" : "Помилка пошуку";
    return NextResponse.json({ error: msg }, { status: 504 });
  }

  // Курсор продолжения: после limit+1-го совпадения — с последнего ОТДАННОГО
  // элемента (следующая страница переоткроет «переполнившее» совпадение);
  // после упора в MAX_SCAN — с последней ПРОСМОТРЕННОЙ строки (ничего не пропускаем).
  const hasMore = overflow || (!exhausted && scanned >= MAX_SCAN);
  const nextCursor = hasMore ? encodeSearchCursor((overflow ? lastAcceptedKeyset : lastKeyset) as SearchCursor) : null;

  const res: SearchResponse = { items, nextCursor, hasMore, appliedFilters };
  return NextResponse.json(res);
}
