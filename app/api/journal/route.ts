import { NextResponse } from "next/server";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError } from "@/lib/validation";
import { wallDayKey } from "@/lib/incidents";
import {
  JournalRequestSchema,
  normalizeJournalRequest,
  encodeJournalCursor,
  dayStartIso,
  shiftDayKey,
  ACTOR_SYSTEM,
  type JournalItem,
  type JournalResponse,
} from "@/lib/journalContract";
import type {
  ImportantEventType,
  ImportantEventEntityType,
  ImportantEventActorRole,
} from "@/lib/importantEvents";

/* ===== POST /api/journal — «Журнал дій» для адміністратора (с25, ТЗ §11) =====

   Слої: auth (requireRole admin + needClinic) → JournalRequestSchema +
   нормалізатор періоду → Supabase ПІД RLS сесії → JournalResponse.

   ЧОМУ РОУТ, а не прямий клієнтський запит (журнал має grant select для
   authenticated): тут одне місце для валідації фільтрів, keyset-курсора і
   меж періоду, і сюди ж потім ляже CEO-режим (політика читання в 0128 у
   нього вже є). Клієнт не задає ні колонок, ні сортування.

   ІЗОЛЯЦІЯ. clinic_id НЕ приймається від клієнта: фільтр ставить сервер із
   перевіреної сесії (me.clinic_id), RLS у БД — друга лінія.

   ЧАС. Період приходить календарними днями в зоні ЦЕНТРУ, а occurred_at —
   timestamptz. Перетворення меж робимо тут, за таймзоною центру, інакше
   «за 5 серпня» у від'ємних зонах з'їхало б на добу.

   PII. Журнал імен не містить (0128), і роут їх НЕ додає: повертаються лише
   ідентифікатори. Імена екран резолвить окремо за id під RLS (ТЗ §11). */

const DB_TIMEOUT_MS = 8000;

/* Межі доби рахує dayStartIso з lib/journalContract (експортовано і покрито
   тестами: у зонах із DST опівночі одноходовий зсув помиляється на годину). */

/** Дозволені ключі details, які взагалі можуть поїхати в браузер (ревʼю с25 M3).
    БІЛА проекція, а не чорний список: ключ, якого тут немає, не покине сервер —
    навіть якщо колись зʼявиться емітер, що поклав зайве.
    Частина ключів (roomId, queueEntryId, scheduledDate…) сьогодні на екрані не
    показується — це свідомий запас під картку деталей події; усі вони є
    ідентифікаторами або датами, PII серед них немає. */
const DETAIL_KEYS: readonly string[] = [
  "from", "to", "previousStatus", "newStatus", "previousCount", "newCount",
  "shifted", "conflicts", "stepsCount", "affectedSteps", "kind", "path",
  "action", "role", "roomsCount", "roomId", "queueEntryId", "sourceEntryId",
  "scheduledDate", "scheduledTime", "targetClinicId", "roomScope", "reason",
  "priority",
  // 0146 (події від RIS): назва ключа інтеграції, тип події та час за версією
  // зовнішньої системи. Без них картка журналу лишалась би без джерела —
  // проєкція викидає все, чого немає в цьому списку.
  "integration", "event", "at",
];

/** Вкладені обʼєкти теж проекціюємо (ревʼю с25 раунд 2 #3): інакше гарантія
    «лише відомі ключі» діяла б тільки на верхньому рівні. */
const NESTED_KEYS: Record<string, readonly string[]> = {
  from: ["date", "time", "roomId"],
  to: ["date", "time", "roomId"],
};

function pickKeys(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (keys.includes(k)) out[k] = v;
  return out;
}

