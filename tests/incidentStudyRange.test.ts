/* U-33 (с49) — простій блокує ДОСЛІДЖЕННЯ, а не лише його старт.
 *
 * Дефект був подвійний, і журнал знав лише про меншу половину:
 *
 *  1. ФІД. Дошка викидала «згаслі» простої (`incidentExpired`) з фіда для форм
 *     запису, а серверний гард відбирає рядки за `status in ('active','planned')`.
 *     У вікні до 5 хв (крон `resolve-expired-incidents`) відповіді розходились.
 *     ⚠️ Точне формулювання: `blocked_until` гард ЗНАЄ (це верхня межа його
 *     `tstzrange`), але не порівнює її з `now()`.
 *
 *  2. ІНТЕРВАЛ — і це більша половина, якої в журналі не було зовсім.
 *     `BookingModal` і `RescheduleModal` питали `slotBlockedByFeed`, тобто
 *     «чи вільний ЦЕЙ момент». Сервер порівнює ДІАПАЗОНИ:
 *        tstzrange(started_at, coalesce(blocked_until,'infinity'))
 *          && tstzrange(scheduled_at, scheduled_at + duration_min)
 *     Планове ТО о 12:00 і запис на 11:45 тривалістю 30 хв: слот зелений,
 *     відмова після «Зберегти». Жодного крона для цього не треба — дефект
 *     постійний. Асиметрія жила ВСЕРЕДИНІ `slotState`: для чужих записів,
 *     графіка і перерв там рахувався інтервал, і лише для простоїв — момент.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { incidentFeed, studyBlockedByFeed, wallInstant, type IncidentLike } from "@/lib/incidents";
import { codeOf } from "./helpers/codeOf";

const DAY = "2026-08-28";
const at = (t: string) => wallInstant(DAY, t);

/** Тіло названої функції за збігом дужок — щоб пінити те, що бачить оператор,
 *  а не наявність рядка ДЕСЬ у файлі. Знадобилось після живої перевірки U-33:
 *  у `ReferralPortal` потрібні тексти були в рядку-вердикті, а тултип сітки
 *  лишався літералом — і сторож «файл містить текст» був зелений. */
function bodyOf(code: string, fn: string): string {
  const head = code.indexOf(`function ${fn}(`);
  if (head < 0) return "";
  const open = code.indexOf("{", head);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open + 1, i);
  }
  return "";
}

/** Простій 12:00–14:00 у кабінеті r1. */
const INC = (over: Partial<IncidentLike> = {}): IncidentLike => ({
  room_id: "r1",
  started_at: DAY + "T12:00:00.000Z",
  blocked_until: DAY + "T14:00:00.000Z",
  ...over,
} as IncidentLike);

