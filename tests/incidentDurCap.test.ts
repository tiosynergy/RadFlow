/**
 * U-15 (с48) — «модалка тривалості не знала про простої».
 *
 * ЩО БУЛО ЗЛАМАНО (перевірено особисто по живій БД, не зі слів хендофа):
 *
 *  • `StudyEditModal` — єдиний екран, який міняє ТРИВАЛІСТЬ запису, — не мав
 *    пропа `incidents` ВЗАГАЛІ. Стеля рахувалась із графіка, перерв і сусідніх
 *    записів; простій кабінету в ній не був представлений нічим.
 *  • Сервер при цьому простій ловить: `check_not_during_incident` (0020)
 *    порівнює ВЕСЬ інтервал дослідження, а тригер `trg_not_during_incident`
 *    висить на `UPDATE OF … duration_min …`. Тобто розтягнути запис у простій
 *    БД не дає — дірки в даних не було.
 *  • Дефект був у ЧЕСНОСТІ: екран показував стелю, якої не існує, кнопка
 *    лишалась активною, а відмова прилітала ПІСЛЯ натискання — ще й текстом
 *    «оберіть інший слот або кабінет», порадою, яку в цьому вікні виконати
 *    нічим: слота тут не обирають.
 *
 * ЧОМУ ТЕСТ ТАКИЙ. Компонентних тестів у проєкті немає (`vitest.config.ts` —
 * environment: "node"), тому правило винесене в `lib/incidents.ts` одним
 * викликом `incidentDurNotice` і перевіряється ПОВЕДІНКОВО. Сторожі внизу
 * тримають лише те, що модалка справді ним користується і що жодна зі стель
 * не випала з мінімуму — форму, а не суть.
 *
 * Урок U-30, застосований тут: сторож, який пінить лише ТЕКСТ гілки, обходиться
 * мутацією умови. Тому кожен сторож нижче пінить УМОВУ разом із гілкою.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";
import {
  incidentFeed,
  incidentDurCapMin,
  incidentEndLabel,
  incidentDurNotice,
  wallInstant,
  type IncidentLike,
} from "../lib/incidents";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/* Кадр часу — «настінний як UTC» (канон 0035/0059): `started_at` у БД лежить
   саме так (`submit_incident_rpc`: `(now() at time zone tz) at time zone 'utc'`),
   тому порівнюється напряму з `wallInstant(date, time)`. */
const INC = (over: Partial<IncidentLike> = {}): IncidentLike => ({
  started_at: "2026-08-28T14:00:00.000Z",
  blocked_until: "2026-08-28T16:00:00.000Z",
  room_id: "r1",
  ...over,
});
const DAY = "2026-08-28";
const at = (t: string) => wallInstant(DAY, t);

