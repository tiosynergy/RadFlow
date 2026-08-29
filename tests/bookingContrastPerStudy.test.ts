/**
 * с47, пакет UI форм запису — «контраст належить ДОСЛІДЖЕННЮ, а не запису».
 *
 * До правки чекбокс «Контраст» стояв ОДИН на всю форму, у шапці «Параметри», і
 * фільтрував список лише ОСНОВНОГО дослідження. Наслідки:
 *
 *  • додаткові дослідження фільтра не мали ВЗАГАЛІ — щоб знайти «МРТ головного
 *    мозку до та після в/в контрастування» серед сотень позицій, оператор гортав
 *    повний список;
 *  • у записі з двох позицій одна буває контрастною, а друга ні — спільна
 *    галочка це приховувала;
 *  • ціна додаткових рахувалась із жорстким `contrast: false`, тож у
 *    легасі-режимі (центр без каталогу) увімкнений контраст показував одну ціну
 *    в списку, а в `studies` їхала інша.
 *
 * Правило контрасту (рішення власника, с19/20 — `docs`/`claude/contrast-filter-rule`):
 * у каталозі чекбокс = ФІЛЬТР списку послуг, доплати немає; у легасі-статиці =
 * МОДИФІКАТОР із доплатою і +CONTRAST_DUR. Межу дає одна функція —
 * `catalog.contrastIsFilter`, а сам фільтр — `catalog.regionsWithContrast`.
 * Обидві форми запису (дошка персоналу і портал направника) зобовʼязані звати
 * саме їх, а не фільтрувати список самі.
 *
 * Ці сторожі тримають те, чого `tsc` не бачить: що фільтр лишився ПО РЯДКАХ,
 * що прапорець рядка їде і в `studies[].contrast`, і в ціну, і що дефолт
 * пріоритету не відкотили назад у порожній.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));
const raw = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const BOOKING = "components/BookingModal.tsx";
const PORTAL = "components/ReferralPortal.tsx";
const CSS = "styles/prototype/radflow.css";

/* Обидві форми створення запису. Списком, а не по одній: цей пакет уже двічі
   ловили на тому, що правку зробили в дошці й забули в порталі (U-11, U-12). */
const FORMS = [BOOKING, PORTAL];