describe("studyBlockedByFeed — дзеркало діапазонів check_not_during_incident", () => {
  const feed = incidentFeed([INC()], false);

  it("дослідження ЗАХОДИТЬ у простій із-під його початку — блокуємо (головний випадок)", () => {
    // 11:45 + 30 хв = 12:15 ⇒ перетин із 12:00–14:00. Стара перевірка старту
    // казала «вільно», сервер відхиляв.
    expect(studyBlockedByFeed(feed, "r1", at("11:45"), 30)).toBe(true);
  });

  it("те саме дослідження, що ВСТИГАЄ закінчитись, — вільно", () => {
    // 11:45 + 15 хв = 12:00. Діапазони напівінтервальні `[)`, тож дотик кінцем
    // у початок простою перетином НЕ є — і сервер такий запис приймає.
    expect(studyBlockedByFeed(feed, "r1", at("11:45"), 15)).toBe(false);
  });

  it("межа рахується по ХВИЛИНАХ, а не «майже»: 16 хв уже перетин", () => {
    expect(studyBlockedByFeed(feed, "r1", at("11:45"), 16)).toBe(true);
  });

  it("старт УСЕРЕДИНІ простою — блокуємо (стара відповідь збережена)", () => {
    expect(studyBlockedByFeed(feed, "r1", at("13:00"), 5)).toBe(true);
  });

  it("після кінця простою — вільно", () => {
    expect(studyBlockedByFeed(feed, "r1", at("14:00"), 60)).toBe(false);
  });

  it("чужий кабінет не блокується", () => {
    expect(studyBlockedByFeed(feed, "r2", at("11:45"), 30)).toBe(false);
  });

  it("«до відновлення» (blocked_until = null) блокує все, що заходить уперед", () => {
    const open = incidentFeed([INC({ blocked_until: null })], false);
    expect(studyBlockedByFeed(open, "r1", at("11:45"), 30)).toBe(true);
    // але не заднім числом: до початку простою кабінет працював
    expect(studyBlockedByFeed(open, "r1", at("11:00"), 30)).toBe(false);
  });

  /* ── Невідомість не має шляху стати «вільно» ─────────────────────────────── */

  it("простої не прочитані → заблоковано (fail-closed), незалежно від тривалості", () => {
    expect(studyBlockedByFeed(null, "r1", at("09:00"), 30)).toBe(true);
    expect(studyBlockedByFeed(incidentFeed([], true), "r1", at("09:00"), 30)).toBe(true);
  });

  it("простоїв немає — вільно (порожній УСПІШНИЙ фід ≠ невідомість)", () => {
    expect(studyBlockedByFeed(incidentFeed([], false), "r1", at("11:45"), 30)).toBe(false);
  });

  /* NaN/0 у тривалості у формах не виникає, але поведінку пінимо явно, бо тут
     дзеркало РОЗХОДИТЬСЯ із сервером у консервативний бік: сервер при
     `duration_min is null` запис пропускає, а ми на старті всередині простою
     блокуємо. Тест фіксує саме це рішення, щоб воно не «поїхало» мовчки. */
  it("тривалість NaN/0 → лишається питання про СТАРТ, а не «вільно»", () => {
    expect(studyBlockedByFeed(feed, "r1", at("13:00"), NaN)).toBe(true);   // старт у простої
    expect(studyBlockedByFeed(feed, "r1", at("11:45"), NaN)).toBe(false);  // старт поза ним
    expect(studyBlockedByFeed(feed, "r1", at("13:00"), 0)).toBe(true);
  });

  it("БУФЕР прибирання не входить: гард рахує рівно duration_min", () => {
    /* 11:45 + 15 хв дослідження = 12:00 — сервер приймає, навіть якщо після
       нього стоїть 15 хв буфера. Якби буфер додавали, форма блокувала б слоти,
       які сервер пропускає, — брехня в інший бік. */
    expect(studyBlockedByFeed(feed, "r1", at("11:45"), 15)).toBe(false);
  });
});

/* ═══════ Проводка: який фід отримує КОЖЕН споживач `incidents` ═════════════

   Це СКАНЕР, а не список: він знаходить у `QueueBoard` усі місця, де проп
   `incidents` передається вниз, і вимагає, щоб кожен компонент був названий у
   таблиці нижче. Новий споживач (або новий вхід у наявний) валить тест доти,
   доки хтось не вирішить СВІДОМО, яке з двох питань він ставить:

     writeIncidentsFeed — «чи прийме це сервер» (усе, що пише queue_entries);
     incidentsFeed      — «чи заблоковано ЗАРАЗ» (картки, банери, зняття простою).

   Урок с47, через який сканер і зʼявився: сторож компонента не захищає МІСЦЯ
   ВИКЛИКУ — проп можна підмінити «зовні», лишивши все зеленим. */

const QB = readFileSync(resolve(process.cwd(), "components/QueueBoard.tsx"), "utf8");

/** Компоненти, що ПИШУТЬ queue_entries (прямо або через дочірню форму). */
const WRITE_FORMS = [
  "BookingModal", "RescheduleModal", "WaitlistCandidatesModal",
  "CollisionPanel", "QuickRescheduleButton", "CaseModal", "StudyEditModal",
];
/** Читання «чи заблоковано зараз» — фід із викинутими «згаслими». */
const READ_NOW = ["RoomDayOverviewModal", "BreakdownModal"];