describe("incidentDurCapMin — дзеркало серверного check_not_during_incident", () => {
  const feed = incidentFeed([INC()]);   // простій 14:00–16:00 у r1

  it("простій ПОПЕРЕДУ — стеля рівно до його початку", () => {
    // Старт 13:00, простій о 14:00 → 60 хв і жодною більше: діапазони [) ,
    // отже дослідження на 60 хв закінчується РІВНО о 14:00 і не перетинається.
    expect(incidentDurCapMin(feed, "r1", at("13:00"))).toBe(60);
    expect(incidentDurCapMin(feed, "r1", at("13:30"))).toBe(30);
  });

  /* ⚠️ Ревʼю р1, знахідка 1. `started_at` не вирівняний на хвилину:
     `emergency_stop_rpc` пише `(now() at time zone tz) at time zone 'utc'` з
     мікросекундами — на проді таких рядків 5 із 6. Дробова стеля йшла далі в
     `fmt`, який робить `m % 60`, і екран друкував «до простою о
     10:23.791866666666666» та радив «скоротіть на 6.2081 хв» — число, якого
     сама форма не приймає (`normDur` кратний 5).
     Округлення саме ВНИЗ: 24 хв від 10:00 закінчуються о 10:24, простій
     починається о 10:23:47 — сервер такий запис відхилить. */
  it("стеля — ЦІЛІ хвилини вниз (started_at із секундами — норма, а не виняток)", () => {
    const sec = incidentFeed([INC({ started_at: "2026-08-28T14:23:47.512000Z" })]);
    expect(incidentDurCapMin(sec, "r1", at("14:00"))).toBe(23);
    expect(Number.isInteger(incidentDurCapMin(sec, "r1", at("14:00")))).toBe(true);
    // І 0 лишається 0, а не «0.008 хв»: старт рівно на секунді простою.
    expect(incidentDurCapMin(sec, "r1", at("14:24"))).toBe(0);
  });

  it("старт УЖЕ в простої — нуль, а не «мало часу»", () => {
    expect(incidentDurCapMin(feed, "r1", at("14:00"))).toBe(0);   // ліва межа включна
    expect(incidentDurCapMin(feed, "r1", at("15:30"))).toBe(0);
  });

  it("простій уже завершився — стелі немає", () => {
    // Права межа ВИКЛЮЧНА: о 16:00 кабінет знову вільний.
    expect(incidentDurCapMin(feed, "r1", at("16:00"))).toBe(Infinity);
    expect(incidentDurCapMin(feed, "r1", at("17:00"))).toBe(Infinity);
  });

  it("простій сусіднього кабінету не обмежує наш", () => {
    expect(incidentDurCapMin(feed, "r2", at("13:00"))).toBe(Infinity);
  });

  it("«до відновлення» (blocked_until = null) блокує безмежно вперед", () => {
    const open = incidentFeed([INC({ blocked_until: null })]);
    expect(incidentDurCapMin(open, "r1", at("15:00"))).toBe(0);
    expect(incidentDurCapMin(open, "r1", at("23:59"))).toBe(0);
    // Але заднім числом — ні: до початку кабінет працював.
    expect(incidentDurCapMin(open, "r1", at("13:00"))).toBe(60);
  });

  it("кілька простоїв — виграє НАЙБЛИЖЧИЙ", () => {
    const two = incidentFeed([
      INC({ started_at: "2026-08-28T15:00:00.000Z", blocked_until: "2026-08-28T15:30:00.000Z" }),
      INC(),   // 14:00
    ]);
    expect(incidentDurCapMin(two, "r1", at("13:00"))).toBe(60);
  });

  /* ── Невідомість не має шляху стати «вільно» ─────────────────────────────── */

  it("простої не прочитані → undefined (а не Infinity і не 0)", () => {
    expect(incidentDurCapMin(incidentFeed([INC()], true), "r1", at("13:00"))).toBeUndefined();
    expect(incidentDurCapMin(null, "r1", at("13:00"))).toBeUndefined();
    expect(incidentDurCapMin(undefined, "r1", at("13:00"))).toBeUndefined();
  });

  it("нерозпарсиваний started_at → undefined, а не «пропустити рядок»", () => {
    // Пропуск тихо перетворив би невідомий простій на «простою немає».
    const bad = incidentFeed([INC({ started_at: "не дата" })]);
    expect(incidentDurCapMin(bad, "r1", at("13:00"))).toBeUndefined();
  });

  /* ⚠️ Порядок гілок у функції. Якби перевірка старту стояла ПЕРЕД перевіркою
     порожнього списку, запис без дати у СПРАВНОМУ кабінеті отримав би
     «невідомо» → консервативну стелю → перестав би подовжуватись узагалі.
     Сервер у цьому місці пропускає: `not exists` по порожній вибірці істинний
     незалежно від `scheduled_at`. */
  it("простоїв немає → Infinity НАВІТЬ без дати запису", () => {
    expect(incidentDurCapMin(incidentFeed([]), "r1", NaN)).toBe(Infinity);
    expect(incidentDurCapMin(incidentFeed([INC({ room_id: "r2" })]), "r1", NaN)).toBe(Infinity);
  });

  it("простої Є, а старт невідомий → undefined (консервативно)", () => {
    expect(incidentDurCapMin(feed, "r1", NaN)).toBeUndefined();
  });
});

