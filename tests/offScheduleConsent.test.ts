/**
 * U-12 — «згода на роботу поза графіком їхала не з тим, хто її дає».
 *
 * Правило 0077 (сервер, `scheduleBlock` в app/queue/actions.ts):
 *
 *     if (!info) return { blocked: null, offSchedule: false };  // у графіку
 *     if (!info.confirmable) return { blocked: offSchedError(info) };
 *     if (!opts.isStaff) return { blocked: OFF_SCHED_ERR };     // ← НАПРАВНИК НІКОЛИ
 *     if (!opts.offSchedule) return { blocked: offSchedNeedsConfirm(info) };
 *
 * Тобто підтверджуваний вихід за графік — привілей ПЕРСОНАЛУ центру, і
 * перевіряється він РАНІШЕ за саму згоду. Редактор досліджень цього не знав:
 *
 *  1. проп `offSchedule` (запис САМ легально стоїть поза графіком) був
 *     необовʼязковим із дефолтом `false`, і `ReferralPortal` його не передавав.
 *     Для направника запис на 17:55 у кабінеті, що закривається о 18:00, ставав
 *     НЕЗБЕРЕЖУВАНИМ назавжди: стеля рахувалась по кінцю графіка → «⚠ Не
 *     вміщується» → сіре «Зберегти». Рівно той провал, заради якого писалась
 *     0077;
 *  2. згода `offSchedule` у `onConfirm` була ДЕТАЛЛЮ meta, і дошки могли її
 *     не довезти до Server Action;
 *  3. зворотний бік: направнику показувалась галочка «Підтверджую роботу поза
 *     графіком» — обіцянка, яку сервер відхиляє гілкою `!opts.isStaff`.
 *
 * Рішення власника (с47): СЕРВЕРНЕ ПРАВИЛО НЕ ЧІПАЄМО, клієнт перестає брехати.
 * Направник бачить пряму відмову з причиною замість сірої кнопки.
 *
 * Механізм, а не уважність: `offSchedule`, `allowOffSchedule` (StudyEditModal) і
 * `referralMode` (CaseModal) — ОБОВʼЯЗКОВІ пропи БЕЗ дефолта, тож повноту місць
 * виклику перелічує tsc. Ці сторожі тримають рівно те, чого tsc не бачить:
 * що проп лишився обовʼязковим, що в кожному місці виклику написана ПРАВИЛЬНА
 * відповідь, і що серверне правило, яке клієнт дзеркалить, не змінилось.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";
import { offScheduleKind, offReasonText, type OffScheduleInfo, type EffectiveRoomSchedule } from "../lib/schedule";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

const MODAL = "components/StudyEditModal.tsx";
const CASE = "components/CaseModal.tsx";
const ACTIONS = "app/queue/actions.ts";

/* ── 1. Серверне правило, яке клієнт ДЗЕРКАЛИТЬ ────────────────────────────
   Найважливіший сторож пакета. Уся клієнтська частина U-12 — це твердження
   «направнику сервер відмовить». Якщо правило 0077 колись послаблять (напр.
   дозволять направнику овертайм), банер «зберегти такий склад звідси не вийде»
   стане брехнею в ІНШИЙ бік, а екран мовчки забиратиме права. Тому пін тут
   двобічний: і сама гілка, і її ПОЗИЦІЯ серед сусідніх. */
