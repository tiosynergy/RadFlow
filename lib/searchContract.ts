/* ===== RadFlow — универсальный поиск: единый контракт фильтров (с22) =====

   ОДНА Zod-схема запроса для: UI страницы «Пошук» → POST /api/search → (этап 2)
   LangChain structured output. Никаких параллельных несовместимых схем.

   Границы безопасности (ТЗ §5/§8.3):
   - clinic_id / роль / user_id НЕ принимаются от клиента: область доступа (RoleScope)
     вычисляет сервер из сессии; клиентские clinicIds/roomIds могут только СУЗИТЬ её;
   - никакие имена колонок / операторы / sort-выражения от клиента (и будущего AI)
     не принимаются — только перечисленные здесь поля-фильтры;
   - cursor непрозрачный, при декоде валидируется схемой и привязан к source+sort. */

import { z } from "zod";
import { zDateKey, zUuid } from "@/lib/validation";
import { digitsOf, isIdLikeQuery, isPhoneLikeQuery, SEARCH_TERM_MAX } from "@/lib/searchText";
import type { Database } from "@/supabase/types";

export type UserRole = Database["public"]["Enums"]["user_role"];
export type SearchSource = "queue" | "waitlist";
export type SearchSort = "relevance" | "date_desc" | "date_asc";

export const SEARCH_LIMIT_DEFAULT = 25;
export const SEARCH_LIMIT_MAX = 100;
/** Максимальный диапазон дат (дней) одного запроса. */
export const SEARCH_SPAN_MAX_DAYS = 731;
/** Дефолтная глубина поиска в обе стороны от «сегодня» (дней), если даты не заданы. */
export const SEARCH_SPAN_DEFAULT_DAYS = 365;

const QUEUE_STATUSES = ["scheduled", "waiting", "in_progress", "done", "no_show", "cancelled", "not_held", "needs_reschedule"] as const;
const WAITLIST_STATUSES = ["waiting", "scheduled", "cancelled", "expired"] as const;
const MODALITIES = ["MRI", "CT", "US", "XRAY", "MAMMO", "OTHER"] as const;
const PRIORITIES = ["cito", "urgent", "planned"] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];
export type SearchModality = (typeof MODALITIES)[number];
export type SearchPriority = (typeof PRIORITIES)[number];

