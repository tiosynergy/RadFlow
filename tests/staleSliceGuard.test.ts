/* Аудит с46, U-1 / U-2 — рядки одного зрізу під заголовком іншого.
 *
 * Клас: на екрані лишаються дані ПОПЕРЕДНЬОГО зрізу, поки заголовок і підписи
 * уже говорять про новий. Це не гонка — у CallListBoard спрацьовує у 100 %
 * випадків, бо спінер вішався на `[clinicId]`, а не на день.
 *
 *  • U-1 `CallListBoard`. Дата в КОЖНОМУ рядку малювалась із стану пікера
 *    (`dateShort={shortDate(date)}`), а не з самого запису. Перемкнув день →
 *    рядки вчорашнього обдзвону стоять далі, і кожен уже підписаний НОВОЮ датою.
 *    Оператор дзвонить і називає пацієнту чужий день. Плюс `catch` свідомо
 *    лишав старий список («старий список лишається на екрані + банер») — вірно
 *    для того самого дня, хибно для іншого.
 *  • U-2 `WaitlistBoard`. Дати немає (тому половина початкового формулювання
 *    хибна), але зріз є: вкладка + модальність + пошук. Guard покоління
 *    відсутній, тож пізніша відповідь СТАРІШОГО запиту перезаписувала рядки.
 *
 * Правки різні за природою, і саме тому їх дві:
 *   1) СТРУКТУРНА — підпис дати береться з рядка, тож рядок фізично не може
 *      стверджувати дату, якої в ньому немає. Це не залежить від жодних
 *      прапорців і переживе будь-який майбутній рефакторинг завантаження.
 *   2) СВІЖІСТЬ — покоління (порядок відповідей) + ключ зрізу (що саме на
 *      екрані). Той самий приймач, що вже стоїть у `lib/slotBusy` і
 *      `CeoDashboard`; тут він застосований третій і четвертий раз, тому
 *      сторож нижче перевіряє ФОРМУ, а не існування слова «genRef».
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/* Спільна форма приймача. Перевіряємо саме її, бо «є genRef» задовольняється
   оголошенням без жодного використання.
   ⚠️ Перша редакція цього сторожа була ДЕКОРАТИВНОЮ: `toMatch(/if \(stale\(\)\)
   return;/)` по всьому файлу задовольнялося входженням усередині `failed()`,
   тож видалення гейта ПЕРЕД записом рядків не червонило нічого. Фальсифікація
   показала це двома мовчазними дефектами (D5, D10) — третій такий випадок за
   сесію. Тепер гейт перевіряється саме там, де він тримає дефект: безпосередньо
   перед `setEntries(`. */
function expectGenerationGuard(code: string, where: string) {
  expect(code, where + ": лічильник поколінь").toMatch(/const gen = \+\+genRef\.current;/);
  expect(code, where + ": предикат протухлості").toMatch(/const stale = \(\) => gen !== genRef\.current;/);
  expect(code, where + ": гейт ПЕРЕД записом рядків").toMatch(/if \(stale\(\)\) return;\s*\n\s*setEntries\(data \|\| \[\]\);/);
  expect(code, where + ": гейт на спінері").toMatch(/if \(!stale\(\)\) setLoading\(false\);/);
  // Розмиття предиката повертає дефект, лишаючи сторожів зеленими.
  expect(code, where + ": предикат не розмито").not.toMatch(/const stale = \(\) =>[^;\n]*\|\|/);
  /* Лічильник рахує ПОРЯДОК ВИДАЧІ, а не актуальність: `reload` живе в замиканнях
     обробників, тож замикання старого зрізу може бути видане ПІЗНІШЕ і виграти
     гонку за власним gen — рядки чужого зрізу лягли б на екран, а спінер свіжого
     не зняв би ніхто. Вихід протухлого замикання мусить стояти ДО ++genRef
     (той самий висновок, що H-3 у QueueBoard). */
  const bail = code.indexOf("if (key !== scopeRef.current) return;");
  const bump = code.indexOf("const gen = ++genRef.current;");
  expect(bail, where + ": вихід протухлого замикання").toBeGreaterThan(-1);
  expect(bail, where + ": вихід стоїть ДО ++genRef").toBeLessThan(bump);
  expect(code, where + ": ключ зрізу пишеться в рендері").toMatch(/scopeRef\.current = /);
}