describe("U-12: серверне правило 0077 — овертайм лише персоналу", () => {
  const code = src(ACTIONS);

  it("scheduleBlock має гілку ролі", () => {
    expect(code, "гілку `if (!opts.isStaff) return OFF_SCHED_ERR` прибрано або перейменовано")
      .toMatch(/if \(!opts\.isStaff\) return \{ blocked: OFF_SCHED_ERR \};/);
  });

  /* Порядок — ЧАСТИНА правила, і саме він робить дзеркало в модалці правильним.
     Якби роль перевірялась ПІСЛЯ згоди, направник із прапорцем `offSchedule`
     проходив би далі; якби ПЕРЕД `confirmable` — персонал діставав би «немає
     прав» там, де насправді не можна нікому. Шукаємо самі умови, без тіла:
     інакше перестановка дала б -1 і тест червонів би як «не знайдено», тобто
     перевіряв би наявність, а не ПОРЯДОК. */
  it("роль перевіряється ПІСЛЯ confirmable і ПЕРЕД згодою", () => {
    const confirmable = code.indexOf("if (!info.confirmable)");
    const staff = code.indexOf("if (!opts.isStaff)");
    const consent = code.indexOf("if (!opts.offSchedule)");
    expect(confirmable, "гілку confirmable не знайдено").toBeGreaterThanOrEqual(0);
    expect(staff, "гілку ролі не знайдено").toBeGreaterThanOrEqual(0);
    expect(consent, "гілку згоди не знайдено").toBeGreaterThanOrEqual(0);
    expect(confirmable, "непідтверджуване має відсікатись РАНІШЕ за роль").toBeLessThan(staff);
    expect(staff, "роль має відсікатись РАНІШЕ за згоду").toBeLessThan(consent);
  });

  /* Згода клієнта нічого не варта, якщо `isStaff` рахує не сервер. */
  it("editQueueEntryStudies рахує isStaff на сервері і везе обидва прапорці", () => {
    expect(code, "isStaff береться не з callerIsStaffOf(cur.clinic_id)")
      .toMatch(/const isStaff = await callerIsStaffOf\(supabase, cur\.clinic_id\);/);
    expect(code, "у scheduleBlock не їде пара { offSchedule, isStaff }")
      .toMatch(/\{ offSchedule, isStaff \}/);
  });

  /* Згода — ОБОВʼЯЗКОВИЙ позиційний аргумент екшена: поки він мав дефолт,
     дошка могла «забути» довезти підтвердження, і сервер бачив `false`. */
  it("editQueueEntryStudies приймає offSchedule обовʼязковим", () => {
    const sig = code.slice(code.indexOf("export async function editQueueEntryStudies"));
    expect(sig.slice(0, 400), "offSchedule став необовʼязковим або дістав дефолт")
      .toMatch(/offSchedule: boolean\s*\n?\s*\)/);
  });
});

/* ── 2. Пропи лишаються обовʼязковими ──────────────────────────────────────
   Дефолт тут — не зручність, а мовчазне ТВЕРДЖЕННЯ на місці незнання:
   `offSchedule = false` каже «запис у графіку», `allowOffSchedule = true` дає
   направнику чужі права, `= false` — забирає їх у персоналу. */
const REQUIRED_PROPS: Array<[string, string]> = [
  [MODAL, "offSchedule"],
  [MODAL, "allowOffSchedule"],
  [CASE, "referralMode"],
];

describe("U-12: пропи ролі та стану — обовʼязкові й без дефолта", () => {
  it.each(REQUIRED_PROPS)("%s: %s оголошений обовʼязковим", (file, prop) => {
    const code = src(file);
    // ВСІ оголошення, а не перше: другий, «тимчасово необовʼязковий» варіант
    // поруч із правильним — рівно те, чого сторож не має пропустити.
    const decls = [...code.matchAll(new RegExp(`\\b${prop}\\s*(\\??)\\s*:\\s*boolean`, "g"))];
    expect(decls.length, `${file}: оголошення пропа ${prop} не знайдено`).toBeGreaterThan(0);
    for (const [, optional] of decls) {
      expect(optional, `${file}: ${prop} став необовʼязковим — tsc перестане ловити пропущений проп`).toBe("");
    }
  });

  it.each(REQUIRED_PROPS)("%s: %s не має дефолта в деструктуризації", (file, prop) => {
    expect(src(file), `${file}: дефолт у деструктуризації повертає мовчазне припущення`)
      .not.toMatch(new RegExp(`${prop}\\s*=\\s*(true|false)`));
  });

  /* Згода в meta теж обовʼязкова: поки вона була `offSchedule?`, дошка
     компілювалась, не довозячи підтвердження до сервера. */
  it("StudyEditModal: onConfirm вимагає offSchedule у meta", () => {
    expect(src(MODAL), "offSchedule у meta став необовʼязковим")
      .toMatch(/meta: \{ dur: number; buffer: number; offSchedule: boolean \}/);
  });
});

/* ── 3. Місця виклику: відповідь МАЄ БУТИ НАПИСАНА, і написана правильно ───
   tsc гарантує, що проп передали. Він НЕ гарантує, що передали правду: у
   CaseModal `allowOffSchedule={true}` компілюється так само добре, як
   `{!referralMode}` — і мовчки дає направнику галочку овертайму. */
type Site = { file: string; expect: RegExp; why: string };

const MODAL_SITES: Site[] = [
  { file: "components/QueueBoard.tsx", expect: /<StudyEditModal[^>]*\sallowOffSchedule(\s|=\{true\})/,
    why: "дошка персоналу мусить лишити персоналу право на овертайм" },
  { file: "components/CallListBoard.tsx", expect: /<StudyEditModal[^>]*\sallowOffSchedule(\s|=\{true\})/,
    why: "колл-лист — теж екран персоналу центру" },
  { file: "components/ReferralPortal.tsx", expect: /<StudyEditModal[^>]*\sallowOffSchedule=\{false\}/,
    why: "направнику сервер відмовить — обіцяти йому овертайм не можна" },
  { file: CASE, expect: /<StudyEditModal[\s\S]*?\sallowOffSchedule=\{!referralMode\}/,
    why: "екран кейса відкривають ОБИДВІ ролі — константа тут бреше одній із них" },
];

