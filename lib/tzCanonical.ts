/* ===== RadFlow — канонічна назва часового поясу центру =====

   0202 (фаза 2 таймзон): прод переїхав з legacy-аліаса `Europe/Kiev` на
   `Europe/Kyiv`, і CHECK `clinics_timezone_chk` аліас більше не пропускає.
   Але браузер може віддати саме аліас: `Intl.DateTimeFormat().resolvedOptions()
   .timeZone` і `Intl.supportedValuesOf("timeZone")` залежать від версії ICU
   рушія, а в старих ICU канон — ще `Europe/Kiev`. Без цієї нормалізації
   майстер налаштувань на такому браузері падав би на записі центру
   `check_violation`-ом, який UI показує як загальну помилку (ревʼю с75, лінза А).

   Правило одне і в один бік: аліас → канон. Читання (Intl, wall-канон 0035)
   аліас розуміє й далі — `tests/fhirTime.test.ts`, `tests/raceCheck.test.ts`. */

const ALIASES: Readonly<Record<string, string>> = {
  "Europe/Kiev": "Europe/Kyiv",
};

/** `Europe/Kiev` → `Europe/Kyiv`; решта — як є (без обрізання чи валідації). */
export function canonicalTz(tz: string): string {
  return ALIASES[tz] ?? tz;
}

/** Список для `<select>`: аліаси замінено каноном, дублікати прибрано, порядок збережено. */
export function canonicalTzList(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const z of list) {
    const c = canonicalTz(z);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/* ===== Зони, які ПРИЙМАЄ база (с82) =====

   CHECK `clinics_timezone_chk` (0192, звужено 0202) пропускає РІВНО цей список.
   До с82 майстер показував у select усі ~400 зон рушія, і будь-яка, крім двох,
   падала на записі `check_violation`-ом у вигляді сирої «Помилки збереження»; а
   зона браузера підставлялась у дефолт як є — адмін із VPN або з-за кордону
   отримував «Europe/Berlin» і не міг запустити центр, не здогадавшись, чому.
   Тепер список один: і для select, і для дефолту, і для перевірки перед записом.

   ⚠️ Новий пояс = міграція з `drop/add constraint` + передрук сторожа №23
   (`k:clinics`, див. AGENTS.md «ЦЕНА РАТЧЕТА №23») І рядок тут. Сторож на
   синхронність двох списків — tests/quickStart.test.ts (читає CHECK з 0202). */
export const CLINIC_TIMEZONES: readonly string[] = ["Europe/Kyiv", "UTC"];

/** Канон ринку: зона за замовчуванням, коли браузерна не проходить CHECK. */
export const DEFAULT_CLINIC_TZ = "Europe/Kyiv";

/** Чи прийме базу цю зону (після нормалізації аліаса). */
export function isClinicTz(tz: string): boolean {
  return CLINIC_TIMEZONES.includes(canonicalTz(tz));
}

/** Зона для нового центру: браузерна, якщо вона у списку CHECK, інакше канон ринку. */
export function clinicTzOrDefault(tz: string | null | undefined): string {
  const c = canonicalTz((tz ?? "").trim());
  return c && isClinicTz(c) ? c : DEFAULT_CLINIC_TZ;
}