/** ЕДИНАЯ схема запроса поиска (UI / API / будущий AI-парсер). */
export const SearchRequestSchema = z.object({
  term: z.string().max(SEARCH_TERM_MAX).optional(),
  sources: z.array(z.enum(["queue", "waitlist"])).max(2).optional(),
  clinicIds: z.array(zUuid).max(20).optional(),
  roomIds: z.array(zUuid).max(20).optional(),
  dateFrom: zDateKey.optional(),
  dateTo: zDateKey.optional(),
  queueStatuses: z.array(z.enum(QUEUE_STATUSES)).max(QUEUE_STATUSES.length).optional(),
  waitlistStatuses: z.array(z.enum(WAITLIST_STATUSES)).max(WAITLIST_STATUSES.length).optional(),
  modalities: z.array(z.enum(MODALITIES)).max(MODALITIES.length).optional(),
  studyQuery: z.string().max(SEARCH_TERM_MAX).optional(),
  contrast: z.boolean().optional(),
  priorities: z.array(z.enum(PRIORITIES)).max(PRIORITIES.length).optional(),
  referrerIds: z.array(zUuid).max(20).optional(),
  sort: z.enum(["relevance", "date_desc", "date_asc"]).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/* ---------- Область доступа роли (вычисляется ТОЛЬКО сервером из сессии) ---------- */

export type RoleScope = {
  role: UserRole;
  userId: string;
  /** Разрешённые клиники (персонал — своя; referrer/ceo — из таблиц доступа). */
  clinicIds: string[];
  /** Радиолог: назначенные кабинеты (пусто = доступа нет). null = кабинеты не ограничены ролью. */
  roomIds: string[] | null;
  /** Направник: ограничение кабинетов по клинике из referral_access.room_ids
   *  (0137: null = все кабинеты центра, массив = ровно эти, [] = ни одного). */
  roomIdsByClinic: Record<string, string[] | null> | null;
  /** Направник: искать только собственные направления (referrer_id = userId). */
  ownReferrerOnly: boolean;
  /** Разрешённые источники (радиологу лист ожидания не показываем — ТЗ §5). */
  sources: SearchSource[];
  /** Поле «направник» в результате видит только персонал центра. */
  showReferrerName: boolean;
  /** CEO — read-only агрегатные экраны: телефон в выдаче не показываем. */
  showPhone: boolean;
};

/* ---------- Нормализованные фильтры (то, что реально применит сервер) ---------- */

export type NormalizedSearchFilters = {
  term: string;
  /** Телефоноподобный запрос (сравнение по цифрам) или текстовый. */
  termKind: "id" | "phone" | "text" | "none";
  source: SearchSource;
  clinicIds: string[];
  roomIds: string[] | null;
  dateFrom: string;
  dateTo: string;
  queueStatuses: QueueStatus[] | null;
  waitlistStatuses: WaitlistStatus[] | null;
  modalities: SearchModality[] | null;
  studyQuery: string;
  contrast: boolean | null;
  priorities: SearchPriority[] | null;
  referrerIds: string[] | null;
  sort: Exclude<SearchSort, "relevance">;
  limit: number;
};

export type NormalizeResult =
  | { ok: true; filters: NormalizedSearchFilters }
  | { ok: false; code: "bad_request" | "term_too_short" | "bad_range" | "forbidden_filter"; error: string };

const dayMs = 24 * 3600 * 1000;
function shiftDateKey(dateKey: string, days: number): string {
  const d = new Date(dateKey + "T00:00:00Z");
  const s = new Date(d.getTime() + days * dayMs);
  return s.toISOString().slice(0, 10);
}

/**
 * Нормализатор: применяет безопасные дефолты, сужает запрос областью роли,
 * отбрасывает недоступные фильтры. Расширить область клиентский ввод НЕ может.
 * `todayKey` передаётся снаружи (зона клиники), чтобы логика была чистой и тестируемой.
 */
export function normalizeSearchRequest(input: unknown, scope: RoleScope, todayKey: string): NormalizeResult {
  const parsed = SearchRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "bad_request", error: "Некоректний запит пошуку" };
  const r = parsed.data;

  // --- источник: пересечение запрошенного с разрешённым; MVP — один источник на запрос
  const wanted = r.sources && r.sources.length ? r.sources : [scope.sources[0]];
  const allowedSources = wanted.filter((s) => scope.sources.includes(s));
  if (!allowedSources.length) return { ok: false, code: "forbidden_filter", error: "Джерело пошуку недоступне цій ролі" };
  const source = allowedSources[0];

  // --- клиники: клиент может только СУЗИТЬ список scope.clinicIds
  let clinicIds = scope.clinicIds;
  if (r.clinicIds && r.clinicIds.length) {
    const own = new Set(scope.clinicIds);
    clinicIds = r.clinicIds.filter((id) => own.has(id));
    if (!clinicIds.length) return { ok: false, code: "forbidden_filter", error: "Обрана клініка недоступна" };
  }
  if (!clinicIds.length) {
    // У роли нет ни одной клиники (нет активных грантов) — пустая область, не ошибка.
    clinicIds = [];
  }

  // --- кабинеты: пересечение с назначенными (радиолог). Для направника фильтр
  // кабинета — только УДОБСТВО (сузить СВОИ направления): безопасность держат
  // `referrer_id = userId` в адаптере и RLS, а «лимит гранта» тут НЕ применяем —
  // ревью с22 (MEDIUM-1) показало, что глобальный allowlist по смешанным грантам
  // ({C1:[R1], C2:null}) молча обнулял легитимный кабинет «безлимитной» клиники.
  let roomIds: string[] | null = r.roomIds && r.roomIds.length ? [...new Set(r.roomIds)] : null;
  if (scope.roomIds !== null) {
    const own = new Set(scope.roomIds);
    roomIds = (roomIds ?? scope.roomIds).filter((id) => own.has(id));
    // Радиолог без назначенных кабинетов ищет «нигде» — пустой результат, не ошибка.
  }

  // --- даты: дефолтная глубина ±365 дней, максимум SEARCH_SPAN_MAX_DAYS
  const dateFrom = r.dateFrom || shiftDateKey(todayKey, -SEARCH_SPAN_DEFAULT_DAYS);
  const dateTo = r.dateTo || shiftDateKey(todayKey, SEARCH_SPAN_DEFAULT_DAYS);
  if (dateFrom > dateTo) return { ok: false, code: "bad_range", error: "Дата «з» пізніша за дату «до»" };
  const span = (new Date(dateTo + "T00:00:00Z").getTime() - new Date(dateFrom + "T00:00:00Z").getTime()) / dayMs;
  if (span > SEARCH_SPAN_MAX_DAYS) return { ok: false, code: "bad_range", error: "Занадто широкий період — звузьте діапазон дат" };

  // --- текстовый запрос: не гоняем глобальный поиск по 1 символу (ТЗ §8.2)
  const term = (r.term || "").trim().replace(/\s+/g, " ");
  let termKind: NormalizedSearchFilters["termKind"] = "none";
  if (term) {
    if (isIdLikeQuery(term)) {
      // с25: ID запису з «Журналу дій» (короткий 8-значний або повний uuid).
      termKind = "id";
    } else if (isPhoneLikeQuery(term)) {
      if (digitsOf(term).length < 3) return { ok: false, code: "term_too_short", error: "Введіть щонайменше 3 цифри номера" };
      termKind = "phone";
    } else {
      if (term.length < 2) return { ok: false, code: "term_too_short", error: "Введіть щонайменше 2 символи" };
      termKind = "text";
    }
  }

  // --- фильтры, доступные не всем ролям
  const referrerIds =
    scope.showReferrerName && r.referrerIds && r.referrerIds.length ? [...new Set(r.referrerIds)] : null;

  const sort: NormalizedSearchFilters["sort"] = r.sort === "date_asc" ? "date_asc" : "date_desc";
  // «relevance» зарезервирован контрактом (этап AI); в MVP детерминированно = date_desc.

  return {
    ok: true,
    filters: {
      term,
      termKind,
      source,
      clinicIds,
      roomIds,
      dateFrom,
      dateTo,
      queueStatuses: r.queueStatuses && r.queueStatuses.length ? [...new Set(r.queueStatuses)] : null,
      waitlistStatuses: r.waitlistStatuses && r.waitlistStatuses.length ? [...new Set(r.waitlistStatuses)] : null,
      modalities: r.modalities && r.modalities.length ? [...new Set(r.modalities)] : null,
      studyQuery: (r.studyQuery || "").trim().replace(/\s+/g, " ").slice(0, SEARCH_TERM_MAX),
      contrast: typeof r.contrast === "boolean" ? r.contrast : null,
      priorities: r.priorities && r.priorities.length ? [...new Set(r.priorities)] : null,
      referrerIds,
      sort,
      limit: r.limit ?? SEARCH_LIMIT_DEFAULT,
    },
  };
}

/* ---------- Cursor (стабильная keyset-пагинация) ---------- */

/* Курсор — позиция ПОСЛЕДНЕЙ ПРОСМОТРЕННОЙ строки в порядке БД (не последнего
   совпадения): серверная фильтрация по term идёт поверх батчей, и продолжение
   «после последней просмотренной» гарантирует отсутствие дублей и пропусков. */

const QueueCursorSchema = z.object({
  s: z.literal("queue"),
  o: z.enum(["date_desc", "date_asc"]),
  d: zDateKey,          // scheduled_date последней просмотренной строки
  // scheduled_time — text «HH:MM» ИЛИ null (колонка nullable — ревью с22 MEDIUM-4).
  // Жёсткий алфавит, потому что значение уходит в PostgREST .or()-фильтр
  // (запятые/скобки/кавычки сломали бы синтаксис).
  t: z.union([z.string().regex(/^[0-9:]{1,8}$/), z.null()]),
  // «Время ненадёжно» (ревью с22 р2 LOW-A): непустое значение вне алфавита выше
  // (данные, вставленные мимо приложения). Keyset деградирует до (date, id);
  // возможный повторный скан внутри запроса гасится дедупом по id в роуте.
  u: z.boolean().optional(),
  id: zUuid,
});
const WaitlistCursorSchema = z.object({
  s: z.literal("waitlist"),
  o: z.enum(["date_desc", "date_asc"]),
  // created_at ISO — тоже уходит в .or()-фильтр, алфавит ограничен.
  c: z.string().regex(/^[0-9T:+.Z-]{10,40}$/),
  id: zUuid,
});
export type QueueCursor = z.infer<typeof QueueCursorSchema>;
export type WaitlistCursor = z.infer<typeof WaitlistCursorSchema>;
export type SearchCursor = QueueCursor | WaitlistCursor;

export function encodeSearchCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** null = курсор отсутствует/битый/не от этого source+sort (клиент начнёт сначала). */
export function decodeSearchCursor(
  raw: string | undefined,
  source: SearchSource,
  sort: "date_desc" | "date_asc"
): SearchCursor | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = source === "queue" ? QueueCursorSchema.safeParse(obj) : WaitlistCursorSchema.safeParse(obj);
  if (!parsed.success) return null;
  if (parsed.data.o !== sort) return null;
  return parsed.data;
}

/* ---------- Результат ---------- */

export type SearchResultStudy = { type: string | null; region: string | null; contrast: boolean };

export type SearchResultItem = {
  source: SearchSource;
  recordId: string;
  caseId: string | null;
  clinicId: string;
  roomId: string | null;
  /** queue: scheduled_date; waitlist: дата создания (YYYY-MM-DD). */
  date: string | null;
  /** queue: scheduled_time «HH:MM»; waitlist: null. */
  time: string | null;
  patientName: string;
  patientPhone: string | null;
  studies: SearchResultStudy[];
  status: string;
  priority: SearchPriority;
  referrerName: string | null;
  isFuture: boolean;
  /** Разрешённый маршрут открытия записи (null — у роли нет экрана перехода). */
  href: string | null;
};

export type SearchResponse = {
  items: SearchResultItem[];
  nextCursor: string | null;
  hasMore: boolean;
  appliedFilters: Omit<NormalizedSearchFilters, "limit">;
};