describe("с47: «Контраст» — фільтр КОЖНОГО дослідження, а не всієї форми", () => {
  it.each(FORMS)("%s: рядок додаткового несе власний прапорець і стан чекбокса", (file) => {
    const code = src(file);
    expect(code, `${file}: у ExtraStudy зник contrast — ціна й has_contrast знову рахуються з нічого`)
      .toMatch(/type ExtraStudy = \{[^}]*\bcontrast\?: boolean/);
    expect(code, `${file}: у ExtraStudy зник filterOn — стан галочки нема де тримати`)
      .toMatch(/type ExtraStudy = \{[^}]*\bfilterOn\?: boolean/);
    /* ⚠️ Саме В РЯДКУ, а не в мапі по індексу: рядки додають і видаляють,
       індекси зсуваються, і галочка від видаленого рядка переїжджала б на
       чужий (урок StudyEditModal, ревʼю M-A). */
    expect(code, `${file}: зʼявилась окрема мапа стану чекбоксів — вона розʼїдеться з рядками`)
      .not.toMatch(/filterOn(Map|By(Index|Row))|contrastByIndex/);
  });

  it.each(FORMS)("%s: список позицій рядка йде через regionsWithContrast", (file) => {
    const code = src(file);
    /* ЄДИНЕ місце правила фільтра. Своя фільтрація в формі — рівно те, через що
       чекбокс колись ховав 88 справжніх контрастних послуг і показував 10
       випадкових. */
    expect(code, `${file}: exList більше не кличе спільне правило фільтра`)
      .toMatch(/const exList = \(r: ExtraStudy\) => catalog\.regionsWithContrast\(r\.type, roomId[^,]*, exChecked\(r\)\);/);
    expect(code, `${file}: видимий стан чекбокса рядка рахується не через contrastIsFilter`)
      .toMatch(/const exChecked = \(r: ExtraStudy\) =>\s*\n?\s*catalog\.contrastIsFilter\(r\.type, roomId[^)]*\) \? \(r\.filterOn \?\? !!r\.contrast\) : !!r\.contrast;/);
  });

  it.each(FORMS)("%s: перемикач рядка розрізняє фільтр і модифікатор", (file) => {
    const code = src(file);
    expect(code, `${file}: exSetContrast зник`).toMatch(/const exSetContrast = \(i: number, v: boolean\) => \{/);
    /* Гард по ВИДИМОМУ стану, а не по r.contrast: у режимі фільтра вони
       навмисне розходяться, і порівняння з r.contrast лишало галочку залиплою. */
    expect(code, `${file}: гард порівнює не з видимим станом — галочка залипне`)
      .toMatch(/if \(exChecked\(r\) === v\) return;/);
    // Гілка фільтра: чекбокс керує лише списком, contrast позиції не чіпаємо.
    expect(code, `${file}: у режимі фільтра галочка знову править сам прапорець дослідження`)
      .toMatch(/exPatch\(i, survives \? \{ filterOn: v \} : \{ filterOn: v, region: "", contrast: false, dur: 0 \}\);/);
    // Гілка модифікатора: ±CONTRAST_DUR, як у основного дослідження.
    expect(code, `${file}: легасі-режим більше не рухає тривалість`)
      .toMatch(/const delta = v \? CONTRAST_DUR : -CONTRAST_DUR;/);
  });

  /* НАЙВАЖЛИВІШЕ місце пакета: прапорець рядка мусить доїхати і в studies, і в
     ЦІНУ. Інваріант правила контрасту дослівно: «durBump/priceBump у формах
     зобовʼязані використовувати той самий contrastIsFilter, що й
     catalog.studyDur/studyPrice — інакше UI покаже одну ціну, а payload поїде
     з іншою». Жорсткий `false` тут стояв роками. */
  it.each(FORMS)("%s: contrast рядка їде і в studies, і в ціну", (file) => {
    const code = src(file);
    expect(code, `${file}: studies[].contrast додаткового більше не з рядка`)
      .toMatch(/contrast: s\.contrast === true, dur: Number\(s\.dur\) \|\| 0, price: studyPrice\(s\.type, s\.region, s\.contrast === true,/);
    expect(code, `${file}: ціна додаткового знову рахується з жорстким false`)
      .not.toMatch(/price: studyPrice\(s\.type, s\.region, false,/);
  });

  it.each(FORMS)("%s: зміна типу скидає і галочку фільтра рядка", (file) => {
    /* Інший тип — інший каталог: лишений filterOn дав би порожній список і
       мовчазне «контрастних немає».
       ⚠️ Якір — саме СПРЕД існуючого рядка (`...s,` / `...x,`): без нього
       регулярка ловила `exAdd`, який теж будує обʼєкт із `region: ""`, і
       мутація «прибрати скидання в changeType» лишалась зеленою (знайдено
       адресною фальсифікацією, M09). */
    expect(src(file), `${file}: filterOn переживає зміну модальності`)
      .toMatch(/\.\.\.[sx], type: \w+, region: "", dur: [^\n]{0,40}?, contrast: false, filterOn: false/);
  });

  /* ── Правки за ревʼю р1 ─────────────────────────────────────────────── */

  it.each(FORMS)("%s: новий рядок лишає filterOn НЕвизначеним", (file) => {
    /* `exChecked` читає `filterOn ?? contrast`. Явний `filterOn: false` у
       новому рядку глушив цей фолбек: оператор обирав «в/в контрастування», а
       галочка лишалась згаслою — екран казав «без контрасту» там, де в studies
       їхав `contrast: true` (підготовка пацієнта, алергія на гадоліній). */
    expect(src(file), `${file}: exAdd знову ставить filterOn — галочка не загориться на контрастній позиції`)
      .not.toMatch(/exAdd = \(\) => setExtraStudies\([^\n]*filterOn/);
  });

  it.each(FORMS)("%s: тривалість рядка рахує резолвер, а не форма", (file) => {
    const code = src(file);
    /* Своя арифметика «база + CONTRAST_DUR» була третьою копією правила
       режимів і розходилась із `studyDur` на позиції без часу (dur == null) і
       на області ПОЗА каталогом. Інваріант правила контрасту: форма зобовʼязана
       брати той самий contrastIsFilter, що й catalog.studyDur. */
    expect(code, `${file}: exSetRegion знову рахує час сам`)
      .toMatch(/dur: reg \? catalog\.studyDur\(r\.type, reg, contrast(Row)?, roomId/);
    expect(code, `${file}: у exSetRegion повернувся ручний bump`)
      .not.toMatch(/const bump = \(!?catalog\.contrastIsFilter/);
  });

  it.each(FORMS)("%s: перевірка «позиція переживає фільтр» — в ОБОХ режимах", (file) => {
    const code = src(file);
    // survives рахується ДО розгалуження по режиму — інакше легасі-гілка знову
    // лишала обрану область у payload при порожньому селекті.
    const sv = code.indexOf("const survives = !r.region");
    const branch = code.indexOf("if (catalog.contrastIsFilter(r.type, roomId");
    expect(sv, `${file}: survives не знайдено`).toBeGreaterThanOrEqual(0);
    expect(branch, `${file}: гілку режиму не знайдено`).toBeGreaterThanOrEqual(0);
    expect(sv, `${file}: survives рахується вже всередині гілки — легасі знову без перевірки`).toBeLessThan(branch);
    expect(code, `${file}: легасі-гілка не скидає область, що не пережила фільтр`)
      .toMatch(/if \(!survives\) \{ exPatch\(i, \{ contrast: v, filterOn: v, region: "", dur: 0 \}\); return; \}/);
  });

  it.each(FORMS)("%s: легасі-дельта не вигадує час і не пробиває стелю", (file) => {
    const code = src(file);
    /* `dur > 0` — 0 означає «час не задано» (канон 0117), і Math.max(5,…)
       робив із нього 15 хв. `Math.min(DUR_MAX, …)` — та сама стеля, що в
       ручному полі: без неї галочка виводила тривалість за CHECK у БД. */
    expect(code, `${file}: дельта знову працює на нульовій тривалості або без стелі`)
      .toMatch(/dur: r\.region && cur > 0 \? Math\.min\(DUR_MAX, Math\.max\(5, cur \+ delta\)\) : 0/);
  });

  it.each(FORMS)("%s: зміна РЕЖИМУ контрасту скидає вибір рядків", (file) => {
    const code = src(file);
    /* `contrastIsFilter` залежить від пари (тип, кабінет): перемикання кабінету
       перевертає сенс `contrast: true` (у каталозі «позиція вже контрастна», у
       легасі «додай 900 ₴ і 15 хв»). Ефект по набору областей цього не ловить —
       у двох кабінетах однієї модальності назви позицій збігаються. */
    expect(code, `${file}: сторож зміни режиму зник — рядок переїде в чужу семантику`)
      .toMatch(/const prevContrastModeRef = useRef\(contrastMode\);/);
    expect(code, `${file}: ефект більше не скидає рядки при зміні режиму`)
      .toMatch(/prevContrastModeRef\.current = contrastMode;[\s\S]{0,400}?filterOn: undefined/);
  });

  it.each(FORMS)("%s: селект рядка показує саме обрану область", (file) => {
    // value="" при !hasRegion давало порожній селект на рядку, який уже їде в
    // payload: опція «(поточне)» відрисована, але не обрана.
    expect(src(file), `${file}: селект знову підміняє обрану область порожнім значенням`)
      .not.toMatch(/value=\{hasRegion \? r\.region : ""\}/);
  });

  it.each(FORMS)("%s: спільної галочки «Контраст» у шапці більше немає", (file) => {
    const code = src(file);
    /* Блок «Параметри» тепер несе ЛИШЕ протипоказання. Повернути туди контраст —
       означає повернути стан «одна галочка на всі дослідження». */
    const block = code.slice(code.indexOf('<div className="bk-check-row">'), code.indexOf('<div className="bk-check-row">') + 700);
    expect(block.length, `${file}: блок «Параметри» не знайдено`).toBeGreaterThan(0);
    expect(block, `${file}: у шапку повернули спільний чекбокс контрасту`).not.toMatch(/toggleContrast/);
    expect(block, "протипоказання мусять лишитись у шапці").toMatch(/setHasContra/);
  });
});

describe("с47: тип · протипоказання · пріоритет — на одному рівні", () => {
  it.each(FORMS)("%s: верхній рядок форми — bk-head-row", (file) => {
    const code = src(file);
    expect(code, `${file}: контейнер одного рівня зник`).toMatch(/<div className="bk-head-row">/);
    /* Пріоритет мусить лежати ВСЕРЕДИНІ цього рядка, а не під ним. Перевіряємо
       порядок: відкриття bk-head-row → підпис пріоритету → StudySearchBox
       (перший блок ПІСЛЯ рядка). Інакше тест був би про наявність, а не про
       рівень. */
    const head = code.indexOf('<div className="bk-head-row">');
    const prio = code.indexOf("Пріоритет пацієнта", head);
    const after = code.indexOf("<StudySearchBox", head);
    expect(prio, `${file}: пріоритет не знайдено після bk-head-row`).toBeGreaterThan(head);
    expect(prio, `${file}: пріоритет виїхав із рядка — він має бути ДО наступного блоку форми`).toBeLessThan(after);
  });

  /* ⚠️ ГРІД, а не flex-wrap (друга ітерація власника, с47). З `flex-wrap` рядок
     тримався в один рівень ЛИШЕ поки все вміщувалось: на вужчому вікні або при
     четвертій модальності пріоритет їхав на другий рядок і розтягувався на всю
     ширину поруч із напівпорожнім першим. Власник прислав це скріншотом. */
  it("CSS: bk-head-row — грід із трьох колонок, а не wrap", () => {
    const css = raw(CSS);
    expect(css, "bk-head-row повернувся до flex-wrap — пріоритет знову поїде на другий рядок")
      .toMatch(/\.bk-head-row \{[^}]*display: grid;[^}]*grid-template-columns: auto auto minmax\(0, 1fr\)/);
    expect(css, "у .bk-head-row лишився flex-wrap").not.toMatch(/\.bk-head-row \{[^}]*flex-wrap/);
    expect(css, "вирівнювання по верху зникло").toMatch(/\.bk-head-row \{[^}]*align-items: start/);
    // Сегменти мусять уміти стискатись, інакше грід розпирає колонку.
    expect(css, "сегменти в рядку знову не стискаються")
      .toMatch(/\.bk-head-row \.prio-seg, \.bk-head-row \.bk-seg \{[^}]*min-width: 0/);
    /* Компактні відступи сегментів пріоритету САМЕ в цьому рядку. Числа
       зміряні у браузері: при лівій колонці 476px (випадок зі скріншота
       власника) сегментам треба 214.5px, а грід дає 192.2px — без компактних
       відступів вони переносяться на два рядки всередині свого поля, і
       «один рівень» знову виглядає зламаним. */
    expect(css, "компактні відступи сегментів пріоритету зникли — на 476px вони знову переносяться")
      .toMatch(/\.bk-head-row \.prio-seg-btn \{[^}]*padding: 5px 6px/);
    expect(css, "gap рядка повернувся до 12px — пріоритету бракує 4px")
      .toMatch(/\.bk-head-row \{[^}]*gap: 10px/);
  });

  it.each(FORMS)("%s: ширини рядка живуть у CSS, а не в інлайнах", (file) => {
    /* На ГРІД-елементах інлайновий `flex` не діє взагалі — залишений, він лише
       вводить в оману наступного читача (ревʼю р2). */
    const code = src(file);
    const head = code.indexOf('<div className="bk-head-row">');
    const seg = code.slice(head, code.indexOf("<StudySearchBox", head));
    expect(seg, `${file}: у дітях bk-head-row лишився інлайновий flex`).not.toMatch(/style=\{\{ flex:/);
  });
});

/* ── Друга ітерація власника: у чекбоксі контрасту немає тексту ───────────
   Рішення с47 СКАСОВУЄ рішення с28 («з контрастом» замість «Контраст»):
   підпис поля / заголовок колонки вже кажуть «Контраст», і прийменник читався
   як друга назва того самого. Стосується ВСІХ ролей і всіх модалок із
   фільтром контрасту. */
describe("с47: чекбокс контрасту — без тексту, у всіх формах", () => {
  const WITH_CONTRAST_CHECKBOX = [BOOKING, PORTAL, "components/StudyEditModal.tsx"];

  it.each(WITH_CONTRAST_CHECKBOX)("%s: підпису «з контрастом» у чекбоксі немає", (file) => {
    const code = src(file);
    /* Шукаємо саме ВИДИМИЙ текст у <span> поруч із .rf-box, а не рядок узагалі:
       «з контрастуванням» лишається в `title`/`aria-label` (там воно пояснює
       семантику) і в назвах послуг прайсу. */
    expect(code, `${file}: текст повернувся всередину чекбокса`)
      .not.toMatch(/<span className="rf-box" \/><span>\{[^}]*контраст/i);
    expect(code, `${file}: у чекбоксі зʼявився підпис «+N хв»`)
      .not.toMatch(/<span className="rf-box" \/><span>\{[^}]*CONTRAST_DUR/);
  });

  it.each(WITH_CONTRAST_CHECKBOX)("%s: доступне імʼя лишилось на самому input", (file) => {
    /* Прибрали видимий текст — доступне імʼя мусить бути в aria-label, інакше
       скрінрідер читає «прапорець» без жодної назви (WCAG 4.1.2). */
    // `[\s\S]` — вираз aria-label буває розбитий на кілька рядків.
    expect(src(file), `${file}: чекбокс контрасту лишився без aria-label`)
      .toMatch(/aria-label=\{[\s\S]{0,140}?[Кк]онтраст/);
  });

  it("CSS: порожній чекбокс — квадрат, а не поле з мертвим padding'ом", () => {
    const css = raw(CSS);
    expect(css, "правило .rf-check-bare зникло — порожній чекбокс лишиться з padding під текст")
      .toMatch(/\.rf-check-bare \{[^}]*padding: 0;[^}]*width: \d+px/);
    expect(css, "чекбокс у таблиці знову розтягнутий під текст")
      .toMatch(/\.bk-study-contrast \{[^}]*width: 32px/);
  });

  /* ⚠️ Клас у JSX без правила в CSS — це не «нічого не станеться», а фактичний
     дефект: поле успадкувало `.fld-row .fld { flex: 1 }` і разом із
     `min-width: 0` стиснулось у НУЛЬ — чекбокс зник, підпис наїхав на
     «Тривалість». Зловлено живою перевіркою на проді (ширина поля = 0px). */
  it("CSS: поле «Контраст» у ряду має явний flex і не стискається", () => {
    const css = raw(CSS);
    expect(css, "правила .bk-fld-contrast немає — поле стиснеться в нуль")
      .toMatch(/\.bk-fld-contrast \{[^}]*flex: 0 0 auto/);
    expect(css, "підпис поля може перенестись і зламати ряд")
      .toMatch(/\.bk-fld-contrast > \.fld-lab \{[^}]*white-space: nowrap/);
  });

  it.each([BOOKING, PORTAL])("%s: клас поля «Контраст» справді використовується", (file) => {
    // Симетрія до правила вище: клас без застосування так само мертвий.
    expect(src(file), `${file}: bk-fld-contrast зник із розмітки`)
      .toMatch(/className="fld bk-fld-contrast"/);
  });
});

describe("с47: пріоритет за замовчуванням — «Планово»", () => {
  it.each(FORMS)("%s: ініціалізація з PRIORITY_DEFAULT", (file) => {
    expect(src(file), `${file}: дефолт пріоритету відкотили в порожній`)
      .toMatch(/useState<PatientPriority \| "">\((prefill\?\.priority \|\| )?PRIORITY_DEFAULT\)/);
  });

  /* ⚠️ Найдешевший мовчазний відкат цієї правки — НЕ в useState, а в скиданні
     форми після збереження: `setPriority("")` лишав дефолт живим рівно до
     першого направлення. Саме так воно й було написано до пакета. */
  it.each(FORMS)("%s: скидання форми повертає ТОЙ САМИЙ дефолт", (file) => {
    expect(src(file), `${file}: після збереження пріоритет знову скидається в порожній`)
      .not.toMatch(/setPriority\(""\)/);
  });

  it("PRIORITY_DEFAULT — це «planned»", () => {
    expect(src("lib/priority.ts")).toMatch(/export const PRIORITY_DEFAULT: PatientPriority = "planned";/);
  });
});

describe("с47: календар нижчий — сітка слотів вища", () => {
  const css = raw(CSS);

  /* ⚠️ Важіль висоти. У базового `.cal-day` стоїть `aspect-ratio: 1`: висота
     дня дорівнює його ШИРИНІ, тож у колонці 372px календар займав ~290px, а
     `min-height` нічого не міняв. Знімеш `aspect-ratio: auto` — і `height`
     нижче стане мертвим, календар мовчки повернеться до старої висоти. */
  it("bk-cal знімає aspect-ratio і задає висоту дня явно", () => {
    expect(css, "aspect-ratio повернувся — height у .bk-cal .cal-day знову нічого не важить")
      .toMatch(/\.bk-cal \.cal-day \{[^}]*aspect-ratio: auto;[^}]*height: \d+px/);
  });

  it("сітка слотів отримала звільнену висоту й не стала нижчою за стару", () => {
    const m = css.match(/\.slot-grid4 \{[^}]*max-height: ([^;]+);/);
    expect(m, "у .slot-grid4 зникла стеля висоти").toBeTruthy();
    expect(m![1], "стеля повернулась до старих 340px — кабінет 08:00–22:00 знову не вміщується")
      .not.toBe("340px");
    // Обмеження по В'ЮПОРТУ: без нього сітка виштовхує підвал із «Зберегти».
    expect(m![1], "зникло обмеження по висоті екрана").toMatch(/vh/);
    /* ⚠️ І ПІДЛОГА (ревʼю р2): 46vh на 720px екрана = 331px, тобто МЕНШЕ старих
       340px. Без max(340px, …) правка «збільшити сітку» робила б її нижчою на
       ноутбуках 1366×768 і всьому, що нижче. */
    expect(m![1], "зникла підлога 340px — на низьких екранах сітка стала б меншою, ніж була")
      .toMatch(/max\(340px/);
  });

  /* Найважливіше в цій вимозі: сам по собі нижчий календар нічого не дає —
     він лише ПЕРЕСТАВЛЯЄ пікселі всередині правої колонки, а скролить `.bk-grid`,
     висоту якого задає ліва колонка. Розклад тримає перед очима липка колонка. */
  it("права колонка розкладу — липка на двоколонковій розкладці", () => {
    expect(css, "sticky зник — «Вільні слоти» знову треба шукати прокруткою")
      .toMatch(/@media \(min-width: 721px\) \{\s*\n?\s*\.bk-col-right \{[^}]*position: sticky/);
    expect(css, "без align-self: start грід розтягує колонку і sticky не працює")
      .toMatch(/\.bk-col-right \{[^}]*align-self: start/);
  });

  it("обидві мітки дня зменшені під компактну комірку", () => {
    // .cal-change зменшили ще в 0133; .cal-sched лишалась 7px при top/left 3/4 —
    // у комірці 26px вона стояла несиметрично й підходила впритул до цифри.
    expect(css, "мітку режиму дня не зменшили разом із коміркою")
      .toMatch(/\.bk-cal \.cal-sched \{[^}]*width: 6px/);
    // Тач-таргет: 26px формально проходить WCAG 2.5.8, але на стійці промахуються.
    expect(css, "на дотикових екранах день календаря лишився 26px")
      .toMatch(/@media \(pointer: coarse\) \{ \.bk-cal \.cal-day \{ height: \d\dpx; \} \}/);
  });

  /* Шапка й рядки таблиці додаткових мусять мати ОДНАКОВУ сітку колонок —
     інакше заголовки роз'їдуться з комірками. Перевіряємо в базовому правилі
     і в мобільному медіа-запиті: колонок стало пʼять (додався «Контраст»). */
  it("шапка й рядки таблиці досліджень мають однакові колонки", () => {
    const cols = [...css.matchAll(/\.bk-study-head[^{]*\{[^}]*grid-template-columns: ([^;]+);/g)].map((m) => m[1].trim());
    const rows = [...css.matchAll(/\.bk-study-row \{[^}]*grid-template-columns: ([^;]+);/g)].map((m) => m[1].trim());
    expect(cols.length, "правило шапки таблиці не знайдено").toBeGreaterThan(0);
    for (const c of cols) expect(c.split(/\s+/).length, `у шапці не 5 колонок: ${c}`).toBe(5);
    // Базове правило пише шапку й рядок разом; мобільне — теж разом. Головне,
    // щоб кількість колонок збігалась у ВСІХ парах.
    for (const r of rows) expect(r.split(/\s+/).length, `у рядку не 5 колонок: ${r}`).toBe(5);
    /* Колонка назви мусить лишитись СТИСКАЛЬНОЮ: із `1fr` (= minmax(auto,1fr))
       min-content селекта з довгою назвою розпирає ліву колонку, і замість
       обрізки зʼявляється горизонтальний скрол усієї форми (ревʼю р2). */
    for (const t of [...cols, ...rows]) expect(t, `колонка назви не стискається: ${t}`).toMatch(/minmax\(0,1fr\)/);
  });
});

describe("с47: доступність нового чекбокса", () => {
  it.each(FORMS)("%s: чекбокс рядка має власне доступне імʼя", (file) => {
    /* Видимий підпис однаковий у всіх рядків («з контрастом»), тож без
       aria-label скрінрідер читає його N разів поспіль, не називаючи, до якого
       дослідження це стосується (ревʼю р2). */
    expect(src(file), `${file}: у чекбокса рядка зникло aria-label із назвою дослідження`)
      .toMatch(/aria-label=\{[^\n]*дослідження \$\{i \+ 2\}/);
  });

  it("клавіатурний фокус видно на «фальшивому» чекбоксі", () => {
    /* `.rf-check` ховає сам input (opacity:0), тож глобальне `:focus-visible`
       його не показує — навігація з клавіатури по формі була сліпою. */
    expect(raw(CSS), "підсвітка фокуса обгортки .rf-check зникла")
      .toMatch(/\.rf-check:has\(input:focus-visible\) \{[^}]*outline:/);
  });
});