describe("incidentEndLabel — термін простою у настінному часі", () => {
  it("той самий день → лише час", () => {
    expect(incidentEndLabel(INC(), DAY)).toBe("16:00");
  });

  /* Нічна поломка з відновленням уранці: «до 09:00» без дати — брехня рівно на
     добу, оператор чекав би дев'ятої ГОДИНИ ЦЬОГО Ж дня. */
  it("інший день → з датою", () => {
    const overnight = INC({ started_at: "2026-08-28T22:00:00.000Z", blocked_until: "2026-08-29T09:00:00.000Z" });
    expect(incidentEndLabel(overnight, DAY)).toBe("29.08 09:00");
  });

  it("без dayKey — завжди з датою (зайва дата не вводить в оману, відсутня — вводить)", () => {
    expect(incidentEndLabel(INC(), null)).toBe("28.08 16:00");
  });

  it("«до відновлення» і нерозпарсиване — null, а не порожній рядок", () => {
    expect(incidentEndLabel(INC({ blocked_until: null }), DAY)).toBeNull();
    expect(incidentEndLabel(INC({ blocked_until: "колись" }), DAY)).toBeNull();
    expect(incidentEndLabel(null, DAY)).toBeNull();
  });
});

describe("incidentDurNotice — одне рішення на три величини", () => {
  const feed = incidentFeed([INC()]);

  it("старт у простої: blocked, стеля 0, названий термін", () => {
    const n = incidentDurNotice(feed, "r1", DAY, "15:00");
    expect(n.blocked).toBe(true);
    expect(n.capMin).toBe(0);
    expect(n.endLabel).toBe("16:00");
  });

  it("простій попереду: НЕ blocked, стеля додатна, терміну не називаємо", () => {
    const n = incidentDurNotice(feed, "r1", DAY, "13:00");
    expect(n.blocked).toBe(false);
    expect(n.capMin).toBe(60);
    // Термін належить БЛОКУЮЧОМУ простою; називати його тут означало б
    // підписати межу «до 16:00» там, де межа — 14:00.
    expect(n.endLabel).toBeNull();
  });

  /* ⚠️ Ключова пастка: `undefined` фолсі так само, як `0`. Якби `blocked`
     рахувався через `!capMin`, банер «кабінет у простої» світився б на
     СПРАВНОМУ кабінеті щоразу, коли впав запит інцидентів. */
  it("простої не прочитані: capMin undefined, але blocked = false", () => {
    const n = incidentDurNotice(incidentFeed([INC()], true), "r1", DAY, "15:00");
    expect(n.capMin).toBeUndefined();
    expect(n.blocked).toBe(false);
    expect(n.endLabel).toBeNull();
  });

  it("«до відновлення»: blocked, але терміну немає — і це не порожній рядок", () => {
    const open = incidentFeed([INC({ blocked_until: null })]);
    const n = incidentDurNotice(open, "r1", DAY, "15:00");
    expect(n.blocked).toBe(true);
    expect(n.endLabel).toBeNull();
  });

  it("справний кабінет: стеля нескінченна, нічого не блокується", () => {
    const n = incidentDurNotice(incidentFeed([]), "r1", DAY, "15:00");
    expect(n.capMin).toBe(Infinity);
    expect(n.blocked).toBe(false);
  });
});

/* ── Сторожі: модалка справді КОРИСТУЄТЬСЯ правилом ──────────────────────────
   Поведінку тримають тести вище. Ці перевіряють, що правило підключене — і
   пінять УМОВУ разом із гілкою: ревʼю U-20 показало (N17), що сторож, який
   пінить лише текст, обходиться мутацією умови — текст лишається в коді, але
   стає недосяжним, і сторож світить зеленим. */
