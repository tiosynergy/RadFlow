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