/** Кожне `incidents={X}` у файлі + найближчий тег ВИЩЕ за текстом.
 *  ⚠️ Пробіли всередині дужок ДОЗВОЛЕНІ (ревʼю пакета): перша версія вимагала
 *  `}` одразу за словом, і мутація `incidents={ incidentsFeed }` прибирала сайт
 *  зі сканера цілком — усі чотири тести лишались зеленими, а дефект вертався. */
function incidentPropSites(code: string): Array<{ tag: string; feed: string }> {
  return [...code.matchAll(/incidents=\{\s*([\w.]+)\s*\}/g)].map((m) => {
    const before = code.slice(0, m.index as number);
    const tags = [...before.matchAll(/<([A-Z]\w+)/g)];
    return { tag: tags.length ? tags[tags.length - 1][1] : "?", feed: m[1] };
  });
}

describe("U-33: проводка фідів простоїв у QueueBoard", () => {
  const sites = incidentPropSites(QB);

  /** Скільки входів `incidents=` має КОЖЕН компонент. Перепис, а не поріг:
   *  зникнення сайта (переніс у вираз, spread, умовний фід) валить тест. */
  const CENSUS: Record<string, number> = {
    BookingModal: 2, RescheduleModal: 1, WaitlistCandidatesModal: 1,
    CollisionPanel: 1, QuickRescheduleButton: 1, CaseModal: 1, StudyEditModal: 1,
    RoomDayOverviewModal: 1, BreakdownModal: 1,
  };

  it("перепис входів збігається — жоден сайт не зник і не задвоївся", () => {
    /* Антитавтологія і одночасно захист від «сайт заховали у вираз»: раніше тут
       стояв поріг `>= 8`, і будь-яке зникнення входу лишалось непоміченим. */
    const got: Record<string, number> = {};
    for (const s of sites) got[s.tag] = (got[s.tag] || 0) + 1;
    expect(got, "перепис входів incidents= у QueueBoard змінився").toEqual(CENSUS);
    /* І ЖОДЕН `incidents={…}` не сховався у виразі, якого сканер не читає:
       кількість «сирих» входжень мусить дорівнювати кількості розібраних. */
    const raw = (QB.match(/incidents=\{/g) || []).length;
    expect(raw, "є incidents={…}, який сканер не розібрав (вираз? spread?)")
      .toBe(sites.length);
  });

  it("КОЖЕН споживач класифікований — новий валить тест, а не проїжджає мовчки", () => {
    const unknown = [...new Set(sites.map((s) => s.tag))]
      .filter((t) => !WRITE_FORMS.includes(t) && !READ_NOW.includes(t))
      .sort();
    expect(unknown,
      "новий споживач простоїв: вирішіть, він питає «чи прийме сервер» чи «чи заблоковано зараз»")
      .toEqual([]);
  });

  it("форми запису отримують writeIncidentsFeed — УСІ входи, без винятків", () => {
    const wrong = sites
      .filter((s) => WRITE_FORMS.includes(s.tag) && s.feed !== "writeIncidentsFeed")
      .map((s) => `${s.tag}=${s.feed}`)
      .sort();
    expect(wrong, "форма запису дістала фід «чи заблоковано зараз»").toEqual([]);
    /* ⚠️ І сам ФІД мусить лишатись собою: `const writeIncidentsFeed =
       loadIncidentsFeed;` можна замінити на `= incidentsFeed`, і всі сайти
       вище лишаться зеленими, бо імʼя не змінилось (ревʼю пакета). */
    expect(QB, "writeIncidentsFeed перестав бути сирим фідом сервера")
      .toMatch(/const writeIncidentsFeed = loadIncidentsFeed;/);
    expect(QB, "loadIncidentsFeed більше не збирається з УСІХ рядків")
      .toMatch(/const loadIncidentsFeed = incidentFeed\(incidents, incidentsErr\);/);
  });

  it("екрани «чи заблоковано зараз» лишились на incidentsFeed", () => {
    const wrong = sites
      .filter((s) => READ_NOW.includes(s.tag) && s.feed !== "incidentsFeed")
      .map((s) => `${s.tag}=${s.feed}`)
      .sort();
    expect(wrong, "екран про «зараз» дістав фід сервера").toEqual([]);
  });
});

/* ═══════ Проводка: модалки питають про ДОСЛІДЖЕННЯ, а не про момент ═══════ */

describe("U-33: форми запису рахують ІНТЕРВАЛ, а не старт", () => {
  /* ⚠️ ТРИ файли, а не два (ревʼю пакета). У `ReferralPortal` — ВЛАСНА сітка
     слотів, а не лише модалки: у першій карті споживачів її не було, і дефект
     U-33 лишався б у направника цілком. */
  /* Четверта колонка — УМОВА гілки «дослідження заходить у простій» усередині
     `blockedLabel`. Потрібна тому, що статичний сторож не бачить МЕРТВУ гілку:
     знеструмити умову (`if (false && …)`) — і тултип завжди друкує літерал,
     хоч потрібний текст лишається у файлі й у тілі функції. Пінити текст +
     привʼязку тут недостатньо, і чесна межа цього названа в PR (борг U-47:
     винести побудову тексту в `lib/` і перевіряти ПОВЕДІНКОЮ). */
  const FORMS: Array<[file: string, call: RegExp, bind: RegExp, cross: RegExp]> = [
    ["components/BookingModal.tsx",
     /studyBlockedByFeed\(incidents, roomId, base, slotDur\)/,
     /if \(slotBlockedByIncident\(s\)\) return "blocked";/,
     /if \(cap !== undefined && Number\.isFinite\(cap\)\) \{/],
    ["components/RescheduleModal.tsx",
     /studyBlockedByFeed\(incidents, roomId, dt, dur\)/,
     /if \(slotBlockedByIncident\(a\)\) return "blocked";/,
     /if \(cap !== undefined && Number\.isFinite\(cap\)\) \{/],
    ["components/ReferralPortal.tsx",
     /studyBlockedByFeed\(incFeed, roomId, slotMs, slotDur\)/,
     /if \(studyBlockedByFeed\(incFeed, roomId, slotMs, slotDur\)\) return "blocked";/,
     /if \(cap > 0 && Number\.isFinite\(cap\)\) \{/],
  ];
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it.each(FORMS)("%s викликає studyBlockedByFeed із САМЕ тривалістю", (file, call) => {
    const code = src(file);
    /* Пінимо ВИКЛИК із конкретними іменами аргументів, а не з `\w+`: ревʼю
       показало, що `\w+` приймає і `buffer` — і тоді простій знову блокував би
       не те (сервер рахує рівно `duration_min`, без буфера). Імпорт тут теж не
       годиться: сторож, що шукає імʼя, ловить рядок імпорту (урок с46). */
    expect(code, `${file}: немає виклику studyBlockedByFeed із тривалістю`).toMatch(call);
  });

  it.each(FORMS)("%s ПРИВʼЯЗУЄ предикат до сітки (не лише має його)", (file, _call, bind) => {
    /* ⚠️ Урок U-15 (D-3), перенесений сюди ревʼю: тіла функцій мало. Прибрати
       рядок `if (…) return "blocked";` зі `slotState` — і всі інші сторожі
       лишаються зеленими, бо і виклик, і тексти на місці, просто сітка більше
       не питає про простій. Пінимо саме ПРИВʼЯЗКУ, і окремо — те, що сітка
       малюється ЦІЄЮ функцією. */
    const code = codeOf(src(file));
    expect(code, `${file}: slotState більше не питає про простій`).toMatch(bind);
    expect(code, `${file}: SlotPicker малює сітку не через slotState`)
      .toMatch(/stateOf=\{slotState\}/);
  });

  it.each(FORMS)("%s більше НЕ вирішує простій по одному моменту", (file) => {
    /* Найдешевший тихий відкат — повернути `slotBlockedByFeed`: тип той самий,
       tsc мовчить, сітка знову зеленіє на слотах, які сервер відхиляє.
       ⚠️ Читаємо КОД, а не текст файла: у самій правці стоїть коментар, який
       ПОЯСНЮЄ, чому старий предикат більше не годиться, — і наївний
       `.not.toContain` червонів на власному поясненні (спіймано першим
       прогоном, той самий клас, що в U-37). */
    expect(codeOf(src(file)), `${file}: повернувся старт-онлі предикат`)
      .not.toContain("slotBlockedByFeed");
  });

  it.each(FORMS)("%s називає СПРАВЖНЮ причину в тултипі, а не «до відновлення»", (file, _c, _b, cross) => {
    /* Старий `blockedLabel` шукав простій, що НАКРИВАЄ сам слот, і при
       `inc === undefined` друкував «Кабінет на ремонті/ТО · До відновлення».
       Після правки це рівно новий випадок — слот ПОЗА простоєм, а заблокований
       тим, що дослідження в нього заходить, — і старий текст називав причиною
       відсутність простою. Тултип тут не косметика: це єдине місце, де оператор
       дізнається, чому зелений слот став червоним. */
    /* ⚠️ Перша версія цього сторожа читала ВЕСЬ файл — і була зеленою на
       `ReferralPortal`, де обидва тексти жили в РЯДКУ-ВЕРДИКТІ, а тултип сітки
       лишався літералом «Кабінет на ремонті/ТО». Знайшла це жива перевірка вже
       після «зеленого» пакета: сторож пінив наявність рядка у файлі, а не те,
       що бачить оператор, наводячись на слот. Тепер — ТІЛО функції тултипа
       плюс сама привʼязка. */
    const code = codeOf(src(file));
    const label = bodyOf(code, "blockedLabel");
    expect(label, `${file}: не знайдено тіло blockedLabel`).not.toBe("");
    expect(label, `${file}: тултип не пояснює перетин із простоєм`)
      .toContain("заходить у простій кабінету з");
    /* Регістр першої літери різний: у модалках це початок другого рядка
       тултипа, у порталі — середина речення. Пінимо суть, а не оформлення. */
    expect(label, `${file}: тултип не називає, скільки часу реально вільно`)
      .toMatch(/[Вв]ільно лише /);
    expect(code, `${file}: тултип сітки для "blocked" — літерал, а не пояснення`)
      .toMatch(/st === "blocked" \? blockedLabel\(s\)/);
    /* І гілка, що друкує це пояснення, під струмом: інакше текст лишається в
       тілі, а оператор його ніколи не побачить (мертва гілка). */
    expect(label, `${file}: гілку «дослідження заходить у простій» знеструмлено`)
      .toMatch(cross);
  });

  it("StudyEditModal (U-15) навпаки лишається на моменті — там слот НЕ обирають", () => {
    /* Межа пакета названа вголос: модалка ТРИВАЛОСТІ має власну стелю
       (`incidentDurCapMin`), бо слот у ній фіксований, а міняється довжина.
       ⚠️ Пінимо ВИКЛИКИ, а не імена (урок с46): перша версія цього тесту
       перевіряла `toContain("slotBlockedByFeed")` — і мутація, що перейменувала
       ЛИШЕ рядок імпорту, лишалась зеленою, бо саме імʼя нікуди не дівалось із
       тіла. Фальсифікація N14 це й показала. */
    const code = codeOf(src("components/StudyEditModal.tsx"));
    /* ⚠️ Стелю модалка бере не з `incidentDurCapMin` напряму, а через обгортку
       `incidentDurNotice` (одне рішення на три величини — U-15). Перша версія
       тесту пінила саме `incidentDurCapMin(` і була ЧЕРВОНОЮ на чистому дереві:
       ім'я є лише в коментарі. Пінимо реальний виклик. */
    expect(code, "StudyEditModal утратив власну стелю тривалості")
      .toMatch(/incidentDurNotice\(/);
    expect(code, "StudyEditModal утратив перевірку слота (старт фіксований)")
      .toMatch(/slotBlockedByFeed\(/);
  });
});
