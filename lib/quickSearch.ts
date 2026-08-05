/* ===== RadFlow — быстрый поиск в дневной очереди (с22) =====

   ОДНА функция-предикат для всех дневных досок (QueueBoard, RadiologistBoard,
   CallListBoard, ReferrerBoard): «запись подходит под строку быстрого поиска».

   Требования ТЗ (§6.1):
   - фильтрует ТОЛЬКО уже загруженный разрешённый набор выбранного дня, синхронно;
   - полная/частичная фамилия (с начала и из середины, несколько слов — AND);
   - телефон по цифрам: код оператора, середина, последние цифры, ввод с «+»,
     пробелами, скобками и дефисами;
   - НЕ сортирует и не переупорядочивает: доска применяет предикат ПОСЛЕ своей
     штатной сортировки, порядок записей не меняется;
   - реагирует с первого символа (день уже в памяти — сетевых запросов нет).

   Дополнительно сохраняем прежнее поведение досок: текстовый запрос ищется и в
   названии процедуры (procLabel / studies) — так уже работали Rad/CallList/Referrer. */

import { entryMatchesTerm, isPhoneLikeQuery, normSearchText, phoneMatches } from "@/lib/searchText";

export type QuickSearchable = {
  patient_name?: string | null;
  patient_phone?: string | null;
  studies?: unknown;
};

/**
 * Запись дневной очереди подходит под строку быстрого поиска?
 * `extraText` — необязательный дополнительный текст записи (например, procLabel
 * с note-фолбэком), в котором тоже ищем текстовый запрос.
 *
 * Телефоноподобный запрос идёт по цифрам телефона, но при промахе падает назад
 * на текстовый поиск (ревью с22, LOW-1/LOW-2): старые доски искали цифры и в
 * процедуре/нотатке («передзвонити о 1430»), а у CEO-drill телефона нет вовсе —
 * без фолбэка цифровой запрос там был бы мёртв.
 */
export function quickSearchMatch(rawQuery: string, e: QuickSearchable, extraText?: string | null): boolean {
  const q = (rawQuery || "").trim();
  if (!q) return true;
  if (isPhoneLikeQuery(q) && phoneMatches(e.patient_phone, q)) return true;
  if (!isPhoneLikeQuery(q) && entryMatchesTerm(e, q)) return true;
  // Текстовый фолбэк (для цифровых запросов — по сырому вводу как подстроке).
  const qn = normSearchText(q);
  // ИМЯ в фолбэк сознательно НЕ входит: его уже проверил nameMatches с правилом
  // «однобуквенное слово = инициал»; сырое подстрочное совпадение по имени вернуло
  // бы ложные срабатывания вроде «Ковал О» → «Коваль Ірина».
  const hay = [normSearchText(studiesTextOf(e)), extraText ? normSearchText(extraText) : ""]
    .filter(Boolean)
    .join(" ");
  if (hay && qn.split(" ").every((w) => hay.includes(w))) return true;
  // Отдельного fuzzy НЕ делаем (ТЗ запрещает объединять людей по похожести).
  return false;
}

function studiesTextOf(e: QuickSearchable): string {
  const arr = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string }>) : [];
  return arr.map((s) => [s?.type || "", s?.region || ""].join(" ")).join(" ");
}

/** Утилита для тестов и досок: отфильтровать массив, СОХРАНИВ исходный порядок. */
export function quickSearchFilter<T extends QuickSearchable>(
  rawQuery: string,
  entries: T[],
  extraTextOf?: (e: T) => string | null
): T[] {
  const q = (rawQuery || "").trim();
  if (!q) return entries;
  return entries.filter((e) => quickSearchMatch(q, e, extraTextOf ? extraTextOf(e) : null));
}
