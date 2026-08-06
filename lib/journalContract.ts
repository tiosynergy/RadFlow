/* ===== RadFlow — «Журнал дій»: контракт запиту/відповіді (с25, ТЗ §11) =====

   Одна Zod-схема на UI сторінки «Журнал дій» → POST /api/journal.

   Межі безпеки (дзеркало lib/searchContract.ts):
   - clinic_id / роль НЕ приймаються від клієнта: адмін бачить ЛИШЕ свій центр,
     і це вирішує сервер із перевіреної сесії (плюс RLS у БД як друга лінія);
   - жодних імен колонок, операторів чи sort-виразів від клієнта — тільки
     перелічені тут поля-фільтри;
   - cursor непрозорий, при декоді валідується схемою.

   ПРО PII. У журналі імен немає за побудовою (0128). Відповідь несе лише
   ідентифікатори; імена співробітників екран резолвить ОКРЕМО за id під
   чинною RLS (ТЗ §11: «имена загружать по ID под действующей RLS»).
   Тому в JournalItem немає жодного поля з ПІБ/телефоном. */

import { z } from "zod";
import { zUuid, zDateKey } from "@/lib/validation";
import {
  REFERRAL_EVENT_TYPES,
  GENERAL_EVENT_TYPES,
  type ImportantEventType,
  type ImportantEventEntityType,
  type ImportantEventActorRole,
} from "@/lib/importantEvents";

export const JOURNAL_LIMIT_DEFAULT = 50;
export const JOURNAL_LIMIT_MAX = 100;
/** Максимальний діапазон однієї вибірки (днів) — ретенція журналу все одно 180. */
export const JOURNAL_SPAN_MAX_DAYS = 366;
/** Глибина за замовчуванням, якщо період не заданий. */
export const JOURNAL_SPAN_DEFAULT_DAYS = 30;

/** Усі типи подій, які взагалі можуть бути в журналі (для z.enum). */
export const ALL_EVENT_TYPES = [...REFERRAL_EVENT_TYPES, ...GENERAL_EVENT_TYPES] as const;

/** Спеціальне значення фільтра «співробітник»: системні події (actor_id IS NULL). */
export const ACTOR_SYSTEM = "system" as const;

export const JournalRequestSchema = z.object({
  /** Початок періоду (календарний день у зоні центру), включно. */
  dateFrom: zDateKey.optional(),
  /** Кінець періоду (календарний день у зоні центру), включно. */
  dateTo: zDateKey.optional(),
  /** uuid співробітника або "system" (події cron/автоматики). */
  actor: z.union([zUuid, z.literal(ACTOR_SYSTEM)]).optional(),
  /** Типи подій; порожньо = всі. */
  eventTypes: z.array(z.enum(ALL_EVENT_TYPES)).max(ALL_EVENT_TYPES.length).optional(),
  /** ID запису / кейса / гранта — точний пошук по entity_id (ТЗ §11). */
  entityId: zUuid.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(JOURNAL_LIMIT_MAX).optional(),
});
export type JournalRequest = z.infer<typeof JournalRequestSchema>;

/** Рядок журналу. Імен НЕМАЄ — лише ідентифікатори (див. шапку). */
export type JournalItem = {
  id: string;
  /** ISO-інстант; форматується в зоні центру на клієнті. */
  occurredAt: string;
  actorId: string | null;
  actorRole: ImportantEventActorRole;
  eventType: ImportantEventType;
  entityType: ImportantEventEntityType;
  entityId: string;
  subjectReferrerId: string | null;
  changedFields: string[] | null;
  details: Record<string, unknown> | null;
};

