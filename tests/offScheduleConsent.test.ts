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
  /* U-20/U-21/U-22 (с48): питання «чи потрібна згода» ставиться ТІЙ САМІЙ
     функції, що й серверу (`offNow` ← `offScheduleKind`), а НЕ арифметиці стель.
     Стара форма `crossesNow && !overflow` була тотожно false для запису в
     графіку (там availableDur === inSchedCap), нічого не знала про
     `confirmable` і не бачила перерви, що вже тривала на момент старту. */
  /* U-15 (с48) додав `!incidentBlocked`. Це НЕ дубль `!overflow`: при простої
     `availableDur = 0`, тож overflow ховає галочку рівно доти, доки склад
     непорожній. При `totalDur = 0` (область ще не обрана) overflow гасне — і на
     записі після закриття у зламаному кабінеті виринала б згода на збереження,
     яке сервер відхилить ІНШИМ тригером. Пінимо ОБИДВА члени. */
  ["галочку овертайму видно лише тому, кому сервер її дозволить",
    /const needsOffConfirm = allowOffSchedule && !!offNow && offNow\.confirmable && !overflow && !incidentBlocked;/],
  ["галочка не спирається на арифметику стель — інакше вона знову стане недосяжною",
    /const needsOffConfirm = (?!.*crossesNow)[^\n]*;/],
  ["непідтверджуваний вид — глухий кут для ВСІХ ролей, не лише для направника",
    /const offHardBlocked = !!offNow && !offNow\.confirmable;/],
  ["відмова рахується з ролі та ЖИВОГО графіка, а не з прапорця запису",
    /const offNow = schedReady && !!patient\.scheduled_time\s*\n?\s*\? offScheduleKind\(startMin, totalDur, roomSched, roomBreaks\) : null;/],
  ["роль справді блокує саме збереження",
    /const offForbiddenForRole = !allowOffSchedule && !!offNow;/],
  /* `[^\n]*` між членами, а не жорсткий хвіст: U-15 дописав у `valid` четвертий
     блок (`!incidentBlocked`), і жорсткий кінець рядка червонів би на КОЖНОМУ
     новому блоці, а не на зникненні перевіреного. Пінимо присутність кожного
     члена окремо — саме це й є те, що не має зникнути. */
  ["рольова заборона входить у valid — інакше «Зберегти» лишиться активним",
    /const valid = [^\n]*&& !offForbiddenForRole &&[^\n]*;/],
  ["непідтверджуваний вид теж входить у valid — інакше персонал збереже те, що сервер відхилить",
    /const valid = [^\n]*&& !offHardBlocked[^\n]*;/],
  ["обидва глухі кути рахуються однією диз'юнкцією",
    /const offDeadEnd = offForbiddenForRole \|\| offHardBlocked;/],
  ["порада «скоротіть» перевіряється тією ж функцією, що й заборона",
    /const fitsIfShorter = offDeadEnd && schedReady && busyReady && inSchedCap >= MIN_ROW_DUR\s*\n?\s*&& !offScheduleKind\(startMin, inSchedCap, roomSched, roomBreaks\);/],
  ["банер рольової відмови рендериться",
    /\{offForbiddenForRole && offNow && \(/],
  /* ⚠️ БЕЗ `!overflow`: гард ховав ЄДИНЕ пояснення сірої кнопки саме там, де воно
     найпотрібніше (закритий день + довгий склад), і робив персонал поінформованим
     ГІРШЕ за направника, у якого такого гарда ніколи не було (ревʼю р1). */
  ["банер «не може погодити ніхто» рендериться для персоналу",
    /\{allowOffSchedule && offHardBlocked && offNow && \(/],
  ["банер «не може погодити ніхто» не ховається за overflow",
    /\{allowOffSchedule && offHardBlocked && offNow && \(\n/],
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
    /: offDeadEnd && offNow\s*\n?\s*\? \(lengthIrrelevant/],
  /* Ревʼю р1 + р2, дві протилежні помилки на одній гілці. р1: у закритому дні
     екран радив «Скоротіть на N хв» — порада, яка не спрацює НІКОЛИ. р2:
     безумовний пріоритет глухого кута забирав ту саму пораду там, де вона
     ПРАЦЮЄ (`too_late` — скорочення робить вид підтверджуваним). Обидві
     помиляються в один бік: пріоритет мусить вирішувати `lengthIrrelevant`. */
  ["overflow виграє скрізь, крім випадків, де довжина не є причиною",
    /\{overflow && !lengthIrrelevant\s*\n?\s*\? <>⚠ Не вміщується/],
  ["глухий кут іде одразу за overflow, а не після нормальної гілки",
    /\{overflow && !lengthIrrelevant[\s\S]{0,600}?: offDeadEnd && offNow/],
  /* U-15 виніс простій ПЕРШИМ членом диз'юнкції: `offNow` для простою в
     робочому кабінеті дорівнює null, тож четвертим членом у дужках він не
     виражається. Пінимо і диз'юнкцію, і повний набір видів у дужках. */
  ["перерва, що накриває старт, теж не лікується довжиною",
    /const lengthIrrelevant = incidentBlocked\s*\n?\s*\|\| \(!!offNow && \(offNow\.kind === "closed" \|\| offNow\.kind === "before_start" \|\| !!curBreak\)\);/],
  ["для too_late банер радить скоротити до жорсткої стелі, а не перезаписувати",
    /: \(overflow && !lengthIrrelevant\)\s*\n?\s*\? <>Скоротіть склад до <b>\{availableDur\} хв<\/b>/],
  /* U-20: те саме правило, але для НОРМАЛЬНОГО стану. Відколи grace відкрита і
     персоналу, `availableDur` — це вже стеля З ОВЕРТАЙМОМ, і показувати її як
     «Доступно у слоті» означає рекламувати понаднормову ємність як звичайну.
     Головне число рядка — межа БЕЗ НОВОЇ ЗГОДИ; овертайм — окремим реченням і
     поруч зі словом «підтвердження». */
  ["головне число рядка доступності — межа графіка, а не стеля з овертаймом",
    /\? <>Доступно у слоті: <b>\{inSchedCap\} хв<\/b> \(\{labelFor\(inSchedCap\)\}\)\./],
  /* ⚠️ Ревʼю р2: проміжний `noConsentCap = offSchedule ? availableDur : inSchedCap`
     був гірший за початковий дефект — він робив `cap > noConsentCap` і
     `availableDur > noConsentCap` тотожно хибними для запису поза графіком, тобто
     вбивав і чесний підпис, і згадку про підтвердження, і ще писав «Без згоди
     вміщується 60 хв» просто над обовʼязковою галочкою. */
  /* ⚠️ Пінимо саме УМОВУ разом із гілкою. Перша версія пінила лише текст
     else-гілки — і мутація `{inSchedCap > 0` → `{true` лишалась ЗЕЛЕНОЮ: текст
     нікуди не дівається, він просто стає недосяжним. Той самий урок, що в с47
     з якорем `exAdd` замість `changeType`: зелена мутація означає «сторож
     дивиться не туди», а не «сторож зайвий». */
  ["нуль у графіку має власну гілку, а не друкується як «доступно 0 хв»",
    /\{inSchedCap > 0\s*\n\s*\? <>Доступно у слоті: <b>\{inSchedCap\} хв<\/b>/],
  ["гілка «часу немає» справді написана",
    /: <>У графіку кабінету вільного часу немає \(\{labelFor\(inSchedCap\)\}\)\.<\/>\}/],
  ["овертайм названий окремо, зі словом «підтвердження» і лише тому, хто може його дати",
    /const overtimeRoom = allowOffSchedule && availableDur > inSchedCap;/],
  ["овертаймове речення рендериться",
    /\{overtimeRoom && <> Понаднормово — до <b>\{availableDur\} хв<\/b> \(\{labelFor\(availableDur\)\}\) з підтвердженням\.<\/>\}/],
  ["«вільно ще» рахується від межі графіка і ховається, щойно склад її перейшов",
    /const freeInSched = inSchedCap - totalDur;/],
  ["«вільно ще» ховається саме по overFree",
    /\{!overFree && <> Вільно ще <b>\{freeInSched\} хв<\/b>\.<\/>\}/],
  /* Ревʼю р1: згода дається під конкретну ПРИЧИНУ. Банер, що називав лише межу,
     для запису всередині перерви казав неправду тричі поспіль. */
  ["банер згоди називає ПРИЧИНУ тією ж функцією, що й банер відмови",
    /<b>⏰ Поза графіком\.<\/b> Разом <b>\{totalDur\} хв<\/b> — \{offNow \? offReasonText\(offNow\) :/],
  /* Ревʼю р1: DUR_MAX у стелях. Без нього склад на 500 хв мовчки зберігався б із
     duration_min = 480 (normDur клампить на сервері) і розходився зі studies[]. */
  /* U-15 додав `capByIncident` В ОБИДВА мінімуми (простій не лікується згодою
     «поза графіком» — сервер відхиляє його окремим тригером). Порядок членів
     закріплений навмисно: перестановка сама по собі безпечна, але зникнення
     будь-якого — ні, а перелік у регулярці робить зникнення видимим одразу. */
  ["обидві стелі клампляться стелею продукту",
    /const availableDur = Math\.max\(0, Math\.min\(capByNext, capBySched, capByBreak, capByIncident, DUR_MAX\)\);/],
  ["строга стеля теж клампиться стелею продукту",
    /const inSchedCap = Math\.max\(0, Math\.min\(capByNext, capBySchedStrict, capByBreakStrict, capByIncident, DUR_MAX\)\);/],
  /* U-22: перерва, що вже триває на момент старту, мусить давати нуль у СТРОГІЙ
     стелі — інакше екран пише «вільно ще N хв» запису, який весь стоїть в обіді. */
  ["перерва, що накриває старт, обнуляє строгу стелю",
    /const capByBreakStrictRaw = curBreak \? 0 : capByBreakRaw;/],
  ["нуль іде ЛИШЕ в строгу стелю — інакше відмова перетвориться на «скоротіть»",
    /const capByBreak = \(offAllowed \|\| !schedApplies\) \? Infinity : \(schedReady \? capByBreakRaw : committedDur\);/],
  /* Ревʼю р1: підпис межі читає СТРОГІ стелі. З м'якими гілка «до перерви»
     вмирає (capByBreak = Infinity для персоналу), і межа 13:00 підписується
     словами «до кінця графіка (18:00)». */
  ["підпис межі рахується зі строгих стель",
    /: \(capByBreakStrict <= capByNext && capByBreakStrict <= capBySchedStrict && nextBreakStart != null\)/],
  /* U-15 поставив ПЕРЕД перервою гілку простою — і саме безумовно, без
     порівняння стель: при записі після закриття `capBySchedStrict` відʼємний,
     `0 <= -30` хибне, і підпис вертався б до графіка рівно там, де накладаються
     два блоки. Пінимо і нову гілку, і те, що перерва лишилась одразу за нею. */
  ["перерва, що накриває старт, має власний підпис",
    /const boundaryLabel = incidentLabel != null\s*\n?\s*\? incidentLabel\s*\n?\s*: curBreak\s*\n?\s*\? \("кабінет у перерві до " \+ curBreak\.end\)/],
  /* Ревʼю р1: згода під одну причину не має мовчки підписувати іншу. */
  ["згода скидається на зміні ВИДУ виходу за графік",
    /if \(offKind === null \|\| prevOffKind\.current === offKind\) return;\s*\n\s*prevOffKind\.current = offKind;\s*\n\s*setOffOk\(false\);/],
  /* Ревʼю р2: `null` — транзієнт набору («100» → «1» → «110»), а не зміна
     причини. Перша версія скидала галочку саме там: вона гасла без видимої
     причини, і «Зберегти» сіріла посеред звичайного редагування. */
  ["скидання не спрацьовує на транзієнтному null під час набору",
    /useEffect\(\(\) => \{[\s\S]{0,800}?offKind === null \|\|/],
];

describe("U-12: гілки ролі в редакторі досліджень", () => {
  it.each(GATES)("%s", (_why, re) => {
    expect(src(MODAL)).toMatch(re);
  });

  /* Взаємне виключення двох банерів — не косметика: показати направнику
     галочку разом із відмовою означає знову пообіцяти те, чого не буде. */
  it("галочка згоди й банер відмови не можуть зійтись разом", () => {
    const code = src(MODAL);
    expect(code, "needsOffConfirm мусить вимагати allowOffSchedule").toMatch(/needsOffConfirm = allowOffSchedule &&/);
    expect(code, "offForbiddenForRole мусить вимагати !allowOffSchedule").toMatch(/offForbiddenForRole = !allowOffSchedule/);
    /* U-21: третій банер. Він виключний із галочкою по `confirmable` (галочка
       вимагає true, банер — false) і з рольовою відмовою по ролі (банер вимагає
       allowOffSchedule, відмова — !allowOffSchedule). Обидві осі пінимо, бо
       зникнення БУДЬ-ЯКОЇ повертає «дві суперечливі коробки на одному екрані». */
    expect(code, "offHardBlocked мусить вимагати саме НЕпідтверджуваний вид").toMatch(/offHardBlocked = !!offNow && !offNow\.confirmable;/);
    expect(code, "банер «не може ніхто» більше не обмежений персоналом — зійдеться з рольовою відмовою")
      .toMatch(/\{allowOffSchedule && offHardBlocked &&/);
  });

  /* ⚠️ Ревʼю р2 зарубало проміжний `noConsentCap = offSchedule ? availableDur :
     inSchedCap`: він робив `cap > noConsentCap` і `availableDur > noConsentCap`
     тотожно хибними для запису поза графіком — тобто вбивав і чесний підпис, і
     єдину згадку про підтвердження, а банер писав «Без згоди вміщується 60 хв»
     просто над обовʼязковою галочкою. Межа без згоди — рівно `inSchedCap`.
     Тест на ВІДСУТНІСТЬ, бо ця ідея виглядає розумною і повернеться. */
  it("межа без згоди не «пом'якшується» успадкованим прапорцем", () => {
    expect(src(MODAL), "повернувся noConsentCap — межа без згоди знову дорівнює стелі з овертаймом")
      .not.toMatch(/const noConsentCap\s*=/);
  });

  /* Банер — це коробка, а базові правила коробки (`display:flex`, рамка, кегль
     `.ib-txt`) живуть у radflow-screens.css. Портал підключав лише radflow.css,
     тому ЄДИНИЙ банер, який направник узагалі бачить, рендерився без оформлення:
     два `<span>` зливались в абзац, інлайновий `flexDirection` був інертний.
     Дефект приїхав із с47 разом із самим банером і прожив до ревʼю U-20. */
  it("портал направника підключає базові стилі банерів", () => {
    const code = src("components/ReferralPortal.tsx");
    expect(code, "без radflow-screens.css банер відмови U-12 знову рендериться без коробки")
      .toMatch(/import "@\/styles\/prototype\/radflow-screens\.css";/);
  });

  /* Жива область на банерах, вміст яких міняється з кожним натисканням клавіші
     в полі тривалості, зачитувала б два абзаци тричі за набір «120». */
  it("банери не мають aria-live/role, поки немає озвучення по blur (U-26)", () => {
    const code = src(MODAL);
    expect(code, "на банері зʼявилась жива область без дебаунсу — скрінрідер зачитає її на кожну клавішу")
      .not.toMatch(/info-banner offsched" (role|aria-live)=/);
  });

  /* Стеля тривалості для запису, що САМ стоїть поза графіком, лишається
     розширеною — інакше повертається провал №1: легально створений запис на
     17:55 неможливо відредагувати взагалі. U-20 додав до умови право РОЛІ, але
     диз'юнкцією: прапорець запису мусить піднімати стелю й тоді, коли овертайму
     роль не має (направник відкриває запис, що вже стоїть поза графіком). */
  it("успадкований прапорець і далі піднімає стелю на grace", () => {
    const code = src(MODAL);
    expect(code, "capBySched більше не враховує offSchedule — запис поза графіком знову не відредагувати")
      .toMatch(/const offAllowed = offSchedule \|\| allowOffSchedule;/);
    expect(code, "grace тепер вішається не на offAllowed — умова розійшлась зі стелею перерви")
      .toMatch(/\(offAllowed \? schedEnd \+ OFF_SCHED_GRACE_MIN : schedEnd\) - startMin/);
    expect(code, "успадкований прапорець ЗАМІНИЛИ роллю — направник знову не відредагує запис поза графіком")
      .not.toMatch(/const offAllowed = allowOffSchedule;/);
  });

  /* U-20 — суть провалу одним рядком: поки grace відкривав ЛИШЕ прапорець
     запису, для запису В ГРАФІКУ `availableDur` тотожно дорівнював `inSchedCap`
     (обидві пари стель збігались), отже `crossesNow ⟺ overflow`, отже стара
     умова галочки `crossesNow && !overflow` була тотожно false. Пінимо саме те,
     що робить її досяжною: обидві стелі мусять розходитись по `offAllowed`. */
  it("стеля з овертаймом і межа графіка розходяться саме по offAllowed", () => {
    const code = src(MODAL);
    expect(code, "capByBreak знову дивиться на прапорець запису, а не на offAllowed")
      .toMatch(/const capByBreak = \(offAllowed \|\| !schedApplies\)/);
    // Строгі стелі не мають знати про овертайм узагалі — інакше межа згоди попливе.
    expect(code, "capBySchedStrict підхопив grace — межа згоди зникне")
      .not.toMatch(/capBySchedStrict = [^;]*OFF_SCHED_GRACE_MIN/);
    expect(code, "capByBreakStrict підхопив offAllowed — межа згоди зникне")
      .not.toMatch(/capByBreakStrict = [^;]*offAllowed/);
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