describe("CallListBoard — рядок не може стверджувати чужу дату (U-1)", () => {
  const code = src("components/CallListBoard.tsx");

  /* Головний, СТРУКТУРНИЙ сторож пакета: підпис дати рахується з самого запису.
     Поки він зелений, жодна майбутня гонка завантаження не зробить із мітки
     брехню — у найгіршому разі буде видно рядок ЗІ СВОЄЮ датою. */
  it("підпис дати береться з рядка, а не зі стану пікера", () => {
    expect(code).toMatch(/<div className="cl-date">\{shortDateKey\(p\.scheduled_date\)\}<\/div>/);
    // Проп, через який мітка приходила ззовні, має зникнути ЦІЛКОМ — інакше
    // хтось поверне його «щоб не ламати виклик» і мітка знову роз'їдеться.
    expect(code).not.toContain("dateShort");
  });

  /* Формат — з рядка YYYY-MM-DD, БЕЗ new Date(): календарний день клініки,
     проведений через Date, повертає зсув зони, з яким боролась 0059. */
  it("форматер не проганяє день клініки через Date", () => {
    const m = code.match(/function shortDateKey\([\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m?.[0]).not.toContain("new Date");
    expect(m?.[0]).toMatch(/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$/);
  });

  it("спінер вішається на КОЖЕН зріз, а не лише на зміну клініки", () => {
    expect(code).toMatch(/useEffect\(\(\) => \{ setLoading\(true\); \}, \[clinicId, dayKey\]\);/);
  });

  it("є guard покоління у потрібній формі", () => {
    expectGenerationGuard(code, "CallListBoard");
    expect(code).toMatch(/const key = clinicId \+ "\|" \+ dayKey;/);
  });

  /* Секція простою тягне записи `.gte(scheduled_date, today)` БЕЗ верхньої межі,
     а простій «до відновлення» не має кінця — тож сюди законно потрапляє пацієнт
     на три тижні вперед. Сам лише час під заголовком «Записи на 29 серпня»
     читається як «сьогодні» (ревʼю пакета). */
  it("рядки секції простою теж мають свою дату", () => {
    expect(code).toMatch(/className="cl-inc-time tabular">\{p\.scheduled_time\}<span className="cl-date"[^>]*>\{shortDateKey\(p\.scheduled_date\)\}<\/span>/);
  });

  /* Обидва читання цього лоадера — джерело твердження «постраждалих немає». */
  it("обидва читання «постраждалих» дивляться на error", () => {
    expect(code).toMatch(/if \(entsRes\.error\) \{ setIncidentsErr\(true\); return; \}/);
  });

  /* PostgREST не кидає: `data || []` при помилці СТИРАВ секцію «Запізнення»,
     хоча коментар обіцяв «лишаємо попередній список». */
  it("«Запізнення» не стирається помилкою читання", () => {
    const m = code.match(/const loadTodayScheduled = useCallback\([\s\S]*?\n  \}, \[clinicId, todayKey\]\);/);
    expect(m).not.toBeNull();
    expect(m?.[0]).toMatch(/const \{ data, error \} = await supabase/);
    expect(m?.[0]).toMatch(/if \(error\) return;\s*\n\s*setTodayScheduled\(data \|\| \[\]\);/);
  });

  /* Похідні від `entries` числа й вивантаження описують ПОПЕРЕДНІЙ день, поки
     новий вантажиться: картки вже маскувались, пігулки і CSV — ні. */
  it("лічильники пігулок і CSV не описують чужий день", () => {
    expect(code).toMatch(/<span className="ct">\(\{loading \? "—" : t\.ct\}\)<\/span>/);
    expect(code).toMatch(/onClick=\{exportCsv\}/);
    expect(code).toMatch(/<button className="btn btn-secondary" disabled=\{loading\} onClick=\{exportCsv\}/);
    // Дата стоїть КОЛОНКОЮ у файлі — помилку видно в самому CSV, а не лише в імені.
    expect(code).toMatch(/const head = \["Дата", "Час"/);
    expect(code).toMatch(/const rows = entries\.map\(\(e\) => \[e\.scheduled_date \|\| ""/);
  });

  /* Модалка досліджень читає графік/оверрайд/зайнятість по цій даті. */
  it("StudyEditModal отримує дату запису, а не пікера", () => {
    expect(code).toMatch(/scheduledDate=\{editStudiesFor\.scheduled_date \|\| dayKey\}/);
  });

  /* Банер не має суперечити тому, що видно поруч. */
  it("текст банера залежить від того, чи лишились рядки", () => {
    expect(code).toMatch(/entries\.length > 0\s*\n?\s*\? "На екрані — попередні дані цього ж дня/);
  });

  /* Старі рядки лишаються ЛИШЕ якщо вони про той самий день. */
  it("збій на іншому дні стирає рядки, а не лишає їх під новою датою", () => {
    expect(code).toMatch(/if \(loadedKeyRef\.current !== key\) \{ loadedKeyRef\.current = null; setEntries\(\[\]\); \}/);
    expect(code).toMatch(/loadedKeyRef\.current = key;/);
    // catch більше не сідає на setEntriesErr напряму повз перевірку зрізу
    expect(code).toMatch(/\} catch \{\s*failed\(\);/);
  });
});

describe("WaitlistBoard — вкладка не показує рядки іншої (U-2)", () => {
  const code = src("components/WaitlistBoard.tsx");

  it("є guard покоління у потрібній формі", () => {
    expectGenerationGuard(code, "WaitlistBoard");
  });

  /* Guard покоління лагодить ПОРЯДОК відповідей, але не детермінований проміжок
     «вкладку перемкнули — відповідь ще не прийшла». Без спінера на зріз рядки
     «Очікують» цілий круговий раз малюються під вкладкою «Записані» — це і є
     основний симптом U-2, і його одним лише genRef не закрити (ревʼю пакета). */
  it("спінер вішається на зміну зрізу, а не лише клініки", () => {
    expect(code).toMatch(/useEffect\(\(\) => \{ setLoading\(true\); \}, \[clinicId, filter, viewMod\]\);/);
  });

  /* Збій ДОГРУЗКИ лишає рядки — і тоді про нього має щось сказати, інакше
     «Показати ще» просто виглядає зламаною. */
  it("збій при збережених рядках теж видно", () => {
    expect(code).toMatch(/\{entriesErr && filtered\.length > 0 && \(/);
  });

  /* Ключ зрізу БЕЗ limit: «Показати ще» лише подовжує той самий список, і при
     збої догрузки стирати вже показані рядки не можна. */
  it("ключ зрізу — вкладка + модальність + пошук, БЕЗ limit", () => {
    const m = code.match(/const key = clinicId \+[^;]*;/);
    expect(m).not.toBeNull();
    expect(m?.[0]).toContain("filter");
    expect(m?.[0]).toContain("viewMod");
    expect(m?.[0]).toContain("qDebounced");
    expect(m?.[0]).not.toContain("limit");
  });

  it("збій на іншому зрізі стирає рядки", () => {
    expect(code).toMatch(/if \(loadedKeyRef\.current !== key\) \{ loadedKeyRef\.current = null; setEntries\(\[\]\); setHasMore\(false\); \}/);
    expect(code).toMatch(/loadedKeyRef\.current = key;/);
  });
});