function pickDetails(d: unknown): Record<string, unknown> | null {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (!DETAIL_KEYS.includes(k)) continue;
    const nested = NESTED_KEYS[k];
    if (nested && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = pickKeys(v as Record<string, unknown>, nested);
    } else {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

export async function POST(req: Request) {
  // Журнал бачить ЛИШЕ адміністратор центру (ТЗ §9: «другим ролям загальний
  // журнал не показувати»). CEO-режим — окремим кроком, коли буде рішення.
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/journal",
    rateLimit: { key: "journal", max: 60, windowSeconds: 60 },
  });
  if (!gate.ok) return gate.res;
  const { supabase, me } = gate;

  const parsed = await parseBody("api/journal", req, JournalRequestSchema, "Некоректний запит журналу");
  if (!parsed.ok) return parsed.res;

  // Таймзона центру — і для «сьогодні», і для меж періоду.
  const { data: clinic, error: clinicErr } = await supabase
    .from("clinics")
    .select("timezone")
    .eq("id", me.clinic_id)
    .maybeSingle();
  if (clinicErr) {
    return NextResponse.json({ error: safeDbError("api/journal.clinic", clinicErr) }, { status: 400 });
  }
  const tz = clinic?.timezone || undefined;

  const norm = normalizeJournalRequest(parsed.data, wallDayKey(tz));
  if (!norm.ok) return NextResponse.json({ error: norm.error, code: norm.code }, { status: 400 });
  const f = norm.filters;

  try {
    let q = supabase
      .from("important_events")
      .select("id, occurred_at, actor_id, actor_role, event_type, entity_type, entity_id, subject_referrer_id, changed_fields, details")
      .eq("clinic_id", me.clinic_id)                       // область — з сесії, не з клієнта
      .gte("occurred_at", dayStartIso(f.dateFrom, tz))
      // Верхня межа — ПОЧАТОК наступної доби з lt (див. dayStartIso).
      .lt("occurred_at", dayStartIso(shiftDayKey(f.dateTo, 1), tz));

    if (f.actor === ACTOR_SYSTEM) q = q.is("actor_id", null);
    else if (f.actor) q = q.eq("actor_id", f.actor);

    if (f.eventTypes?.length) q = q.in("event_type", f.eventTypes);
    if (f.entityId) q = q.eq("entity_id", f.entityId);

    // Keyset за (occurred_at desc, id desc) — під індексом (clinic_id, occurred_at desc).
    if (f.cursor) {
      // .lte — щоб планувальник тримав межу ДІАПАЗОНУ по індексу; сам .or()
      // діапазонного сканування не дає і лишався б фільтром поверх (ревʼю с25).
      q = q
        .lte("occurred_at", f.cursor.at)
        .or(`occurred_at.lt."${f.cursor.at}",and(occurred_at.eq."${f.cursor.at}",id.lt.${f.cursor.id})`);
    }

    // +1 рядок понад ліміт — так дізнаємось про наявність наступної сторінки.
    const { data, error } = await q
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(f.limit + 1)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));

    /* Помилка БД — це ПОМИЛКА, а не «подій немає» (урок с22).
       ⚠️ postgrest-js за замовчуванням НЕ кидає на обрив: таймаут
       AbortSignal приїжджає сюди як `error`, а не у catch (ревʼю с25 LOW-4) —
       тому розпізнаємо його саме тут. */
    if (error) {
      /* ⚠️ Розпізнаємо ЛИШЕ таймаут: `/abort/` по всьому тексту ловив би й
         легітимну 25P02 «current transaction is aborted» (ревʼю с25 раунд 2).
         `error.details` не читаємо — postgrest-js кладе туди стек. */
      const isTimeout =
        error.code === "57014" || /TimeoutError|AbortError|statement timeout/i.test(error.message ?? "");
      if (isTimeout) {
        safeDbError("api/journal.timeout", error);   // слід у серверному лозі лишається
        return NextResponse.json(
          { error: "Журнал відповідає занадто довго — звузьте період" },
          { status: 504 }
        );
      }
      return NextResponse.json({ error: safeDbError("api/journal.select", error) }, { status: 400 });
    }

    const rows = data ?? [];
    const hasMore = rows.length > f.limit;
    const page = hasMore ? rows.slice(0, f.limit) : rows;

    const items: JournalItem[] = page.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorId: r.actor_id,
      actorRole: r.actor_role as ImportantEventActorRole,
      eventType: r.event_type as ImportantEventType,
      entityType: r.entity_type as ImportantEventEntityType,
      entityId: r.entity_id,
      subjectReferrerId: r.subject_referrer_id,
      changedFields: r.changed_fields,
      details: pickDetails(r.details),
    }));

    const last = page[page.length - 1];
    const res: JournalResponse = {
      items,
      nextCursor: hasMore && last ? encodeJournalCursor({ at: last.occurred_at, id: last.id }) : null,
      hasMore,
    };
    return NextResponse.json(res);
  } catch (e) {
    // 504 лише для таймауту; будь-яка інша несподіванка — це 500 (ревʼю с25).
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return NextResponse.json(
      { error: timeout ? "Журнал відповідає занадто довго — звузьте період" : "Помилка читання журналу" },
      { status: timeout ? 504 : 500 }
    );
  }
}