const CASE_SITES: Site[] = [
  { file: "components/QueueBoard.tsx", expect: /<CaseModal[^>]*\sreferralMode=\{false\}/,
    why: "дошка персоналу мусить сказати це явно, а не покластися на дефолт" },
  { file: "components/ReferralPortal.tsx", expect: /<CaseModal[^>]*\sreferralMode(\s|=\{true\})/,
    why: "портал направника мусить лишитись у режимі направника" },
];

describe("U-12: у кожному місці виклику написана правильна роль", () => {
  it.each([...MODAL_SITES, ...CASE_SITES])("$file — $why", ({ file, expect: re, why }) => {
    expect(src(file), `${file}: ${why}`).toMatch(re);
  });

  /* Сканер: новий екран, що відкриє редактор або кейс, зобовʼязаний зʼявитись
     у списках вище. Без нього сторожі перевіряють лише те, що вже знають, і
     наступний ReferralPortal знову проїде повз. */
  const files = readdirSync(resolve(process.cwd(), "components")).filter((f) => f.endsWith(".tsx"));

  it("усі місця виклику StudyEditModal перелічені", () => {
    const known = new Set(MODAL_SITES.map((s) => s.file));
    const found = files.map((f) => "components/" + f)
      .filter((p) => src(p).includes("<StudyEditModal"));
    expect(found.filter((p) => !known.has(p)), "новий екран відкриває редактор досліджень — допишіть його в MODAL_SITES з очікуваною роллю")
      .toEqual([]);
    // І навпаки: список не має тихо посилатись на екран, який більше не рендерить модалку.
    expect([...known].filter((p) => !found.includes(p)), "у MODAL_SITES лишився файл, який уже не відкриває редактор")
      .toEqual([]);
  });

  it("усі місця виклику CaseModal перелічені", () => {
    const known = new Set(CASE_SITES.map((s) => s.file));
    const found = files.map((f) => "components/" + f)
      .filter((p) => src(p).includes("<CaseModal"));
    expect(found.filter((p) => !known.has(p)), "новий екран відкриває кейс — допишіть його в CASE_SITES з очікуваним referralMode")
      .toEqual([]);
    expect([...known].filter((p) => !found.includes(p)), "у CASE_SITES лишився файл, який уже не відкриває кейс")
      .toEqual([]);
  });

  /* Згода мусить доїхати до Server Action у ВСІХ чотирьох дошках: сама по собі
     галочка в модалці нічого не важить, якщо meta.offSchedule лишиться в
     обробнику. */
  it.each(["components/QueueBoard.tsx", "components/CallListBoard.tsx", "components/ReferralPortal.tsx", CASE])(
    "%s довозить meta.offSchedule до editQueueEntryStudies", (file) => {
      const code = src(file);
      /* `buffer` в обробниках дошок необовʼязковий (історично), а от згода —
         ні: саме `offSchedule?` дозволив би дошці мовчки не довозити її. */
      expect(code, `${file}: обробник більше не вимагає offSchedule у meta`)
        .toMatch(/meta: \{[^}]*\boffSchedule: boolean\s*\}/);
      expect(code, `${file}: offSchedule у meta обробника став необовʼязковим`)
        .not.toMatch(/meta: \{[^}]*\boffSchedule\?/);
      expect(code, `${file}: meta.offSchedule не їде пʼятим аргументом екшена`)
        .toMatch(/editQueueEntryStudies\([\s\S]{0,200}?meta\.offSchedule\)/);
    });
});

/* ── 4. Дзеркало ролі в самій модалці ──────────────────────────────────────
   Компонентних тестів у проєкті немає (vitest.config.ts — environment: "node"),
   тож форму гілок звіряємо статично, а найдорожче рішення (текст причини і сама
   перевірка «чи допоможе скорочення») винесене у функції й перевірене по суті. */
