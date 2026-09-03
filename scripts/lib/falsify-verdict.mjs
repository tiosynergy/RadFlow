// ============================================================
//  U-74. ВЕРДИКТ СТЕНДА ФАЛЬСИФІКАЦІЇ — один екземпляр на всі стенди.
//
//  ЧОМУ ЦЕ ІСНУЄ. До с51 жоден стенд не мав коду повернення: він друкував
//  таблицю і виходив НУЛЕМ незалежно від того, що в ній. Тому «відхилений
//  якір» — рядок «ЯКІР НЕ УНІКАЛЬНИЙ (0)», тобто мутація, яка НЕ ВІДБУЛАСЬ, —
//  виглядав у звіті майже як успіх. У с50 цей клас уже ловили в falsify-f4-2
//  (три протухлі якорі) і полагодили ТОЧКОВО, правила не зробивши; у с51
//  живий прогін показав, що в falsify-u70 так протухли ПʼЯТЬ якорів, і серед
//  них сторож рівно на ту помилку, заради якої стенд писався.
//
//  ⚠️ ПРАВИЛО: відхилений якір — це ЧЕРВОНИЙ вердикт стенда, а не рядок у
//     таблиці. Мутація, яка не застосувалась, нічого не довела; стенд, який
//     цього не кричить, бреше тим голосніше, чим більше в ньому мутацій.
//
//  ⚠️ Чому лічильник, а не лише розбір тексту. Розбір власного виводу — сам по
//     собі крихкий сторож: він сліпий до рядка, якого НЕМАЄ. Тому окремо
//     звіряється КІЛЬКІСТЬ рядків-результатів із кількістю мутацій: рядок, що
//     не потрапив у таблицю, і рядок, вердикт якого парсер не впізнав,
//     однаково валять прогін.
// ============================================================

const OK = "✅";                    // ✅
const HEADER_LAST_CELL = "вердикт";   // «вердикт»
const SEP = /^-+$/;

/** Розбір рядка markdown-таблиці на клітинки; null — якщо це не рядок таблиці. */
function cellsOf(line) {
  if (typeof line !== "string" || !line.startsWith("|")) return null;
  const raw = line.split("|");
  const cells = raw.slice(1, raw.length - 1).map((c) => c.trim());
  return cells.length ? cells : null;
}

/**
 * ⚠️ Типи в JSDoc не косметика: `tsc --noEmit` перевіряє і `tests/`, а спек
 * цього модуля читає `counts.rejected`. З нетипізованим `object` гейт падав
 * одинадцятьма помилками (с51) — тобто сторож над сторожами сам не збирався.
 *
 * @param {string[]} lines   рядки звіту, як їх зібрав стенд
 * @param {number} expected  скільки мутацій мало бути прогнано (MUTATIONS.length)
 * @returns {{ok: boolean, summary: string, counts: {passed: number, rejected: number, crashed: number, notHeld: number, wrongSpec: number, noSuchGuard: number, unknown: number}}}
 */
