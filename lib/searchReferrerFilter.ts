/* ===== Пошук: фільтр «Направник» — чиста логіка (с77) =====

   Задача власника 22.09: у пошуку для всіх ролей, крім направника, — фільтр за
   направником. У RadFlow ДВА різні «направники», і селект мусить дати обидва,
   інакше фільтр виглядає зламаним (рішення власника 23.09 — «обидві групи»):

     • АКАУНТ (`profiles.role = 'referrer'` + грант `referral_access`) — у записі
       лежить `referrer_id`; шукаємо по ньому і в черзі, і в листі очікування;
     • КАРТКА ДОВІДНИКА `doctors` — акаунта немає, у запис черги їде лише ТЕКСТ
       `doctor` при `referrer_id = null` (правило — lib/referrerField.ts,
       `referrerPatchFor`); шукаємо по тексту, лише в черзі — у листі очікування
       колонки `doctor` немає взагалі.

   Плюс «Без направника» — записи, де немає ні того, ні іншого.

   ⚠️ КЛЮЧІ ОПЦІЙ — ті самі префікси, що в картці пацієнта (`lib/referrerField.ts`):
      `r-<uuid>` — акаунт, `d-<uuid>` — картка довідника. У `BookingModal` живе
      ДРУГИЙ, несумісний префікс `ref:` — кожен самодостатній у своєму екрані, і
      змішувати їх тут не можна: `ref:` цей модуль не розбирає свідомо (тест).

   ⚠️ ТЕКСТ ЛІКАРЯ ПОРІВНЮЄТЬСЯ НОРМАЛІЗОВАНИМ, а не як рядок: клас інциденту с31
      — «Заставська··Марія» (подвійний пробіл) проти «Заставська·Марія». Плюс
      три написання апострофа в українських прізвищах (ʼ ' ’) і регістр. */

import { zUuid } from "@/lib/validation";

export const REF_KEY_ALL = "all";
export const REF_KEY_NONE = "none";
/** Префікси — дзеркало `lib/referrerField.ts` (`r-` акаунт, `d-` довідник). */
export const REF_PREFIX_ACCOUNT = "r-";
export const REF_PREFIX_CARD = "d-";

/** Частина запиту пошуку, яку задає селект «Направник». */
export type ReferrerRequestPart = { referrerIds?: string[]; doctorIds?: string[]; noReferrer?: true };

/**
 * Ключ селекта → поля запиту. Невідомий/битий ключ (і `all`) → порожньо, тобто
 * «без фільтра»: сервер усе одно звужує область сам, а вигаданий id сюди не
 * пролізе — хвіст ключа мусить бути UUID.
 */
export function referrerKeyToRequest(key: string): ReferrerRequestPart {
  if (key === REF_KEY_NONE) return { noReferrer: true };
  const tail = (p: string) => (key.startsWith(p) ? key.slice(p.length) : null);
  const acc = tail(REF_PREFIX_ACCOUNT);
  if (acc !== null) return zUuid.safeParse(acc).success ? { referrerIds: [acc] } : {};
  const card = tail(REF_PREFIX_CARD);
  if (card !== null) return zUuid.safeParse(card).success ? { doctorIds: [card] } : {};
  return {};
}

/** Чи ключ означає картку довідника (такий фільтр недоступний листу очікування). */
export function isCardKey(key: string): boolean {
  return key.startsWith(REF_PREFIX_CARD);
}

/**
 * Нормалізація ПІБ для порівняння тексту `doctor` з карткою: NFC, усі види
 * пробілів → один, три апострофи → один, регістр — український. Порожнє/null → "".
 */
export function normPersonName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFC")
    .replace(/[\u02BC\u2019\u2018`\u00B4]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("uk");
}

/** Довідник направників області ролі (те, що віддає GET /api/search/referrers). */
export type ReferrerDirectory = {
  accounts: Array<{ id: string; name: string | null }>;
  cards: Array<{ id: string; name: string | null; clinicId: string }>;
};

/** `clinicId` — лише в картки довідника: UI ховає картки чужого центру, коли
 *  обрано фільтр центру (ревʼю с77, B MEDIUM-1). */
export type ReferrerOption = { key: string; label: string; clinicId?: string };
export type ReferrerOptions = { accounts: ReferrerOption[]; cards: ReferrerOption[] };

const byLabel = (a: ReferrerOption, b: ReferrerOption) => a.label.localeCompare(b.label, "uk");

/**
 * Опції селекта. Порожні імена відкидаються (їх нема чим показати); дублікати
 * id — теж. Однойменні АКАУНТ і КАРТКА лишаються обидва: це різні записи в БД
 * і різні фільтри (урок BookingModal, ревʼю р.2 — дедуп за іменем обнуляв звʼязок).
 * Мультицентровій ролі (CEO) до картки дописується центр: картки належать
 * центру, і дві однойменні картки різних центрів інакше не розрізнити.
 */
export function buildReferrerOptions(
  dir: ReferrerDirectory,
  clinicNameById: Record<string, string>,
  multiClinic: boolean
): ReferrerOptions {
  const seenA = new Set<string>();
  const accounts: ReferrerOption[] = [];
  for (const a of dir.accounts) {
    const name = (a.name || "").trim().replace(/\s+/g, " ");
    if (!name || seenA.has(a.id)) continue;
    seenA.add(a.id);
    accounts.push({ key: REF_PREFIX_ACCOUNT + a.id, label: name });
  }
  const seenC = new Set<string>();
  const cards: ReferrerOption[] = [];
  for (const c of dir.cards) {
    const name = (c.name || "").trim().replace(/\s+/g, " ");
    if (!name || seenC.has(c.id)) continue;
    seenC.add(c.id);
    const where = multiClinic ? clinicNameById[c.clinicId] : "";
    cards.push({ key: REF_PREFIX_CARD + c.id, label: where ? `${name} · ${where}` : name, clinicId: c.clinicId });
  }
  return { accounts: accounts.sort(byLabel), cards: cards.sort(byLabel) };
}

/** Підпис «без направника» для джерела: лист очікування тексту лікаря не
 *  зберігає, тож там це чесно лише «без АКАУНТА направника» (ревʼю с77). */
export function noReferrerLabel(source: "queue" | "waitlist"): string {
  return source === "waitlist" ? "Без акаунта направника" : "Без направника";
}

/** Підпис обраного фільтра для chip-а (null — фільтра немає або опція зникла). */
export function referrerChipLabel(key: string, opts: ReferrerOptions | null, source: "queue" | "waitlist" = "queue"): string | null {
  if (key === REF_KEY_ALL) return null;
  if (key === REF_KEY_NONE) return noReferrerLabel(source);
  const hit = opts ? [...opts.accounts, ...opts.cards].find((o) => o.key === key) : null;
  return hit ? `Напр.: ${hit.label}` : "Напр.: обраний";
}
