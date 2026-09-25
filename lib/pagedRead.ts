/* ===== Читання keyset-сторінками під стелею db-max-rows (с79 → с80) =====

   Винесено з app/api/ceo/export/route.ts (с80, Н-16) БЕЗ змін логіки: тим самим
   кодом тепер читає і CSV колл-листа (app/api/call-list/export). Друга копія
   розійшлась би з першою на першій же правці — а кожне правило тут оплачене
   ревʼю с79 (M-1 «тиха обрізка до 1000», L2 «дедуп між сторінками»). */

/** Сторінка читання. PostgREST віддає не більше db-max-rows (1000) рядків на
    запит — МОВЧКИ (ревʼю с79, M-1): 5000 записів одним `.limit(5001)` на проді
    ставали 1000 без жодної ознаки обрізання, а місячний файл одного центру
    (≈2,9 тис. записів) — неповним. */
export const PAGE = 1000;
/** Запобіжник від нескінченного циклу (≈60 тис. рядків за стелі 1000). Більше
    сторінок = зламаний keyset або крихітна стеля сервера → помилка, а не тиша. */
export const MAX_PAGES = 60;

export type DbErr = { code?: string; message?: string };
export type PageRes<T> = PromiseLike<{ data: T[] | null; error: DbErr | null }>;

/**
 * Читає вибірку keyset-сторінками до `cap` рядків (або до кінця).
 * `page(after, want)` будує СВІЖИЙ запит «строго після рядка `after`» (null —
 * з початку) з тим самим ORDER BY і `.limit(want)`.
 *   • КІНЕЦЬ — лише ПОРОЖНЯ сторінка. Коротка може бути стелею сервера, а не
 *     кінцем вибірки; повірити їй — та сама тиха обрізка, від якої лікуємо;
 *   • «є ще» роут вирішує за РЕАЛЬНО прочитаним рядком понад стелю файлу;
 *   • keyset, а не offset (`.range`): між сторінками запис можуть скасувати —
 *     offset тоді зсувається і МОВЧКИ губить сусідній рядок, а keyset
 *     продовжує від останнього прочитаного ключа.
 */
export async function readPages<T extends { id: string }>(
  page: (after: T | null, want: number) => PageRes<T>,
  cap: number,
  opts: { after?: T | null; seen?: Set<string> } = {}
): Promise<{ rows: T[]; error: DbErr | null }> {
  const rows: T[] = [];
  /* Дедуп за id МІЖ сторінками (ревʼю с79 р2, L2). Снапшоту між запитами
     немає: запис, перенесений ВПЕРЕД за курсор, прийшов би вдруге — не
     дублюємо (лишається перша, вже прочитана версія); перенесений НАЗАД за
     курсор — пропускаємо (його вже не видно; межа без снапшоту). */
  const seen = opts.seen ?? new Set<string>();
  let after: T | null = opts.after ?? null;
  for (let i = 0; i < MAX_PAGES; i++) {
    let res: { data: T[] | null; error: DbErr | null };
    try {
      res = await page(after, Math.min(PAGE, cap - rows.length));
    } catch (e) {
      // Напр. некоректний ключ сторінки (afterDateIdOr кидає) — помилка, не «кінець».
      return { rows, error: { code: "exception", message: e instanceof Error ? e.message : String(e) } };
    }
    if (res.error) return { rows, error: res.error };
    const got = res.data ?? [];
    if (!got.length) return { rows, error: null };
    for (const r of got) {
      const k = String(r.id).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(r);
    }
    if (rows.length >= cap) return { rows, error: null };
    after = got[got.length - 1];   // курсор — за порядком СЕРВЕРА, навіть якщо останній був дублем
  }
  return { rows, error: { code: "pagination_overflow", message: `pages>${MAX_PAGES}` } };
}