export function verdictOf(lines, expected) {
  const counts = { passed: 0, rejected: 0, crashed: 0, notHeld: 0, wrongSpec: 0, noSuchGuard: 0, unknown: 0 };
  const baselineRed = lines.some((l) => typeof l === "string" && l.includes("Базова лінія червона"));
  const unknownSamples = [];

  for (const line of lines) {
    const cells = cellsOf(line);
    if (!cells) continue;
    const last = cells[cells.length - 1];
    if (last === HEADER_LAST_CELL || SEP.test(last)) continue;
    if (last === OK) { counts.passed++; continue; }
    if (last.includes("відхилено")) { counts.rejected++; continue; }
    if (last.includes("зламала збірку")) { counts.crashed++; continue; }
    if (last.includes("НЕ ТРИМАЄ")) { counts.notHeld++; continue; }
    /* ⚠️ ДВА ДІАГНОЗИ U-80б, яких цей модуль НЕ ЗНАВ (с56). Стенди, переведені
       на адресність, друкують «СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ» і «ЧУЖИЙ сторож»
       — і обидва падали в `unknown`. Прогін від цього червонів (кількість
       сходилась не за тим кошиком), тобто нічого не ховалось; але ПРИЧИНА в
       підсумку називалась «невпізнаний вердикт» замість справжньої. Сторож,
       який червоніє з неправильним поясненням, лікується не тим місцем.
       ⚠️ «Немає сторожа з таким іменем» — окремий кошик НАВМИСНО: це дефект
       САМОГО СТЕНДА (опечатка в `expect`), а не дірка в покритті, і плутати
       їх означає шукати вчорашній день у продукті. */
    if (last.includes("ТАКИМ ІМЕНЕМ НЕМАЄ")) { counts.noSuchGuard++; continue; }
    if (/ЧУЖИЙ (спек|сторож)/.test(last)) { counts.wrongSpec++; continue; }
    counts.unknown++;
    if (unknownSamples.length < 3) unknownSamples.push(last.slice(0, 60));
  }

  /* ⚠️ Новий кошик мусить бути І тут (с56). Забути його в сумі означало б
     діагноз «N мутацій не дали рядка в таблиці» на рядок, який у таблиці Є, —
     тобто сторож указував би не на те місце. */
  const total = counts.passed + counts.rejected + counts.crashed + counts.notHeld
    + counts.wrongSpec + counts.noSuchGuard + counts.unknown;

  /* ⚠️ НЕ `Number.isFinite(expected) ? … : 0` (знахідка ревʼю А). Така форма
     ТИХО вимикала б половину сторожа: стенд, який колись покличе verdictOf без
     другого аргументу або з рядком, отримав би зелений вердикт без звірки
     кількості — тобто рівно той мовчазний розхід, проти якого модуль і
     написаний. Падаємо голосно. */
  if (!Number.isFinite(expected)) {
    throw new TypeError(`verdictOf: expected має бути числом (отримано ${typeof expected})`);
  }
  const missing = expected - total;

  const problems = [];
  if (baselineRed) problems.push("базова лінія ЧЕРВОНА — стенд нічого не доводить");
  if (counts.rejected) problems.push(`${counts.rejected} відхилених якорів (мутація НЕ відбулась — протухлий якір)`);
  if (counts.crashed) problems.push(`${counts.crashed} мутацій зламали збірку`);
  if (counts.notHeld) problems.push(`${counts.notHeld} сторожів НЕ ТРИМАЮТЬ`);
  if (counts.wrongSpec) problems.push(`${counts.wrongSpec} мутацій спіймав ЧУЖИЙ сторож, а не названий`);
  if (counts.noSuchGuard) problems.push(`${counts.noSuchGuard} мутацій називають сторожа, ЯКОГО НЕМАЄ — дефект стенда, не покриття`);
  if (counts.unknown) problems.push(`${counts.unknown} рядків із невпізнаним вердиктом (${unknownSamples.join(" / ")})`);
  if (missing > 0) problems.push(`${missing} мутацій не дали рядка в таблиці`);
  if (missing < 0) problems.push(`рядків більше, ніж мутацій (${total} проти ${expected})`);

  const ok = problems.length === 0;
  const summary = ok
    ? `**ВЕРДИКТ: ✅ СТЕНД ЗЕЛЕНИЙ** — ${counts.passed}/${expected} мутацій відпрацювали як задумано.`
    : `**ВЕРДИКТ: ⛔ СТЕНД ЧЕРВОНИЙ** (${counts.passed}/${expected} у нормі)\n\n`
      + problems.map((p) => `* ${p}`).join("\n")
      + `\n\n⚠️ Червоний вердикт стенда найчастіше означає дефект САМОГО СТЕНДА\n`
      + `(протухлий якір після рефактора), а не дефект продукту. Але доки він\n`
      + `червоний, стенд НЕ доводить нічого.`;

  return { ok, summary, counts };
}
