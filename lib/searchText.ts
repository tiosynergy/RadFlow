/* ===== RadFlow — универсальный поиск: текстовое сопоставление (с22) =====

   ЕДИНОЕ ядро сопоставления «пациент или исследование» для:
   1) быстрого поиска в дневной очереди (lib/quickSearch.ts, клиент);
   2) глобального серверного поиска (app/api/search/route.ts).

   Принципы (ТЗ универсального поиска, §6.1/§8.2):
   - ФИО ищем подстрокой в НОРМАЛИЗОВАННОМ имени (регистр, повторные пробелы);
     несколько слов запроса → каждое слово обязано найтись (AND);
   - телефон сравниваем ТОЛЬКО ПО ЦИФРАМ: запрос «0671», «123 45», «+380 (67)
     123-45-67» находит номер независимо от формата хранения («+380 67 123 45 67»);
     ведущие «0» / «380» запроса — взаимозаменяемы с хранением в intl-формате;
   - никакого fuzzy-слияния людей: это ФИЛЬТР строк, а не резолвер пациента.

   ⚠️ Существующий formatPhoneSearch (lib/phone.ts) канонизирует ввод «с начала
   номера» и НЕ находит середину («123 45 67» ≠ «+380 12 345 67»). Здесь — более
   общее цифровое сравнение; formatPhoneSearch остаётся только форматтером инпута. */

/** Максимальная длина поискового запроса (защита от чрезмерных строк). */
export const SEARCH_TERM_MAX = 120;

/** Нормализация текста запроса/имени: трим, схлопывание пробелов, нижний регистр. */
export function normSearchText(s: string | null | undefined): string {
  return (s || "").slice(0, SEARCH_TERM_MAX * 2).trim().replace(/\s+/g, " ").toLowerCase();
}

/** Все цифры строки (без ограничения «национальным» форматом — ищем и середину). */
export function digitsOf(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

/** Запрос «похож на телефон»: есть цифры и нет букв (пробелы/скобки/дефисы/+ допустимы). */
export function isPhoneLikeQuery(s: string): boolean {
  const t = (s || "").trim();
  return !!t && /\d/.test(t) && /^[\d\s()+-]+$/.test(t);
}

/**
 * Запрос «похож на ID записи» (с25): hex-символы и дефисы. Источник таких
 * запросов — «Журнал дій», где запись подписана коротким ID (первые 8 знаков
 * uuid) с полным uuid в тултипе.
 *
 * Чтобы НЕ отбирать запросы у телефона и имени:
 *   - минимум 6 символов (короткий ID из журнала — 8);
 *   - либо есть дефис (кусок полного uuid), либо есть И цифра, И hex-буква.
 * ⚠️ Ограничение: чисто цифровой префикс id («12345678») останется телефонным
 * запросом — для такой записи вставляйте полный uuid из тултипа.
 */
export function isIdLikeQuery(s: string): boolean {
  const t = (s || "").trim().toLowerCase();
  if (t.length < 6 || t.length > 36) return false;
  if (!/^[0-9a-f-]+$/.test(t)) return false;
  return t.includes("-") || (/\d/.test(t) && /[a-f]/.test(t));
}

/** ID записи начинается с введённого фрагмента? (короткий ID журнала = префикс uuid) */
export function idMatches(id: string | null | undefined, rawQuery: string): boolean {
  const q = (rawQuery || "").trim().toLowerCase();
  if (!q) return false;
  return (id || "").toLowerCase().startsWith(q);
}

/**
 * Варианты цифровой последовательности запроса. Оператор может ввести номер
 * «по-местному» («067…», «0 67 123…»), а в БД он лежит в intl-виде («+380 67…»,
 * цифры «38067…»). Ведущий «0» ↔ «380» взаимозаменяемы; сам ввод тоже ищем как есть
 * (для середины номера). Пустые и слишком короткие варианты отбрасываем на месте
 * вызова (правило «минимум N цифр» у быстрого и глобального поиска разное).
 */
export function phoneQueryVariants(queryDigits: string): string[] {
  const out = new Set<string>();
  const d = queryDigits;
  if (!d) return [];
  out.add(d);
  if (d.startsWith("0")) out.add("380" + d.slice(1));
  if (d.startsWith("380")) out.add("0" + d.slice(3));
  if (d.startsWith("80")) out.add("3" + d); // «80 67…» — набор без «+3»
  return [...out];
}

/** Телефон записи содержит введённую последовательность цифр (в любом месте)? */
export function phoneMatches(storedPhone: string | null | undefined, rawQuery: string): boolean {
  const stored = digitsOf(storedPhone);
  if (!stored) return false;
  const qd = digitsOf(rawQuery);
  if (!qd) return false;
  return phoneQueryVariants(qd).some((v) => stored.includes(v));
}

/**
 * Имя пациента соответствует запросу? Каждое слово запроса (после нормализации)
 * должно найтись в нормализованном имени: «Ковал О» → «Коваленко Олена».
 * Слово из 2+ символов ищется ПОДСТРОКОЙ в любом месте («вален» → «Коваленко»);
 * однобуквенное слово — как ИНИЦИАЛ (начало слова имени), иначе «О» матчило бы
 * почти любое кириллическое ФИО («Коваль» содержит «о»).
 */
export function nameMatches(patientName: string | null | undefined, rawQuery: string): boolean {
  const name = normSearchText(patientName);
  if (!name) return false;
  const q = normSearchText(rawQuery);
  if (!q) return false;
  const words = name.split(" ");
  return q.split(" ").every((w) => (w.length >= 2 ? name.includes(w) : words.some((n) => n.startsWith(w))));
}

/** Study-подобный элемент (queue_entries.studies[] / waitlist_entries.studies[]). */
export type SearchableStudy = { type?: string; region?: string; contrast?: boolean };

/** Безопасно привести JSONB studies к массиву (мусор → []). */
export function studiesArr(studies: unknown): SearchableStudy[] {
  return Array.isArray(studies) ? (studies as SearchableStudy[]) : [];
}

/** Текст исследований для поиска: «МРТ Головний мозок КТ …» (type + region). */
export function studiesText(studies: unknown): string {
  return studiesArr(studies)
    .map((s) => [s?.type || "", s?.region || ""].join(" "))
    .join(" ");
}

/**
 * Универсальное правило «строка подходит под текстовый запрос»:
 * телефоноподобный запрос → только по цифрам телефона;
 * текстовый → по имени ИЛИ по тексту исследований (type/region).
 */
export function entryMatchesTerm(
  e: { id?: string | null; patient_name?: string | null; patient_phone?: string | null; studies?: unknown },
  rawQuery: string
): boolean {
  const q = (rawQuery || "").trim();
  if (!q) return true;
  // ID-запрос (с25): проверяется ПЕРЕД телефоном — он содержит hex-буквы или
  // дефис, телефонным быть не может; текстом его тоже не ищем (hex-строка в
  // имени/дослідженнях дала б лише хибні збіги).
  if (isIdLikeQuery(q)) return idMatches(e.id, q);
  if (isPhoneLikeQuery(q)) return phoneMatches(e.patient_phone, q);
  const st = normSearchText(studiesText(e.studies));
  const qn = normSearchText(q);
  return nameMatches(e.patient_name, q) || (!!st && qn.split(" ").every((w) => st.includes(w)));
}