export type JournalResponse = {
  items: JournalItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

/* ---------- Курсор: keyset по (occurred_at desc, id desc) ---------- */

export type JournalCursor = { at: string; id: string };

/* `at` іде в PostgREST-фільтр `.or(...)` → алфавіт ОБМЕЖЕНИЙ (канон
   lib/searchContract.ts): інакше лапки й коми в курсорі переписують дерево
   фільтрів усередині or=(…). */
const CursorSchema = z.object({ at: z.string().regex(/^[0-9T:+.Z -]{10,40}$/), id: zUuid });

export function encodeJournalCursor(c: JournalCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Декод курсора з валідацією. Невалідний курсор = null (починаємо спочатку). */
export function decodeJournalCursor(raw: string | undefined): JournalCursor | null {
  if (!raw) return null;
  try {
    const parsed = CursorSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* ---------- Межі доби в зоні центру ---------- */

const offFmtCache = new Map<string, Intl.DateTimeFormat>();

/** Наскільки зона попереду UTC у конкретний момент (мс). */
function offsetAt(ms: number, tz: string): number {
  let f = offFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    offFmtCache.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asIfUtc - ms;
}

/**
 * Початок календарної доби ЦЕНТРУ як ISO-інстант.
 *
 * ⚠️ Зсув зони не можна взяти одним проходом: він залежить від САМОГО
 * моменту, який шукаємо. Тому беремо двох кандидатів і лишаємо того, що
 * витримує round-trip (`c + offset(c) === base`).
 *   • перехід НАЗАД опівночі (Santiago 05.04): валідних кандидатів два —
 *     беремо ранішого, інакше година подій випала б із доби;
 *   • перехід ВПЕРЕД опівночі (Santiago 06.09, Havana 08.03): локальної
 *     півночі НЕ ІСНУЄ, жоден кандидат не сходиться — беремо пізнішого,
 *     тобто перший інстант, який уже належить нашій добі.
 * Звірено з еталоном (бінарний пошук першого інстанта доби) на 12 зонах ×
 * 400 днів: 0 розбіжностей. Одноходовий варіант помилявся на годину у двох
 * днях — ревʼю с25, раунд 2.
 */
export function dayStartIso(dayKey: string, tz?: string): string {
  const base = Date.UTC(+dayKey.slice(0, 4), +dayKey.slice(5, 7) - 1, +dayKey.slice(8, 10));
  if (!tz) return new Date(base).toISOString();
  try {
    const c1 = base - offsetAt(base, tz);
    const c2 = base - offsetAt(c1, tz);
    const cands = Array.from(new Set([c1, c2]));
    const valid = cands.filter((c) => c + offsetAt(c, tz) === base);
    const guess = valid.length ? Math.min(...valid) : Math.max(...cands);
    return new Date(guess).toISOString();
  } catch {
    return new Date(base).toISOString();
  }
}

/* ---------- Нормалізація періоду ---------- */

export type JournalFilters = {
  dateFrom: string;
  dateTo: string;
  actor?: string;
  eventTypes?: ImportantEventType[];
  entityId?: string;
  cursor: JournalCursor | null;
  limit: number;
};

export type JournalNormalizeResult =
  | { ok: true; filters: JournalFilters }
  | { ok: false; code: "bad_range"; error: string };

/** 'YYYY-MM-DD' ± n діб у настінному календарі (без TZ-арифметики). */
export function shiftDayKey(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Скільки діб між двома денними ключами (включно). */
export function spanDays(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Доводить запит до повних фільтрів: період за замовчуванням, межі діапазону.
 * `todayKey` — «сьогодні» в зоні ЦЕНТРУ (рахує сервер, не браузер).
 */
export function normalizeJournalRequest(
  req: JournalRequest,
  todayKey: string
): JournalNormalizeResult {
  const dateTo = req.dateTo ?? todayKey;
  const dateFrom = req.dateFrom ?? shiftDayKey(dateTo, -(JOURNAL_SPAN_DEFAULT_DAYS - 1));

  if (dateFrom > dateTo) {
    return { ok: false, code: "bad_range", error: "Початок періоду пізніше за кінець" };
  }
  if (spanDays(dateFrom, dateTo) > JOURNAL_SPAN_MAX_DAYS) {
    return {
      ok: false,
      code: "bad_range",
      error: `Період задовгий — максимум ${JOURNAL_SPAN_MAX_DAYS} днів`,
    };
  }

  return {
    ok: true,
    filters: {
      dateFrom,
      dateTo,
      actor: req.actor,
      eventTypes: req.eventTypes?.length ? [...req.eventTypes] : undefined,
      entityId: req.entityId,
      cursor: decodeJournalCursor(req.cursor),
      limit: req.limit ?? JOURNAL_LIMIT_DEFAULT,
    },
  };
}