const MODAL = "components/StudyEditModal.tsx";

describe("U-15: сторожі підключення в StudyEditModal", () => {
  it("рішення береться ОДНИМ викликом incidentDurNotice", () => {
    const code = src(MODAL);
    expect(code, "модалка не викликає incidentDurNotice").toMatch(/incidentDurNotice\s*\(\s*incidents\s*,/);
    /* ⚠️ Тут БУЛА заборона на `incidentAtInstant` — «другий власник тієї самої
       правди». Ревʼю р1 (знахідка 4) показало, що заборона зайва й шкідлива:
       сітку слотів теж треба фарбувати простоями, а її ПІДПИС зобовʼязаний
       відрізнити «кабінет у простої» від «простої не прочитані» — для чого
       потрібен саме `incidentAtInstant` із його трьома відповідями. Єдиність
       ДЖЕРЕЛА РІШЕННЯ тримає наступний тест (`incidentBlocked === incNotice
       .blocked`), і тримає строго; заборона за іменем функції лише виглядала
       суворою. */
  });

  /* ⚠️ ЦЕЙ сторож закриває обхід, який знайшла власна фальсифікація: усі
     перевірки нижче пінять `!incidentBlocked` У ВИРАЗАХ, тож мутація самого
     ДЖЕРЕЛА (`const incidentBlocked = false;`) лишає кожен із них зеленим —
     жодного символа з перевіреного коду не зникає, просто гілки стають
     недосяжними. Той самий клас, що N17 в U-20 і N06 в U-30, лише вхід інший:
     не ранній `return`, а підміна вхідної величини. Пінимо три привʼязки до
     `incNotice` — тут вони єдине джерело правди. */
  it("прапорець і стеля беруться саме з notice, а не підмінені константою", () => {
    const code = src(MODAL);
    expect(code, "incidentBlocked відвʼязаний від notice — усі гілки стануть недосяжними мовчки")
      .toMatch(/const incidentBlocked = incNotice\.blocked;/);
    expect(code, "incCapRaw відвʼязаний від notice").toMatch(/const incCapRaw = incNotice\.capMin;/);
    expect(code, "термін простою відвʼязаний від notice").toMatch(/const incEndLabel = incNotice\.endLabel;/);
    /* Невідомість → КОНСЕРВАТИВНА стеля. `Infinity` тут — fail-open: простої не
       прочитані, а форма дозволяє тягнути тривалість куди завгодно. */
    expect(code, "непрочитані простої більше не дають консервативної стелі")
      .toMatch(/const capByIncident = incCapRaw === undefined \? committedDur : incCapRaw;/);
  });

  /* Поле `incidentsFailed` тримає перелік джерел, яким не можна вірити. Поки
     воно обовʼязкове, tsc перелічує КОЖНЕ місце, де будується `SlotDataState`;
     з `?` наступний екран доступності забуде третє джерело мовчки — рівно те,
     через що модалка тривалості й прожила без простоїв до U-15. */
  it("incidentsFailed лишається ОБОВʼЯЗКОВИМ полем SlotDataState", () => {
    expect(src("lib/availabilityTrust.ts"), "поле стало необовʼязковим — tsc перестане перелічувати екрани")
      .toMatch(/\n\s*incidentsFailed: boolean;/);
  });

  it("стеля простою стоїть в ОБОХ мінімумах — мʼякому і строгому", () => {
    const code = src(MODAL);
    const soft = code.match(/const\s+availableDur\s*=\s*[^;]+;/)?.[0] || "";
    const strict = code.match(/const\s+inSchedCap\s*=\s*[^;]+;/)?.[0] || "";
    expect(soft, "availableDur не враховує простій").toMatch(/capByIncident/);
    /* У строгому — обовʼязково: простій не лікується згодою «поза графіком»
       (сервер відхиляє його ІНШИМ тригером, який про off_schedule не знає).
       Випади він звідси — форма показала б галочку, якої сервер не прийме. */
    expect(strict, "inSchedCap не враховує простій — grace повела б повз простій").toMatch(/capByIncident/);
  });

  it("збереження блокується ОКРЕМИМ членом, а не арифметикою стель", () => {
    const code = src(MODAL);
    const valid = code.match(/const\s+valid\s*=\s*[^;]+;/)?.[0] || "";
    expect(valid, "valid покладається на overflow — будь-яка правка стель зніме блок").toMatch(/!\s*incidentBlocked/);
  });

  it("довжина визнана неістотною, а згода — недосяжною", () => {
    const code = src(MODAL);
    const irrelevant = code.match(/const\s+lengthIrrelevant\s*=\s*[^;]+;/)?.[0] || "";
    const consent = code.match(/const\s+needsOffConfirm\s*=\s*[^;]+;/)?.[0] || "";
    expect(irrelevant, "порада «скоротіть» поїде і в простій").toMatch(/incidentBlocked/);
    expect(consent, "галочка згоди виринає при порожньому складі в простої").toMatch(/!\s*incidentBlocked/);
  });

  it("підпис межі має власну гілку простою", () => {
    const code = src(MODAL);
    const label = code.match(/const\s+incidentLabel\s*=\s*[\s\S]*?;\s*\n/)?.[0] || "";
    expect(label, "гілки підпису для простою немає").toMatch(/incidentBlocked/);
    expect(label, "підпис не називає простій словами").toMatch(/у простої/);
    expect(label, "стеля простою попереду не має підпису").toMatch(/до простою о/);
    /* ⚠️ Мало ОГОЛОСИТИ підпис — його треба ще й ПІДСТАВИТИ першим. Власна
       фальсифікація (N06) прибрала саме використання, лишивши оголошення: цей
       сторож світив зеленим, а дефект зловив чужий гвард від U-12. Пінимо
       використання окремо, щоб ім'я червоного тесту називало справжню причину.
       Порівняння стель тут заборонене свідомо: при записі після закриття
       `capBySchedStrict` відʼємний, і `0 <= -30` відкинуло б гілку простою
       рівно там, де накладаються два блоки. */
    expect(code, "підпис простою оголошений, але не використаний у boundaryLabel")
      .toMatch(/const boundaryLabel = incidentLabel != null\s*\n?\s*\? incidentLabel/);
    /* ⚠️ Ревʼю р1, знахідка 3. Умова «чи вʼяже простій» мусить перевіряти ТОЙ
       САМИЙ набір стель, з якого рахується мінімум — разом із `DUR_MAX`. Без
       нього в кабінеті 08:00–20:00 із ТО о 17:00 стеля простою (540) програвала
       продуктовій (480), але підпис діставався їй: екран писав «доступно 480 хв
       (до простою о 17:00)», хоча 480 хв від 08:00 — це 16:00, і причиною був
       `normDur`, а не ТО. Читач ішов дзвонити в сервіс. */
    /* ⚠️ Пінимо ВЕСЬ вираз, від голови. Ревʼю р2 (D-2) показало обхід: мутація
       `!incidentBlocked` → `incidentBlocked` робить гілку недосяжною назавжди
       (при `blocked` спрацьовує перша гілка `incidentLabel`), а хвіст із
       `DUR_MAX` лишається цілим — сторож, що дивився тільки на хвіст, світив
       зеленим. Це третій випадок того самого класу за два пакети (N17 в U-20,
       N06 в U-30): пінити треба те, що робить гілку ДОСЯЖНОЮ. */
    expect(code, "incCapBinds не звіряється з DUR_MAX або відвʼязаний від !incidentBlocked")
      .toMatch(/const incCapBinds = !incidentBlocked && incCapRaw !== undefined && incCapRaw < Infinity\s*\n?\s*&& incCapRaw <= capByNext && incCapRaw <= capBySchedStrict && incCapRaw <= capByBreakStrict\s*\n?\s*&& incCapRaw <= DUR_MAX;/);
    /* Мʼякий близнюк: `labelFor` кличуть і з `availableDur`, і його набір інший.
       Без цієї умови понаднормовий напис називав простій «підтвердженням». */
    expect(code, "мʼяка стеля простою не має свого прапорця — овертайм назве простій згодою")
      .toMatch(/const incCapBindsSoft = !incidentBlocked &&[\s\S]{0,240}?incCapRaw <= capByBreak && incCapRaw <= DUR_MAX;/);
    expect(code, "понаднормовий підпис не називає простій причиною")
      .toMatch(/incCapBindsSoft && cap === incCapRaw \? " — далі простій кабінету" : ""/);
  });

  /* Умова І текст в ОДНОМУ виразі: мутація `incidentBlocked → true/false`
     лишить текст у файлі, але зробить гілку недосяжною — сторож, що шукає
     тільки текст, цього не побачить (урок N17 з U-20). */
  it("рядок доступності має гілку простою — разом з умовою", () => {
    const code = src(MODAL);
    expect(code, "гілка рядка доступності не привʼязана до incidentBlocked")
      .toMatch(/:\s*incidentBlocked\s*\n?\s*\?\s*<>[\s\S]{0,200}Кабінет у простої/);
  });

  it("банер простою існує і дає ДІЮ, а не лише факт", () => {
    const code = src(MODAL);
    const banner = code.match(/\{incidentBlocked\s*&&\s*\([\s\S]*?\n\s{10}\)\}/)?.[0] || "";
    expect(banner, "банера жорсткого блоку простою немає").toContain("Кабінет у простої");
    /* Без дії банер лишає читача з сірою кнопкою — рівно те, що U-12 виправляв
       для рольової відмови. */
    /* ⚠️ Порада НЕ називає кнопку (ревʼю р2, A-2). «🗓 Перезаписати» — підпис
       рівно одного з чотирьох місць виклику (`ReferrerBoard`); у QueueBoard,
       CallListBoard і CaseModal кнопка зветься «🗓 Перенести», а в кейсі вона
       ще й не «на дошці». Спільна константа `RESCHEDULE_HINT` посилається на
       те, що правда скрізь: кнопка переносу в тому самому рядку дій. */
    expect(banner, "банер не каже, що робити").toMatch(/RESCHEDULE_HINT/);
    expect(banner, "у банер повернулась назва кнопки, вірна лише для однієї дошки")
      .not.toMatch(/Перезаписати|на дошці/);
    /* ⚠️ Дія тут ОДНА на обидві ролі, і розгалуження заборонено (ревʼю р1,
       знахідка 2). `allowOffSchedule` — право ПІДТВЕРДИТИ роботу поза графіком,
       а не право переносити: кнопка «🗓 Перезаписати» стоїть у направника рівно
       поруч із «🩻 Дослідження» (`ReferrerBoard`). Перша версія банера писала
       йому «перенести може лише центр» — і слала дзвонити замість одного кліку.
       Це той самий клас, що U-12, лише дзеркальний: там роль не могла зробити
       обіцяне, тут могла, а екран це приховав. */
    expect(banner, "порада знову розгалужена по ролі — а роль тут ні до чого").not.toMatch(/allowOffSchedule/);
    /* Термін ремонту — єдине, що дозволяє не переносити, а перечекати. */
    expect(banner, "банер мовчить про термін ремонту").toMatch(/incEndLabel/);
  });

  /* Ревʼю р1, знахідка 4: ліва колонка писала «🔧 Кабінет у простої до 12:00», а
     сітка поруч малювала ті самі слоти вільними — один екран стверджував і
     «сюди не можна», і «тут порожньо». До U-15 сітка була чесно невігласною
     (простоїв не знала вся модалка); пакет зробив половину — і породив
     суперечність. */
  it("сітка слотів фарбує простій, а не малює його вільним", () => {
    const code = src(MODAL);
    const state = code.match(/function slotState\([\s\S]*?\n  \}/)?.[0] || "";
    expect(state, "slotState не питає про простої — сітка суперечить банеру")
      .toMatch(/if \(slotBlockedByFeed\(incidents, patient\.room_id, .+\)\) return "blocked";/);
    /* Порядок: простій мусить перебивати зайнятість і графік. Єдине, що стоїть
       раніше, — минулий день і закритий кабінет (там сітки просто немає). */
    expect(state, "простій опинився нижче за зайнятість — червоне зʼїсть червоне")
      .toMatch(/return "blocked";[\s\S]*roomBusy\.some/);
    /* ⚠️ Тіла функцій мало: мутація `stateOf={() => "free"}` (або `gridSlots = []`)
       лишає обидві функції цілими й відвʼязує сітку від правила — знайдено
       фальсифікацією ревʼю р2 (D-3). Пінимо ПРИВʼЯЗКУ, як це вже роблять сторожі
       availState у BookingModal/RescheduleModal. */
    expect(code, "сітка більше не питає slotState — правило є, але не підключене")
      .toMatch(/stateOf=\{slotState\}/);
    expect(code, "підпис слотів відвʼязаний від slotTitle").toMatch(/titleOf=\{slotTitle\}/);
    const title = code.match(/function slotTitle\([\s\S]*?\n  \}/)?.[0] || "";
    /* Фарбує однаково і «простій», і «не прочитали» (fail-closed) — а от
       ПІДПИС мусить їх розрізняти, інакше екран вигадує причину.
       ⚠️ Чесно: сьогодні ця гілка НЕДОСЯЖНА — при `incidentsUnknown` сітка
       ховається раніше (`availFailed` вище за неї). Лишаємо як запобіжник саме
       тому, що гейт довіри й підпис живуть у різних місцях файла: варто комусь
       послабити гейт — і без цієї гілки тултип почне вигадувати простій, якого
       ніхто не читав. Сторож охороняє запобіжник, а не робочу гілку. */
    expect(title, "підпис не розрізняє простій і непрочитані дані")
      .toMatch(/inc === undefined/);
    expect(title, "підпис заблокованого слота не називає простій").toMatch(/у простої/);
    /* Легенда: `SlotPicker` малює `blocked` тим самим `.busy`, тож без свого
       рядка вона пояснює простій словом «зайнято» (ревʼю р2, A-3). */
    expect(code, "легенда не має рядка про простій — червоне читається як «зайнято»")
      .toMatch(/roomIncidentRows\.length > 0 && <span><span className="lg-dot busy" \/>простій \/ ТО<\/span>/);
  });
});

/* ── Сторож місць виклику ────────────────────────────────────────────────────
   Проп обовʼязковий і без дефолта, тож tsc ловить пропущений виклик — але лише
   доки він таким лишається. Сторож нижче тримає САМ МЕХАНІЗМ на рівні викликів:
   `incidents={incidentFeed([])}` скомпілюється й тихо поверне fail-open. */
const CALL_SITES = [
  "components/QueueBoard.tsx",
  "components/CallListBoard.tsx",
  "components/CaseModal.tsx",
  "components/ReferralPortal.tsx",
];

describe("U-15: кожен виклик StudyEditModal передає ЖИВИЙ фід простоїв", () => {
  it.each(CALL_SITES)("%s", (file) => {
    const code = src(file);
    const calls = [...code.matchAll(/<StudyEditModal\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(calls.length, `${file}: виклик StudyEditModal не знайдено`).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, `${file}: виклик без пропа incidents`).toMatch(/\bincidents=\{/);
      /* Порожній літерал — це «простоїв немає», а не «ось фід»: рівно та
         підміна невідомості порожнечею, яку U-11 і закривав. */
      expect(call, `${file}: заглушка замість фіда`).not.toMatch(/incidents=\{\s*incidentFeed\(\s*\[\s*\]\s*\)\s*\}/);
      expect(call, `${file}: заглушка замість фіда`).not.toMatch(/incidents=\{\s*\{\s*rows:\s*\[\s*\]/);
    }
  });

  /* ⚠️ Ревʼю р2, A-1 — НАЙдорожча знахідка пакета, і вона не в модалці.
     `QueueBoard` віддавав формам `incidentsFeed`, побудований на `liveIncidents`
     (без «згаслих» за `incidentExpired`). Виправдання жило в коментарі лоадера:
     «DB-гард рахує ВІКНО, а не статус». Функцію прочитано з живої БД — вона
     рахує І ТЕ, І ТЕ (`i.status in ('active','planned')` І перетин вікон). Отже
     у вікні до 5 хв між `blocked_until` і прогоном крона
     (`resolve-expired-incidents`, кожні 5 хв, активний) форма обіцяла
     збереження, яке тригер відхиляє, — рівно та брехня, заради якої U-15 і
     робився, тільки заведена з іншого боку. CallListBoard і ReferralPortal
     подають сирі рядки й були праві; розходились саме адміністратор і направник
     на ОДНОМУ записі. */
  it("QueueBoard дає формам запису фід із предикатом СЕРВЕРА, а не «заблоковано зараз»", () => {
    const code = src("components/QueueBoard.tsx");
    expect(code, "writeIncidentsFeed зник — форми знову беруть відфільтрований клієнтом список")
      .toMatch(/const writeIncidentsFeed = loadIncidentsFeed;/);
    expect(code, "loadIncidentsFeed більше не з сирих incidents — предикат розійшовся з тригером")
      .toMatch(/const loadIncidentsFeed = incidentFeed\(incidents, incidentsErr\);/);
    for (const tag of ["StudyEditModal", "CaseModal"]) {
      const m = new RegExp("<" + tag + "\\b[\\s\\S]*?/>").exec(code);
      expect(m, `${tag} у QueueBoard не знайдено`).not.toBeNull();
      expect((m as RegExpExecArray)[0], `${tag} отримує incidentsFeed — у вікні до 5 хв обіцяє відхилене`)
        .toMatch(/incidents=\{writeIncidentsFeed\}/);
    }
  });

  /* Ревʼю р1, знахідка 5. У порталі направника відкриття редактора складу стало
     АСИНХРОННИМ (треба дочитати простої центру), а гвард поколінь `openGen`
     рухали лише асинхронні дії. Синхронні («✎ Дані пацієнта», «✕ Скасувати»,
     дії листа очікування) його не чіпали — і відповідь попереднього кліку
     приземлялась ДРУГИМ оверлеєм поверх уже відкритої модалки: обидві вішають
     `useModalA11y` на document у capture, Esc закриває не те вікно (дефект U-8).
     Пінимо, що синхронні відкриття теж рухають лічильник. */
  it("ReferralPortal: синхронні відкриття теж рухають гвард поколінь", () => {
    const code = src("components/ReferralPortal.tsx");
    expect(code, "bumpOpen зник — гвард поколінь знову бачить лише асинхронні відкриття")
      .toMatch(/const bumpOpen = \(\) => \{ openGen\.current \+= 1; \};/);
    for (const setter of ["setEditPatientFor", "setCancelAsk", "setWlEditFor", "setWlConfirmRemove", "setWlAddOpen"]) {
      expect(code, `${setter} відкриває модалку, не рухаючи openGen — асинхронна відповідь ляже поверх`)
        .toMatch(new RegExp("bumpOpen\\(\\);\\s*" + setter + "\\("));
    }
  });
});