const GATES: Array<[string, RegExp]> = [
  ["галочку овертайму видно лише тому, кому сервер її дозволить",
    /const needsOffConfirm = crossesNow && !overflow && allowOffSchedule;/],
  ["відмова рахується з ролі та ЖИВОГО графіка, а не з прапорця запису",
    /const offNow = schedReady && !!patient\.scheduled_time\s*\n?\s*\? offScheduleKind\(startMin, totalDur, roomSched, roomBreaks\) : null;/],
  ["роль справді блокує саме збереження",
    /const offForbiddenForRole = !allowOffSchedule && !!offNow;/],
  ["заборона входить у valid — інакше «Зберегти» лишиться активним",
    /const valid = [^\n]*&& !offForbiddenForRole;/],
  ["порада «скоротіть» перевіряється тією ж функцією, що й заборона",
    /const fitsIfShorter = offForbiddenForRole && schedReady && busyReady && inSchedCap >= MIN_ROW_DUR\s*\n?\s*&& !offScheduleKind\(startMin, inSchedCap, roomSched, roomBreaks\);/],
  ["банер відмови рендериться",
    /\{offForbiddenForRole && offNow && \(/],
  /* Ревʼю р1: «зверніться до центру» правдиве лише для confirmable-видів. Для
     closed / before_start / too_late сервер відхиляє гілкою `!info.confirmable`
     ДО перевірки ролі — тобто центр теж безсилий, і порада коштує дзвінка. */
  ["текст відмови розрізняє «центр може погодити» і «не може ніхто»",
    /\{offNow\.confirmable\s*\n?\s*\? <> Роботу поза графіком підтверджує лише центр/],
  ["порада «що робити» теж розрізняє два види відмови",
    /: offNow\.confirmable\s*\n?\s*\? <>Змінити склад цього запису може лише центр/],
  /* Ревʼю р1: при рольовій забороні «Доступно у слоті» називало стелю З GRACE —
     три різні числа на одному екрані. Межа при відмові одна: та, що в графіку. */
  ["рядок доступності при забороні показує межу графіка, а не grace",
    /: offForbiddenForRole\s*\n?\s*\? <>Разом <b>\{totalDur\} хв<\/b>\. У графік кабінету вміщується <b>\{inSchedCap\} хв<\/b>\./],
];

describe("U-12: гілки ролі в редакторі досліджень", () => {
  it.each(GATES)("%s", (_why, re) => {
    expect(src(MODAL)).toMatch(re);
  });

  /* Взаємне виключення двох банерів — не косметика: показати направнику
     галочку разом із відмовою означає знову пообіцяти те, чого не буде. */
  it("галочка згоди й банер відмови не можуть зійтись разом", () => {
    const code = src(MODAL);
    expect(code, "needsOffConfirm мусить вимагати allowOffSchedule").toMatch(/needsOffConfirm = [^\n]*&& allowOffSchedule;/);
    expect(code, "offForbiddenForRole мусить вимагати !allowOffSchedule").toMatch(/offForbiddenForRole = !allowOffSchedule/);
  });

  /* Стеля тривалості для запису, що САМ стоїть поза графіком, лишається
     розширеною — інакше повертається провал №1: легально створений запис на
     17:55 неможливо відредагувати взагалі. */
  it("успадкований прапорець і далі піднімає стелю на grace", () => {
    expect(src(MODAL), "capBySched більше не враховує offSchedule — запис поза графіком знову не відредагувати")
      .toMatch(/offSchedule \? schedEnd \+ OFF_SCHED_GRACE_MIN : schedEnd/);
  });

  /* Ревʼю р1: два різні мінімуми на одному екрані. `valid` приймає рядок від
     5 хв, а порада «скоротіть до N» вимагала 15 (MIN_STUDY — мірка «чи є місце
     на ЩЕ одне дослідження») і казала «вкластися неможливо» там, де форма сама
     б зберегла. Тримаємо ОДНУ константу на обидва місця. */
  it("поріг «вкладаємось» — один і той самий у valid і в пораді", () => {
    const code = src(MODAL);
    expect(code, "MIN_ROW_DUR зник — пороги знову розійдуться").toMatch(/const MIN_ROW_DUR = 5;/);
    expect(code, "valid більше не спирається на спільну константу").toMatch(/\(Number\(r\.dur\) \|\| 0\) >= MIN_ROW_DUR/);
    expect(code, "порада знову міряє мінімум по MIN_STUDY").not.toMatch(/inSchedCap >= MIN_STUDY/);
  });
});

/* ── 4b. U-19: портал направника не стверджує на непрочитаних даних ────────
   Той самий принцип, що в U-5/U-11: «не знаємо» ≠ «порожньо». Три підказки про
   графік і ЛІЧИЛЬНИК вільного часу — однаково твердження про день. */
describe("U-19: підказки й лічильник порталу — під гейтом довіри", () => {
  const PORTAL = "components/ReferralPortal.tsx";

  it("catch у loadDay обнуляє прочитаний графік і оверрайд", () => {
    const code = src(PORTAL);
    expect(code, "протухлий override іншого дня лишиться на екрані").toMatch(/setOverride\(null\);\s*\n?\s*setRoomSchedule\(null\);/);
    /* Зайнятість і простої тут НЕ обнуляємо свідомо: `[]` означав би «нічого
       немає» — підміна невідомості порожнечею (клас U-11). Їх прикриває
       slotsErr, який ховає сітку цілком. */
    expect(code, "зайнятість обнулили в порожній масив — це підміна невідомості порожнечею")
      .not.toMatch(/setSlotsErr\(true\);[\s\S]{0,200}setDayEntries\(\[\]\)/);
  });

  it("усі три підказки про графік — під availTrusted", () => {
    const code = src(PORTAL);
    for (const re of [/availTrusted && roomId && roomSched\.closed/, /availTrusted && roomId && !roomSched\.closed && roomSched\.custom/, /availTrusted && roomId && !roomSched\.closed && slots\.some/]) {
      expect(code, "підказка про графік показується на непрочитаних даних").toMatch(re);
    }
  });

  it("лічильник «вміщується ще N» не рахується на непрочитаних даних", () => {
    expect(src(PORTAL), "при збої читання лічильник показував найбільше число саме тоді, коли ми не знаємо нічого")
      .toMatch(/!availTrusted \? \(slotsLoading \? "завантаження…" : "дані кабінету не підтверджені"\)/);
  });
});

/* ── 5. Текст причини — по суті, а не по формі ─────────────────────────────
   Єдина чиста функція пакета: її можна перевірити поведінкою, і саме вона
   відрізняє «поза графіком» від «кабінет зачинений» — а це різні дії людини. */
describe("U-12: offReasonText називає ПРИЧИНУ, а не жанр", () => {
  const KINDS: OffScheduleInfo[] = [
    { kind: "closed", confirmable: false },
    { kind: "before_start", confirmable: false },
    { kind: "after_end", confirmable: true, end: "18:00" },
    { kind: "too_late", confirmable: false, end: "18:00" },
    { kind: "break", confirmable: true, brk: { start: "13:00", end: "14:00" } },
  ];

  it("кожен різновид має свій непорожній текст", () => {
    const texts = KINDS.map(offReasonText);
    for (const t of texts) expect(t.length, "порожня причина = знову «просто не вміщується»").toBeGreaterThan(10);
    /* after_end і too_late свідомо збігаються (для направника різниці немає),
       решта мусить розрізнятись — інакше «зачинено» і «на 10 хв довше» знову
       зіллються в одне повідомлення. */
    expect(new Set(texts).size, "різні причини описані однаково").toBe(4);
  });

  it("межу і перерву називає числами з ЖИВОГО графіка", () => {
    expect(offReasonText({ kind: "after_end", confirmable: true, end: "18:00" })).toContain("18:00");
    expect(offReasonText({ kind: "break", confirmable: true, brk: { start: "13:00", end: "14:00" } }))
      .toContain("13:00–14:00");
  });

  it("без даних межі не вигадує час", () => {
    const t = offReasonText({ kind: "after_end", confirmable: true });
    expect(t).not.toMatch(/\d\d:\d\d/);
    expect(t.length).toBeGreaterThan(10);
  });
});

/* ── 6. Причина, з якої «скоротіть до N хв» рахується перепиткою функції ───
   Тут перевіряється сама ПАСТКА, а не її обхід: запис, що стоїть УСЕРЕДИНІ
   перерви, від скорочення поза графіком не виходить. Порада, побудована на
   порівнянні стель, у цьому випадку була б брехнею — і тест фіксує, чому
   `fitsIfShorter` мусить питати offScheduleKind повторно. */
describe("U-12: скорочення допомагає не завжди", () => {
  const sched: EffectiveRoomSchedule = { start: "08:00", end: "18:00", closed: false, custom: false };
  const lunch = [{ start: "13:00", end: "14:00" }];

  it("запис ПЕРЕД межею: скорочення виводить у графік", () => {
    expect(offScheduleKind(17 * 60 + 30, 60, sched, [])).not.toBeNull();
    expect(offScheduleKind(17 * 60 + 30, 30, sched, [])).toBeNull();
  });

  it("запис УСЕРЕДИНІ перерви: скорочення НЕ рятує", () => {
    expect(offScheduleKind(13 * 60 + 10, 40, sched, lunch)?.kind).toBe("break");
    expect(offScheduleKind(13 * 60 + 10, 15, sched, lunch)?.kind).toBe("break");
  });
});
