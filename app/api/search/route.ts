import { NextResponse } from "next/server";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseBody } from "@/lib/validationHttp";
import { SearchRequestSchema, type SearchResponse } from "@/lib/searchContract";
import { decodeSearchCursor, prepareSearch, runSearchPage, SEARCH_BATCH, SEARCH_MAX_SCAN } from "@/lib/searchEngine.server";

/* ===== POST /api/search — универсальный поиск пациентов и исследований (с22) =====

   Одна функция для всех пяти ролей, РАЗНЫЕ области доступа (ТЗ §5):
   область вычисляется из СЕССИИ (роль/клиника/назначенные кабинеты/гранты),
   клиентские clinicIds/roomIds могут только сузить её (нормализатор).

   Слои: auth (requireRole) → prepareSearch (область + нормализатор) →
   runSearchPage (адаптер источника под RLS) → SearchResponse.
   Рушій живе в lib/searchEngine.server.ts (с77): його ж використовує експорт у
   Excel, і область/фільтри/скриття в них не мають права розійтися.

   Почему НЕ service-role для рядків: запросы идут RLS-клиентом сессии
   (gate.supabase) — RLS остаётся последним рубежом под нашими явными фильтрами
   области. Довідкові імена направників — окремий, вузький виняток (шапка
   рушія). Term-матчинг — app-side поверх батчей (телефон у БД форматований,
   studies — JSONB), скан обмежений SEARCH_MAX_SCAN рядками на запит; шлях
   масштабування — docs/SEARCH.md. */

export async function POST(req: Request) {
  // Любой авторизованный пользователь с профилем; частота — 60 запросов/мин
  // (дебаунс на клиенте 350 мс, но лимит защищает и от скриптованного перебора).
  const gate = await requireRole(null, { rateLimit: { key: "search", max: 60, windowSeconds: 60 } });
  if (!gate.ok) return gate.res;
  const { supabase, me } = gate;

  const parsed = await parseBody("api/search", req, SearchRequestSchema, "Некоректний запит пошуку");
  if (!parsed.ok) return parsed.res;

  const prep = await prepareSearch(supabase, createAdminClient(), me, parsed.data);
  if (!prep.ok) return NextResponse.json(prep.body, { status: prep.status });
  const { ctx, f } = prep;
  const { limit: _limit, ...appliedFilters } = f;

  // Пустая область (нет активных грантов / радиолог без кабинетов) — честный пустой
  // результат БЕЗ запроса к БД (и без «ошибки», это законное состояние).
  if (prep.empty) {
    const empty: SearchResponse = { items: [], nextCursor: null, hasMore: false, appliedFilters };
    return NextResponse.json(empty);
  }

  const cursor = decodeSearchCursor(parsed.data.cursor, f.source, f.sort);
  const page = await runSearchPage(ctx, f, cursor, { limit: f.limit, maxScan: SEARCH_MAX_SCAN, batch: SEARCH_BATCH });
  if (!page.ok) return NextResponse.json({ error: page.error }, { status: page.status });

  const res: SearchResponse = { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, appliedFilters };
  return NextResponse.json(res);
}
